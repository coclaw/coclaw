#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./plugin-install-lib.sh
source "$SCRIPT_DIR/plugin-install-lib.sh"

mode="$(get_install_mode)"
require_ready_config "$mode"

case "$mode" in
	npm)
		log "开始卸载 npm 安装插件: $PLUGIN_ID"
		printf 'y\n' | oc plugins uninstall "$PLUGIN_ID"
		cleanup_bindings
		cleanup_legacy_channels_config
		log "完成。gateway 重启请按你的流程手动执行。"
		;;
	link)
		err "检测到当前为 --link 安装，不执行 npm 卸载。请改用: pnpm run plugin:dev:unlink"
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
