#!/usr/bin/env bash
# 逐文件运行 vitest，每个文件独立进程，避免 jsdom 内存累积导致 OOM。
# 用法：
#   scripts/test.sh              # 仅跑测试
#   scripts/test.sh --coverage   # 跑测试 + 覆盖率门禁（verify 用）
set -uo pipefail
cd "$(dirname "$0")/.."

COVERAGE=false
for arg in "$@"; do
	[ "$arg" = "--coverage" ] && COVERAGE=true
done

BLOB_DIR=".vitest-blobs"
COV_TMP_DIR=".vitest-cov-tmp"

if $COVERAGE; then
	rm -rf "$BLOB_DIR" "$COV_TMP_DIR"
	mkdir -p "$BLOB_DIR"
fi

FILES=$(find src -name '*.test.js' | sort)
TOTAL=$(echo "$FILES" | wc -l)
PASSED=0
FAILED=0
FAILED_FILES=""
I=0

for f in $FILES; do
	I=$((I + 1))
	if $COVERAGE; then
		npx vitest run "$f" \
			--reporter=blob --outputFile="$BLOB_DIR/blob-$I.json" \
			--coverage.enabled --coverage.reporter=json \
			--coverage.reportsDirectory="$COV_TMP_DIR/cov-$I" \
			--coverage.thresholds.lines=0 --coverage.thresholds.functions=0 \
			--coverage.thresholds.branches=0 --coverage.thresholds.statements=0
	else
		npx vitest run "$f"
	fi
	RC=$?

	if [ $RC -eq 0 ]; then
		PASSED=$((PASSED + 1))
	else
		FAILED=$((FAILED + 1))
		FAILED_FILES="$FAILED_FILES\n  $f"
	fi
done

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ($TOTAL files) ==="

if [ $FAILED -gt 0 ]; then
	echo -e "Failed files:$FAILED_FILES"
fi

# coverage 模式：合并 blob 并检查覆盖率门禁
if $COVERAGE; then
	echo ""
	echo "=== Merging coverage reports ==="
	npx vitest --merge-reports="$BLOB_DIR" --coverage
	MERGE_RC=$?
	rm -rf "$BLOB_DIR" "$COV_TMP_DIR"
	[ $MERGE_RC -ne 0 ] && exit $MERGE_RC
fi

[ $FAILED -gt 0 ] && exit 1
exit 0
