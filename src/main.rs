mod api;
mod cache;
mod config;
mod connections;
mod execution;
mod hub;
mod keystore;
mod persistence;
mod providers;
mod rate_limit;
mod router;
mod semantic;
mod tracking;
mod utils;

use std::sync::Arc;

use api::{create_routes, AppState};
use config::Settings;
use providers::ProviderRegistry;
use router::Router;

/// Build the configured persistence backend from settings.
async fn init_persistence(settings: &Settings) -> std::sync::Arc<dyn persistence::Persistence> {
    match settings.database.mode.as_str() {
        "sqlite" => {
            match persistence::sqlite::SqlitePersistence::open(&settings.database.sqlite.path) {
                Ok(p) => {
                    tracing::info!(path = %settings.database.sqlite.path, "SQLite persistence ready");
                    std::sync::Arc::new(p)
                }
                Err(e) => {
                    tracing::error!("SQLite persistence failed ({}); falling back to in-memory", e);
                    std::sync::Arc::new(persistence::NoopPersistence)
                }
            }
        }
        "postgres" => {
            #[cfg(feature = "full")]
            {
                let url = substitute_pg_url(&settings.database.postgres.url);
                if url.is_empty() {
                    tracing::error!("postgres mode selected but database.postgres.url is empty");
                    return std::sync::Arc::new(persistence::NoopPersistence);
                }
                match persistence::postgres::PostgresPersistence::connect(&url).await {
                    Ok(p) => {
                        tracing::info!("PostgreSQL persistence ready");
                        std::sync::Arc::new(p)
                    }
                    Err(e) => {
                        tracing::error!("PostgreSQL persistence failed ({}); falling back to in-memory", e);
                        std::sync::Arc::new(persistence::NoopPersistence)
                    }
                }
            }
            #[cfg(not(feature = "full"))]
            {
                tracing::error!(
                    "postgres mode requires building with `--features full` (sqlx); using in-memory"
                );
                std::sync::Arc::new(persistence::NoopPersistence)
            }
        }
        _ => std::sync::Arc::new(persistence::NoopPersistence),
    }
}
fn substitute_pg_url(url: &str) -> String {
    if url.starts_with("${") && url.ends_with("}") {
        let var = &url[2..url.len() - 1];
        std::env::var(var).unwrap_or_default()
    } else {
        url.to_string()
    }

}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load .env if present
    let _ = dotenvy::dotenv();

    // Initialize tracing
    {
        use tracing_subscriber::prelude::*;
        tracing_subscriber::registry()
            .with(
                tracing_subscriber::fmt::layer().with_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
                ),
            )
            .with(hub::LogLayer)
            .init();
    }

    tracing::info!("Starting LLM Router v{}...", env!("CARGO_PKG_VERSION"));
    hub::init();

    // Initialize metrics registry early
    tracking::metrics::init();

    // Load configuration
    let settings = Settings::load().map_err(|e| {
        tracing::error!("Failed to load configuration: {}", e);
        e
    })?;

    tracing::info!("Configuration loaded successfully");

    // Persistence (usage records + runtime virtual keys)
    let persistence = init_persistence(&settings).await;
    persistence::install(persistence.clone());
    tracing::info!(
        "Persistence mode: {} (records: {})",
        persistence.mode(),
        persistence.count_usage().await.unwrap_or(0)
    );

    // Create provider registry
    let registry = Arc::new(ProviderRegistry::new(settings.clone()));
    connections::restore(&registry);

    tracing::info!(
        "Registered {} providers",
        registry.list_providers().len()
    );

    // Create HTTP client
    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;

    // Create router
    let router = Arc::new(Router::new(registry, settings.clone(), http_client));

    // Security: rate limiter + optional client keys + optional admin key
    let rate_limiter = Arc::new(rate_limit::RateLimiter::new(
        settings.security.requests_per_minute,
        std::time::Duration::from_secs(60),
    ));

    let keystore = std::sync::Arc::new(keystore::KeyStore::from_config(settings.keys.clone()));

    // Overlay runtime keys persisted from a previous run (config keys first;
    // persisted keys win so admin changes survive restarts)
    for cfg in persistence::load_runtime_keys().await {
        tracing::info!(owner = %cfg.owner, "Restoring persisted virtual key");
        keystore.upsert(cfg);
    }

    if keystore.is_enabled() {
        tracing::info!(
            "Virtual key auth ENABLED ({} keys configured)",
            keystore.list().len()
        );
    } else {
        tracing::info!("Virtual key auth DISABLED (no `keys` configured)");
    }

    let api_keys = if !keystore.is_enabled() && !settings.security.api_keys.is_empty() {
        tracing::info!(
            "Legacy API key auth ENABLED ({} keys configured)",
            settings.security.api_keys.len()
        );
        Some(settings.security.api_keys.clone())
    } else {
        None
    };

    let admin_key = settings.security.admin_key.clone();

    // Response cache (exact match, non-streaming)
    let cache = if settings.cache.enabled {
        tracing::info!(
            "Response cache ENABLED (ttl {}s, max {} entries)",
            settings.cache.ttl_seconds,
            settings.cache.max_entries
        );
        Some(Arc::new(cache::ResponseCache::new(
            settings.cache.ttl_seconds,
            settings.cache.max_entries,
        )))
    } else {
        tracing::info!("Response cache DISABLED");
        None
    };

    // Semantic cache (embedding cosine similarity, non-streaming)
    let semantic = if settings.semantic_cache.enabled {
        tracing::info!(
            "Semantic cache ENABLED (model {}, threshold {:.2}, ttl {}s, max {} entries)",
            settings.semantic_cache.embedding_model,
            settings.semantic_cache.similarity_threshold,
            settings.semantic_cache.ttl_seconds,
            settings.semantic_cache.max_entries
        );
        Some(Arc::new(semantic::SemanticCache::new(
            &settings.semantic_cache,
        )))
    } else {
        tracing::info!("Semantic cache DISABLED");
        None
    };

    // Create app state
    let state = AppState {
        router,
        rate_limiter,
        cache,
        semantic,
        keystore,
        api_keys,
        admin_key,
    };

    // Create axum app
    let app = create_routes(state);

    // Bind server
    let addr = format!("{}:{}", settings.server.host, settings.server.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;

    tracing::info!("Server listening on {}", addr);

    // Run server (with connect info for per-IP rate limiting)
    use std::net::SocketAddr;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}
