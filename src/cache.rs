//! Exact-match response cache for non-streaming chat completions.
//!
//! Keyed by a hash of the canonical request (model + messages + params).
//! In-memory only, TTL-based, LRU-free bounded size (FIFO eviction).

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::api::models::{ChatCompletionRequest, ChatCompletionResponse};

struct CacheEntry {
    created: Instant,
    response: ChatCompletionResponse,
}

pub struct ResponseCache {
    ttl: Duration,
    max_entries: usize,
    entries: Mutex<HashMap<String, CacheEntry>>,
}

impl ResponseCache {
    pub fn new(ttl_seconds: u64, max_entries: usize) -> Self {
        Self {
            ttl: Duration::from_secs(ttl_seconds),
            max_entries,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Canonical cache key for a request (stream flag excluded).
    pub fn cache_key(&self, req: &ChatCompletionRequest) -> Option<String> {
        let mut probe = req.clone();
        probe.stream = false;
        let serialized = serde_json::to_string(&probe).ok()?;

        let mut hasher = DefaultHasher::new();
        serialized.hash(&mut hasher);
        Some(format!("{:016x}", hasher.finish()))
    }

    pub fn get(&self, req: &ChatCompletionRequest) -> Option<ChatCompletionResponse> {
        let key = self.cache_key(req)?;
        let mut guard = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let hit = guard.get(&key)?;
        if hit.created.elapsed() >= self.ttl {
            guard.remove(&key);
            return None;
        }
        Some(hit.response.clone())
    }

    pub fn put(&self, req: &ChatCompletionRequest, response: ChatCompletionResponse) {
        let Some(key) = self.cache_key(req) else {
            return;
        };
        let mut guard = self.entries.lock().unwrap_or_else(|p| p.into_inner());

        // Simple capacity bound: drop the whole cache when full (evicts all
        // expired entries anyway, keeps the code simple and bounded).
        if guard.len() >= self.max_entries {
            let now = Instant::now();
            guard.retain(|_, e| now.duration_since(e.created) < self.ttl);
            if guard.len() >= self.max_entries {
                guard.clear();
            }
        }

        guard.insert(key, CacheEntry {
            created: Instant::now(),
            response,
        });
    }

    pub fn len(&self) -> usize {
        self.entries.lock().map(|g| g.len()).unwrap_or(0)
    }
}
