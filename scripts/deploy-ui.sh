#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/deploy-common.sh"

need_cmd pnpm
need_cmd rsync
need_cmd ssh

RELEASE_TAG="${1:-ui-$(date +%Y%m%d-%H%M)}"

log "build ui"
cd "$PROJECT_ROOT"
pnpm --filter @coclaw/ui build

log "prepare local release: $RELEASE_TAG"
mkdir -p "$DEPLOY_DIR/static/ui/releases/$RELEASE_TAG"
rsync -a --delete "$PROJECT_ROOT/ui/dist/" "$DEPLOY_DIR/static/ui/releases/$RELEASE_TAG/"
ln -sfn "releases/$RELEASE_TAG" "$DEPLOY_DIR/static/ui/current"

log "sync static to remote"
rsync -az --delete "$DEPLOY_DIR/static/" "$DEPLOY_HOST:$DEPLOY_REMOTE_DIR/deploy/static/"

log "restart remote nginx"
restart_nginx

log "done: ui release=$RELEASE_TAG"
