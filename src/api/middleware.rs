use axum::{
    extract::{ConnectInfo, Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use std::net::SocketAddr;

use crate::api::models::KeyContext;
use crate::api::routes::AppState;

/// Enforces admin key (on /admin/*), optional Bearer-key auth with
/// per-key permissions, and per-IP + per-key rate limits.
/// `/health` is always open.
/// KeyContext is injected into request extensions for handlers.
pub async fn enforce(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    mut req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path();
    if path == "/health" {
        return next.run(req).await;
    }

    // ---- Admin auth ----
    let is_admin_path = path.starts_with("/admin");
    let is_admin = if let Some(admin_key) = &state.admin_key {
        let token = admin_token(&req);
        token.map(|t| t == *admin_key).unwrap_or(false)
    } else {
        false
    };
    if is_admin_path {
        if state.admin_key.is_some() && !is_admin {
            return unauthorized("Invalid admin key");
        }
        // Admin endpoints bypass client-key auth & rate limits
        req.extensions_mut().insert(KeyContext::anonymous());
        return next.run(req).await;
    }

    // The admin web UI proxies read-only diagnostics (e.g. /v1/models for
    // the endpoint page) through the BFF with the server-side admin key.
    // Once virtual keys exist those calls would otherwise 401 as
    // "anonymous", so a *valid* admin key also grants an anonymous
    // (full-access) KeyContext on non-admin routes. The BFF enforces
    // role rules before this header ever reaches us.
    if is_admin {
        req.extensions_mut().insert(KeyContext::anonymous());
        return next.run(req).await;
    }

    // ---- Per-IP rate limit ----
    if !state.rate_limiter.check(&format!("ip:{}", addr.ip())) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error": {"message": "Rate limit exceeded", "type": "rate_limit_error"}})),
        )
            .into_response();
    }

    // ---- Client key auth -> KeyContext ----
    let ctx: KeyContext = if state.keystore.is_enabled() {
        let token = bearer_token(&req);
        let Some(token) = token.filter(|t| !t.is_empty()) else {
            return unauthorized("Missing API key");
        };
        match state.keystore.get(&token) {
            Some(cfg) => KeyContext {
                key: cfg.key.clone(),
                label: cfg.key.clone(),
                owner: cfg.owner.clone(),
                allowed_models: cfg.allowed_models.clone(),
                // Team keys only ever route through their own team's
                // connections (intersected with any explicit key-level
                // provider allow-list). Global keys (team=None) keep whatever
                // provider list the key carries.
                allowed_providers: crate::connections::effective_providers(&cfg),
                rpm: cfg.rpm,
                monthly_budget_usd: cfg.monthly_budget_usd,
                team: cfg.team.clone(),
            },
            None => return unauthorized("Invalid API key"),
        }
    } else if let Some(legacy) = &state.api_keys {
        let token = bearer_token(&req);
        let valid = token.map(|t| legacy.contains(&t)).unwrap_or(false);
        if valid {
            KeyContext::anonymous()
        } else {
            return unauthorized("Missing or invalid API key");
        }
    } else {
        KeyContext::anonymous()
    };

    // ---- Per-key rate limit ----
    if let Some(rpm) = ctx.rpm {
        if !state.rate_limiter.check_limit(&format!("key:{}", ctx.key), rpm) {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error": {"message": "API key rate limit exceeded", "type": "rate_limit_error"}})),
            )
                .into_response();
        }
    }

    // Expose key context to handlers
    req.extensions_mut().insert(ctx);

    next.run(req).await
}

fn unauthorized(msg: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error": {"message": msg, "type": "auth_error"}})),
    )
        .into_response()
}

fn bearer_token(req: &Request) -> Option<String> {
    req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string())
}

fn admin_token(req: &Request) -> Option<String> {
    if let Some(v) = req
        .headers()
        .get("x-admin-key")
        .and_then(|v| v.to_str().ok())
    {
        return Some(v.trim().to_string());
    }
    bearer_token(&req)
}
