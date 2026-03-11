#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

# 预发布验证：打包 tarball 并安装到 OpenClaw 中验证。
#
# 用法:
#   bash scripts/prerelease.sh              # 全新安装验证（交互式）
#   bash scripts/prerelease.sh --upgrade    # 升级验证（交互式）
#   bash scripts/prerelease.sh --auto       # 全新安装验证（自动，用于 release 流程）

AUTO=false
MODE="fresh"
for arg in "$@"; do
	case "$arg" in
		--auto) AUTO=true ;;
		--upgrade) MODE="upgrade" ;;
		--fresh) MODE="fresh" ;;
	esac
done

PACK_DIR="$PLUGIN_DIR/.pack"

echo "=== 预发布验证 (mode=$MODE, auto=$AUTO) ==="

# Step 1: 质量门禁
echo ""
echo "[STEP 1] pnpm verify"
cd "$PLUGIN_DIR"
pnpm verify

# Step 2: 记录当前安装模式（用于结束后恢复）
ORIGINAL_MODE=$(get_install_mode)
echo ""
echo "[INFO] 当前安装模式: $ORIGINAL_MODE（验证完成后将恢复）"

# Step 3: 打包
echo ""
echo "[STEP 2] npm pack"
mkdir -p "$PACK_DIR"
rm -f "$PACK_DIR"/*.tgz
TARBALL=$(npm pack --pack-destination "$PACK_DIR" 2>/dev/null | tail -1)
TARBALL_PATH="$PACK_DIR/$TARBALL"
echo "[INFO] 已打包: $TARBALL_PATH"

# Step 4: 根据模式执行验证
if [[ "$MODE" == "upgrade" ]]; then
	echo ""
	echo "[STEP 3] 升级验证：先安装当前 npm 发布版本"
	ensure_uninstalled

	echo "[SUB] openclaw plugins install $PKG_NAME"
	openclaw plugins install "$PKG_NAME"
	wait_gateway_restart
	echo "[INFO] 旧版已安装，准备用本地打包版本覆盖..."

	echo ""
	echo "[STEP 4] 卸载旧版并安装本地打包版本"
	ensure_uninstalled
else
	echo ""
	echo "[STEP 3] 全新安装验证"
	ensure_uninstalled
fi

echo "[SUB] openclaw plugins install $TARBALL_PATH"
openclaw plugins install "$TARBALL_PATH"

wait_gateway_restart
verify_install

# Step 5: 交互确认 or 自动继续
if [[ "$AUTO" == "false" ]]; then
	echo ""
	echo "=========================================="
	echo "  请手动验证插件功能是否正常。"
	echo "  验证完成后按 Enter 恢复开发环境。"
	echo "  按 Ctrl+C 中止（需手动恢复）。"
	echo "=========================================="
	read -r
fi

# Step 6: 恢复到原始安装模式
echo ""
echo "[STEP] 恢复到原始安装模式: $ORIGINAL_MODE"
ensure_uninstalled

case "$ORIGINAL_MODE" in
	link)
		echo "[SUB] 恢复 link 模式"
		openclaw plugins install --link "$PLUGIN_DIR"
		;;
	npm)
		echo "[SUB] 恢复 npm 模式"
		openclaw plugins install "$PKG_NAME"
		;;
	*)
		echo "[INFO] 原始状态为 $ORIGINAL_MODE，不恢复安装"
		;;
esac

wait_gateway_restart
verify_install

echo ""
echo "[DONE] 预发布验证完成，已恢复到 $ORIGINAL_MODE 模式"
