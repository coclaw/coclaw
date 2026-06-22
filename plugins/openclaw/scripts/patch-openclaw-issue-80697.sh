#!/usr/bin/env bash
# 给本机已安装的 OpenClaw bundled dist 打 manifest cache fallback 补丁
# （workaround for upstream issue #80697）。
#
# 背景：getStatusSummary.buildSessionRows 每个 session 都重建 plugin manifest
# snapshot ~49ms，session 多时 status/sessions.list/models.list/topics.list
# 每次卡到 10-20s。本补丁在 loadManifestModelIdNormalizationPolicies 里加一段
# 60s 进程级 fallback cache，专门接住 params.config===undefined 的调用，
# 让重复调用直接命中 cache。
#
# 用法：
#   ./patch-openclaw-issue-80697.sh           # 自动找 openclaw 安装目录并打补丁
#   ./patch-openclaw-issue-80697.sh --revert  # 从 .bak 回滚
#   ./patch-openclaw-issue-80697.sh --check   # 仅检查当前状态，不改文件
#
# 重打条件：OpenClaw 升级后 bundled dist 重生成，需要重跑本脚本。
# 上游修复后（issue #80697 合并并 release）应停止使用本补丁。
#
# ── 已知限制 / 健壮性待补强（原 TODO 迁入，2026-06-22）──────────────────────
# 本脚本是手动 workaround，sentinel 提供基本幂等、有 --revert/--check 入口；#80697
# 上游新版仅缓解未根除，故保留备查。下列为已知毛刺，非阻塞，日后真要加固再做：
#   - patch 写入用裸 writeFileSync，无 tmp+rename 原子写：半截写崩溃会留破损 dist
#     → 改 writeFileSync(tmp) + rename(tmp, target)
#   - 用法注释提到 OPENCLAW_DIST 环境变量，但 find_openclaw_dist 实际未读它 → 补读取
#   - rollback 仅在 node --check 语法校验失败时触发；"语法对但写错位置"的语义错误会直接生效
#     → 加 trap EXIT 兜底 rollback
#   - 无 OpenClaw 版本号 guard：升级后哨兵残留可能让 patch 静默跳过 → 哨兵串嵌版本号，失配即 re-patch
#   - 无 --dry-run / --verify 模式

set -euo pipefail

MODE="apply"
case "${1:-}" in
	--revert) MODE="revert" ;;
	--check) MODE="check" ;;
	--apply|"") MODE="apply" ;;
	-h|--help)
		sed -n '2,18p' "$0"
		exit 0
		;;
	*)
		echo "[ERROR] 未知参数: $1（用 --help 看用法）" >&2
		exit 2
		;;
esac

# 定位 openclaw bundled dist 目录
find_openclaw_dist() {
	# 1) 优先：openclaw CLI 在 PATH 里时按 readlink 反推
	if command -v openclaw >/dev/null 2>&1; then
		local bin
		bin=$(readlink -f "$(command -v openclaw)" 2>/dev/null || true)
		# bin 通常是 .../node_modules/openclaw/dist/cli.js 或同目录下的 entry
		local candidate
		candidate=$(dirname "$bin" 2>/dev/null || true)
		if [[ -n "$candidate" && -d "$candidate" ]] && ls "$candidate"/manifest-model-id-normalization-*.js >/dev/null 2>&1; then
			echo "$candidate"
			return
		fi
	fi
	# 2) 退化：扫常见 nvm / 全局 npm 路径
	local p
	for p in \
		"$HOME"/.nvm/versions/node/*/lib/node_modules/openclaw/dist \
		/usr/local/lib/node_modules/openclaw/dist \
		/usr/lib/node_modules/openclaw/dist; do
		if [[ -d "$p" ]] && ls "$p"/manifest-model-id-normalization-*.js >/dev/null 2>&1; then
			echo "$p"
			return
		fi
	done
	return 1
}

DIST_DIR=$(find_openclaw_dist || true)
if [[ -z "$DIST_DIR" ]]; then
	echo "[ERROR] 没找到 openclaw bundled dist 目录" >&2
	echo "[HINT] 请确保已 npm i -g openclaw，或手动指定 OPENCLAW_DIST=<path> 重跑" >&2
	exit 1
fi

# 匹配 hash 后缀的目标文件（vite/rollup 输出，OpenClaw 升级时后缀会变）
shopt -s nullglob
TARGETS=("$DIST_DIR"/manifest-model-id-normalization-*.js)
shopt -u nullglob
if (( ${#TARGETS[@]} == 0 )); then
	echo "[ERROR] $DIST_DIR 下没有 manifest-model-id-normalization-*.js" >&2
	exit 1
fi
if (( ${#TARGETS[@]} > 1 )); then
	echo "[ERROR] 找到多个候选文件，请人工确认：" >&2
	printf '  %s\n' "${TARGETS[@]}" >&2
	exit 1
fi
TARGET="${TARGETS[0]}"
BAK="$TARGET.bak"
SENTINEL="FALLBACK_CACHE_TTL_MS"

is_patched() {
	grep -q "$SENTINEL" "$TARGET" 2>/dev/null
}

case "$MODE" in
check)
	echo "[INFO] dist: $DIST_DIR"
	echo "[INFO] target: $TARGET"
	if is_patched; then
		echo "[STATUS] patched"
	else
		echo "[STATUS] unpatched"
	fi
	[[ -f "$BAK" ]] && echo "[INFO] backup present: $BAK" || echo "[INFO] no backup file"
	exit 0
	;;
revert)
	if [[ ! -f "$BAK" ]]; then
		echo "[ERROR] 找不到备份 $BAK，无法回滚" >&2
		exit 1
	fi
	cp "$BAK" "$TARGET"
	echo "[OK] 已从 $BAK 回滚 → $TARGET"
	echo "[HINT] 重启 gateway 使变更生效：openclaw gateway restart"
	exit 0
	;;
esac

# apply mode
echo "[INFO] dist: $DIST_DIR"
echo "[INFO] target: $TARGET"

if is_patched; then
	echo "[INFO] 已打过补丁（含 $SENTINEL 标记），跳过"
	exit 0
fi

# 用 anchor 替换；anchor 缺一不可，缺则保守报错（多半是 OpenClaw 升级改了源码结构）
node --input-type=module -e "
import fs from 'node:fs';
const path = '$TARGET';
const src = fs.readFileSync(path, 'utf8');

const HEAD_ANCHOR = 'let cachedPolicies;\nfunction resolveMetadataSnapshotForPolicies(params = {}) {';
const HEAD_REPLACE = \`let cachedPolicies;
let fallbackCachedPolicies = null;
let fallbackCachedAtMs = 0;
const FALLBACK_CACHE_TTL_MS = 60000;
function resolveMetadataSnapshotForPolicies(params = {}) {\`;

const FN_ANCHOR = \`function loadManifestModelIdNormalizationPolicies(params = {}) {
\tif (params.plugins) return collectManifestModelIdNormalizationPolicies(params.plugins);
\tconst { snapshot, cacheable } = resolveMetadataSnapshotForPolicies(params);
\tconst configFingerprint = snapshot.configFingerprint;
\tif (cacheable && configFingerprint && cachedPolicies?.configFingerprint === configFingerprint) return cachedPolicies.policies;
\tconst policies = collectManifestModelIdNormalizationPolicies(snapshot.plugins);
\tif (cacheable && configFingerprint) cachedPolicies = {
\t\tconfigFingerprint,
\t\tpolicies
\t};
\treturn policies;
}\`;

const FN_REPLACE = \`function loadManifestModelIdNormalizationPolicies(params = {}) {
\tif (params.plugins) return collectManifestModelIdNormalizationPolicies(params.plugins);
\tif (!params.config) {
\t\tconst now = Date.now();
\t\tif (fallbackCachedPolicies && (now - fallbackCachedAtMs) < FALLBACK_CACHE_TTL_MS) {
\t\t\treturn fallbackCachedPolicies;
\t\t}
\t}
\tconst { snapshot, cacheable } = resolveMetadataSnapshotForPolicies(params);
\tconst configFingerprint = snapshot.configFingerprint;
\tif (cacheable && configFingerprint && cachedPolicies?.configFingerprint === configFingerprint) return cachedPolicies.policies;
\tconst policies = collectManifestModelIdNormalizationPolicies(snapshot.plugins);
\tif (cacheable && configFingerprint) cachedPolicies = {
\t\tconfigFingerprint,
\t\tpolicies
\t};
\tif (!params.config) {
\t\tfallbackCachedPolicies = policies;
\t\tfallbackCachedAtMs = Date.now();
\t}
\treturn policies;
}\`;

if (!src.includes(HEAD_ANCHOR)) {
	console.error('[FAIL] 没找到 head anchor，可能 OpenClaw 升级改了源码结构');
	console.error('[HINT] 请重新核对 docs/openclaw-research/plugin-manifest-cache-mismatch.md 里的 patch 模板');
	process.exit(3);
}
if (!src.includes(FN_ANCHOR)) {
	console.error('[FAIL] 没找到 function anchor，可能 OpenClaw 升级改了源码结构');
	console.error('[HINT] 请重新核对 docs/openclaw-research/plugin-manifest-cache-mismatch.md 里的 patch 模板');
	process.exit(3);
}

fs.copyFileSync(path, path + '.bak');
const out = src.replace(HEAD_ANCHOR, HEAD_REPLACE).replace(FN_ANCHOR, FN_REPLACE);
fs.writeFileSync(path, out);
console.log('[OK] 备份 → ' + path + '.bak');
console.log('[OK] 已 patch（+' + (out.length - src.length) + ' bytes）');
"

# 语法 sanity check
if ! node --check "$TARGET" 2>/dev/null; then
	echo "[ERROR] patched 文件 node --check 失败，自动回滚" >&2
	cp "$BAK" "$TARGET"
	exit 1
fi

echo "[OK] 语法校验通过"
echo "[HINT] 重启 gateway 使变更生效：openclaw gateway restart"
echo "[HINT] 验证：time openclaw status --json > /dev/null （应明显比之前快）"
