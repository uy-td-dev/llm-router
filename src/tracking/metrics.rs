use once_cell::sync::Lazy;
use prometheus::{
    Encoder, HistogramOpts, HistogramVec, IntCounterVec, Opts, Registry, TextEncoder,
};
use std::collections::HashMap;
use std::sync::Mutex;

static REGISTRY: Lazy<Registry> = Lazy::new(Registry::new);

pub static REQUESTS_TOTAL: Lazy<IntCounterVec> = Lazy::new(|| {
    let counter = IntCounterVec::new(
        Opts::new(
            "llm_router_requests_total",
            "Total LLM requests by provider, model and status",
        ),
        &["provider", "model", "status"],
    )
    .unwrap();
    REGISTRY
        .register(Box::new(counter.clone()))
        .expect("register requests_total");
    counter
});

pub static REQUEST_DURATION_SECONDS: Lazy<HistogramVec> = Lazy::new(|| {
    let histogram = HistogramVec::new(
        HistogramOpts::new(
            "llm_router_request_duration_seconds",
            "Duration of provider calls in seconds",
        ),
        &["provider", "model"],
    )
    .unwrap();
    REGISTRY
        .register(Box::new(histogram.clone()))
        .expect("register request_duration");
    histogram
});

/// Force metric registration early.
pub fn init() {
    Lazy::force(&REQUESTS_TOTAL);
    Lazy::force(&REQUEST_DURATION_SECONDS);
}

pub fn record_success(provider: &str, model: &str, duration_s: f64) {
    REQUESTS_TOTAL
        .with_label_values(&[provider, model, "success"])
        .inc();
    REQUEST_DURATION_SECONDS
        .with_label_values(&[provider, model])
        .observe(duration_s);
}

pub fn record_failure(provider: &str, model: &str, duration_s: f64) {
    REQUESTS_TOTAL
        .with_label_values(&[provider, model, "failure"])
        .inc();
    REQUEST_DURATION_SECONDS
        .with_label_values(&[provider, model])
        .observe(duration_s);
}

/// Render metrics in Prometheus text format.
pub fn render() -> String {
    let encoder = TextEncoder::new();
    let mut buffer = Vec::new();
    encoder
        .encode(&REGISTRY.gather(), &mut buffer)
        .expect("encode metrics");
    String::from_utf8(buffer).expect("metrics utf8")
}

// ---------------------------------------------------------------------------
// Latency EMA store (routing decision data)
// ---------------------------------------------------------------------------

/// Exponentially-weighted moving average of endpoint latency, used by
/// the latency-first routing strategy.
#[derive(Debug, Clone)]
pub struct LatencySample {
    pub ema_ms: f64,
    pub samples: u64,
}

static LATENCY_EMA: Lazy<Mutex<HashMap<(String, String), LatencySample>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const EMA_ALPHA: f64 = 0.3;

/// Record a latency observation (in milliseconds) and update the EMA.
pub fn record_latency(provider: &str, model: &str, latency_ms: u128) {
    let mut map = LATENCY_EMA.lock().unwrap_or_else(|p| p.into_inner());
    let entry = map
        .entry((provider.to_string(), model.to_string()))
        .or_insert(LatencySample {
            ema_ms: 0.0,
            samples: 0,
        });

    let v = latency_ms as f64;
    entry.ema_ms = if entry.samples == 0 {
        v
    } else {
        entry.ema_ms * (1.0 - EMA_ALPHA) + v * EMA_ALPHA
    };
    entry.samples += 1;
}

/// Current EMA latency for a provider/model, if measured.
pub fn latency_for(provider: &str, model: &str) -> Option<LatencySample> {
    let map = LATENCY_EMA.lock().unwrap_or_else(|p| p.into_inner());
    map.get(&(provider.to_string(), model.to_string())).cloned()
}
