#!/usr/bin/env bash
# 统计自 server 上次启动以来曾连接过的 openclaw 实例的基本信息
# （平台/架构、webrtc 实现、版本等）
# 数据来源：coclaw-server-1 容器输出的 "coclaw.env" 日志行
#
# 用法：
#   ./stats-seen-claws.sh              # 默认 ssh 到 im.coclaw.net
#   ./stats-seen-claws.sh --local      # 在 server 主机本地运行
#   REMOTE=user@host ./stats-seen-claws.sh
#   CONTAINER=other-container ./stats-seen-claws.sh

set -euo pipefail

CONTAINER="${CONTAINER:-coclaw-server-1}"
REMOTE="${REMOTE:-im.coclaw.net}"
MODE="remote"

for arg in "$@"; do
	case "$arg" in
		--local) MODE="local" ;;
		--remote) MODE="remote" ;;
		-h|--help)
			sed -n '2,10p' "$0" | sed 's/^# \?//'
			exit 0
			;;
		*)
			echo "unknown arg: $arg" >&2
			exit 2
			;;
	esac
done

if [ "$MODE" = "local" ]; then
	LOGS=$(sudo -n docker logs "$CONTAINER" 2>&1 | grep -a 'coclaw.env' || true)
else
	LOGS=$(ssh "$REMOTE" "sudo -n docker logs $CONTAINER" 2>&1 | grep -a 'coclaw.env' || true)
fi

if [ -z "$LOGS" ]; then
	echo "未找到 coclaw.env 日志行（容器未启动或日志已轮转）" >&2
	exit 1
fi

TOTAL=$(printf '%s\n' "$LOGS" | wc -l | tr -d ' ')

# 按 claw id 去重，每个实例取首条（字段在一次连接内固定）
UNIQ_LINES=$(printf '%s\n' "$LOGS" | awk '{
	if (match($0, /claw:[0-9]+/)) {
		id = substr($0, RSTART, RLENGTH);
		if (!(id in seen)) { seen[id] = 1; print $0; }
	}
}')
UNIQ_COUNT=$(printf '%s\n' "$UNIQ_LINES" | wc -l | tr -d ' ')

tally() {
	# $1: 字段匹配正则；统一缩进 4 空格输出
	printf '%s\n' "$UNIQ_LINES" | grep -oE "$1" | sort | uniq -c | sort -rn \
		| awk '{count=$1; $1=""; sub(/^ +/, ""); printf "    %s %s\n", count, $0}'
}

echo "连接事件数: $TOTAL   唯一实例数: $UNIQ_COUNT"
echo
echo "--- 平台/架构 ---"
tally 'platform=[^ ]+ arch=[^ ]+'
echo
echo "--- WebRTC 实现 ---"
tally 'impl=[^ ]+'
echo
echo "--- plugin 版本 ---"
tally 'plugin=[^ ]+'
echo
echo "--- openclaw 版本 ---"
tally 'openclaw=[^ ]+'
echo
echo "--- node 版本 ---"
tally 'node=[^ ]+'
