//! One plain model call, no tools and no agent loop, for what the built-in editor will call: Tab, Cmd+K, Apply, next edit and
//! commit messages.
use saturn_domain::completions::{
    clean_commit_message, completion_prompt, cut_at_stop, fim_format, fim_prompt, parse_next_edit,
    strip_fences, trim_inline,
};
use saturn_domain::js;
use saturn_domain::llm::runs_on_plan;
use saturn_llm::lmstudio::{RawRequest, RawStream};
use saturn_llm::{CallContext, ChatMessage, CompletionInput, Role};
use serde_json::{Value, json};

use crate::catalog::connection_of;
use crate::records::{by_id, text};
use crate::{CoreError, Kernel};

/// Usage from the editor features is filed under this pseudo-agent (earlier usage records carry the same id).
pub const EDITOR_AGENT_ID: &str = "saturn-ide";
const EDITOR_AGENT_NAME: &str = "Editor features";

/// Output budget per kind; Apply returns a whole file.
fn budget(kind: &str, block: bool) -> u64 {
    match kind {
        "inline" if block => 2048,
        "edit" => 4096,
        "apply" => 16000,
        "commit" => 2048,
        _ => 1024,
    }
}

/// Tab as it is being generated.
pub struct InlineStream {
    source: Source,
    fim_stops: Option<&'static [&'static str]>,
    suffix: String,
    model: String,
    buffer: String,
    sent: usize,
    finished: bool,
}

/// Where its text comes from.
enum Source {
    Raw(RawStream),
    /// A chat model's whole answer, cleaned of fences.
    Whole(Option<String>),
}

impl InlineStream {
    /// The next piece, `{ text }` for whole lines and `{ text, done, model }` at the end; nothing after that.
    pub async fn next(&mut self) -> Result<Option<Value>, CoreError> {
        loop {
            if self.finished {
                return Ok(None);
            }
            let piece = match &mut self.source {
                Source::Raw(stream) => stream.next().await?,
                Source::Whole(text) => text.take(),
            };
            let Some(piece) = piece else {
                return Ok(Some(self.finish()));
            };
            self.buffer.push_str(&piece);
            if let Some(stops) = self.fim_stops {
                self.buffer = cut_at_stop(&self.buffer, stops).to_owned();
            }
            // Hand over whole lines as they complete; the last (unterminated) line waits for the next piece.
            let trimmed = trim_inline(&self.buffer, &self.suffix);
            let stopped_early = trimmed.len() < self.buffer.len();
            let complete = if stopped_early {
                trimmed.as_str()
            } else {
                &trimmed[..trimmed.rfind('\n').map_or(0, |at| at + 1)]
            };
            let mut piece_out = None;
            if complete.len() > self.sent {
                piece_out = Some(json!({ "text": complete[self.sent..] }));
                self.sent = complete.len();
            }
            if stopped_early {
                self.source = Source::Whole(None);
            }
            if piece_out.is_some() {
                return Ok(piece_out);
            }
        }
    }

    fn finish(&mut self) -> Value {
        self.finished = true;
        let clean = if self.fim_stops.is_some() {
            self.buffer.as_str()
        } else {
            strip_fences(&self.buffer)
        };
        let last = trim_inline(clean, &self.suffix);
        let last = last.trim_end_matches('\n');
        let text = if last.len() > self.sent {
            &last[self.sent..]
        } else {
            ""
        };
        json!({ "text": text, "done": true, "model": self.model })
    }
}

impl Kernel {
    /// The model to use: the request's, else the background model. Subscription models never receive API requests.
    fn completion_model(&self, model_id: &str) -> Result<Value, CoreError> {
        let id = if model_id.is_empty() {
            self.store.read(|state| {
                state
                    .settings
                    .get("completionModelId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            })
        } else {
            model_id.to_owned()
        };
        if id.is_empty() {
            return Err(CoreError::new(
                409,
                "Choose a background model in Saturn Settings → General.",
            ));
        }
        let model = self.store.read(|state| by_id(&state.models, &id).cloned()).ok_or_else(|| CoreError::new(409, "The background model was removed. Choose another in Saturn Settings → General."))?;
        let provider = text(&model, "provider");
        if runs_on_plan(provider) {
            let through = if provider == "codex" {
                "Codex"
            } else {
                "Claude Code"
            };
            return Err(CoreError::new(
                409,
                format!(
                    "{} runs through {through} and cannot serve completions. Choose an API model.",
                    text(&model, "name")
                ),
            ));
        }
        Ok(model)
    }

    async fn completion_call(
        &self,
        model: &Value,
        kind: &str,
        input: &Value,
        temperature: f64,
        max_output: u64,
        low_thinking: bool,
    ) -> Result<String, CoreError> {
        let (system, user) = completion_prompt(kind, input);
        let body = self
            .call_model(
                model,
                CompletionInput {
                    context: CallContext {
                        agent_id: EDITOR_AGENT_ID.to_owned(),
                        agent_name: EDITOR_AGENT_NAME.to_owned(),
                        run_id: None,
                        purpose: "completion",
                    },
                    temperature: Some(temperature),
                    max_output: Some(max_output),
                    low_thinking,
                    messages: vec![
                        ChatMessage::new(Role::System, system),
                        ChatMessage::new(Role::User, user),
                    ],
                    tools: Vec::new(),
                },
            )
            .await?;
        Ok(body.content)
    }

    /// One editor call that answers whole.
    pub async fn complete_for_editor(&self, input: &Value) -> Result<Value, CoreError> {
        let kind = text(input, "kind");
        if !matches!(kind, "inline" | "edit" | "apply" | "next" | "commit") {
            return Err(CoreError::new(
                400,
                "kind must be inline, edit, apply, next or commit",
            ));
        }
        let holds = |key: &str| !js::trim(&js::text(input.get(key))).is_empty();
        if kind == "edit" && !holds("instruction") {
            return Err(CoreError::new(400, "Type an instruction for the edit"));
        }
        if kind == "apply" && !holds("selection") {
            return Err(CoreError::new(400, "Nothing to apply"));
        }
        if kind == "next" && !js::truthy(input.get("edit")) {
            return Err(CoreError::new(400, "Describe the edit that was just made"));
        }
        if kind == "commit" && !holds("diff") && !holds("files") {
            return Err(CoreError::new(400, "There are no changes to describe"));
        }
        let model = self.completion_model(text(input, "modelId"))?;
        let block = text(input, "mode") == "block";
        let limit = budget(kind, block);
        let asked = js::number(input.get("maxTokens"));
        let wanted = if asked.is_finite() && asked != 0.0 {
            asked
        } else {
            limit as f64
        };
        let max_output = wanted.clamp(16.0, 16000.0) as u64;
        // The prompts ask for short answers; the budget is generous because thinking models spend part of it reasoning, and a
        // cut-off completion (half an expression) is worse than none.
        let temperature = if matches!(kind, "inline" | "next") {
            0.0
        } else {
            0.2
        };
        let low = matches!(kind, "inline" | "next" | "commit");
        let raw = self
            .completion_call(&model, kind, input, temperature, max_output, low)
            .await?;
        let answer = match kind {
            "edit" => js::trim_end(strip_fences(&raw).trim_start_matches('\n')).to_owned(),
            "apply" => strip_fences(&raw).trim_start_matches('\n').to_owned(),
            "next" => parse_next_edit(&raw).to_string(),
            "commit" => clean_commit_message(&raw),
            _ => trim_inline(
                strip_fences(&raw).trim_end_matches('\n'),
                &js::text(input.get("suffix")),
            ),
        };
        let name = if text(&model, "model").is_empty() {
            text(&model, "name")
        } else {
            text(&model, "model")
        };
        Ok(json!({ "text": answer, "modelId": text(&model, "id"), "model": name }))
    }

    /// Tab, line by line. A fill-in-the-middle model gets its native prompt through the raw endpoint; any other the chat prompt.
    pub async fn complete_inline_stream(&self, input: &Value) -> Result<InlineStream, CoreError> {
        let model = self.completion_model(text(input, "modelId"))?;
        let max_output = budget("inline", text(input, "mode") == "block");
        let connection = connection_of(&model);
        let adapter = self.broker.adapter_for(&connection)?;
        let name = if text(&model, "model").is_empty() {
            text(&model, "name")
        } else {
            text(&model, "model")
        }
        .to_owned();
        let fim = fim_format(&name);
        let suffix = js::text(input.get("suffix"));
        let raw = match fim {
            Some(format) => {
                let request = RawRequest {
                    model: name.clone(),
                    base_url: connection.base_url.clone(),
                    api_key: self.broker.key_for(&connection),
                    prompt: fim_prompt(format, input),
                    stops: format
                        .stops()
                        .iter()
                        .map(|stop| (*stop).to_owned())
                        .collect(),
                    max_output,
                    temperature: Some(0.0),
                };
                adapter
                    .complete_raw(self.broker.http(), &request)
                    .await
                    .transpose()?
            }
            None => None,
        };
        // Stops apply only where the raw prompt was used, or to a code model answering through chat.
        let fim_stops = fim.map(saturn_domain::completions::Fim::stops);
        let source = match raw {
            Some(stream) => Source::Raw(stream),
            None => {
                let answer = self
                    .completion_call(&model, "inline", input, 0.0, max_output, true)
                    .await?;
                Source::Whole(Some(strip_fences(&answer).to_owned()))
            }
        };
        Ok(InlineStream {
            source,
            fim_stops,
            suffix,
            model: name,
            buffer: String::new(),
            sent: 0,
            finished: false,
        })
    }
}
