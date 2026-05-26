#!/usr/bin/env bash
# MiniMax OAuth 端到端验证（人机协同；cn 站授权）
#
# 设备码流必须真人到浏览器授权，无法全自动。脚本流程：
#   1. 调 coclaw.providerAuth.loginOauth '{"region":"cn"}'（--json）→ 立即拿 accepted 帧
#      （CLI 默认收首帧即返，--expect-final 专为 agent 留），打印 verificationUri + userCode
#   2. 暂停，等你到 https://api.minimaxi.com 用 MiniMax 账号授权 + 输入 userCode
#   3. 轮询 coclaw.providerAuth.list '{"provider":"minimax-portal"}' 直到出现 oauth profile
#      （gateway 内的后台轮询拿到 token 后落盘——脚本观测的是这个落盘副作用，事件帧 CLI 收不到）
#   4. 断言 openclaw.json 的 models.providers.minimax-portal.baseUrl 已写 + gateway 未重启
#   5. Create-Test-Delete 还原：coclaw.providerAuth.remove 删凭据；models.providers.minimax-portal
#      配置节点无 CLI 可删，打印手动 jq 命令（该节点残留无害，见 docs/model-config-api.md § 6.14）
#
# 前置：
#   - openclaw gateway 跑着；jq 已装
#   - 有可授权的 MiniMax（cn / token plan）账号
#   - 验证前 minimax-portal 未绑定（脚本会先 precheck，避免污染你已有的真实绑定）
#
# 用法：bash plugins/openclaw/scripts/oauth-e2e-verify.sh

set -u

BLUE='\033[0;34m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

PROVIDER="minimax-portal"
CONFIG_PATH="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
POLL_TIMEOUT_SECONDS=300
POLL_INTERVAL_SECONDS=3
LOGIN_ID=""

PASS=0
FAIL=0

note() { printf "${BLUE}===>${NC} %s\n" "$1"; }
ok()   { printf "    ${GREEN}%s${NC}\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "    ${RED}%s${NC}\n" "$1"; FAIL=$((FAIL+1)); }

cleanup() {
	echo
	note "清理（Create-Test-Delete 还原）"
	# 拨掉可能仍在跑的后台轮询（幂等；未知/已终态也无害）
	if [[ -n "$LOGIN_ID" ]]; then
		openclaw gateway call coclaw.providerAuth.cancelOauth "{\"loginId\":\"$LOGIN_ID\"}" --json >/dev/null 2>&1 || true
	fi
	openclaw gateway call coclaw.providerAuth.remove "{\"provider\":\"$PROVIDER\"}" --json >/dev/null 2>&1 || true
	printf "    凭据已删。配置节点 models.providers.%s 无 CLI 可删（残留无害，见 § 6.14）。\n" "$PROVIDER"
	printf "    如需手动清除：\n"
	printf "      ${YELLOW}jq 'del(.models.providers.\"%s\")' %s > /tmp/oc.json && mv /tmp/oc.json %s && openclaw gateway restart${NC}\n" "$PROVIDER" "$CONFIG_PATH" "$CONFIG_PATH"
}
trap cleanup EXIT

# === precheck ===

command -v jq >/dev/null 2>&1 || { echo "需要 jq，请先安装"; exit 1; }
openclaw gateway status >/dev/null 2>&1 || { echo "gateway 未运行"; exit 1; }

note "precheck：minimax-portal 当前未绑定"
PRE_LIST=$(openclaw gateway call coclaw.providerAuth.list "{\"provider\":\"$PROVIDER\"}" --json 2>&1)
PRE_COUNT=$(echo "$PRE_LIST" | jq '.profiles | length' 2>/dev/null || echo "?")
if [[ "$PRE_COUNT" != "0" ]]; then
	echo "    minimax-portal 已存在 $PRE_COUNT 条 profile —— 为避免污染真实绑定，请先手动 remove 再跑本脚本"
	echo "    当前：$PRE_LIST"
	LOGIN_ID=""  # 不进入登录流程，cleanup 不应误删你已有的绑定
	trap - EXIT  # 撤掉 cleanup，避免删你已有凭据
	exit 1
fi
ok "未绑定，可安全验证"

# gateway pid 快照（断言不重启）
GW_PID_BEFORE=$(openclaw gateway status 2>/dev/null | grep -oiE 'pid[^0-9]*[0-9]+' | grep -oE '[0-9]+' | head -1)

# === phase-1：发起登录，拿 accepted 帧 ===

note "发起 loginOauth（region=cn），拿 accepted 帧"
ACCEPTED=$(openclaw gateway call coclaw.providerAuth.loginOauth '{"region":"cn"}' --json 2>&1)
STATUS=$(echo "$ACCEPTED" | jq -r '.status // empty' 2>/dev/null)
if [[ "$STATUS" != "accepted" ]]; then
	bad "未拿到 accepted 帧：$ACCEPTED"
	exit 1
fi
LOGIN_ID=$(echo "$ACCEPTED" | jq -r '.loginId')
VERIFY_URI=$(echo "$ACCEPTED" | jq -r '.verificationUri')
USER_CODE=$(echo "$ACCEPTED" | jq -r '.userCode')
ok "accepted: loginId=$LOGIN_ID"

echo
printf "${YELLOW}========== 请手动授权 ==========${NC}\n"
printf "  打开：    %s\n" "$VERIFY_URI"
printf "  输入码：  %s\n" "$USER_CODE"
printf "${YELLOW}================================${NC}\n"
echo
read -r -p "授权完成后按回车继续（或 Ctrl-C 取消）..." _

# === phase-2 侧效观测：轮询 list 直到 oauth profile 落盘 ===

note "轮询 providerAuth.list 等待 oauth profile 落盘（最多 ${POLL_TIMEOUT_SECONDS}s）"
DEADLINE=$(( $(date +%s) + POLL_TIMEOUT_SECONDS ))
FOUND=""
while [[ $(date +%s) -lt $DEADLINE ]]; do
	LIST=$(openclaw gateway call coclaw.providerAuth.list "{\"provider\":\"$PROVIDER\"}" --json 2>&1)
	TYPE=$(echo "$LIST" | jq -r '.profiles[0].type // empty' 2>/dev/null)
	if [[ "$TYPE" == "oauth" ]]; then
		FOUND=$LIST
		break
	fi
	sleep "$POLL_INTERVAL_SECONDS"
done

if [[ -z "$FOUND" ]]; then
	bad "超时仍未见 oauth profile（授权失败 / device code 过期 / 网络）"
	exit 1
fi
ok "oauth profile 落盘：$(echo "$FOUND" | jq -c '.profiles[0] | {profileId, provider, type}')"

# === 断言配置写入 ===

note "断言 openclaw.json 写入 models.providers.$PROVIDER.baseUrl"
BASE_URL=$(jq -r ".models.providers.\"$PROVIDER\".baseUrl // empty" "$CONFIG_PATH" 2>/dev/null)
if [[ -n "$BASE_URL" ]]; then
	ok "baseUrl=$BASE_URL"
else
	bad "配置节点未写入（$CONFIG_PATH）"
fi

API_FIELD=$(jq -r ".models.providers.\"$PROVIDER\".api // empty" "$CONFIG_PATH" 2>/dev/null)
[[ "$API_FIELD" == "anthropic-messages" ]] && ok "api=anthropic-messages" || bad "api 字段异常：$API_FIELD"

# === 断言 gateway 未重启（hot-reload 零打断）===

note "断言 gateway 未重启（PID 不变）"
GW_PID_AFTER=$(openclaw gateway status 2>/dev/null | grep -oiE 'pid[^0-9]*[0-9]+' | grep -oE '[0-9]+' | head -1)
if [[ -n "$GW_PID_BEFORE" && "$GW_PID_BEFORE" == "$GW_PID_AFTER" ]]; then
	ok "PID 不变（$GW_PID_AFTER）"
else
	bad "PID 变化 before=$GW_PID_BEFORE after=$GW_PID_AFTER（可能触发了重启，与 hot-reload 预期不符）"
fi

# === 汇总 ===

echo
printf "PASS: ${GREEN}%d${NC}    FAIL: ${RED}%d${NC}\n" "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
