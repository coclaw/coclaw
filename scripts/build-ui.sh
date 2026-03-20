#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

: "${GHCR_UI:=ghcr.io/coclaw/ui}"

log() { echo "[build-ui] $*"; }

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || {
		echo "[build-ui] missing command: $1" >&2
		exit 1
	}
}

need_cmd docker
need_cmd node
need_cmd pnpm

VERSION=$(node -p "require('$PROJECT_ROOT/ui/package.json').version")
PLATFORMS="linux/amd64,linux/arm64"

log "version: $VERSION"
log "platforms: $PLATFORMS"
log "repo: $GHCR_UI"

# 本地构建 UI
log "building UI..."
cd "$PROJECT_ROOT"
pnpm --filter @coclaw/ui build

# 确保 buildx builder 可用
if ! docker buildx inspect coclaw-builder >/dev/null 2>&1; then
	log "creating buildx builder..."
	docker buildx create --name coclaw-builder --use
	docker buildx inspect --bootstrap >/dev/null
else
	docker buildx use coclaw-builder
fi

# 打包并推送镜像（仅包含静态文件，无架构依赖）
log "building and pushing image..."
docker buildx build \
	--platform "$PLATFORMS" \
	-t "$GHCR_UI:latest" \
	-t "$GHCR_UI:$VERSION" \
	--push \
	-f "$PROJECT_ROOT/ui/Dockerfile" \
	"$PROJECT_ROOT"

log "verifying manifest..."
docker manifest inspect "$GHCR_UI:$VERSION" >/dev/null 2>&1 \
	&& log "verified: $GHCR_UI:$VERSION" \
	|| { log "ERROR: manifest verification failed"; exit 1; }

log "done: $GHCR_UI:latest + :$VERSION"
