use crate::providers::ProviderInfo;
use crate::tracking::metrics::{self, LatencySample};

pub struct RouterSelection {
    pub provider: String,
    pub model: String,
    pub cost_estimate: f64,
}

pub trait RoutingStrategy: Send + Sync {
    fn select(&self, available: &[ProviderInfo]) -> Option<RouterSelection>;
}

pub struct CheapestFirstStrategy;

impl RoutingStrategy for CheapestFirstStrategy {
    fn select(&self, available: &[ProviderInfo]) -> Option<RouterSelection> {
        available
            .iter()
            .filter(|p| p.is_healthy)
            .min_by(|a, b| {
                let a_cost = a.cost.input_per_1m + a.cost.output_per_1m;
                let b_cost = b.cost.input_per_1m + b.cost.output_per_1m;
                a_cost.partial_cmp(&b_cost).unwrap()
            })
            .map(|p| RouterSelection {
                provider: p.provider.clone(),
                model: p.model.clone(),
                cost_estimate: p.cost.input_per_1m + p.cost.output_per_1m,
            })
    }
}

/// Picks the measured-fastest provider for the requested model.
/// Healthy providers without samples yet are "explored" (cheapest first)
/// so everyone gets measured before EMA-based routing kicks in.
pub struct LatencyFirstStrategy;

impl RoutingStrategy for LatencyFirstStrategy {
    fn select(&self, available: &[ProviderInfo]) -> Option<RouterSelection> {
        let healthy: Vec<&ProviderInfo> = available.iter().filter(|p| p.is_healthy).collect();
        if healthy.is_empty() {
            return None;
        }

        fn cost_of(p: &ProviderInfo) -> f64 {
            p.cost.input_per_1m + p.cost.output_per_1m
        }

        fn ident_of(p: &ProviderInfo) -> (&str, &str) {
            (p.provider.as_str(), p.model.as_str())
        }

        // Providers with a latency sample
        let sampled: Vec<(&ProviderInfo, LatencySample)> = healthy
            .iter()
            .filter_map(|p| metrics::latency_for(&p.provider, &p.model).map(|s| (*p, s)))
            .collect();

        // Exploration phase: try providers without samples (cheapest first)
        let unsampled: Vec<&ProviderInfo> = healthy
            .iter()
            .filter(|p| {
                !sampled
                    .iter()
                    .any(|(sp, _)| ident_of(sp) == ident_of(p))
            })
            .copied()
            .collect();

        if let Some(best) = unsampled
            .iter()
            .min_by(|a, b| {
                cost_of(a)
                    .partial_cmp(&cost_of(b))
                    .unwrap()
                    .then(ident_of(a).cmp(&ident_of(b)))
            })
        {
            return Some(RouterSelection {
                provider: best.provider.clone(),
                model: best.model.clone(),
                cost_estimate: cost_of(best),
            });
        }

        // EMA-based selection
        sampled
            .into_iter()
            .min_by(|a, b| {
                a.1.ema_ms
                    .partial_cmp(&b.1.ema_ms)
                    .unwrap()
                    .then(ident_of(a.0).cmp(&ident_of(b.0)))
            })
            .map(|(p, _)| RouterSelection {
                provider: p.provider.clone(),
                model: p.model.clone(),
                cost_estimate: cost_of(p),
            })
    }
}
