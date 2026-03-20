#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/deploy-common.sh"

KEEP_HOURS="168h"
PRUNE_ALL="false"
DRY_RUN="false"

for arg in "$@"; do
	case "$arg" in
		--all) PRUNE_ALL="true" ;;
		--dry-run) DRY_RUN="true" ;;
		--keep=*) KEEP_HOURS="${arg#--keep=}" ;;
		*) echo "usage: $0 [--all] [--dry-run] [--keep=<duration>]"; exit 1 ;;
	esac
done

log "target: $DEPLOY_HOST"

if [[ "$DRY_RUN" == "true" ]]; then
	log "[dry-run] docker system df"
	ssh_remote "docker system df"
	log "[dry-run] dangling images:"
	ssh_remote "docker images --filter 'dangling=true' -q" || true
	log "[dry-run] no changes made"
	exit 0
fi

if [[ "$PRUNE_ALL" == "true" ]]; then
	log "prune ALL unused images, build cache, networks..."
	ssh_remote "docker system prune -af"
	ssh_remote "docker builder prune -af"
else
	log "prune unused resources older than $KEEP_HOURS..."
	ssh_remote "docker system prune -af --filter 'until=$KEEP_HOURS'"
	ssh_remote "docker builder prune -af --filter 'until=$KEEP_HOURS'"
fi

log "disk usage after cleanup:"
ssh_remote "docker system df"
ssh_remote "df -h / | tail -1"
log "done"
