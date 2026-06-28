#!/usr/bin/env bash
set -euo pipefail

# 发布编排（不可逆段）：push main → 等该 commit 的 CI 绿（门禁）→ 打/push tag（钉确切 SHA）
#   → 监控 tag 触发的镜像构建（非门禁）。供 /release skill 调用，详见 .claude/skills/release/SKILL.md。
#
# 用法：bash scripts/release-publish.sh <version>            # 0.32.11 或 v0.32.11，tag 为 v<version>
#   隔离自检：bash scripts/release-publish.sh --decide <head-ref>   # 只打印镜像推导，不做任何不可逆动作
#
# 退出码：push 失败 / CI 红 / CI 超时 → 非零（均在打 tag 前中止，远端零残留）；
#         镜像监控异常 → 只告警、exit 0（tag 已推、不可逆，非门禁）。

# --- 镜像推导：忠实复刻 .github/workflows/publish-images.yaml 的 "Decide which images to build" ---
# 用于（a）调监控节奏（含 server 更慢）；（b）校验实际构建是否符合预期。改这里务必与那个 workflow 同步，否则误报。

resolve_base() {
	# 沿祖先链找 <ref> 之前最近的 v* tag（对齐 workflow 的 `git describe ... 'HEAD^'`）。
	# 找不到（首个 tag / 无父）→ 空，调用方退化为全建。需本地已有上个版本 tag。
	git describe --tags --match 'v*' --abbrev=0 "$1^" 2>/dev/null || true
}

decide_images() {
	# 复刻 workflow：按 <base>..<head> 的路径 diff 判定建哪些镜像，结果写全局 BUILD_SERVER / BUILD_UI。
	local base="$1" head="$2"
	# 根级镜像输入变更 → 两个都建：lock / workspace / .dockerignore 任一改动，或根 package.json 的
	# 「非 version 行」实质改动（version bump 每次发布都有、不影响产物，必须排除，否则选择性构建被 churn 打回全建）。
	local root_pkg_real
	root_pkg_real=$(git diff "$base" "$head" -- package.json \
		| grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | grep -vE '^[+-][[:space:]]*"version":' || true)
	if [ -n "$(git diff --name-only "$base" "$head" -- pnpm-lock.yaml pnpm-workspace.yaml .dockerignore)" ] \
		|| [ -n "$root_pkg_real" ]; then
		BUILD_SERVER=true
		BUILD_UI=true
		return
	fi
	# 各服务信号 = 服务目录 diff（含其 package.json 版本 bump）+ 对应 build 脚本 diff。
	BUILD_SERVER=$([ -n "$(git diff --name-only "$base" "$head" -- server/ scripts/build-server.sh)" ] && echo true || echo false)
	BUILD_UI=$([ -n "$(git diff --name-only "$base" "$head" -- ui/ scripts/build-ui.sh)" ] && echo true || echo false)
}

# --- 隔离自检入口：只打印推导，不碰远端 ---
if [ "${1:-}" = "--decide" ]; then
	head="${2:?usage: release-publish.sh --decide <head-ref>}"
	base=$(resolve_base "$head")
	if [ -z "$base" ]; then
		echo "no prev v* tag for $head -> full build (server+ui)"
		exit 0
	fi
	decide_images "$base" "$head"
	echo "base=$base head=$head -> build_server=$BUILD_SERVER build_ui=$BUILD_UI"
	exit 0
fi

# ===========================  正式发布编排  ===========================

RAW="${1:?usage: release-publish.sh <version>  e.g. 0.32.11 或 v0.32.11}"
VERSION="${RAW#v}"
TAG="v$VERSION"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || { echo "bad version: $RAW"; exit 1; }

command -v gh >/dev/null 2>&1 || { echo "missing command: gh"; exit 1; }

# HEAD 必须是 main：`git push origin main` 推 main、SHA 钉 HEAD，错位会 tag 到没推上去的 commit。
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = main ] || { echo "not on main (on $BRANCH); aborting"; exit 1; }
# 工作区须干净：bump commit 应已落定，脏树意味着 HEAD 未必含本次 bump。
if ! git diff --quiet || ! git diff --cached --quiet; then
	echo "working tree not clean; commit the bump first; aborting"; exit 1
fi

SCRIPT_START=$(date +%s)
DEADLINE_S=570 # 整脚本墙钟上限 ~9.5min，护住 agent 的 10min 工具超时；只约束非门禁的镜像监控。
within_deadline() { [ $(( $(date +%s) - SCRIPT_START )) -lt "$DEADLINE_S" ]; }

echo "=== push main ==="
git push origin main
SHA=$(git rev-parse HEAD) # 钉本次 bump commit；CI 门禁、tag 都对这个 SHA，绝不用裸 HEAD。
echo "bump commit SHA: $SHA"

echo "=== ci gate (门禁) ==="
# CI（ci.yaml）只在 push main / PR 触发，tag 不触发它——等的就是上面 push 触发的那次。
RUN_ID=""
for _ in $(seq 1 12); do
	# `// empty`：gojq 对空数组的 .[0].x 输出字面 "null"（非空串），不归一会让下面的 -n 守卫误判「已找到」、架空重试。
	RUN_ID=$(gh run list --workflow ci.yaml --commit "$SHA" --limit 1 --json databaseId -q '.[0].databaseId // empty' || true)
	[ -n "$RUN_ID" ] && break
	sleep 5
done
[ -z "$RUN_ID" ] && { echo "CI run for $SHA not found; aborting"; exit 1; }
echo "CI run id: $RUN_ID"
sleep 135 # CI 实测 ~2min+，先一次性等过拐点，省掉头几次必然 in_progress 的白查。
STATUS=""
for _ in $(seq 1 18); do # 之后短间隔轮询，有上界（再 ~3min）。
	STATUS=$(gh run view "$RUN_ID" --json status -q '.status' || true)
	[ "$STATUS" = "completed" ] && break
	sleep 10
done
if [ "$STATUS" != "completed" ]; then
	echo "CI 超时未结束（run ${RUN_ID}）：去 Actions 页核实，绿了再手动对该 SHA 打 tag。aborting"
	exit 1
fi
CONCLUSION=$(gh run view "$RUN_ID" --json conclusion -q '.conclusion' || true)
echo "CI conclusion: $CONCLUSION"
[ "$CONCLUSION" = "success" ] || { echo "CI not green ($CONCLUSION); aborting tag/release"; exit 1; }

echo "=== tag ==="
# 不存在才建（`git tag -l` 命中失败也退 0，不能当存在性判断）；本次新建则记下，push 失败时回滚本地 tag。
TAG_CREATED=false
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
	git tag "$TAG" "$SHA"
	TAG_CREATED=true
fi
if ! git push origin "$TAG"; then
	echo "push tag $TAG failed"
	[ "$TAG_CREATED" = true ] && { git tag -d "$TAG"; echo "removed local tag $TAG (created this run, not pushed)"; }
	exit 1
fi
echo "tagged & pushed $TAG @ $SHA"

echo "=== images (非门禁) ==="
# 推导本次该建哪些镜像（与 publish-images.yaml 同源），用于调监控节奏 + 校验实际构建。
BUILD_SERVER=true
BUILD_UI=true
BASE=$(resolve_base "$SHA")
if [ -z "$BASE" ]; then
	echo "no prev v* tag -> 预期全建 (server+ui)"
else
	decide_images "$BASE" "$SHA"
	echo "prev tag $BASE -> 预期 build_server=$BUILD_SERVER build_ui=$BUILD_UI"
fi

# 找 tag push 触发的 publish-images run（按 push 事件取最新；有注册延迟，短重试）。
PUB_RUN_ID=""
for _ in $(seq 1 12); do
	PUB_RUN_ID=$(gh run list --workflow publish-images.yaml --event push --limit 1 --json databaseId -q '.[0].databaseId // empty' || true)
	[ -n "$PUB_RUN_ID" ] && break
	sleep 5
done
if [ -z "$PUB_RUN_ID" ]; then
	echo "WARN: publish-images run 未找到——去 Actions 页确认是否触发/需手动补建（tag 已推，非门禁）"
	exit 0
fi
echo "publish-images run id: $PUB_RUN_ID"

# 按推导调节奏：含 server（arm64 模拟 ~4min+）先 sleep 过拐点；仅 ui（~50s）从头短间隔轮询。
# 整段受 within_deadline 兜底，确保不撞穿 10min 工具超时（非门禁，到点未完只告警）。
if [ "$BUILD_SERVER" = true ]; then
	echo "含 server 构建（较慢），先等 ~2min 再轮询"
	waited=0
	while [ "$waited" -lt 120 ] && within_deadline; do sleep 10; waited=$((waited + 10)); done
fi
PUB_STATUS=""
while within_deadline; do
	PUB_STATUS=$(gh run view "$PUB_RUN_ID" --json status -q '.status' || true)
	[ "$PUB_STATUS" = "completed" ] && break
	sleep 15
done
if [ "$PUB_STATUS" != "completed" ]; then
	echo "WARN: 镜像未在预算内建完（run ${PUB_RUN_ID}）——非失败，去 Actions 页看最终结果（tag 已推，非门禁）"
	exit 0
fi
PUB_CONCLUSION=$(gh run view "$PUB_RUN_ID" --json conclusion -q '.conclusion' || true)
if [ "$PUB_CONCLUSION" != "success" ]; then
	echo "WARN: 镜像构建未成功（conclusion=${PUB_CONCLUSION}, run ${PUB_RUN_ID}）——去 Actions 排查，必要时 gh workflow run publish-images.yaml（tag 已推，非门禁）"
	exit 0
fi
echo "镜像构建成功（run ${PUB_RUN_ID}；未改动服务 step=skipped 属正常）"

# 校验实际构建与推导是否一致（非门禁，仅漂移时告警）。step conclusion=skipped 表示该服务被跳过。
server_step=$(gh run view "$PUB_RUN_ID" --json jobs -q '.jobs[].steps[]|select(.name=="Build & push server image")|.conclusion' 2>/dev/null | head -n1 || true)
ui_step=$(gh run view "$PUB_RUN_ID" --json jobs -q '.jobs[].steps[]|select(.name=="Build & push ui image")|.conclusion' 2>/dev/null | head -n1 || true)
actual_server=$([ -n "$server_step" ] && [ "$server_step" != skipped ] && echo true || echo false)
actual_ui=$([ -n "$ui_step" ] && [ "$ui_step" != skipped ] && echo true || echo false)
echo "推导: server=$BUILD_SERVER ui=$BUILD_UI ；实际: server=$actual_server ui=$actual_ui"
if [ "$actual_server" != "$BUILD_SERVER" ] || [ "$actual_ui" != "$BUILD_UI" ]; then
	echo "WARN: 实际构建与本地推导不符——脚本推导可能与 publish-images.yaml 漂移，请核对（非门禁）"
fi
exit 0
