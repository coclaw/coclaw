#!/usr/bin/env bash
set -euo pipefail

# Safe updater for local (non-npm) plugin development.
# Strategy:
# 1) Stop gateway to avoid noisy side effects during plugin CLI operations.
# 2) Uninstall existing same-id plugin record/dir if present.
# 3) Link workspace source with `plugins install --link`.
# 4) Restart gateway and verify config + source markers.

OPENCLAW_BIN="${OPENCLAW_BIN:-/home/xhx/.local/bin/openclaw}"
PLUGIN_SRC="${PLUGIN_SRC:-/home/xhx/.openclaw/workspace/coclaw/plugins/openclaw}"
PLUGIN_ID="${PLUGIN_ID:-coclaw}"
BACKUP_DIR="${BACKUP_DIR:-/home/xhx/.openclaw/backups}"
CFG="${CFG:-/home/xhx/.openclaw/openclaw.json}"

if [[ ! -x "$OPENCLAW_BIN" ]]; then
  echo "[ERROR] openclaw binary not found or not executable: $OPENCLAW_BIN" >&2
  exit 1
fi
if [[ ! -d "$PLUGIN_SRC" ]]; then
  echo "[ERROR] plugin source dir not found: $PLUGIN_SRC" >&2
  exit 1
fi
if [[ ! -f "$PLUGIN_SRC/openclaw.plugin.json" ]]; then
  echo "[ERROR] plugin manifest missing: $PLUGIN_SRC/openclaw.plugin.json" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
CFG_BAK="$BACKUP_DIR/openclaw.json.${TS}.bak"
cp "$CFG" "$CFG_BAK"
echo "[INFO] config backup: $CFG_BAK"

echo "[STEP] pre-check status"
"$OPENCLAW_BIN" gateway status || true

echo "[STEP] stop gateway (prevent interruption/noisy plugin side effects)"
"$OPENCLAW_BIN" gateway stop || true

echo "[STEP] uninstall existing plugin id if present (ignore if not managed)"
"$OPENCLAW_BIN" plugins uninstall "$PLUGIN_ID" --force || true

echo "[STEP] remove stale global extension dir if still exists"
if [[ -d "/home/xhx/.openclaw/extensions/$PLUGIN_ID" ]]; then
  rm -rf "/home/xhx/.openclaw/extensions/$PLUGIN_ID"
  echo "[INFO] removed stale dir: /home/xhx/.openclaw/extensions/$PLUGIN_ID"
fi

echo "[STEP] link plugin source (dev mode)"
"$OPENCLAW_BIN" plugins install --link "$PLUGIN_SRC"

echo "[STEP] restart gateway"
"$OPENCLAW_BIN" gateway start
sleep 2

echo "[STEP] post-check"
"$OPENCLAW_BIN" gateway status
"$OPENCLAW_BIN" plugins doctor
"$OPENCLAW_BIN" plugins info "$PLUGIN_ID" || true

echo "[STEP] verify config and link state"
python - <<'PY'
import json
from pathlib import Path
cfg = json.loads(Path('/home/xhx/.openclaw/openclaw.json').read_text())
plugins = cfg.get('plugins') or {}
paths = ((plugins.get('load') or {}).get('paths') or [])
entry = (plugins.get('entries') or {}).get('coclaw')
install = (plugins.get('installs') or {}).get('coclaw')
print('[INFO] plugins.load.paths =', paths)
print('[INFO] plugins.entries.coclaw =', entry)
print('[INFO] plugins.installs.coclaw =', install)
if '/home/xhx/.openclaw/workspace/coclaw/plugins/openclaw' not in paths:
    raise SystemExit('[ERROR] linked source path missing in plugins.load.paths')
if not (entry or {}).get('enabled'):
    raise SystemExit('[ERROR] plugins.entries.coclaw.enabled is not true')
if (install or {}).get('source') != 'path':
    raise SystemExit('[ERROR] plugins.installs.coclaw.source is not path')
PY

echo "[STEP] verify expected updated code markers in linked source"
rg -n "parseSessionFileName|archiveType|jsonl\.reset|jsonl\.deleted" \
  "$PLUGIN_SRC/src/session-manager/manager.js" -S >/dev/null

echo "[DONE] local linked plugin update completed"
