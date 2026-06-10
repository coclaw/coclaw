#!/usr/bin/env bash
# 共享常量和工具函数，被其他脚本 source 引入。

PLUGIN_ID="openclaw-coclaw"
PKG_NAME="@coclaw/openclaw-coclaw"
CHANNEL_ID="coclaw"
# state-dir：尊重 OPENCLAW_STATE_DIR（多 profile/容器/隔离网关），默认 ~/.openclaw
OPENCLAW_STATE_DIR_RESOLVED="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
BINDINGS_FILE="$OPENCLAW_STATE_DIR_RESOLVED/coclaw/bindings.json"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# stage 目录与 workspace 根：均相对 PLUGIN_DIR 推算，所以在 worktree 里 source
# 本文件时它们自动落在该 worktree（worktree-gateway.sh 据此为每个 worktree 建独立 stage）。
STAGE_DIR="$PLUGIN_DIR/.build/link-stage"
WORKSPACE_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"

# ── 安装记录读取（经官方 CLI，不直读账本文件）──
# OpenClaw ≥2026.6.1 把 install records 迁入共享 SQLite，旧 JSON 账本停更，
# 直读必错。`openclaw plugins inspect <id> --json` 是三代稳定契约，顶层
# `install` 字段透传原始 record。
# memo：单脚本内缓存一次 inspect 输出（CLI 一次 ~3s）。注意 bash 命令替换跑在
# 子 shell，缓存只在主 shell 调用链内生效——调用方脚本应在首次使用 getter 前于
# 主 shell 显式 load_install_record 预载；ensure_uninstalled 卸载后会主动作废。
_LIB_INSPECT_JSON=""
_LIB_INSPECT_LOADED=0

load_install_record() {
	if [[ "$_LIB_INSPECT_LOADED" == "1" ]]; then
		return 0
	fi
	if ! command -v openclaw >/dev/null 2>&1; then
		echo "[ERROR] 未找到 openclaw CLI，无法读取插件安装记录" >&2
		echo "[HINT] 确认 openclaw 已安装且在 PATH 上" >&2
		return 1
	fi
	local out
	# 未安装判定：exit≠0 或 stdout 空（不读 stderr 文案，无契约承诺）
	if ! out="$(openclaw plugins inspect "$PLUGIN_ID" --json 2>/dev/null)" || [[ -z "$out" ]]; then
		_LIB_INSPECT_JSON=""
		_LIB_INSPECT_LOADED=1
		return 0
	fi
	_LIB_INSPECT_JSON="$out"
	_LIB_INSPECT_LOADED=1
}

# 安装状态已变（卸载/重装）时作废缓存
invalidate_install_record() {
	_LIB_INSPECT_JSON=""
	_LIB_INSPECT_LOADED=0
}

# 检测当前安装模式
# 返回: link | npm | archive | none
# 注意: OpenClaw --link 安装实际记录 source="path"，此函数通过
#       比较 sourcePath 与 installPath 是否相同来判断是否为 link 模式。
get_install_mode() {
	load_install_record || return 1
	if [[ -z "$_LIB_INSPECT_JSON" ]]; then
		echo "none"
		return
	fi
	local result
	# 有输出但非 JSON：响亮报错、不回落旧账本（dev 机均新 host，旧账本只会给分歧数据）
	result=$(printf '%s' "$_LIB_INSPECT_JSON" | node -e "
		let raw = '';
		process.stdin.on('data', (d) => { raw += d; });
		process.stdin.on('end', () => {
			let payload;
			try { payload = JSON.parse(raw); }
			catch (e) { process.exit(2); }
			const r = payload?.install;
			if (!r) { console.log('none'); return; }
			if (r.source === 'path') {
				const same = r.sourcePath && r.installPath && r.sourcePath === r.installPath;
				console.log(same ? 'link' : 'link:mismatch');
			} else {
				console.log(r.source ?? 'none');
			}
		});
	") || {
		echo "[ERROR] plugins inspect 输出无法解析（非 JSON），拒绝猜测安装模式" >&2
		echo "[HINT] 手动检查: openclaw plugins inspect $PLUGIN_ID --json" >&2
		return 1
	}
	if [[ "$result" == "link:mismatch" ]]; then
		echo "[ERROR] source=path 但 sourcePath !== installPath，安装状态异常" >&2
		echo "[HINT] 建议执行 openclaw plugins doctor 检查" >&2
		echo "link"
		return
	fi
	echo "${result:-none}"
}

# 获取已安装的版本号（未安装输出空串）
get_installed_version() {
	load_install_record || return 1
	if [[ -z "$_LIB_INSPECT_JSON" ]]; then
		echo ""
		return
	fi
	printf '%s' "$_LIB_INSPECT_JSON" | node -e "
		let raw = '';
		process.stdin.on('data', (d) => { raw += d; });
		process.stdin.on('end', () => {
			let payload;
			try { payload = JSON.parse(raw); }
			catch (e) { process.exit(2); }
			console.log(payload?.install?.version ?? '');
		});
	" || {
		echo "[ERROR] plugins inspect 输出无法解析（非 JSON），拒绝猜测版本" >&2
		return 1
	}
}

# 卸载当前安装的插件（不清理 bindings）
ensure_uninstalled() {
	# 主 shell 预载缓存，让下面子 shell 的 get_install_mode 复用，不再起 CLI
	load_install_record || return 1
	local mode
	mode=$(get_install_mode)
	if [[ "$mode" == "none" ]]; then
		echo "[INFO] 插件未安装，无需卸载"
		return 0
	fi
	echo "[INFO] 当前安装模式: ${mode}，执行卸载..."
	# --force 跳过交互确认；脚本环境没有 stdin tty。
	openclaw plugins uninstall --force "$PLUGIN_ID" || true
	# 状态已变，作废缓存（后续读取重新走 CLI）
	invalidate_install_record
	# 清理可能残留的 extensions 目录
	local ext_dir="$OPENCLAW_STATE_DIR_RESOLVED/extensions/$PLUGIN_ID"
	if [[ -d "$ext_dir" ]]; then
		echo "[INFO] 清理残留目录: $ext_dir"
		rm -rf "$ext_dir"
	fi
}

# 等待 gateway 自动重启（openclaw.json 变更触发 chokidar file-watch → restart）
wait_gateway_restart() {
	echo "[INFO] 等待 gateway 自动重启..."
	sleep 3
}

# 验证安装状态
verify_install() {
	echo ""
	echo "[VERIFY] openclaw plugins doctor"
	openclaw plugins doctor
	echo ""
	echo "[VERIFY] openclaw gateway status"
	openclaw gateway status
}

# 解析本机 openclaw 包根目录。子 shell 里调用，失败 return 1（不能用 exit——
# 命令替换的 exit 只杀子 shell，主脚本会带空值继续）。
resolve_openclaw_root() {
	local bin root
	bin="$(command -v openclaw 2>/dev/null || true)"
	if [[ -z "$bin" ]]; then
		echo "[ERROR] 未找到 openclaw CLI，无法为 link-stage 建 node_modules/openclaw 软链" >&2
		echo "[HINT] 确认 openclaw 已安装且在 PATH 上" >&2
		return 1
	fi
	# openclaw.mjs 位于包根，bin 多为指向它的软链；逐层解析后取其所在目录
	root="$(dirname "$(readlink -f "$bin")")"
	if [[ "$(node -p "require('$root/package.json').name" 2>/dev/null)" != "openclaw" ]]; then
		echo "[ERROR] openclaw 包根解析异常：$root 非 openclaw 包目录" >&2
		echo "[HINT] openclaw CLI 入口布局可能变更，请检查 $bin 的真实指向" >&2
		return 1
	fi
	echo "$root"
}

# 在 stage 的 node_modules 下建 openclaw → host 包根软链，供 runtime 原生解析
# import('openclaw/plugin-sdk/*')。**必须在 `openclaw plugins install` 之后调用**：
# install 期安全扫描拒绝 node_modules 下任何外指软链（见 link.sh 头注），而 gateway
# 重启 / 加载 plugins.load.paths 插件时**不再重扫**，故 install 后补链可长期存活。
# --link 安装器自身不建此链（dryRun 探针跳过建链的 afterInstall），故由我们补。idempotent。
ensure_openclaw_link() {
	local oc_root
	if ! oc_root="$(resolve_openclaw_root)"; then
		exit 1
	fi
	rm -rf "$STAGE_DIR/node_modules/openclaw"
	ln -s "$oc_root" "$STAGE_DIR/node_modules/openclaw"
	echo "[STEP] 建 node_modules/openclaw → ${oc_root}（runtime 解析 plugin-sdk）"
}

# 构建扁平依赖 stage（pnpm deploy）+ 把 src/ 换成回指源目录的 symlink。
# 被 link.sh 与 worktree-gateway.sh 共用。详见 link.sh 顶部注释与
# docs/local-plugin-update-sop.md（为何只软链 src/、为何要扁平依赖）。
build_stage() {
	echo "[STEP] pnpm deploy → $STAGE_DIR"
	rm -rf "$STAGE_DIR"
	mkdir -p "$(dirname "$STAGE_DIR")"
	(cd "$WORKSPACE_ROOT" && pnpm deploy --prod --filter "$PKG_NAME" --legacy "$STAGE_DIR")

	# pnpm 会在 .pnpm/node_modules/ 下塞一条指向源目录的 workspace 自引用，
	# 扫描会把它判定为外指。插件不 import 自己，直接删掉即可。
	local self_ref="$STAGE_DIR/node_modules/.pnpm/node_modules/$PKG_NAME"
	if [[ -L "$self_ref" ]]; then
		rm -f "$self_ref"
	fi

	# 根 pnpm.overrides 把 openclaw peer 重定向到 tools/openclaw-peer-stub 空壳（摁锁膨胀），
	# pnpm deploy 据此在 stage 建一条 node_modules/openclaw → 空壳的外指软链——它既会被下面
	# 的 leak 自检判为外指、也会被 install 安全扫描拒（指向非 host openclaw）。直接删；runtime
	# 真要用的 openclaw 链由 ensure_openclaw_link 在 install 之后另建。
	rm -rf "$STAGE_DIR/node_modules/openclaw"

	# 把 src/ 换成回指真源目录的 symlink，保留“改代码 → restart gateway”热更新。
	#
	# 为什么仅 src/：
	#   OpenClaw discovery 对以下三类文件做 realpath-in-root 检查，symlink 外指会被拒：
	#     · 入口 index.js（checkSourceEscapesRoot）
	#     · package.json / openclaw.plugin.json（openBoundaryFileSync → boundary-path.ts）
	#   这三个必须保留 deploy 产出的真文件拷贝。src/ 下的模块仅被 Node runtime
	#   require 加载（自动跟随 symlink），不经过任何 boundary 检查。
	#   所以 src/ 用 symlink 既能热更新，又不触发拦截。
	rm -rf "$STAGE_DIR/src"
	ln -s "$PLUGIN_DIR/src" "$STAGE_DIR/src"

	# 自检：确认 stage 的 src 确为指向「本检出」源码的活软链。一旦 pnpm deploy 布局
	# 变更（跟随/拷贝 src）或软链创建失败，这里 loud 失败，避免 reload 静默测到旧码。
	local stage_src real_src
	stage_src="$(readlink -f "$STAGE_DIR/src" 2>/dev/null || true)"
	real_src="$(readlink -f "$PLUGIN_DIR/src" 2>/dev/null || true)"
	if [[ -z "$stage_src" || "$stage_src" != "$real_src" ]]; then
		echo "[ERROR] stage src 软链自检失败：$STAGE_DIR/src → ${stage_src:-<空>}（期望 ${real_src}）" >&2
		echo "[HINT] 可能 pnpm deploy 布局变更或软链失活，reload 会测到旧码，已中止" >&2
		exit 1
	fi

	# 核对：node_modules 里不允许再有指向 stage 外的 symlink，
	# 一旦 pnpm 布局变更引入新的外指会立即暴露。
	local leak
	leak=$(find "$STAGE_DIR/node_modules" -type l 2>/dev/null | while read -r l; do
		local tgt
		tgt=$(readlink -f "$l" 2>/dev/null || true)
		# 非空且不在 stage 内 = 外指泄漏。用 [[ ]] 而非 case：bash 3.2 无法在 $(...)
		# 命令替换内解析 case（把闭 case 分支的 ) 误当成闭命令替换的 )，macOS 自带 bash 3.2）。
		if [[ -n "$tgt" && "$tgt" != "$STAGE_DIR"/* ]]; then
			echo "$l → $tgt"
		fi
	done | head -1)
	if [[ -n "$leak" ]]; then
		echo "[ERROR] stage 仍存在外指 symlink：$leak" >&2
		echo "[HINT] 请上报该 symlink，可能是新的 pnpm 布局变更" >&2
		exit 1
	fi
}
