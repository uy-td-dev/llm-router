use std::collections::HashMap;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use serde::Serialize;

use crate::api::models::{KeyContext, Usage};

#[derive(Debug, Clone, Serialize)]
pub struct UsageRecord {
    pub timestamp: DateTime<Utc>,
    /// Client-facing virtual key label (or "anonymous")
    pub api_key: String,
    pub owner: String,
    /// Team of the key at request time (None for global/anonymous keys)
    #[serde(default)]
    pub team: Option<String>,
    pub requested_model: String,
    pub provider: String,
    pub model: String,
    /// Upstream account label used for this call
    pub upstream_account: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    pub cost_usd: f64,
    pub latency_ms: u128,
}

#[derive(Debug, Default, Clone)]
struct Aggregates {
    requests: u64,
    prompt_tokens: u64,
    completion_tokens: u64,
    cost_usd: f64,
}

#[derive(Debug, Default)]
struct Inner {
    total_requests: u64,
    prompt_tokens: u64,
    completion_tokens: u64,
    cost_usd: f64,
    /// Requests served from the response cache
    cache_hits: u64,
    /// Requests served by semantic (embedding similarity) cache
    semantic_cache_hits: u64,
    /// keyed by (provider, model)
    by_provider_model: HashMap<(String, String), Aggregates>,
    /// keyed by (api_key label, owner)
    by_key: HashMap<(String, String), Aggregates>,
    /// keyed by (api_key label, calendar month "YYYY-MM") — monthly budget
    /// checks with no persistence backend fall back to this window
    by_key_month: HashMap<(String, String), Aggregates>,
}

pub struct UsageTracker {
    inner: Mutex<Inner>,
    started_at: DateTime<Utc>,
}

pub static TRACKER: Lazy<UsageTracker> = Lazy::new(|| UsageTracker {
    inner: Mutex::new(Inner::default()),
    started_at: Utc::now(),
});

impl UsageTracker {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn record(&self, record: UsageRecord) {
        let mut inner = self.lock();
        inner.total_requests += 1;
        inner.prompt_tokens += record.prompt_tokens as u64;
        inner.completion_tokens += record.completion_tokens as u64;
        inner.cost_usd += record.cost_usd;

        let pm = inner
            .by_provider_model
            .entry((record.provider.clone(), record.model.clone()))
            .or_default();
        pm.requests += 1;
        pm.prompt_tokens += record.prompt_tokens as u64;
        pm.completion_tokens += record.completion_tokens as u64;
        pm.cost_usd += record.cost_usd;

        let key = inner
            .by_key
            .entry((record.api_key.clone(), record.owner.clone()))
            .or_default();
        key.requests += 1;
        key.prompt_tokens += record.prompt_tokens as u64;
        key.completion_tokens += record.completion_tokens as u64;
        key.cost_usd += record.cost_usd;

        let month = record.timestamp.format("%Y-%m").to_string();
        let mk = inner
            .by_key_month
            .entry((record.api_key.clone(), month))
            .or_default();
        mk.requests += 1;
        mk.prompt_tokens += record.prompt_tokens as u64;
        mk.completion_tokens += record.completion_tokens as u64;
        mk.cost_usd += record.cost_usd;

        // Fire-and-forget durable persistence (noop in "none" mode)
        crate::persistence::persist_usage(record);
    }

    fn stats(&self) -> StatsResponse {
        let inner = self.lock();

        let mut breakdown: Vec<ProviderBreakdown> = inner
            .by_provider_model
            .iter()
            .map(|((provider, model), agg)| ProviderBreakdown {
                provider: provider.clone(),
                model: model.clone(),
                requests: agg.requests,
                prompt_tokens: agg.prompt_tokens,
                completion_tokens: agg.completion_tokens,
                cost_usd: agg.cost_usd,
            })
            .collect();
        breakdown.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap());

        let mut by_api_key: Vec<KeyBreakdown> = inner
            .by_key
            .iter()
            .map(|((api_key, owner), agg)| KeyBreakdown {
                api_key: api_key.clone(),
                owner: owner.clone(),
                requests: agg.requests,
                prompt_tokens: agg.prompt_tokens,
                completion_tokens: agg.completion_tokens,
                cost_usd: agg.cost_usd,
            })
            .collect();
        by_api_key.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap());

        StatsResponse {
            uptime_seconds: (Utc::now() - self.started_at).num_seconds().max(0) as u64,
            total_requests: inner.total_requests,
            total_prompt_tokens: inner.prompt_tokens,
            total_completion_tokens: inner.completion_tokens,
            total_cost_usd: inner.cost_usd,
            cache_hits: inner.cache_hits,
            semantic_cache_hits: inner.semantic_cache_hits,
            breakdown,
            by_api_key,
        }
    }
}

// Public API backed by the global tracker
pub fn record(record: UsageRecord) {
    crate::hub::on_usage(&record);
    TRACKER.record(record);
}

/// Count a cache hit (served without touching upstream).
pub fn record_cache_hit() {
    TRACKER.lock().cache_hits += 1;
}

/// Count a semantic cache hit (served by similarity without upstream).
pub fn record_semantic_cache_hit() {
    TRACKER.lock().semantic_cache_hits += 1;
}

/// Cumulative USD spend for one api_key label (all owners).
pub fn key_cost(label: &str) -> f64 {
    let inner = TRACKER.lock();
    inner
        .by_key
        .iter()
        .filter(|((k, _), _)| k == label)
        .map(|(_, agg)| agg.cost_usd)
        .sum()
}

/// USD spend for one api_key label in one calendar month ("YYYY-MM", UTC).
/// In-memory fallback for budget checks without a persistence backend.
pub fn key_month_cost(label: &str, month: &str) -> f64 {
    let inner = TRACKER.lock();
    inner
        .by_key_month
        .iter()
        .filter(|((k, m), _)| k == label && m == month)
        .map(|(_, agg)| agg.cost_usd)
        .sum()
}

/// Convenience: record a completed request from its parts.
pub fn record_usage(
    ctx: &KeyContext,
    requested_model: &str,
    provider: &str,
    model: &str,
    upstream_account: &str,
    usage: &Usage,
    cost_usd: f64,
    latency_ms: u128,
) {
    record(UsageRecord {
        timestamp: Utc::now(),
        api_key: ctx.label.clone(),
        owner: ctx.owner.clone(),
        team: ctx.team.clone(),
        requested_model: requested_model.to_string(),
        provider: provider.to_string(),
        model: model.to_string(),
        upstream_account: upstream_account.to_string(),
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        cost_usd,
        latency_ms,
    });
}

pub fn stats() -> StatsResponse {
    TRACKER.stats()
}

#[derive(Debug, Serialize)]
pub struct ProviderBreakdown {
    pub provider: String,
    pub model: String,
    pub requests: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cost_usd: f64,
}

#[derive(Debug, Serialize)]
pub struct KeyBreakdown {
    pub api_key: String,
    pub owner: String,
    pub requests: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cost_usd: f64,
}

#[derive(Debug, Serialize)]
pub struct StatsResponse {
    pub uptime_seconds: u64,
    pub total_requests: u64,
    pub total_prompt_tokens: u64,
    pub total_completion_tokens: u64,
    pub total_cost_usd: f64,
    /// Requests served directly from the response cache
    pub cache_hits: u64,
    /// Requests served by semantic (embedding similarity) cache
    pub semantic_cache_hits: u64,
    pub breakdown: Vec<ProviderBreakdown>,
    pub by_api_key: Vec<KeyBreakdown>,
}
