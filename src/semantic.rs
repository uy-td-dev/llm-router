//! Semantic response cache for non-streaming chat completions.
//!
//! Instead of an exact hash match, requests are matched by cosine similarity
//! of embedding vectors computed from the conversation text. A hit returns
//! the stored response without touching upstream. Entries expire by TTL and
//! evict FIFO when full. The caller supplies vectors (via the embeddings
//! pipeline); this type is pure in-memory state.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::api::models::{ChatCompletionResponse, KeyContext};
use crate::config::SemanticCacheConfig;

struct Entry {
    vector: Vec<f32>,
    response: ChatCompletionResponse,
    created: Instant,
}

pub struct SemanticCache {
    threshold: f32,
    ttl: Duration,
    max_entries: usize,
    entries: Mutex<VecDeque<Entry>>,
}

impl SemanticCache {
    pub fn new(cfg: &SemanticCacheConfig) -> Self {
        Self {
            threshold: cfg.similarity_threshold,
            ttl: Duration::from_secs(cfg.ttl_seconds),
            max_entries: cfg.max_entries,
            entries: Mutex::new(VecDeque::new()),
        }
    }

    /// Context used for internal (cache-priming) embeddings calls.
    pub fn internal_context() -> KeyContext {
        let mut ctx = KeyContext::anonymous();
        ctx.label = "semantic-cache".to_string();
        ctx.owner = "system".to_string();
        ctx
    }

    /// Best-similarity entry at or above the threshold; expired entries are
    /// dropped on the way. Caller message vector: normalized internally.
    pub fn lookup(&self, vector: &[f32]) -> Option<ChatCompletionResponse> {
        let mut guard = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        guard.retain(|e| e.created.elapsed() < self.ttl);

        let mut best: Option<(f32, usize)> = None;
        for (idx, entry) in guard.iter().enumerate() {
            let sim = cosine_similarity(vector, &entry.vector);
            if sim >= self.threshold && best.map(|(b, _)| sim > b).unwrap_or(true) {
                best = Some((sim, idx));
            }
        }

        let (_, idx) = best?;
        Some(guard[idx].response.clone())
    }

    pub fn store(&self, vector: Vec<f32>, response: ChatCompletionResponse) {
        let mut guard = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        guard.push_back(Entry {
            vector,
            response,
            created: Instant::now(),
        });
        while guard.len() > self.max_entries {
            guard.pop_front();
        }
    }

    pub fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Cosine similarity of two non-empty vectors (zero vectors score 0).
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}
