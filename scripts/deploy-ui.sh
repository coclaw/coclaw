#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/deploy-common.sh"

need_cmd pnpm
need_cmd rsync
need_cmd ssh

RELEASE_TAG="${1:-ui-$(date +%Y%m%d-%H%M)}"
MAX_RELEASES=10

log "build ui"
cd "$PROJECT_ROOT"
pnpm --filter @coclaw/ui build

log "prepare local release: $RELEASE_TAG"
mkdir -p "$DEPLOY_DIR/static/ui/releases/$RELEASE_TAG"
rsync -a --delete "$PROJECT_ROOT/ui/dist/" "$DEPLOY_DIR/static/ui/releases/$RELEASE_TAG/"
ln -sfn "releases/$RELEASE_TAG" "$DEPLOY_DIR/static/ui/current"

log "sync static to remote"
rsync -az --delete "$DEPLOY_DIR/static/" "$DEPLOY_HOST:$DEPLOY_REMOTE_DIR/static/"

# 清理超出保留数量的旧版本（本地 + 远端）
cleanup_old_releases() {
	local dir="$1"
	local releases
	releases=$(ls -1dt "$dir"/ui-* 2>/dev/null || true)
	local count
	count=$(echo "$releases" | grep -c . 2>/dev/null || echo 0)
	if [[ "$count" -gt "$MAX_RELEASES" ]]; then
		echo "$releases" | tail -n +"$((MAX_RELEASES + 1))" | while read -r old; do
			log "remove old release: $(basename "$old")"
			rm -rf "$old"
		done
	fi
}

cleanup_old_releases "$DEPLOY_DIR/static/ui/releases"
# 远端清理
ssh_remote "cd $DEPLOY_REMOTE_DIR/static/ui/releases && ls -1dt ui-* 2>/dev/null | tail -n +$((MAX_RELEASES + 1)) | xargs -r rm -rf" || true

log "done: ui release=$RELEASE_TAG"
