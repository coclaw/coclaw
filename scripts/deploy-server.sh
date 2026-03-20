#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/deploy-common.sh"

need_cmd ssh

log "sync deploy config to remote"
sync_deploy

log "pull server image on remote"
pull_server

log "restart server on remote"
ssh_remote "cd $DEPLOY_REMOTE_DIR && docker compose up -d server"

log "check server status"
ssh_remote "cd $DEPLOY_REMOTE_DIR && docker compose ps server"

log "done: server deployed"
