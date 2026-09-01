# All-in-one image: dashboard (:8080) + headless trading runner (:8090
# health endpoint) supervised inside ONE container by docker/supervisor.mjs.
# Neon is the canonical DB; Supabase is a best-effort mirror/fallback, so the
# container stays fully operational even when the Supabase project is down.
FROM node:22-alpine

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install dependencies (dev deps included — vite serves the dashboard and tsx
# drives the runner at run time)
RUN npm config set fetch-retries 5 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm install --include=dev

# Copy application source
COPY . .

# Node 22's happy-eyeballs default (250ms per connection attempt) is too
# aggressive for some VPS/VPN networks and makes Neon/Bybit fetches flap.
ENV NODE_OPTIONS="--network-family-autoselection-attempt-timeout=3000"

EXPOSE 8080 8090

# Healthy only when BOTH halves respond: dashboard HTTP 200 and the runner's
# /health (which itself goes 503 if the engine stops ticking for >60s).
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "Promise.all([fetch('http://localhost:8080/').then(r=>{if(!r.ok)throw 0}),fetch('http://localhost:8090/health').then(r=>{if(!r.ok)throw 0})]).then(()=>process.exit(0),()=>process.exit(1))"

# All credentials (DATABASE_URL, SUPABASE_*, RUNNER_*, BYBIT_*) are supplied
# at run time via env_file — nothing secret is baked into the image.
CMD ["node", "docker/supervisor.mjs"]
