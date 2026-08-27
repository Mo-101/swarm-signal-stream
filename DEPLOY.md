# VPS deploy

One container runs both halves (dashboard on `:8085`, runner health on
`:8090`), supervised by `docker/supervisor.mjs`. All state lives outside the
container (Neon canonical, Supabase mirror), so it's safe to replace at will.

## First-time setup on the VPS

```bash
# 1. Docker (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER" && newgrp docker

# 2. Get the repo
git clone https://github.com/Mo-101/swarm-signal-stream.git /opt/alpha-swarm
cd /opt/alpha-swarm

# 3. Secrets
cp .env.example .env
nano .env    # DATABASE_URL, RUNNER_EMAIL/PASSWORD, BYBIT_* ...

# 4. GHCR login (only needed while the package is private)
echo "$GHCR_PAT" | docker login ghcr.io -u Mo-101 --password-stdin

# 5. Deploy
./scripts/deploy-vps.sh
```

`deploy-vps.sh` pulls `ghcr.io/mo-101/swarm-signal-stream:latest`, restarts the
stack, waits for both `http://localhost:8085/` and
`http://localhost:8090/health`, and prunes old layers. Use
`./scripts/deploy-vps.sh --build` to build from the checkout instead of pulling.

## Update to the latest build

```bash
cd /opt/alpha-swarm && git pull && ./scripts/deploy-vps.sh
```

## Verify after deploy

```bash
curl -s localhost:8090/health | jq
curl -s localhost:8085/api/public/health | jq
docker compose -f docker-compose.prod.yml ps
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

## Building/pushing images by hand

CI (`.github/workflows/docker-publish*.yml`) publishes on every push to `main`.
To do it manually:

```bash
echo "$GHCR_PAT" | docker login ghcr.io -u Mo-101 --password-stdin
./scripts/build-image.sh          # both images, :latest + short sha
PUSH=0 ./scripts/build-image.sh   # local build only
```

## Reverse proxy (optional, Caddy)

```
swarm.example.com {
  reverse_proxy localhost:8085
}
```

## Runner-only host

If the dashboard runs elsewhere and you only want the trading process:

```bash
docker compose -f docker-compose.runner.yml up -d --build
curl -s localhost:8090/health | jq
tail -f logs/runner.log
```
