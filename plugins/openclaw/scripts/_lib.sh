#!/usr/bin/env bash
# 共享常量和工具函数，被其他脚本 source 引入。

PLUGIN_ID="openclaw-coclaw"
PKG_NAME="@coclaw/openclaw-coclaw"
CHANNEL_ID="coclaw"
BINDINGS_FILE="$HOME/.openclaw/coclaw/bindings.json"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# stage 目录与 workspace 根：均相对 PLUGIN_DIR 推算，所以在 worktree 里 source
# 本文件时它们自动落在该 worktree（worktree-gateway.sh 据此为每个 worktree 建独立 stage）。
STAGE_DIR="$PLUGIN_DIR/.build/link-stage"
WORKSPACE_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"
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

# 构建扁平依赖 stage（pnpm deploy）+ 把 src/ 换成回指源目录的 symlink。
# 被 link.sh 与 worktree-gateway.sh 共用。详见 link.sh 顶部注释与
# docs/local-plugin-update-sop.md（为何只软链 src/、为何要扁平依赖）。
build_stage() {
	echo "[STEP] pnpm deploy → $STAGE_DIR"
	rm -rf "$STAGE_DIR"
	mkdir -p "$(dirname "$STAGE_DIR")"
	(cd "$WORKSPACE_ROOT" && pnpm deploy --prod --filter "$PKG_NAME" --legacy "$STAGE_DIR")

	# pnpm 会在 .pnpm/node_modules/ 下塞一条指向源目录的 workspace 自引用，
	# 扫描会把它判定为外指。插件不 import 自己，直接删掉即可。
	local self_ref="$STAGE_DIR/node_modules/.pnpm/node_modules/$PKG_NAME"
	if [[ -L "$self_ref" ]]; then
		rm -f "$self_ref"
	fi

	# 把 src/ 换成回指真源目录的 symlink，保留“改代码 → restart gateway”热更新。
	#
	# 为什么仅 src/：
	#   OpenClaw discovery 对以下三类文件做 realpath-in-root 检查，symlink 外指会被拒：
	#     · 入口 index.js（checkSourceEscapesRoot）
	#     · package.json / openclaw.plugin.json（openBoundaryFileSync → boundary-path.ts）
	#   这三个必须保留 deploy 产出的真文件拷贝。src/ 下的模块仅被 Node runtime
	#   require 加载（自动跟随 symlink），不经过任何 boundary 检查。
	#   所以 src/ 用 symlink 既能热更新，又不触发拦截。
	rm -rf "$STAGE_DIR/src"
	ln -s "$PLUGIN_DIR/src" "$STAGE_DIR/src"

	# 核对：node_modules 里不允许再有指向 stage 外的 symlink，
	# 一旦 pnpm 布局变更引入新的外指会立即暴露。
	local leak
	leak=$(find "$STAGE_DIR/node_modules" -type l 2>/dev/null | while read -r l; do
		local tgt
		tgt=$(readlink -f "$l" 2>/dev/null || true)
		case "$tgt" in
			"$STAGE_DIR"/*|'') ;;
			*) echo "$l → $tgt" ;;
		esac
	done | head -1)
	if [[ -n "$leak" ]]; then
		echo "[ERROR] stage 仍存在外指 symlink：$leak" >&2
		echo "[HINT] 请上报该 symlink，可能是新的 pnpm 布局变更" >&2
		exit 1
	fi
}
