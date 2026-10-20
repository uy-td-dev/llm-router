use async_trait::async_trait;
use serde_json::{json, Value};

use crate::api::models::{ChatCompletionRequest, ChatCompletionResponse, Message, MessageContent, Usage};
use crate::config::ProviderConfig;
use crate::providers::traits::{LLMProvider, err, parse_data_url};
use crate::utils::Result;

/// OAuth access tokens issued for claude.ai accounts (vs console API keys
/// `sk-ant-api…`).
pub fn is_oauth_token(api_key: &str) -> bool {
    api_key.starts_with("sk-ant-oat")
}

/// Beta flags Claude Code OAuth tokens require (interleaved thinking,
/// prompt caching, oauth grant, …). Requests without them are rejected with
/// an OAuth-specific error.
const OAUTH_BETA: &str = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28";

/// Headers a Claude Code CLI sends alongside an OAuth token.
fn oauth_headers(token: &str) -> Vec<(String, String)> {
    vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Authorization".to_string(), format!("Bearer {token}")),
        ("anthropic-version".to_string(), "2023-06-01".to_string()),
        ("anthropic-beta".to_string(), OAUTH_BETA.to_string()),
        ("anthropic-dangerous-direct-browser-access".to_string(), "true".to_string()),
        ("User-Agent".to_string(), "claude-cli/2.1.280 (external, sdk-cli)".to_string()),
        ("X-App".to_string(), "cli".to_string()),
        ("X-Stainless-Helper-Method".to_string(), "stream".to_string()),
        ("X-Stainless-Retry-Count".to_string(), "0".to_string()),
        ("X-Stainless-Runtime-Version".to_string(), "v24.14.0".to_string()),
        ("X-Stainless-Package-Version".to_string(), "0.80.0".to_string()),
        ("X-Stainless-Runtime".to_string(), "node".to_string()),
        ("X-Stainless-Lang".to_string(), "js".to_string()),
        ("X-Stainless-Arch".to_string(), "arm64".to_string()),
        ("X-Stainless-Os".to_string(), "MacOS".to_string()),
        ("X-Stainless-Timeout".to_string(), "600".to_string()),
    ]
}

pub struct AnthropicProvider {
    config: ProviderConfig,
}

impl AnthropicProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl LLMProvider for AnthropicProvider {
    fn name(&self) -> &str {
        &self.config.name
    }

    fn models(&self) -> Vec<String> {
        self.config.models.iter().map(|m| m.name.clone()).collect()
    }

    fn translate_request(&self, req: &ChatCompletionRequest) -> Result<Value> {
        // Extract system message if present
        let mut system_msg = String::new();
        let mut messages_vec = Vec::new();

        for msg in &req.messages {
            if msg.role == "system" {
                if !system_msg.is_empty() {
                    system_msg.push_str("\n\n");
                }
                system_msg.push_str(&msg.content.text());
            } else {
                let content = match &msg.content {
                    MessageContent::Text(s) => json!(s),
                    MessageContent::Parts(_) => {
                        let mut blocks: Vec<Value> = msg
                            .content
                            .images()
                            .iter()
                            .map(|url| match parse_data_url(url) {
                                Some((mime, data)) => json!({
                                    "type": "image",
                                    "source": {"type": "base64", "media_type": mime, "data": data}
                                }),
                                None => json!({
                                    "type": "image",
                                    "source": {"type": "url", "url": url}
                                }),
                            })
                            .collect();
                        let text = msg.content.text();
                        if !text.is_empty() {
                            blocks.push(json!({"type": "text", "text": text}));
                        }
                        json!(blocks)
                    }
                };
                messages_vec.push(json!({
                    "role": msg.role,
                    "content": content,
                }));
            }
        }

        let mut body = json!({
            "model": req.model,
            "messages": messages_vec,
            "max_tokens": req.max_tokens.unwrap_or(4096),
            "stream": req.stream,
        });

        if !system_msg.is_empty() {
            body["system"] = json!(system_msg);
        }

        if let Some(temp) = req.temperature {
            body["temperature"] = json!(temp);
        }

        if let Some(top_p) = req.top_p {
            body["top_p"] = json!(top_p);
        }

        if let Some(ref stop) = req.stop {
            body["stop_sequences"] = json!(stop);
        }

        Ok(body)
    }

    fn build_http_request(
        &self,
        req: &ChatCompletionRequest,
        api_key: &str,
    ) -> Result<(String, Vec<(String, String)>, Value)> {
        let url = format!("{}/messages", self.config.base_url);
        let mut body = self.translate_request(req)?;

        // Claude Code OAuth tokens need extra metadata + beta flags.
        if is_oauth_token(api_key) {
            // metadata.user_id must be a JSON string (device/account/session
            // ids), matching what the official Claude Code CLI sends.
            if body.get("metadata").and_then(|m| m.get("user_id")).is_none() {
                let device_id = format!("dev-{}", &api_key[api_key.len().min(32)..api_key.len().min(64)]);
                let account_uuid = format!("acct-{}", &api_key[api_key.len().min(64)..api_key.len().min(80)]);
                let user_id = format!(
                    r#"{{"device_id":"{device_id}","account_uuid":"{account_uuid}","session_id":"sess-{}"}}"#,
                    std::process::id()
                );
                match body.get_mut("metadata") {
                    Some(m) => { m["user_id"] = serde_json::json!(user_id); }
                    None => { body["metadata"] = serde_json::json!({"user_id": user_id}); }
                }
            }
            return Ok((url, oauth_headers(api_key), body));
        }

        let headers = vec![
            ("Content-Type".to_string(), "application/json".to_string()),
            ("x-api-key".to_string(), api_key.to_string()),
            ("anthropic-version".to_string(), "2023-06-01".to_string()),
        ];
        Ok((url, headers, body))
    }

    fn normalize_response(&self, raw: Value, model: &str) -> Result<ChatCompletionResponse> {
        let obj = raw.as_object().ok_or_else(|| err("Expected object"))?;

        let id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("msg_unknown")
            .to_string();

        let content_arr = obj
            .get("content")
            .and_then(|v| v.as_array())
            .ok_or_else(|| err("Missing content array"))?;

        let text = content_arr
            .iter()
            .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("");

        let message = Message {
            role: "assistant".to_string(),
            content: text.into(),
            tool_calls: None,
            tool_call_id: None,
            reasoning: None,
        };

        let usage = self.normalize_usage(obj.get("usage"));

        Ok(ChatCompletionResponse::new(id, model.to_string(), message, usage))
    }

    fn normalize_usage(&self, raw_usage: Option<&Value>) -> Usage {
        if let Some(u) = raw_usage.and_then(|v| v.as_object()) {
            Usage {
                prompt_tokens: u
                    .get("input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32,
                completion_tokens: u
                    .get("output_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32,
                total_tokens: (u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0)
                    + u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0))
                    as u32,
            }
        } else {
            Usage {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            }
        }
    }
}
