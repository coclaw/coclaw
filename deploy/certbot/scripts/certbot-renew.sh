#!/bin/sh

while :; do
	echo "[certbot-renew] running renewal check..."
	certbot renew --webroot -w /var/www/certbot --quiet \
		--deploy-hook '/scripts/reload-nginx.sh' \
		|| echo "[certbot-renew] renewal returned non-zero (may be normal)"
	echo "[certbot-renew] sleeping for 12h"
	sleep 12h
done
