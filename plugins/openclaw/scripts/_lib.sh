#!/usr/bin/env bash
# 共享常量和工具函数，被其他脚本 source 引入。

PLUGIN_ID="openclaw-coclaw"
PKG_NAME="@coclaw/openclaw-coclaw"
CHANNEL_ID="coclaw"
BINDINGS_FILE="$HOME/.openclaw/coclaw/bindings.json"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"

# 检测当前安装模式
# 返回: link | npm | archive | none
get_install_mode() {
	if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
		echo "none"
		return
	fi
	local source
	source=$(node -e "
		const c = JSON.parse(require('fs').readFileSync('$OPENCLAW_CONFIG', 'utf8'));
		const r = c?.plugins?.installs?.['$PLUGIN_ID'];
		console.log(r?.source ?? 'none');
	" 2>/dev/null) || true
	echo "${source:-none}"
}

# 获取已安装的版本号
get_installed_version() {
	if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
		echo ""
		return
	fi
	node -e "
		const c = JSON.parse(require('fs').readFileSync('$OPENCLAW_CONFIG', 'utf8'));
		const r = c?.plugins?.installs?.['$PLUGIN_ID'];
		console.log(r?.version ?? '');
	" 2>/dev/null || true
}

# 卸载当前安装的插件（不清理 bindings）
ensure_uninstalled() {
	local mode
	mode=$(get_install_mode)
	if [[ "$mode" == "none" ]]; then
		echo "[INFO] 插件未安装，无需卸载"
		return 0
	fi
	echo "[INFO] 当前安装模式: $mode，执行卸载..."
	openclaw plugins uninstall "$PLUGIN_ID" || true
	# 清理可能残留的 extensions 目录
	local ext_dir="$HOME/.openclaw/extensions/$PLUGIN_ID"
	if [[ -d "$ext_dir" ]]; then
		echo "[INFO] 清理残留目录: $ext_dir"
		rm -rf "$ext_dir"
	fi
}

# 等待 gateway 自动重启（openclaw.json 变更触发 chokidar file-watch → restart）
wait_gateway_restart() {
	echo "[INFO] 等待 gateway 自动重启..."
	sleep 3
}

# 验证安装状态
verify_install() {
	echo ""
	echo "[VERIFY] openclaw plugins doctor"
	openclaw plugins doctor
	echo ""
	echo "[VERIFY] openclaw gateway status"
	openclaw gateway status
}
