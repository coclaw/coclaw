#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

: "${GHCR_SERVER:=ghcr.io/coclaw/server}"

log() { echo "[build-server] $*"; }

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || {
		echo "[build-server] missing command: $1" >&2
		exit 1
	}
}

need_cmd docker
need_cmd node

VERSION=$(node -p "require('$PROJECT_ROOT/server/package.json').version")
PLATFORMS="linux/amd64,linux/arm64"

log "version: $VERSION"
log "platforms: $PLATFORMS"
log "repo: $GHCR_SERVER"

# 确保 buildx builder 可用
if ! docker buildx inspect coclaw-builder >/dev/null 2>&1; then
	log "creating buildx builder..."
	docker buildx create --name coclaw-builder --use
	docker buildx inspect --bootstrap >/dev/null
else
	docker buildx use coclaw-builder
fi

log "building and pushing..."
docker buildx build \
	--platform "$PLATFORMS" \
	-t "$GHCR_SERVER:latest" \
	-t "$GHCR_SERVER:$VERSION" \
	--push \
	-f "$PROJECT_ROOT/server/Dockerfile" \
	"$PROJECT_ROOT"

log "verifying manifest..."
docker manifest inspect "$GHCR_SERVER:$VERSION" >/dev/null 2>&1 \
	&& log "verified: $GHCR_SERVER:$VERSION" \
	|| { log "ERROR: manifest verification failed"; exit 1; }

log "done: $GHCR_SERVER:latest + :$VERSION"
