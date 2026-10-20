use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::models::{ChatCompletionRequest, ChatCompletionResponse, Usage};
use crate::config::CostConfig;
use crate::utils::{Result, RouterError};

/// Provider execution result before normalization
#[derive(Debug, Clone)]
pub struct ProviderResponse {
    pub raw: Value,
    pub model: String,
}

/// A routable (provider, model) pair with metadata
#[derive(Debug, Clone)]
pub struct ProviderInfo {
    pub provider: String,
    pub model: String,
    pub cost: CostConfig,
    pub is_healthy: bool,
    /// Model is an embeddings model (routable via /v1/embeddings).
    pub is_embedding: bool,
}

#[async_trait]
pub trait LLMProvider: Send + Sync {
    fn name(&self) -> &str;

    fn models(&self) -> Vec<String>;

    fn supports(&self, model: &str) -> bool {
        self.models().iter().any(|m| {
            m == model
                || (m.ends_with("-latest") && model.starts_with(m.trim_end_matches("-latest")))
        })
    }

    /// Translate OpenAI-format request into this provider's wire format.
    fn translate_request(&self, req: &ChatCompletionRequest) -> Result<Value>;

    /// Build the full provider HTTP request (URL + headers + body).
    /// `api_key` comes from the selected upstream account.
    fn build_http_request(
        &self,
        req: &ChatCompletionRequest,
        api_key: &str,
    ) -> Result<(String, Vec<(String, String)>, Value)>;

    /// Translate provider wire response into OpenAI format.
    fn normalize_response(
        &self,
        raw: Value,
        model: &str,
    ) -> Result<ChatCompletionResponse>;

    /// Normalize a provider-specific usage object into OpenAI usage.
    fn normalize_usage(&self, raw_usage: Option<&Value>) -> Usage;

    fn calculate_cost(&self, cost_cfg: &CostConfig, usage: &Usage) -> f64 {
        let input = usage.prompt_tokens as f64 / 1_000_000.0 * cost_cfg.input_per_1m;
        let output = usage.completion_tokens as f64 / 1_000_000.0 * cost_cfg.output_per_1m;
        input + output
    }

    async fn health_check(&self, client: &reqwest::Client) -> bool {
        // Default: assume healthy. Providers override with a real probe.
        let _ = client;
        true
    }

    /// Whether this provider exposes an embeddings API.
    fn supports_embeddings(&self) -> bool {
        false
    }

    /// Build the single-input embeddings HTTP request (URL + headers + body).
    /// `api_key` comes from the selected upstream account.
    fn build_embedding_http_request(
        &self,
        _model: &str,
        _input: &str,
        _api_key: &str,
    ) -> Result<(String, Vec<(String, String)>, Value)> {
        Err(err(format!(
            "Provider {} does not support embeddings",
            self.name()
        )))
    }

    /// Extract (embedding vector, optional prompt-token count) from the
    /// provider's raw embeddings response.
    fn normalize_embedding_response(&self, _raw: Value) -> Result<(Vec<f32>, Option<u32>)> {
        Err(err(format!(
            "Provider {} does not support embeddings",
            self.name()
        )))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderModelInfo {
    pub name: String,
    pub cost: CostConfig,
}

/// `data:<mime>;base64,<data>` → (mime, data).
pub fn parse_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let mime = meta.strip_suffix(";base64")?;
    Some((mime.to_string(), data.to_string()))
}

pub fn err(msg: impl Into<String>) -> RouterError {
    RouterError::Internal(msg.into())
}