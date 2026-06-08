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
PID_FILE="$STATE_DIR/.wt-gateway-pid"
GW_LOG="$STATE_DIR/gateway.log"

# --- 可移植原语：端口探测多级回退 + 自带超时替代 Linux-only 的 timeout ---
# 端口探测按 lsof -> ss -> fuser 三级回退：lsof 永远第一优先（macOS/Linux 都有，且
# macOS 无 ss、其 BSD fuser 又不认 <port>/tcp 语法，故 Mac 全靠 lsof）；ss/fuser 是
# Linux 上 lsof 缺席时的兜底（沿用 Mac 兼容改造前的老码）。三者全缺则一次性响亮告警，
# 端口探测降级但不再静默。

# 端口探测工具全缺（lsof/ss/fuser 都没装）时的一次性响亮告警：用模块级 flag 守住，
# 避免每次探端口都刷屏；走 stderr，文案点名三者并给可操作的安装提示。
__PORT_PROBE_WARNED=""
__warn_no_port_probe() {
	[[ -n "$__PORT_PROBE_WARNED" ]] && return 0
	__PORT_PROBE_WARNED=1
	echo "[WARN] 端口探测不可用：lsof / ss / fuser 三者都没装。" >&2
	echo "       隔离网关的端口起 / 停判断会失准（可能误判端口空闲、或漏杀残留旧网关）。" >&2
	echo "       请装其一后重试：Linux 用 apt install lsof（或 iproute2 / psmisc），macOS 用 brew install lsof。" >&2
}

# 端口是否被监听（占用）。返回 0=占用，1=空闲。
# 三级回退 lsof -> ss -> fuser；三者全缺则告警一次并视为「未占用」(rc=1) 继续。
__port_in_use() {   # $1=port
	if command -v lsof >/dev/null 2>&1; then
		lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
	elif command -v ss >/dev/null 2>&1; then
		ss -ltn 2>/dev/null | grep -q ":$1 "
	elif command -v fuser >/dev/null 2>&1; then
		fuser "$1/tcp" >/dev/null 2>&1
	else
		__warn_no_port_probe
		return 1
	fi
}

# 列出监听某端口的 pid（每行一个；无则空）。替代 fuser <port>/tcp。
# 三级回退 lsof -> ss -> fuser（顺序与 __port_in_use 一致）；三者全缺则告警一次并输出空。
# ss -ltnp 同用户网关看得到自身 pid，无需 root；端口锚定沿用 ":$1 " 防子串误配。
# 双栈监听（v4+v6）会让 ss 重复输出同一 pid，sort -u 去重，与 lsof/fuser 的单行输出对齐。
__port_listener_pids() {   # $1=port
	if command -v lsof >/dev/null 2>&1; then
		lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
	elif command -v ss >/dev/null 2>&1; then
		ss -ltnp 2>/dev/null | grep ":$1 " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
	elif command -v fuser >/dev/null 2>&1; then
		fuser "$1/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true
	else
		__warn_no_port_probe
	fi
}

# 在 secs 秒内运行命令，超时 TERM 杀之并返回 124。优先用 coreutils 的
# timeout/gtimeout（信号传播更稳）；都没有（macOS 默认）时退化为可移植轮询看门狗。
__run_timeout() {   # $1=secs  $2..=cmd
	local secs="$1"; shift
	if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; return $?; fi
	if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"; return $?; fi
	"$@" &
	local cmd_pid=$! count=0 rc=0
	local tenths=$((secs * 10))
	while kill -0 "$cmd_pid" 2>/dev/null; do
		if [[ "$count" -ge "$tenths" ]]; then
			kill -TERM "$cmd_pid" 2>/dev/null || true
			wait "$cmd_pid" 2>/dev/null || true
			return 124
		fi
		sleep 0.1
		count=$((count + 1))
	done
	wait "$cmd_pid" || rc=$?
	return "$rc"
}

# 选端口：已记录则复用（up/reload 稳定）；否则名字哈希到 18800-18879，被占向后找空位。
__pick_port() {
	if [[ -f "$PORT_FILE" ]]; then cat "$PORT_FILE"; return; fi
	local h base p
	h=$(printf '%s' "$PROFILE" | cksum | cut -d' ' -f1)
	base=$((18800 + h % 80)); p=$base
	local _i
	for _i in $(seq 1 40); do
		if ! __port_in_use "$p"; then echo "$p"; return; fi
		p=$((p + 1))
	done
	echo "[ERROR] 找不到空闲端口（18800 起扫 40 个都被占）" >&2; exit 1
}

# pid 与端口双向印证：确认 pid 仍占着记录的端口才认定它是本工具起的网关。
# （gateway 进程把 /proc/<pid>/cmdline 改写成了 "openclaw"，靠 cmdline 辨识不了；
#  pid+port 双印证还能同时挡住「pid 复用」和「别的进程接管了端口」两种误伤。）
__pid_owns_port() {   # $1=pid  $2=port
	local owners
	owners="$(__port_listener_pids "$2" | tr '\n' ' ')"
	[[ " $owners " == *" $1 "* ]]
}

__stop_gateway() {
	# 优先按 pid 精确停：仅当记录 pid 仍存活且仍占着记录端口时才杀，
	# 避开 fuser 按端口盲杀「碰巧接管该端口的无关进程」。
	if [[ -f "$PID_FILE" ]]; then
		local pid port
		pid="$(cat "$PID_FILE" 2>/dev/null || true)"
		port="$(cat "$PORT_FILE" 2>/dev/null || true)"
		rm -f "$PID_FILE"
		if [[ -n "$pid" && -n "$port" ]] && kill -0 "$pid" 2>/dev/null && __pid_owns_port "$pid" "$port"; then
			kill "$pid" 2>/dev/null || true
		fi
		return 0   # PID_FILE 存在即本工具管控：pid 已不占端口=网关自行退出，不再盲按端口杀
	fi
	# 无 PID_FILE（旧 state 兼容）：best-effort 按端口杀（端口作用域，非广义匹配）
	if [[ -f "$PORT_FILE" ]]; then
		local lp
		lp="$(__port_listener_pids "$(cat "$PORT_FILE")")"
		[[ -n "$lp" ]] && kill $lp 2>/dev/null || true
	fi
}

# 就绪判断走 RPC 探活（call coclaw.info）而非 grep 上游日志文案：既不耦合日志措辞，
# 又顺带证明插件已加载、RPC 真可达——网关起来但插件没加载会在这里 loud 失败。
__wait_ready() {
	local port="$1" _i
	for _i in $(seq 1 40); do
		if __run_timeout 5 openclaw --profile "$PROFILE" gateway call coclaw.info \
			--url "ws://127.0.0.1:$port" --token x --json >/dev/null 2>&1; then
			return 0
		fi
		sleep 0.5
	done
	echo "[ERROR] 隔离网关 20s 内 RPC 未就绪（coclaw.info 调不通：网关起失败或插件未加载），看 $GW_LOG" >&2
	exit 1
}

# 等端口释放：停掉旧网关后端口约 250ms 才放开。不靠 `gateway run --force` 抢占，
# 而是等自己端口空出来再起——这样不依赖上游 --force 语义（避免它哪天从"只杀目标端口"
# 变成"杀任意网关"而误伤主网关），端口被无关进程占着时也能 loud 失败而非盲杀。
__wait_port_free() {   # $1=port
	local _i
	for _i in $(seq 1 30); do   # 最多 ~3s
		__port_in_use "$1" || return 0
		sleep 0.1
	done
	echo "[ERROR] 端口 $1 3s 内未释放（可能被无关进程占用）；换端口或先 pnpm wt:down --all" >&2
	exit 1
}

__start_gateway() {
	local port="$1"
	mkdir -p "$STATE_DIR"
	__wait_port_free "$port"   # 不传 --force：先等自己端口空出来再起，不抢占
	# nohup + 重定向：脱离本脚本进程存活，输出落盘备查。--auth none 省去 token 周旋。
	nohup openclaw --profile "$PROFILE" gateway run --port "$port" \
		--allow-unconfigured --auth none > "$GW_LOG" 2>&1 &
	echo $! > "$PID_FILE"   # 记 pid 供 __stop_gateway 精确停
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
	# install 期安全扫描已过，补 node_modules/openclaw 软链供 runtime 解析 plugin-sdk
	# （reload 不重建 stage，此链跨 reload 存活）。
	ensure_openclaw_link
	local port; port="$(__pick_port)"
	mkdir -p "$STATE_DIR"; echo "$port" > "$PORT_FILE"
	echo "[STEP] 起隔离网关：--profile $PROFILE --port $port"
	__start_gateway "$port"
	__wait_ready "$port"
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
	__stop_gateway   # 精确停旧网关；__start_gateway 内 __wait_port_free 负责等端口放开
	__start_gateway "$port"
	__wait_ready "$port"
	echo "[DONE] 隔离网关已重载（url ws://127.0.0.1:${port}）"
}

cmd_call() {
	[[ -f "$PORT_FILE" ]] || { echo "[ERROR] 没有运行中的隔离网关，先 pnpm wt:up" >&2; exit 1; }
	local port method; port="$(cat "$PORT_FILE")"; method="${1:-}"; shift || true
	[[ -n "$method" ]] || { echo "用法: wt:call <method> [--params '<json>']" >&2; exit 1; }
	# --token x 仅为满足 --url override 的凭据守卫；auth=none 会忽略它。
	openclaw --profile "$PROFILE" gateway call "$method" --url "ws://127.0.0.1:$port" --token x --json "$@"
}

cmd_down() {
	if [[ "${1:-}" == "--all" ]]; then __reap_all; return; fi
	__stop_gateway
	rm -rf "$STATE_DIR"
	echo "[DONE] 已停隔离网关并清除 profile：$PROFILE"
}

# 兜底清理所有遗留隔离网关——含「worktree 已删、wt:down 调不动而搁浅」的孤儿。
# 扫文件系统不依赖 cwd，可从任意检出运行。按 pid 精确收尸：仅杀「pid 仍活且仍占记录端口」者，
# 故意不设按端口兜底杀（那会误伤接管该端口的无关进程）——换来「绝不误伤」。代价：pid 记录丢失的
# 网关收不到（只会发生在 SIGTERM 没生效 / 手动删了 pid 文件，而 OpenClaw 实测稳收 SIGTERM），
# 会留真孤儿、需手动 kill（如 lsof -t -iTCP:<port> -sTCP:LISTEN | xargs kill）。极窄、可接受，是有意取舍。
__reap_all() {
	shopt -s nullglob
	local dirs=("$HOME"/.openclaw-wt-*)
	shopt -u nullglob
	if [[ ${#dirs[@]} -eq 0 ]]; then
		echo "[INFO] 没有可清理的隔离网关（~/.openclaw-wt-*）"; return
	fi
	local d name pid port
	for d in "${dirs[@]}"; do
		[[ -d "$d" ]] || continue
		name="$(basename "$d")"
		pid="$(cat "$d/.wt-gateway-pid" 2>/dev/null || true)"
		port="$(cat "$d/.wt-gateway-port" 2>/dev/null || true)"
		# 仅当 pid 仍存活且仍占着该 profile 记录端口才杀（pid+port 双印证，避免误伤接管端口的无关进程）
		if [[ -n "$pid" && -n "$port" ]] && kill -0 "$pid" 2>/dev/null && __pid_owns_port "$pid" "$port"; then
			kill "$pid" 2>/dev/null || true
		fi
		rm -rf "$d"
		echo "[REAP] 已清理：$name"
	done
}

case "${1:-}" in
	up)     cmd_up ;;
	reload) cmd_reload ;;
	call)   shift; cmd_call "$@" ;;
	down)   shift; cmd_down "$@" ;;
	*) echo "用法: $0 <up|reload|call|down [--all]>" >&2; exit 1 ;;
esac
