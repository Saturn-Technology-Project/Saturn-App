//! MLX on Apple silicon, through `mlx_lm.server`: its OpenAI-compatible Chat Completions takes tool definitions and images and
//! returns tool calls and the reasoning of thinking models; /v1/completions serves raw completions. It runs on this computer,
//! like LM Studio, so it is asked the same way.
use std::time::Duration;

use crate::http::{Http, LlmError};
use crate::lmstudio::{
    RawRequest, RawStream, complete_local, complete_raw_local, local_server_url,
};
use crate::{ChatRequest, Completion};

/// The name errors give the server.
const SERVER: &str = "mlx_lm.server";

/// One chat call to `mlx_lm.server`, which loads the model the request names.
pub async fn complete(http: &Http, request: &ChatRequest) -> Result<Completion, LlmError> {
    complete_local(http, request, SERVER, "mlx").await
}

/// The model's raw completion of a prompt, from `mlx_lm.server`'s /v1/completions.
pub async fn complete_raw(http: &Http, request: &RawRequest) -> Result<RawStream, LlmError> {
    complete_raw_local(http, request, SERVER).await
}

/// The models `mlx_lm.server` can load: the one it was started with and those in the Hugging Face cache. Embedding models are
/// left out, as they cannot chat.
pub async fn list_models(http: &Http, base_url: &str) -> Result<Vec<String>, LlmError> {
    let url = format!("{}/models", local_server_url(base_url, SERVER)?);
    let answer = http
        .get_json(&url, Duration::from_secs(4))
        .await
        .map_err(|_| LlmError::new(None, format!("{SERVER} is not running")))?;
    Ok(answer
        .as_ref()
        .and_then(|answer| answer["data"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| item["id"].as_str())
        .filter(|id| !id.to_lowercase().contains("embed"))
        .map(str::to_owned)
        .collect())
}
