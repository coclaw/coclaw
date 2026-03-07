#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

DO_UI="false"
DO_SERVER="false"
DO_DB="false"
DO_CHECK="false"
DB_PUSH="false"
CREATE_TEST="false"

if [[ "$#" -eq 0 ]]; then
	echo "usage: $0 [--ui] [--server] [--db] [--check] [--db-push] [--create-test-account]"
	exit 1
fi

for arg in "$@"; do
	case "$arg" in
		--ui) DO_UI="true" ;;
		--server) DO_SERVER="true" ;;
		--db) DO_DB="true" ;;
		--check) DO_CHECK="true" ;;
		--db-push) DB_PUSH="true" ;;
		--create-test-account) CREATE_TEST="true" ;;
		*) echo "unknown arg: $arg" >&2; exit 1 ;;
	esac
done

if [[ "$DO_UI" == "true" ]]; then
	"$BASE_DIR/deploy-ui.sh"
fi

if [[ "$DO_SERVER" == "true" ]]; then
	"$BASE_DIR/deploy-server.sh"
fi

if [[ "$DO_DB" == "true" ]]; then
	DB_ARGS=()
	[[ "$DB_PUSH" == "true" ]] && DB_ARGS+=("--db-push")
	[[ "$CREATE_TEST" == "true" ]] && DB_ARGS+=("--create-test-account")
	"$BASE_DIR/deploy-db.sh" "${DB_ARGS[@]}"
fi

if [[ "$DO_CHECK" == "true" ]]; then
	"$BASE_DIR/deploy-check.sh"
fi

echo "[deploy] done"
