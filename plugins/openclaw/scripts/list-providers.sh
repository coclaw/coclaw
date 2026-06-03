#!/usr/bin/env bash
set -uo pipefail

# 通过本机 openclaw CLI 输出其支持的所有 provider 的目录信息。
#
# 数据源：openclaw infer model providers
#   该子命令默认即吐 NDJSON(每行一个紧凑 JSON 对象);加 --json 反而是单个
#   pretty 数组,故这里不加 --json,保持逐行原样。
# 输出：逐行 JSON(NDJSON),每行一个 provider 对象:
#   { provider, count, defaults, available, configured, selected }
#   - provider   provider id
#   - count      该 provider 在 catalog 中的模型数
#   - defaults   默认/代表性模型 id(前若干个)
#   - available  catalog 是否提供该 provider
#   - configured 本机是否已配置凭据
#   - selected   是否被选为当前默认
#
# 去噪：openclaw 在交互式终端下会把 🦞 banner 和 clack 装饰行(│ / ◇)混进
#   输出流,且 banner 跟随 stdout/stderr 里那个是 TTY 的流走(无任何 flag/env
#   能关)。这里把 stdout 接成管道、stderr 收进临时文件,使两个流都不是 TTY,
#   openclaw 便原生省掉全部装饰、只在 stdout 吐纯 NDJSON。stderr 仅在 openclaw
#   真失败时回放,不吞错误诊断。
#
# 用法：
#   bash scripts/list-providers.sh
#   bash scripts/list-providers.sh --profile dev   # 透传全局 flag 到隔离 profile
#
# 传入的参数原样前置给 openclaw(放在子命令之前),用于 --profile / --dev /
# --container / --log-level 等全局选项。

if ! command -v openclaw >/dev/null 2>&1; then
	echo "error: openclaw CLI not found in PATH" >&2
	exit 127
fi

err="$(mktemp)"
trap 'rm -f "$err"' EXIT

openclaw "$@" infer model providers 2>"$err" | cat
status=${PIPESTATUS[0]}

if [ "$status" -ne 0 ]; then
	cat "$err" >&2
fi
exit "$status"
