#!/usr/bin/env bash
#
# 抽取本地日志中某只 claw 的 connId 时间线，每个 connId 一行（首/末出现时刻 + 时长）。
#
# 用法：
#   ./connid-timeline.sh <local-log> <claw-id>
#
# 示例：
#   ./connid-timeline.sh tmp/diag-window.log 151178797073
#
# 输出示例：
#   2026-05-05T14:45:57Z  →  2026-05-05T15:18:38Z  ( 32m41s)  c_734c75c0
#   2026-05-05T15:18:38Z  →  2026-05-05T15:20:31Z  (  1m53s)  c_3af8e466
#   ...
#
# 用途：
#   代码注释保证 "connId 按 claw 复用、不按 restart 代际"
#   （ui/src/services/webrtc-connection.js 第 1603 行附近），
#   即在同一个 SPA 实例里，无论 PC 怎么 ICE restart / 重建，UI 那边
#   该 claw 的 connId 都不变。唯一会清掉它的入口只有：
#     1) 登出 / claw 被快照剔除 → claw-connection.disconnect
#     2) 信令 WS 主动 disconnect 清理（__cleanup）
#     3) 收到 server 推送的 rtc:closed
#   PC 重建、信令 WS 自动重连、前后台切换都**保留** connId。
#
#   因此：在排查"任务未完成 / 状态机错乱"等问题时，如果某只 claw 的
#   connId 在窗口里换了 N 次，就是 N 次 SPA 软重启（移动端 WebView 被
#   OS 回收）的硬证据——比 claw.fullInit 信号更直接（fullInit 路径多，
#   connId 路径单一）。
#
# 戒律：
#   - 输入文件应是已经落到本地的过滤后日志（用 fetch-and-filter.sh 拉）。
#     直接对线上 docker compose logs 跑这个脚本会反复 ssh，慢。
#   - 仅识别短码（c_xxxxxxxx，前 8 位）。pion 侧日志带的是完整 UUID
#     形如 c_xxxxxxxx-xxxx-...，但前 8 位等价。

set -euo pipefail

LOG="${1:?用法：$0 <local-log> <claw-id>}"
CLAW="${2:?用法：$0 <local-log> <claw-id>}"

if [ ! -f "$LOG" ]; then
	echo "[connid-timeline] 找不到日志文件：$LOG" >&2
	exit 1
fi

# 1) 抽取与该 claw 相关的所有行，再从中抓 c_xxxxxxxx
ids=$(LC_ALL=C grep -aE "$CLAW" "$LOG" | LC_ALL=C grep -aoE 'c_[0-9a-f]{8}' | sort -u)

if [ -z "$ids" ]; then
	echo "[connid-timeline] 未在 $LOG 中找到 claw=$CLAW 的任何 c_xxxxxxxx" >&2
	exit 0
fi

# 2) 对每个 connId 求首/末时刻并算时长
LC_ALL=C
ts_re='2026-[0-9-]+T[0-9:.]+Z'  # 容器侧 ISO 时间戳前缀（docker compose -t）

# 收集 (first_ts, last_ts, connId) 三元组
rows=$(while IFS= read -r id; do
	first=$(LC_ALL=C grep -aE "$CLAW" "$LOG" | LC_ALL=C grep -aE "$id" | head -1 | LC_ALL=C grep -oE "$ts_re" | head -1)
	last=$(LC_ALL=C grep -aE "$CLAW" "$LOG" | LC_ALL=C grep -aE "$id" | tail -1 | LC_ALL=C grep -oE "$ts_re" | head -1)
	[ -z "$first" ] || [ -z "$last" ] && continue
	echo "$first|$last|$id"
done <<< "$ids" | LC_ALL=C sort)

# 3) 格式化输出（含时长）
echo "$rows" | awk -F'|' '
function fmt_dur(sec,    h,m,s) {
	h = int(sec/3600); m = int((sec%3600)/60); s = sec%60
	if (h > 0) return sprintf("%dh%02dm%02ds", h, m, s)
	if (m > 0) return sprintf("%2dm%02ds", m, s)
	return sprintf("    %2ds", s)
}
function ts2sec(ts,    cmd, sec) {
	# 用 GNU date 把 ISO 时间转成秒；遇到不可解析直接给 0
	cmd = "date -u -d \"" ts "\" +%s 2>/dev/null"
	cmd | getline sec
	close(cmd)
	return sec + 0
}
{
	first=$1; last=$2; id=$3
	dur = ts2sec(last) - ts2sec(first)
	printf("%s  →  %s  (%s)  %s\n", first, last, fmt_dur(dur), id)
}'
