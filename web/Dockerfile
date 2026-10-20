# LLM Router dashboard (Next.js 16) — multi-stage standalone build.
# Build:  docker build -f web/Dockerfile -t llm-router-web ./web
# Run:    docker run -p 3000:3000 llm-router-web

# ---- deps ---------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# npm install (no npm ci to tolerate lockfile drift)
RUN npm install --include=dev --no-audit --no-fund

# ---- build --------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runtime ------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone server + static assets
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Persisted identity store (admin/alice/bob seed) — mount a volume to override.
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "server.js"]
