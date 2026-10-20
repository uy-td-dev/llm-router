use crate::config::RetryConfig;
use crate::utils::{Result, RouterError};
use std::time::Duration;

/// Executes an operation with exponential backoff retry.
/// Only retries transient errors (rate limits, timeouts, 5xx);
/// permanent errors (4xx auth/parse) fail fast.
#[derive(Clone)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub initial_backoff_ms: u64,
    pub max_backoff_ms: u64,
    pub backoff_multiplier: f64,
}

impl RetryPolicy {
    pub fn from_config(cfg: &RetryConfig) -> Self {
        Self {
            max_attempts: cfg.max_attempts.max(1),
            initial_backoff_ms: cfg.initial_backoff_ms,
            max_backoff_ms: cfg.max_backoff_ms,
            backoff_multiplier: cfg.backoff_multiplier,
        }
    }

    pub async fn execute<T, F, Fut>(&self, mut op: F) -> Result<T>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let mut attempt = 0u32;
        let mut backoff_ms = self.initial_backoff_ms;

        loop {
            attempt += 1;
            match op().await {
                Ok(value) => return Ok(value),
                Err(e) if attempt >= self.max_attempts || !Self::is_retryable(&e) => {
                    tracing::warn!(
                        "Attempt {}/{} failed (retryable: {}): {}",
                        attempt,
                        self.max_attempts,
                        Self::is_retryable(&e),
                        e
                    );
                    return Err(e);
                }
                Err(e) => {
                    tracing::warn!(
                        "Attempt {}/{} failed with retryable error, backing off {}ms: {}",
                        attempt,
                        self.max_attempts,
                        backoff_ms,
                        e
                    );
                    tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                    backoff_ms = ((backoff_ms as f64 * self.backoff_multiplier) as u64)
                        .min(self.max_backoff_ms);
                }
            }
        }
    }

    /// Timeouts, transient 5xx and network errors are safe to retry on the
    /// same upstream account. Rate limits (429, quota, overloaded) are NOT
    /// retried here — the executor rotates to the next upstream account
    /// (or next candidate) immediately instead. Auth/parse errors fail fast.
    fn is_retryable(e: &RouterError) -> bool {
        match e {
            RouterError::Http(_) => true,
            RouterError::Provider(msg) => {
                let m = msg.to_lowercase();
                m.contains("timeout")
                    || m.contains("timed out")
                    || m.contains("500")
                    || m.contains("502")
                    || m.contains("503")
                    || m.contains("504")
                    || m.contains("temporarily")
            }
            _ => false,
        }
    }
}
