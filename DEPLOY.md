# VPS deploy

One container runs both halves (dashboard on `:8085`, runner health on
`:8090`), supervised by `docker/supervisor.mjs`. All state lives outside the
container — **Neon is canonical** (DB + auth), Supabase is an optional
fallback mirror and is not required — so the container is safe to replace at
any time.

Live layout on the current box:

| Item | Value |
| --- | --- |
| Project path | `/docker/alpha-swarm` |
| Compose project | `alpha-swarm` |
| Image | `ghcr.io/mo-101/swarm-signal-stream:latest` |
| Dashboard | `http://<host>:8085` |
| Dashboard health | `http://localhost:8085/api/public/health` |
| Runner health | `http://localhost:8090/health` |
| Persistent logs | `/docker/alpha-swarm/logs/{dashboard,runner}.log` |

## First-time setup

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER" && newgrp docker

git clone https://github.com/Mo-101/swarm-signal-stream.git /docker/alpha-swarm
cd /docker/alpha-swarm

cp .env.example .env
nano .env      # DATABASE_URL, LOCAL_AUTH_SECRET, RUNNER_EMAIL/PASSWORD, BYBIT_* ...
               # never commit this file; nothing from it is printed by any script

echo "$GHCR_PAT" | docker login ghcr.io -u Mo-101 --password-stdin   # while the package is private

./scripts/deploy-vps.sh
```

`deploy-vps.sh` does everything a fresh box needs, in order:

1. `docker compose config -q` preflight
2. creates `./logs`
3. pulls `ghcr.io/mo-101/swarm-signal-stream:latest` (`--build` builds locally instead)
4. **applies the Neon schema idempotently inside the pulled image**
   (`scripts/apply-schema.mjs src/lib/db/schema.sql`), and fails the deploy if
   `public.edge_report(uuid, text)` is missing afterwards — no more manual
   schema patching
5. `docker compose up -d`
6. waits up to 180 s for both health endpoints
7. on failure prints `compose ps`, the last 80 container log lines and the tail
   of `logs/runner.log` — never any secret value

Flags: `--build` (local build), `--no-schema` (skip step 4).

## Update / redeploy

```bash
cd /docker/alpha-swarm
git pull
./scripts/deploy-vps.sh
```

Panel-managed hosts that inject env vars instead of using a `.env` file can use
`vps-compose.yml` (identical, minus `env_file` and `container_name`).

## Verification

```bash
cd /docker/alpha-swarm
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps          # expect "healthy"
curl -s localhost:8090/health | jq                    # runner: status "running"
curl -s localhost:8085/api/public/health | jq         # full system probe
tail -f logs/runner.log
```

The runner writes to both Docker stdout and `logs/runner.log` on the host.
Dashboard logs are written to `logs/dashboard.log`. The supervisor rotates
those app logs at 20 MB, and Compose also limits Docker's JSON logs.

If deploy fails before the container starts with an `.env` or compose parse
error, check that `.env` contains only valid environment entries:

```bash
KEY=value
# comments are fine
```

Plain notes such as `schemas present: public, financial...` must be removed or
commented out, because Compose parses them as environment keys.

## Day-to-day

```bash
docker compose -f docker-compose.prod.yml logs -f          # both services
tail -f logs/dashboard.log logs/runner.log                 # host-side app logs
docker compose -f docker-compose.prod.yml restart          # bounce
docker compose -f docker-compose.prod.yml down             # stop
curl -s localhost:8090/health | jq                         # runner heartbeat
curl -s localhost:8085/api/public/health | jq              # full system probe
```
```

## Logs

Both halves write to stdout **and** to host-side files through the
`./logs:/app/logs` bind mount (`LOG_DIR=/app/logs`):

```bash
tail -f logs/runner.log        # trading engine
tail -f logs/dashboard.log     # web server
```

App-side files rotate at 20 MB (one generation kept) and survive container
replacement. The Docker json-file driver rotates separately at 10 MB × 5.

## Restart semantics

- The supervisor restarts each half independently with exponential backoff
  (1 s → 30 s), resetting after 2 minutes healthy.
- If one half crash-loops (>10 restarts in 10 minutes) the container exits and
  Docker's `restart: always` recreates it cleanly.
- `stop_grace_period: 20s` lets open work flush on redeploy.
- The image `HEALTHCHECK` requires *both* the dashboard and `/health` to
  answer, so `docker ps` reflects real engine liveness.

## Schema

Automatic on every deploy. To run it by hand (needs `DATABASE_URL` in the
environment; the value is never echoed):

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps \
  --entrypoint node alpha-swarm scripts/apply-schema.mjs src/lib/db/schema.sql
# or, with Node >= 20 on the host:
node scripts/apply-schema.mjs src/lib/db/schema.sql
```

It is safe to re-run: every statement is `IF NOT EXISTS` / `CREATE OR REPLACE`.
With `DATABASE_URL` unset it exits 0 with a "skipped" note.

## Firewall

Ports 8085 and 8090 must be open in **both** layers:

```bash
sudo ufw allow 8085/tcp
sudo ufw allow 8090/tcp
sudo ufw reload
```

…and in the Hostinger panel firewall (VPS → Firewall → add inbound TCP rules
for 8085 and 8090). A missing rule in either layer looks exactly like a dead
container from outside.

Preferred alternative for public exposure: keep 8085/8090 closed to the
internet and terminate TLS with a reverse proxy on 80/443.

```
# Caddyfile
swarm.example.com {
  reverse_proxy localhost:8085
}
```

```nginx
server {
  listen 443 ssl;
  server_name swarm.example.com;
  location / { proxy_pass http://127.0.0.1:8085; proxy_http_version 1.1;
               proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; }
}
```

Keep `:8090` internal — it is an operational probe, not a public endpoint.

## Supabase

Optional. When `SUPABASE_URL` is unset the safety-net-daemon check reports
`NOT CONFIGURED` rather than degraded, and the health rollup stays `ok`; the
VPS runner is the primary engine and Neon holds all canonical state.

## Building/pushing images by hand

```bash
echo "$GHCR_PAT" | docker login ghcr.io -u Mo-101 --password-stdin
./scripts/build-image.sh          # both images, :latest + short sha
PUSH=0 ./scripts/build-image.sh   # local build only
```

## Runner-only host

```bash
## Runner-only host

```bash
docker compose -f docker-compose.runner.yml up -d --build
curl -s localhost:8090/health | jq
tail -f logs/runner.log
```

If you need a single-container runner instead of Compose, use:

```bash
docker run -d --name alpha-swarm-runner --restart always \
  --env-file runner/.env -p 8090:8090 -v "$PWD/logs:/app/logs" -e LOG_DIR=/app/logs \
  ghcr.io/mo-101/swarm-signal-stream-runner:latest
```
```

## Secrets

No script or document in this repo prints `DATABASE_URL`, API keys, tokens or
`.env` contents. Failure diagnostics are limited to compose status and
application logs. Keep it that way when editing `scripts/`.
