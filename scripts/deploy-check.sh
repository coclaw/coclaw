#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/deploy-common.sh"

log "docker compose status"
ssh_remote "cd $DEPLOY_REMOTE_DIR && docker compose ps"

log "check https home"
curl -k -sS -o /tmp/coclaw_home.out -w "HTTP %{http_code}\n" "https://$DEPLOY_DOMAIN/"

log "check auth session"
curl -k -sS -o /tmp/coclaw_session.out -w "HTTP %{http_code}\n" "https://$DEPLOY_DOMAIN/api/v1/auth/session"
head -c 200 /tmp/coclaw_session.out; echo

log "done: checks passed"
