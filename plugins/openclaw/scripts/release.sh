#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

# 发布 @coclaw/openclaw-coclaw 到 npm。
# 流程：质量门禁 → 凭据检查 → dry-run → 发布 → 轮询确认。
#
# 用法:
#   bash scripts/release.sh               # 默认：verify → 发布（latest tag）
#   bash scripts/release.sh --prerelease  # 含预发布验证（pack + 安装测试）
#   bash scripts/release.sh --beta        # 发布 beta 版（beta tag，不影响 latest）

RUN_PRERELEASE=false
BETA=false
for arg in "$@"; do
	case "$arg" in
		--prerelease) RUN_PRERELEASE=true ;;
		--beta) BETA=true ;;
	esac
done

NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"

cd "$PLUGIN_DIR"

PKG_VERSION=$(node -e "console.log(require('./package.json').version)")
IS_PRIVATE=$(node -e "console.log(require('./package.json').private ?? false)")

# beta 模式下校验版本号包含预发布标识
if [[ "$BETA" == "true" ]]; then
	DIST_TAG="beta"
	if [[ "$PKG_VERSION" != *-beta* ]]; then
		echo "[ERROR] --beta 模式要求版本号包含 -beta 预发布标识（当前: $PKG_VERSION）" >&2
		echo "[HINT] 先执行: npm version prerelease --preid=beta  或手动修改 package.json" >&2
		exit 1
	fi
else
	DIST_TAG="latest"
	# 正式发布时拒绝预发布版本号
	if [[ "$PKG_VERSION" == *-* ]]; then
		echo "[ERROR] 正式发布不允许预发布版本号（当前: $PKG_VERSION）" >&2
		echo "[HINT] 若要发布 beta，请加 --beta 参数" >&2
		exit 1
	fi
fi

echo "=== 发布 $PKG_NAME ($DIST_TAG) ==="

# Step 1: 基本检查
echo ""
echo "[STEP 1/5] 检查工作目录"
if [[ ! -f "package.json" ]] || [[ ! -f "openclaw.plugin.json" ]]; then
	echo "[ERROR] 未找到 package.json 或 openclaw.plugin.json" >&2
	exit 1
fi

echo "[INFO] 包名: $PKG_NAME  版本: $PKG_VERSION  tag: $DIST_TAG"
echo "[INFO] Registry: $NPM_REGISTRY"

if [[ "$IS_PRIVATE" == "true" ]]; then
	echo "[ERROR] package.json 中 private=true" >&2
	exit 1
fi

# Step 2: 质量门禁
echo ""
if [[ "$RUN_PRERELEASE" == "true" ]]; then
	echo "[STEP 2/5] 预发布验证（含 pack + 安装测试）"
	bash "$SCRIPT_DIR/prerelease.sh" --auto
else
	echo "[STEP 2/5] pnpm verify"
	pnpm verify
fi

# Step 3: npm 凭据
echo ""
echo "[STEP 3/5] 校验 npm 凭据与连通性"
npm whoami --registry="$NPM_REGISTRY" >/dev/null
npm ping --registry="$NPM_REGISTRY" >/dev/null
echo "[INFO] 凭据有效"

# Step 4: dry-run + 发布
echo ""
echo "[STEP 4/5] dry-run 发布检查"
npm publish --dry-run --access public --registry="$NPM_REGISTRY" --tag "$DIST_TAG"
echo ""
echo "[INFO] 以上为将要发布的文件列表，请确认无敏感文件。"

echo ""
echo "[STEP 4/5] 发布到 npm (tag: $DIST_TAG)"
npm publish --access public --registry="$NPM_REGISTRY" --tag "$DIST_TAG"
echo "[INFO] $PKG_NAME@$PKG_VERSION 已提交到 npm (tag: $DIST_TAG)"

# 触发 npmmirror 同步
echo "[POST] 触发 npmmirror 同步..."
curl -sSf -X PUT "https://registry-direct.npmmirror.com/$PKG_NAME/sync" >/dev/null 2>&1 || \
	echo "[WARN] npmmirror 同步触发失败（不影响发布）"

# Step 5: 轮询确认发布生效
echo ""
echo "[STEP 5/5] 确认发布生效"
WAIT=1 DIST_TAG="$DIST_TAG" bash "$SCRIPT_DIR/release-check.sh" "$PKG_VERSION"

echo ""
echo "[DONE] $PKG_NAME@$PKG_VERSION 发布完成 (tag: $DIST_TAG)"
