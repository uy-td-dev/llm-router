use async_trait::async_trait;
use serde_json::{json, Value};

use crate::api::models::{ChatCompletionRequest, ChatCompletionResponse, Message, Usage};
use crate::config::ProviderConfig;
use crate::providers::traits::{LLMProvider, err};
use crate::utils::Result;

pub struct OpenAIProvider {
    config: ProviderConfig,
}

impl OpenAIProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl LLMProvider for OpenAIProvider {
    fn name(&self) -> &str {
        &self.config.name
    }

    fn models(&self) -> Vec<String> {
        self.config.models.iter().map(|m| m.name.clone()).collect()
    }

    fn translate_request(&self, req: &ChatCompletionRequest) -> Result<Value> {
        // OpenAI format is already the standard
        let mut body = json!({
            "model": req.model,
            "messages": req.messages,
            "temperature": req.temperature,
            "top_p": req.top_p,
            "max_tokens": req.max_tokens,
            "stream": req.stream,
            "stop": req.stop,
        });
        if req.stream {
            // Ask OpenAI to include a usage chunk at the end of the stream
            body["stream_options"] = json!({"include_usage": true});
        }
        if let Some(tools) = &req.tools {
            body["tools"] = json!(tools);
            if let Some(choice) = &req.tool_choice {
                body["tool_choice"] = json!(choice);
            }
        }
        Ok(body)
    }

    fn build_http_request(
        &self,
        req: &ChatCompletionRequest,
        api_key: &str,
    ) -> Result<(String, Vec<(String, String)>, Value)> {
        let url = format!("{}/chat/completions", self.config.base_url);
        let mut headers = vec![
            ("Content-Type".to_string(), "application/json".to_string()),
            ("Authorization".to_string(), format!("Bearer {}", api_key)),
        ];
        headers.extend(self.config.headers.iter().map(|(k, v)| (k.clone(), v.clone())));
        let body = self.translate_request(req)?;
        Ok((url, headers, body))
    }

    fn normalize_response(&self, raw: Value, model: &str) -> Result<ChatCompletionResponse> {
        let obj = raw.as_object().ok_or_else(|| err("Expected object"))?;

        let id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("chatcmpl-unknown")
            .to_string();

        let choices = obj
            .get("choices")
            .and_then(|v| v.as_array())
            .ok_or_else(|| err("Missing choices"))?;

        let first = choices
            .first()
            .and_then(|c| c.as_object())
            .ok_or_else(|| err("No first choice"))?;

        let message_obj = first
            .get("message")
            .and_then(|m| m.as_object())
            .ok_or_else(|| err("No message"))?;

        let role = message_obj
            .get("role")
            .and_then(|r| r.as_str())
            .unwrap_or("assistant")
            .to_string();

        let content = message_obj
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();

        let message = Message {
            role,
            content: content.into(),
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
                    .get("prompt_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32,
                completion_tokens: u
                    .get("completion_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32,
                total_tokens: u
                    .get("total_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32,
            }
        } else {
            Usage {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            }
        }
    }

    fn supports_embeddings(&self) -> bool {
        true
    }

    fn build_embedding_http_request(
        &self,
        model: &str,
        input: &str,
        api_key: &str,
    ) -> Result<(String, Vec<(String, String)>, Value)> {
        let url = format!("{}/embeddings", self.config.base_url);
        let mut headers = vec![
            ("Content-Type".to_string(), "application/json".to_string()),
            ("Authorization".to_string(), format!("Bearer {}", api_key)),
        ];
        headers.extend(self.config.headers.iter().map(|(k, v)| (k.clone(), v.clone())));
        let body = json!({ "model": model, "input": input });
        Ok((url, headers, body))
    }

    fn normalize_embedding_response(&self, raw: Value) -> Result<(Vec<f32>, Option<u32>)> {
        let emb = raw
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|a| a.first())
            .and_then(|e| e.get("embedding"))
            .and_then(|v| v.as_array())
            .ok_or_else(|| err("Embedding response missing data[0].embedding"))?;
        let vector = emb
            .iter()
            .filter_map(|v| v.as_f64())
            .map(|f| f as f32)
            .collect();
        let tokens = raw
            .get("usage")
            .and_then(|u| u.get("prompt_tokens"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32);
        Ok((vector, tokens))
    }
}
