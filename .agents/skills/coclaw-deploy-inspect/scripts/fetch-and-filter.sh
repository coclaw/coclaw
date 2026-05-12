#!/usr/bin/env bash
#
# CoClaw 部署机日志拉取 + 过滤一键脚本（封装 SKILL.md 第 9 节"快速自检模板"）。
#
# 用法：
#   ./fetch-and-filter.sh <host> <since> [<entity-regex>]
#
# 参数：
#   host          目标主机，如 im.coclaw.net
#   since         时间窗，如 30m / 2h（传给 docker compose logs --since）
#   entity-regex  可选。grep -E 的正则，过滤 user/claw/connId 等
#
# 示例：
#   ./fetch-and-filter.sh im.coclaw.net 30m 'c_7fd224ff|143579687452'
#
# 行为：
#   1) ssh 到远端，docker compose logs --since=<since> 落到 /tmp/srv.log
#   2) 若传了 regex：远端 LC_ALL=C grep -aE 过滤到 /tmp/srv_e.log，cat 回本地 stdout
#   3) 否则只报告 /tmp/srv.log 行数，由人接着用
#
# 戒律（踩过的坑，不要绕）：
#   - LC_ALL=C grep -a：日志混 binary，普通 grep 会丢行（"Binary file ..."）
#   - 不用 docker compose logs -f：会阻塞 SSH。用 --since 拉快照
#   - dump 后多次 grep 复用，不要每次都重新拉日志
#   - --no-color：避免 ANSI 污染 grep
#   - -t：行首是容器侧 UTC（server 接收时刻）。行内 [ts=<ISO_UTC>] 是 UI/plugin
#     端事件发生时刻，也 UTC；多端日志排序优先用 [ts=...]（字典序=时间序）

set -euo pipefail

HOST="${1:?用法：$0 <host> <since> [<regex>]; 示例：$0 im.coclaw.net 30m 'c_7fd224ff'}"
SINCE="${2:-30m}"
REGEX="${3:-}"

echo "[fetch] host=$HOST since=$SINCE regex=${REGEX:-(none)}" >&2

# 1) 落盘到远端 /tmp/srv.log
ssh "$HOST" "cd ~/coclaw && docker compose logs --since=${SINCE} --no-color -t server > /tmp/srv.log 2>&1; echo -n '[fetch] /tmp/srv.log lines: '; wc -l < /tmp/srv.log" >&2

if [ -z "$REGEX" ]; then
	echo "[fetch] 未传 regex，跳过过滤；登录到 $HOST 后用 'cat /tmp/srv.log' 看全量" >&2
	exit 0
fi

# 2) 远端过滤到 /tmp/srv_e.log
ssh "$HOST" "LC_ALL=C grep -aE '$REGEX' /tmp/srv.log > /tmp/srv_e.log; echo -n '[fetch] /tmp/srv_e.log lines: '; wc -l < /tmp/srv_e.log" >&2

# 3) 本地打印
ssh "$HOST" 'cat /tmp/srv_e.log'
