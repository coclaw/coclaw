#!/usr/bin/env bash
# 确保本地开发所需的容器（mysql、coturn）已启动。
# 幂等：容器不存在则创建，存在但已停则启动，在跑则快速返回。
# 可从任意子目录调用（server/ui 的 dev 脚本会前缀调用）。
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -f deploy/compose.dev.yaml up -d --wait
