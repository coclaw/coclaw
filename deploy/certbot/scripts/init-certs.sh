#!/usr/bin/env bash
# 一键签发 SSL 证书（首次部署时使用）
# 用法：./certbot/scripts/init-certs.sh
#
# 前置条件：
# 1. .env 中已配置 APP_DOMAIN 和 CERTBOT_EMAIL
# 2. 80 端口可从公网访问
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="docker compose"

log() { echo "[init-certs] $*"; }
err() { echo "[init-certs] ERROR: $*" >&2; exit 1; }

cd "$DEPLOY_DIR"

# 读取配置
[[ -f .env ]] || err "未找到 .env，请先执行: cp .env.example .env 并填写配置"
source .env
[[ -n "${APP_DOMAIN:-}" ]] || err "APP_DOMAIN 未设置"
[[ -n "${CERTBOT_EMAIL:-}" ]] || err "CERTBOT_EMAIL 未设置"

log "域名: $APP_DOMAIN"
log "邮箱: $CERTBOT_EMAIL"

# 确保 nginx 运行（使用临时 HTTP 配置接受 ACME 挑战）
log "启动 nginx..."
$COMPOSE up -d nginx || true
sleep 3

# 签发证书
log "签发证书..."
$COMPOSE --profile init-cert run --rm certbot-init

# reload nginx 加载新证书
log "重载 nginx..."
$COMPOSE exec nginx nginx -s reload

log "完成！证书已签发。"
log "现在可以启动完整服务: docker compose --profile auto-https up -d"
