#!/usr/bin/env bash
# Build a traceable, pinnable GDS Autotask MCP image (brief §7.34 / Phase 5).
#
# Bakes VERSION + COMMIT_SHA + BUILD_DATE into the image (and package.json, so
# the /health endpoint reports the real version). Tags by both version and the
# short commit SHA so the exact source is always recoverable, and prints the
# image digest to pin in the deployment.
#
# Usage:
#   scripts/build-image.sh [VERSION]
#
# VERSION defaults to `git describe --tags` (falls back to the package.json
# version + "-<sha>"). IMAGE_NAME can be overridden via env.
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-ghcr.io/gdstechnology/autotask-mcp}"

COMMIT_SHA="$(git rev-parse --short HEAD)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ "${1:-}" != "" ]; then
  VERSION="$1"
elif VERSION="$(git describe --tags --always --dirty 2>/dev/null)"; then
  :
else
  VERSION="$(node -p "require('./package.json').version")-${COMMIT_SHA}"
fi

# Refuse to build a "traceable" image from a dirty tree unless explicitly allowed.
if [ -n "$(git status --porcelain)" ] && [ "${ALLOW_DIRTY:-}" != "1" ]; then
  echo "ERROR: working tree is dirty. Commit/stash first, or set ALLOW_DIRTY=1." >&2
  exit 1
fi

echo "Building ${IMAGE_NAME}"
echo "  VERSION    = ${VERSION}"
echo "  COMMIT_SHA = ${COMMIT_SHA}"
echo "  BUILD_DATE = ${BUILD_DATE}"

docker build \
  --platform linux/amd64 \
  --build-arg "VERSION=${VERSION}" \
  --build-arg "COMMIT_SHA=${COMMIT_SHA}" \
  --build-arg "BUILD_DATE=${BUILD_DATE}" \
  -t "${IMAGE_NAME}:${VERSION}" \
  -t "${IMAGE_NAME}:${COMMIT_SHA}" \
  .

echo
echo "Built and tagged:"
echo "  ${IMAGE_NAME}:${VERSION}"
echo "  ${IMAGE_NAME}:${COMMIT_SHA}"
echo
echo "Image ID / RepoDigests (pin one of these in the deployment):"
docker image inspect "${IMAGE_NAME}:${VERSION}" --format '  Id:          {{.Id}}' || true
docker image inspect "${IMAGE_NAME}:${VERSION}" --format '  RepoDigests: {{join .RepoDigests ", "}}' 2>/dev/null || true
echo
echo "Next: push (docker push ${IMAGE_NAME}:${VERSION} && docker push ${IMAGE_NAME}:${COMMIT_SHA})"
echo "then deploy per DEPLOY.md and verify GET /health reports version ${VERSION}."
