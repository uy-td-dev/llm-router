use std::collections::HashMap;
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::config::{ProviderAccountConfig, ProviderConfig};

/// One upstream credential for a provider.
#[derive(Debug, Clone)]
pub struct UpstreamAccount {
    pub label: String,
    pub api_key: String,
    pub priority: i32,
    pub weight: u32,
}

/// Per-provider account pool (mutable at runtime via the admin API).
#[derive(Default)]
pub struct Vault {
    by_provider: RwLock<HashMap<String, Vec<UpstreamAccount>>>,
}

impl Vault {
    pub fn from_settings(providers: &[ProviderConfig]) -> Self {
        let mut by_provider: HashMap<String, Vec<UpstreamAccount>> = HashMap::new();
        for cfg in providers {
            if !cfg.enabled {
                continue;
            }
            let mut accounts: Vec<UpstreamAccount> = cfg
                .accounts
                .iter()
                .map(|a| UpstreamAccount {
                    label: a.label.clone(),
                    api_key: a.api_key.clone(),
                    priority: a.priority,
                    weight: a.weight,
                })
                .collect();
            // Legacy single-account config fallback (even with an empty
            // key, so requests still reach the provider and surface its
            // 401/403 error like before multi-account support).
            if accounts.is_empty() {
                accounts.push(UpstreamAccount {
                    label: cfg.name.clone(),
                    api_key: cfg.api_key.clone(),
                    priority: default_priority(),
                    weight: default_weight(),
                });
            }
            by_provider.insert(cfg.name.clone(), accounts);
        }
        Self {
            by_provider: RwLock::new(by_provider),
        }
    }

    fn lock(&self) -> std::sync::RwLockReadGuard<'_, HashMap<String, Vec<UpstreamAccount>>> {
        self.by_provider.read().unwrap_or_else(|p| p.into_inner())
    }

    /// Snapshot of the pool (cloned; hot path locks only briefly).
    pub fn get(&self, provider: &str) -> Vec<UpstreamAccount> {
        self.lock()
            .get(provider)
            .cloned()
            .unwrap_or_default()
    }

    pub fn provider_names(&self) -> Vec<String> {
        self.lock().keys().cloned().collect()
    }

    /// Add or replace (same label) an account on a provider pool at runtime.
    pub fn add(&self, provider: &str, account: UpstreamAccount) -> Result<(), String> {
        let mut map = self.by_provider.write().unwrap_or_else(|p| p.into_inner());
        let pool = map.entry(provider.to_string()).or_default();
        if let Some(existing) = pool.iter_mut().find(|a| a.label == account.label) {
            *existing = account;
        } else {
            pool.push(account);
        }
        Ok(())
    }

    /// Replace a provider's whole pool.
    pub fn replace(&self, provider: &str, accounts: Vec<UpstreamAccount>) {
        self.by_provider
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .insert(provider.to_string(), accounts);
    }

    /// Drop a provider's whole pool.
    pub fn clear(&self, provider: &str) {
        self.by_provider
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .remove(provider);
    }

    /// Remove an account by label; errors when absent.
    pub fn remove(&self, provider: &str, label: &str) -> Result<(), String> {
        let mut map = self.by_provider.write().unwrap_or_else(|p| p.into_inner());
        let Some(pool) = map.get_mut(provider) else {
            return Err(format!("provider '{provider}' has no account pool"));
        };
        let before = pool.len();
        pool.retain(|a| a.label != label);
        if pool.len() == before {
            return Err(format!("account '{label}' not found on '{provider}'"));
        }
        Ok(())
    }
}

fn default_priority() -> i32 {
    10
}

fn default_weight() -> u32 {
    1
}

/// Runtime upkeep of upstream accounts: smooth weighted round-robin state,
/// per-account cooldowns and counters.
#[derive(Debug, Default)]
struct Inner {
    entries: HashMap<(String, String), Entry>,
    /// Smooth weighted-RR effective weights, keyed "provider:tier_priority".
    weighted: HashMap<String, HashMap<String, i64>>,
}

#[derive(Debug)]
struct Entry {
    successes: u64,
    failures: u64,
    rate_limited: u64,
    /// Consecutive 429s without a success in between (drives adaptive cooldown).
    consecutive_rate_limited: u64,
    /// Instant at which the cooldown ends.
    cooldown_until: Option<Instant>,
}

impl Entry {
    fn new() -> Self {
        Self {
            successes: 0,
            failures: 0,
            rate_limited: 0,
            consecutive_rate_limited: 0,
            cooldown_until: None,
        }
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct AccountStatus {
    pub provider: String,
    pub label: String,
    pub requests: u64,
    pub failures: u64,
    pub rate_limited: u64,
    pub cooldown_remaining_ms: Option<u64>,
    pub consecutive_rate_limited: u64,
}

/// Manages rotation & cooldowns for upstream accounts.
///
/// Cooldown duration grows exponentially with consecutive 429s:
/// base * 2^(n-1), capped at `max_cooldown`; a success resets the streak.
pub struct AccountManager {
    inner: Mutex<Inner>,
    base_cooldown: Duration,
    max_cooldown: Duration,
}

impl AccountManager {
    pub fn new(base_cooldown: Duration, max_cooldown: Duration) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            base_cooldown,
            max_cooldown,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Rotation snapshot for a provider. Accounts are grouped by priority
    /// (highest first); within a tier they follow smooth *weighted*
    /// round-robin (weight field). Lower priority tiers only appear when
    /// every account of the tier above is in cooldown. Accounts in
    /// cooldown are skipped entirely.
    pub fn rotate_snapshot(&self, provider: &str, accounts: &[UpstreamAccount]) -> Vec<UpstreamAccount> {
        if accounts.is_empty() {
            return vec![];
        }

        let now = Instant::now();
        let mut guard = self.lock();

        // Priority descending, stable by label for deterministic rotation
        let mut sorted: Vec<&UpstreamAccount> = accounts.iter().collect();
        sorted.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.label.cmp(&b.label)));

        let mut out: Vec<UpstreamAccount> = Vec::with_capacity(sorted.len());
        let mut idx = 0;
        while idx < sorted.len() {
            let tier_priority = sorted[idx].priority;
            let tier_start = idx;
            while idx < sorted.len() && sorted[idx].priority == tier_priority {
                idx += 1;
            }
            let tier: Vec<&UpstreamAccount> = sorted[tier_start..idx].to_vec();

            // Smooth weighted round-robin: exactly ONE weighted pick per
            // request as the primary choice; the remaining accounts act as
            // fallback in label order. State persists across requests,
            // producing the classic weighted distribution over time.
            let key = format!("{provider}:{tier_priority}");
            let (primary, rest): (UpstreamAccount, Vec<UpstreamAccount>) = {
                let state = guard.weighted.entry(key).or_default();
                let total: i64 = tier.iter().map(|a| a.weight.max(1) as i64).sum();

                for account in &tier {
                    let eff = state.entry(account.label.clone()).or_insert(0);
                    *eff += account.weight.max(1) as i64;
                }

                let pick = (*tier
                    .iter()
                    .max_by_key(|a| {
                        let lab = a.label.clone();
                        (state.get(&lab).copied().unwrap_or(0), lab)
                    })
                    .unwrap())
                .clone();

                let lab = pick.label.clone();
                let eff = state.get(&lab).copied().unwrap_or(0);
                state.insert(lab, eff - total);

                // Drop state for accounts no longer in the tier
                state.retain(|label, _| tier.iter().any(|a| &a.label == label));

                let mut rest: Vec<UpstreamAccount> = tier
                    .iter()
                    .filter(|a| a.label != pick.label)
                    .map(|a| (*a).clone())
                    .collect();
                rest.sort_by(|a, b| a.label.cmp(&b.label));
                (pick, rest)
            };

            for account in std::iter::once(primary).chain(rest) {
                if account_available(&guard, provider, &account.label, now) {
                    out.push(account);
                }
            }
        }

        out
    }

    pub fn record(&self, provider: &str, label: &str, success: bool, rate_limited: bool) {
        let mut guard = self.lock();
        let key = (provider.to_string(), label.to_string());
        let entry = guard.entries.entry(key).or_insert_with(Entry::new);
        if success {
            entry.successes += 1;
            entry.consecutive_rate_limited = 0;
        } else {
            entry.failures += 1;
            if rate_limited {
                entry.rate_limited += 1;
                entry.consecutive_rate_limited += 1;
            }
        }
    }

    /// Adaptive cooldown: base * 2^(consecutive-1), capped.
    pub fn cooldown_after(&self, provider: &str, label: &str) {
        let mut guard = self.lock();
        let key = (provider.to_string(), label.to_string());
        let entry = guard.entries.entry(key).or_insert_with(Entry::new);

        let streak = entry.consecutive_rate_limited.max(1);
        let shift = streak.saturating_sub(1).min(20);
        let secs = self
            .base_cooldown
            .as_secs()
            .checked_shl(shift as u32)
            .unwrap_or(self.max_cooldown.as_secs())
            .min(self.max_cooldown.as_secs());

        entry.cooldown_until = Some(now_plus(Duration::from_secs(secs)));

        tracing::warn!(
            provider,
            account = label,
            cooldown_s = secs,
            consecutive_429s = streak,
            "Upstream account put in adaptive cooldown"
        );
    }

    pub fn statuses(&self, provider: &str, accounts: &[UpstreamAccount]) -> Vec<AccountStatus> {
        let guard = self.lock();
        let now = Instant::now();
        accounts
            .iter()
            .map(|account| {
                let key = (provider.to_string(), account.label.clone());
                let (requests, failures, rate_limited_count, cooldown_remaining_ms, consecutive) =
                    match guard.entries.get(&key) {
                        Some(entry) => {
                            let remaining = entry.cooldown_until.and_then(|until| {
                                if until > now {
                                    Some(until.duration_since(now).as_millis() as u64)
                                } else {
                                    None
                                }
                            });
                            (
                                entry.successes,
                                entry.failures,
                                entry.rate_limited,
                                remaining,
                                entry.consecutive_rate_limited,
                            )
                        }
                        None => (0, 0, 0, None, 0),
                    };
                AccountStatus {
                    provider: provider.to_string(),
                    label: account.label.clone(),
                    requests,
                    failures,
                    rate_limited: rate_limited_count,
                    cooldown_remaining_ms,
                    consecutive_rate_limited: consecutive,
                }
            })
            .collect()
    }
}

fn account_available(guard: &Inner, provider: &str, label: &str, now: Instant) -> bool {
    match guard.entries.get(&(provider.to_string(), label.to_string())) {
        Some(entry) => match entry.cooldown_until {
            Some(until) => until <= now,
            None => true,
        },
        None => true,
    }
}

fn now_plus(d: Duration) -> Instant {
    Instant::now() + d
}

#[allow(dead_code)]
fn _assert(a: ProviderAccountConfig) -> ProviderAccountConfig {
    a
}
