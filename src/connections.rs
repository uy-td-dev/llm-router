//! Runtime provider connections (9router-style catalog entries connected from
//! the dashboard). Each connection = an OpenAI/Anthropic/Gemini-compatible
//! provider definition + its account pool, an optional short model prefix
//! (e.g. `cc` → `cc/<model>`) and an enabled flag. Persisted to
//! `data/connections.json` and restored at startup; YAML providers are never
//! redefined (a connection with a YAML provider's name only adds accounts).
//!
//! Combos (named fallback chains, e.g. `coding` → [a/x, b/y]) live in
//! `data/combos.json`.

use std::collections::HashMap;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::config::{CostConfig, ModelConfig, ProviderConfig};
use crate::providers::vault::UpstreamAccount;
use crate::providers::ProviderRegistry;
use crate::utils::{Result, RouterError};

const STORE: &str = "data/connections.json";
const COMBO_STORE: &str = "data/combos.json";

static STORE_LOCK: once_cell::sync::Lazy<std::sync::Mutex<()>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(()));

/// prefix → provider name
static PREFIXES: once_cell::sync::Lazy<RwLock<HashMap<String, String>>> =
    once_cell::sync::Lazy::new(|| RwLock::new(HashMap::new()));

/// team → provider names owned by that team (enabled, non-disabled).
/// Rebuilt whenever the connections store is (re)loaded/saved. This is the
/// source of truth for team-scoped provider access on the hot request path.
static TEAM_PROVIDERS: once_cell::sync::Lazy<RwLock<HashMap<String, Vec<String>>>> =
    once_cell::sync::Lazy::new(|| RwLock::new(HashMap::new()));

static COMBOS: once_cell::sync::Lazy<RwLock<Vec<Combo>>> =
    once_cell::sync::Lazy::new(|| RwLock::new(Vec::new()));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnModel {
    pub name: String,
    #[serde(default)]
    pub input_per_1m: f64,
    #[serde(default)]
    pub output_per_1m: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnAccount {
    pub label: String,
    pub api_key: String,
    #[serde(default = "default_priority")]
    pub priority: i32,
    #[serde(default = "default_weight")]
    pub weight: u32,
    #[serde(default)]
    pub disabled: bool,
}

fn default_priority() -> i32 {
    50
}
fn default_weight() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub name: String,
    #[serde(default = "default_format")]
    pub format: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub models: Vec<ConnModel>,
    #[serde(default)]
    pub accounts: Vec<ConnAccount>,
    /// Short alias usable as `<prefix>/<model>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Disabled connections stay saved but are not routed to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    /// Team that owns this connection. Team-scoped: only keys of that team
    /// may route through it (None = global connection, admin-owned).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    /// Upsert only: keep existing accounts/settings not given in the body.
    #[serde(default, skip_serializing)]
    pub merge: bool,
}

fn default_format() -> String {
    "openai".to_string()
}

fn mask(key: &str) -> String {
    let n = key.chars().count();
    if n <= 10 {
        return "•••".to_string();
    }
    let head: String = key.chars().take(6).collect();
    let tail: String = key.chars().skip(n - 4).collect();
    format!("{head}…{tail}")
}

impl Connection {
    pub fn is_disabled(&self) -> bool {
        self.disabled.unwrap_or(false)
    }

    pub fn provider_config(&self) -> ProviderConfig {
        ProviderConfig {
            name: self.name.clone(),
            enabled: true,
            format: Some(self.format.clone()),
            headers: self.headers.clone(),
            api_key: String::new(),
            base_url: self.base_url.trim_end_matches('/').to_string(),
            models: self
                .models
                .iter()
                .map(|m| ModelConfig {
                    name: m.name.clone(),
                    cost: CostConfig {
                        input_per_1m: m.input_per_1m,
                        output_per_1m: m.output_per_1m,
                    },
                    kind: None,
                })
                .collect(),
            accounts: vec![],
            timeout_ms: 120_000,
            max_retries: 1,
        }
    }

    fn pool(&self) -> Vec<UpstreamAccount> {
        self.accounts
            .iter()
            .filter(|a| !a.disabled && !a.api_key.trim().is_empty() && !a.label.trim().is_empty())
            .map(|a| UpstreamAccount {
                label: a.label.trim().to_string(),
                api_key: a.api_key.trim().to_string(),
                priority: a.priority,
                weight: a.weight.max(1),
            })
            .collect()
    }

    /// Public view (no secrets).
    pub fn summary(&self, yaml: bool) -> serde_json::Value {
        serde_json::json!({
            "name": self.name,
            "display_name": self.display_name,
            "format": self.format,
            "base_url": self.base_url,
            "prefix": self.prefix,
            "team": self.team,
            "disabled": self.is_disabled(),
            "models": self.models.iter().map(|m| m.name.clone()).collect::<Vec<_>>(),
            "accounts": self.accounts.iter().map(|a| serde_json::json!({
                "label": a.label,
                "priority": a.priority,
                "weight": a.weight,
                "disabled": a.disabled,
                "key": mask(&a.api_key),
            })).collect::<Vec<_>>(),
            "yaml": yaml,
        })
    }
}

fn load_store() -> Vec<Connection> {
    std::fs::read_to_string(STORE)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(path: &str, value: &T) -> Result<()> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    std::fs::create_dir_all("data").map_err(|e| RouterError::Internal(e.to_string()))?;
    let tmp = format!("{path}.tmp");
    let text = serde_json::to_string_pretty(value).map_err(|e| RouterError::Internal(e.to_string()))?;
    std::fs::write(&tmp, text).map_err(|e| RouterError::Internal(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| RouterError::Internal(e.to_string()))
}

fn save_store(all: &[Connection]) -> Result<()> {
    write_json(STORE, &all)?;
    rebuild_prefixes(all);
    rebuild_teams(all);
    Ok(())
}

fn rebuild_prefixes(all: &[Connection]) {
    let mut map = PREFIXES.write().unwrap_or_else(|p| p.into_inner());
    map.clear();
    for c in all.iter().filter(|c| !c.is_disabled()) {
        if let Some(p) = c.prefix.as_deref().filter(|p| !p.is_empty()) {
            map.insert(p.to_string(), c.name.clone());
        }
    }
}

fn rebuild_teams(all: &[Connection]) {
    let mut map = TEAM_PROVIDERS.write().unwrap_or_else(|p| p.into_inner());
    map.clear();
    for c in all.iter().filter(|c| !c.is_disabled()) {
        if let Some(team) = c.team.as_deref().filter(|t| !t.is_empty()) {
            map.entry(team.to_string())
                .or_default()
                .push(c.name.clone());
        }
    }
    for names in map.values_mut() {
        names.sort();
    }
}

/// Provider names a team may route through. Empty when the team has no
/// connections yet (its keys then cannot reach any provider).
pub fn team_providers(team: &str) -> Vec<String> {
    TEAM_PROVIDERS
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .get(team)
        .cloned()
        .unwrap_or_default()
}

/// Effective provider allow-list for a virtual key: for team keys this is the
/// team's providers, optionally narrowed further by the key's own list.
pub fn effective_providers(cfg: &crate::config::KeyConfig) -> Option<Vec<String>> {
    let Some(team) = cfg.team.as_deref().filter(|t| !t.is_empty()) else {
        return cfg.allowed_providers.clone();
    };
    let team_names = team_providers(team);
    match &cfg.allowed_providers {
        // No key-level restriction: the team's connections are the authority.
        // A team with no connections therefore routes nowhere (fail closed),
        // rather than silently falling back to every global provider.
        None => Some(team_names),
        // Explicit list: intersect with the team's own connections. An empty
        // list means "no provider" and must stay empty.
        Some(list) => Some(
            list.iter()
                .filter(|p| team_names.iter().any(|n| n == *p))
                .cloned()
                .collect(),
        ),
    }
}

/// Resolve a model prefix (connection alias or provider name) to a provider.
pub fn resolve_prefix(prefix: &str) -> Option<String> {
    PREFIXES
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .get(prefix)
        .cloned()
}

/// All `(prefix, provider)` aliases.
pub fn prefixes() -> Vec<(String, String)> {
    PREFIXES
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .map(|(a, b)| (a.clone(), b.clone()))
        .collect()
}

fn apply(registry: &ProviderRegistry, conn: &Connection) -> Result<()> {
    if registry.is_yaml(&conn.name) {
        // YAML provider: keep its own accounts, connection accounts on top
        let mut pool = registry.yaml_pool(&conn.name);
        pool.retain(|a| !a.api_key.is_empty());
        if !conn.is_disabled() {
            pool.extend(conn.pool());
        }
        registry.replace_accounts(&conn.name, pool);
        return Ok(());
    }
    if conn.is_disabled() {
        registry.remove_provider(&conn.name);
        return Ok(());
    }
    registry.upsert_provider(conn.provider_config())?;
    registry.replace_accounts(&conn.name, conn.pool());
    Ok(())
}

/// Restore persisted connections + combos at startup.
pub fn restore(registry: &ProviderRegistry) {
    let all = load_store();
    for conn in &all {
        match apply(registry, conn) {
            Ok(()) => tracing::info!(provider = %conn.name, accounts = conn.accounts.len(), "Connection restored"),
            Err(e) => tracing::warn!(provider = %conn.name, error = %e, "Connection restore failed"),
        }
    }
    rebuild_prefixes(&all);
    rebuild_teams(&all);
    let combos: Vec<Combo> = std::fs::read_to_string(COMBO_STORE)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    *COMBOS.write().unwrap_or_else(|p| p.into_inner()) = combos;
}

pub fn list(registry: &ProviderRegistry) -> Vec<serde_json::Value> {
    load_store()
        .iter()
        .map(|c| c.summary(registry.is_yaml(&c.name)))
        .collect()
}

fn valid_prefix(p: &str) -> bool {
    (1..=20).contains(&p.len())
        && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn upsert(registry: &ProviderRegistry, mut conn: Connection) -> Result<()> {
    let mut all = load_store();
    if conn.merge {
        if let Some(old) = all.iter().find(|c| c.name == conn.name) {
            // Existing labels keep their settings; only the credential is updated
            let mut accounts: Vec<ConnAccount> = old.accounts.clone();
            for new in conn.accounts.drain(..) {
                match accounts.iter_mut().find(|a| a.label == new.label) {
                    Some(a) => a.api_key = new.api_key,
                    None => accounts.push(new),
                }
            }
            conn.accounts = accounts;
            if conn.models.is_empty() {
                conn.models = old.models.clone();
            }
            if conn.headers.is_empty() {
                conn.headers = old.headers.clone();
            }
            if conn.base_url.is_empty() {
                conn.base_url = old.base_url.clone();
            }
            conn.prefix = conn.prefix.or_else(|| old.prefix.clone());
            conn.display_name = conn.display_name.or_else(|| old.display_name.clone());
            conn.disabled = conn.disabled.or(old.disabled);
            conn.team = conn.team.or_else(|| old.team.clone());
        }
    }
    conn.prefix = conn.prefix.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(p) = &conn.prefix {
        if !valid_prefix(p) {
            return Err(RouterError::InvalidRequest(format!("prefix '{p}' không hợp lệ (a-z, 0-9, '-')")));
        }
        if p != &conn.name && registry.get(p).is_some() {
            return Err(RouterError::InvalidRequest(format!("prefix '{p}' trùng tên một provider khác")));
        }
        if all.iter().any(|c| c.name != conn.name && c.prefix.as_deref() == Some(p.as_str())) {
            return Err(RouterError::InvalidRequest(format!("prefix '{p}' đã được dùng")));
        }
    }
    if !registry.is_yaml(&conn.name) {
        if conn.models.is_empty() {
            return Err(RouterError::InvalidRequest(format!(
                "connection '{}' cần ít nhất 1 model",
                conn.name
            )));
        }
        if conn.base_url.is_empty() {
            return Err(RouterError::InvalidRequest("cần base_url".to_string()));
        }
    }
    apply(registry, &conn)?;
    all.retain(|c| c.name != conn.name);
    all.push(conn);
    save_store(&all)
}

#[derive(Debug, Deserialize)]
pub struct AccountPatch {
    pub priority: Option<i32>,
    pub weight: Option<u32>,
    pub disabled: Option<bool>,
    pub api_key: Option<String>,
}

/// Edit one account's routing settings / credential.
pub fn update_account(registry: &ProviderRegistry, name: &str, label: &str, patch: AccountPatch) -> Result<()> {
    let mut all = load_store();
    let Some(conn) = all.iter_mut().find(|c| c.name == name) else {
        return Err(RouterError::InvalidRequest(format!("connection '{name}' không tồn tại")));
    };
    let Some(acc) = conn.accounts.iter_mut().find(|a| a.label == label) else {
        return Err(RouterError::InvalidRequest(format!("account '{label}' không tồn tại")));
    };
    if let Some(p) = patch.priority {
        acc.priority = p;
    }
    if let Some(w) = patch.weight {
        acc.weight = w.max(1);
    }
    if let Some(d) = patch.disabled {
        acc.disabled = d;
    }
    if let Some(k) = patch.api_key.filter(|k| !k.trim().is_empty()) {
        acc.api_key = k.trim().to_string();
    }
    let conn = conn.clone();
    apply(registry, &conn)?;
    save_store(&all)
}

/// Raw credential of a stored account (first enabled when `label` is None).
pub fn stored_key(name: &str, label: Option<&str>) -> Option<String> {
    load_store()
        .into_iter()
        .find(|c| c.name == name)?
        .accounts
        .into_iter()
        .find(|a| match label {
            Some(l) => a.label == l,
            None => !a.disabled,
        })
        .map(|a| a.api_key)
}

pub fn get(name: &str) -> Option<Connection> {
    load_store().into_iter().find(|c| c.name == name)
}

/// Remove one account; the connection is dropped when it was the last one.
pub fn remove_account(registry: &ProviderRegistry, name: &str, label: &str) -> Result<()> {
    let mut all = load_store();
    let Some(conn) = all.iter_mut().find(|c| c.name == name) else {
        return Err(RouterError::InvalidRequest(format!("connection '{name}' không tồn tại")));
    };
    let before = conn.accounts.len();
    conn.accounts.retain(|a| a.label != label);
    if conn.accounts.len() == before {
        return Err(RouterError::InvalidRequest(format!("account '{label}' không tồn tại")));
    }
    if conn.accounts.is_empty() {
        return remove(registry, name);
    }
    let conn = conn.clone();
    apply(registry, &conn)?;
    save_store(&all)
}

pub fn remove(registry: &ProviderRegistry, name: &str) -> Result<()> {
    let mut all = load_store();
    let before = all.len();
    all.retain(|c| c.name != name);
    if all.len() == before {
        return Err(RouterError::InvalidRequest(format!("connection '{name}' không tồn tại")));
    }
    if registry.is_yaml(name) {
        registry.replace_accounts(name, registry.yaml_pool(name));
    } else {
        registry.remove_provider(name);
    }
    save_store(&all)
}

/// Query the upstream model list (OpenAI `/models`, Anthropic `/models`,
/// Gemini `/models`).
pub async fn fetch_models(
    format: &str,
    base_url: &str,
    headers: &HashMap<String, String>,
    api_key: &str,
) -> Result<Vec<String>> {
    let base = base_url.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| RouterError::Internal(e.to_string()))?;
    let mut req = client.get(format!("{base}/models"));
    req = match format {
        "anthropic" => req
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        "google" => req.header("x-goog-api-key", api_key).query(&[("pageSize", "1000")]),
        _ => req.bearer_auth(api_key),
    };
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req.send().await.map_err(|e| RouterError::Provider(e.to_string()))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| RouterError::Provider(format!("HTTP {status}: {e}")))?;
    if !status.is_success() {
        return Err(RouterError::Provider(format!(
            "HTTP {status}: {}",
            body.to_string().chars().take(300).collect::<String>()
        )));
    }
    let mut out: Vec<String> = if format == "google" {
        body["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| {
                m["supportedGenerationMethods"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|x| x == "generateContent"))
            })
            .filter_map(|m| m["name"].as_str())
            .map(|n| n.trim_start_matches("models/").to_string())
            .collect()
    } else {
        body["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m["id"].as_str().map(str::to_string))
            .collect()
    };
    out.sort();
    out.dedup();
    Ok(out)
}

// ============================ Combos ============================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Combo {
    pub name: String,
    /// Ordered `provider/model` (or `prefix/model`) entries, tried in order.
    pub models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

pub fn combos() -> Vec<Combo> {
    COMBOS.read().unwrap_or_else(|p| p.into_inner()).clone()
}

pub fn combo(name: &str) -> Option<Combo> {
    combos().into_iter().find(|c| c.name == name)
}

pub fn upsert_combo(registry: &ProviderRegistry, combo: Combo) -> Result<()> {
    let name = combo.name.trim();
    if name.is_empty() || name.len() > 60 || name.contains('/') || name.contains(char::is_whitespace) {
        return Err(RouterError::InvalidRequest(
            "tên combo không hợp lệ (không khoảng trắng, không '/')".to_string(),
        ));
    }
    if combo.models.is_empty() {
        return Err(RouterError::InvalidRequest("combo cần ít nhất 1 model".to_string()));
    }
    if registry.list_providers().iter().any(|p| p.model == name) {
        return Err(RouterError::InvalidRequest(format!("'{name}' trùng tên một model")));
    }
    for m in &combo.models {
        if m.split_once('/').is_none() {
            return Err(RouterError::InvalidRequest(format!("'{m}' phải có dạng provider/model")));
        }
    }
    let mut all = combos();
    all.retain(|c| c.name != name);
    all.push(Combo { name: name.to_string(), ..combo });
    all.sort_by(|a, b| a.name.cmp(&b.name));
    write_json(COMBO_STORE, &all)?;
    *COMBOS.write().unwrap_or_else(|p| p.into_inner()) = all;
    Ok(())
}

pub fn remove_combo(name: &str) -> Result<()> {
    let mut all = combos();
    let before = all.len();
    all.retain(|c| c.name != name);
    if all.len() == before {
        return Err(RouterError::InvalidRequest(format!("combo '{name}' không tồn tại")));
    }
    write_json(COMBO_STORE, &all)?;
    *COMBOS.write().unwrap_or_else(|p| p.into_inner()) = all;
    Ok(())
}
