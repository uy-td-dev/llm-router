//! 9router-style hub features layered on top of the router core:
//! - Console Log: in-memory ring buffer fed by a tracing layer
//! - Request log + hourly usage series (Usage page)
//! - Quota Tracker: per upstream account daily/monthly limits (enforced in rotation)
//! - Token Saver: request compaction before routing
//! - Vision Adapter: images → text description for non-vision models
//! - Proxy Pools: per-provider outbound HTTP/SOCKS proxies
//! - Skills: reusable system prompts (auto or `/skill` trigger)
//!
//! Settings persist in `data/hub.json`; counters are in-memory.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Mutex, RwLock};

use chrono::{DateTime, Datelike, Timelike, Utc};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use crate::api::models::{ChatCompletionRequest, KeyContext, Message, MessageContent};
use crate::tracking::usage::UsageRecord;
use crate::utils::{Result, RouterError};

const STORE: &str = "data/hub.json";
const LOG_CAP: usize = 2000;
const REQ_CAP: usize = 5000;
const SERIES_HOURS: i64 = 24 * 7;

pub static STARTED: Lazy<DateTime<Utc>> = Lazy::new(Utc::now);

// ============================ Settings ============================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TokenSaver {
    pub enabled: bool,
    /// Keep only the last N non-system messages (0 = unlimited).
    pub max_history: usize,
    /// Truncate older messages above N chars (0 = off). Last user message is never cut.
    pub max_message_chars: usize,
    /// Collapse blank lines / trailing spaces.
    pub trim_whitespace: bool,
    /// Drop consecutive duplicated messages.
    pub dedupe: bool,
}

impl Default for TokenSaver {
    fn default() -> Self {
        Self {
            enabled: false,
            max_history: 40,
            max_message_chars: 8000,
            trim_whitespace: true,
            dedupe: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct VisionAdapter {
    pub enabled: bool,
    /// `provider/model` (or combo / prefix form) used to describe images.
    pub vision_model: String,
    /// Glob patterns of models that accept images natively.
    pub native_models: Vec<String>,
    pub prompt: String,
}

impl Default for VisionAdapter {
    fn default() -> Self {
        Self {
            enabled: false,
            vision_model: String::new(),
            native_models: vec![
                "*gpt-4o*".into(),
                "*gpt-4.1*".into(),
                "*gpt-5*".into(),
                "*claude*".into(),
                "*gemini*".into(),
                "*vision*".into(),
                "*-vl*".into(),
            ],
            prompt: "Mô tả chi tiết nội dung ảnh này (văn bản, bố cục, số liệu) để một mô hình chỉ đọc chữ có thể hiểu.".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Quota {
    pub requests_per_day: Option<u64>,
    pub tokens_per_day: Option<u64>,
    pub usd_per_month: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyEntry {
    pub name: String,
    /// http://, https://, socks5:// (user:pass@host:port allowed)
    pub url: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub prompt: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Inject into every request (otherwise only via `/name` at message start).
    #[serde(default)]
    pub auto: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HubConfig {
    pub token_saver: TokenSaver,
    pub vision: VisionAdapter,
    pub proxies: Vec<ProxyEntry>,
    /// provider name → proxy name
    pub provider_proxy: HashMap<String, String>,
    /// "provider/label" → limits
    pub quotas: HashMap<String, Quota>,
    pub skills: Vec<Skill>,
}

static CONFIG: Lazy<RwLock<HubConfig>> = Lazy::new(|| {
    let cfg = std::fs::read_to_string(STORE)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    RwLock::new(cfg)
});

pub fn config() -> HubConfig {
    CONFIG.read().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Mutate + persist atomically.
pub fn update<F: FnOnce(&mut HubConfig) -> Result<()>>(f: F) -> Result<HubConfig> {
    let mut guard = CONFIG.write().unwrap_or_else(|p| p.into_inner());
    let mut next = guard.clone();
    f(&mut next)?;
    std::fs::create_dir_all("data").map_err(|e| RouterError::Internal(e.to_string()))?;
    let text = serde_json::to_string_pretty(&next).map_err(|e| RouterError::Internal(e.to_string()))?;
    let tmp = format!("{STORE}.tmp");
    std::fs::write(&tmp, text).map_err(|e| RouterError::Internal(e.to_string()))?;
    std::fs::rename(&tmp, STORE).map_err(|e| RouterError::Internal(e.to_string()))?;
    *guard = next.clone();
    drop(guard);
    PROXY_CLIENTS.lock().unwrap_or_else(|p| p.into_inner()).clear();
    Ok(next)
}

pub fn init() {
    Lazy::force(&STARTED);
    let cfg = config();
    tracing::info!(
        proxies = cfg.proxies.len(),
        skills = cfg.skills.len(),
        quotas = cfg.quotas.len(),
        token_saver = cfg.token_saver.enabled,
        vision = cfg.vision.enabled,
        "Hub settings loaded"
    );
}

pub fn valid_name(name: &str) -> Result<String> {
    let n = name.trim();
    if n.is_empty() || n.len() > 40 || !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(RouterError::InvalidRequest(
            "tên chỉ gồm a-z, 0-9, '-', '_' (tối đa 40 ký tự)".into(),
        ));
    }
    Ok(n.to_string())
}

// ============================ Console log ============================

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub id: u64,
    pub ts: DateTime<Utc>,
    pub level: String,
    pub target: String,
    pub message: String,
}

static LOGS: Lazy<Mutex<(u64, VecDeque<LogLine>)>> =
    Lazy::new(|| Mutex::new((0, VecDeque::with_capacity(LOG_CAP))));

fn push_log(level: &str, target: &str, message: String) {
    let mut g = LOGS.lock().unwrap_or_else(|p| p.into_inner());
    g.0 += 1;
    let id = g.0;
    if g.1.len() >= LOG_CAP {
        g.1.pop_front();
    }
    g.1.push_back(LogLine {
        id,
        ts: Utc::now(),
        level: level.to_string(),
        target: target.to_string(),
        message,
    });
}

pub fn logs(after: u64, limit: usize) -> (u64, Vec<LogLine>) {
    let g = LOGS.lock().unwrap_or_else(|p| p.into_inner());
    let lines: Vec<LogLine> = g.1.iter().filter(|l| l.id > after).cloned().collect();
    let skip = lines.len().saturating_sub(limit);
    (g.0, lines.into_iter().skip(skip).collect())
}

pub fn clear_logs() {
    LOGS.lock().unwrap_or_else(|p| p.into_inner()).1.clear();
}

/// tracing layer copying events into the console ring buffer.
pub struct LogLayer;

struct Visitor {
    message: String,
    fields: Vec<String>,
}

impl tracing::field::Visit for Visitor {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.fields.push(format!("{}={}", field.name(), value));
        }
    }
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
        } else {
            self.fields.push(format!("{}={:?}", field.name(), value));
        }
    }
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for LogLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>) {
        let meta = event.metadata();
        if *meta.level() > tracing::Level::INFO || !meta.target().starts_with("llm_router") {
            return;
        }
        let mut v = Visitor { message: String::new(), fields: vec![] };
        event.record(&mut v);
        let mut msg = v.message;
        if !v.fields.is_empty() {
            msg.push_str("  ");
            msg.push_str(&v.fields.join(" "));
        }
        let target = meta.target().trim_start_matches("llm_router::");
        push_log(meta.level().as_str(), target, msg);
    }
}

// ============================ Request log / usage ============================

#[derive(Debug, Clone, Serialize)]
pub struct RequestLine {
    pub id: u64,
    pub ts: DateTime<Utc>,
    pub key: String,
    pub owner: String,
    /// Team of the key at request time (None for global/anonymous keys)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    pub requested_model: String,
    pub provider: String,
    pub model: String,
    pub account: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub cost_usd: f64,
    pub latency_ms: u128,
    /// ok | error | cache
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct HourAgg {
    pub hour: i64,
    pub requests: u64,
    pub errors: u64,
    pub cache_hits: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cost_usd: f64,
    pub saved_tokens: u64,
}

#[derive(Default)]
struct Usage {
    next_id: u64,
    requests: VecDeque<RequestLine>,
    hours: BTreeMap<i64, HourAgg>,
    /// (provider, label) → (day, requests, tokens)
    daily: HashMap<(String, String), (String, u64, u64)>,
    /// (provider, label) → (month, usd)
    monthly: HashMap<(String, String), (String, f64)>,
    saved_tokens_total: u64,
    saver_runs: u64,
    vision_runs: u64,
    skill_runs: u64,
}

static USAGE: Lazy<Mutex<Usage>> = Lazy::new(|| Mutex::new(Usage::default()));

fn hour_bucket(ts: DateTime<Utc>) -> i64 {
    ts.timestamp() - ts.timestamp().rem_euclid(3600)
}

fn day_key(ts: DateTime<Utc>) -> String {
    ts.format("%Y-%m-%d").to_string()
}

fn month_key(ts: DateTime<Utc>) -> String {
    format!("{:04}-{:02}", ts.year(), ts.month())
}

fn with_hour<F: FnOnce(&mut HourAgg)>(u: &mut Usage, ts: DateTime<Utc>, f: F) {
    let h = hour_bucket(ts);
    f(u.hours.entry(h).or_insert_with(|| HourAgg { hour: h, ..Default::default() }));
    let cutoff = h - SERIES_HOURS * 3600;
    while let Some((&first, _)) = u.hours.iter().next() {
        if first >= cutoff {
            break;
        }
        u.hours.remove(&first);
    }
}

fn push_request(u: &mut Usage, mut line: RequestLine) {
    u.next_id += 1;
    line.id = u.next_id;
    if u.requests.len() >= REQ_CAP {
        u.requests.pop_front();
    }
    u.requests.push_back(line);
}

/// Called for every successful upstream completion (tracking::usage::record).
pub fn on_usage(r: &UsageRecord) {
    let mut u = USAGE.lock().unwrap_or_else(|p| p.into_inner());
    let ts = r.timestamp;
    with_hour(&mut u, ts, |h| {
        h.requests += 1;
        h.prompt_tokens += r.prompt_tokens as u64;
        h.completion_tokens += r.completion_tokens as u64;
        h.cost_usd += r.cost_usd;
    });
    let key = (r.provider.clone(), r.upstream_account.clone());
    let day = day_key(ts);
    let d = u.daily.entry(key.clone()).or_insert_with(|| (day.clone(), 0, 0));
    if d.0 != day {
        *d = (day, 0, 0);
    }
    d.1 += 1;
    d.2 += r.total_tokens as u64;
    let month = month_key(ts);
    let m = u.monthly.entry(key).or_insert_with(|| (month.clone(), 0.0));
    if m.0 != month {
        *m = (month, 0.0);
    }
    m.1 += r.cost_usd;
    push_request(
        &mut u,
        RequestLine {
            id: 0,
            ts,
            key: r.api_key.clone(),
            owner: r.owner.clone(),
            team: r.team.clone(),
            requested_model: r.requested_model.clone(),
            provider: r.provider.clone(),
            model: r.model.clone(),
            account: r.upstream_account.clone(),
            prompt_tokens: r.prompt_tokens,
            completion_tokens: r.completion_tokens,
            cost_usd: r.cost_usd,
            latency_ms: r.latency_ms,
            status: "ok".into(),
            error: None,
        },
    );
}

pub fn log_error(ctx: &KeyContext, model: &str, error: &str) {
    let mut u = USAGE.lock().unwrap_or_else(|p| p.into_inner());
    let ts = Utc::now();
    with_hour(&mut u, ts, |h| h.errors += 1);
    push_request(
        &mut u,
        RequestLine {
            id: 0,
            ts,
            key: ctx.label.clone(),
            owner: ctx.owner.clone(),
            team: ctx.team.clone(),
            requested_model: model.to_string(),
            provider: String::new(),
            model: String::new(),
            account: String::new(),
            prompt_tokens: 0,
            completion_tokens: 0,
            cost_usd: 0.0,
            latency_ms: 0,
            status: "error".into(),
            error: Some(error.chars().take(400).collect()),
        },
    );
}

pub fn log_cache(ctx: &KeyContext, model: &str) {
    let mut u = USAGE.lock().unwrap_or_else(|p| p.into_inner());
    let ts = Utc::now();
    with_hour(&mut u, ts, |h| h.cache_hits += 1);
    push_request(
        &mut u,
        RequestLine {
            id: 0,
            ts,
            key: ctx.label.clone(),
            owner: ctx.owner.clone(),
            team: ctx.team.clone(),
            requested_model: model.to_string(),
            provider: "cache".into(),
            model: model.to_string(),
            account: String::new(),
            prompt_tokens: 0,
            completion_tokens: 0,
            cost_usd: 0.0,
            latency_ms: 0,
            status: "cache".into(),
            error: None,
        },
    );
}

pub fn requests(limit: usize, status: Option<&str>) -> Vec<RequestLine> {
    let u = USAGE.lock().unwrap_or_else(|p| p.into_inner());
    u.requests
        .iter()
        .rev()
        .filter(|r| status.map_or(true, |s| r.status == s))
        .take(limit)
        .cloned()
        .collect()
}

#[derive(Serialize, Default, Clone)]
pub struct Group {
    pub name: String,
    pub requests: u64,
    pub errors: u64,
    pub tokens: u64,
    pub cost_usd: f64,
    pub avg_latency_ms: f64,
}

fn group_by<F: Fn(&RequestLine) -> String>(rows: &[&RequestLine], f: F) -> Vec<Group> {
    let mut map: HashMap<String, (Group, u128)> = HashMap::new();
    for r in rows {
        let name = f(r);
        if name.is_empty() {
            continue;
        }
        let e = map.entry(name.clone()).or_insert_with(|| (Group { name, ..Default::default() }, 0));
        e.0.requests += 1;
        if r.status == "error" {
            e.0.errors += 1;
        }
        e.0.tokens += (r.prompt_tokens + r.completion_tokens) as u64;
        e.0.cost_usd += r.cost_usd;
        e.1 += r.latency_ms;
    }
    let mut out: Vec<Group> = map
        .into_values()
        .map(|(mut g, lat)| {
            let ok = g.requests - g.errors;
            g.avg_latency_ms = if ok > 0 { lat as f64 / ok as f64 } else { 0.0 };
            g
        })
        .collect();
    out.sort_by(|a, b| b.requests.cmp(&a.requests));
    out
}

pub fn usage_report(hours: i64) -> serde_json::Value {
    let hours = hours.clamp(1, SERIES_HOURS);
    let u = USAGE.lock().unwrap_or_else(|p| p.into_inner());
    let now = hour_bucket(Utc::now());
    let series: Vec<HourAgg> = (0..hours)
        .rev()
        .map(|i| {
            let h = now - i * 3600;
            u.hours.get(&h).cloned().unwrap_or(HourAgg { hour: h, ..Default::default() })
        })
        .collect();
    let since = Utc::now() - chrono::Duration::hours(hours);
    let rows: Vec<&RequestLine> = u.requests.iter().filter(|r| r.ts >= since).collect();
    let mut totals = HourAgg::default();
    for h in &series {
        totals.requests += h.requests;
        totals.errors += h.errors;
        totals.cache_hits += h.cache_hits;
        totals.prompt_tokens += h.prompt_tokens;
        totals.completion_tokens += h.completion_tokens;
        totals.cost_usd += h.cost_usd;
        totals.saved_tokens += h.saved_tokens;
    }
    serde_json::json!({
        "hours": hours,
        "series": series,
        "totals": totals,
        "by_provider": group_by(&rows, |r| r.provider.clone()),
        "by_model": group_by(&rows, |r| if r.provider.is_empty() { String::new() } else { format!("{}/{}", r.provider, r.model) }),
        "by_account": group_by(&rows, |r| if r.account.is_empty() { String::new() } else { format!("{}/{}", r.provider, r.account) }),
        "by_key": group_by(&rows, |r| r.key.clone()),
        "by_owner": group_by(&rows, |r| r.owner.clone()),
        "by_team": group_by(&rows, |r| r.team.clone().unwrap_or_default()),
    })
}

/// Dashboard scope for team/user-restricted views. `None` fields are
/// unrestricted; an inactive scope (everything `None`) means "all data".
#[derive(Default, Clone)]
pub struct Scope {
    /// Restrict to records charged to one owner username.
    pub owner: Option<String>,
    /// Restrict to these key labels (e.g. all keys of one team).
    pub keys: Option<std::collections::HashSet<String>>,
    /// Restrict to records whose key belonged to this team at request time.
    /// Preferred over `keys` for teams: survives key rotation/deletion.
    pub team: Option<String>,
}

impl Scope {
    fn active(&self) -> bool {
        self.owner.is_some() || self.keys.is_some() || self.team.is_some()
    }

    fn matches(&self, r: &RequestLine) -> bool {
        if let Some(owner) = &self.owner {
            if &r.owner != owner {
                return false;
            }
        }
        if let Some(team) = &self.team {
            if r.team.as_deref() != Some(team.as_str()) {
                return false;
            }
        }
        if let Some(keys) = &self.keys {
            if !keys.contains(&r.key) {
                return false;
            }
        }
        true
    }
}

/// Scoped usage report for team-lead / member dashboards. Hour buckets are
/// not owner-dimensioned, so a scoped report is recomputed from the request
/// ring (last REQ_CAP requests) instead of the global hour series.
pub fn usage_report_scoped(hours: i64, scope: &Scope) -> serde_json::Value {
    if !scope.active() {
        return usage_report(hours);
    }
    let hours = hours.clamp(1, SERIES_HOURS);
    let u = USAGE.lock().unwrap_or_else(|p| p.into_inner());
    let now = hour_bucket(Utc::now());
    let since = Utc::now() - chrono::Duration::hours(hours);
    let rows: Vec<&RequestLine> = u
        .requests
        .iter()
        .filter(|r| r.ts >= since && scope.matches(r))
        .collect();
    let mut buckets: BTreeMap<i64, HourAgg> = BTreeMap::new();
    for r in &rows {
        let h = hour_bucket(r.ts);
        let agg = buckets.entry(h).or_insert_with(|| HourAgg { hour: h, ..Default::default() });
        agg.requests += 1;
        match r.status.as_str() {
            "error" => agg.errors += 1,
            "cache" => agg.cache_hits += 1,
            _ => {}
        }
        agg.prompt_tokens += r.prompt_tokens as u64;
        agg.completion_tokens += r.completion_tokens as u64;
        agg.cost_usd += r.cost_usd;
    }
    let series: Vec<HourAgg> = (0..hours)
        .rev()
        .map(|i| {
            let h = now - i * 3600;
            buckets.get(&h).cloned().unwrap_or(HourAgg { hour: h, ..Default::default() })
        })
        .collect();
    let mut totals = HourAgg::default();
    for h in &series {
        totals.requests += h.requests;
        totals.errors += h.errors;
        totals.cache_hits += h.cache_hits;
        totals.prompt_tokens += h.prompt_tokens;
        totals.completion_tokens += h.completion_tokens;
        totals.cost_usd += h.cost_usd;
        totals.saved_tokens += h.saved_tokens;
    }
    serde_json::json!({
        "hours": hours,
        "series": series,
        "totals": totals,
        "by_provider": group_by(&rows, |r| r.provider.clone()),
        "by_model": group_by(&rows, |r| if r.provider.is_empty() { String::new() } else { format!("{}/{}", r.provider, r.model) }),
        "by_account": group_by(&rows, |r| if r.account.is_empty() { String::new() } else { format!("{}/{}", r.provider, r.account) }),
        "by_key": group_by(&rows, |r| r.key.clone()),
        "by_owner": group_by(&rows, |r| r.owner.clone()),
        "by_team": group_by(&rows, |r| r.team.clone().unwrap_or_default()),
        "scoped": true,
    })
}

/// Scoped request log: newest first, filtered by the given scope.
pub fn requests_scoped(limit: usize, status: Option<&str>, scope: &Scope) -> Vec<RequestLine> {
    if !scope.active() {
        return requests(limit, status);
    }
    let u = USAGE.lock().unwrap_or_else(|p| p.into_inner());
    u.requests
        .iter()
        .rev()
        .filter(|r| scope.matches(r) && status.map_or(true, |s| r.status == s))
        .take(limit)
        .cloned()
        .collect()
}

// ============================ Quota tracker ============================

/// False when the account exhausted one of its limits (skipped in rotation).
pub fn quota_ok(provider: &str, label: &str) -> bool {
    let cfg = CONFIG.read().unwrap_or_else(|p| p.into_inner());
    let Some(q) = cfg.quotas.get(&format!("{provider}/{label}")) else {
        return true;
    };
    let q = q.clone();
    drop(cfg);
    let (req, tok, usd) = account_usage(provider, label);
    !(q.requests_per_day.is_some_and(|l| req >= l)
        || q.tokens_per_day.is_some_and(|l| tok >= l)
        || q.usd_per_month.is_some_and(|l| usd >= l))
}

/// (requests today, tokens today, usd this month)
pub fn account_usage(provider: &str, label: &str) -> (u64, u64, f64) {
    let u = USAGE.lock().unwrap_or_else(|p| p.into_inner());
    let key = (provider.to_string(), label.to_string());
    let now = Utc::now();
    let (req, tok) = match u.daily.get(&key) {
        Some((d, r, t)) if *d == day_key(now) => (*r, *t),
        _ => (0, 0),
    };
    let usd = match u.monthly.get(&key) {
        Some((m, c)) if *m == month_key(now) => *c,
        _ => 0.0,
    };
    (req, tok, usd)
}

/// Seconds until the daily counters reset (UTC midnight).
pub fn reset_in_secs() -> i64 {
    let now = Utc::now();
    86_400 - (now.num_seconds_from_midnight() as i64)
}

// ============================ Token saver ============================

fn est_tokens(chars: usize) -> u64 {
    (chars as u64).div_ceil(4)
}

fn total_chars(msgs: &[Message]) -> usize {
    msgs.iter().map(|m| m.content.len()).sum()
}

fn trim_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank = 0;
    for line in s.lines() {
        let l = line.trim_end();
        if l.is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        out.push_str(l);
        out.push('\n');
    }
    out.trim_end().to_string()
}

/// Apply token saver rules (counted in stats); returns estimated saved tokens.
pub fn save_tokens(cfg: &TokenSaver, req: &mut ChatCompletionRequest) -> u64 {
    if !cfg.enabled {
        return 0;
    }
    let saved = compact(cfg, req);
    let mut u = USAGE.lock().unwrap_or_else(|p| p.into_inner());
    u.saver_runs += 1;
    u.saved_tokens_total += saved;
    with_hour(&mut u, Utc::now(), |h| h.saved_tokens += saved);
    saved
}

/// Pure compaction (used by preview too). Returns estimated saved tokens.
pub fn compact(cfg: &TokenSaver, req: &mut ChatCompletionRequest) -> u64 {
    let before = total_chars(&req.messages);

    if cfg.trim_whitespace {
        for m in &mut req.messages {
            if let MessageContent::Text(t) = &m.content {
                m.content = MessageContent::Text(trim_text(t));
            }
        }
    }

    if cfg.dedupe {
        let mut out: Vec<Message> = Vec::with_capacity(req.messages.len());
        for m in req.messages.drain(..) {
            let dup = out.last().is_some_and(|p: &Message| {
                p.role == m.role
                    && matches!((&p.content, &m.content), (MessageContent::Text(a), MessageContent::Text(b)) if a == b)
            });
            if !dup {
                out.push(m);
            }
        }
        req.messages = out;
    }

    if cfg.max_history > 0 {
        let non_system: Vec<usize> = req
            .messages
            .iter()
            .enumerate()
            .filter(|(_, m)| m.role != "system")
            .map(|(i, _)| i)
            .collect();
        if non_system.len() > cfg.max_history {
            let cut: std::collections::HashSet<usize> =
                non_system[..non_system.len() - cfg.max_history].iter().copied().collect();
            let mut i = 0;
            req.messages.retain(|_| {
                let keep = !cut.contains(&i);
                i += 1;
                keep
            });
        }
    }

    if cfg.max_message_chars > 0 {
        let last_user = req.messages.iter().rposition(|m| m.role == "user");
        for (i, m) in req.messages.iter_mut().enumerate() {
            if Some(i) == last_user || m.role == "system" {
                continue;
            }
            if let MessageContent::Text(t) = &m.content {
                if t.chars().count() > cfg.max_message_chars {
                    let head: String = t.chars().take(cfg.max_message_chars).collect();
                    m.content = MessageContent::Text(format!("{head}\n…[đã rút gọn bởi Token Saver]"));
                }
            }
        }
    }

    let after = total_chars(&req.messages);
    est_tokens(before.saturating_sub(after))
}

pub fn estimate_tokens(msgs: &[Message]) -> u64 {
    est_tokens(total_chars(msgs))
}

pub fn counters() -> serde_json::Value {
    let u = USAGE.lock().unwrap_or_else(|p| p.into_inner());
    serde_json::json!({
        "saved_tokens_total": u.saved_tokens_total,
        "saver_runs": u.saver_runs,
        "vision_runs": u.vision_runs,
        "skill_runs": u.skill_runs,
    })
}

pub fn count_vision() {
    USAGE.lock().unwrap_or_else(|p| p.into_inner()).vision_runs += 1;
}

// ============================ Vision adapter ============================

pub fn has_images(req: &ChatCompletionRequest) -> bool {
    req.messages.iter().any(|m| !m.content.images().is_empty())
}

pub fn needs_vision_adapter(cfg: &VisionAdapter, model: &str) -> bool {
    if !cfg.enabled || cfg.vision_model.trim().is_empty() {
        return false;
    }
    let bare = model.rsplit('/').next().unwrap_or(model);
    !cfg
        .native_models
        .iter()
        .any(|p| crate::utils::glob_match(p, model) || crate::utils::glob_match(p, bare))
}

// ============================ Skills ============================

/// Inject enabled skills: auto skills always; `/name` at the start of the
/// last user message triggers that skill (prefix removed).
pub fn apply_skills(req: &mut ChatCompletionRequest) -> Vec<String> {
    let skills: Vec<Skill> = config().skills.into_iter().filter(|s| s.enabled).collect();
    if skills.is_empty() {
        return vec![];
    }
    let mut prompts: Vec<(String, String)> = skills
        .iter()
        .filter(|s| s.auto)
        .map(|s| (s.name.clone(), s.prompt.clone()))
        .collect();

    if let Some(last) = req.messages.iter_mut().rev().find(|m| m.role == "user") {
        if let MessageContent::Text(t) = &last.content {
            if let Some(rest) = t.strip_prefix('/') {
                let (name, body) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
                if let Some(s) = skills.iter().find(|s| s.name == name) {
                    if !prompts.iter().any(|(n, _)| n == &s.name) {
                        prompts.push((s.name.clone(), s.prompt.clone()));
                    }
                    last.content = MessageContent::Text(body.trim_start().to_string());
                }
            }
        }
    }

    if prompts.is_empty() {
        return vec![];
    }
    let text = prompts.iter().map(|(_, p)| p.as_str()).collect::<Vec<_>>().join("\n\n");
    req.messages.insert(
        0,
        Message {
            role: "system".into(),
            content: text.into(),
            tool_calls: None,
            tool_call_id: None,
            reasoning: None,
        },
    );
    USAGE.lock().unwrap_or_else(|p| p.into_inner()).skill_runs += 1;
    prompts.into_iter().map(|(n, _)| n).collect()
}

// ============================ Proxy pools ============================

static PROXY_CLIENTS: Lazy<Mutex<HashMap<String, reqwest::Client>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn build_proxy_client(url: &str, timeout: Option<std::time::Duration>) -> Result<reqwest::Client> {
    let proxy = reqwest::Proxy::all(url).map_err(|e| RouterError::InvalidRequest(format!("proxy URL lỗi: {e}")))?;
    let mut b = reqwest::Client::builder().proxy(proxy).connect_timeout(std::time::Duration::from_secs(15));
    if let Some(t) = timeout {
        b = b.timeout(t);
    }
    b.build().map_err(|e| RouterError::Internal(e.to_string()))
}

/// Proxied client for a provider (None = direct). `stream` clients have no
/// overall timeout.
pub fn client_for(provider: &str, stream: bool) -> Option<reqwest::Client> {
    let cfg = CONFIG.read().unwrap_or_else(|p| p.into_inner());
    let pname = cfg.provider_proxy.get(provider)?;
    let entry = cfg.proxies.iter().find(|p| &p.name == pname && p.enabled)?.clone();
    drop(cfg);
    let cache_key = format!("{}|{}", entry.name, stream);
    let mut clients = PROXY_CLIENTS.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(c) = clients.get(&cache_key) {
        return Some(c.clone());
    }
    let timeout = if stream { None } else { Some(std::time::Duration::from_secs(120)) };
    match build_proxy_client(&entry.url, timeout) {
        Ok(c) => {
            clients.insert(cache_key, c.clone());
            Some(c)
        }
        Err(e) => {
            tracing::warn!(proxy = %entry.name, "Proxy client build failed: {e}");
            None
        }
    }
}

/// Probe a proxy: public IP seen through it + latency.
pub async fn test_proxy(url: &str) -> Result<(String, u128)> {
    let client = build_proxy_client(url, Some(std::time::Duration::from_secs(20)))?;
    let started = std::time::Instant::now();
    let resp = client
        .get("https://api.ipify.org?format=json")
        .send()
        .await
        .map_err(|e| RouterError::Provider(format!("không kết nối được qua proxy: {e}")))?;
    let v: serde_json::Value = resp.json().await.unwrap_or_default();
    Ok((v["ip"].as_str().unwrap_or("?").to_string(), started.elapsed().as_millis()))
}

pub fn mask_proxy(url: &str) -> String {
    // hide password in scheme://user:pass@host
    if let Some((scheme, rest)) = url.split_once("://") {
        if let Some((cred, host)) = rest.rsplit_once('@') {
            let user = cred.split(':').next().unwrap_or("");
            return format!("{scheme}://{user}:•••@{host}");
        }
    }
    url.to_string()
}

// ============================ Insights (admin monitor) ============================

/// Aggregate a row slice: requests / errors / tokens / cost.
fn agg_of(rows: &[&RequestLine]) -> (u64, u64, u64, f64) {
    let requests = rows.len() as u64;
    let errors = rows.iter().filter(|r| r.status == "error").count() as u64;
    let tokens = rows.iter().map(|r| (r.prompt_tokens + r.completion_tokens) as u64).sum::<u64>();
    let cost_usd = rows.iter().map(|r| r.cost_usd).sum::<f64>();
    (requests, errors, tokens, cost_usd)
}

/// Insert the aggregate fields into a json!({...}) object literal.
fn with_agg(mut v: serde_json::Value, rows: &[&RequestLine]) -> serde_json::Value {
    let (requests, errors, tokens, cost_usd) = agg_of(rows);
    let o = v.as_object_mut().expect("object");
    o.insert("requests".into(), serde_json::json!(requests));
    o.insert("errors".into(), serde_json::json!(errors));
    o.insert("tokens".into(), serde_json::json!(tokens));
    o.insert("cost_usd".into(), serde_json::json!(cost_usd));
    v
}

fn model_name(r: &RequestLine) -> String {
    if r.provider.is_empty() {
        String::new()
    } else {
        format!("{}/{}", r.provider, r.model)
    }
}

fn account_name(r: &RequestLine) -> String {
    if r.account.is_empty() {
        String::new()
    } else {
        format!("{}/{}", r.provider, r.account)
    }
}

/// Nested per-team / per-owner / per-key breakdown for the admin monitor:
/// which team/user/key used how many tokens & requests, on which models,
/// providers and upstream accounts. Computed from the in-memory request
/// ring (last REQ_CAP requests, ~7 days) — the same window as the usage page.
/// Keys with no traffic in the window are not listed here; the web UI joins
/// them from /admin/keys.
pub fn insights(hours: i64) -> serde_json::Value {
    insights_scoped(hours, &Scope::default())
}

/// Same as [`insights`], restricted to a team/owner scope (team-lead and
/// member dashboards). An inactive scope returns everything.
pub fn insights_scoped(hours: i64, scope: &Scope) -> serde_json::Value {
    let hours = hours.clamp(1, SERIES_HOURS);
    let u = USAGE.lock().unwrap_or_else(|p| p.into_inner());
    let since = Utc::now() - chrono::Duration::hours(hours);
    let rows: Vec<&RequestLine> = u
        .requests
        .iter()
        .filter(|r| r.ts >= since && scope.matches(r))
        .collect();

    let mut teams: HashMap<String, Vec<&RequestLine>> = HashMap::new();
    let mut owners: HashMap<String, Vec<&RequestLine>> = HashMap::new();
    let mut keys: HashMap<String, Vec<&RequestLine>> = HashMap::new();
    for r in &rows {
        teams.entry(r.team.clone().unwrap_or_default()).or_default().push(r);
        owners.entry(r.owner.clone()).or_default().push(r);
        keys.entry(r.key.clone()).or_default().push(r);
    }

    let mut teams_v: Vec<serde_json::Value> = teams
        .into_iter()
        .map(|(name, rows)| {
            with_agg(
                serde_json::json!({
                    "name": name,
                    "by_model": group_by(&rows, model_name),
                    "by_provider": group_by(&rows, |r| r.provider.clone()),
                    "by_account": group_by(&rows, account_name),
                    "by_owner": group_by(&rows, |r| r.owner.clone()),
                    "by_key": group_by(&rows, |r| r.key.clone()),
                }),
                &rows,
            )
        })
        .collect();
    teams_v.sort_by(|a, b| b["requests"].as_u64().cmp(&a["requests"].as_u64()));

    let mut owners_v: Vec<serde_json::Value> = owners
        .into_iter()
        .map(|(name, rows)| {
            let team = rows.iter().find_map(|r| r.team.clone()).unwrap_or_default();
            with_agg(
                serde_json::json!({
                    "name": name,
                    "team": team,
                    "by_model": group_by(&rows, model_name),
                    "by_provider": group_by(&rows, |r| r.provider.clone()),
                    "by_account": group_by(&rows, account_name),
                    "by_key": group_by(&rows, |r| r.key.clone()),
                }),
                &rows,
            )
        })
        .collect();
    owners_v.sort_by(|a, b| b["requests"].as_u64().cmp(&a["requests"].as_u64()));

    let mut keys_v: Vec<serde_json::Value> = keys
        .into_iter()
        .map(|(name, rows)| {
            let owner = rows.first().map(|r| r.owner.clone()).unwrap_or_default();
            let team = rows.iter().find_map(|r| r.team.clone()).unwrap_or_default();
            with_agg(
                serde_json::json!({
                    "name": name,
                    "owner": owner,
                    "team": team,
                    "by_model": group_by(&rows, model_name),
                    "by_provider": group_by(&rows, |r| r.provider.clone()),
                    "by_account": group_by(&rows, account_name),
                }),
                &rows,
            )
        })
        .collect();
    keys_v.sort_by(|a, b| b["requests"].as_u64().cmp(&a["requests"].as_u64()));

    let (treq, terr, ttok, tcost) = agg_of(&rows);
    serde_json::json!({
        "hours": hours,
        "totals": { "requests": treq, "errors": terr, "tokens": ttok, "cost_usd": tcost },
        "teams": teams_v,
        "owners": owners_v,
        "keys": keys_v,
    })
}
