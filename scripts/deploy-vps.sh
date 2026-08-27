#!/usr/bin/env bash
# One-shot VPS deploy for alpha-swarm (dashboard :8085 + runner health :8090).
#
#   ./scripts/deploy-vps.sh            # pull the published GHCR image and restart
#   ./scripts/deploy-vps.sh --build    # build locally from this checkout instead
#
# Requires: docker + docker compose v2, and a filled .env next to this repo
# (copy .env.example). Nothing secret is baked into the image.
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="pull"
[[ "${1:-}" == "--build" ]] && MODE="build"

if [[ ! -f .env ]]; then
  echo "!! .env missing — cp .env.example .env and fill it in first." >&2
  exit 1
fi

COMPOSE_FILE="docker-compose.prod.yml"
[[ "$MODE" == "build" ]] && COMPOSE_FILE="docker-compose.yml"

CONFIG_ERR="$(mktemp)"
if ! docker compose -f "$COMPOSE_FILE" config >/dev/null 2>"$CONFIG_ERR"; then
  echo "!! compose preflight failed before deploy." >&2
  echo "!! Check .env: it must contain only KEY=value lines, blank lines, or # comments." >&2
  sed -n '1,12p' "$CONFIG_ERR" >&2
  rm -f "$CONFIG_ERR"
  exit 1
fi
rm -f "$CONFIG_ERR"

if [[ "$MODE" == "build" ]]; then
  echo "==> building locally"
  docker compose build --pull
  docker compose up -d
  COMPOSE="docker compose"
else
  echo "==> pulling ghcr.io/mo-101/swarm-signal-stream:latest"
  docker compose -f docker-compose.prod.yml pull
  docker compose -f docker-compose.prod.yml up -d
  COMPOSE="docker compose -f docker-compose.prod.yml"
fi

echo "==> waiting for health"
for i in $(seq 1 60); do
  if curl -sf -o /dev/null http://localhost:8085/ && curl -sf -o /dev/null http://localhost:8090/health; then
    echo "==> healthy: dashboard http://localhost:8085  runner http://localhost:8090/health"
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 2
done

echo "!! not healthy after 120s — recent logs:" >&2
$COMPOSE logs --tail=60
exit 1
