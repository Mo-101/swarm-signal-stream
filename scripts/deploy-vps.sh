#!/usr/bin/env bash
# One-shot VPS deploy for alpha-swarm (dashboard :8085 + runner health :8090).
#
#   ./scripts/deploy-vps.sh              # pull the published GHCR image and restart
#   ./scripts/deploy-vps.sh --build      # build locally from this checkout instead
#   ./scripts/deploy-vps.sh --no-schema  # skip the Neon schema apply step
#
# Requires docker + docker compose v2. Nothing secret is baked into the image
# and nothing secret is printed by this script.
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="pull"
APPLY_SCHEMA=1
for arg in "$@"; do
  case "$arg" in
    --build) MODE="build" ;;
    --no-schema) APPLY_SCHEMA=0 ;;
    *) echo "!! unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$MODE" == "build" ]]; then
  COMPOSE_FILE="docker-compose.yml"
else
  COMPOSE_FILE="docker-compose.prod.yml"
fi
COMPOSE=(docker compose -f "$COMPOSE_FILE")
SERVICE="alpha-swarm"

echo "==> preflight: $COMPOSE_FILE"
"${COMPOSE[@]}" config -q

mkdir -p logs

if [[ ! -f .env ]]; then
  echo "-- note: no .env in $(pwd) — relying on environment injected by the host/panel."
fi

if [[ "$MODE" == "build" ]]; then
  echo "==> building image locally"
  "${COMPOSE[@]}" build --pull
else
  echo "==> pulling ghcr.io/mo-101/swarm-signal-stream:latest"
  "${COMPOSE[@]}" pull
fi

if [[ "$APPLY_SCHEMA" == "1" ]]; then
  echo "==> applying Neon schema (idempotent)"
  if ! "${COMPOSE[@]}" run --rm --no-deps --entrypoint node "$SERVICE" \
      scripts/apply-schema.mjs src/lib/db/schema.sql; then
    echo "!! schema apply failed — aborting before restart." >&2
    exit 1
  fi
fi

echo "==> restarting stack"
"${COMPOSE[@]}" up -d

echo "==> waiting for health (up to 180s)"
for _ in $(seq 1 90); do
  if curl -sf -o /dev/null http://localhost:8090/health \
     && curl -sf -o /dev/null http://localhost:8085/api/public/health; then
    echo "==> healthy"
    echo "    dashboard   http://localhost:8085"
    echo "    dash health http://localhost:8085/api/public/health"
    echo "    runner      http://localhost:8090/health"
    echo "    logs        tail -f logs/runner.log"
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 2
done

echo "!! not healthy after 180s — diagnostics below (no secrets are printed):" >&2
"${COMPOSE[@]}" ps || true
"${COMPOSE[@]}" logs --tail=80 || true
[[ -f logs/runner.log ]] && { echo "---- logs/runner.log (tail) ----"; tail -n 40 logs/runner.log; }
exit 1
