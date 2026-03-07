#!/usr/bin/env bash
set -euo pipefail

# 从 npm 安装 @coclaw/openclaw-coclaw 插件并验证。
# 涉及 gateway 重启，需手动执行。
#
# 用法:
#   ./scripts/test-npm-install.sh              # 从 npm registry 安装
#   ./scripts/test-npm-install.sh --local      # 本地 pack 安装（不需要先发布）
#
# 完成测试后恢复开发模式:
#   ./scripts/test-npm-install.sh --restore    # 恢复 --link 开发模式

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
PLUGIN_ID="coclaw"
PKG_NAME="@coclaw/openclaw-coclaw"
CFG="${CFG:-$HOME/.openclaw/openclaw.json}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/.openclaw/backups}"
MODE="${1:-registry}"

# 所有模式都先备份 openclaw.json
mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
CFG_BAK="$BACKUP_DIR/openclaw.json.${TS}.bak"
cp "$CFG" "$CFG_BAK"
echo "[INFO] 配置已备份: $CFG_BAK"

# ─── 恢复开发模式 ───
if [[ "$MODE" == "--restore" ]]; then
	echo "=== 恢复 --link 开发模式 ==="

	echo "[STEP] 停止 gateway"
	"$OPENCLAW_BIN" gateway stop || true

	echo "[STEP] 卸载 npm 安装的插件"
	"$OPENCLAW_BIN" plugins uninstall "$PLUGIN_ID" --force || true

	echo "[STEP] 清理残留 extensions 目录"
	if [[ -d "$HOME/.openclaw/extensions/$PLUGIN_ID" ]]; then
		rm -rf "$HOME/.openclaw/extensions/$PLUGIN_ID"
		echo "[INFO] 已清理: ~/.openclaw/extensions/$PLUGIN_ID"
	fi

	echo "[STEP] 重新 link 本地源码"
	"$OPENCLAW_BIN" plugins install --link "$PLUGIN_DIR"

	echo "[STEP] 启动 gateway"
	"$OPENCLAW_BIN" gateway start
	sleep 2

	echo "[STEP] 验证"
	"$OPENCLAW_BIN" gateway status
	"$OPENCLAW_BIN" plugins doctor
	echo ""
	echo "[DONE] 已恢复 --link 开发模式"
	exit 0
fi

# ─── 安装测试 ───
echo "=== 测试从 npm 安装 $PKG_NAME ==="

echo "[STEP 1/7] 停止 gateway"
"$OPENCLAW_BIN" gateway stop || true

echo "[STEP 2/7] 卸载现有插件（link 或 npm 均可）"
"$OPENCLAW_BIN" plugins uninstall "$PLUGIN_ID" --force || true

echo "[STEP 3/7] 清理残留 extensions 目录"
if [[ -d "$HOME/.openclaw/extensions/$PLUGIN_ID" ]]; then
	rm -rf "$HOME/.openclaw/extensions/$PLUGIN_ID"
	echo "[INFO] 已清理: ~/.openclaw/extensions/$PLUGIN_ID"
fi

# 只读检查：uninstall 后 load.paths 是否还残留本地路径
if command -v python3 &>/dev/null; then
	python3 - <<'PY'
import json
from pathlib import Path

cfg = json.loads((Path.home() / '.openclaw' / 'openclaw.json').read_text())
paths = ((cfg.get('plugins') or {}).get('load') or {}).get('paths') or []
stale = [p for p in paths if 'coclaw/plugins/openclaw' in p]
if stale:
    print(f'[WARN] plugins.load.paths 仍残留本地路径: {stale}')
    print('[WARN] 请手动从 openclaw.json 中移除，或重新运行 openclaw plugins uninstall')
else:
    print('[INFO] plugins.load.paths 已清理')
PY
fi

echo "[STEP 4/7] 安装插件"
if [[ "$MODE" == "--local" ]]; then
	echo "[INFO] 本地 pack 模式"
	cd "$PLUGIN_DIR"
	TARBALL=$(npm pack --json 2>/dev/null | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)[0].filename))")
	echo "[INFO] 生成 tarball: $TARBALL"
	"$OPENCLAW_BIN" plugins install "$PLUGIN_DIR/$TARBALL"
	rm -f "$PLUGIN_DIR/$TARBALL"
else
	echo "[INFO] 从 npm registry 安装"
	"$OPENCLAW_BIN" plugins install "$PKG_NAME"
fi

echo "[STEP 5/7] 启动 gateway"
"$OPENCLAW_BIN" gateway start
sleep 2

echo "[STEP 6/7] 验证安装状态"
"$OPENCLAW_BIN" gateway status
"$OPENCLAW_BIN" plugins doctor
"$OPENCLAW_BIN" plugins list

echo "[STEP 7/7] 检查配置"
if command -v python3 &>/dev/null; then
	python3 - <<'PY'
import json
from pathlib import Path

cfg = json.loads((Path.home() / '.openclaw' / 'openclaw.json').read_text())
plugins = cfg.get('plugins') or {}
entry = (plugins.get('entries') or {}).get('coclaw')
install = (plugins.get('installs') or {}).get('coclaw')
print(f'[INFO] plugins.entries.coclaw = {entry}')
print(f'[INFO] plugins.installs.coclaw = {install}')

if not (entry or {}).get('enabled'):
    print('[WARN] 插件未启用！')
else:
    print('[OK] 插件已启用')

source = (install or {}).get('source', '')
print(f'[INFO] 安装来源: {source}')
PY
fi

echo ""
echo "[DONE] npm 安装测试完成"
echo ""
echo "后续操作:"
echo "  - 测试 /coclaw bind、/coclaw unbind 等命令"
echo "  - 测试完成后执行: ./scripts/test-npm-install.sh --restore 恢复开发模式"
