#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

# 从 npm registry 安装插件。
# 如果当前为其他安装模式，会先卸载再安装。

echo "=== 从 npm 安装插件 ==="

mode=$(get_install_mode)

if [[ "$mode" == "npm" ]]; then
	echo "[INFO] 已处于 npm 模式 ($(get_installed_version))"
	echo "[HINT] 如需升级: openclaw plugins update $PLUGIN_ID"
	exit 0
fi

if [[ "$mode" != "none" ]]; then
	echo "[INFO] 当前为 $mode 模式，先卸载..."
	ensure_uninstalled
fi

echo "[STEP] openclaw plugins install $PKG_NAME"
openclaw plugins install "$PKG_NAME"

wait_gateway_restart
verify_install

echo ""
echo "[DONE] 已从 npm 安装 $PKG_NAME"
