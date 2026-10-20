pub mod strategy;

use std::sync::Arc;

use tokio_stream::wrappers::ReceiverStream;
use bytes::Bytes;

use crate::api::models::{
    ChatCompletionRequest, ChatCompletionResponse, EmbeddingInput, EmbeddingObject,
    EmbeddingRequest, EmbeddingsListResponse, EmbeddingUsage, KeyContext,
};
use crate::config::Settings;
use crate::execution::circuit_breaker::CircuitBreaker;
use crate::execution::fallback::{Candidate, FallbackExecutor};
use crate::execution::retry::RetryPolicy;
use crate::providers::ProviderRegistry;
use crate::providers::vault::AccountStatus;
use crate::router::strategy::{CheapestFirstStrategy, LatencyFirstStrategy, RoutingStrategy};
use crate::{tracking, utils::{Result, RouterError}};
use chrono::{Datelike, Timelike, Utc};

pub struct Router {
    registry: Arc<ProviderRegistry>,
    executor: Arc<FallbackExecutor>,
    strategy: Box<dyn RoutingStrategy>,
    settings: Settings,
}

impl Router {
    pub fn new(registry: Arc<ProviderRegistry>, settings: Settings, client: reqwest::Client) -> Self {
        let retry = RetryPolicy::from_config(&settings.routing.retry);
        let stream_client = reqwest::Client::new(); // no timeout: streams can be long-lived
        let executor = Arc::new(FallbackExecutor {
            registry: registry.clone(),
            retry,
            breaker: Arc::new(CircuitBreaker::default()),
            http_client: client,
            stream_client,
        });

        let strategy: Box<dyn RoutingStrategy> = match settings.routing.default_strategy.as_str() {
            "latency_first" => {
                tracing::info!("Routing strategy: latency_first (exploration until all providers measured)");
                Box::new(LatencyFirstStrategy)
            }
            _ => Box::new(CheapestFirstStrategy),
        };

        Self {
            registry,
            executor,
            strategy,
            settings,
        }
    }

    /// Build candidate list for a request:
    /// 1. Primary selection according to routing strategy (cheapest supporting provider)
    /// 2. Explicit fallback_chain from config
    /// 3. Alias expansion — same-model ids matching other providers (cross-provider
    ///    fallback when rate limited) and alias names like "premium"/"fast"
    /// 4. Any other providers supporting the model, cheapest first
    ///
    /// All candidates are filtered by the caller's key permissions.
    pub fn build_candidates(&self, requested_model: &str, ctx: &KeyContext) -> Vec<Candidate> {
        let mut candidates: Vec<Candidate> = Vec::new();
        let mut seen = std::collections::HashSet::new();

        let available = self.registry.list_providers();

        // 0a. Combo: named ordered fallback chain
        if let Some(combo) = crate::connections::combo(requested_model) {
            for entry in &combo.models {
                if let Some(c) = self.pinned(entry, &available, ctx) {
                    if seen.insert(format!("{}/{}", c.provider, c.model)) {
                        candidates.push(c);
                    }
                }
            }
            return candidates;
        }

        // 0b. Explicit "provider/model" or "prefix/model" pins one provider
        if let Some(c) = self.pinned(requested_model, &available, ctx) {
            return vec![c];
        }

        // Providers supporting the requested model, restricted by key permissions
        let supporting: Vec<_> = available
            .iter()
            .filter(|p| {
                (p.model == requested_model
                    || p.model.ends_with(&format!("-{requested_model}")))
                    && ctx.provider_allowed(&p.provider)
            })
            .cloned()
            .collect();

        fn push_candidate(
            candidates: &mut Vec<Candidate>,
            seen: &mut std::collections::HashSet<String>,
            provider: String,
            model: String,
        ) {
            if seen.insert(format!("{provider}/{model}")) {
                candidates.push(Candidate { provider, model });
            }
        }

        // 1. Strategy-selected cheapest healthy provider that supports the model
        if let Some(best) = self.strategy.select(&supporting) {
            push_candidate(&mut candidates, &mut seen, best.provider.clone(), best.model.clone());
        }

        // 2. Explicit fallback chain from config (matching + allowed)
        for entry in &self.settings.routing.fallback_chain {
            if entry.model == requested_model && ctx.provider_allowed(&entry.provider) {
                push_candidate(
                    &mut candidates,
                    &mut seen,
                    entry.provider.clone(),
                    entry.model.clone(),
                );
            }
        }

        // 3. Alias expansion (cross-provider fallback + named aliases)
        if let Some(entries) = self.settings.routing.aliases.get(requested_model) {
            for entry in entries {
                let Some((provider, model)) = entry.split_once('/') else {
                    tracing::warn!("Malformed alias entry: {}", entry);
                    continue;
                };
                if ctx.provider_allowed(provider) {
                    push_candidate(
                        &mut candidates,
                        &mut seen,
                        provider.to_string(),
                        model.to_string(),
                    );
                }
            }
        }

        // 4. Remaining providers supporting the model, cheapest first
        let mut remaining: Vec<Candidate> = supporting
            .iter()
            .map(|p| Candidate {
                provider: p.provider.clone(),
                model: p.model.clone(),
            })
            .filter(|c| !seen.contains(&format!("{}/{}", c.provider, c.model)))
            .collect();

        remaining.sort_by_key(|c| {
            supporting
                .iter()
                .find(|p| p.provider == c.provider)
                .map(|p| (p.cost.input_per_1m + p.cost.output_per_1m) as u64)
                .unwrap_or(u64::MAX)
        });

        remaining.into_iter().for_each(|c| {
            push_candidate(&mut candidates, &mut seen, c.provider, c.model)
        });

        candidates
    }

    /// Resolve `provider/model` or `prefix/model` to one allowed candidate.
    fn pinned(
        &self,
        requested: &str,
        available: &[crate::providers::traits::ProviderInfo],
        ctx: &KeyContext,
    ) -> Option<Candidate> {
        let (prefix, rest) = requested.split_once('/')?;
        let provider = if available.iter().any(|p| p.provider == prefix) {
            prefix.to_string()
        } else {
            crate::connections::resolve_prefix(prefix)?
        };
        (ctx.provider_allowed(&provider)
            && available.iter().any(|p| p.provider == provider && p.model == rest))
        .then(|| Candidate {
            provider,
            model: rest.to_string(),
        })
    }

    /// USD amount already spent this calendar month (UTC) for a key label.
    /// Durable sum over `usage_records` when a persistence backend is active
    /// (so budgets survive restarts and roll over every month); in-memory
    /// month aggregates otherwise.
    async fn key_spent(&self, label: &str) -> f64 {
        let now = Utc::now();
        let month_start = now
            .with_day(1)
            .and_then(|d| d.with_hour(0))
            .and_then(|d| d.with_minute(0))
            .and_then(|d| d.with_second(0))
            .and_then(|d| d.with_nanosecond(0))
            .unwrap_or(now);
        let since = month_start.to_rfc3339();
        if let Some(spent) = crate::persistence::sum_key_cost_since(label, &since).await {
            return spent;
        }
        tracking::usage::key_month_cost(label, &now.format("%Y-%m").to_string())
    }

    /// Budget gate shared by every routing path.
    async fn check_budget(&self, ctx: &KeyContext) -> Result<()> {
        if let Some(budget) = ctx.monthly_budget_usd {
            let spent = self.key_spent(&ctx.label).await;
            if spent >= budget {
                return Err(RouterError::Budget(format!(
                    "API key '{}' spent ${:.4}, monthly budget ${:.4}",
                    ctx.label, spent, budget
                )));
            }
        }
        Ok(())
    }

    /// Hub pre-processing: skills → vision adapter → token saver.
    async fn prepare(&self, req: &ChatCompletionRequest, ctx: &KeyContext) -> Result<ChatCompletionRequest> {
        let mut req = req.clone();
        let skills = crate::hub::apply_skills(&mut req);
        if !skills.is_empty() {
            tracing::info!(model = %req.model, skills = ?skills, "Skills injected");
        }

        let hub_cfg = crate::hub::config();
        if crate::hub::has_images(&req) && crate::hub::needs_vision_adapter(&hub_cfg.vision, &req.model) {
            self.describe_images(&mut req, &hub_cfg.vision, ctx).await?;
        }

        let saved = crate::hub::save_tokens(&hub_cfg.token_saver, &mut req);
        if saved > 0 {
            tracing::info!(model = %req.model, saved_tokens = saved, "Token saver compacted request");
        }
        Ok(req)
    }

    /// Replace image parts with text descriptions from the vision model.
    async fn describe_images(
        &self,
        req: &mut ChatCompletionRequest,
        cfg: &crate::hub::VisionAdapter,
        ctx: &KeyContext,
    ) -> Result<()> {
        let candidates = self.build_candidates(cfg.vision_model.trim(), ctx);
        if candidates.is_empty() {
            return Err(RouterError::Provider(format!(
                "Vision adapter: model '{}' không khả dụng",
                cfg.vision_model
            )));
        }
        for msg in req.messages.iter_mut() {
            let images = msg.content.images();
            if images.is_empty() {
                continue;
            }
            let mut parts = vec![serde_json::json!({"type": "text", "text": cfg.prompt})];
            for url in &images {
                parts.push(serde_json::json!({"type": "image_url", "image_url": {"url": url}}));
            }
            let vreq: ChatCompletionRequest = serde_json::from_value(serde_json::json!({
                "model": cfg.vision_model.trim(),
                "messages": [{"role": "user", "content": parts}],
                "max_tokens": 1024,
            }))
            .map_err(|e| RouterError::Internal(e.to_string()))?;
            let (resp, provider, model) = self.executor.execute(&candidates, &vreq, ctx).await?;
            let description = resp.choices.first().map(|c| c.message.content.text()).unwrap_or_default();
            crate::hub::count_vision();
            tracing::info!(
                images = images.len(),
                served_by = %format!("{provider}/{model}"),
                "Vision adapter described images"
            );
            let text = msg.content.text();
            msg.content = crate::api::models::MessageContent::Text(format!(
                "{text}\n\n[Mô tả ảnh (vision adapter)]\n{description}"
            ));
        }
        Ok(())
    }

    pub async fn route(
        &self,
        req: &ChatCompletionRequest,
        ctx: &KeyContext,
    ) -> Result<(ChatCompletionResponse, String, String)> {
        let result = self.route_inner(req, ctx).await;
        if let Err(e) = &result {
            crate::hub::log_error(ctx, &req.model, &e.to_string());
        }
        result
    }

    pub async fn route_stream(
        &self,
        req: &ChatCompletionRequest,
        ctx: &KeyContext,
    ) -> Result<(ReceiverStream<Bytes>, String, String)> {
        let result = self.route_stream_inner(req, ctx).await;
        if let Err(e) = &result {
            crate::hub::log_error(ctx, &req.model, &e.to_string());
        }
        result
    }

    async fn route_inner(
        &self,
        req: &ChatCompletionRequest,
        ctx: &KeyContext,
    ) -> Result<(ChatCompletionResponse, String, String)> {
        if !ctx.model_allowed(&req.model) {
            return Err(RouterError::Forbidden(format!(
                "API key '{}' is not allowed to use model '{}'",
                ctx.label, req.model
            )));
        }

        // Budget enforcement: reject before spending more upstream credits.
        self.check_budget(ctx).await?;

        let candidates = self.build_candidates(&req.model, ctx);

        if candidates.is_empty() {
            return Err(RouterError::Provider(format!(
                "No provider supports model '{}' (or fallback failed)",
                req.model
            )));
        }

        tracing::info!(
            owner = %ctx.owner,
            key = %ctx.label,
            model = %req.model,
            candidates = ?candidates.iter().map(|c| format!("{}/{}", c.provider, c.model)).collect::<Vec<_>>(),
            "Routing candidates"
        );

        let req = self.prepare(req, ctx).await?;
        self.executor.execute(&candidates, &req, ctx).await
    }

    /// Streaming variant: returns a normalized OpenAI SSE byte stream.
    async fn route_stream_inner(
        &self,
        req: &ChatCompletionRequest,
        ctx: &KeyContext,
    ) -> Result<(ReceiverStream<Bytes>, String, String)> {
        if !ctx.model_allowed(&req.model) {
            return Err(RouterError::Forbidden(format!(
                "API key '{}' is not allowed to use model '{}'",
                ctx.label, req.model
            )));
        }

        // Streaming spends the same credits: gate it too.
        self.check_budget(ctx).await?;

        let candidates = self.build_candidates(&req.model, ctx);

        if candidates.is_empty() {
            return Err(RouterError::Provider(format!(
                "No provider supports model '{}' (or fallback failed)",
                req.model
            )));
        }

        tracing::info!(
            owner = %ctx.owner,
            key = %ctx.label,
            model = %req.model,
            candidates = ?candidates.iter().map(|c| format!("{}/{}", c.provider, c.model)).collect::<Vec<_>>(),
            "Routing streaming candidates"
        );

        let req = self.prepare(req, ctx).await?;
        self.executor.execute_stream(&candidates, &req, ctx).await
    }

    /// Embeddings routing: only providers exposing an embeddings API are
    /// eligible; each input element goes through the full account-rotation
    /// fallback. Cost is charged per input token.
    pub async fn embeddings(
        &self,
        req: &EmbeddingRequest,
        ctx: &KeyContext,
    ) -> Result<EmbeddingsListResponse> {
        if !ctx.model_allowed(&req.model) {
            return Err(RouterError::Forbidden(format!(
                "API key '{}' is not allowed to use model '{}'",
                ctx.label, req.model
            )));
        }

        self.check_budget(ctx).await?;

        // Eligible: (provider, model) pairs flagged `kind: embedding` whose
        // provider supports the embeddings API and passes key permissions.
        let supporting: Vec<_> = self
            .registry
            .list_providers()
            .into_iter()
            .filter(|p| p.is_embedding && p.model == req.model && ctx.provider_allowed(&p.provider))
            .collect();

        // Cheapest first (embedding aliases are not supported for now).
        let mut ordered: Vec<Candidate> = supporting
            .iter()
            .map(|p| Candidate {
                provider: p.provider.clone(),
                model: p.model.clone(),
            })
            .collect();
        ordered.sort_by_key(|c| {
            supporting
                .iter()
                .find(|p| p.provider == c.provider)
                .map(|p| (p.cost.input_per_1m + p.cost.output_per_1m) as u64)
                .unwrap_or(u64::MAX)
        });

        if ordered.is_empty() {
            return Err(RouterError::Provider(format!(
                "No provider supports embedding model '{}' (or fallback failed)",
                req.model
            )));
        }

        tracing::info!(
            owner = %ctx.owner,
            key = %ctx.label,
            model = %req.model,
            candidates = ?ordered.iter().map(|c| format!("{}/{}", c.provider, c.model)).collect::<Vec<_>>(),
            "Routing embedding candidates"
        );

        let requested_model = req.model.clone();
        let inputs = req.input.clone().into_vec();
        let mut data = Vec::with_capacity(inputs.len());
        let mut total_tokens: u32 = 0;

        for (idx, input) in inputs.into_iter().enumerate() {
            // Fail the whole request on the first failing element.
            let (vector, tokens, _, _) = self
                .executor
                .execute_embedding(&ordered, &requested_model, &input, ctx, &requested_model)
                .await?;
            total_tokens += tokens;
            data.push(EmbeddingObject {
                object: "embedding".to_string(),
                index: idx,
                embedding: vector,
            });
        }

        Ok(EmbeddingsListResponse {
            object: "list".to_string(),
            data,
            model: req.model.clone(),
            usage: EmbeddingUsage {
                prompt_tokens: total_tokens,
                total_tokens,
            },
        })
    }

    /// Internal: vectorize a text with the configured semantic-cache
    /// embedding model under the system context (bypasses caller
    /// key permissions; usage still tracked + persisted).
    pub async fn embed_text(&self, text: &str) -> Result<Vec<f32>> {
        let model = self.settings.semantic_cache.embedding_model.clone();
        let req = EmbeddingRequest {
            model,
            input: EmbeddingInput::One(text.to_string()),
        };
        let ctx = crate::semantic::SemanticCache::internal_context();
        let resp = self.embeddings(&req, &ctx).await?;
        Ok(resp
            .data
            .into_iter()
            .next()
            .map(|d| d.embedding)
            .unwrap_or_default())
    }

    /// List unique model ids across all enabled providers, filtered by
    /// this key's permissions.
    pub fn list_models(&self, ctx: &KeyContext) -> Vec<String> {
        let mut models: Vec<String> = self
            .registry
            .list_providers()
            .into_iter()
            .filter(|p| ctx.provider_allowed(&p.provider) && !p.is_embedding)
            .flat_map(|p| [p.model.clone(), format!("{}/{}", p.provider, p.model)])
            .filter(|m| ctx.model_allowed(m))
            .collect();
        let providers = self.registry.list_providers();
        for (prefix, provider) in crate::connections::prefixes() {
            if prefix == provider || !ctx.provider_allowed(&provider) {
                continue;
            }
            models.extend(
                providers
                    .iter()
                    .filter(|p| p.provider == provider && !p.is_embedding)
                    .map(|p| format!("{prefix}/{}", p.model))
                    .filter(|m| ctx.model_allowed(m)),
            );
        }
        models.extend(
            crate::connections::combos()
                .into_iter()
                // Only surface a combo when the key can actually route at
                // least one of its entries (team keys drop other teams').
                .filter(|c| {
                    c.models
                        .iter()
                        .any(|entry| self.pinned(entry, &providers, ctx).is_some())
                })
                .map(|c| c.name)
                .filter(|m| ctx.model_allowed(m)),
        );
        models.sort();
        models.dedup();
        models
    }

    /// Upstream account pool statuses (for /admin/accounts).
    pub fn account_statuses(&self) -> Vec<AccountStatus> {
        self.registry.account_statuses()
    }

    /// Current runtime settings (for the config admin API).
    pub fn settings(&self) -> Settings {
        self.settings.clone()
    }

    /// Admin: view one provider's account pool.
    pub fn provider_accounts(&self, provider: &str) -> Result<Vec<AccountStatus>> {
        self.registry.provider_accounts(provider)
    }

    /// Admin: add/replace an upstream account at runtime.
    pub fn add_account(
        &self,
        provider: &str,
        label: &str,
        api_key: &str,
        priority: i32,
        weight: u32,
    ) -> Result<()> {
        self.registry
            .add_account(provider, label, api_key, priority, weight)
    }

    /// Admin: remove an upstream account at runtime.
    pub fn remove_account(&self, provider: &str, label: &str) -> Result<()> {
        self.registry.remove_account(provider, label)
    }

    pub fn registry(&self) -> &ProviderRegistry {
        &self.registry
    }

    /// Probe an unsaved connection definition with one credential.
    pub async fn test_connection(
        &self,
        conn: &crate::connections::Connection,
        api_key: &str,
        model: Option<&str>,
    ) -> Result<serde_json::Value> {
        let cfg = conn.provider_config();
        let provider = crate::providers::registry::build_provider(&cfg).ok_or_else(|| {
            RouterError::InvalidRequest(format!("format '{}' không hỗ trợ", conn.format))
        })?;
        let model = match model.filter(|m| !m.is_empty()) {
            Some(m) => m.to_string(),
            None => conn
                .models
                .first()
                .map(|m| m.name.clone())
                .ok_or_else(|| RouterError::InvalidRequest("connection chưa có model".to_string()))?,
        };
        let (reply, usage, ms) = self
            .executor
            .probe(provider, &model, api_key, "Reply with exactly: pong")
            .await?;
        Ok(serde_json::json!({
            "ok": true, "provider": conn.name, "model": model,
            "reply": reply, "usage": usage, "latency_ms": ms,
        }))
    }

    /// Admin: real upstream probe with either an explicit credential (test
    /// before adding) or an existing pool account's credential (by label).
    /// `model` defaults to the provider's first chat model.
    pub async fn test_account(
        &self,
        provider: &str,
        label: Option<&str>,
        api_key: Option<&str>,
        model: Option<&str>,
    ) -> Result<serde_json::Value> {
        let key = match (api_key.filter(|k| !k.trim().is_empty()), label) {
            (Some(k), _) => k.trim().to_string(),
            (None, Some(l)) => self
                .registry
                .account_key(provider, l)
                .or_else(|| crate::connections::stored_key(provider, Some(l)))
                .ok_or_else(|| {
                RouterError::InvalidRequest(format!("account '{l}' not found on '{provider}'"))
            })?,
            (None, None) => {
                return Err(RouterError::InvalidRequest(
                    "cần api_key hoặc label".to_string(),
                ))
            }
        };
        let model = match model.filter(|m| !m.is_empty()) {
            Some(m) => m.to_string(),
            None => self
                .registry
                .list_providers()
                .into_iter()
                .find(|p| p.provider == provider && !p.is_embedding)
                .map(|p| p.model)
                .ok_or_else(|| {
                    RouterError::InvalidRequest(format!("provider '{provider}' không có chat model"))
                })?,
        };
        let (reply, usage, ms) = self
            .executor
            .test_credential(provider, &model, &key, "Reply with exactly: pong")
            .await?;
        Ok(serde_json::json!({
            "ok": true,
            "provider": provider,
            "model": model,
            "reply": reply,
            "usage": usage,
            "latency_ms": ms,
        }))
    }
}
