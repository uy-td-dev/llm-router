use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Circuit breaker states:
/// - Closed:    normal operation, requests flow through
/// - Open:      provider is failing, requests rejected immediately
/// - HalfOpen:  after cooldown, allow a probe request to test recovery
#[derive(Debug, Clone, PartialEq)]
enum State {
    Closed,
    Open { opened_at: Instant },
    HalfOpen,
}

#[derive(Debug)]
struct Entry {
    state: State,
    failures: u32,
    successes: u32, // probes succeeded in HalfOpen
}

impl Entry {
    fn new() -> Self {
        Self {
            state: State::Closed,
            failures: 0,
            successes: 0,
        }
    }
}

pub struct CircuitBreaker {
    entries: Mutex<HashMap<String, Entry>>,
    failure_threshold: u32,
    cooldown: Duration,
    half_open_probes: u32,
}

impl Default for CircuitBreaker {
    fn default() -> Self {
        Self::new(5, Duration::from_secs(30), 2)
    }
}

impl CircuitBreaker {
    pub fn new(failure_threshold: u32, cooldown: Duration, half_open_probes: u32) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            failure_threshold,
            cooldown,
            half_open_probes,
        }
    }

    fn key(provider: &str, model: &str) -> String {
        format!("{provider}/{model}")
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Returns true if a request to this provider/model may proceed.
    pub fn allow(&self, provider: &str, model: &str) -> bool {
        let mut guard = self.lock();
        let key = Self::key(provider, model);
        let entry = guard.entry(key).or_insert_with(Entry::new);

        match entry.state.clone() {
            State::Closed => true,
            State::Open { opened_at } => {
                if opened_at.elapsed() >= self.cooldown {
                    entry.state = State::HalfOpen;
                    entry.successes = 0;
                    entry.failures = 0;
                    tracing::info!(provider, model, "Circuit half-open, probing");
                    true
                } else {
                    false
                }
            }
            State::HalfOpen => true, // allow probe(s)
        }
    }

    /// Record a successful request.
    pub fn record_success(&self, provider: &str, model: &str) {
        let mut guard = self.lock();
        let key = Self::key(provider, model);
        let entry = guard.entry(key).or_insert_with(Entry::new);

        match entry.state.clone() {
            State::HalfOpen => {
                entry.successes += 1;
                if entry.successes >= self.half_open_probes {
                    entry.state = State::Closed;
                    entry.failures = 0;
                    entry.successes = 0;
                    tracing::info!(provider, model, "Circuit closed (recovered)");
                }
            }
            _ => {
                entry.failures = 0;
            }
        }
    }

    /// Record a failed request.
    pub fn record_failure(&self, provider: &str, model: &str) {
        let mut guard = self.lock();
        let key = Self::key(provider, model);
        let entry = guard.entry(key).or_insert_with(Entry::new);

        match entry.state {
            State::HalfOpen => {
                // probe failed -> reopen immediately
                entry.state = State::Open {
                    opened_at: Instant::now(),
                };
                entry.failures += 1;
                tracing::warn!(provider, model, "Circuit re-opened after failed probe");
            }
            _ => {
                entry.failures += 1;
                if entry.failures >= self.failure_threshold {
                    entry.state = State::Open {
                        opened_at: Instant::now(),
                    };
                    tracing::warn!(
                        provider,
                        model,
                        "Circuit opened after {} consecutive failures",
                        entry.failures
                    );
                }
            }
        }
    }
}

/// Thread-safe shared handle.
pub type SharedCircuitBreaker = Arc<CircuitBreaker>;
