use std::sync::Arc;
use std::time::Instant;

use bytes::Bytes;
use futures_util::StreamExt;
use tokio::sync::mpsc::Sender;
use tokio_stream::wrappers::ReceiverStream;

use crate::api::models::{ChatCompletionRequest, ChatCompletionResponse, KeyContext, Usage};
use crate::config::CostConfig;
use crate::execution::circuit_breaker::SharedCircuitBreaker;
use crate::execution::retry::RetryPolicy;
use crate::providers::ProviderRegistry;
use crate::tracking;
use crate::utils::{is_rate_limited, Result, RouterError, StreamConverter, Wire, wire_for};

/// One attempt target: provider + model to try.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub provider: String,
    pub model: String,
}

pub struct FallbackExecutor {
    pub registry: Arc<ProviderRegistry>,
    pub retry: RetryPolicy,
    pub breaker: SharedCircuitBreaker,
    pub http_client: reqwest::Client,
    /// Dedicated client without a request timeout, for SSE streams.
    pub stream_client: reqwest::Client,
}

impl FallbackExecutor {
    /// Try candidates in order. Per candidate, rotate upstream accounts:
    /// rate-limited accounts are put in cooldown and the next account is
    /// tried immediately; other failures move on to the next candidate.
    /// With alias-expanded candidates, this transparently switches
    /// provider/model without the client noticing.
    pub async fn execute(
        &self,
        candidates: &[Candidate],
        req: &ChatCompletionRequest,
        ctx: &KeyContext,
    ) -> Result<(ChatCompletionResponse, String, String)> {
        if candidates.is_empty() {
            return Err(RouterError::AllProvidersFailed);
        }

        let mut last_error: Option<RouterError> = None;

        for candidate in candidates {
            let (provider_name, model) = (candidate.provider.clone(), candidate.model.clone());

            if !self.breaker.allow(&provider_name, &model) {
                tracing::info!(
                    provider = %provider_name,
                    model = %model,
                    "Circuit open, skipping candidate"
                );
                last_error = Some(RouterError::Provider(format!(
                    "{provider_name}/{model} circuit open"
                )));
                continue;
            }

            let provider = match self.registry.get(&provider_name) {
                Some(p) => p.clone(),
                None => {
                    last_error = Some(RouterError::Provider(format!(
                        "Provider {provider_name} not registered"
                    )));
                    continue;
                }
            };

            let accounts = self.registry.rotate_accounts(&provider_name);
            if accounts.is_empty() {
                tracing::warn!(
                    provider = %provider_name,
                    model = %model,
                    "All upstream accounts in cooldown, trying next candidate"
                );
                last_error = Some(RouterError::Provider(format!(
                    "{provider_name}/{model}: all upstream accounts in cooldown"
                )));
                continue;
            }

            let mut candidate_exhausted = false;

            for account in accounts {
                let mut model_req = req.clone();
                model_req.model = model.clone();

                let started = Instant::now();
                let attempt_start = Instant::now();

                let provider_clone = provider.clone();
                let client = crate::hub::client_for(&provider_name, false)
                    .unwrap_or_else(|| self.http_client.clone());
                let breaker = self.breaker.clone();
                let pn = provider_name.clone();
                let mn = model.clone();
                let body = model_req.clone();
                let api_key = account.api_key.clone();
                let result = self
                    .retry
                    .execute(move || {
                        let pc = provider_clone.clone();
                        let cl = client.clone();
                        let bk = breaker.clone();
                        let b2 = body.clone();
                        let key = api_key.clone();
                        let pn2 = pn.clone();
                        let mn2 = mn.clone();

                        async move {
                            match Self::call_provider(&pc, &cl, &b2, &key).await {
                                Ok(resp) => {
                                    bk.record_success(&pn2, &mn2);
                                    Ok(resp)
                                }
                                Err(e) => {
                                    bk.record_failure(&pn2, &mn2);
                                    Err(e)
                                }
                            }
                        }
                    })
                    .await;
                let result_duration = attempt_start.elapsed().as_secs_f64();

                match result {
                    Ok(resp) => {
                        let _ = started;
                        let latency_ms = attempt_start.elapsed().as_millis();
                        tracking::metrics::record_success(&provider_name, &model, result_duration);
                        tracking::metrics::record_latency(&provider_name, &model, latency_ms);

                        // Compute cost & record usage
                        let cost_usd = self
                            .registry
                            .model_cost(&provider_name, &model)
                            .map(|c| {
                                c.input_per_1m * resp.usage.prompt_tokens as f64 / 1_000_000.0
                                    + c.output_per_1m * resp.usage.completion_tokens as f64
                                        / 1_000_000.0
                            })
                            .unwrap_or(0.0);

                        tracking::usage::record_usage(
                            ctx,
                            &req.model,
                            &provider_name,
                            &model,
                            &account.label,
                            &resp.usage,
                            cost_usd,
                            result_start_millis(attempt_start),
                        );
                        self.registry.record_account(&provider_name, &account.label, true, false);

                        return Ok((resp, provider_name, model));
                    }
                    Err(e) => {
                        if is_rate_limited(&e) {
                            // Rotate to the next upstream account immediately
                            // (record first so the adaptive cooldown sees the
                            // incremented consecutive-429 streak)
                            self.registry.record_account(&provider_name, &account.label, false, true);
                            self.registry.cooldown_account(&provider_name, &account.label);
                            tracking::metrics::record_failure(&provider_name, &model, result_duration);
                            tracing::warn!(
                                provider = %provider_name,
                                model = %model,
                                account = %account.label,
                                "Rate limited, rotating to next upstream account"
                            );
                            last_error = Some(e);
                            candidate_exhausted = true;
                            continue; // next account of same provider
                        }

                        self.registry.record_account(&provider_name, &account.label, false, false);
                        tracking::metrics::record_failure(&provider_name, &model, result_duration);
                        tracing::warn!(
                            provider = %provider_name,
                            model = %model,
                            account = %account.label,
                            "Candidate failed: {}",
                            e
                        );
                        last_error = Some(e);
                        candidate_exhausted = true;
                        break; // permanent failure: move to the next candidate (provider)
                    }
                }
            }

            let _ = candidate_exhausted;
        }

        Err(last_error.unwrap_or(RouterError::AllProvidersFailed))
    }

    /// Connectivity probe: one real upstream call with an explicit
    /// credential (no retry/rotation/breaker). Returns (reply, usage, ms).
    pub async fn test_credential(
        &self,
        provider_name: &str,
        model: &str,
        api_key: &str,
        prompt: &str,
    ) -> Result<(String, crate::api::models::Usage, u128)> {
        let provider = self
            .registry
            .get(provider_name)
            .ok_or_else(|| RouterError::InvalidRequest(format!("unknown provider '{provider_name}'")))?;
        self.probe(provider, model, api_key, prompt).await
    }

    /// Same probe against an arbitrary (possibly unregistered) provider.
    pub async fn probe(
        &self,
        provider: Arc<dyn crate::providers::traits::LLMProvider>,
        model: &str,
        api_key: &str,
        prompt: &str,
    ) -> Result<(String, crate::api::models::Usage, u128)> {
        let req: ChatCompletionRequest = serde_json::from_value(serde_json::json!({
            "model": model,
            "messages": [{ "role": "user", "content": prompt }],
            // headroom for models that count reasoning tokens (gemini-2.5)
            "max_tokens": 1024,
        }))
        .map_err(|e| RouterError::Internal(e.to_string()))?;
        let started = Instant::now();
        let client = crate::hub::client_for(provider.name(), false).unwrap_or_else(|| self.http_client.clone());
        let resp = Self::call_provider(&provider, &client, &req, api_key).await?;
        let text = resp
            .choices
            .first()
            .map(|c| c.message.content.text())
            .unwrap_or_default();
        Ok((text, resp.usage, started.elapsed().as_millis()))
    }

    async fn call_provider(
        provider: &Arc<dyn crate::providers::traits::LLMProvider>,
        client: &reqwest::Client,
        req: &ChatCompletionRequest,
        api_key: &str,
    ) -> Result<ChatCompletionResponse> {
        let (url, headers, body) = provider.build_http_request(req, api_key)?;

        let mut http_req = client.post(&url).json(&body);
        for (key, value) in headers {
            http_req = http_req.header(key, value);
        }

        let response = http_req.send().await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(RouterError::Provider(format!(
                "Provider {} returned {}: {}",
                provider.name(),
                status,
                // Truncate long error bodies
                error_text.chars().take(500).collect::<String>()
            )));
        }

        let raw: serde_json::Value = response.json().await?;
        let normalized = provider.normalize_response(raw, &req.model)?;
        Ok(normalized)
    }

    /// Streaming variant with the same account-rotation and transparent
    /// cross-provider fallback semantics.
    pub async fn execute_stream(
        &self,
        candidates: &[Candidate],
        req: &ChatCompletionRequest,
        ctx: &KeyContext,
    ) -> Result<(ReceiverStream<Bytes>, String, String)> {
        if candidates.is_empty() {
            return Err(RouterError::AllProvidersFailed);
        }

        let mut last_error: Option<RouterError> = None;

        for candidate in candidates {
            let (provider_name, model) = (candidate.provider.clone(), candidate.model.clone());

            if !self.breaker.allow(&provider_name, &model) {
                tracing::info!(
                    provider = %provider_name,
                    model = %model,
                    "Circuit open, skipping streaming candidate"
                );
                last_error = Some(RouterError::Provider(format!(
                    "{provider_name}/{model} circuit open"
                )));
                continue;
            }

            let provider = match self.registry.get(&provider_name) {
                Some(p) => p.clone(),
                None => {
                    last_error = Some(RouterError::Provider(format!(
                        "Provider {provider_name} not registered"
                    )));
                    continue;
                }
            };

            let accounts = self.registry.rotate_accounts(&provider_name);
            if accounts.is_empty() {
                tracing::warn!(
                    provider = %provider_name,
                    model = %model,
                    "All upstream accounts in cooldown, trying next streaming candidate"
                );
                last_error = Some(RouterError::Provider(format!(
                    "{provider_name}/{model}: all upstream accounts in cooldown"
                )));
                continue;
            }

            for account in accounts {
                let started = Instant::now();
                let mut model_req = req.clone();
                model_req.model = model.clone();
                model_req.stream = true;

                let (url, headers, body) = match provider.build_http_request(&model_req, &account.api_key) {
                    Ok(v) => v,
                    Err(e) => {
                        last_error = Some(e);
                        break;
                    }
                };

                let mut http_req = crate::hub::client_for(&provider_name, true)
                    .unwrap_or_else(|| self.stream_client.clone())
                    .post(&url)
                    .json(&body);
                for (key, value) in headers {
                    http_req = http_req.header(key, value);
                }

                let response = match http_req.send().await {
                    Ok(r) => r,
                    Err(e) => {
                        self.registry.record_account(&provider_name, &account.label, false, false);
                        self.breaker.record_failure(&provider_name, &model);
                        tracking::metrics::record_failure(
                            &provider_name,
                            &model,
                            started.elapsed().as_secs_f64(),
                        );
                        last_error = Some(e.into());
                        break; // next candidate
                    }
                };

                if !response.status().is_success() {
                    let status = response.status();
                    let error_text = response.text().await.unwrap_or_default();
                    let msg = format!(
                        "Provider {} returned {}: {}",
                        provider_name,
                        status,
                        error_text.chars().take(500).collect::<String>()
                    );
                    let error = RouterError::Provider(msg);

                    if is_rate_limited(&error) {
                        // record first -> adaptive cooldown sees new streak
                        self.registry.record_account(&provider_name, &account.label, false, true);
                        self.registry.cooldown_account(&provider_name, &account.label);
                        tracking::metrics::record_failure(
                            &provider_name,
                            &model,
                            started.elapsed().as_secs_f64(),
                        );
                        tracing::warn!(
                            provider = %provider_name,
                            model = %model,
                            account = %account.label,
                            "Rate limited, rotating to next upstream account (stream)"
                        );
                        continue; // next account
                    }

                    self.registry.record_account(&provider_name, &account.label, false, false);
                    self.breaker.record_failure(&provider_name, &model);
                    tracking::metrics::record_failure(
                        &provider_name,
                        &model,
                        started.elapsed().as_secs_f64(),
                    );
                    last_error = Some(error);
                    break; // next candidate
                }

                // Upstream accepted the stream; record success and spawn the pump.
                self.registry.record_account(&provider_name, &account.label, true, false);
                self.breaker.record_success(&provider_name, &model);
                let time_to_stream = started.elapsed().as_secs_f64();
                tracking::metrics::record_success(&provider_name, &model, time_to_stream);
                tracking::metrics::record_latency(
                    &provider_name,
                    &model,
                    started.elapsed().as_millis(),
                );

                let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(1024);
                let cost_cfg = self.registry.model_cost(&provider_name, &model);
                let wire = wire_for(
                    &self
                        .registry
                        .wire_format(&provider_name)
                        .unwrap_or_else(|| provider_name.clone()),
                );
                let requested_model = req.model.clone();
                let served_model = model.clone();
                let ctx2 = ctx.clone();
                let account_label = account.label.clone();

                tokio::spawn(Self::pipe_stream(
                        response,
                        wire,
                        provider_name.clone(),
                        served_model,
                        requested_model,
                        account_label,
                        ctx2,
                        cost_cfg,
                        started,
                        tx,
                ));

                return Ok((ReceiverStream::new(rx), provider_name, model));
            }
        }

        Err(last_error.unwrap_or(RouterError::AllProvidersFailed))
    }

    /// One embeddings call through the candidates, reusing the same
    /// account-rotation and transparent cross-provider fallback semantics.
    /// Returns (vector, prompt_tokens, provider, model).
    pub async fn execute_embedding(
        &self,
        candidates: &[Candidate],
        model_name: &str,
        input: &str,
        ctx: &KeyContext,
        requested_model: &str,
    ) -> Result<(Vec<f32>, u32, String, String)> {
        if candidates.is_empty() {
            return Err(RouterError::AllProvidersFailed);
        }

        let mut last_error: Option<RouterError> = None;

        for candidate in candidates {
            let (provider_name, model) = (candidate.provider.clone(), candidate.model.clone());

            if !self.breaker.allow(&provider_name, &model) {
                tracing::info!(
                    provider = %provider_name,
                    model = %model,
                    "Circuit open, skipping embedding candidate"
                );
                last_error = Some(RouterError::Provider(format!(
                    "{provider_name}/{model} circuit open"
                )));
                continue;
            }

            let provider = match self.registry.get(&provider_name) {
                Some(p) => p.clone(),
                None => {
                    last_error = Some(RouterError::Provider(format!(
                        "Provider {provider_name} not registered"
                    )));
                    continue;
                }
            };

            let accounts = self.registry.rotate_accounts(&provider_name);
            if accounts.is_empty() {
                tracing::warn!(
                    provider = %provider_name,
                    model = %model,
                    "All upstream accounts in cooldown, trying next embedding candidate"
                );
                last_error = Some(RouterError::Provider(format!(
                    "{provider_name}/{model}: all upstream accounts in cooldown"
                )));
                continue;
            }

            for account in accounts {
                let started = Instant::now();

                let (url, headers, body) =
                    match provider.build_embedding_http_request(model_name, input, &account.api_key)
                    {
                        Ok(v) => v,
                        Err(e) => {
                            last_error = Some(e);
                            break; // permanent: next candidate
                        }
                    };

                let mut http_req = crate::hub::client_for(&provider_name, false)
                    .unwrap_or_else(|| self.http_client.clone())
                    .post(&url)
                    .json(&body);
                for (key, value) in &headers {
                    http_req = http_req.header(key, value);
                }

                let response = match http_req.send().await {
                    Ok(r) => r,
                    Err(e) => {
                        self.registry.record_account(&provider_name, &account.label, false, false);
                        self.breaker.record_failure(&provider_name, &model);
                        tracking::metrics::record_failure(
                            &provider_name,
                            &model,
                            started.elapsed().as_secs_f64(),
                        );
                        last_error = Some(e.into());
                        break; // next candidate
                    }
                };

                if !response.status().is_success() {
                    let status = response.status();
                    let error_text = response.text().await.unwrap_or_default();
                    let error = RouterError::Provider(format!(
                        "Provider {} returned {}: {}",
                        provider_name,
                        status,
                        error_text.chars().take(500).collect::<String>()
                    ));

                    if is_rate_limited(&error) {
                        // record first -> adaptive cooldown sees new streak
                        self.registry.record_account(&provider_name, &account.label, false, true);
                        self.registry.cooldown_account(&provider_name, &account.label);
                        tracking::metrics::record_failure(
                            &provider_name,
                            &model,
                            started.elapsed().as_secs_f64(),
                        );
                        tracing::warn!(
                            provider = %provider_name,
                            model = %model,
                            account = %account.label,
                            "Rate limited, rotating to next upstream account (embeddings)"
                        );
                        continue; // next account
                    }

                    self.registry.record_account(&provider_name, &account.label, false, false);
                    self.breaker.record_failure(&provider_name, &model);
                    tracking::metrics::record_failure(
                        &provider_name,
                        &model,
                        started.elapsed().as_secs_f64(),
                    );
                    last_error = Some(error);
                    break; // next candidate
                }

                let raw: serde_json::Value = match response.json().await {
                    Ok(v) => v,
                    Err(e) => {
                        self.registry.record_account(&provider_name, &account.label, false, false);
                        self.breaker.record_failure(&provider_name, &model);
                        tracking::metrics::record_failure(
                            &provider_name,
                            &model,
                            started.elapsed().as_secs_f64(),
                        );
                        last_error = Some(e.into());
                        break; // next candidate
                    }
                };

                let (vector, tokens) = match provider.normalize_embedding_response(raw) {
                    Ok(v) => v,
                    Err(e) => {
                        self.registry.record_account(&provider_name, &account.label, false, false);
                        self.breaker.record_failure(&provider_name, &model);
                        tracking::metrics::record_failure(
                            &provider_name,
                            &model,
                            started.elapsed().as_secs_f64(),
                        );
                        last_error = Some(e);
                        break; // next candidate
                    }
                };

                // Success: record latency/usage/account health.
                let latency_ms = started.elapsed().as_millis();
                tracking::metrics::record_success(&provider_name, &model, started.elapsed().as_secs_f64());
                tracking::metrics::record_latency(&provider_name, &model, latency_ms);
                self.registry.record_account(&provider_name, &account.label, true, false);
                self.breaker.record_success(&provider_name, &model);

                let tokens = tokens.unwrap_or(0);
                let usage = Usage {
                    prompt_tokens: tokens,
                    completion_tokens: 0,
                    total_tokens: tokens,
                };
                let cost_usd = self
                    .registry
                    .model_cost(&provider_name, &model)
                    .map(|c| c.input_per_1m * tokens as f64 / 1_000_000.0)
                    .unwrap_or(0.0);
                tracking::usage::record_usage(
                    ctx,
                    requested_model,
                    &provider_name,
                    &model,
                    &account.label,
                    &usage,
                    cost_usd,
                    latency_ms,
                );

                return Ok((vector, tokens, provider_name, model));
            }
        }

        Err(last_error.unwrap_or(RouterError::AllProvidersFailed))
    }

    /// Read an upstream SSE response, convert each event to OpenAI chunk
    /// format and push bytes to the client channel. Records usage at the end.
    #[allow(clippy::too_many_arguments)]
    async fn pipe_stream(
        response: reqwest::Response,
        wire: Wire,
        provider_name: String,
        served_model: String,
        requested_model: String,
        account_label: String,
        ctx: KeyContext,
        cost_cfg: Option<CostConfig>,
        started: Instant,
        tx: Sender<Bytes>,
    ) {
        let mut converter = StreamConverter::new(served_model.clone());
        let mut buffer = String::new();
        let mut stream = response.bytes_stream();
        'outer: loop {
            tokio::select! {
                item = stream.next() => {
                    match item {
                        Some(Ok(bytes)) => {
                            buffer.push_str(&String::from_utf8_lossy(&bytes));
                            while let Some(idx) = buffer.find('\n') {
                                let raw: String = buffer.drain(..=idx).collect();
                                let line = raw.trim_end_matches(['\r', '\n']);
                                let Some(data) = line.strip_prefix("data:") else { continue };
                                for event in converter.process(wire, data) {
                                    if tx.send(Bytes::from(event)).await.is_err() {
                                        break 'outer; // client disconnected
                                    }
                                }
                            }
                        }
                        Some(Err(e)) => {
                            tracing::warn!(provider = %provider_name, "Stream error from provider: {e}");
                            break 'outer;
                        }
                        None => break 'outer,
                    }
                }
                _ = tx.closed() => {
                    break 'outer; // client gone; drain remaining work implicitly
                }
            }
        }

        // Flush any trailing buffered line without newline
        let rest = buffer.trim();
        if let Some(data) = rest.strip_prefix("data:") {
            for event in converter.process(wire, data) {
                let _ = tx.send(Bytes::from(event)).await;
            }
        }

        if converter.needs_done() {
            let _ = tx.send(Bytes::from("data: [DONE]\n\n")).await;
        }

        // Record usage/cost for the completed stream when the provider exposed tokens
        let usage = &converter.usage;
        if usage.total_tokens > 0 {
            let cost_usd = cost_cfg
                .map(|c| {
                    c.input_per_1m * usage.prompt_tokens as f64 / 1_000_000.0
                        + c.output_per_1m * usage.completion_tokens as f64 / 1_000_000.0
                })
                .unwrap_or(0.0);
            tracking::usage::record_usage(
                &ctx,
                &requested_model,
                &provider_name,
                &served_model,
                &account_label,
                usage,
                cost_usd,
                started.elapsed().as_millis(),
            );
        }
    }
}

fn result_start_millis(attempt_start: Instant) -> u128 {
    attempt_start.elapsed().as_millis()
}
