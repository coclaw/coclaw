#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./plugin-install-lib.sh
source "$SCRIPT_DIR/plugin-install-lib.sh"

mode="$(get_install_mode)"
require_ready_config "$mode"

case "$mode" in
	npm)
		err "检测到当前为 npm 安装。请先执行: pnpm run plugin:npm:uninstall"
		exit 2
		;;
	link)
		log "已是 --link 安装，无需重复安装。"
		exit 0
		;;
	none)
		log "开始以 --link 模式安装本地插件: $PLUGIN_DIR"
		oc plugins install --link "$PLUGIN_DIR"
		log "完成。gateway 重启请按你的流程手动执行。"
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
