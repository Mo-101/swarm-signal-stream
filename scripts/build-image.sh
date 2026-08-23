#!/usr/bin/env bash
# Build + push the two images to GHCR by hand (CI normally does this on every
# push to main). Needs: docker login ghcr.io -u <you> --password-stdin  with a
# PAT that has write:packages.
#
#   ./scripts/build-image.sh              # tag :latest and the short git sha
#   TAG=v2 ./scripts/build-image.sh       # extra tag
#   PUSH=0 ./scripts/build-image.sh       # build only, no push
set -euo pipefail

cd "$(dirname "$0")/.."

OWNER="${OWNER:-mo-101}"
APP_IMAGE="ghcr.io/${OWNER}/swarm-signal-stream"
RUNNER_IMAGE="ghcr.io/${OWNER}/swarm-signal-stream-runner"
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo local)"
PUSH="${PUSH:-1}"

build() {
  local image="$1" dockerfile="$2"
  echo "==> building ${image}:${SHA}"
  docker build -f "$dockerfile" -t "${image}:latest" -t "${image}:${SHA}" ${TAG:+-t "${image}:${TAG}"} .
  if [[ "$PUSH" == "1" ]]; then
    docker push "${image}:latest"
    docker push "${image}:${SHA}"
    [[ -n "${TAG:-}" ]] && docker push "${image}:${TAG}"
  fi
}

build "$APP_IMAGE" Dockerfile
build "$RUNNER_IMAGE" Dockerfile.runner

echo "==> done: ${APP_IMAGE}:${SHA} and ${RUNNER_IMAGE}:${SHA}"
