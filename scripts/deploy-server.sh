#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/deploy-common.sh"

need_cmd rsync
need_cmd ssh

WITH_NGINX="false"
if [[ "${1:-}" == "--with-nginx" ]]; then
	WITH_NGINX="true"
fi

sync_repo

log "build remote server image"
ssh_remote "cd $DEPLOY_REMOTE_DIR/deploy && docker compose build server"

if [[ "$WITH_NGINX" == "true" ]]; then
	log "restart server + nginx"
	ssh_remote "cd $DEPLOY_REMOTE_DIR/deploy && docker compose up -d server nginx"
else
	log "restart server"
	ssh_remote "cd $DEPLOY_REMOTE_DIR/deploy && docker compose up -d server"
fi

ssh_remote "cd $DEPLOY_REMOTE_DIR/deploy && docker compose ps server"
log "done: server deployed"
