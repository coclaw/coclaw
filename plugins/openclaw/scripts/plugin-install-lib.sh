#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
PLUGIN_ID="${PLUGIN_ID:-coclaw}"
PKG_NAME="${PKG_NAME:-@coclaw/openclaw-coclaw}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${PLUGIN_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

log() { echo "[INFO] $*"; }
warn() { echo "[WARN] $*" >&2; }
err() { echo "[ERROR] $*" >&2; }

OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_DIR/openclaw.json}"
SAFE_CWD="${SAFE_CWD:-$HOME}"

oc() {
	(
		cd "$SAFE_CWD"
		"$OPENCLAW_BIN" "$@"
	)
}

get_install_mode() {
	# 避免调用 `openclaw plugins info`：该命令在某些场景会触发插件加载并常驻，导致脚本卡住。
	# 这里改为只读检查本地状态（config + extensions 目录）。
	CFG_FILE="$OPENCLAW_CONFIG_PATH" PLUGIN_ID="$PLUGIN_ID" PLUGIN_DIR="$PLUGIN_DIR" STATE_DIR="$OPENCLAW_STATE_DIR" node -e '
const fs = require("node:fs");
const path = require("node:path");

const cfgFile = process.env.CFG_FILE;
const pluginId = process.env.PLUGIN_ID;
const pluginDir = process.env.PLUGIN_DIR;
const stateDir = process.env.STATE_DIR;

function safeRead(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const raw = safeRead(cfgFile);
const normalizedDir = String(pluginDir).replace(/\\\\/g, "/");
const extDir = path.join(stateDir, "extensions", pluginId);
const extExists = fs.existsSync(extDir);

let linkByPath = false;
let sourcePathByInstall = false;
let npmByInstall = false;
let pathByInstall = false;

if (raw) {
  const rawN = raw.replace(/\\\\/g, "/");
  const dirRe = new RegExp(escRe(normalizedDir));
  linkByPath = dirRe.test(rawN);

  const installNpmRe = new RegExp(`"${escRe(pluginId)}"\\s*:\\s*\\{[\\s\\S]*?"source"\\s*:\\s*"npm"`, "m");
  const installPathRe = new RegExp(`"${escRe(pluginId)}"\\s*:\\s*\\{[\\s\\S]*?"source"\\s*:\\s*"path"`, "m");
  const sourcePathRe = new RegExp(`"${escRe(pluginId)}"\\s*:\\s*\\{[\\s\\S]*?"sourcePath"\\s*:\\s*"${escRe(normalizedDir)}"`, "m");

  npmByInstall = installNpmRe.test(rawN);
  pathByInstall = installPathRe.test(rawN);
  sourcePathByInstall = sourcePathRe.test(rawN);
}

if (npmByInstall || (extExists && !linkByPath && !pathByInstall && !sourcePathByInstall)) {
  process.stdout.write("npm");
  process.exit(0);
}

if (linkByPath || pathByInstall || sourcePathByInstall) {
  process.stdout.write("link");
  process.exit(0);
}

if (!raw && !extExists) {
  process.stdout.write("none");
  process.exit(0);
}

process.stdout.write("none");
'
}

require_ready_config() {
	# 保留占位，便于后续扩展（当前只读策略下不再依赖 openclaw CLI 配置解析）
	return 0
}

CHANNEL_ID="${CHANNEL_ID:-coclaw}"
BINDINGS_DIR="$OPENCLAW_STATE_DIR/$CHANNEL_ID"
BINDINGS_FILE="$BINDINGS_DIR/bindings.json"

# 清理绑定信息文件
cleanup_bindings() {
	if [ -f "$BINDINGS_FILE" ]; then
		rm -f "$BINDINGS_FILE"
		log "已清理绑定信息: $BINDINGS_FILE"
		# 若目录为空则一并删除
		rmdir "$BINDINGS_DIR" 2>/dev/null || true
	else
		log "未发现绑定信息文件，跳过清理。"
	fi
}

# 清理 openclaw.json 中可能残留的 channels.coclaw 节点（旧版兼容）
cleanup_legacy_channels_config() {
	CFG_FILE="$OPENCLAW_CONFIG_PATH" CHANNEL="$CHANNEL_ID" node -e '
const fs = require("node:fs");
const cfgFile = process.env.CFG_FILE;
const channel = process.env.CHANNEL;

let raw;
try { raw = fs.readFileSync(cfgFile, "utf8"); } catch { process.exit(0); }
let cfg;
try { cfg = JSON.parse(raw); } catch { process.exit(0); }
if (!cfg.channels || !cfg.channels[channel]) process.exit(0);

delete cfg.channels[channel];
if (Object.keys(cfg.channels).length === 0) delete cfg.channels;
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
console.log("[INFO] 已清理 openclaw.json 中残留的 channels." + channel + " 节点。");
'
}

remove_plugin_dir_from_load_paths() {
	local target="$PLUGIN_DIR"
	local raw next

	if ! raw="$(oc config get plugins.load.paths 2>/dev/null)"; then
		# 未配置 load.paths 视为无需处理
		return 0
	fi

	next="$(RAW="$raw" TARGET="$target" node -e '
const raw = (process.env.RAW || "").trim();
const target = (process.env.TARGET || "").replace(/\\/g, "/");

function normalize(v) {
  return String(v || "").trim().replace(/\\/g, "/");
}

function parseLoadPaths(input) {
  if (!input) return [];

  // 优先按 JSON/JSON 字符串解析
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === "string") return [parsed];
  } catch {}

  // 兜底：按行解析（某些 CLI 输出可能是逐行）
  const lines = input
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^"|"$/g, ""));

  // 若是类似 [a,b] 但非严格 JSON，再兜底处理一次
  if (lines.length === 1 && /^\[.*\]$/.test(lines[0])) {
    const body = lines[0].slice(1, -1).trim();
    if (!body) return [];
    return body.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
  }

  return lines;
}

const paths = parseLoadPaths(raw).map(normalize).filter(Boolean);
const filtered = paths.filter((p) => p !== target);
process.stdout.write(JSON.stringify(filtered));
')"

	oc config set plugins.load.paths "$next" >/dev/null
}
