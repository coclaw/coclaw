/**
 * rtc-isolation.test.js — 自动升级链路与 WebRTC/pion/bridge 的隔离红线
 *
 * werift 兜底剔除后 pion 是唯一 WebRTC 实现：某台机器 pion 起不来（impl=none）时，
 * 自动升级是把它"捞回来"的唯一通道（发布修复版 → 自动升级装上 → 恢复）。
 * 若升级链路反过来依赖 RTC/pion，pion 挂掉的机器连升级也挂 → 永久变砖。
 *
 * 三条静态钉死：
 * 1. scheduler 入口 updater.js 的 import 闭包不触碰 RTC 面，且零外部依赖；
 * 2. 升级 worker（独立子进程）worker.js 同上，另禁 remote-log；
 * 3. 插件入口 index.js 的**静态** import 闭包不得含 native RTC 包——pion SDK 只允许
 *    经动态 import 惰性加载（preloader 内），坏包/坏二进制才不会炸插件注册与升级链路。
 *
 * 扫描是文本级（正则），方向 fail-closed：注释/字符串里的引号路径可能被误收集
 * （表现为读文件报错或黑名单误命中），但不会漏放绿。无法静态分析的加载形态
 * （createRequire、非字面量动态 import/require）在升级闭包内直接判红。
 * 运行时行为由 realtime-bridge 的 impl=none 契约测试与升级链路自身测试共同覆盖。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { test } from 'node:test';

// RTC 面模块特征：webrtc/ 目录、realtime-bridge、pion（SDK 与 preloader）、
// file-manager（挂在 DC 上的文件传输）。命中任何一个即违反隔离红线。
const RTC_FORBIDDEN = /webrtc|werift|pion|realtime-bridge|file-manager/i;

// native RTC 包（含历史名）：入口静态闭包禁入，只能动态 import
const NATIVE_RTC_PKGS = /^(?:@coclaw\/pion-node|werift|node-datachannel)(?:\/|$)/;

// specifier 提取：static（import/export ... from 'x' / import 'x'，ESM 语法保证字面量）、
// dynamic（import('x')）、require（require('x')，ESM 仓不应出现但一并捕获防绕过）
const SPEC_PATTERNS = [
	{ kind: 'static', re: /(?<![\w.$])(?:import|export)\s+(?:[^'"()]*?from\s*)?['"]([^'"]+)['"]/g },
	{ kind: 'dynamic', re: /(?<![\w.$])import\s*\(\s*['"]([^'"]+)['"]/g },
	{ kind: 'require', re: /(?<![\w.$])require\s*\(\s*['"]([^'"]+)['"]/g },
];

// 扫描器健全性：升级闭包内出现无法静态分析的加载形态时直接红，防止黑名单被静默绕过
const UNANALYZABLE = [
	{ name: 'createRequire', re: /createRequire/ },
	{ name: 'non-literal dynamic import', re: /(?<![\w.$])import\s*\(\s*[^'")\s]/ },
	{ name: 'non-literal require call', re: /(?<![\w.$])require\s*\(\s*[^'")\s]/ },
];

/**
 * 收集一个入口文件的 import 闭包。
 * 相对路径递归展开；node: 内建与外部包记录 specifier 但不展开。
 * @param {string} entryAbs - 入口文件绝对路径
 * @param {object} [opts]
 * @param {boolean} [opts.staticOnly] - 只沿静态 import/export-from 展开（动态/require 不收集）
 * @returns {Promise<{ files: Set<string>, specs: { from: string, spec: string, kind: string }[], unanalyzable: { file: string, form: string }[] }>}
 */
async function collectImportClosure(entryAbs, { staticOnly = false } = {}) {
	const files = new Set();
	const specs = [];
	const unanalyzable = [];
	const queue = [entryAbs];
	const patterns = staticOnly ? SPEC_PATTERNS.filter((p) => p.kind === 'static') : SPEC_PATTERNS;
	while (queue.length) {
		const file = queue.pop();
		if (files.has(file)) continue;
		files.add(file);
		let src;
		try {
			src = await fs.readFile(file, 'utf8');
		} catch (err) {
			// 正则是文本级扫描：注释/字符串里带引号的相对路径也会被当 specifier 压入队列
			throw new Error(`cannot read ${file} (a quoted path in a comment/string may have been mis-collected as an import specifier): ${err.message}`);
		}
		for (const { name, re } of UNANALYZABLE) {
			if (re.test(src)) unanalyzable.push({ file: nodePath.basename(file), form: name });
		}
		for (const { kind, re } of patterns) {
			for (const m of src.matchAll(re)) {
				const spec = m[1];
				specs.push({ from: nodePath.basename(file), spec, kind });
				if (spec.startsWith('.')) {
					queue.push(nodePath.resolve(nodePath.dirname(file), spec));
				}
			}
		}
	}
	return { files, specs, unanalyzable };
}

function assertNoRtcSurface(specs) {
	const hits = specs.filter(({ spec }) => RTC_FORBIDDEN.test(spec));
	assert.deepEqual(
		hits, [],
		`升级链路 import 闭包不得触碰 RTC 面（webrtc/pion/bridge/file-manager）：${JSON.stringify(hits)}`,
	);
}

function assertAnalyzable(unanalyzable) {
	assert.deepEqual(
		unanalyzable, [],
		`升级链路闭包内出现扫描器无法静态分析的加载形态（须改为字面量 import 或移出闭包）：${JSON.stringify(unanalyzable)}`,
	);
}

function assertNoExternalDeps(specs, who) {
	// 只允许 node: 内建 + 插件内相对模块——升级器在依赖树受损时也必须能跑
	// （它正是修复依赖树的通道），不得引入外部 npm 包（外部包不被展开，
	// 名字不含黑名单词也可能内裹 RTC，一律禁入）。
	const external = specs.filter(({ spec }) => !spec.startsWith('.') && !spec.startsWith('node:'));
	assert.deepEqual(external, [], `${who} 闭包不得有外部依赖：${JSON.stringify(external)}`);
}

test('红线：scheduler（updater.js）import 闭包不触碰 RTC 面，且零外部依赖', async () => {
	const { specs, unanalyzable } = await collectImportClosure(nodePath.join(import.meta.dirname, 'updater.js'));
	assertNoRtcSurface(specs);
	assertAnalyzable(unanalyzable);
	assertNoExternalDeps(specs, 'scheduler');
});

test('红线：升级 worker（worker.js）import 闭包不触碰 RTC 面，且零外部依赖', async () => {
	const { specs, unanalyzable } = await collectImportClosure(nodePath.join(import.meta.dirname, 'worker.js'));
	assertNoRtcSurface(specs);
	assertAnalyzable(unanalyzable);
	// worker 是独立 spawn 子进程：无 bridge 连接，禁止 remote-log（既有红线，一并钉死）
	const remoteLogHits = specs.filter(({ spec }) => /remote-log/.test(spec));
	assert.deepEqual(remoteLogHits, [], `worker 闭包禁止 remote-log：${JSON.stringify(remoteLogHits)}`);
	assertNoExternalDeps(specs, 'worker');
});

test('红线：插件入口 index.js 静态 import 闭包不得含 native RTC 包（pion 只许动态加载）', async () => {
	// 入口静态闭包若含 @coclaw/pion-node 一类 native 包，包损坏/二进制缺失会在模块加载期
	// 炸掉整个插件注册——scheduler、upgradeHealth 一并陪葬，升级通道随 RTC 同死。
	// 现状：pion SDK 仅在 pion-preloader.js 内动态 import，本用例把这条不变式钉死。
	const entry = nodePath.resolve(import.meta.dirname, '..', '..', 'index.js');
	const { specs } = await collectImportClosure(entry, { staticOnly: true });
	const hits = specs.filter(({ spec }) => NATIVE_RTC_PKGS.test(spec));
	assert.deepEqual(
		hits, [],
		`插件入口静态闭包不得直接 import native RTC 包（只允许 preloader 内动态 import）：${JSON.stringify(hits)}`,
	);
});
