# LLM Router (Rust backend) — multi-stage build.
# Build:  docker build -t llm-router .
# Run:    docker run -p 8080:8080 -v llm-router-data:/app/data llm-router

# ---- build ---------------------------------------------------------------
FROM rust:1-slim AS builder

# Build deps (needed to compile/link, incl. the bundled SQLite C driver)
RUN apt-get update && apt-get install -y --no-install-recommends \
      pkg-config gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Cache dependencies: copy manifests first, fetch, then copy sources.
COPY Cargo.toml Cargo.lock* ./
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs && cargo fetch

COPY src ./src

# Release build (default features). Use `--features full` for postgres/redis:
#   docker build --build-arg FEATURES=full -t llm-router .
ARG FEATURES=""
RUN cargo build --release ${FEATURES:+--features $FEATURES} \
    && cp target/release/llm-router /build/llm-router

# ---- runtime --------------------------------------------------------------
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -r -u 10001 -m router

WORKDIR /app
COPY --from=builder /build/llm-router /app/llm-router
COPY config /app/config
RUN mkdir -p /app/data && chown -R router:router /app

USER router

ENV RUST_LOG=info
EXPOSE 8080

# Config is read from /app/config/default.yaml (mount to override);
# runtime state (SQLite DB, connections.json, hub.json) lives in /app/data —
# mount a volume there so keys/usage survive container restarts.
VOLUME ["/app/data"]
ENTRYPOINT ["/app/llm-router"]
