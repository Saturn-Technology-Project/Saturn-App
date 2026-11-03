//! The editor features' prompts, and how a model's answer to them is cleaned: Tab, Cmd+K, Apply, next edit and commit messages.
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use crate::js;

const CONTEXT: usize = 3000;
const EDITS: usize = 1200;
pub const PREFIX: usize = 8000;
pub const SUFFIX: usize = 4000;
const SELECTION: usize = 20000;
const INSTRUCTION: usize = 2000;
const FILE: usize = 60000;
const WINDOW: usize = 12000;
const DIFF: usize = 60000;
const FILES: usize = 8000;
const DRAFT: usize = 2000;

/// A fill-in-the-middle family: code models that complete the gap between a prefix and a suffix, given their own tokens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fim {
    QwenCoder,
    DeepSeekCoder,
    Codestral,
    StarCoder,
    CodeLlama,
    CodeGemma,
}

static QWEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)qwen.*coder|qwen2\\.5-coder|qwen3-coder").expect("valid"));
static DEEPSEEK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)deepseek.*coder").expect("valid"));
static CODESTRAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)codestral|mistral.*code|devstral").expect("valid"));
static STARCODER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)starcoder|granite.*code|santacoder").expect("valid"));
static CODELLAMA: LazyLock<Regex> = LazyLock::new(|| Regex::new("(?i)code-?llama").expect("valid"));
static CODEGEMMA: LazyLock<Regex> = LazyLock::new(|| Regex::new("(?i)codegemma").expect("valid"));
static CHAT_GEMMA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)codegemma.*-it").expect("valid"));

/// The format a model id speaks, if any.
pub fn fim_format(model: &str) -> Option<Fim> {
    // The -it variant of CodeGemma is a chat model, not an infilling one.
    let gemma = CODEGEMMA.is_match(model) && !CHAT_GEMMA.is_match(model);
    if QWEN.is_match(model) {
        Some(Fim::QwenCoder)
    } else if DEEPSEEK.is_match(model) {
        Some(Fim::DeepSeekCoder)
    } else if CODESTRAL.is_match(model) {
        Some(Fim::Codestral)
    } else if STARCODER.is_match(model) {
        Some(Fim::StarCoder)
    } else if CODELLAMA.is_match(model) {
        Some(Fim::CodeLlama)
    } else if gemma {
        Some(Fim::CodeGemma)
    } else {
        None
    }
}

impl Fim {
    /// The family, for logs.
    pub fn family(self) -> &'static str {
        match self {
            Self::QwenCoder => "qwen-coder",
            Self::DeepSeekCoder => "deepseek-coder",
            Self::Codestral => "codestral",
            Self::StarCoder => "starcoder",
            Self::CodeLlama => "codellama",
            Self::CodeGemma => "codegemma",
        }
    }

    /// Where the model's turn ends: these stop generation and are never shown.
    pub fn stops(self) -> &'static [&'static str] {
        match self {
            Self::QwenCoder => &[
                "<|fim_prefix|>",
                "<|fim_suffix|>",
                "<|fim_middle|>",
                "<|fim_pad|>",
                "<|endoftext|>",
                "<|repo_name|>",
                "<|file_sep|>",
            ],
            Self::DeepSeekCoder => &[
                "<｜fim▁begin｜>",
                "<｜fim▁hole｜>",
                "<｜fim▁end｜>",
                "<｜end▁of▁sentence｜>",
            ],
            Self::Codestral => &["[PREFIX]", "[SUFFIX]", "[MIDDLE]", "</s>"],
            Self::StarCoder => &[
                "<fim_prefix>",
                "<fim_suffix>",
                "<fim_middle>",
                "<|endoftext|>",
                "<file_sep>",
            ],
            Self::CodeLlama => &["<PRE>", "<SUF>", "<MID>", "<EOT>", "</s>"],
            Self::CodeGemma => &[
                "<|fim_prefix|>",
                "<|fim_suffix|>",
                "<|fim_middle|>",
                "<|file_separator|>",
                "<eos>",
            ],
        }
    }

    fn prompt(self, prefix: &str, suffix: &str) -> String {
        match self {
            Self::QwenCoder | Self::CodeGemma => {
                format!("<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>")
            }
            Self::DeepSeekCoder => {
                format!("<｜fim▁begin｜>{prefix}<｜fim▁hole｜>{suffix}<｜fim▁end｜>")
            }
            Self::Codestral => format!("[SUFFIX]{suffix}[PREFIX] {prefix}"),
            Self::StarCoder => format!("<fim_prefix>{prefix}<fim_suffix>{suffix}<fim_middle>"),
            Self::CodeLlama => format!("<PRE> {prefix} <SUF>{suffix} <MID>"),
        }
    }

    /// For models trained on whole repositories: the other files' snippets in the model's own format.
    fn repository(self, files: &[(String, String)], path: &str) -> Option<String> {
        let listed = |separator: &str| {
            files
                .iter()
                .map(|(file, content)| format!("{separator}{file}\n{content}\n"))
                .collect::<String>()
        };
        match self {
            Self::QwenCoder => Some(format!(
                "<|repo_name|>project\n{}<|file_sep|>{path}\n",
                listed("<|file_sep|>")
            )),
            Self::StarCoder => Some(format!(
                "<repo_name>project{}<file_sep>{path}\n",
                listed("<file_sep>")
            )),
            _ => None,
        }
    }
}

/// The text up to the first stop sequence the model may have echoed.
pub fn cut_at_stop<'a>(text: &'a str, stops: &[&str]) -> &'a str {
    let end = stops
        .iter()
        .filter_map(|stop| text.find(stop))
        .min()
        .unwrap_or(text.len());
    &text[..end]
}

/// The comment that starts a line in a language.
pub fn line_comment(language: &str) -> &'static str {
    match language.to_lowercase().as_str() {
        "python" | "ruby" | "shellscript" | "bash" | "sh" | "zsh" | "yaml" | "toml" | "perl"
        | "r" | "makefile" | "dockerfile" | "powershell" | "elixir" | "julia" | "nim"
        | "coffeescript" => "#",
        "sql" | "lua" | "haskell" | "ada" | "elm" => "--",
        "lisp" | "clojure" | "scheme" => ";;",
        _ => "//",
    }
}

/// Other files' snippets as comment lines, for a model without a repository format.
pub fn context_as_comments(files: &[(String, String)], language: &str) -> String {
    if files.is_empty() {
        return String::new();
    }
    let mark = line_comment(language);
    let blocks: Vec<String> = files
        .iter()
        .map(|(path, content)| {
            let mut lines = vec![format!("{mark} From {path}:")];
            lines.extend(content.split('\n').map(|line| format!("{mark} {line}")));
            lines.join("\n")
        })
        .collect();
    format!("{}\n\n", blocks.join("\n"))
}

/// A request's text field.
fn field(input: &Value, key: &str) -> String {
    js::text(input.get(key))
}

fn start(value: &str, limit: usize) -> &str {
    js::prefix(value, limit)
}

fn end(value: &str, limit: usize) -> &str {
    js::suffix(value, limit)
}

fn file_line(input: &Value) -> String {
    let (path, language) = (field(input, "path"), field(input, "language"));
    if path.is_empty() {
        let shown = if language.is_empty() {
            "plain text"
        } else {
            &language
        };
        return format!("Language: {shown}");
    }
    let named = if language.is_empty() {
        String::new()
    } else {
        format!(" ({language})")
    };
    format!("File: {path}{named}")
}

/// The user's recent edits in this file as a short diff-like note, for the model to read intent from.
fn recent_edits(input: &Value) -> String {
    let edits: Vec<&Value> = input
        .get("recentEdits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|edit| js::trim(&field(edit, "before")) != js::trim(&field(edit, "after")))
        .collect();
    if edits.is_empty() {
        return String::new();
    }
    let mut lines = Vec::new();
    for edit in &edits[edits.len().saturating_sub(4)..] {
        lines.push(format!("@@ line {} @@", js::text(edit.get("line"))));
        for (key, mark) in [("before", "-"), ("after", "+")] {
            lines.extend(
                field(edit, key)
                    .split('\n')
                    .filter(|line| !js::trim(line).is_empty())
                    .map(|line| format!("{mark} {line}")),
            );
        }
    }
    end(&lines.join("\n"), EDITS).to_owned()
}

/// The other files' snippets, within the budget, each one whole or left out.
fn context_files(input: &Value) -> Vec<(String, String)> {
    let mut files = Vec::new();
    let mut room = CONTEXT;
    for item in input
        .get("context")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let path = start(&field(item, "path"), 300).to_owned();
        let content = start(&field(item, "text"), 1500).to_owned();
        let size = js::length(&content) + js::length(&path);
        if path.is_empty() || js::trim(&content).is_empty() || size > room {
            continue;
        }
        room -= size;
        files.push((path, content));
    }
    files
}

fn fim_prefix(input: &Value) -> String {
    let source = field(input, "prefix");
    let prefix = end(&source, PREFIX);
    let edits = recent_edits(input);
    if edits.is_empty() {
        return prefix.to_owned();
    }
    let commented: Vec<String> = edits.split('\n').map(|line| format!("// {line}")).collect();
    format!(
        "// Recent edits in this file:\n{}\n\n{prefix}",
        commented.join("\n")
    )
}

/// The raw prompt: other files in the model's repository format when it has one, else as comments.
pub fn fim_prompt(fim: Fim, input: &Value) -> String {
    let source = field(input, "suffix");
    let suffix = start(&source, SUFFIX);
    let files = context_files(input);
    if !files.is_empty() {
        let path = field(input, "path");
        if let Some(repository) =
            fim.repository(&files, if path.is_empty() { "file" } else { &path })
        {
            return repository + &fim.prompt(&fim_prefix(input), suffix);
        }
    }
    fim.prompt(
        &(context_as_comments(&files, &field(input, "language")) + &fim_prefix(input)),
        suffix,
    )
}

/// A system and a user turn.
fn turns(system: &[&str], user: String) -> Vec<(String, String)> {
    vec![(system.join("\n"), user)]
}

/// The prompt of a kind of completion, as its system text and its user text.
pub fn completion_prompt(kind: &str, input: &Value) -> (String, String) {
    let parts = match kind {
        "edit" => edit_prompt(input),
        "apply" => apply_prompt(input),
        "next" => next_prompt(input),
        "commit" => commit_prompt(input),
        _ => inline_prompt(input),
    };
    parts.into_iter().next().unwrap_or_default()
}

fn inline_prompt(input: &Value) -> Vec<(String, String)> {
    let (before, after) = (field(input, "prefix"), field(input, "suffix"));
    let edits = recent_edits(input);
    let block = input.get("mode").and_then(Value::as_str) == Some("block");
    let others: String = context_files(input)
        .iter()
        .map(|(path, content)| format!("\n\nCode from {path} that this file uses:\n{content}"))
        .collect();
    let edited = if edits.is_empty() {
        String::new()
    } else {
        format!("\n\nThe user's recent edits in this file (what they are doing now):\n{edits}")
    };
    turns(
        &[
            "You are a code completion engine inside an editor.",
            "Reply with only the text to insert at <CURSOR>: no explanation, no markdown fences, no repetition of the code around it.",
            if block {
                "The cursor opens a block: you may suggest the whole block body (several lines), matching the surrounding style and indentation."
            } else {
                "Prefer a short completion: finish the current line, or at most a few lines when a block is clearly started."
            },
            "Reply with nothing when no completion is useful.",
        ],
        format!(
            "{}{others}{edited}\n\n{}<CURSOR>{}",
            file_line(input),
            end(&before, PREFIX),
            start(&after, SUFFIX)
        ),
    )
}

fn edit_prompt(input: &Value) -> Vec<(String, String)> {
    let (before, after, selection, instruction) = (
        field(input, "prefix"),
        field(input, "suffix"),
        field(input, "selection"),
        field(input, "instruction"),
    );
    turns(
        &[
            "You rewrite code inside an editor.",
            "You get the code before the selection, the selection, and the code after it, plus an instruction.",
            "Reply with only the code that replaces the selection, keeping its indentation: no explanation, no markdown fences,",
            "and none of the surrounding code. When the selection is empty, reply with the code to insert at that point.",
        ],
        [
            file_line(input).as_str(),
            "",
            "<before>",
            end(&before, PREFIX),
            "</before>",
            "<selection>",
            start(&selection, SELECTION),
            "</selection>",
            "<after>",
            start(&after, SUFFIX),
            "</after>",
            "",
            &format!(
                "Instruction: {}",
                js::trim(start(&instruction, INSTRUCTION))
            ),
        ]
        .join("\n"),
    )
}

fn apply_prompt(input: &Value) -> Vec<(String, String)> {
    let (file, snippet, note) = (
        field(input, "file"),
        field(input, "selection"),
        field(input, "instruction"),
    );
    let note = js::trim(start(&note, INSTRUCTION));
    let mut lines = vec![
        file_line(input),
        String::new(),
        "<file>".to_owned(),
        start(&file, FILE).to_owned(),
        "</file>".to_owned(),
        "<snippet>".to_owned(),
        start(&snippet, SELECTION).to_owned(),
        "</snippet>".to_owned(),
    ];
    if !note.is_empty() {
        lines.push(String::new());
        lines.push(format!("Note: {note}"));
    }
    turns(
        &[
            "You merge a code change into a file inside an editor.",
            "You get the current file and a snippet from a chat reply. The snippet may be partial: comments such as",
            "\"// ...existing code...\" or \"...\" stand for unchanged parts.",
            "Reply with the complete updated file and nothing else: no explanation, no markdown fences.",
            "Keep every part the snippet does not change exactly as it is, including formatting and comments.",
            "If the snippet is a whole new version of the file, reply with it as is.",
        ],
        lines.join("\n"),
    )
}

fn next_prompt(input: &Value) -> Vec<(String, String)> {
    let window = field(input, "file");
    let edit = input
        .get("edit")
        .cloned()
        .unwrap_or_else(|| json!({ "before": "", "after": "", "line": 0 }));
    let (before, after) = (field(&edit, "before"), field(&edit, "after"));
    turns(
        &[
            "You predict a programmer's next edit, like an IDE's next-edit suggestion.",
            "You get numbered lines around the cursor and the edit just made. If that edit implies another one nearby",
            "(the same rename, a matching change, an obvious follow-up), name it. Otherwise say there is none.",
            "Reply with JSON only: {\"line\": <line number>, \"find\": \"<exact text on that line to replace>\", \"replace\": \"<new text>\"}",
            "or {} when there is no clear next edit. Never repeat the edit that was just made.",
        ],
        [
            file_line(input).as_str(),
            "",
            &format!("Edit just made at line {}:", js::text(edit.get("line"))),
            "<before>",
            start(&before, 2000),
            "</before>",
            "<after>",
            start(&after, 2000),
            "</after>",
            "",
            "<lines>",
            start(&window, WINDOW),
            "</lines>",
        ]
        .join("\n"),
    )
}

fn commit_prompt(input: &Value) -> Vec<(String, String)> {
    let recent: Vec<String> = input
        .get("recentCommits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|subject| {
            js::trim(js::text(Some(subject)).split('\n').next().unwrap_or("")).to_owned()
        })
        .filter(|subject| !subject.is_empty())
        .take(20)
        .collect();
    let (note, draft, files, diff, branch) = (
        field(input, "instruction"),
        field(input, "draft"),
        field(input, "files"),
        field(input, "diff"),
        field(input, "branch"),
    );
    let (note, draft, files) = (
        js::trim(start(&note, INSTRUCTION)),
        js::trim(start(&draft, DRAFT)),
        js::trim(start(&files, FILES)),
    );
    let mut lines: Vec<String> = Vec::new();
    if !branch.is_empty() {
        lines.push(format!("Branch: {}", start(&branch, 200)));
        lines.push(String::new());
    }
    if !recent.is_empty() {
        lines.push("<recent_commits>".to_owned());
        lines.extend(recent.iter().map(|subject| format!("- {subject}")));
        lines.push("</recent_commits>".to_owned());
        lines.push(String::new());
    }
    if !files.is_empty() {
        lines.extend([
            "<files>".to_owned(),
            files.to_owned(),
            "</files>".to_owned(),
            String::new(),
        ]);
    }
    lines.extend([
        "<diff>".to_owned(),
        start(&diff, DIFF).to_owned(),
        "</diff>".to_owned(),
    ]);
    if !draft.is_empty() {
        lines.extend([
            String::new(),
            "<draft>".to_owned(),
            draft.to_owned(),
            "</draft>".to_owned(),
        ]);
    }
    if !note.is_empty() {
        lines.extend([String::new(), format!("Instructions: {note}")]);
    }
    turns(
        &[
            "You write git commit messages for the changes about to be committed.",
            "Reply with only the commit message: no explanation, no markdown fences, no quotes around it, no trailers such as Co-authored-by.",
            "First line: a subject that says what the change does, in the imperative mood, at most 72 characters, without a trailing period.",
            "When the change is more than a one-liner, add a blank line and a short body (wrapped at 72 characters) saying what changed and why;",
            "use \"- \" bullets only for several distinct changes. Describe the change itself, not the diff (no \"modified file X\" lists).",
            "When the recent commits share a style (a prefix such as \"feat:\" or \"Area:\", capitalization, language), follow it; never copy them.",
            "When a draft is given, keep its intent and wording where it is right, and complete or correct it from the changes.",
            "The user's instructions, when given, take precedence over these rules.",
        ],
        lines.join("\n"),
    )
}

/// Models often wrap code in a fence despite being told not to; keep just what's inside.
pub fn strip_fences(text: &str) -> &str {
    static FENCED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\s*```[^\n]*\n((?s:.*?))\n?```\s*$").expect("valid"));
    FENCED
        .captures(text)
        .and_then(|found| found.get(1))
        .map_or(text, |inner| inner.as_str())
}

/// The model's commit message without fences, wrapping quotes, a "Commit message:" label or trailing blank lines.
pub fn clean_commit_message(raw: &str) -> String {
    static LABEL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^(?:\*\*)?(?:suggested )?commit message(?:\*\*)?:?(?:\*\*)?\s*\n?")
            .expect("valid")
    });
    static TRAILING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)[ \t]+$").expect("valid"));
    static BLANKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").expect("valid"));
    let text = js::trim(strip_fences(raw));
    let text = LABEL.replace(text, "");
    let text = js::trim(strip_fences(js::trim(&text)));
    let mut text = text;
    if let Some(quote) = text
        .chars()
        .next()
        .filter(|first| ['"', '\'', '`'].contains(first))
        && text.chars().count() > 1
        && text.ends_with(quote)
        && !text[1..text.len() - 1].contains(quote)
    {
        text = js::trim(&text[1..text.len() - 1]);
    }
    let text = TRAILING.replace_all(text, "");
    BLANKS.replace_all(&text, "\n\n").into_owned()
}

/// The model's next-edit answer, or `{}` when it is missing, malformed, or a no-op.
pub fn parse_next_edit(raw: &str) -> Value {
    let body = js::trim(strip_fences(raw));
    let parsed = body
        .find('{')
        .zip(body.rfind('}'))
        .filter(|(first, last)| last > first)
        .and_then(|(first, last)| serde_json::from_str::<Value>(&body[first..=last]).ok());
    let found = parsed.and_then(|value| {
        let line = js::number(Some(value.get("line")?));
        let (find, replace) = (
            value.get("find")?.as_str()?,
            value.get("replace")?.as_str()?,
        );
        (line >= 1.0 && line.fract() == 0.0 && !find.is_empty() && find != replace)
            .then(|| json!({ "line": line as i64, "find": find, "replace": replace }))
    });
    found.unwrap_or_else(|| json!({}))
}

/// Drops a completion's tail when the model repeated the code that already follows the cursor.
pub fn trim_inline(text: &str, suffix: &str) -> String {
    let Some(next) = suffix
        .split('\n')
        .map(js::trim)
        .find(|line| !line.is_empty())
    else {
        return text.to_owned();
    };
    let lines: Vec<&str> = text.split('\n').collect();
    match lines
        .iter()
        .enumerate()
        .position(|(index, line)| index > 0 && js::trim(line) == next)
    {
        Some(at) => js::trim_end(&lines[..at].join("\n")).to_owned(),
        None => text.to_owned(),
    }
}
