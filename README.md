# LLM Router

High-performance LLM routing proxy written in Rust, inspired by LiteLLM and 9router.

Includes a Next.js + TypeScript + Tailwind admin dashboard in `web/`
(login with 3 roles — admin / team_lead / user — teams, per-team providers,
key management, charts, usage history, chat playground) — all
admin API calls are proxied server-side so the browser never sees the router
admin key. Details in `web/README.md`.

## Features

- **Multi-provider support**: OpenAI, Anthropic, Google Gemini
- **Cost-optimized routing**: Routes to the cheapest provider supporting the requested model
- **Latency-based routing**: Optional `latency_first` strategy routes by measured (EMA) endpoint latency with automatic exploration of unmeasured providers
- **Response caching**: Exact-match cache for non-streaming requests (TTL + capacity), tracked through `cache_hits`
- **OpenAI-compatible API**: Drop-in replacement for OpenAI client libraries
- **Retry & Fallback**: Exponential backoff on transient errors, fall back to next provider on failure
- **Upstream account pools**: Multiple API-key accounts per provider with priority tiers, smooth *weighted* round-robin rotation and adaptive per-account cooldown on 429 (60s × 2^streak, capped 10 min)
- **Runtime key management**: Add/delete virtual keys live via `POST /admin/keys` and `POST /admin/keys/delete` (auth latch never auto-opens)
- **Transparent model fallback (aliases)**: When a model/account is rate limited, requests continue on the next provider/model from the configured alias list — the client keeps its model id
- **Virtual keys & multi-tenancy**: Client-facing API keys with owner, team, per-key allowed models (globs), allowed providers and per-key RPM; usage stats per key/owner/provider/model
- **Team scoping (data plane)**: `Connection.team` marks a dashboard-configured provider as owned by one team; a key with `team` only routes through that team's connections (fail-closed: a team with no connections routes nowhere). Usage/history/requests can be filtered by `owner` and `team` on the admin API
- **Per-key budgets**: `monthly_budget_usd` caps spend per *calendar month* (UTC); over-budget requests are rejected with `402` before hitting upstream (streaming included). With `database.mode: sqlite/postgres` the monthly spend is summed from durable `usage_records`, so budgets survive restarts and reset every month; without persistence it falls back to per-month in-memory aggregates
- **Circuit breaker**: Stops hammering failing providers; auto-recovers after cooldown
- **Streaming (SSE)**: Provider-specific streams are converted to OpenAI chunk format live
- **Rate limiting**: Sliding-window per client IP plus per-key overrides
- **Auth**: Virtual keys (Bearer), legacy allow-list, admin master key for `/admin/*`
- **Observability**: Prometheus metrics + cost/usage breakdown
- **High performance**: Built with Rust and Tokio for minimal latency overhead

## Quick Start

### Installation

1. Clone the repository
2. Copy `.env.example` to `.env` and add your provider API keys
3. Build and run:

```bash
cargo build --release
cargo run
```

### Configuration

Edit `config/default.yaml` to configure providers, models, routing strategy and security.

Environment overrides use the `LLM_ROUTER__` prefix with `__` as path separator, e.g.
`LLM_ROUTER__SECURITY__REQUESTS_PER_MINUTE=10`.

### Multi-tenancy & account pools

**Upstream accounts (quota pooling)** — one provider can have several API keys.
Accounts are grouped into **priority tiers** (higher `priority` preferred),
accounts within a tier **rotate round-robin**, and a `429` puts an account on a
**60s cooldown** while the next tier/rotation order is tried — all transparent
to the client:

```yaml
providers:
  - name: openai
    accounts:
      - label: openai-main
        api_key: "${OPENAI_API_KEY}"
        priority: 10
      - label: openai-backup
        api_key: "${OPENAI_API_KEY_2}"
        priority: 5
```

**Transparent model fallback (aliases)** — when the primary target is rate
limited or missing quota, the request continues on the next `provider/model`
entry while the client keeps its model id:

```yaml
routing:
  aliases:
    premium: [openai/gpt-4, anthropic/claude-3-5-sonnet-20241022, google/gemini-1.5-pro]
    gpt-4:   [openai/gpt-4, google/gemini-1.5-pro]   # gpt-4 quota exhausted? use gemini
```

**Virtual keys (per-user authz & quota)** — define client-facing keys with
allowed models (glob patterns), allowed providers a per-key RPM and an
optional USD budget. Adding `team` restricts the key to that team's
dashboard connections (`/admin/connections` with `"team": ...`):

```yaml
keys:
  - key: sk-vk-alice
    owner: alice
    team: team-a          # optional: only team-a's connections + intersection with allowed_providers
    allowed_models: [gpt-4, gemini-*, premium]
    allowed_providers: [openai, google]
    rpm: 30
    monthly_budget_usd: 50   # monthly cap (UTC calendar month); 402 budget_exceeded when exceeded
```

Requests are accepted with `Authorization: Bearer sk-vk-alice`. Usage/cost is
tracked per key + owner at `GET /admin/stats`. Protect `/admin/*` with
`security.admin_key` (sent as `X-Admin-Key` header or standard Bearer).

Keys can also be managed live (auth latches on and never auto-opens):

```bash
# add or replace a key
curl -X POST http://localhost:8080/admin/keys \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"key":"sk-vk-carol","owner":"carol","allowed_models":["gemini-*"],"rpm":10}'

# remove a key
curl -X POST http://localhost:8080/admin/keys/delete \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"key":"sk-vk-carol"}'
```

**Latency-based routing** — set `routing.default_strategy: "latency_first"`.
Every provider serving a model is measured once (exploration, cheapest first),
afterward requests go to the provider with the lowest exponentially-weighted
average latency; samples keep updating on each call.

**Response cache** — enable `cache.enabled: true` to serve identical
non-streaming requests from memory (TTL seconds, bounded entries). Cache hits
are recorded as `cache_hits` in `/admin/stats` and bypass upstream completely.
Streaming requests are never cached.

**Semantic cache** — `semantic_cache.enabled: true` goes further: the
conversation text is embedded via the embeddings pipeline and a previous
response is served when cosine similarity of the incoming query is at least
`similarity_threshold`. Settings and behavior:

```yaml
semantic_cache:
  enabled: true
  similarity_threshold: 0.92   # 0..1, higher = stricter
  embedding_model: "text-embedding-3-small"
  ttl_seconds: 300
  max_entries: 100
```

- Lookups embed the chat request first (one extra upstream embeddings
  call per chat request, tracked under the `semantic-cache` system label)
- a hit returns the stored response with no chat-upstream call and bumps
  `semantic_cache_hits` in `/admin/stats`
- misses fall through to normal routing; the response's vector is stored
  for future lookups (TTL + FIFO eviction)
- the embedding call failing (e.g. no embedding provider) just disables
  caching for that request — chat routing continues normally
- streaming requests bypass both caches

**Persistence** (`database.mode`) — durable storage for usage records and
runtime-managed virtual keys, selectable per deployment:

```yaml
database:
  mode: "sqlite"              # "none" (default) | "sqlite" | "postgres"
  sqlite:
    path: "data/llm_router.db"
  # postgres:
  #   url: "${POSTGRES_URL}"  # requires `cargo build --features full`
```

- `none` (default): in-memory only, stats reset on restart
- `sqlite`: self-contained WAL file under `data/`
- `postgres`: needs the `full` cargo feature; DB errors fall back to
  in-memory with a logged error (the proxy keeps serving)
- Runtime keys added via the admin API are persisted and restored on
  startup (they win over identical YAML keys)
- `GET /admin/persistence` reports mode + record/key counts
- `GET /admin/history` queries the persisted `usage_records`:
  `group=raw` (latest records, `limit` capped 1000) or aggregates by
  `day` / `key` / `provider` / `model`, all filtered by `minutes` and
  optionally one `api_key`; with mode `none` it responds with an empty
  list and a note instead of an error

**Embeddings** — mark models with `kind: embedding` and route them through
`POST /v1/embeddings` (OpenAI wire format):

```yaml
models:
  - name: text-embedding-3-small
    kind: embedding          # routable via /v1/embeddings
    cost: { input_per_1m: 0.02, output_per_1m: 0.0 }
```

```bash
curl http://localhost:8080/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-3-small","input":["one","two"]}'
```

- Batches are executed element-by-element, each with the full
  account-rotation + cross-provider fallback (429 cooldown applies too)
- OpenAI (`text-embedding-*`) and Google (`text-embedding-004`,
  `embedContent`) are supported; Anthropic has no embeddings API and is
  excluded automatically
- Token usage is credited per input token; key globs
  (`allowed_models`/`allowed_providers`) and budgets apply as usual

## API

| Endpoint | Description | Auth |
|---|---|---|
| `POST /v1/chat/completions` | Chat completions (stream with `"stream": true`) | Client key (if configured) |
| `POST /v1/embeddings` | OpenAI-compatible embeddings with cross-provider rotation | Client key (if configured) |
| `GET /v1/models` | List available models (filtered by key permissions) | Client key (if configured) |
| `GET /health` | Health check | open |
| `GET /metrics` | Prometheus metrics | Client key (if configured) |
| `GET /admin/stats` | Cost & usage per provider/model and per key/owner | Admin key |
| `GET /admin/keys` | List configured virtual keys (key masked) | Admin key |
| `POST /admin/keys` | Add/replace a virtual key at runtime | Admin key |
| `POST /admin/keys/delete` | Delete a virtual key at runtime | Admin key |
| `GET /admin/accounts` | Upstream account-pool status (cooldowns, counters) | Admin key |
| `GET /admin/providers/:name/accounts` | View one provider's pool | Admin key |
| `POST /admin/providers/:name/accounts` | Add/replace an upstream account at runtime (label/api_key/priority/weight) | Admin key |
| `DELETE /admin/providers/:name/accounts/:label` | Remove a runtime account | Admin key |
| `GET /admin/history` | Raw/aggregate usage history from the DB (`?group=raw\|day\|key\|provider\|model&minutes=N&api_key=L&limit=M`) | Admin key |
| `GET /admin/config` | Current `config/default.yaml` (secrets masked as `__SAVED__`) | Admin key |
| `PUT /admin/config` | Persist edited config to YAML (backup `.bak`); `__SAVED__` keeps old secret; restart to apply | Admin key |
| `GET /admin/persistence` | Persistence mode + durable record/key counts | Admin key |

### Example (non-streaming)

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4", "messages": [{"role": "user", "content": "Hello"}]}'
```

The router picks the cheapest healthy provider that supports the requested model,
retries transient failures, and falls back to other providers when needed.

### Example (streaming)

```bash
curl -N http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gemini-1.5-flash", "messages": [{"role": "user", "content": "Hi"}], "stream": true}'
```

Provider-specific SSE formats (Anthropic events, Gemini `alt=sse`) are converted
on the fly into standard OpenAI `chat.completion.chunk` events.

## Testing verified behaviors

- Cross-provider fallback: `premium` alias expanded to `openai/gpt-4 → anthropic/claude-3-5-sonnet → google/gemini-1.5-pro`; each candidate tried in order
- Account rotation: first upstream account returns `429` → put in cooldown (~60s) → next account serves the request transparently (~13ms next request)
- Priority tiers: highest-priority accounts preferred; lower tiers only used while higher tiers are in cooldown
- Weighted rotation: accounts with weight 3:1 in one tier → exactly 6:2 request split (sequence A,A,B,A,A,A,B,A)
- Adaptive cooldown: 429 #1 → 60s cooldown; 429 #2 (after expiry) → 120s (`cooldown_remaining_ms` reflects it)
- Runtime key management: `POST /admin/keys` enables auth instantly; deleting the last key keeps auth ON (latched 401)
- SQLite persistence: 2 usage records → server restart → records count unchanged (`/admin/persistence`), runtime key restored from DB and usable; key delete also persisted
- `/v1/embeddings`: single input → 1 vector + `usage.prompt_tokens: 8`; batch `[a, b]` → 2 vectors + 16 tokens; chat model rejected (no embedding provider); key with `allowed_models: [text-embedding-*]` gets 200 on embeddings but `403` on chat
- Semantic cache: call 1 (miss) served by upstream, identical call 2 and call 3 both return the stored response id (`semantic_cache_hits: 2`); internal embeddings tracked under `semantic-cache/system` in `/admin/stats`
- History API: 3 chat calls with key `sk-hist-alice` survived a server restart in SQLite; `group=key` → `{api_key, owner, requests: 3, cost_usd}`, `group=day` → 1 bucket for today, `group=model` → per provider+model; `api_key` filter and invalid group (400) work; mode `none` → note instead of error
- 429 fails fast to rotation (no wasted backoff retries on the same account); 5xx/timeout retry with backoff
- Virtual keys: no key → `401`; wrong key → `401`; key without model permission → `403`; allowed key+model → `200`
- Per-key RPM: calls 1-5 → `200`, 6+ → `429` with `rpm: 5`
- Latency-first routing: 2 providers (fast ~3ms, slow 400ms) — call 1-2 explore each once, from call 3 onward always the fast provider (per-request: 2640ms → 3ms → 8ms)
- Response cache: identical request → first call misses (slow provider), second call returns same body in ~2ms; `cache_hits` = 1; stream requests bypass the cache
- Budget: key with `monthly_budget_usd` exceeded → `402` `budget_exceeded` (further calls on that key blocked, other keys unaffected)
- `/v1/models` filtered by the caller key's allowed models/providers
- `/admin/*` requires the admin key (X-Admin-Key header or Bearer)
- Runtime account management: `POST /admin/providers/openai/accounts`
  adds an account that enters weighted rotation immediately (priority tier,
  cooldown, 429 streak); DELETE removes it; unknown provider/label → 400
- Circuit opens after 5 consecutive failures per provider/model and skips later requests
- IP rate limiting returns `429` beyond the configured requests/minute

## Roadmap

- [x] Phase 1: MVP with 3 providers and cheapest-first routing
- [x] Phase 2: Retry logic, fallback chain, circuit breaker
- [x] Phase 3: Cost tracking, Prometheus metrics
- [x] Streaming SSE with provider format conversion
- [x] Rate limiting + Bearer auth
- [x] Upstream account pools (multi-account, weighted rotation, adaptive cooldown)
- [x] Virtual keys with per-key permissions + per-key usage stats
- [x] Runtime key management API (add/delete without restart)
- [x] Persistence: SQLite (bundled) + PostgreSQL (`--features full`), usage records & durable runtime keys
- [x] Transparent cross-provider model fallback (aliases)
- [x] Latency-based routing strategy (EMA + exploration)
- [x] Exact-match response cache (memory)
- [x] Semantic cache (embedding cosine similarity)
- [x] History API over persisted usage records (raw + day/key/provider/model aggregates)
- [x] Runtime account management API (add/remove upstream accounts, immediate rotation)
- [x] Per-key budget enforcement (402)
- [ ] Advanced strategies (budget-constrained routing, weighted sampling)
- [ ] Semantic caching (embedding similarity over cached responses)
- [ ] Persistence (PostgreSQL) & dynamic key management API

## License

MIT
