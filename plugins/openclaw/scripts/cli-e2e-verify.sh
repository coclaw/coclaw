#!/usr/bin/env bash
# Phase C 端到端验证：plugins/openclaw 的全部 6 个 CLI 子命令
#
# 覆盖：
#   wire 形态：providerAuth.list 不再带 { status: ... } wrap（Phase B 去 wrap 实际生效）
#   providerAuth.setApiKey / list / remove：完整 happy-path（临时 fake provider，Create-Test-Delete）
#   enroll 错误路径：当前已 bind 时应抛 ALREADY_BOUND
#
# 设计原则：
#   - 不破坏现有绑定；不动 coclaw unbind
#   - 不测 bind 错误路径——bindClaw 是换绑语义（自动 unbind 旧的再绑新的，失败不回滚），
#     在已绑定状态下用任何 code 调 bind 都会清掉本地 bindings。bind 错误路径已由
#     cli-registrar.test.js 单元测试覆盖。
#   - providerAuth 用临时 fake provider（test-cli-verify-dummy-<pid>），EXIT trap 清理
#   - 失败时打印 stdout/stderr 便于定位
#
# 前置：
#   - openclaw gateway 跑着（systemd user service 或 foreground）
#   - 当前已绑定到 server（脚本会读 bindings.json 校验）
#
# 用法：bash plugins/openclaw/scripts/cli-e2e-verify.sh

set -u

BLUE='\033[0;34m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

PASS=0
FAIL=0
FAILURES=()
TEST_PROVIDER="cli-verify-dummy-$$"
TEST_PROFILE_ID="${TEST_PROVIDER}:phase-c"

cleanup() {
	openclaw coclaw auth remove "$TEST_PROVIDER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

run_test() {
	local name=$1
	shift
	printf "${BLUE}===>${NC} %s\n" "$name"
	if "$@"; then
		printf "    ${GREEN}PASS${NC}\n\n"
		PASS=$((PASS+1))
	else
		printf "    ${RED}FAIL${NC}\n\n"
		FAIL=$((FAIL+1))
		FAILURES+=("$name")
	fi
}

# === precheck ===

precheck_gateway() {
	openclaw gateway status >/dev/null 2>&1 || {
		echo "    gateway not running" >&2
		return 1
	}
	return 0
}

precheck_bound() {
	if [[ ! -s "$HOME/.openclaw/coclaw/bindings.json" ]]; then
		echo "    bindings.json missing or empty — bind/enroll error-path tests need an existing binding" >&2
		return 1
	fi
	return 0
}

# === wire format ===

test_wire_no_status_wrap() {
	local out
	out=$(openclaw gateway call coclaw.providerAuth.list --json 2>&1)
	if echo "$out" | grep -q '"status"\s*:'; then
		echo "    wire still has {status:...} wrap:"
		echo "$out" | head -5
		return 1
	fi
	if ! echo "$out" | grep -q '"profiles"'; then
		echo "    wire missing profiles field:"
		echo "$out" | head -5
		return 1
	fi
	return 0
}

# === providerAuth.setApiKey ===

test_set_api_key_default() {
	local out
	out=$(openclaw coclaw auth set-api-key "$TEST_PROVIDER" --key "dummy-cli-verify-key" 2>&1)
	echo "$out" | grep -q "OK\. API key for \"$TEST_PROVIDER\" stored" || {
		echo "    unexpected output: $out"
		return 1
	}
	echo "$out" | grep -q "profileId=${TEST_PROVIDER}:default" || {
		echo "    profileId not in output: $out"
		return 1
	}
	return 0
}

test_set_api_key_custom_profile() {
	local out
	out=$(openclaw coclaw auth set-api-key "$TEST_PROVIDER" --key "dummy-cli-verify-key-2" --profile-id "$TEST_PROFILE_ID" 2>&1)
	echo "$out" | grep -q "profileId=${TEST_PROFILE_ID}" || {
		echo "    custom profileId not in output: $out"
		return 1
	}
	return 0
}

# === providerAuth.list ===

test_list_filtered() {
	local out
	out=$(openclaw coclaw auth list --provider "$TEST_PROVIDER" 2>&1)
	echo "$out" | grep -q "${TEST_PROVIDER}:default" || {
		echo "    default profile missing: $out"
		return 1
	}
	echo "$out" | grep -q "$TEST_PROFILE_ID" || {
		echo "    custom profile missing: $out"
		return 1
	}
	return 0
}

test_list_unfiltered_preserves_existing() {
	local out
	out=$(openclaw coclaw auth list 2>&1)
	echo "$out" | grep -q "${TEST_PROVIDER}:default" || {
		echo "    test profile not in global list: $out"
		return 1
	}
	echo "$out" | grep -q "openai-codex:default" || {
		echo "    PRE-EXISTING openai-codex:default profile lost!"
		echo "$out"
		return 1
	}
	return 0
}

test_list_empty_filter() {
	local out
	out=$(openclaw coclaw auth list --provider "nonexistent-provider-zzzzzzzz" 2>&1)
	echo "$out" | grep -q "No auth profiles found for provider" || {
		echo "    empty msg missing: $out"
		return 1
	}
	return 0
}

# === providerAuth.remove ===

test_remove() {
	local out
	out=$(openclaw coclaw auth remove "$TEST_PROVIDER" 2>&1)
	echo "$out" | grep -q "OK\. Removed all auth profiles for \"$TEST_PROVIDER\"" || {
		echo "    remove output: $out"
		return 1
	}

	local list_after
	list_after=$(openclaw coclaw auth list --provider "$TEST_PROVIDER" 2>&1)
	echo "$list_after" | grep -q "No auth profiles found for provider" || {
		echo "    profiles still exist after remove: $list_after"
		return 1
	}

	local list_global
	list_global=$(openclaw coclaw auth list 2>&1)
	echo "$list_global" | grep -q "openai-codex:default" || {
		echo "    PRE-EXISTING openai-codex:default profile lost during remove!"
		echo "$list_global"
		return 1
	}
	return 0
}

# === enroll 错误路径 ===

test_enroll_already_bound() {
	# 已 bind 状态 → 必须抛 ALREADY_BOUND；exit 0 视为失败（说明 bindings 已意外丢失）
	local out exit_code
	out=$(openclaw coclaw enroll 2>&1)
	exit_code=$?
	if [[ $exit_code -eq 0 ]]; then
		echo "    expected non-zero exit when already bound, got 0; output: $out"
		echo "    (若输出含 'Claim code:' 说明 bindings 已丢失，请核实 ~/.openclaw/coclaw/bindings.json)"
		return 1
	fi
	echo "$out" | grep -qi "already\|already bound\|ALREADY_BOUND" || {
		echo "    no 'already' in output: $out"
		return 1
	}
	return 0
}

# === 主流程 ===

echo "=========================================="
echo "Phase C CLI 端到端验证"
echo "Test provider:    $TEST_PROVIDER"
echo "Test profile ID:  $TEST_PROFILE_ID"
echo "=========================================="
echo

run_test "[precheck] gateway 运行中"     precheck_gateway
run_test "[precheck] 当前已绑定"         precheck_bound

run_test "wire 形态：providerAuth.list 不再带 {status:...} wrap" test_wire_no_status_wrap

run_test "auth set-api-key 默认 profileId"      test_set_api_key_default
run_test "auth set-api-key 自定义 profileId"    test_set_api_key_custom_profile
run_test "auth list --provider 过滤"            test_list_filtered
run_test "auth list 全部 + 不影响已有 profile"   test_list_unfiltered_preserves_existing
run_test "auth list --provider 不存在 → empty"  test_list_empty_filter
run_test "auth remove + 验证清空 + 不影响其它"   test_remove

run_test "enroll 已绑定状态 → ALREADY_BOUND"     test_enroll_already_bound

echo "=========================================="
printf "PASS: ${GREEN}%d${NC}    FAIL: ${RED}%d${NC}\n" "$PASS" "$FAIL"
if [[ ${#FAILURES[@]} -gt 0 ]]; then
	echo
	printf "${YELLOW}失败的测试：${NC}\n"
	for f in "${FAILURES[@]}"; do
		echo "  - $f"
	done
	exit 1
fi
echo "=========================================="
exit 0
