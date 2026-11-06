//! Embedding models for the code index: one Saturn runs itself on
//! the CPU, one loaded in LM Studio, or any OpenAI-compatible `/embeddings` endpoint.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use base64::Engine;
use saturn_llm::lmstudio::openai_compatible_url;
use saturn_telemetry::network::{SendNoted, client_builder};
use serde_json::{Value, json};
use tokenizers::Tokenizer;
use tract_onnx::prelude::*;

/// A search question, or a piece of the code being indexed. Some models embed the two differently.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmbedKind {
    Query,
    Passage,
}

/// Why embedding failed: the API status it should answer with, when it has its own, and a message for the user.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmbedError {
    pub status: Option<u16>,
    pub message: String,
}

impl EmbedError {
    fn new(status: Option<u16>, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn plain(message: impl Into<String>) -> Self {
        Self::new(None, message)
    }
}

impl std::fmt::Display for EmbedError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for EmbedError {}

/// A model Saturn can run itself, on the CPU, with no other app.
pub struct BuiltinModel {
    pub name: &'static str,
    repo: &'static str,
    query_prefix: &'static str,
    passage_prefix: &'static str,
    max_tokens: usize,
}

const MODEL_FILES: [&str; 4] = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "onnx/model_quantized.onnx",
];

/// The first is the default.
pub const BUILTIN_MODELS: [BuiltinModel; 2] = [
    BuiltinModel {
        name: "multilingual-e5-small",
        repo: "Xenova/multilingual-e5-small",
        query_prefix: "query: ",
        passage_prefix: "passage: ",
        max_tokens: 512,
    },
    BuiltinModel {
        name: "jina-embeddings-v2-base-code",
        repo: "jinaai/jina-embeddings-v2-base-code",
        query_prefix: "",
        passage_prefix: "",
        max_tokens: 2048,
    },
];

pub const DEFAULT_BUILTIN_MODEL: &str = "multilingual-e5-small";

/// The built-in model of this name.
pub fn builtin_model(name: &str) -> Option<&'static BuiltinModel> {
    BUILTIN_MODELS.iter().find(|model| model.name == name)
}

/// Padded tokens one inference may hold: attention memory grows with rows × width².
pub const MAX_BATCH_TOKENS: usize = 4096;

/// Splits rows, in order, into groups whose padded size (rows × longest row) stays within the budget.
pub fn token_budget_groups(rows: Vec<Vec<i64>>, budget: usize) -> Vec<Vec<Vec<i64>>> {
    let mut groups = Vec::new();
    let mut group: Vec<Vec<i64>> = Vec::new();
    let mut width = 0;
    for row in rows {
        let next = width.max(row.len());
        if !group.is_empty() && (group.len() + 1) * next > budget {
            groups.push(std::mem::take(&mut group));
            width = 0;
        }
        width = width.max(row.len());
        group.push(row);
    }
    if !group.is_empty() {
        groups.push(group);
    }
    groups
}

/// Keeps the first tokens and the closing one, so a long chunk still ends the way the model expects.
fn clip_tokens(mut ids: Vec<i64>, max: usize) -> Vec<i64> {
    if ids.len() > max {
        let last = ids[ids.len() - 1];
        ids.truncate(max - 1);
        ids.push(last);
    }
    ids
}

/// The average of one row's token vectors (padding excluded), scaled to length 1.
pub fn mean_pool(data: &[f32], row: usize, tokens: usize, width: usize, dims: usize) -> Vec<f32> {
    let mut vector = vec![0.0_f32; dims];
    for token in 0..tokens {
        let offset = (row * width + token) * dims;
        for (dim, value) in vector.iter_mut().enumerate() {
            *value += data[offset + dim];
        }
    }
    let mut norm = 0.0_f32;
    for value in &mut vector {
        *value /= tokens as f32;
        norm += *value * *value;
    }
    let norm = if norm == 0.0 { 1.0 } else { norm.sqrt() };
    for value in &mut vector {
        *value /= norm;
    }
    vector
}

fn has_files(dir: &Path) -> bool {
    MODEL_FILES.iter().all(|file| dir.join(file).is_file())
}

/// Where a built-in model's files are: the copy shipped with Saturn (SATURN_MODELS_DIR) when it has them, else
/// `<data>/models/<name>`, where `ensure_model` downloads them. The second part says whether they are all there.
pub fn model_dir(data_root: &Path, name: &str) -> (PathBuf, bool) {
    let shipped = std::env::var_os("SATURN_MODELS_DIR")
        .filter(|root| !root.is_empty())
        .map(|root| PathBuf::from(root).join(name));
    if let Some(dir) = shipped
        && has_files(&dir)
    {
        return (dir, true);
    }
    let dir = data_root.join("models").join(name);
    let ready = has_files(&dir);
    (dir, ready)
}

/// Downloads a built-in model's files from Hugging Face into `<data>/models/<name>` (once).
pub async fn ensure_model(data_root: &Path, model: &BuiltinModel) -> Result<PathBuf, EmbedError> {
    let (dir, ready) = model_dir(data_root, model.name);
    if ready {
        return Ok(dir);
    }
    let client = client_builder()
        .build()
        .map_err(|error| EmbedError::plain(error.to_string()))?;
    for file in MODEL_FILES {
        let target = dir.join(file);
        if target.is_file() {
            continue;
        }
        let address = format!("https://huggingface.co/{}/resolve/main/{file}", model.repo);
        let refused = |reason: String| {
            EmbedError::new(
                Some(502),
                format!("Could not download {} ({file}): {reason}", model.name),
            )
        };
        let response = client
            .get(&address)
            .send_noted()
            .await
            .map_err(|error| refused(error.to_string()))?;
        if !response.status().is_success() {
            return Err(refused(format!(
                "Hugging Face answered {}",
                response.status().as_u16()
            )));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| refused(error.to_string()))?;
        let failed = |error: std::io::Error| EmbedError::plain(error.to_string());
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(failed)?;
        }
        // Written beside the target first, so an interrupted download is never mistaken for the model.
        let part = PathBuf::from(format!("{}.part", target.display()));
        tokio::fs::write(&part, &bytes).await.map_err(failed)?;
        tokio::fs::rename(&part, &target).await.map_err(failed)?;
    }
    Ok(dir)
}

type Plan = Arc<TypedRunnableModel>;

/// A loaded model: what turns text into tokens and the encoder.
struct Loaded {
    tokenizer: Tokenizer,
    plan: Plan,
    inputs: Vec<String>,
}

/// A model run inside the runtime: tokenize, run the encoder, average the token vectors and normalize.
pub struct OnnxEmbedder {
    data_root: PathBuf,
    model: &'static BuiltinModel,
    loaded: tokio::sync::OnceCell<Arc<Loaded>>,
}

impl OnnxEmbedder {
    pub fn new(data_root: PathBuf, model: &'static BuiltinModel) -> Self {
        Self {
            data_root,
            model,
            loaded: tokio::sync::OnceCell::new(),
        }
    }

    async fn load(&self) -> Result<Arc<Loaded>, EmbedError> {
        let loaded = self
            .loaded
            .get_or_try_init(|| async {
                let dir = ensure_model(&self.data_root, self.model).await?;
                let loaded = tokio::task::spawn_blocking(move || load_model(&dir))
                    .await
                    .map_err(|error| EmbedError::plain(error.to_string()))??;
                Ok::<_, EmbedError>(Arc::new(loaded))
            })
            .await?;
        Ok(Arc::clone(loaded))
    }

    async fn embed(&self, texts: &[String], kind: EmbedKind) -> Result<Vec<Vec<f32>>, EmbedError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let loaded = self.load().await?;
        let prefix = match kind {
            EmbedKind::Query => self.model.query_prefix,
            EmbedKind::Passage => self.model.passage_prefix,
        };
        let inputs: Vec<String> = texts.iter().map(|text| format!("{prefix}{text}")).collect();
        let max_tokens = self.model.max_tokens;
        // Each group runs on its own blocking task, so dropping this future (a cancel) stops between groups.
        let encoded = {
            let loaded = Arc::clone(&loaded);
            tokio::task::spawn_blocking(move || encode_all(&loaded.tokenizer, inputs, max_tokens))
                .await
                .map_err(|error| EmbedError::plain(error.to_string()))??
        };
        let mut vectors = Vec::with_capacity(texts.len());
        for group in token_budget_groups(encoded, MAX_BATCH_TOKENS) {
            let loaded = Arc::clone(&loaded);
            vectors.extend(
                tokio::task::spawn_blocking(move || run_group(&loaded, &group))
                    .await
                    .map_err(|error| EmbedError::plain(error.to_string()))??,
            );
        }
        Ok(vectors)
    }
}

fn load_model(dir: &Path) -> Result<Loaded, EmbedError> {
    let failed = |what: &str, error: String| {
        EmbedError::plain(format!(
            "Could not load the embedding model ({what}): {error}"
        ))
    };
    let tokenizer = Tokenizer::from_file(dir.join("tokenizer.json"))
        .map_err(|error| failed("tokenizer", error.to_string()))?;
    let model = tract_onnx::onnx()
        .model_for_path(dir.join("onnx/model_quantized.onnx"))
        .map_err(|error| failed("model", error.to_string()))?;
    let inputs = model
        .input_outlets()
        .map_err(|error| failed("model", error.to_string()))?
        .iter()
        .map(|outlet| model.node(outlet.node).name.clone())
        .collect();
    let plan = model
        .into_optimized()
        .and_then(TypedModel::into_runnable)
        .map_err(|error| failed("model", error.to_string()))?;
    Ok(Loaded {
        tokenizer,
        plan,
        inputs,
    })
}

fn encode_all(
    tokenizer: &Tokenizer,
    texts: Vec<String>,
    max_tokens: usize,
) -> Result<Vec<Vec<i64>>, EmbedError> {
    texts
        .into_iter()
        .map(|text| {
            let encoding = tokenizer
                .encode(text, true)
                .map_err(|error| EmbedError::plain(format!("Could not tokenize: {error}")))?;
            Ok(clip_tokens(
                encoding.get_ids().iter().map(|id| i64::from(*id)).collect(),
                max_tokens,
            ))
        })
        .collect()
}

fn run_group(loaded: &Loaded, rows: &[Vec<i64>]) -> Result<Vec<Vec<f32>>, EmbedError> {
    let failed =
        |error: TractError| EmbedError::plain(format!("The embedding model failed: {error}"));
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    let cells = rows.len() * width;
    let mut ids = vec![0_i64; cells];
    let mut mask = vec![0_i64; cells];
    for (row, tokens) in rows.iter().enumerate() {
        for (column, token) in tokens.iter().enumerate() {
            ids[row * width + column] = *token;
            mask[row * width + column] = 1;
        }
    }
    let shape = [rows.len(), width];
    let tensor = |values: Vec<i64>| Tensor::from_shape(&shape, &values).map_err(failed);
    let mut feeds = TVec::new();
    for name in &loaded.inputs {
        let values = match name.as_str() {
            "input_ids" => ids.clone(),
            "attention_mask" => mask.clone(),
            _ => vec![0_i64; cells],
        };
        feeds.push(tensor(values)?.into());
    }
    let outputs = loaded.plan.run(feeds).map_err(failed)?;
    let output = outputs
        .first()
        .ok_or_else(|| EmbedError::plain("The embedding model gave no output"))?;
    let dims = output.shape().get(2).copied().unwrap_or(0);
    let plain = output.try_as_plain_ram().map_err(failed)?;
    let data = plain.as_slice::<f32>().map_err(failed)?;
    Ok(rows
        .iter()
        .enumerate()
        .map(|(row, tokens)| mean_pool(data, row, tokens.len(), width, dims))
        .collect())
}

/// Any OpenAI-compatible `/embeddings` endpoint: OpenAI itself, or a local server that speaks its API.
pub struct OpenAiEmbedder {
    base_url: Option<String>,
    api_key: Option<String>,
    model: String,
}

impl OpenAiEmbedder {
    pub fn new(base_url: Option<String>, api_key: Option<String>, model: String) -> Self {
        Self {
            base_url: base_url.filter(|url| !url.is_empty()),
            api_key,
            model,
        }
    }

    fn id(&self) -> String {
        format!(
            "openai:{}:{}",
            self.base_url.as_deref().unwrap_or("api.openai.com"),
            self.model
        )
    }

    async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
        let base = self
            .base_url
            .as_deref()
            .unwrap_or("https://api.openai.com/v1")
            .trim_end_matches('/');
        let client = client_builder()
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|error| EmbedError::plain(error.to_string()))?;
        let key = self
            .api_key
            .as_deref()
            .filter(|key| !key.is_empty())
            .unwrap_or("none");
        let response = client
            .post(format!("{base}/embeddings"))
            .bearer_auth(key)
            .json(&json!({ "model": self.model, "input": texts }))
            .send_noted()
            .await
            .map_err(|error| {
                EmbedError::plain(if error.is_connect() {
                    "Connection error: could not connect to the embedding model".to_owned()
                } else {
                    format!(
                        "The embedding model did not answer: {}",
                        error.without_url()
                    )
                })
            })?;
        let status = response.status();
        let body = response.text().await.map_err(|error| {
            EmbedError::plain(format!(
                "The embedding model did not answer: {}",
                error.without_url()
            ))
        })?;
        let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        if !status.is_success() {
            let message = parsed["error"]["message"]
                .as_str()
                .or_else(|| parsed["message"].as_str())
                .map_or_else(|| body.chars().take(300).collect(), str::to_owned);
            return Err(EmbedError::plain(format!("{} {message}", status.as_u16())));
        }
        read_embeddings(&parsed, texts.len())
    }
}

/// The vectors of an `/embeddings` answer, in the order asked (its `index` fields say which is which). A vector is a list
/// of numbers, or base64 of little-endian floats from a server that prefers those.
fn read_embeddings(answer: &Value, expected: usize) -> Result<Vec<Vec<f32>>, EmbedError> {
    let malformed = || EmbedError::plain("The embedding model's answer could not be read");
    let mut items: Vec<&Value> = answer["data"]
        .as_array()
        .ok_or_else(malformed)?
        .iter()
        .collect();
    items.sort_by_key(|item| item["index"].as_u64().unwrap_or(0));
    if items.len() != expected {
        return Err(malformed());
    }
    items
        .into_iter()
        .map(|item| match &item["embedding"] {
            Value::Array(values) => values
                .iter()
                .map(|value| {
                    value
                        .as_f64()
                        .map(|number| number as f32)
                        .ok_or_else(malformed)
                })
                .collect(),
            Value::String(encoded) => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| malformed())?;
                Ok(bytes
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|four| f32::from_le_bytes(*four))
                    .collect())
            }
            _ => Err(malformed()),
        })
        .collect()
}

/// What embeds an index. Vectors from different ids never mix in one index.
pub enum Embedder {
    Builtin(Arc<OnnxEmbedder>),
    LmStudio { base_url: String, model: String },
    OpenAi(OpenAiEmbedder),
}

impl Embedder {
    /// Source and model, e.g. "builtin:multilingual-e5-small".
    pub fn id(&self) -> String {
        match self {
            Self::Builtin(embedder) => format!("builtin:{}", embedder.model.name),
            Self::LmStudio { model, .. } => format!("lmstudio:{model}"),
            Self::OpenAi(embedder) => embedder.id(),
        }
    }

    pub async fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        match self {
            Self::Builtin(embedder) => embedder.embed(texts, kind).await,
            Self::OpenAi(embedder) => embedder.embed(texts).await,
            Self::LmStudio { base_url, model } => {
                let url = openai_compatible_url(base_url)
                    .map_err(|error| EmbedError::plain(error.message))?;
                OpenAiEmbedder::new(Some(url), Some("lm-studio".to_owned()), model.clone())
                    .embed(texts)
                    .await
                    .map_err(|error| lm_studio_error(error, model))
            }
        }
    }
}

/// LM Studio's failures in the words of what to do about them.
fn lm_studio_error(error: EmbedError, model: &str) -> EmbedError {
    let text = error.message.to_lowercase();
    if ["econnrefused", "not running", "connect"]
        .iter()
        .any(|word| text.contains(word))
    {
        return EmbedError::new(
            Some(503),
            "LM Studio is not running. Start it, or switch the code index to the built-in embedding model in Settings → General.",
        );
    }
    if [
        "not found",
        "no model",
        "unknown model",
        "does not exist",
        "not loaded",
        "404",
    ]
    .iter()
    .any(|word| text.contains(word))
    {
        return EmbedError::new(
            Some(409),
            format!(
                "The embedding model \"{model}\" is not downloaded in LM Studio. Download it there, or choose another in Settings → General."
            ),
        );
    }
    error
}

/// The built-in embedders of one data folder, each loaded once.
#[derive(Default)]
pub struct BuiltinEmbedders {
    loaded: Mutex<HashMap<String, Arc<OnnxEmbedder>>>,
}

impl BuiltinEmbedders {
    pub fn get(&self, data_root: &Path, model: &'static BuiltinModel) -> Arc<OnnxEmbedder> {
        let mut loaded = self.loaded.lock().unwrap_or_else(PoisonError::into_inner);
        Arc::clone(
            loaded
                .entry(model.name.to_owned())
                .or_insert_with(|| Arc::new(OnnxEmbedder::new(data_root.to_path_buf(), model))),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mean_pooling_averages_a_rows_real_tokens_and_scales_to_length_one() {
        // Two rows of width 3, two dims; row 1 has two real tokens and one padding token.
        let data = [1.0, 0.0, 3.0, 0.0, 9.0, 9.0, 0.0, 2.0, 0.0, 2.0, 9.0, 9.0];
        assert_eq!(mean_pool(&data, 0, 2, 3, 2), [1.0, 0.0]);
        assert_eq!(mean_pool(&data, 1, 2, 3, 2), [0.0, 1.0]);
    }

    #[test]
    fn batches_are_split_so_no_inference_holds_more_padded_tokens_than_the_budget() {
        let rows = |lengths: &[usize]| lengths.iter().map(|length| vec![1_i64; *length]).collect();
        let lengths = |groups: Vec<Vec<Vec<i64>>>| {
            groups
                .into_iter()
                .map(|group| group.iter().map(Vec::len).collect::<Vec<_>>())
                .collect::<Vec<_>>()
        };
        let full = token_budget_groups(rows(&[512; 32]), MAX_BATCH_TOKENS);
        assert_eq!(full.iter().map(Vec::len).collect::<Vec<_>>(), [8, 8, 8, 8]);
        assert_eq!(
            lengths(token_budget_groups(rows(&[10, 10, 30, 5, 90]), 60)),
            [vec![10, 10], vec![30, 5], vec![90]]
        );
        assert!(token_budget_groups(Vec::new(), 60).is_empty());
    }

    #[test]
    fn long_tokens_keep_their_closing_one() {
        assert_eq!(clip_tokens(vec![1, 2, 3, 4, 5], 3), [1, 2, 5]);
        assert_eq!(clip_tokens(vec![1, 2], 3), [1, 2]);
    }

    #[test]
    fn answers_are_read_in_index_order_as_numbers_or_base64() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(
            [1.0_f32, 0.5]
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect::<Vec<_>>(),
        );
        let answer = json!({ "data": [
            { "index": 1, "embedding": encoded },
            { "index": 0, "embedding": [0.25, 2.0] },
        ] });
        assert_eq!(
            read_embeddings(&answer, 2).unwrap(),
            [vec![0.25, 2.0], vec![1.0, 0.5]]
        );
        assert!(read_embeddings(&answer, 3).is_err());
    }
}
