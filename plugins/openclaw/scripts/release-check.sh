#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

# 检查 npm 官方和 npmmirror 的插件包版本。
#
# 用法:
#   bash scripts/release-check.sh              # 显示当前各 registry 最新版本
#   bash scripts/release-check.sh 0.1.7        # 显示并对比指定版本
#   WAIT=1 bash scripts/release-check.sh 0.1.7 # 轮询直到指定版本在所有 registry 生效
#   DIST_TAG=beta bash scripts/release-check.sh 0.1.8-beta.0  # 检查 beta tag

NPM_REGISTRY="https://registry.npmjs.org"
TIMEOUT="${POLL_TIMEOUT:-120}"
INTERVAL=5
INITIAL_DELAY="${INITIAL_DELAY:-5}"
DIST_TAG="${DIST_TAG:-latest}"

EXPECTED_VERSION="${1:-}"

# npm view 查询指定 registry 的 dist-tag 版本
# 带 --registry 查官方源，不带则查本机配置的源（通常为 npmmirror）
check_npm_version() {
	local version
	version=$(npm view "$PKG_NAME" dist-tags."$DIST_TAG" --registry="$NPM_REGISTRY" 2>/dev/null) || true
	echo "${version:-N/A}"
}

check_mirror_version() {
	local version
	version=$(npm view "$PKG_NAME" dist-tags."$DIST_TAG" 2>/dev/null) || true
	echo "${version:-N/A}"
}

# 非等待模式：显示当前状态
if [[ "${WAIT:-}" != "1" ]]; then
	echo "=== $PKG_NAME 版本状态 (tag: $DIST_TAG) ==="
	echo ""
	npm_latest=$(check_npm_version)
	mirror_latest=$(check_mirror_version)
	echo "[npm]       $DIST_TAG: $npm_latest"
	echo "[npmmirror] $DIST_TAG: $mirror_latest"

	if [[ -n "$EXPECTED_VERSION" ]]; then
		echo ""
		if [[ "$npm_latest" == "$EXPECTED_VERSION" ]]; then
			echo "[npm]       $EXPECTED_VERSION -- OK"
		else
			echo "[npm]       $EXPECTED_VERSION -- NOT YET (current: $npm_latest)"
		fi
		if [[ "$mirror_latest" == "$EXPECTED_VERSION" ]]; then
			echo "[npmmirror] $EXPECTED_VERSION -- OK"
		else
			echo "[npmmirror] $EXPECTED_VERSION -- NOT YET (current: $mirror_latest)"
		fi
	fi

	echo ""
	echo "[HINT] 轮询等待: WAIT=1 pnpm run release:check -- $EXPECTED_VERSION"
	[[ "$DIST_TAG" != "latest" ]] && echo "[HINT] 指定 tag: DIST_TAG=$DIST_TAG WAIT=1 pnpm run release:check -- $EXPECTED_VERSION"
	exit 0
fi

# 等待模式：轮询直到 expected version 在所有 registry 生效
if [[ -z "$EXPECTED_VERSION" ]]; then
	echo "[ERROR] 等待模式需要指定版本号" >&2
	exit 1
fi

echo "=== 等待 $PKG_NAME@$EXPECTED_VERSION 发布生效 (timeout: ${TIMEOUT}s) ==="

# 初始等待：发布和镜像同步通常几秒内完成，先等一下再查询
echo "[INFO] 等待 ${INITIAL_DELAY}s 后开始检查..."
sleep "$INITIAL_DELAY"

elapsed=0
npm_ok=false
mirror_ok=false

while [[ $elapsed -lt $TIMEOUT ]]; do
	if [[ "$npm_ok" != "true" ]]; then
		v=$(check_npm_version)
		if [[ "$v" == "$EXPECTED_VERSION" ]]; then
			npm_ok=true
			echo "[npm]       $EXPECTED_VERSION -- OK (${elapsed}s)"
		fi
	fi

	if [[ "$mirror_ok" != "true" ]]; then
		v=$(check_mirror_version)
		if [[ "$v" == "$EXPECTED_VERSION" ]]; then
			mirror_ok=true
			echo "[npmmirror] $EXPECTED_VERSION -- OK (${elapsed}s)"
		fi
	fi

	if [[ "$npm_ok" == "true" && "$mirror_ok" == "true" ]]; then
		echo ""
		echo "[DONE] $PKG_NAME@$EXPECTED_VERSION 已在所有 registry 生效"
		exit 0
	fi

	sleep $INTERVAL
	elapsed=$((elapsed + INTERVAL))

	# 每 15 秒打印一次进度
	if (( elapsed % 15 == 0 )); then
		status=""
		[[ "$npm_ok" == "true" ]] && status="npm:OK" || status="npm:waiting"
		[[ "$mirror_ok" == "true" ]] && status="$status, mirror:OK" || status="$status, mirror:waiting"
		echo "[WAIT] ${elapsed}s ($status)"
	fi
done

echo ""
echo "[TIMEOUT] ${TIMEOUT}s 超时"
[[ "$npm_ok" == "true" ]] && echo "[npm]       OK" || echo "[npm]       FAIL (未检测到 $EXPECTED_VERSION)"
[[ "$mirror_ok" == "true" ]] && echo "[npmmirror] OK" || echo "[npmmirror] FAIL (未检测到 $EXPECTED_VERSION)"
exit 1
