use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Sliding-window rate limiter keyed by an arbitrary string
/// (e.g. "ip:1.2.3.4" or "key:sk-vk-alice"). Each key can use its own
/// limit via `check_limit`; `check` applies the shared default limit.
pub struct RateLimiter {
    entries: Mutex<HashMap<String, VecDeque<Instant>>>,
    max_requests: usize,
    window: Duration,
}

pub type SharedRateLimiter = Arc<RateLimiter>;

impl RateLimiter {
    pub fn new(max_requests: usize, window: Duration) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            max_requests,
            window,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, VecDeque<Instant>>> {
        self.entries.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Returns true and records the hit when within limits; false when throttled.
    pub fn check(&self, key: &str) -> bool {
        self.check_limit(key, self.max_requests)
    }

    /// Same as `check`, but with a per-caller limit.
    pub fn check_limit(&self, key: &str, max_requests: usize) -> bool {
        let now = Instant::now();
        let mut guard = self.lock();
        let queue = guard.entry(key.to_string()).or_default();

        // Evict entries that fell out of the window
        while let Some(front) = queue.front() {
            if now.duration_since(*front) > self.window {
                queue.pop_front();
            } else {
                break;
            }
        }

        if queue.len() >= max_requests {
            false
        } else {
            queue.push_back(now);
            true
        }
    }
}
