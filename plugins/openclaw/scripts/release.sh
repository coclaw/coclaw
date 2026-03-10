#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

# 发布 @coclaw/openclaw-coclaw 到 npm。
# 流程：预发布验证 → 凭据检查 → dry-run → 发布 → 轮询确认。

NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"

cd "$PLUGIN_DIR"

echo "=== 发布 $PKG_NAME ==="

# Step 1: 基本检查
echo ""
echo "[STEP 1/6] 检查工作目录"
if [[ ! -f "package.json" ]] || [[ ! -f "openclaw.plugin.json" ]]; then
	echo "[ERROR] 未找到 package.json 或 openclaw.plugin.json" >&2
	exit 1
fi

PKG_VERSION=$(node -e "console.log(require('./package.json').version)")
IS_PRIVATE=$(node -e "console.log(require('./package.json').private ?? false)")

echo "[INFO] 包名: $PKG_NAME  版本: $PKG_VERSION"
echo "[INFO] Registry: $NPM_REGISTRY"

if [[ "$IS_PRIVATE" == "true" ]]; then
	echo "[ERROR] package.json 中 private=true" >&2
	exit 1
fi

# Step 2: 预发布验证
echo ""
echo "[STEP 2/6] 预发布验证"
bash "$SCRIPT_DIR/prerelease.sh" --auto

# Step 3: npm 凭据
echo ""
echo "[STEP 3/6] 校验 npm 凭据与连通性"
npm whoami --registry="$NPM_REGISTRY" >/dev/null
npm ping --registry="$NPM_REGISTRY" >/dev/null
echo "[INFO] 凭据有效"

# Step 4: dry-run
echo ""
echo "[STEP 4/6] dry-run 发布检查"
npm publish --dry-run --access public --registry="$NPM_REGISTRY"
echo ""
echo "[INFO] 以上为将要发布的文件列表，请确认无敏感文件。"

# Step 5: 发布
echo ""
echo "[STEP 5/6] 发布到 npm"
npm publish --access public --registry="$NPM_REGISTRY"
echo "[INFO] $PKG_NAME@$PKG_VERSION 已提交到 npm"

# 触发 npmmirror 同步
echo "[POST] 触发 npmmirror 同步..."
curl -sSf -X PUT "https://registry-direct.npmmirror.com/$PKG_NAME/sync" >/dev/null 2>&1 || \
	echo "[WARN] npmmirror 同步触发失败（不影响发布）"

# Step 6: 轮询确认发布生效
echo ""
echo "[STEP 6/6] 确认发布生效"
WAIT=1 bash "$SCRIPT_DIR/release-check.sh" "$PKG_VERSION"

echo ""
echo "[DONE] $PKG_NAME@$PKG_VERSION 发布完成"
