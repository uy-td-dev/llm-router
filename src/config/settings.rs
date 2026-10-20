use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Settings {
    pub server: ServerConfig,
    pub providers: Vec<ProviderConfig>,
    pub routing: RoutingConfig,
    #[serde(default)]
    pub security: SecurityConfig,
    /// Client-facing virtual API keys with per-key permissions.
    #[serde(default)]
    pub keys: Vec<KeyConfig>,
    /// Exact-match response cache for non-streaming requests.
    #[serde(default)]
    pub cache: CacheConfig,
    /// Durable persistence (usage records + runtime keys).
    #[serde(default)]
    pub database: DatabaseConfig,
    /// Embedding-similarity response cache for non-streaming requests.
    #[serde(default)]
    pub semantic_cache: SemanticCacheConfig,
}

/// Semantic (embedding cosine) cache selection.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SemanticCacheConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Minimum cosine similarity (0..1] to serve a cached response.
    #[serde(default = "default_similarity_threshold")]
    pub similarity_threshold: f32,
    /// Embedding model used to vectorize conversations (must be configured
    /// with `kind: embedding`).
    #[serde(default = "default_semantic_embedding_model")]
    pub embedding_model: String,
    #[serde(default = "default_semantic_ttl")]
    pub ttl_seconds: u64,
    #[serde(default = "default_semantic_max")]
    pub max_entries: usize,
}

impl Default for SemanticCacheConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            similarity_threshold: default_similarity_threshold(),
            embedding_model: default_semantic_embedding_model(),
            ttl_seconds: default_semantic_ttl(),
            max_entries: default_semantic_max(),
        }
    }
}

fn default_similarity_threshold() -> f32 {
    0.92
}

fn default_semantic_embedding_model() -> String {
    "text-embedding-3-small".to_string()
}

fn default_semantic_ttl() -> u64 {
    300
}

fn default_semantic_max() -> usize {
    100
}

/// Persistence selection.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DatabaseConfig {
    /// "none" (default, in-memory) | "sqlite" | "postgres"
    #[serde(default = "default_db_mode")]
    pub mode: String,
    #[serde(default)]
    pub sqlite: SqliteConfig,
    #[serde(default)]
    pub postgres: PostgresConfig,
}

impl Default for DatabaseConfig {
    fn default() -> Self {
        Self {
            mode: default_db_mode(),
            sqlite: SqliteConfig::default(),
            postgres: PostgresConfig::default(),
        }
    }
}

fn default_db_mode() -> String {
    "none".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SqliteConfig {
    #[serde(default = "default_sqlite_path")]
    pub path: String,
}

impl Default for SqliteConfig {
    fn default() -> Self {
        Self {
            path: default_sqlite_path(),
        }
    }
}

fn default_sqlite_path() -> String {
    "data/llm_router.db".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PostgresConfig {
    #[serde(default)]
    pub url: String,
}

impl Default for PostgresConfig {
    fn default() -> Self {
        Self { url: String::new() }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProviderConfig {
    pub name: String,
    pub enabled: bool,
    /// Wire format: "openai" | "anthropic" | "google". Omitted = derived
    /// from the name (anthropic/google), otherwise OpenAI-compatible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    /// Extra static headers sent upstream (e.g. Copilot editor headers).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub headers: HashMap<String, String>,
    /// Legacy single-account key. Ignored when `accounts` is non-empty.
    pub api_key: String,
    pub base_url: String,
    pub models: Vec<ModelConfig>,
    /// Multiple upstream accounts for the same provider (quota pooling).
    #[serde(default)]
    pub accounts: Vec<ProviderAccountConfig>,
    pub timeout_ms: u64,
    pub max_retries: u32,
}

impl ProviderConfig {
    pub fn wire_format(&self) -> &str {
        match self.format.as_deref() {
            Some(f) => f,
            None => match self.name.as_str() {
                "anthropic" => "anthropic",
                "google" => "google",
                _ => "openai",
            },
        }
    }
}

/// One upstream credential for a provider.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProviderAccountConfig {
    pub label: String,
    pub api_key: String,
    /// Higher priority accounts are preferred in rotation.
    #[serde(default = "default_priority")]
    pub priority: i32,
    #[serde(default = "default_weight")]
    pub weight: u32,
}

fn default_priority() -> i32 {
    10
}

fn default_weight() -> u32 {
    1
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModelConfig {
    pub name: String,
    pub cost: CostConfig,
    /// "embedding" marks the model as routable via POST /v1/embeddings;
    /// omitted (or anything else) = chat model.
    #[serde(default)]
    pub kind: Option<String>,
}

impl ModelConfig {
    pub fn is_embedding(&self) -> bool {
        self.kind.as_deref() == Some("embedding")
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CostConfig {
    pub input_per_1m: f64,
    pub output_per_1m: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RoutingConfig {
    pub default_strategy: String,
    pub fallback_chain: Vec<FallbackEntry>,
    pub retry: RetryConfig,
    /// Model aliases and transparent cross-provider fallbacks.
    /// Key = requested model id or alias, value = ordered "provider/model" list.
    /// When the primary target is rate limited, requests transparently
    /// continue with the next entry while the client keeps its model id.
    #[serde(default)]
    pub aliases: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FallbackEntry {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RetryConfig {
    pub max_attempts: u32,
    pub initial_backoff_ms: u64,
    pub max_backoff_ms: u64,
    pub backoff_multiplier: f64,
}

/// Security configuration for the proxy surface itself.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SecurityConfig {
    #[serde(default = "default_requests_per_minute")]
    pub requests_per_minute: usize,
    /// Legacy global allow-list (applies when `keys` is empty).
    #[serde(default)]
    pub api_keys: Vec<String>,
    /// Master key for /admin/* endpoints (X-Admin-Key header or Bearer).
    #[serde(default)]
    pub admin_key: Option<String>,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            requests_per_minute: default_requests_per_minute(),
            api_keys: Vec::new(),
            admin_key: None,
        }
    }
}

fn default_requests_per_minute() -> usize {
    60
}

/// A client-facing virtual API key with scoped permissions.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct KeyConfig {
    /// The token presented by clients as `Authorization: Bearer <key>`.
    pub key: String,
    /// Owner / account name used in usage reports.
    #[serde(default = "default_owner")]
    pub owner: String,
    /// Glob patterns (e.g. "gpt-*", "gemini-*", "premium", "*").
    #[serde(default = "default_all_models")]
    pub allowed_models: Vec<String>,
    /// Restrict which providers this key may use (glob names). None = all.
    pub allowed_providers: Option<Vec<String>>,
    /// Per-key rate limit override (requests/minute).
    pub rpm: Option<usize>,
    /// Maximum USD spend (tracked since process start) before the key is
    /// rejected with 402.
    pub monthly_budget_usd: Option<f64>,
    /// Team this key belongs to. A team key may only route through that
    /// team's connections (`team` field on the connection). None = a global
    /// key (admin-created) that is not restricted to a single team.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
}

fn default_owner() -> String {
    "default".to_string()
}

fn default_all_models() -> Vec<String> {
    vec!["*".to_string()]
}

/// Exact-match response cache configuration.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CacheConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_cache_ttl")]
    pub ttl_seconds: u64,
    #[serde(default = "default_cache_max")]
    pub max_entries: usize,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            ttl_seconds: default_cache_ttl(),
            max_entries: default_cache_max(),
        }
    }
}

fn default_cache_ttl() -> u64 {
    300
}

fn default_cache_max() -> usize {
    1000
}

impl Settings {
    pub fn load() -> Result<Self, config::ConfigError> {
        let mut builder = config::Config::builder()
            .add_source(config::File::with_name("config/default"));

        // Allow environment variable overrides
        builder = builder.add_source(
            config::Environment::with_prefix("LLM_ROUTER")
                .separator("__"),
        );

        let config = builder.build()?;

        let mut settings: Settings = config.try_deserialize()?;

        // Substitute environment variables in upstream keys
        for provider in &mut settings.providers {
            provider.api_key = substitute_env_var(&provider.api_key);
            for account in &mut provider.accounts {
                account.api_key = substitute_env_var(&account.api_key);
            }
        }

        Ok(settings)
    }
}

fn substitute_env_var(value: &str) -> String {
    if value.starts_with("${") && value.ends_with("}") {
        let var_name = &value[2..value.len() - 1];
        std::env::var(var_name).unwrap_or_else(|_| String::new())
    } else {
        value.to_string()
    }
}
