//! PostgreSQL persistence (requires the `full` cargo feature).

use serde_json::json;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use sqlx::Row;

use crate::config::KeyConfig;
use crate::persistence::{Persistence, UsageQuery};
use crate::tracking::usage::UsageRecord;

pub struct PostgresPersistence {
    pool: PgPool,
}

impl PostgresPersistence {
    pub async fn connect(url: &str) -> Result<Self, String> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect(url)
            .await
            .map_err(|e| e.to_string())?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS usage_records (
                id BIGSERIAL PRIMARY KEY,
                ts TIMESTAMPTZ NOT NULL,
                api_key TEXT NOT NULL,
                owner TEXT NOT NULL,
                requested_model TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                upstream_account TEXT NOT NULL,
                prompt_tokens INTEGER NOT NULL,
                completion_tokens INTEGER NOT NULL,
                total_tokens INTEGER NOT NULL,
                cost_usd DOUBLE PRECISION NOT NULL,
                latency_ms BIGINT NOT NULL
            )
            "#,
        )
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS virtual_keys (
                key TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                allowed_models JSONB NOT NULL DEFAULT '[]',
                allowed_providers JSONB,
                rpm INTEGER,
                monthly_budget_usd DOUBLE PRECISION,
                team TEXT
            )
            "#,
        )
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

        // Additive migration for databases created before teams existed.
        sqlx::query("ALTER TABLE virtual_keys ADD COLUMN IF NOT EXISTS team TEXT")
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_vk_team ON virtual_keys(team)")
            .execute(&pool)
            .await
            .map_err(|e| e.to_string())?;

        tracing::info!("PostgreSQL schema verified");
        Ok(Self { pool })
    }
}

#[async_trait::async_trait]
impl Persistence for PostgresPersistence {
    fn mode(&self) -> &'static str {
        "postgres"
    }

    async fn save_usage(&self, record: &UsageRecord) -> Result<(), String> {
        sqlx::query(
            r#"
            INSERT INTO usage_records
                (ts, api_key, owner, requested_model, provider, model,
                 upstream_account, prompt_tokens, completion_tokens,
                 total_tokens, cost_usd, latency_ms)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            "#,
        )
        .bind(record.timestamp)
        .bind(&record.api_key)
        .bind(&record.owner)
        .bind(&record.requested_model)
        .bind(&record.provider)
        .bind(&record.model)
        .bind(&record.upstream_account)
        .bind(record.prompt_tokens as i32)
        .bind(record.completion_tokens as i32)
        .bind(record.total_tokens as i32)
        .bind(record.cost_usd)
        .bind(record.latency_ms as i64)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn count_usage(&self) -> Result<u64, String> {
        let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM usage_records")
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(row.0 as u64)
    }

    async fn load_keys(&self) -> Result<Vec<KeyConfig>, String> {
        let rows: Vec<(
            String,
            String,
            sqlx::types::Json<Vec<String>>,
            Option<sqlx::types::Json<Vec<String>>>,
            Option<i32>,
            Option<f64>,
            Option<String>,
        )> = sqlx::query_as(
            "SELECT key, owner, allowed_models, allowed_providers, rpm, monthly_budget_usd, team
             FROM virtual_keys",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        Ok(rows
            .into_iter()
            .map(|(key, owner, models, providers, rpm, budget, team)| KeyConfig {
                key,
                owner,
                allowed_models: models.0,
                allowed_providers: providers.map(|v| v.0),
                rpm: rpm.map(|v| v as usize),
                monthly_budget_usd: budget,
                team,
            })
            .collect())
    }

    async fn upsert_key(&self, cfg: &KeyConfig) -> Result<(), String> {
        use sqlx::types::Json;

        sqlx::query(
            r#"
            INSERT INTO virtual_keys
                (key, owner, allowed_models, allowed_providers, rpm, monthly_budget_usd, team)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (key) DO UPDATE SET
                owner = excluded.owner,
                allowed_models = excluded.allowed_models,
                allowed_providers = excluded.allowed_providers,
                rpm = excluded.rpm,
                monthly_budget_usd = excluded.monthly_budget_usd,
                team = excluded.team
            "#,
        )
        .bind(&cfg.key)
        .bind(&cfg.owner)
        .bind(Json(cfg.allowed_models.clone()))
        .bind(cfg.allowed_providers.as_ref().map(Json))
        .bind(cfg.rpm.map(|v| v as i32))
        .bind(cfg.monthly_budget_usd)
        .bind(&cfg.team)
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn delete_key(&self, key: &str) -> Result<(), String> {
        sqlx::query("DELETE FROM virtual_keys WHERE key = $1")
            .bind(key)
            .execute(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn count_keys(&self) -> Result<u64, String> {
        let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM virtual_keys")
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(row.0 as u64)
    }

    async fn query_usage(&self, query: &UsageQuery) -> Result<Vec<serde_json::Value>, String> {
        let since: chrono::DateTime<chrono::Utc> = query
            .since_rfc3339
            .parse()
            .map_err(|e| format!("bad since timestamp: {e}"))?;

        // All four filters are always bound (NULL = no-op) so every branch
        // shares one placeholder numbering.
        let where_sql = "WHERE ts >= $1 \
             AND ($2::text IS NULL OR api_key = $2) \
             AND ($3::text IS NULL OR owner = $3) \
             AND ($4::text IS NULL OR api_key IN (SELECT key FROM virtual_keys WHERE team = $4))";

        let agg_cols =
            "COUNT(*) AS requests,
             SUM(prompt_tokens) AS prompt_tokens,
             SUM(completion_tokens) AS completion_tokens,
             SUM(cost_usd) AS cost_usd";

        match query.group.as_deref() {
            Some("day") => {
                let sql = format!(
                    "SELECT date_trunc('day', ts)::text AS bucket, {agg_cols}
                     FROM usage_records {where_sql}
                     GROUP BY bucket
                     ORDER BY bucket"
                );
                let exec = sqlx::query(&sql)
                    .bind(since)
                    .bind(query.api_key.as_deref())
                    .bind(query.owner.as_deref())
                    .bind(query.team.as_deref());
                let rows = exec
                    .fetch_all(&self.pool)
                    .await
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .map(|r| {
                        Ok(json!({
                            "bucket": r.try_get::<Option<String>, _>(0).map_err(|e| e.to_string())?,
                            "requests": r.try_get::<i64, _>(1).map_err(|e| e.to_string())?,
                            "prompt_tokens": r.try_get::<Option<i64>, _>(2).map_err(|e| e.to_string())?.unwrap_or(0),
                            "completion_tokens": r.try_get::<Option<i64>, _>(3).map_err(|e| e.to_string())?.unwrap_or(0),
                            "cost_usd": r.try_get::<Option<f64>, _>(4).map_err(|e| e.to_string())?.unwrap_or(0.0),
                        }))
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                Ok(rows)
            }
            Some("key") => {
                let sql = format!(
                    "SELECT api_key, owner, {agg_cols}
                     FROM usage_records {where_sql}
                     GROUP BY api_key, owner ORDER BY cost_usd DESC"
                );
                let exec = sqlx::query(&sql)
                    .bind(since)
                    .bind(query.api_key.as_deref())
                    .bind(query.owner.as_deref())
                    .bind(query.team.as_deref());
                let rows = exec
                    .fetch_all(&self.pool)
                    .await
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .map(|r| {
                        Ok(json!({
                            "api_key": r.try_get::<String, _>(0).map_err(|e| e.to_string())?,
                            "owner": r.try_get::<String, _>(1).map_err(|e| e.to_string())?,
                            "requests": r.try_get::<i64, _>(2).map_err(|e| e.to_string())?,
                            "prompt_tokens": r.try_get::<Option<i64>, _>(3).map_err(|e| e.to_string())?.unwrap_or(0),
                            "completion_tokens": r.try_get::<Option<i64>, _>(4).map_err(|e| e.to_string())?.unwrap_or(0),
                            "cost_usd": r.try_get::<Option<f64>, _>(5).map_err(|e| e.to_string())?.unwrap_or(0.0),
                        }))
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                Ok(rows)
            }
            Some("provider") | Some("model") => {
                let (sql, dims) = if query.group.as_deref() == Some("provider") {
                    (
                        format!(
                            "SELECT provider, {agg_cols}
                             FROM usage_records {where_sql}
                             GROUP BY provider ORDER BY cost_usd DESC"
                        ),
                        1usize,
                    )
                } else {
                    (
                        format!(
                            "SELECT provider, model, {agg_cols}
                             FROM usage_records {where_sql}
                             GROUP BY provider, model ORDER BY cost_usd DESC"
                        ),
                        2usize,
                    )
                };
                let exec = sqlx::query(&sql)
                    .bind(since)
                    .bind(query.api_key.as_deref())
                    .bind(query.owner.as_deref())
                    .bind(query.team.as_deref());
                let rows = exec
                    .fetch_all(&self.pool)
                    .await
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .map(|r| {
                        let mut obj = serde_json::Map::new();
                        for idx in 0..dims {
                            let v: String = r.try_get(idx).map_err(|e| e.to_string())?;
                            obj.insert(
                                if idx == 0 { "provider".into() } else { "model".into() },
                                json!(v),
                            );
                        }
                        obj.insert("requests".into(), json!(r.try_get::<i64, _>(dims).map_err(|e| e.to_string())?));
                        obj.insert("prompt_tokens".into(), json!(r.try_get::<Option<i64>, _>(dims + 1).map_err(|e| e.to_string())?.unwrap_or(0)));
                        obj.insert("completion_tokens".into(), json!(r.try_get::<Option<i64>, _>(dims + 2).map_err(|e| e.to_string())?.unwrap_or(0)));
                        obj.insert("cost_usd".into(), json!(r.try_get::<Option<f64>, _>(dims + 3).map_err(|e| e.to_string())?.unwrap_or(0.0)));
                        Ok(serde_json::Value::Object(obj))
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                Ok(rows)
            }
            _ => {
                let sql = format!(
                    "SELECT ts::text, api_key, owner, requested_model, provider, model,
                            upstream_account, prompt_tokens, completion_tokens,
                            total_tokens, cost_usd, latency_ms
                     FROM usage_records {where_sql}
                     ORDER BY ts DESC LIMIT {}",
                    query.limit.min(1000)
                );
                let exec = sqlx::query(&sql)
                    .bind(since)
                    .bind(query.api_key.as_deref())
                    .bind(query.owner.as_deref())
                    .bind(query.team.as_deref());
                let rows = exec
                    .fetch_all(&self.pool)
                    .await
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .map(|r| {
                        Ok(json!({
                            "ts": r.try_get::<String, _>(0).map_err(|e| e.to_string())?,
                            "api_key": r.try_get::<String, _>(1).map_err(|e| e.to_string())?,
                            "owner": r.try_get::<String, _>(2).map_err(|e| e.to_string())?,
                            "requested_model": r.try_get::<String, _>(3).map_err(|e| e.to_string())?,
                            "provider": r.try_get::<String, _>(4).map_err(|e| e.to_string())?,
                            "model": r.try_get::<String, _>(5).map_err(|e| e.to_string())?,
                            "upstream_account": r.try_get::<String, _>(6).map_err(|e| e.to_string())?,
                            "prompt_tokens": r.try_get::<i32, _>(7).map_err(|e| e.to_string())?,
                            "completion_tokens": r.try_get::<i32, _>(8).map_err(|e| e.to_string())?,
                            "total_tokens": r.try_get::<i32, _>(9).map_err(|e| e.to_string())?,
                            "cost_usd": r.try_get::<f64, _>(10).map_err(|e| e.to_string())?,
                            "latency_ms": r.try_get::<i64, _>(11).map_err(|e| e.to_string())?,
                        }))
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                Ok(rows)
            }
        }
    }

    async fn sum_cost_since(
        &self,
        api_key: Option<&str>,
        since_rfc3339: &str,
    ) -> Result<f64, String> {
        let since: chrono::DateTime<chrono::Utc> = since_rfc3339
            .parse()
            .map_err(|e| format!("bad since timestamp: {e}"))?;
        let (cost,): (Option<f64>,) = if let Some(key) = api_key {
            sqlx::query_as(
                "SELECT SUM(cost_usd) FROM usage_records WHERE ts >= $1 AND api_key = $2",
            )
            .bind(since)
            .bind(key)
            .fetch_one(&self.pool)
            .await
            .map_err(|e| e.to_string())?
        } else {
            sqlx::query_as("SELECT SUM(cost_usd) FROM usage_records WHERE ts >= $1")
                .bind(since)
                .fetch_one(&self.pool)
                .await
                .map_err(|e| e.to_string())?
        };
        Ok(cost.unwrap_or(0.0).max(0.0))
    }
}
