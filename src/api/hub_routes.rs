//! Admin endpoints for hub features (logs, usage, quotas, token saver,
//! vision adapter, proxy pools, skills, system).

use axum::{
    extract::{Path, Query, State},
    routing::{delete, get, post},
    Json, Router as AxumRouter,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::routes::{AppError, AppState};
use crate::hub;
use crate::utils::RouterError;

pub fn routes() -> AxumRouter<AppState> {
    AxumRouter::new()
        .route("/admin/logs", get(logs_get).delete(logs_clear))
        .route("/admin/requests", get(requests_get))
        .route("/admin/usage", get(usage_get))
        .route("/admin/insights", get(insights_get))
        .route("/admin/quotas", get(quotas_get).post(quotas_set))
        .route("/admin/token-saver", get(saver_get).post(saver_set))
        .route("/admin/token-saver/preview", post(saver_preview))
        .route("/admin/vision", get(vision_get).post(vision_set))
        .route("/admin/proxies", get(proxies_get).post(proxies_upsert))
        .route("/admin/proxies/test", post(proxies_test))
        .route("/admin/proxies/assign", post(proxies_assign))
        .route("/admin/proxies/:name", delete(proxies_delete))
        .route("/admin/skills", get(skills_get).post(skills_upsert))
        .route("/admin/skills/:name", delete(skills_delete))
        .route("/admin/system", get(system_get))
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::from(RouterError::InvalidRequest(msg.into()))
}

// ---------- logs ----------

#[derive(Deserialize)]
struct LogParams {
    after: Option<u64>,
    limit: Option<usize>,
}

async fn logs_get(Query(p): Query<LogParams>) -> Json<Value> {
    let (last, lines) = hub::logs(p.after.unwrap_or(0), p.limit.unwrap_or(500).clamp(1, 2000));
    Json(json!({ "last_id": last, "lines": lines }))
}

async fn logs_clear() -> Json<Value> {
    hub::clear_logs();
    Json(json!({ "ok": true }))
}

#[derive(Deserialize)]
struct ReqParams {
    limit: Option<usize>,
    status: Option<String>,
    /// Dashboard scoping: restrict rows to one owner (member view) or to
    /// all keys of one team (team-lead view). Both may be combined.
    owner: Option<String>,
    team: Option<String>,
}

async fn requests_get(
    State(state): State<AppState>,
    Query(p): Query<ReqParams>,
) -> Json<Value> {
    let scope = scope_from_params(&state, p.owner, p.team);
    let rows = hub::requests_scoped(p.limit.unwrap_or(200).clamp(1, 2000), p.status.as_deref(), &scope);
    Json(json!({ "rows": rows }))
}

#[derive(Deserialize)]
struct UsageParams {
    hours: Option<i64>,
    /// Dashboard scoping (see ReqParams).
    owner: Option<String>,
    team: Option<String>,
}

async fn usage_get(State(state): State<AppState>, Query(p): Query<UsageParams>) -> Json<Value> {
    let scope = scope_from_params(&state, p.owner, p.team);
    let mut v = hub::usage_report_scoped(p.hours.unwrap_or(24), &scope);
    v["counters"] = hub::counters();
    Json(v)
}

#[derive(Deserialize)]
struct InsightsParams {
    hours: Option<i64>,
    /// Dashboard scoping (see ReqParams): team-lead view filters by team.
    owner: Option<String>,
    team: Option<String>,
}

/// GET /admin/insights?hours=N[&team=..|&owner=..] — per team / owner / key
/// nested breakdown (tokens, requests, models, providers, accounts). Admin
/// monitor view; team leads get their team via the team param (BFF-forced).
async fn insights_get(
    State(state): State<AppState>,
    Query(p): Query<InsightsParams>,
) -> Json<Value> {
    let scope = scope_from_params(&state, p.owner, p.team);
    Json(hub::insights_scoped(p.hours.unwrap_or(168), &scope))
}

/// Resolve `owner`/`team` query params into a hub::Scope. Team scoping uses
/// the team recorded at request time (survives key rotation); when a team has
/// no keys at all we also match nothing extra — fail closed either way.
fn scope_from_params(
    state: &AppState,
    owner: Option<String>,
    team: Option<String>,
) -> crate::hub::Scope {
    let mut scope = crate::hub::Scope::default();
    if let Some(owner) = owner.filter(|o| !o.is_empty()) {
        scope.owner = Some(owner);
    }
    if let Some(team) = team.filter(|t| !t.is_empty()) {
        // Also restrict to live keys of that team: requests made with a
        // deleted key whose team field matched would otherwise still show.
        let keys = state
            .keystore
            .list()
            .into_iter()
            .filter(|k| k.team.as_deref() == Some(team.as_str()))
            .map(|k| k.key)
            .collect::<std::collections::HashSet<_>>();
        scope.team = Some(team);
        scope.keys = Some(keys);
    }
    scope
}

// ---------- quotas ----------

async fn quotas_get(State(state): State<AppState>) -> Json<Value> {
    let cfg = hub::config();
    let rows: Vec<Value> = state
        .router
        .account_statuses()
        .into_iter()
        .map(|a| {
            let key = format!("{}/{}", a.provider, a.label);
            let (req, tok, usd) = hub::account_usage(&a.provider, &a.label);
            let quota = cfg.quotas.get(&key).cloned().unwrap_or_default();
            json!({
                "provider": a.provider,
                "label": a.label,
                "requests_today": req,
                "tokens_today": tok,
                "usd_month": usd,
                "quota": quota,
                "exhausted": !hub::quota_ok(&a.provider, &a.label),
                "cooldown_remaining_ms": a.cooldown_remaining_ms,
                "total_requests": a.requests,
                "failures": a.failures,
                "rate_limited": a.rate_limited,
            })
        })
        .collect();
    Json(json!({ "rows": rows, "reset_in_secs": hub::reset_in_secs() }))
}

#[derive(Deserialize)]
struct QuotaBody {
    provider: String,
    label: String,
    #[serde(default)]
    quota: Option<hub::Quota>,
}

async fn quotas_set(Json(b): Json<QuotaBody>) -> Result<Json<Value>, AppError> {
    if b.provider.is_empty() || b.label.is_empty() {
        return Err(bad("provider và label là bắt buộc"));
    }
    let key = format!("{}/{}", b.provider, b.label);
    hub::update(|c| {
        match b.quota {
            Some(q) if q.requests_per_day.is_some() || q.tokens_per_day.is_some() || q.usd_per_month.is_some() => {
                c.quotas.insert(key.clone(), q);
            }
            _ => {
                c.quotas.remove(&key);
            }
        }
        Ok(())
    })?;
    Ok(Json(json!({ "ok": true })))
}

// ---------- token saver ----------

async fn saver_get() -> Json<Value> {
    let c = hub::config();
    Json(json!({ "settings": c.token_saver, "counters": hub::counters() }))
}

async fn saver_set(Json(s): Json<hub::TokenSaver>) -> Result<Json<Value>, AppError> {
    let c = hub::update(|c| {
        c.token_saver = s;
        Ok(())
    })?;
    Ok(Json(json!({ "ok": true, "settings": c.token_saver })))
}

#[derive(Deserialize)]
struct PreviewBody {
    settings: hub::TokenSaver,
    messages: Vec<crate::api::models::Message>,
}

async fn saver_preview(Json(b): Json<PreviewBody>) -> Result<Json<Value>, AppError> {
    let mut req: crate::api::models::ChatCompletionRequest = serde_json::from_value(json!({
        "model": "preview",
        "messages": b.messages,
    }))
    .map_err(|e| bad(e.to_string()))?;
    let before = hub::estimate_tokens(&req.messages);
    let saved = hub::compact(&b.settings, &mut req);
    Ok(Json(json!({
        "before_tokens": before,
        "after_tokens": hub::estimate_tokens(&req.messages),
        "saved_tokens": saved,
        "messages": req.messages,
    })))
}

// ---------- vision ----------

async fn vision_get() -> Json<Value> {
    Json(json!({ "settings": hub::config().vision, "counters": hub::counters() }))
}

async fn vision_set(Json(v): Json<hub::VisionAdapter>) -> Result<Json<Value>, AppError> {
    if v.enabled && v.vision_model.trim().is_empty() {
        return Err(bad("cần chọn vision model khi bật adapter"));
    }
    let c = hub::update(|c| {
        c.vision = v;
        Ok(())
    })?;
    Ok(Json(json!({ "ok": true, "settings": c.vision })))
}

// ---------- proxies ----------

async fn proxies_get(State(state): State<AppState>) -> Json<Value> {
    let c = hub::config();
    let proxies: Vec<Value> = c
        .proxies
        .iter()
        .map(|p| {
            let used_by: Vec<&String> = c
                .provider_proxy
                .iter()
                .filter(|(_, v)| *v == &p.name)
                .map(|(k, _)| k)
                .collect();
            json!({ "name": p.name, "url": hub::mask_proxy(&p.url), "enabled": p.enabled, "used_by": used_by })
        })
        .collect();
    let mut providers: Vec<String> = state
        .router
        .registry()
        .provider_configs()
        .into_iter()
        .map(|p| p.name)
        .collect();
    providers.sort();
    providers.dedup();
    Json(json!({ "proxies": proxies, "assignments": c.provider_proxy, "providers": providers }))
}

#[derive(Deserialize)]
struct ProxyBody {
    name: String,
    #[serde(default)]
    url: String,
    #[serde(default = "yes")]
    enabled: bool,
}
fn yes() -> bool {
    true
}

fn valid_proxy_url(url: &str) -> Result<(), AppError> {
    let ok = ["http://", "https://", "socks5://", "socks5h://"].iter().any(|s| url.starts_with(s));
    if !ok {
        return Err(bad("URL proxy phải bắt đầu bằng http://, https://, socks5:// hoặc socks5h://"));
    }
    reqwest::Proxy::all(url).map_err(|e| bad(format!("proxy URL lỗi: {e}")))?;
    Ok(())
}

async fn proxies_upsert(Json(b): Json<ProxyBody>) -> Result<Json<Value>, AppError> {
    let name = hub::valid_name(&b.name)?;
    let url = b.url.trim().to_string();
    hub::update(|c| {
        if let Some(p) = c.proxies.iter_mut().find(|p| p.name == name) {
            // empty / masked url keeps the stored one
            if !url.is_empty() && !url.contains('•') {
                valid_proxy_url(&url).map_err(|_| RouterError::InvalidRequest("proxy URL không hợp lệ".into()))?;
                p.url = url.clone();
            }
            p.enabled = b.enabled;
        } else {
            if url.is_empty() {
                return Err(RouterError::InvalidRequest("cần URL proxy".into()));
            }
            valid_proxy_url(&url).map_err(|_| RouterError::InvalidRequest("proxy URL không hợp lệ (http/https/socks5)".into()))?;
            c.proxies.push(hub::ProxyEntry { name: name.clone(), url: url.clone(), enabled: b.enabled });
        }
        Ok(())
    })?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ProxyTest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

async fn proxies_test(Json(b): Json<ProxyTest>) -> Result<Json<Value>, AppError> {
    let url = match (b.url.filter(|u| !u.is_empty() && !u.contains('•')), b.name) {
        (Some(u), _) => u,
        (None, Some(n)) => hub::config()
            .proxies
            .into_iter()
            .find(|p| p.name == n)
            .map(|p| p.url)
            .ok_or_else(|| bad(format!("proxy '{n}' không tồn tại")))?,
        _ => return Err(bad("cần name hoặc url")),
    };
    valid_proxy_url(&url)?;
    match hub::test_proxy(&url).await {
        Ok((ip, ms)) => Ok(Json(json!({ "ok": true, "ip": ip, "latency_ms": ms }))),
        Err(e) => Ok(Json(json!({ "ok": false, "error": e.to_string() }))),
    }
}

#[derive(Deserialize)]
struct AssignBody {
    provider: String,
    /// null / "" = direct
    #[serde(default)]
    proxy: Option<String>,
}

async fn proxies_assign(Json(b): Json<AssignBody>) -> Result<Json<Value>, AppError> {
    hub::update(|c| {
        match b.proxy.filter(|p| !p.is_empty()) {
            Some(p) => {
                if !c.proxies.iter().any(|x| x.name == p) {
                    return Err(RouterError::InvalidRequest(format!("proxy '{p}' không tồn tại")));
                }
                c.provider_proxy.insert(b.provider.clone(), p);
            }
            None => {
                c.provider_proxy.remove(&b.provider);
            }
        }
        Ok(())
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn proxies_delete(Path(name): Path<String>) -> Result<Json<Value>, AppError> {
    hub::update(|c| {
        let before = c.proxies.len();
        c.proxies.retain(|p| p.name != name);
        if c.proxies.len() == before {
            return Err(RouterError::InvalidRequest(format!("proxy '{name}' không tồn tại")));
        }
        c.provider_proxy.retain(|_, v| v != &name);
        Ok(())
    })?;
    Ok(Json(json!({ "ok": true })))
}

// ---------- skills ----------

async fn skills_get() -> Json<Value> {
    Json(json!({ "skills": hub::config().skills, "counters": hub::counters() }))
}

async fn skills_upsert(Json(mut s): Json<hub::Skill>) -> Result<Json<Value>, AppError> {
    s.name = hub::valid_name(&s.name)?;
    if s.prompt.trim().is_empty() {
        return Err(bad("prompt không được rỗng"));
    }
    if s.prompt.len() > 20_000 {
        return Err(bad("prompt quá dài (tối đa 20.000 ký tự)"));
    }
    hub::update(|c| {
        c.skills.retain(|x| x.name != s.name);
        c.skills.push(s);
        c.skills.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(())
    })?;
    Ok(Json(json!({ "ok": true })))
}

async fn skills_delete(Path(name): Path<String>) -> Result<Json<Value>, AppError> {
    hub::update(|c| {
        let before = c.skills.len();
        c.skills.retain(|s| s.name != name);
        if c.skills.len() == before {
            return Err(RouterError::InvalidRequest(format!("skill '{name}' không tồn tại")));
        }
        Ok(())
    })?;
    Ok(Json(json!({ "ok": true })))
}

// ---------- system ----------

async fn system_get(State(state): State<AppState>) -> Json<Value> {
    let started = *hub::STARTED;
    let reg = state.router.registry();
    let providers = reg.provider_configs();
    let accounts = state.router.account_statuses();
    let persistence = crate::persistence::status().await;
    let c = hub::config();
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "started_at": started,
        "uptime_seconds": (chrono::Utc::now() - started).num_seconds().max(0),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "pid": std::process::id(),
        "providers": providers.len(),
        "models": reg.list_providers().len(),
        "accounts": accounts.len(),
        "combos": crate::connections::combos().len(),
        "keys": state.keystore.list().len(),
        "cache": state.cache.is_some(),
        "semantic_cache": state.semantic.is_some(),
        "persistence": persistence,
        "features": {
            "token_saver": c.token_saver.enabled,
            "vision": c.vision.enabled,
            "proxies": c.proxies.len(),
            "skills": c.skills.iter().filter(|s| s.enabled).count(),
            "quotas": c.quotas.len(),
        }
    }))
}
