#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/deploy-common.sh"

DO_DB_PUSH="false"
DO_CREATE_TEST="false"
for arg in "$@"; do
	case "$arg" in
		--db-push) DO_DB_PUSH="true" ;;
		--create-test-account) DO_CREATE_TEST="true" ;;
		*) echo "unknown arg: $arg" >&2; exit 1 ;;
	esac
done

if [[ "$DO_DB_PUSH" == "true" ]]; then
	log "run prisma db push (internal only)"
	ssh_remote "cd $DEPLOY_REMOTE_DIR && docker compose exec -T server npx prisma db push"
fi

if [[ "$DO_CREATE_TEST" == "true" ]]; then
	log "create test account"
	ssh_remote "cd $DEPLOY_REMOTE_DIR && docker compose exec -T server node scripts/create-test-local-account.js"
fi

log "done: db ops"
