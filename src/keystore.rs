//! In-memory runtime key store overlaying the YAML-configured virtual keys.
//!
//! Admin API (`POST/DELETE /admin/keys`) mutates this store at runtime.
//! Changes are NOT persisted: on restart the YAML `keys` section is the
//! source of truth again.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

use crate::config::KeyConfig;

pub struct KeyStore {
    keys: RwLock<HashMap<String, KeyConfig>>,
    /// Latch: once auth has been enabled (via YAML config or the admin API)
    /// it stays on even if every key is deleted — deleting the last key
    /// locks out nothing silently open the proxy.
    enabled: AtomicBool,
}

impl KeyStore {
    pub fn from_config(keys: Vec<KeyConfig>) -> Self {
        let enabled = AtomicBool::new(!keys.is_empty());
        let map = keys
            .into_iter()
            .map(|k| (k.key.clone(), k))
            .collect();
        Self {
            keys: RwLock::new(map),
            enabled,
        }
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, HashMap<String, KeyConfig>> {
        self.keys.read().unwrap_or_else(|p| p.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<String, KeyConfig>> {
        self.keys.write().unwrap_or_else(|p| p.into_inner())
    }

    /// Auth is required once any key has ever been configured.
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn get(&self, key: &str) -> Option<KeyConfig> {
        self.read().get(key).cloned()
    }

    /// Adds or replaces a key. Returns true when it replaced an existing one.
    pub fn upsert(&self, cfg: KeyConfig) -> bool {
        self.enabled.store(true, Ordering::Relaxed);
        self.write().insert(cfg.key.clone(), cfg).is_some()
    }

    pub fn remove(&self, key: &str) -> bool {
        self.write().remove(key).is_some()
    }

    pub fn list(&self) -> Vec<KeyConfig> {
        let mut out: Vec<KeyConfig> = self.read().values().cloned().collect();
        out.sort_by(|a, b| a.key.cmp(&b.key));
        out
    }
}
