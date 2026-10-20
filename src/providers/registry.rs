use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

use crate::config::{CostConfig, ProviderConfig, Settings};
use crate::providers::traits::{LLMProvider, ProviderInfo};
use crate::providers::vault::{AccountManager, AccountStatus, UpstreamAccount, Vault};
use crate::providers::{anthropic::AnthropicProvider, google::GoogleProvider, openai::OpenAIProvider};
use crate::utils::{Result, RouterError};

pub struct ProviderRegistry {
    providers: RwLock<HashMap<String, Arc<dyn LLMProvider>>>,
    /// Enabled provider configs: YAML first, then runtime connections.
    configs: RwLock<Vec<ProviderConfig>>,
    /// Providers defined in YAML (never removed at runtime).
    yaml_names: HashSet<String>,
    vault: Vault,
    accounts: AccountManager,
}

pub fn build_provider(cfg: &ProviderConfig) -> Option<Arc<dyn LLMProvider>> {
    match cfg.wire_format() {
        "openai" => Some(Arc::new(OpenAIProvider::new(cfg.clone()))),
        "anthropic" => Some(Arc::new(AnthropicProvider::new(cfg.clone()))),
        "google" => Some(Arc::new(GoogleProvider::new(cfg.clone()))),
        other => {
            tracing::warn!("Unknown provider format '{}' for {}", other, cfg.name);
            None
        }
    }
}

pub fn valid_provider_name(name: &str) -> bool {
    let len_ok = (2..=40).contains(&name.len());
    len_ok
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

impl ProviderRegistry {
    pub fn new(settings: Settings) -> Self {
        let mut providers: HashMap<String, Arc<dyn LLMProvider>> = HashMap::new();
        let mut configs = Vec::new();

        for cfg in settings.providers.iter().filter(|p| p.enabled) {
            if let Some(provider) = build_provider(cfg) {
                providers.insert(cfg.name.clone(), provider);
                configs.push(cfg.clone());
            }
        }

        let yaml_names = configs.iter().map(|c| c.name.clone()).collect();
        let vault = Vault::from_settings(&configs);

        Self {
            providers: RwLock::new(providers),
            configs: RwLock::new(configs),
            yaml_names,
            vault,
            accounts: AccountManager::new(
                std::time::Duration::from_secs(60),
                std::time::Duration::from_secs(600),
            ),
        }
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn LLMProvider>> {
        self.providers
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(name)
            .cloned()
    }

    pub fn is_yaml(&self, name: &str) -> bool {
        self.yaml_names.contains(name)
    }

    pub fn list_providers(&self) -> Vec<ProviderInfo> {
        let configs = self.configs.read().unwrap_or_else(|p| p.into_inner());
        let mut result = Vec::new();
        for cfg in configs.iter() {
            for model_cfg in &cfg.models {
                result.push(ProviderInfo {
                    provider: cfg.name.clone(),
                    model: model_cfg.name.clone(),
                    cost: model_cfg.cost.clone(),
                    is_healthy: true, // TODO: track actual health
                    is_embedding: model_cfg.is_embedding(),
                });
            }
        }
        result
    }

    /// Register (or replace) a provider defined at runtime by a connection.
    /// YAML providers keep their YAML definition.
    pub fn upsert_provider(&self, cfg: ProviderConfig) -> Result<()> {
        if !valid_provider_name(&cfg.name) {
            return Err(RouterError::InvalidRequest(format!(
                "tên provider '{}' không hợp lệ (a-z, 0-9, '-')",
                cfg.name
            )));
        }
        if self.is_yaml(&cfg.name) {
            return Ok(());
        }
        if !(cfg.base_url.starts_with("https://") || cfg.base_url.starts_with("http://")) {
            return Err(RouterError::InvalidRequest("base_url phải là http(s)://".to_string()));
        }
        if cfg.models.is_empty() {
            return Err(RouterError::InvalidRequest(format!(
                "provider '{}' cần ít nhất 1 model",
                cfg.name
            )));
        }
        let provider = build_provider(&cfg).ok_or_else(|| {
            RouterError::InvalidRequest(format!(
                "format '{}' không hỗ trợ (openai|anthropic|google)",
                cfg.wire_format()
            ))
        })?;
        self.providers
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .insert(cfg.name.clone(), provider);
        let mut configs = self.configs.write().unwrap_or_else(|p| p.into_inner());
        configs.retain(|c| c.name != cfg.name);
        configs.push(cfg);
        Ok(())
    }

    /// Accounts a YAML provider starts with (connections add on top).
    pub fn yaml_pool(&self, provider: &str) -> Vec<UpstreamAccount> {
        if !self.is_yaml(provider) {
            return vec![];
        }
        match self.provider_config(provider) {
            Some(cfg) => Vault::from_settings(std::slice::from_ref(&cfg)).get(provider),
            None => vec![],
        }
    }

    /// Replace the whole account pool of a provider (connection sync).
    pub fn replace_accounts(&self, provider: &str, accounts: Vec<UpstreamAccount>) {
        self.vault.replace(provider, accounts);
    }

    /// Unregister a runtime provider (YAML providers are kept).
    pub fn remove_provider(&self, name: &str) {
        if self.is_yaml(name) {
            return;
        }
        self.providers
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .remove(name);
        self.configs
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|c| c.name != name);
        self.vault.clear(name);
    }

    /// Rotation snapshot of upstream accounts for a provider.
    pub fn rotate_accounts(&self, provider: &str) -> Vec<UpstreamAccount> {
        let pool: Vec<UpstreamAccount> = self
            .vault
            .get(provider)
            .into_iter()
            .filter(|a| crate::hub::quota_ok(provider, &a.label))
            .collect();
        self.accounts.rotate_snapshot(provider, &pool)
    }

    /// Raw pool (server-side use only).
    pub fn pool(&self, provider: &str) -> Vec<UpstreamAccount> {
        self.vault.get(provider)
    }

    /// Account pool view for the admin API (fails on unknown providers).
    pub fn provider_accounts(&self, provider: &str) -> Result<Vec<AccountStatus>> {
        if self.get(provider).is_none() {
            return Err(RouterError::InvalidRequest(format!(
                "unknown provider '{provider}'"
            )));
        }
        let accounts = self.vault.get(provider);
        Ok(self.accounts.statuses(provider, &accounts))
    }

    /// Admin API: add/replace an account in the runtime pool.
    pub fn add_account(
        &self,
        provider: &str,
        label: &str,
        api_key: &str,
        priority: i32,
        weight: u32,
    ) -> Result<()> {
        if self.get(provider).is_none() {
            return Err(RouterError::InvalidRequest(format!(
                "unknown provider '{provider}'"
            )));
        }
        if label.trim().is_empty() || api_key.trim().is_empty() {
            return Err(RouterError::InvalidRequest(
                "label and api_key must be non-empty".to_string(),
            ));
        }
        self.vault
            .add(
                provider,
                UpstreamAccount {
                    label: label.trim().to_string(),
                    api_key: api_key.trim().to_string(),
                    priority,
                    weight: weight.max(1),
                },
            )
            .map_err(RouterError::Internal)
    }

    /// Raw credential of one pool account (server-side use only).
    pub fn account_key(&self, provider: &str, label: &str) -> Option<String> {
        self.vault
            .get(provider)
            .into_iter()
            .find(|a| a.label == label)
            .map(|a| a.api_key)
    }

    /// Admin API: remove an account from the runtime pool.
    pub fn remove_account(&self, provider: &str, label: &str) -> Result<()> {
        if self.get(provider).is_none() {
            return Err(RouterError::InvalidRequest(format!(
                "unknown provider '{provider}'"
            )));
        }
        self.vault
            .remove(provider, label)
            .map_err(RouterError::InvalidRequest)
    }

    pub fn record_account(&self, provider: &str, label: &str, success: bool, rate_limited: bool) {
        self.accounts.record(provider, label, success, rate_limited);
    }

    pub fn cooldown_account(&self, provider: &str, label: &str) {
        self.accounts.cooldown_after(provider, label);
    }

    pub fn account_statuses(&self) -> Vec<AccountStatus> {
        let mut out = Vec::new();
        let mut names = self.vault.provider_names();
        names.sort();
        for provider in names {
            let accounts = self.vault.get(&provider);
            if accounts.is_empty() {
                continue;
            }
            out.extend(self.accounts.statuses(&provider, &accounts));
        }
        out
    }

    /// Find the enabled provider config by name.
    pub fn provider_config(&self, name: &str) -> Option<ProviderConfig> {
        self.configs
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .find(|p| p.name == name)
            .cloned()
    }

    pub fn provider_configs(&self) -> Vec<ProviderConfig> {
        self.configs.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn wire_format(&self, name: &str) -> Option<String> {
        self.provider_config(name).map(|c| c.wire_format().to_string())
    }

    /// Look up the cost configuration for a specific provider/model pair.
    pub fn model_cost(&self, provider_name: &str, model: &str) -> Option<CostConfig> {
        self.provider_config(provider_name)
            .and_then(|cfg| cfg.models.into_iter().find(|m| m.name == model))
            .map(|m| m.cost)
    }
}
