#!/usr/bin/env bash
set -euo pipefail

# 发布 @coclaw/openclaw-coclaw 插件到 npm。
# 说明：该脚本不会直接修改 ~/.openclaw/openclaw.json。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"

cd "$PLUGIN_DIR"

echo "[STEP 1/5] 检查工作目录"
if [[ ! -f "package.json" ]] || [[ ! -f "openclaw.plugin.json" ]]; then
	echo "[ERROR] 必须在插件根目录执行（未找到 package.json 或 openclaw.plugin.json）" >&2
	exit 1
fi

PKG_NAME=$(node -e "console.log(require('./package.json').name)")
PKG_VERSION=$(node -e "console.log(require('./package.json').version)")
echo "[INFO] 包名: $PKG_NAME  版本: $PKG_VERSION"
echo "[INFO] 发布 registry: $NPM_REGISTRY"

# 检查是否 private
IS_PRIVATE=$(node -e "console.log(require('./package.json').private ?? false)")
if [[ "$IS_PRIVATE" == "true" ]]; then
	echo "[ERROR] package.json 中 private=true，无法发布" >&2
	exit 1
fi

echo "[STEP 2/5] 校验 npm 凭据与连通性"
npm whoami --registry="$NPM_REGISTRY" >/dev/null
npm ping --registry="$NPM_REGISTRY" >/dev/null

echo "[STEP 3/5] dry-run 检查发布通路与内容"
# 使用 publish --dry-run 比 pack 更接近真实发布流程
npm publish --dry-run --access public --registry="$NPM_REGISTRY"
echo ""
echo "[INFO] 以上为将要发布的文件列表，请确认无敏感文件。"

echo "[STEP 4/5] (可选) 质量门禁"
if [[ "${RUN_VERIFY:-0}" == "1" ]]; then
	echo "[INFO] RUN_VERIFY=1，执行 pnpm verify"
	pnpm verify
else
	echo "[INFO] 跳过 verify（如需启用：RUN_VERIFY=1 bash ./scripts/publish-npm.sh）"
fi

echo "[STEP 5/5] 发布到 npm"
# --access public 确保非 scope 包也能正常发布
npm publish --access public --registry="$NPM_REGISTRY"

echo ""
echo "[DONE] $PKG_NAME@$PKG_VERSION 已发布到 npm"
echo "[INFO] 安装命令: openclaw plugins install $PKG_NAME"

# 触发 npmmirror 同步，避免使用镜像的用户拉到旧版
echo "[POST] 触发 npmmirror 镜像同步..."
SYNC_STATUS=$(curl -sSf -X PUT "https://registry-direct.npmmirror.com/$PKG_NAME/sync" 2>&1) && \
	echo "[POST] 同步已触发: $SYNC_STATUS" || \
	echo "[POST] 镜像同步触发失败（不影响发布）: $SYNC_STATUS"
