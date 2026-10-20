# LLM Router — Docker usage

## Build & run with docker compose

```bash
docker compose up --build
```

- Dashboard: http://localhost:3000 — login `admin / admin123`
- Router API: http://localhost:8080

## Build images individually

```bash
# Rust router
docker build -t llm-router .
docker run -p 8080:8080 -v llm-router-data:/app/data llm-router

# Next.js dashboard
docker build -f web/Dockerfile -t llm-router-web ./web
docker run -p 3000:3000 -e ADMIN_API_KEY=dev-admin -e AUTH_SECRET=change-me -e ROUTER_URL=http://host.docker.internal:8080 llm-router-web
```

## Production notes

- **Secrets**: change `ADMIN_API_KEY`, `AUTH_SECRET`, `security.admin_key` (config/default.yaml) and the default admin password before exposing publicly.
- **Persistence**: mount volumes for `/app/data` (router: SQLite DB + connections.json; web: users.json/teams.json) so state survives restarts.
- **Postgres/redis**: enable with `--build-arg FEATURES=full` and set `database.mode: postgres` (plus `url`).
- **Upstream keys**: `data/connections.json` is intentionally NOT baked into the image — configure providers via the UI (Providers page) on first start.
- **OAuth (Claude)**: the OAuth flow needs the browser to reach the dashboard over HTTPS and the router to be reachable; run behind a reverse proxy in production.
