use serde_json::{json, Value};

use crate::api::models::Usage;

/// The wire format a provider uses for streaming.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Wire {
    OpenAI,
    Anthropic,
    Google,
}

pub fn wire_for(provider: &str) -> Wire {
    match provider {
        "openai" => Wire::OpenAI,
        "anthropic" => Wire::Anthropic,
        "google" => Wire::Google,
        _ => Wire::OpenAI,
    }
}

/// Converts provider-specific SSE `data:` payloads into OpenAI-format
/// `chat.completion.chunk` events and tracks token usage along the way.
pub struct StreamConverter {
    id: String,
    created: i64,
    model: String,
    pub usage: Usage,
    done_sent: bool,
    role_sent: bool,
}

impl StreamConverter {
    pub fn new(model: String) -> Self {
        Self {
            id: format!("chatcmpl-{}", uuid::Uuid::new_v4()),
            created: chrono::Utc::now().timestamp(),
            model,
            usage: Usage {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            },
            done_sent: false,
            role_sent: false,
        }
    }

    /// Process one `data:` payload line (JSON or the literal "[DONE]").
    /// Returns formatted SSE events ready to forward downstream.
    pub fn process(&mut self, wire: Wire, data: &str) -> Vec<String> {
        let data = data.trim();
        if data.is_empty() {
            return vec![];
        }

        if data == "[DONE]" {
            self.done_sent = true;
            return vec!["data: [DONE]\n\n".to_string()];
        }

        let value = match serde_json::from_str::<Value>(data) {
            Ok(v) => v,
            Err(_) => return vec![], // ignore unparseable lines
        };

        match wire {
            Wire::OpenAI => self.openai_chunk(value),
            Wire::Anthropic => self.anthropic_chunk(value),
            Wire::Google => self.google_chunk(value),
        }
    }

    /// Providers that do not terminate with `[DONE]` need one appended.
    pub fn needs_done(&self) -> bool {
        !self.done_sent
    }

    // ---------- OpenAI ----------
    // Format: {"choices":[{"delta":{...},"finish_reason":null|"..."}], "usage":{...} (optional)}
    fn openai_chunk(&mut self, v: Value) -> Vec<String> {
        if let Some(usage) = v.get("usage").filter(|u| u.is_object()) {
            let prompt = usage
                .get("prompt_tokens")
                .and_then(|t| t.as_u64())
                .unwrap_or(0) as u32;
            let completion = usage
                .get("completion_tokens")
                .and_then(|t| t.as_u64())
                .unwrap_or(0) as u32;
            self.ingest_usage(prompt, completion);
        }

        let Some(choice) = v
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
        else {
            return vec![]; // usage-only chunk
        };

        let delta = choice.get("delta").cloned();
        let finish = choice
            .get("finish_reason")
            .and_then(|f| f.as_str())
            .map(|s| s.to_string());

        vec![self.emit(delta, finish)]
    }

    // ---------- Anthropic ----------
    // events: message_start, content_block_delta, message_delta, message_stop
    fn anthropic_chunk(&mut self, v: Value) -> Vec<String> {
        match v.get("type").and_then(|t| t.as_str()) {
            Some("message_start") => {
                let input = v["message"]["usage"]["input_tokens"]
                    .as_u64()
                    .unwrap_or(0) as u32;
                self.ingest_usage(input, 0);
                vec![self.emit(Some(json!({"role": "assistant", "content": ""})), None)]
            }
            Some("content_block_delta") => {
                let text = v["delta"]["text"].as_str().unwrap_or("");
                if text.is_empty() {
                    vec![]
                } else {
                    vec![self.emit(Some(json!({ "content": text })), None)]
                }
            }
            Some("message_delta") => {
                let completion = v["usage"]["output_tokens"].as_u64().unwrap_or(0) as u32;
                self.ingest_usage(self.usage.prompt_tokens, completion);
                let finish = v["delta"]["stop_reason"]
                    .as_str()
                    .map(|s| match s {
                        "max_tokens" => "length",
                        "tool_use" => "tool_calls",
                        _ => "stop",
                    })
                    .map(|s| s.to_string());
                vec![self.emit(None, finish)]
            }
            Some("message_stop") => {
                self.done_sent = true;
                vec!["data: [DONE]\n\n".to_string()]
            }
            _ => vec![],
        }
    }

    // ---------- Google ----------
    // Format: {"candidates":[{"content":{"parts":[{"text":...}]},"finishReason":...}], "usageMetadata":{...}}
    fn google_chunk(&mut self, v: Value) -> Vec<String> {
        if let Some(meta) = v.get("usageMetadata") {
            let prompt = meta
                .get("promptTokenCount")
                .and_then(|t| t.as_u64())
                .unwrap_or(0) as u32;
            let completion = meta
                .get("candidatesTokenCount")
                .and_then(|t| t.as_u64())
                .unwrap_or(0) as u32;
            self.ingest_usage(prompt, completion);
        }

        let Some(candidate) = v
            .get("candidates")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
        else {
            return vec![];
        };

        let mut delta: Option<Value> = None;
        if let Some(parts) = candidate
            .get("content")
            .and_then(|c| c.get("parts"))
            .and_then(|p| p.as_array())
        {
            let text: String = parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect();
            if !text.is_empty() {
                let mut d = json!({"content": text});
                if !self.role_sent {
                    d["role"] = json!("assistant");
                }
                delta = Some(d);
            }
        }

        let finish = candidate
            .get("finishReason")
            .and_then(|f| f.as_str())
            .map(|s| match s {
                "MAX_TOKENS" => "length",
                _ => "stop",
            })
            .map(|s| s.to_string());

        if let Some(finish) = finish {
            self.role_sent = true;
            vec![self.emit(delta, Some(finish))]
        } else if delta.is_some() {
            self.role_sent = true;
            vec![self.emit(delta, None)]
        } else {
            vec![]
        }
    }

    /// Keep the max seen for each direction (providers repeat cumulative values).
    fn ingest_usage(&mut self, prompt: u32, completion: u32) {
        if prompt > self.usage.prompt_tokens {
            self.usage.prompt_tokens = prompt;
        }
        if completion > self.usage.completion_tokens {
            self.usage.completion_tokens = completion;
        }
        self.usage.total_tokens = self.usage.prompt_tokens + self.usage.completion_tokens;
    }

    fn emit(&self, delta: Option<Value>, finish: Option<String>) -> String {
        let payload = json!({
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{
                "index": 0,
                "delta": delta.unwrap_or(json!({})),
                "finish_reason": finish,
            }],
        });
        format!("data: {payload}\n\n")
    }
}
