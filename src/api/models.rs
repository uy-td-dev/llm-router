use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatCompletionRequest {
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub top_p: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub stop: Option<Vec<String>>,
    /// OpenAI function-calling tools, forwarded verbatim to OpenAI-format
    /// upstreams (agents like OpenCode/Cline depend on them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Message {
    pub role: String,
    #[serde(default)]
    pub content: MessageContent,
    /// Assistant tool calls (OpenAI format) on this turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<serde_json::Value>>,
    /// Tool-call id when role == "tool".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Reasoning trace chunks some models stream (`reasoning_content`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<serde_json::Value>,
}

/// OpenAI message content: plain string or multimodal parts
/// (`{"type":"text"}` / `{"type":"image_url"}`).
///
/// Serialization is untagged (`"hi"` / `[{"type":"text",…}]`), so re-sending
/// the message upstream produces the exact OpenAI wire shape. Deserialization
/// is deliberately permissive: clients (AI SDK, OpenCode, Cline…) also send a
/// bare object, `null`, numbers or booleans, and a strict untagged enum
/// rejects those with a 422 before the request is even routed.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<serde_json::Value>),
}

impl<'de> Deserialize<'de> for MessageContent {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde_json::Value;
        let value = Value::deserialize(deserializer)?;
        Ok(match value {
            Value::String(s) => MessageContent::Text(s),
            Value::Array(parts) => MessageContent::Parts(parts),
            // Single content block instead of an array
            Value::Object(_) => MessageContent::Parts(vec![value]),
            Value::Null => MessageContent::Text(String::new()),
            // number / bool: coerce to its JSON text form
            other => MessageContent::Text(other.to_string()),
        })
    }
}

impl Default for MessageContent {
    fn default() -> Self {
        MessageContent::Text(String::new())
    }
}

impl From<String> for MessageContent {
    fn from(s: String) -> Self {
        MessageContent::Text(s)
    }
}

impl MessageContent {
    /// Concatenated text parts.
    pub fn text(&self) -> String {
        match self {
            MessageContent::Text(s) => s.clone(),
            MessageContent::Parts(parts) => parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }

    /// Image URLs (`data:` or http) contained in the parts.
    pub fn images(&self) -> Vec<String> {
        match self {
            MessageContent::Text(_) => vec![],
            MessageContent::Parts(parts) => parts
                .iter()
                .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("image_url"))
                .filter_map(|p| {
                    p["image_url"]
                        .get("url")
                        .and_then(|u| u.as_str())
                        .or_else(|| p["image_url"].as_str())
                        .map(str::to_string)
                })
                .collect(),
        }
    }

    pub fn len(&self) -> usize {
        match self {
            MessageContent::Text(s) => s.len(),
            MessageContent::Parts(_) => self.text().len(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatCompletionResponse {
    pub id: String,
    pub object: String,
    pub created: i64,
    pub model: String,
    pub choices: Vec<Choice>,
    pub usage: Usage,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Choice {
    pub index: u32,
    pub message: Message,
    pub finish_reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ErrorResponse {
    pub error: ErrorDetail,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ErrorDetail {
    pub message: String,
    #[serde(rename = "type")]
    pub error_type: String,
}

/// Request context produced by auth middleware — who is calling and
/// what this key is allowed to use.
#[derive(Debug, Clone)]
pub struct KeyContext {
    pub key: String,
    pub label: String,
    pub owner: String,
    /// Glob patterns of allowed model ids / aliases.
    pub allowed_models: Vec<String>,
    /// Glob patterns of allowed provider names; None = all.
    pub allowed_providers: Option<Vec<String>>,
    /// Per-key RPM override (already enforced by middleware).
    pub rpm: Option<usize>,
    /// Maximum USD spend enforced in the router.
    pub monthly_budget_usd: Option<f64>,
    /// Team this key belongs to (None = global key).
    pub team: Option<String>,
}

impl KeyContext {
    pub fn anonymous() -> Self {
        Self {
            key: String::new(),
            label: "anonymous".to_string(),
            owner: "anonymous".to_string(),
            allowed_models: vec!["*".to_string()],
            allowed_providers: None,
            rpm: None,
            monthly_budget_usd: None,
            team: None,
        }
    }

    pub fn model_allowed(&self, model: &str) -> bool {
        self.allowed_models
            .iter()
            .any(|p| crate::utils::glob_match(p, model))
    }

    pub fn provider_allowed(&self, provider: &str) -> bool {
        match &self.allowed_providers {
            None => true,
            Some(patterns) => patterns.iter().any(|p| crate::utils::glob_match(p, provider)),
        }
    }
}

impl ChatCompletionResponse {
    pub fn new(id: String, model: String, message: Message, usage: Usage) -> Self {
        Self {
            id,
            object: "chat.completion".to_string(),
            created: chrono::Utc::now().timestamp(),
            model,
            choices: vec![Choice {
                index: 0,
                message,
                finish_reason: "stop".to_string(),
            }],
            usage,
        }
    }
}

// ---------------------------------------------------------------------------
// Embeddings (OpenAI-compatible)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct EmbeddingRequest {
    pub model: String,
    /// One string or an array of strings (batch).
    pub input: EmbeddingInput,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum EmbeddingInput {
    One(String),
    Many(Vec<String>),
}

impl EmbeddingInput {
    pub fn into_vec(self) -> Vec<String> {
        match self {
            EmbeddingInput::One(s) => vec![s],
            EmbeddingInput::Many(v) => v,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct EmbeddingsListResponse {
    pub object: String,
    pub data: Vec<EmbeddingObject>,
    pub model: String,
    pub usage: EmbeddingUsage,
}

#[derive(Debug, Clone, Serialize)]
pub struct EmbeddingObject {
    pub object: String,
    pub index: usize,
    pub embedding: Vec<f32>,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct EmbeddingUsage {
    pub prompt_tokens: u32,
    pub total_tokens: u32,
}
