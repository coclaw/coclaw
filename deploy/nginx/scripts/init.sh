#!/bin/sh
set -e

HTTPS_MODE="${HTTPS_MODE:-auto}"
MODES_DIR="/etc/nginx/modes"
TEMPLATES_DIR="/etc/nginx/templates"

case "$HTTPS_MODE" in
	off)
		echo "[init] HTTPS_MODE=off — HTTP-only"
		cp "$MODES_DIR/app-http.conf.template" "$TEMPLATES_DIR/app.conf.template"
		;;
	auto|custom)
		echo "[init] HTTPS_MODE=$HTTPS_MODE — HTTPS"
		cp "$MODES_DIR/app-https.conf.template" "$TEMPLATES_DIR/app.conf.template"
		;;
	*)
		echo "[init] ERROR: unknown HTTPS_MODE='$HTTPS_MODE' (expected: auto|custom|off)" >&2
		exit 1
		;;
esac

# custom 模式：若证书不存在，自动生成自签名证书
if [ "$HTTPS_MODE" = "custom" ]; then
	CERT_DIR="/etc/letsencrypt/live/$APP_DOMAIN"
	if [ ! -f "$CERT_DIR/fullchain.pem" ]; then
		echo "[init] Generating self-signed certificate for $APP_DOMAIN ..."
		mkdir -p "$CERT_DIR"
		openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
			-keyout "$CERT_DIR/privkey.pem" \
			-out "$CERT_DIR/fullchain.pem" \
			-subj "/CN=$APP_DOMAIN" 2>/dev/null
		echo "[init] Self-signed certificate created at $CERT_DIR"
	fi
fi

exec /docker-entrypoint.sh nginx -g "daemon off;"
