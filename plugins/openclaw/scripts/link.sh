#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

# 切换到 link 开发模式。
# 如果当前为其他安装模式，会先卸载再 link。

echo "=== 切换到 link 开发模式 ==="

mode=$(get_install_mode)

if [[ "$mode" == "link" ]]; then
	echo "[INFO] 已处于 link 模式，无需操作"
	echo "[HINT] 代码更新后只需: openclaw gateway restart"
	exit 0
fi

if [[ "$mode" != "none" ]]; then
	echo "[INFO] 当前为 $mode 模式，先卸载..."
	ensure_uninstalled
fi

echo "[STEP] openclaw plugins install --link --dangerously-force-unsafe-install $PLUGIN_DIR"
openclaw plugins install --link --dangerously-force-unsafe-install "$PLUGIN_DIR"

wait_gateway_restart
verify_install

echo ""
echo "[DONE] 已切换到 link 开发模式"
echo "[HINT] 代码更新后只需: openclaw gateway restart"
