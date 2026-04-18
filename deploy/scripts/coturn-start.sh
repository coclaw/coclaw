#!/bin/sh
# coturn 启动脚本
# 根据环境变量动态构建 turnserver 命令，支持默认模式和 TURNS/TLS 模式

set -e

# TURN_INTERNAL_IP 未设置时回退到 TURN_EXTERNAL_IP（EIP 直通等场景下两者相同）
TURN_INTERNAL_IP="${TURN_INTERNAL_IP:-${TURN_EXTERNAL_IP}}"

set -- \
	--listening-port="${TURN_PORT}" \
	--listening-ip="${TURN_INTERNAL_IP}" \
	--relay-ip="${TURN_INTERNAL_IP}" \
	--external-ip="${TURN_EXTERNAL_IP}/${TURN_INTERNAL_IP}" \
	--realm="${APP_DOMAIN}" \
	--use-auth-secret \
	--static-auth-secret="${TURN_SECRET}" \
	--min-port="${TURN_MIN_PORT}" \
	--max-port="${TURN_MAX_PORT}" \
	--fingerprint \
	--no-cli \
	--log-file=stdout

# TURNS (TLS) 模式：设置了 TURN_TLS_PORT 且证书存在时启用
if [ -n "${TURN_TLS_PORT}" ] && [ -f "${TURN_TLS_CERT}" ]; then
	set -- "$@" \
		--tls-listening-port="${TURN_TLS_PORT}" \
		--cert="${TURN_TLS_CERT}" \
		--pkey="${TURN_TLS_KEY}" \
		--no-tlsv1
	echo "[coturn] TLS enabled on port ${TURN_TLS_PORT}"
elif [ -n "${TURN_TLS_PORT}" ]; then
	echo "[coturn] WARNING: TURN_TLS_PORT=${TURN_TLS_PORT} but cert not found at ${TURN_TLS_CERT}, TLS disabled"
fi

exec turnserver "$@"
