#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

# 卸载 npm/archive 模式安装的插件。

echo "=== 卸载 npm 安装 ==="

mode=$(get_install_mode)

if [[ "$mode" == "none" ]]; then
	echo "[INFO] 插件未安装"
	exit 0
fi

if [[ "$mode" == "link" ]]; then
	echo "[ERROR] 当前安装模式为 link，非 npm/archive 模式" >&2
	echo "[HINT] 如需卸载 link 安装: pnpm run unlink" >&2
	exit 1
fi

echo "[STEP] openclaw plugins uninstall $PLUGIN_ID"
openclaw plugins uninstall "$PLUGIN_ID"

echo ""
echo "[DONE] 插件已卸载（gateway 将自动重启）"
