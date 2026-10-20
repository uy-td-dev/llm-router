use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router as AxumRouter,
};
use futures_util::StreamExt;
use serde_json::json;

use crate::api::models::{
    ChatCompletionRequest, EmbeddingRequest, ErrorDetail, ErrorResponse, KeyContext,
};
use crate::router::Router;
use crate::utils::RouterError;

#[derive(Clone)]
pub struct AppState {
    pub router: Arc<Router>,
    pub rate_limiter: crate::rate_limit::SharedRateLimiter,
    /// Exact-match response cache (when enabled)
    pub cache: Option<Arc<crate::cache::ResponseCache>>,
    /// Semantic (embedding cosine) cache (when enabled)
    pub semantic: Option<Arc<crate::semantic::SemanticCache>>,
    /// Runtime-adjustable virtual keys (auth enabled when non-empty)
    pub keystore: std::sync::Arc<crate::keystore::KeyStore>,
    /// Legacy global allow-list (used when the keystore is empty)
    pub api_keys: Option<Vec<String>>,
    /// Master key required on /admin/* endpoints
    pub admin_key: Option<String>,
}

pub fn create_routes(state: AppState) -> AxumRouter {
    AxumRouter::new()
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/embeddings", post(embeddings))
        .route("/v1/models", get(list_models))
        .route("/health", get(health_check))
        .route("/metrics", get(metrics))
        .route("/admin/stats", get(admin_stats))
        .route("/admin/keys", get(admin_keys_list).post(admin_keys_add))
        .route("/admin/keys/delete", post(admin_keys_delete))
        .route("/admin/accounts", get(admin_accounts))
        .route("/admin/providers/:name/accounts", get(provider_accounts).post(provider_accounts_add))
        .route("/admin/providers/:name/accounts/:label", delete(provider_account_delete))
        .route("/admin/providers/:name/test", post(provider_test))
        .route("/admin/connections", get(connections_list).post(connections_upsert))
        .route("/admin/connections/test", post(connections_test))
        .route("/admin/connections/:name", delete(connections_delete))
        .route(
            "/admin/connections/:name/accounts/:label",
            delete(connections_account_delete).patch(connections_account_patch),
        )
        .route("/admin/connections/models", post(connections_fetch_models))
        .route("/admin/combos", get(combos_list).post(combos_upsert))
        .route("/admin/combos/:name", delete(combos_delete))
        .route("/admin/config", get(admin_config_get).put(admin_config_put))
        .route("/admin/history", get(admin_history))
        .route("/admin/persistence", get(admin_persistence))
        .merge(crate::api::hub_routes::routes())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::api::middleware::enforce,
        ))
        .with_state(state)
}

async fn chat_completions(
    State(state): State<AppState>,
    Extension(ctx): Extension<KeyContext>,
    Json(req): Json<ChatCompletionRequest>,
) -> Result<Response, AppError> {
    // Streaming path: normalized OpenAI SSE chunks
    if req.stream {
        let (stream, provider, model) = state.router.route_stream(&req, &ctx).await?;
        let bytes_stream = stream.map(|b| Ok::<_, std::io::Error>(b));
        let response = Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .header("connection", "keep-alive")
            .body(Body::from_stream(bytes_stream))
            .map_err(|e| AppError(RouterError::Internal(e.to_string())))?;

        tracing::info!(
            requested_model = %req.model,
            served_by = %format!("{provider}/{model}"),
            "Streaming request started"
        );
        return Ok(response);
    }

    // Cache lookup (non-streaming only)
    if let Some(cache) = &state.cache {
        if let Some(hit) = cache.get(&req) {
            crate::tracking::usage::record_cache_hit();
            crate::hub::log_cache(&ctx, &req.model);
            tracing::info!(
                requested_model = %req.model,
                owner = %ctx.owner,
                key = %ctx.label,
                "Cache hit"
            );
            return Ok(Json(hit).into_response());
        }
    }

    // Semantic cache lookup (non-streaming only). The conversation text is
    // embedded via the embeddings pipeline; a hit returns the stored
    // response without touching the chat upstream.
    let mut query_vector: Option<Vec<f32>> = None;
    if let Some(semantic) = &state.semantic {
        let text = req
            .messages
            .iter()
            .map(|m| m.content.text())
            .collect::<Vec<_>>()
            .join("\n");
        match state.router.embed_text(&text).await {
            Ok(vector) if !vector.is_empty() => {
                if let Some(hit) = semantic.lookup(&vector) {
                    crate::tracking::usage::record_semantic_cache_hit();
                    crate::hub::log_cache(&ctx, &req.model);
                    tracing::info!(
                        requested_model = %req.model,
                        owner = %ctx.owner,
                        key = %ctx.label,
                        "Semantic cache hit"
                    );
                    return Ok(Json(hit).into_response());
                }
                query_vector = Some(vector);
            }
            Ok(_) => {
                tracing::warn!("Semantic cache bypass: empty embedding vector");
            }
            Err(e) => {
                tracing::debug!("Semantic cache bypass (embedding unavailable): {e}");
            }
        }
    }

    let (response, provider, model) = state.router.route(&req, &ctx).await?;
    tracing::info!(
        requested_model = %req.model,
        served_by = %format!("{provider}/{model}"),
        tokens = response.usage.total_tokens,
        "Request completed"
    );
    if let Some(cache) = &state.cache {
        cache.put(&req, response.clone());
    }
    if let (Some(semantic), Some(vector)) = (&state.semantic, query_vector) {
        semantic.store(vector, response.clone());
    }
    Ok(Json(response).into_response())
}

/// POST /v1/embeddings — OpenAI-compatible response built from whichever
/// provider/account served the request.
async fn embeddings(
    State(state): State<AppState>,
    Extension(ctx): Extension<KeyContext>,
    Json(req): Json<EmbeddingRequest>,
) -> Result<Response, AppError> {
    let response = state.router.embeddings(&req, &ctx).await?;
    tracing::info!(
        requested_model = %req.model,
        inputs = response.data.len(),
        tokens = response.usage.total_tokens,
        "Embedding request completed"
    );
    Ok(Json(response).into_response())
}

async fn health_check() -> &'static str {
    "OK"
}

async fn list_models(
    State(state): State<AppState>,
    Extension(ctx): Extension<KeyContext>,
) -> Json<serde_json::Value> {
    let data: Vec<serde_json::Value> = state
        .router
        .list_models(&ctx)
        .into_iter()
        .map(|m| {
            serde_json::json!({
                "id": m,
                "object": "model",
                "created": 0,
                "owned_by": "llm-router",
            })
        })
        .collect();
    Json(serde_json::json!({ "object": "list", "data": data }))
}

async fn metrics() -> impl IntoResponse {
    (
        StatusCode::OK,
        [("Content-Type", "text/plain; version=0.0.4")],
        crate::tracking::metrics::render(),
    )
}

async fn admin_stats() -> Json<serde_json::Value> {
    Json(serde_json::to_value(crate::tracking::usage::stats()).unwrap_or_default())
}

/// Masked display form of a virtual key (`sk-****`). Byte-safe: never
/// panics on non-ASCII keys (byte-index slicing at 4 could).
fn mask_key(key: &str) -> String {
    let head = key
        .char_indices()
        .nth(4)
        .map(|(i, _)| i)
        .unwrap_or(key.len());
    format!("{}***", &key[..head])
}

async fn admin_keys_list(State(state): State<AppState>) -> Json<serde_json::Value> {
    let keys = state.keystore.list();
    let masked: Vec<serde_json::Value> = keys
        .iter()
        .map(|k| {
            let masked_key = mask_key(&k.key);
            json!({
                "key": masked_key,
                // The admin UI needs the real value to edit/delete a key
                // (`POST /admin/keys` upserts by the key string itself).
                // Only reachable behind admin auth.
                "key_plain": k.key,
                "owner": k.owner,
                "team": k.team,
                "allowed_models": k.allowed_models,
                "allowed_providers": crate::connections::effective_providers(k),
                "rpm": k.rpm,
                "monthly_budget_usd": k.monthly_budget_usd,
            })
        })
        .collect();
    Json(json!({ "count": masked.len(), "keys": masked }))
}

/// Runtime key management (admin):
/// POST /admin/keys {"key": "...", "owner": "...", ...} → add or replace.
async fn admin_keys_add(
    State(state): State<AppState>,
    Json(cfg): Json<crate::config::KeyConfig>,
) -> Result<Json<serde_json::Value>, AppError> {
    if cfg.key.trim().is_empty() {
        return Err(AppError(RouterError::InvalidRequest(
            "key must not be empty".to_string(),
        )));
    }
    let replaced = state.keystore.upsert(cfg.clone());
    tracing::info!(key = %cfg.key, owner = %cfg.owner, replaced, "Virtual key upserted via admin API");
    crate::persistence::persist_key(&cfg).await;
    Ok(Json(json!({
        "status": "ok",
        "replaced": replaced,
        "key_masked": format!("{}***", &cfg.key[..cfg.key.len().min(4)]),
        "owner": cfg.owner,
        "total_keys": state.keystore.list().len(),
    })))
}

/// POST /admin/keys/delete {"key": "sk-vk-alice"} → remove.
async fn admin_keys_delete(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    let Some(key) = body.get("key").and_then(|v| v.as_str()) else {
        return Err(AppError(RouterError::InvalidRequest(
            "missing field 'key'".to_string(),
        )));
    };
    let removed = state.keystore.remove(key);
    if !removed {
        return Err(AppError(RouterError::InvalidRequest(format!(
            "key not found: {}",
            mask_key(key)
        ))));
    }
    tracing::info!(key_masked = %mask_key(key), "Virtual key removed via admin API");
    crate::persistence::remove_key(key).await;
    Ok(Json(json!({
        "status": "ok",
        "removed": true,
        "total_keys": state.keystore.list().len(),
    })))
}

async fn admin_accounts(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({ "accounts": state.router.account_statuses() }))
}

/// Secrets whose value the config API replaces with this sentinel in GET
/// responses; PUT with the sentinel keeps the previous value (so secrets
/// are never displayed or accidentally overwritten by the UI).
const SAVED_MASK: &str = "__SAVED__";

const ALLOWED_FORMATS: [&str; 3] = ["openai", "anthropic", "google"];

fn mask_saved_settings(settings: &mut crate::config::Settings) {
    for provider in &mut settings.providers {
        if !provider.api_key.is_empty() {
            provider.api_key = SAVED_MASK.to_string();
        }
        for account in &mut provider.accounts {
            if !account.api_key.is_empty() {
                account.api_key = SAVED_MASK.to_string();
            }
        }
    }
    for key in &mut settings.keys {
        key.key = SAVED_MASK.to_string();
    }
    if settings.security.admin_key.is_some() {
        settings.security.admin_key = Some(SAVED_MASK.to_string());
    }
}

/// GET /admin/config — current config file with secrets masked
/// (`__SAVED__`); the `keys`/`security` sections are managed elsewhere
/// (runtime key API) and changes to them are ignored on save.
async fn admin_config_get(State(state): State<AppState>) -> Json<serde_json::Value> {
    // Prefer the YAML file (source of truth PUT edits); fall back to runtime.
    let mut settings = tokio::fs::read_to_string("config/default.yaml")
        .await
        .ok()
        .and_then(|t| serde_yaml::from_str::<crate::config::Settings>(&t).ok())
        .unwrap_or_else(|| state.router.settings());
    mask_saved_settings(&mut settings);
    Json(serde_json::to_value(&settings).unwrap_or_else(|_| json!({})))
}

/// PUT /admin/config — persist an edited configuration to
/// `config/default.yaml` (backup at `default.yaml.bak`). Secrets sent as
/// `__SAVED__` keep their previous value; `keys`/`security` are never
/// modified here (use the runtime keys API). Takes effect on restart.
async fn admin_config_put(
    State(_state): State<AppState>,
    Json(mut new): Json<crate::config::Settings>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Structural validation first
    for provider in &new.providers {
        if !ALLOWED_FORMATS.contains(&provider.wire_format()) {
            return Err(AppError(RouterError::InvalidRequest(format!(
                "provider '{}': format '{}' không hỗ trợ (chỉ openai|anthropic|google)",
                provider.name,
                provider.wire_format()
            ))));
        }
        if provider.models.is_empty() {
            return Err(AppError(RouterError::InvalidRequest(format!(
                "provider '{}' cần ít nhất 1 model",
                provider.name
            ))));
        }
    }

    // Unmask secrets from the YAML file's values (placeholders like
    // ${OPENAI_API_KEY} survive the round trip; the UI never saw them).
    let file_settings = tokio::fs::read_to_string("config/default.yaml")
        .await
        .ok()
        .and_then(|t| serde_yaml::from_str::<crate::config::Settings>(&t).ok());
    if let Some(saved) = &file_settings {
        for provider in &mut new.providers {
            if let Some(old) = saved.providers.iter().find(|p| p.name == provider.name) {
                if provider.api_key == SAVED_MASK {
                    provider.api_key = old.api_key.clone();
                }
                for account in &mut provider.accounts {
                    if account.api_key == SAVED_MASK {
                        if let Some(old_acc) =
                            old.accounts.iter().find(|a| a.label == account.label)
                        {
                            account.api_key = old_acc.api_key.clone();
                        }
                    }
                }
            }
        }
    }

    // keys/security never editable here: restore file-provided values
    if let Some(file_settings) = file_settings {
        new.keys = file_settings.keys.clone();
        new.security = file_settings.security;
    }

    // Scoped lock (std MutexGuard is not Send — must not be held across .await)
    {
        let _config_lock = CONFIG_FILE_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
    }

    let yaml = serde_yaml::to_string(&new)
        .map_err(|e| AppError(RouterError::Internal(format!("serialize yaml: {e}"))))?;
    let path = std::path::Path::new("config/default.yaml");
    let old = tokio::fs::read_to_string(path).await.unwrap_or_default();
    tokio::fs::write("config/default.yaml.bak", &old)
        .await
        .map_err(|e| AppError(RouterError::Internal(format!("backup: {e}"))))?;
    tokio::fs::write(path, yaml)
        .await
        .map_err(|e| AppError(RouterError::Internal(format!("write config: {e}"))))?;

    tracing::info!("Configuration updated via admin API (restart required)");
    Ok(Json(json!({
        "status": "ok",
        "restart_required": true,
        "note": "config/default.yaml written; restart llm-router to apply"
    })))
}

static CONFIG_FILE_LOCK: once_cell::sync::Lazy<std::sync::Mutex<()>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(()));

/// GET /admin/connections — dashboard-connected providers (no secrets).
async fn connections_list(State(state): State<AppState>) -> Json<serde_json::Value> {
    let registry = state.router.registry();
    let providers: Vec<_> = registry
        .provider_configs()
        .iter()
        .map(|c| {
            json!({
                "name": c.name,
                "format": c.wire_format(),
                "models": c.models.iter().map(|m| m.name.clone()).collect::<Vec<_>>(),
                "accounts": registry.pool(&c.name).iter().filter(|a| !a.api_key.is_empty()).count(),
                "yaml": registry.is_yaml(&c.name),
            })
        })
        .collect();
    Json(json!({
        "connections": crate::connections::list(registry),
        "providers": providers,
    }))
}

/// POST /admin/connections — create/replace a connection (provider
/// definition + accounts); applied immediately and persisted.
async fn connections_upsert(
    State(state): State<AppState>,
    Json(conn): Json<crate::connections::Connection>,
) -> Result<Json<serde_json::Value>, AppError> {
    let name = conn.name.clone();
    crate::connections::upsert(state.router.registry(), conn).map_err(AppError)?;
    tracing::info!(provider = %name, "Connection saved via admin API");
    Ok(Json(json!({ "status": "ok", "name": name })))
}

#[derive(serde::Deserialize)]
struct ConnTestBody {
    connection: crate::connections::Connection,
    api_key: String,
    model: Option<String>,
}

/// POST /admin/connections/test — probe an unsaved connection.
async fn connections_test(
    State(state): State<AppState>,
    Json(body): Json<ConnTestBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    match state
        .router
        .test_connection(&body.connection, &body.api_key, body.model.as_deref())
        .await
    {
        Ok(v) => Ok(Json(v)),
        Err(RouterError::InvalidRequest(msg)) => Err(AppError(RouterError::InvalidRequest(msg))),
        Err(e) => Ok(Json(json!({ "ok": false, "provider": body.connection.name, "error": e.to_string() }))),
    }
}

/// DELETE /admin/connections/:name — disconnect.
async fn connections_delete(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::connections::remove(state.router.registry(), &name).map_err(AppError)?;
    Ok(Json(json!({ "status": "ok", "removed": name })))
}

/// DELETE /admin/connections/:name/accounts/:label — disconnect one account.
async fn connections_account_delete(
    State(state): State<AppState>,
    Path((name, label)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::connections::remove_account(state.router.registry(), &name, &label).map_err(AppError)?;
    Ok(Json(json!({ "status": "ok", "removed": label })))
}

/// PATCH /admin/connections/:name/accounts/:label — priority/weight/enabled/key.
async fn connections_account_patch(
    State(state): State<AppState>,
    Path((name, label)): Path<(String, String)>,
    Json(patch): Json<crate::connections::AccountPatch>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::connections::update_account(state.router.registry(), &name, &label, patch).map_err(AppError)?;
    Ok(Json(json!({ "status": "ok" })))
}

#[derive(serde::Deserialize)]
struct FetchModelsBody {
    /// Saved connection name (uses its definition + stored key)…
    name: Option<String>,
    label: Option<String>,
    /// …or an unsaved definition + key.
    format: Option<String>,
    base_url: Option<String>,
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
    api_key: Option<String>,
}

/// POST /admin/connections/models — list models from the upstream `/models`.
async fn connections_fetch_models(
    State(state): State<AppState>,
    Json(b): Json<FetchModelsBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    let saved = b.name.as_deref().and_then(crate::connections::get);
    let yaml = b.name.as_deref().and_then(|n| state.router.registry().provider_config(n));
    let format = b
        .format
        .or_else(|| saved.as_ref().map(|c| c.format.clone()))
        .or_else(|| yaml.as_ref().map(|c| c.wire_format().to_string()))
        .unwrap_or_else(|| "openai".to_string());
    let base_url = b
        .base_url
        .filter(|u| !u.is_empty())
        .or_else(|| saved.as_ref().map(|c| c.base_url.clone()).filter(|u| !u.is_empty()))
        .or_else(|| yaml.as_ref().map(|c| c.base_url.clone()))
        .ok_or_else(|| AppError(RouterError::InvalidRequest("cần base_url".to_string())))?;
    let headers = if b.headers.is_empty() {
        saved.as_ref().map(|c| c.headers.clone()).unwrap_or_default()
    } else {
        b.headers
    };
    let key = b
        .api_key
        .filter(|k| !k.trim().is_empty())
        .or_else(|| {
            b.name
                .as_deref()
                .and_then(|n| crate::connections::stored_key(n, b.label.as_deref()))
        })
        .or_else(|| {
            b.name.as_deref().and_then(|n| {
                state.router.registry().pool(n).into_iter().find(|a| !a.api_key.is_empty()).map(|a| a.api_key)
            })
        })
        .ok_or_else(|| AppError(RouterError::InvalidRequest("cần api_key hoặc account đã lưu".to_string())))?;
    match crate::connections::fetch_models(&format, &base_url, &headers, key.trim()).await {
        Ok(models) => Ok(Json(json!({ "ok": true, "models": models }))),
        Err(e) => Ok(Json(json!({ "ok": false, "error": e.to_string() }))),
    }
}

async fn combos_list() -> Json<serde_json::Value> {
    Json(json!({ "combos": crate::connections::combos() }))
}

async fn combos_upsert(
    State(state): State<AppState>,
    Json(combo): Json<crate::connections::Combo>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::connections::upsert_combo(state.router.registry(), combo).map_err(AppError)?;
    Ok(Json(json!({ "status": "ok" })))
}

async fn combos_delete(Path(name): Path<String>) -> Result<Json<serde_json::Value>, AppError> {
    crate::connections::remove_combo(&name).map_err(AppError)?;
    Ok(Json(json!({ "status": "ok", "removed": name })))
}

#[derive(serde::Deserialize, Default)]
struct TestBody {
    label: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
}

/// POST /admin/providers/:name/test — one real upstream request using
/// either `api_key` (test before saving) or an existing account `label`.
/// Upstream failures come back as `{ok:false, error}` with HTTP 200 so the
/// UI can show the provider's message; bad input stays 400.
async fn provider_test(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<TestBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    match state
        .router
        .test_account(
            &name,
            body.label.as_deref(),
            body.api_key.as_deref(),
            body.model.as_deref(),
        )
        .await
    {
        Ok(v) => Ok(Json(v)),
        Err(RouterError::InvalidRequest(msg)) => {
            Err(AppError(RouterError::InvalidRequest(msg)))
        }
        Err(e) => Ok(Json(json!({ "ok": false, "provider": name, "error": e.to_string() }))),
    }
}

#[derive(serde::Deserialize)]
struct AddAccountBody {
    label: String,
    api_key: String,
    priority: Option<i32>,
    weight: Option<u32>,
}

/// GET /admin/providers/:name/accounts — view one provider's pool.
async fn provider_accounts(State(state): State<AppState>, Path(name): Path<String>) -> Result<Json<serde_json::Value>, AppError> {
    let accounts = state
        .router
        .provider_accounts(&name)
        .map_err(AppError)?;
    Ok(Json(json!({ "provider": name, "accounts": accounts })))
}

/// POST /admin/providers/:name/accounts — add/replace an upstream account
/// at runtime (weighted rotation applies immediately; not persisted to YAML).
async fn provider_accounts_add(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<AddAccountBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    state
        .router
        .add_account(
            &name,
            &body.label,
            &body.api_key,
            body.priority.unwrap_or(10),
            body.weight.unwrap_or(1),
        )
        .map_err(AppError)?;
    tracing::info!(provider = %name, label = %body.label, "Upstream account added via admin API");
    let accounts = state
        .router
        .provider_accounts(&name)
        .map_err(AppError)?;
    Ok(Json(json!({ "status": "ok", "provider": name, "label": body.label, "accounts": accounts })))
}

/// DELETE /admin/providers/:name/accounts/:label — remove a runtime account.
async fn provider_account_delete(
    State(state): State<AppState>,
    Path((name, label)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    state
        .router
        .remove_account(&name, &label)
        .map_err(AppError)?;
    tracing::info!(provider = %name, label = %label, "Upstream account removed via admin API");
    let accounts = state
        .router
        .provider_accounts(&name)
        .map_err(AppError)?;
    Ok(Json(json!({ "status": "ok", "removed": label, "accounts": accounts })))
}

#[derive(serde::Deserialize)]
struct HistoryParams {
    minutes: Option<u64>,
    api_key: Option<String>,
    /// Filter by owner username (dashboard-scoped views).
    owner: Option<String>,
    /// Filter by team: restricts rows to keys of that team.
    team: Option<String>,
    /// "raw" (default) | "day" | "key" | "provider" | "model" | "account" | "team" | "owner"
    group: Option<String>,
    limit: Option<u64>,
}

/// GET /admin/history — raw records or aggregates from the persisted
/// usage history (requires database.mode sqlite/postgres).
async fn admin_history(
    axum::extract::Query(params): axum::extract::Query<HistoryParams>,
) -> Result<Json<serde_json::Value>, AppError> {
    let minutes = params.minutes.unwrap_or(1440).clamp(1, 60 * 24 * 365);
    let limit = params.limit.unwrap_or(200).clamp(1, 1000);
    let group = params.group.clone().unwrap_or_else(|| "raw".to_string());
    if !matches!(group.as_str(), "raw" | "day" | "key" | "provider" | "model" | "account" | "team" | "owner") {
        return Err(AppError(RouterError::InvalidRequest(format!(
            "invalid group '{group}': expected raw|day|key|provider|model|account|team|owner"
        ))));
    }

    let since = chrono::Utc::now() - chrono::Duration::minutes(minutes as i64);
    let query = crate::persistence::UsageQuery {
        since_rfc3339: since.to_rfc3339(),
        api_key: params.api_key.clone(),
        owner: params.owner.clone(),
        team: params.team.clone(),
        group: if group == "raw" { None } else { Some(group.clone()) },
        limit,
    };

    let mode = crate::persistence::status().await.mode;
    if mode == "none" {
        return Ok(Json(json!({
            "mode": "none",
            "group": group,
            "minutes": minutes,
            "rows": [],
            "note": "history requires database.mode: sqlite/postgres"
        })));
    }

    let rows = crate::persistence::query_usage(query)
        .await
        .map_err(RouterError::Internal)
        .map_err(AppError)?;
    Ok(Json(json!({
        "mode": mode,
        "group": group,
        "minutes": minutes,
        "api_key": params.api_key,
        "owner": params.owner,
        "team": params.team,
        "count": rows.len(),
        "rows": rows,
    })))
}

async fn admin_persistence() -> Json<serde_json::Value> {
    let status = crate::persistence::status().await;
    Json(json!({ "persistence": status }))
}

// Error handling wrapper
pub struct AppError(RouterError);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, error_type, message) = match self.0 {
            RouterError::Provider(msg) => (StatusCode::BAD_GATEWAY, "provider_error", msg),
            RouterError::AllProvidersFailed => (
                StatusCode::SERVICE_UNAVAILABLE,
                "all_providers_failed",
                "All providers failed".to_string(),
            ),
            RouterError::InvalidRequest(msg) => (StatusCode::BAD_REQUEST, "invalid_request", msg),
            RouterError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, "auth_error", msg),
            RouterError::Forbidden(msg) => (StatusCode::FORBIDDEN, "permission_error", msg),
            RouterError::Budget(msg) => (
                StatusCode::PAYMENT_REQUIRED,
                "budget_exceeded",
                msg,
            ),
            RouterError::Config(msg) => (StatusCode::INTERNAL_SERVER_ERROR, "config_error", msg),
            RouterError::Http(e) => (
                StatusCode::BAD_GATEWAY,
                "http_error",
                e.to_string(),
            ),
            RouterError::Serialization(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "serialization_error",
                e.to_string(),
            ),
            RouterError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, "internal_error", msg),
        };

        let error_response = ErrorResponse {
            error: ErrorDetail {
                message,
                error_type: error_type.to_string(),
            },
        };

        (status, Json(error_response)).into_response()
    }
}

impl<E> From<E> for AppError
where
    E: Into<RouterError>,
{
    fn from(err: E) -> Self {
        Self(err.into())
    }
}
