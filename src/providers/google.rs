use async_trait::async_trait;
use serde_json::{json, Value};

use crate::api::models::{ChatCompletionRequest, ChatCompletionResponse, Message, Usage};
use crate::config::ProviderConfig;
use crate::providers::traits::{LLMProvider, err};
use crate::utils::Result;

pub struct GoogleProvider {
    config: ProviderConfig,
}

impl GoogleProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl LLMProvider for GoogleProvider {
    fn name(&self) -> &str {
        &self.config.name
    }

    fn models(&self) -> Vec<String> {
        self.config.models.iter().map(|m| m.name.clone()).collect()
    }

    fn translate_request(&self, req: &ChatCompletionRequest) -> Result<Value> {
        let mut contents = Vec::new();

        for msg in &req.messages {
            let role = if msg.role == "assistant" {
                "model"
            } else {
                "user"
            };

            let mut parts: Vec<Value> = msg
                .content
                .images()
                .iter()
                .filter_map(|url| crate::providers::traits::parse_data_url(url))
                .map(|(mime, data)| json!({"inlineData": {"mimeType": mime, "data": data}}))
                .collect();
            let text = msg.content.text();
            if !text.is_empty() || parts.is_empty() {
                parts.push(json!({"text": text}));
            }
            contents.push(json!({
                "role": role,
                "parts": parts
            }));
        }

        let mut body = json!({
            "contents": contents,
        });

        let mut generation_config = json!({});

        if let Some(temp) = req.temperature {
            generation_config["temperature"] = json!(temp);
        }

        if let Some(top_p) = req.top_p {
            generation_config["topP"] = json!(top_p);
        }

        if let Some(max_tokens) = req.max_tokens {
            generation_config["maxOutputTokens"] = json!(max_tokens);
        }

        if let Some(ref stop) = req.stop {
            generation_config["stopSequences"] = json!(stop);
        }

        if !generation_config.as_object().unwrap().is_empty() {
            body["generationConfig"] = generation_config;
        }

        Ok(body)
    }

    fn build_http_request(
        &self,
        req: &ChatCompletionRequest,
        api_key: &str,
    ) -> Result<(String, Vec<(String, String)>, Value)> {
        let method = if req.stream {
            "streamGenerateContent"
        } else {
            "generateContent"
        };
        let mut url = format!("{}/models/{}:{}", self.config.base_url, req.model, method);
        if req.stream {
            url.push_str("?alt=sse");
        }
        // Key in a header (not the query string) so it never lands in URL logs
        let headers = vec![
            ("Content-Type".to_string(), "application/json".to_string()),
            ("x-goog-api-key".to_string(), api_key.to_string()),
        ];
        let body = self.translate_request(req)?;
        Ok((url, headers, body))
    }

    fn normalize_response(&self, raw: Value, model: &str) -> Result<ChatCompletionResponse> {
        let obj = raw.as_object().ok_or_else(|| err("Expected object"))?;

        let candidates = obj
            .get("candidates")
            .and_then(|v| v.as_array())
            .ok_or_else(|| err("Missing candidates"))?;

        let first = candidates
            .first()
            .and_then(|c| c.as_object())
            .ok_or_else(|| err("No first candidate"))?;

        let content_obj = first
            .get("content")
            .and_then(|c| c.as_object())
            .ok_or_else(|| err("No content"))?;

        let parts = content_obj
            .get("parts")
            .and_then(|p| p.as_array())
            .ok_or_else(|| err("No parts"))?;

        let text = parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("");

        let message = Message {
            role: "assistant".to_string(),
            content: text.into(),
            tool_calls: None,
            tool_call_id: None,
            reasoning: None,
        };

        let usage = self.normalize_usage(obj.get("usageMetadata"));

        Ok(ChatCompletionResponse::new(
            uuid::Uuid::new_v4().to_string(),
            model.to_string(),
            message,
            usage,
        ))
    }

    fn normalize_usage(&self, raw_usage: Option<&Value>) -> Usage {
        if let Some(u) = raw_usage.and_then(|v| v.as_object()) {
            Usage {
                prompt_tokens: u
                    .get("promptTokenCount")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32,
                completion_tokens: u
                    .get("candidatesTokenCount")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32,
                total_tokens: u
                    .get("totalTokenCount")
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
        let url = format!("{}/models/{}:embedContent", self.config.base_url, model);
        let headers = vec![
            ("Content-Type".to_string(), "application/json".to_string()),
            ("x-goog-api-key".to_string(), api_key.to_string()),
        ];
        let body = json!({ "content": { "parts": [{ "text": input }] } });
        Ok((url, headers, body))
    }

    fn normalize_embedding_response(&self, raw: Value) -> Result<(Vec<f32>, Option<u32>)> {
        let emb = raw
            .get("embedding")
            .and_then(|e| e.get("values"))
            .and_then(|v| v.as_array())
            .ok_or_else(|| err("Embedding response missing embedding.values"))?;
        let vector = emb
            .iter()
            .filter_map(|v| v.as_f64())
            .map(|f| f as f32)
            .collect();
        // embedContent does not report token usage
        Ok((vector, None))
    }
}
