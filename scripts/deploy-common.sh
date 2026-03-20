#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$PROJECT_ROOT/deploy"

: "${DEPLOY_HOST:=im.coclaw.net}"
: "${DEPLOY_REMOTE_DIR:=~/coclaw}"
: "${DEPLOY_DOMAIN:=im.coclaw.net}"
: "${GHCR_SERVER:=ghcr.io/coclaw/server}"
: "${GHCR_UI:=ghcr.io/coclaw/ui}"

if [[ -z "${SSH_AUTH_SOCK:-}" && -S "$HOME/.ssh/agent.sock" ]]; then
	export SSH_AUTH_SOCK="$HOME/.ssh/agent.sock"
fi

log() {
	echo "[deploy] $*"
}

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || {
		echo "[deploy] missing command: $1" >&2
		exit 1
	}
}

ssh_remote() {
	ssh "$DEPLOY_HOST" "$@"
}

pull_server() {
	log "pull server image on remote"
	ssh_remote "cd $DEPLOY_REMOTE_DIR && docker compose pull server"
}

sync_deploy() {
	log "sync deploy config -> $DEPLOY_HOST:$DEPLOY_REMOTE_DIR"
	rsync -az --delete \
		--exclude '.env' \
		--exclude 'data' \
		--exclude 'certbot/conf' \
		--exclude 'static' \
		--exclude 'REVIEW.md' \
		"$DEPLOY_DIR/" "$DEPLOY_HOST:$DEPLOY_REMOTE_DIR/"
}

restart_nginx() {
	ssh_remote "cd $DEPLOY_REMOTE_DIR && docker compose restart nginx"
}
