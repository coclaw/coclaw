#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

# 为「当前 worktree」起 / 停一个一次性隔离网关，用来在活网关里验真·worktree 的插件代码。
# 完整背景与坑见 docs/worktree-plugin-dev.md。
#
# 为什么需要它：
#   活的主网关（systemd）装的是「主检出」的插件 stage——其 src 是软链回主检出。
#   所以在 worktree 改插件代码、restart 主网关也看不到（主坑）。本脚本给当前 worktree
#   建独立 stage（src 软链→本 worktree）+ 独立 profile（~/.openclaw-<profile>，不碰主
#   config）+ 独立端口的前台网关，跑完即弃，主网关 / 主 config 全程不动。
#
# profile 与端口都从 worktree 根目录名派生，保证同一 worktree 多次操作稳定、不同
# worktree 互不撞。务必在「目标 worktree 内」运行（pnpm 会自动定位到该 worktree 的脚本）。

WT_NAME="$(basename "$WORKSPACE_ROOT")"   # worktree 即仓库根；主检出则是 coclaw
PROFILE="wt-$WT_NAME"
STATE_DIR="$HOME/.openclaw-$PROFILE"
PORT_FILE="$STATE_DIR/.wt-gateway-port"
GW_LOG="$STATE_DIR/gateway.log"

# 选端口：已记录则复用（up/reload 稳定）；否则名字哈希到 18800-18879，被占向后找空位。
__pick_port() {
	if [[ -f "$PORT_FILE" ]]; then cat "$PORT_FILE"; return; fi
	local h base p
	h=$(printf '%s' "$PROFILE" | cksum | cut -d' ' -f1)
	base=$((18800 + h % 80)); p=$base
	local _i
	for _i in $(seq 1 40); do
		if ! ss -ltn 2>/dev/null | grep -q ":$p "; then echo "$p"; return; fi
		p=$((p + 1))
	done
	echo "[ERROR] 找不到空闲端口（18800 起扫 40 个都被占）" >&2; exit 1
}

__stop_gateway() {
	if [[ -f "$PORT_FILE" ]]; then
		fuser -k "$(cat "$PORT_FILE")/tcp" 2>/dev/null || true
	fi
}

__wait_ready() {
	local _i
	for _i in $(seq 1 40); do
		if grep -qE "\[gateway\].*ready" "$GW_LOG" 2>/dev/null; then return 0; fi
		sleep 0.5
	done
	echo "[ERROR] 隔离网关 20s 内未就绪，看 $GW_LOG" >&2; exit 1
}

__start_gateway() {
	local port="$1"
	# nohup + 重定向：脱离本脚本进程存活，输出落盘供 grep。--auth none 省去 token 周旋。
	nohup openclaw --profile "$PROFILE" gateway run --port "$port" \
		--force --allow-unconfigured --auth none > "$GW_LOG" 2>&1 &
	disown || true
}

cmd_up() {
	__stop_gateway   # 重复 up 时先停旧的，避免孤儿
	if [[ ! -d "$WORKSPACE_ROOT/node_modules" ]]; then
		echo "[STEP] worktree 缺 node_modules，先 pnpm install --prefer-offline"
		(cd "$WORKSPACE_ROOT" && pnpm install --prefer-offline)
	fi
	build_stage
	echo "[STEP] 装 stage 到隔离 profile：$PROFILE"
	openclaw --profile "$PROFILE" plugins install --link --dangerously-force-unsafe-install "$STAGE_DIR"
	local port; port="$(__pick_port)"
	mkdir -p "$STATE_DIR"; echo "$port" > "$PORT_FILE"
	echo "[STEP] 起隔离网关：--profile $PROFILE --port $port"
	__start_gateway "$port"
	__wait_ready
	echo ""
	echo "[DONE] worktree 隔离网关已就绪"
	echo "  profile : $PROFILE   (state: $STATE_DIR)"
	echo "  url     : ws://127.0.0.1:$port"
	echo "  log     : $GW_LOG"
	echo "  改 src/ 后：pnpm wt:reload      （改 index.js/manifest/依赖才需重跑 pnpm wt:up）"
	echo "  调 RPC ：pnpm wt:call coclaw.info"
	echo "  用完清 ：pnpm wt:down"
}

# src/ 在 stage 里是软链，改 src 只需 restart 隔离网关（不重 deploy）。
cmd_reload() {
	[[ -f "$PORT_FILE" ]] || { echo "[ERROR] 没有运行中的隔离网关，先 pnpm wt:up" >&2; exit 1; }
	local port; port="$(cat "$PORT_FILE")"
	__stop_gateway; sleep 1
	__start_gateway "$port"
	__wait_ready
	echo "[DONE] 隔离网关已重载（url ws://127.0.0.1:$port）"
}

cmd_call() {
	[[ -f "$PORT_FILE" ]] || { echo "[ERROR] 没有运行中的隔离网关，先 pnpm wt:up" >&2; exit 1; }
	local port method; port="$(cat "$PORT_FILE")"; method="${1:-}"; shift || true
	[[ -n "$method" ]] || { echo "用法: wt:call <method> [--params '<json>']" >&2; exit 1; }
	# --token x 仅为满足 --url override 的凭据守卫；auth=none 会忽略它。
	openclaw --profile "$PROFILE" gateway call "$method" --url "ws://127.0.0.1:$port" --token x --json "$@"
}

cmd_down() {
	__stop_gateway
	rm -rf "$STATE_DIR"
	echo "[DONE] 已停隔离网关并清除 profile：$PROFILE"
}

case "${1:-}" in
	up)     cmd_up ;;
	reload) cmd_reload ;;
	call)   shift; cmd_call "$@" ;;
	down)   cmd_down ;;
	*) echo "用法: $0 <up|reload|call|down>" >&2; exit 1 ;;
esac
