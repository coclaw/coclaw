#!/usr/bin/env bash
# 共享常量和工具函数，被其他脚本 source 引入。

PLUGIN_ID="openclaw-coclaw"
PKG_NAME="@coclaw/openclaw-coclaw"
CHANNEL_ID="coclaw"
BINDINGS_FILE="$HOME/.openclaw/coclaw/bindings.json"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# OpenClaw 2026.5 起把安装记录从 openclaw.json 的 plugins.installs 搬到了
# ~/.openclaw/plugins/installs.json 的 installRecords，且明确标记前者为 transient
# 不再持久化，所以模式判断必须读这本新账。
INSTALL_RECORDS_FILE="$HOME/.openclaw/plugins/installs.json"

# 检测当前安装模式
# 返回: link | npm | archive | none
# 注意: OpenClaw --link 安装实际记录 source="path"，此函数通过
#       比较 sourcePath 与 installPath 是否相同来判断是否为 link 模式。
get_install_mode() {
	if [[ ! -f "$INSTALL_RECORDS_FILE" ]]; then
		echo "none"
		return
	fi
	local result
	result=$(node -e "
		try {
			const c = JSON.parse(require('fs').readFileSync('$INSTALL_RECORDS_FILE', 'utf8'));
			const r = c?.installRecords?.['$PLUGIN_ID'];
			if (!r) { console.log('none'); process.exit(); }
			if (r.source === 'path') {
				const same = r.sourcePath && r.installPath && r.sourcePath === r.installPath;
				console.log(same ? 'link' : 'link:mismatch');
			} else {
				console.log(r.source ?? 'none');
			}
		} catch (e) { console.log('none'); }
	" 2>/dev/null) || true
	if [[ "$result" == "link:mismatch" ]]; then
		echo "[ERROR] source=path 但 sourcePath !== installPath，安装状态异常" >&2
		echo "[HINT] 建议执行 openclaw plugins doctor 检查" >&2
		echo "link"
		return
	fi
	echo "${result:-none}"
}

# 获取已安装的版本号
get_installed_version() {
	if [[ ! -f "$INSTALL_RECORDS_FILE" ]]; then
		echo ""
		return
	fi
	node -e "
		try {
			const c = JSON.parse(require('fs').readFileSync('$INSTALL_RECORDS_FILE', 'utf8'));
			const r = c?.installRecords?.['$PLUGIN_ID'];
			console.log(r?.version ?? '');
		} catch (e) { console.log(''); }
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
	# --force 跳过交互确认；脚本环境没有 stdin tty。
	openclaw plugins uninstall --force "$PLUGIN_ID" || true
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
