#!/usr/bin/env bash
# One-shot deploy + verify for the VPS runner.
#   ./scripts/deploy-and-verify.sh            # pull the published GHCR image
#   ./scripts/deploy-and-verify.sh --build    # build locally from this checkout
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> pulling latest changes"
git pull

echo "==> running deploy"
./scripts/deploy-vps.sh "${1:-}"

echo "==> checking runner health"
curl -s -f localhost:8090/health | jq
echo ""

echo "==> tailing runner log (Ctrl+C to exit)"
tail -f logs/runner.log
