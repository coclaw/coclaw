#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$PROJECT_ROOT/deploy"

: "${DEPLOY_HOST:=coclaw.net}"
: "${DEPLOY_REMOTE_DIR:=~/coclaw}"
: "${DEPLOY_DOMAIN:=coclaw.qidianchat.com}"

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

sync_repo() {
	log "sync repo -> $DEPLOY_HOST:$DEPLOY_REMOTE_DIR"
	rsync -az --delete \
		--exclude '.git' \
		--exclude 'node_modules' \
		--exclude 'deploy/data' \
		--exclude 'deploy/certbot/conf' \
		--exclude 'deploy/.env' \
		--exclude 'deploy/env/*.env' \
		"$PROJECT_ROOT/" "$DEPLOY_HOST:$DEPLOY_REMOTE_DIR/"
}

restart_nginx() {
	ssh_remote "cd $DEPLOY_REMOTE_DIR/deploy && docker compose restart nginx"
}
