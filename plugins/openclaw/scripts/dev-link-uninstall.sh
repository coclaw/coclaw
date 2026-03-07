#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./plugin-install-lib.sh
source "$SCRIPT_DIR/plugin-install-lib.sh"

mode="$(get_install_mode)"
require_ready_config "$mode"

case "$mode" in
	link)
		log "开始卸载 --link 插件: $PLUGIN_ID"
		# 顺序：先卸载插件 id（清理 entries/installs 等），再清理 load.paths 残留路径，最后清理绑定信息。
		printf 'y\n' | oc plugins uninstall "$PLUGIN_ID"
		remove_plugin_dir_from_load_paths
		cleanup_bindings
		cleanup_legacy_channels_config
		log "完成（已尝试清理 plugins.load.paths 中的本地 link 路径及绑定信息）。gateway 重启请按你的流程手动执行。"
		;;
	npm)
		err "检测到当前为 npm 安装，不执行 link 卸载。请改用: pnpm run plugin:npm:uninstall"
		exit 2
		;;
	none)
		log "当前未检测到已安装插件，无需卸载。"
		exit 0
		;;
	unknown)
		err "无法可靠判断当前安装状态（unknown），为避免误操作已中止。"
		err "请先手动执行: openclaw plugins info $PLUGIN_ID --json"
		exit 4
		;;
	*)
		err "未知安装状态: $mode"
		exit 1
		;;
esac
