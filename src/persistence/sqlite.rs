//! SQLite persistence (default). Self-contained via the bundled driver.

use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde_json::json;

use crate::config::KeyConfig;
use crate::persistence::{Persistence, UsageQuery};
use crate::tracking::usage::UsageRecord;

pub struct SqlitePersistence {
    conn: Arc<Mutex<Connection>>,
}

impl SqlitePersistence {
    pub fn open(path: &str) -> Result<Self, String> {
        if let Some(parent) = std::path::Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;

            CREATE TABLE IF NOT EXISTS usage_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                api_key TEXT NOT NULL,
                owner TEXT NOT NULL,
                team TEXT,
                requested_model TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                upstream_account TEXT NOT NULL,
                prompt_tokens INTEGER NOT NULL,
                completion_tokens INTEGER NOT NULL,
                total_tokens INTEGER NOT NULL,
                cost_usd REAL NOT NULL,
                latency_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_usage_api_key ON usage_records(api_key);
            CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_records(ts);
            CREATE INDEX IF NOT EXISTS idx_usage_provider_model ON usage_records(provider, model);

            CREATE TABLE IF NOT EXISTS virtual_keys (
                key TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                allowed_models TEXT NOT NULL,   -- JSON array
                allowed_providers TEXT,         -- JSON array or NULL
                rpm INTEGER,
                monthly_budget_usd REAL
            );
            "#,
        )
        .map_err(|e| e.to_string())?;

        // Additive migration: `team` was added after the first release, so
        // existing databases get the columns here. Guarded by column checks
        // so re-running is a no-op.
        let has_vk_team = (|| -> rusqlite::Result<bool> {
            let mut stmt = conn.prepare("PRAGMA table_info(virtual_keys)")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                if row.get::<_, String>(1)? == "team" {
                    return Ok(true);
                }
            }
            Ok(false)
        })()
        .unwrap_or(false);
        if !has_vk_team {
            conn.execute_batch("ALTER TABLE virtual_keys ADD COLUMN team TEXT;")
                .map_err(|e| e.to_string())?;
        }
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_vk_team ON virtual_keys(team);")
            .map_err(|e| e.to_string())?;

        let has_usage_team = (|| -> rusqlite::Result<bool> {
            let mut stmt = conn.prepare("PRAGMA table_info(usage_records)")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                if row.get::<_, String>(1)? == "team" {
                    return Ok(true);
                }
            }
            Ok(false)
        })()
        .unwrap_or(false);
        if !has_usage_team {
            conn.execute_batch("ALTER TABLE usage_records ADD COLUMN team TEXT;")
                .map_err(|e| e.to_string())?;
        }

        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_usage_team ON usage_records(team);")
            .map_err(|e| e.to_string())?;
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_usage_owner ON usage_records(owner);")
            .map_err(|e| e.to_string())?;


        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let guard = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        f(&guard).map_err(|e| e.to_string())
    }
}

#[async_trait::async_trait]
impl Persistence for SqlitePersistence {
    fn mode(&self) -> &'static str {
        "sqlite"
    }

    async fn save_usage(&self, record: &UsageRecord) -> Result<(), String> {
        let rec = record.clone();
        let conn = self.conn.clone();
        // rusqlite is sync; move the insert off the async worker threads.
        tokio::task::spawn_blocking(move || {
            let guard = conn.lock().unwrap_or_else(|p| p.into_inner());
            guard
                .execute(
                    r#"
                    INSERT INTO usage_records
                        (ts, api_key, owner, team, requested_model, provider, model,
                         upstream_account, prompt_tokens, completion_tokens,
                         total_tokens, cost_usd, latency_ms)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                    "#,
                    rusqlite::params![
                        rec.timestamp.to_rfc3339(),
                        rec.api_key,
                        rec.owner,
                        rec.team,
                        rec.requested_model,
                        rec.provider,
                        rec.model,
                        rec.upstream_account,
                        rec.prompt_tokens as i64,
                        rec.completion_tokens as i64,
                        rec.total_tokens as i64,
                        rec.cost_usd,
                        rec.latency_ms as i64,
                    ],
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn count_usage(&self) -> Result<u64, String> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let guard = conn.lock().unwrap_or_else(|p| p.into_inner());
            guard
                .query_row("SELECT COUNT(*) FROM usage_records", [], |row| {
                    row.get::<_, i64>(0)
                })
                .map(|v| v as u64)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn load_keys(&self) -> Result<Vec<KeyConfig>, String> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let guard = conn.lock().unwrap_or_else(|p| p.into_inner());
            let mut stmt = guard
                .prepare(
                    "SELECT key, owner, allowed_models, allowed_providers, rpm,
                            monthly_budget_usd, team FROM virtual_keys",
                )
                .map_err(|e| e.to_string())?;

            let rows = stmt
                .query_map([], |row| {
                    Ok(DecodedKey {
                        key: row.get(0)?,
                        owner: row.get(1)?,
                        allowed_models: row.get::<_, Option<String>>(2)?,
                        allowed_providers: row.get(3)?,
                        rpm: row.get(4)?,
                        monthly_budget_usd: row.get(5)?,
                        team: row.get(6)?,
                    })
                })
                .map_err(|e| e.to_string())?;

            let mut out = Vec::new();
            for row in rows {
                let DecodedKey {
                    key,
                    owner,
                    allowed_models,
                    allowed_providers,
                    rpm,
                    monthly_budget_usd,
                    team,
                } = row.map_err(|e| e.to_string())?;

                let allowed_models: Option<Vec<String>> = allowed_models
                    .and_then(|s| serde_json::from_str(&s).ok());
                out.push(KeyConfig {
                    key,
                    owner,
                    allowed_models: allowed_models.unwrap_or_else(|| vec!["*".to_string()]),
                    allowed_providers: allowed_providers
                        .and_then(|s| serde_json::from_str(&s).ok()),
                    rpm: rpm.map(|v| v as usize),
                    monthly_budget_usd,
                    team,
                });
            }
            Ok(out)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn upsert_key(&self, cfg: &KeyConfig) -> Result<(), String> {
        let c = cfg.clone();
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let guard = conn.lock().unwrap_or_else(|p| p.into_inner());
            guard
                .execute(
                    r#"
                    INSERT INTO virtual_keys
                        (key, owner, allowed_models, allowed_providers, rpm, monthly_budget_usd, team)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                    ON CONFLICT(key) DO UPDATE SET
                        owner = excluded.owner,
                        allowed_models = excluded.allowed_models,
                        allowed_providers = excluded.allowed_providers,
                        rpm = excluded.rpm,
                        monthly_budget_usd = excluded.monthly_budget_usd,
                        team = excluded.team
                    "#,
                    rusqlite::params![
                        c.key,
                        c.owner,
                        serde_json::to_string(&c.allowed_models).unwrap_or_else(|_| "[]".into()),
                        c.allowed_providers
                            .as_ref()
                            .map(|v| serde_json::to_string(v).ok()),
                        c.rpm.map(|v| v as i64),
                        c.monthly_budget_usd,
                        c.team,
                    ],
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn delete_key(&self, key: &str) -> Result<(), String> {
        let k = key.to_string();
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let guard = conn.lock().unwrap_or_else(|p| p.into_inner());
            guard
                .execute("DELETE FROM virtual_keys WHERE key = ?1", rusqlite::params![k])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn count_keys(&self) -> Result<u64, String> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let guard = conn.lock().unwrap_or_else(|p| p.into_inner());
            guard
                .query_row("SELECT COUNT(*) FROM virtual_keys", [], |row| {
                    row.get::<_, i64>(0)
                })
                .map(|v| v as u64)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn query_usage(&self, query: &UsageQuery) -> Result<Vec<serde_json::Value>, String> {
        let q = query.clone();
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let guard = conn.lock().unwrap_or_else(|p| p.into_inner());
            let since = q.since_rfc3339.clone();

            // Filters are combined (api_key + owner + team can stack), so the
            // WHERE clause is assembled from AND-ed predicates with positional
            // params appended in the same order: [since, api_key?, owner?, team?].
            let mut preds: Vec<String> = vec!["ts >= ?1".to_string()];
            let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(since.clone())];
            if let Some(key) = &q.api_key {
                preds.push(format!("api_key = ?{}", params.len() + 1));
                params.push(Box::new(key.clone()));
            }
            if let Some(owner) = &q.owner {
                preds.push(format!("owner = ?{}", params.len() + 1));
                params.push(Box::new(owner.clone()));
            }
            if let Some(team) = &q.team {
                // `team` was denormalized onto usage_records; the sub-query on
                // virtual_keys stays as a fallback for rows written before the
                // column existed (or with a rotated key).
                preds.push(format!(
                    "(team = ?{} OR api_key IN (SELECT key FROM virtual_keys WHERE team = ?{}))",
                    params.len() + 1,
                    params.len() + 1
                ));
                params.push(Box::new(team.clone()));
            }
            let where_sql = format!("WHERE {}", preds.join(" AND "));

            // Executor shared by every variant: run `sql` with the bound
            // filters and map rows through `mapper`.
            let exec = |sql: &str,
                        mapper: Box<dyn Fn(&rusqlite::Row<'_>) -> rusqlite::Result<serde_json::Value>>|
             -> rusqlite::Result<Vec<serde_json::Value>> {
                let mut stmt = guard.prepare(sql)?;
                let bound: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
                let mut rows = stmt.query(bound.as_slice())?;
                let mut out = Vec::new();
                while let Some(row) = rows.next()? {
                    out.push(mapper(row)?);
                }
                Ok(out)
            };

            let agg_cols =
                "COUNT(*) AS requests,
                 SUM(prompt_tokens) AS prompt_tokens,
                 SUM(completion_tokens) AS completion_tokens,
                 SUM(cost_usd) AS cost_usd";

            let sql: String;
            let mapper: Box<dyn Fn(&rusqlite::Row<'_>) -> rusqlite::Result<serde_json::Value>>;

            match q.group.as_deref() {
                Some("day") => {
                    sql = format!(
                        "SELECT strftime('%Y-%m-%d', ts) AS bucket, {agg_cols}
                         FROM usage_records {where_sql}
                         GROUP BY bucket ORDER BY bucket"
                    );
                    mapper = Box::new(|row: &rusqlite::Row<'_>| -> rusqlite::Result<serde_json::Value> {
                        Ok(json!({
                            "bucket": row.get::<_, Option<String>>("bucket")?.unwrap_or_default(),
                            "requests": row.get::<_, i64>("requests")?,
                            "prompt_tokens": row.get::<_, Option<i64>>("prompt_tokens")?.unwrap_or(0),
                            "completion_tokens": row.get::<_, Option<i64>>("completion_tokens")?.unwrap_or(0),
                            "cost_usd": row.get::<_, Option<f64>>("cost_usd")?.unwrap_or(0.0),
                        }))
                    });
                }
                Some("key") => {
                    sql = format!(
                        "SELECT api_key, owner, {agg_cols}
                         FROM usage_records {where_sql}
                         GROUP BY api_key, owner ORDER BY cost_usd DESC"
                    );
                    mapper = Box::new(|row: &rusqlite::Row<'_>| -> rusqlite::Result<serde_json::Value> {
                        Ok(json!({
                            "api_key": row.get::<_, String>("api_key")?,
                            "owner": row.get::<_, String>("owner")?,
                            "requests": row.get::<_, i64>("requests")?,
                            "prompt_tokens": row.get::<_, Option<i64>>("prompt_tokens")?.unwrap_or(0),
                            "completion_tokens": row.get::<_, Option<i64>>("completion_tokens")?.unwrap_or(0),
                            "cost_usd": row.get::<_, Option<f64>>("cost_usd")?.unwrap_or(0.0),
                        }))
                    });
                }
                Some("team") => {
                    sql = format!(
                        "SELECT COALESCE(team, '') AS team, {agg_cols}
                         FROM usage_records {where_sql}
                         GROUP BY team ORDER BY cost_usd DESC"
                    );
                    mapper = Box::new(|row: &rusqlite::Row<'_>| -> rusqlite::Result<serde_json::Value> {
                        Ok(json!({
                            "team": row.get::<_, String>("team")?,
                            "requests": row.get::<_, i64>("requests")?,
                            "prompt_tokens": row.get::<_, Option<i64>>("prompt_tokens")?.unwrap_or(0),
                            "completion_tokens": row.get::<_, Option<i64>>("completion_tokens")?.unwrap_or(0),
                            "cost_usd": row.get::<_, Option<f64>>("cost_usd")?.unwrap_or(0.0),
                        }))
                    });
                }
                Some("owner") => {
                    sql = format!(
                        "SELECT owner, COALESCE(team, '') AS team, {agg_cols}
                         FROM usage_records {where_sql}
                         GROUP BY owner, team ORDER BY cost_usd DESC"
                    );
                    mapper = Box::new(|row: &rusqlite::Row<'_>| -> rusqlite::Result<serde_json::Value> {
                        Ok(json!({
                            "owner": row.get::<_, String>("owner")?,
                            "team": row.get::<_, String>("team")?,
                            "requests": row.get::<_, i64>("requests")?,
                            "prompt_tokens": row.get::<_, Option<i64>>("prompt_tokens")?.unwrap_or(0),
                            "completion_tokens": row.get::<_, Option<i64>>("completion_tokens")?.unwrap_or(0),
                            "cost_usd": row.get::<_, Option<f64>>("cost_usd")?.unwrap_or(0.0),
                        }))
                    });
                }
                Some("provider") => {
                    sql = format!(
                        "SELECT provider, {agg_cols}
                         FROM usage_records {where_sql}
                         GROUP BY provider ORDER BY cost_usd DESC"
                    );
                    mapper = Box::new(|row: &rusqlite::Row<'_>| -> rusqlite::Result<serde_json::Value> {
                        Ok(json!({
                            "provider": row.get::<_, String>("provider")?,
                            "requests": row.get::<_, i64>("requests")?,
                            "prompt_tokens": row.get::<_, Option<i64>>("prompt_tokens")?.unwrap_or(0),
                            "completion_tokens": row.get::<_, Option<i64>>("completion_tokens")?.unwrap_or(0),
                            "cost_usd": row.get::<_, Option<f64>>("cost_usd")?.unwrap_or(0.0),
                        }))
                    });
                }
                Some("account") => {
                    sql = format!(
                        "SELECT provider, upstream_account, {agg_cols}
                         FROM usage_records {where_sql}
                         GROUP BY provider, upstream_account ORDER BY cost_usd DESC"
                    );
                    mapper = Box::new(|row: &rusqlite::Row<'_>| -> rusqlite::Result<serde_json::Value> {
                        Ok(json!({
                            "provider": row.get::<_, String>("provider")?,
                            "account": row.get::<_, String>("upstream_account")?,
                            "requests": row.get::<_, i64>("requests")?,
                            "prompt_tokens": row.get::<_, Option<i64>>("prompt_tokens")?.unwrap_or(0),
                            "completion_tokens": row.get::<_, Option<i64>>("completion_tokens")?.unwrap_or(0),
                            "cost_usd": row.get::<_, Option<f64>>("cost_usd")?.unwrap_or(0.0),
                        }))
                    });
                }
                Some("model") => {
                    sql = format!(
                        "SELECT provider, model, {agg_cols}
                         FROM usage_records {where_sql}
                         GROUP BY provider, model ORDER BY cost_usd DESC"
                    );
                    mapper = Box::new(|row: &rusqlite::Row<'_>| -> rusqlite::Result<serde_json::Value> {
                        Ok(json!({
                            "provider": row.get::<_, String>("provider")?,
                            "model": row.get::<_, String>("model")?,
                            "requests": row.get::<_, i64>("requests")?,
                            "prompt_tokens": row.get::<_, Option<i64>>("prompt_tokens")?.unwrap_or(0),
                            "completion_tokens": row.get::<_, Option<i64>>("completion_tokens")?.unwrap_or(0),
                            "cost_usd": row.get::<_, Option<f64>>("cost_usd")?.unwrap_or(0.0),
                        }))
                    });
                }
                _ => {
                    sql = format!(
                        "SELECT ts, api_key, owner, team, requested_model, provider, model,
                                upstream_account, prompt_tokens, completion_tokens,
                                total_tokens, cost_usd, latency_ms
                         FROM usage_records {where_sql}
                         ORDER BY ts DESC LIMIT {}",
                        q.limit.min(1000)
                    );
                    mapper = Box::new(|row: &rusqlite::Row<'_>| -> rusqlite::Result<serde_json::Value> {
                        Ok(json!({
                            "ts": row.get::<_, String>("ts")?,
                            "api_key": row.get::<_, String>("api_key")?,
                            "owner": row.get::<_, String>("owner")?,
                            "team": row.get::<_, Option<String>>("team")?,
                            "requested_model": row.get::<_, String>("requested_model")?,
                            "provider": row.get::<_, String>("provider")?,
                            "model": row.get::<_, String>("model")?,
                            "upstream_account": row.get::<_, String>("upstream_account")?,
                            "prompt_tokens": row.get::<_, i64>("prompt_tokens")?,
                            "completion_tokens": row.get::<_, i64>("completion_tokens")?,
                            "total_tokens": row.get::<_, i64>("total_tokens")?,
                            "cost_usd": row.get::<_, f64>("cost_usd")?,
                            "latency_ms": row.get::<_, i64>("latency_ms")?,
                        }))
                    });
                }
            }

            exec(&sql, mapper).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn sum_cost_since(
        &self,
        api_key: Option<&str>,
        since_rfc3339: &str,
    ) -> Result<f64, String> {
        let conn = self.conn.clone();
        let key = api_key.map(|s| s.to_string());
        let since = since_rfc3339.to_string();
        tokio::task::spawn_blocking(move || {
            let guard = conn.lock().unwrap_or_else(|p| p.into_inner());
            let (cost, _n): (Option<f64>, i64) = if let Some(key) = &key {
                guard
                    .query_row(
                        "SELECT SUM(cost_usd), COUNT(*) FROM usage_records
                         WHERE ts >= ?1 AND api_key = ?2",
                        rusqlite::params![since, key],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(|e| e.to_string())?
            } else {
                guard
                    .query_row(
                        "SELECT SUM(cost_usd), COUNT(*) FROM usage_records WHERE ts >= ?1",
                        rusqlite::params![since],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(|e| e.to_string())?
            };
            Ok(cost.unwrap_or(0.0).max(0.0))
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

struct DecodedKey {
    key: String,
    owner: String,
    allowed_models: Option<String>,
    allowed_providers: Option<String>,
    rpm: Option<i64>,
    monthly_budget_usd: Option<f64>,
    team: Option<String>,
}
