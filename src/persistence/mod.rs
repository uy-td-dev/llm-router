//! Pluggable persistence: usage records + virtual keys.
//!
//! Selected by `database.mode`: `none` (in-memory only), `sqlite`
//! (default file DB), or `postgres` (requires the `full` cargo feature).
//! A global store instance is installed at startup; callers behind the
//! `store` module can treat it as always available.

pub mod sqlite;
#[cfg(feature = "full")]
pub mod postgres;

use std::sync::Arc;

use serde::Serialize;

use crate::config::KeyConfig;
use crate::tracking::usage::UsageRecord;

#[derive(Debug, Serialize)]
pub struct PersistenceStatus {
    pub mode: String,
    pub usage_records: u64,
    pub keys: u64,
}

/// History/analytics filter for persisted usage records.
#[derive(Debug, Clone, Default)]
pub struct UsageQuery {
    /// RFC3339 lower bound for the `ts` column.
    pub since_rfc3339: String,
    /// Exact api_key label filter (None = all).
    pub api_key: Option<String>,
    /// Exact owner filter (None = all).
    pub owner: Option<String>,
    /// Restrict to keys of one team (None = all). Backends that persist the
    /// key table resolve it with a sub-query; backends that cannot return an
    /// error rather than silently widening the scope.
    pub team: Option<String>,
    /// None = raw records; Some("day"|"key"|"provider"|"model")
    pub group: Option<String>,
    pub limit: u64,
}

#[async_trait::async_trait]
pub trait Persistence: Send + Sync {
    fn mode(&self) -> &'static str;

    async fn save_usage(&self, record: &UsageRecord) -> Result<(), String>;
    async fn count_usage(&self) -> Result<u64, String>;

    async fn load_keys(&self) -> Result<Vec<KeyConfig>, String>;
    async fn upsert_key(&self, cfg: &KeyConfig) -> Result<(), String>;
    async fn delete_key(&self, key: &str) -> Result<(), String>;
    async fn count_keys(&self) -> Result<u64, String>;

    /// Raw records or grouped aggregates; float/int columns are serialized
    /// into JSON objects per group bucket.
    async fn query_usage(&self, query: &UsageQuery) -> Result<Vec<serde_json::Value>, String>;

    /// Total USD cost over one api_key label (None = all keys) since an
    /// RFC3339 instant — the durable half of monthly budget enforcement.
    async fn sum_cost_since(
        &self,
        api_key: Option<&str>,
        since_rfc3339: &str,
    ) -> Result<f64, String>;
}

// ---------------------------------------------------------------------------
// Global store (always set at startup; NoopPersistence for mode "none")
// ---------------------------------------------------------------------------

static STORE: once_cell::sync::Lazy<std::sync::RwLock<Arc<dyn Persistence>>> =
    once_cell::sync::Lazy::new(|| std::sync::RwLock::new(Arc::new(NoopPersistence)));

pub fn install(persistence: Arc<dyn Persistence>) {
    *STORE.write().unwrap_or_else(|p| p.into_inner()) = persistence;
}

fn current() -> Arc<dyn Persistence> {
    STORE.read().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Fire-and-forget usage persistence (must be called within a tokio runtime).
pub fn persist_usage(record: UsageRecord) {
    let store = current();
    tokio::spawn(async move {
        if let Err(e) = store.save_usage(&record).await {
            tracing::warn!(mode = store.mode(), "usage persistence failed: {e}");
        }
    });
}

/// Load virtual keys that were added/changed at runtime in a previous run.
pub async fn load_runtime_keys() -> Vec<KeyConfig> {
    let store = current();
    match store.load_keys().await {
        Ok(keys) => keys,
        Err(e) => {
            tracing::warn!(mode = store.mode(), "could not load persisted keys: {e}");
            vec![]
        }
    }
}

pub async fn persist_key(cfg: &KeyConfig) {
    let store = current();
    if store.mode() == "none" {
        return;
    }
    if let Err(e) = store.upsert_key(cfg).await {
        tracing::warn!(mode = store.mode(), "key persistence failed: {e}");
    }
}

pub async fn remove_key(key: &str) {
    let store = current();
    if store.mode() == "none" {
        return;
    }
    if let Err(e) = store.delete_key(key).await {
        tracing::warn!(mode = store.mode(), "key removal persistence failed: {e}");
    }
}

/// Raw/aggregate history from the active persistence backend.
pub async fn query_usage(query: UsageQuery) -> Result<Vec<serde_json::Value>, String> {
    current().query_usage(&query).await
}

/// Durable USD spend for one api_key since an instant; `None` when no DB is
/// active (mode none) or the query fails (caller falls back to in-memory).
pub async fn sum_key_cost_since(api_key: &str, since_rfc3339: &str) -> Option<f64> {
    let store = current();
    if store.mode() == "none" {
        return None;
    }
    match store.sum_cost_since(Some(api_key), since_rfc3339).await {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!(mode = store.mode(), "sum_cost_since failed: {e}");
            None
        }
    }
}

pub async fn status() -> PersistenceStatus {
    let store = current();
    let usage_records = store.count_usage().await.unwrap_or(0);
    let keys = store.count_keys().await.unwrap_or(0);
    PersistenceStatus {
        mode: store.mode().to_string(),
        usage_records,
        keys,
    }
}

// ---------------------------------------------------------------------------
// No-op fallback (mode: none)
// ---------------------------------------------------------------------------

pub struct NoopPersistence;

#[async_trait::async_trait]
impl Persistence for NoopPersistence {
    fn mode(&self) -> &'static str {
        "none"
    }

    async fn save_usage(&self, _: &UsageRecord) -> Result<(), String> {
        Ok(())
    }
    async fn count_usage(&self) -> Result<u64, String> {
        Ok(0)
    }
    async fn load_keys(&self) -> Result<Vec<KeyConfig>, String> {
        Ok(vec![])
    }
    async fn upsert_key(&self, _: &KeyConfig) -> Result<(), String> {
        Ok(())
    }
    async fn delete_key(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn count_keys(&self) -> Result<u64, String> {
        Ok(0)
    }

    async fn query_usage(&self, _: &UsageQuery) -> Result<Vec<serde_json::Value>, String> {
        Err("persistence disabled (database.mode: none)".to_string())
    }

    async fn sum_cost_since(&self, _: Option<&str>, _: &str) -> Result<f64, String> {
        Ok(0.0)
    }
}
