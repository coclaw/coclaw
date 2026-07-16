/**
 * rtc-isolation.test.js — 自动升级链路与 WebRTC/pion/bridge 的隔离红线
 *
 * werift 兜底剔除后 pion 是唯一 WebRTC 实现：某台机器 pion 起不来（impl=none）时，
 * 自动升级是把它"捞回来"的唯一通道（发布修复版 → 自动升级装上 → 恢复）。
 * 若升级链路反过来依赖 RTC/pion，pion 挂掉的机器连升级也挂 → 永久变砖。
 *
 * 四条静态钉死：
 * 1. scheduler 入口 updater.js 的 import 闭包不触碰 RTC 面，且零外部依赖；
 * 2. 升级 worker（独立子进程）worker.js 同上，另禁 remote-log；
 * 3. 插件入口 index.js 的模块可达图（静态 + 字面量动态相对边都展开——顶层 await import
 *    会把惰性边变成加载期边，故一并扫）不得以任何字面量形态引入 native RTC 包；
 * 4. native RTC SDK 的生产加载点全 src 唯一：pion-preloader.js 内经注入式动态 import，
 *    连"包名字符串出现在别处"都判红（封住 wrapper 函数一类的间接加载形态）。
 *
 * 扫描是词法级（手写小词法器剥掉注释/字符串/模板/正则字面量后按 token 流提取 specifier），
 * 不是对原文跑正则——后者会被 token 间注释等合法写法骗过（实证过的绕过形态，见语料用例）。
 *
 * fail-closed 原则：扫不出 ≠ 安全。凡无法静态确定的引入形态——非字面量 import()/require、
 * createRequire、eval、模板替换位里的 loader 调用、缺字面量 specifier 的声明——一律判红，
 * 逼改动者要么写成可分析的字面量形态、要么在白名单里显式豁免并写明理由（白名单按
 * 文件+形态精确计数，多一个少一个都红）。
 *
 * 钉不住的（如实声明，别让承诺超出能力）：
 * - 蓄意混淆（字符串拼接 specifier、eval 动态源码等）只被 unanalyzable/eval 判红兜住，
 *   护栏定位是防意外回归，不承诺防恶意；
 * - "preload 永不 settle" 是运行时形态，import 面扫描钉不住（见 TODO.md 熔断条目）；
 * - 运行时行为由 realtime-bridge 的 impl=none 契约测试与升级链路自身测试覆盖。
 *
 * 自保：语料用例（扫描器直接吃已实证的绕过形态源码）+ fixture 变异用例（把违规代码
 * 真实落盘走完整闭包收集与断言链）保证扫描器或断言接线被削弱时本文件自己变红。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { test } from 'node:test';

const PLUGIN_ROOT = nodePath.resolve(import.meta.dirname, '..', '..');

// RTC 面模块特征：webrtc/ 目录、realtime-bridge、pion（SDK 与 preloader）、
// file-manager（挂在 DC 上的文件传输）。命中任何一个即违反隔离红线。
const RTC_FORBIDDEN = /webrtc|werift|pion|realtime-bridge|file-manager/i;

// native RTC 包（含历史名）：任何字面量引入形态（static/dynamic/require）都禁
const NATIVE_RTC_PKGS = /^(?:@coclaw\/pion-node|werift|node-datachannel)(?:\/|$)/;

// 入口可达图内允许的不可分析形态白名单（file+form 精确计数；增删都红，防白名单腐化）
const ENTRY_UNANALYZABLE_ALLOW = [
	// pion-preloader 的可注入加载原语 `deps.dynamicImport ?? ((spec) => import(spec))`：
	// 测试经 deps.dynamicImport 注入 mock，生产走 import(spec)。它的唯一字面量调用点
	// 由"唯一生产加载点"用例钉死，且它只在 preload 函数内执行（惰性，不炸注册期）。
	{ file: 'src/webrtc/pion-preloader.js', form: 'non-literal dynamic import', count: 1 },
];

// native RTC 包名字符串在全 src 的唯一合法出现点（生产加载点钉死）
const NATIVE_LOAD_POINT_ALLOW = [
	{ file: 'src/webrtc/pion-preloader.js', value: '@coclaw/pion-node' },
];

// —— 词法层 ——

const WORD_CHAR = /[A-Za-z0-9_$]/;
// '/' 起始处，前一 token 是这些关键字或非 )/] 标点时按正则字面量消费，否则按除号
const REGEX_PREV_WORDS = new Set([
	'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/**
 * 消费一段模板字面量（src[start] 为反引号），处理 ${} 替换位嵌套（含嵌套模板、
 * 替换位内的字符串与注释），返回结束位置与是否含替换位。
 * @param {string} src
 * @param {number} start
 * @returns {{ end: number, hasSubst: boolean }}
 */
function lexTemplate(src, start) {
	let i = start + 1;
	let hasSubst = false;
	while (i < src.length) {
		const c = src[i];
		if (c === '\\') { i += 2; continue; }
		if (c === '`') return { end: i + 1, hasSubst };
		if (c === '$' && src[i + 1] === '{') {
			hasSubst = true;
			i += 2;
			let depth = 1;
			while (i < src.length && depth > 0) {
				const d = src[i];
				if (d === '\\') { i += 2; continue; }
				if (d === '`') { i = lexTemplate(src, i).end; continue; }
				if (d === '/' && src[i + 1] === '/') {
					const nl = src.indexOf('\n', i + 2);
					i = nl === -1 ? src.length : nl + 1;
					continue;
				}
				if (d === '/' && src[i + 1] === '*') {
					const close = src.indexOf('*/', i + 2);
					i = close === -1 ? src.length : close + 2;
					continue;
				}
				if (d === "'" || d === '"') {
					i++;
					while (i < src.length && src[i] !== d) i += src[i] === '\\' ? 2 : 1;
					i++;
					continue;
				}
				if (d === '{') depth++;
				else if (d === '}') depth--;
				i++;
			}
			continue;
		}
		i++;
	}
	return { end: src.length, hasSubst };
}

/**
 * 把源码切成 token 流：注释剥除；字符串/模板/正则字面量为原子 token；
 * 其余按 word（标识符/关键字/数字）与单字符 punct 切分。
 * @param {string} src
 * @returns {{ type: string, value?: string, hasSubst?: boolean }[]}
 */
function tokenize(src) {
	const tokens = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) { i++; continue; }
		if (c === '/' && src[i + 1] === '/') {
			const nl = src.indexOf('\n', i + 2);
			i = nl === -1 ? src.length : nl + 1;
			continue;
		}
		if (c === '/' && src[i + 1] === '*') {
			const close = src.indexOf('*/', i + 2);
			i = close === -1 ? src.length : close + 2;
			continue;
		}
		if (c === "'" || c === '"') {
			let j = i + 1;
			let value = '';
			while (j < src.length && src[j] !== c) {
				if (src[j] === '\\') { value += src[j + 1] ?? ''; j += 2; }
				else { value += src[j]; j++; }
			}
			tokens.push({ type: 'string', value });
			i = j + 1;
			continue;
		}
		if (c === '`') {
			const { end, hasSubst } = lexTemplate(src, i);
			tokens.push({ type: 'template', value: src.slice(i + 1, end - 1), hasSubst });
			i = end;
			continue;
		}
		if (c === '/') {
			const prev = tokens[tokens.length - 1];
			const isRegex = !prev
				|| (prev.type === 'punct' && prev.value !== ')' && prev.value !== ']')
				|| (prev.type === 'word' && REGEX_PREV_WORDS.has(prev.value));
			if (isRegex) {
				let j = i + 1;
				let inClass = false;
				while (j < src.length) {
					const d = src[j];
					if (d === '\\') { j += 2; continue; }
					if (d === '[') inClass = true;
					else if (d === ']') inClass = false;
					else if (d === '/' && !inClass) break;
					else if (d === '\n') break; // 正则不跨行；万一误判成正则也止损在行尾
					j++;
				}
				j++;
				while (j < src.length && WORD_CHAR.test(src[j])) j++; // flags
				tokens.push({ type: 'regex' });
				i = j;
				continue;
			}
			tokens.push({ type: 'punct', value: '/' });
			i++;
			continue;
		}
		if (WORD_CHAR.test(c)) {
			let j = i;
			while (j < src.length && WORD_CHAR.test(src[j])) j++;
			tokens.push({ type: 'word', value: src.slice(i, j) });
			i = j;
			continue;
		}
		tokens.push({ type: 'punct', value: c });
		i++;
	}
	return tokens;
}

// —— 提取层 ——

/**
 * 从单个源文件提取：specifier（static/dynamic/require 三形态，只收字面量）、
 * 全部字符串/模板字面量（供"唯一生产加载点"钉子）、不可分析形态清单。
 * @param {string} src
 * @returns {{ specs: { spec: string, kind: string }[], strings: { value: string, template: boolean, hasSubst?: boolean }[], unanalyzable: { form: string }[] }}
 */
function scanSource(src) {
	const tokens = tokenize(src);
	const specs = [];
	const strings = [];
	const unanalyzable = [];
	const at = (k) => tokens[k] ?? { type: 'eof', value: '' };
	// createRequire/eval 用独立全量遍历判红（不放进下面的游标循环：
	// 游标处理 import 声明时会跳过 clause 内 token，import { createRequire as cr } 会漏）
	for (const t of tokens) {
		if (t.type === 'string') strings.push({ value: t.value, template: false });
		else if (t.type === 'template') {
			strings.push({ value: t.value, template: true, hasSubst: t.hasSubst });
			// 替换位表达式未展开成 token，其中的 loader 调用文本兜底判红
			if (t.hasSubst && /(?<![\w.$])(?:import|require)\s*\(/.test(t.value)) {
				unanalyzable.push({ form: 'loader call inside template substitution' });
			}
		} else if (t.type === 'word' && t.value === 'createRequire') {
			unanalyzable.push({ form: 'createRequire' });
		} else if (t.type === 'word' && t.value === 'eval') {
			unanalyzable.push({ form: 'eval' });
		}
	}
	let i = 0;
	while (i < tokens.length) {
		const t = tokens[i];
		if (t.type !== 'word') { i++; continue; }
		if (t.value === 'import') {
			const next = at(i + 1);
			if (next.type === 'punct' && next.value === '.') { i += 2; continue; } // import.meta
			if (next.type === 'punct' && next.value === '(') {
				const arg = at(i + 2);
				const after = at(i + 3);
				if (arg.type === 'string' && after.type === 'punct' && (after.value === ')' || after.value === ',')) {
					specs.push({ spec: arg.value, kind: 'dynamic' });
					i += 4;
				} else {
					unanalyzable.push({ form: 'non-literal dynamic import' });
					i += 2;
				}
				continue;
			}
			// 静态 import 声明：specifier 是声明内第一个字符串字面量（ESM 语法保证）；
			// 扫到语句边界仍没有 → 词法器被某种写法搞糊涂了，判红而不是放过
			let j = i + 1;
			let found = false;
			while (j < tokens.length) {
				const u = tokens[j];
				if (u.type === 'string') { specs.push({ spec: u.value, kind: 'static' }); found = true; break; }
				if ((u.type === 'punct' && u.value === ';') || (u.type === 'word' && (u.value === 'import' || u.value === 'export'))) break;
				j++;
			}
			if (!found) unanalyzable.push({ form: 'static import without literal specifier' });
			i = found ? j + 1 : i + 1;
			continue;
		}
		if (t.value === 'export') {
			const next = at(i + 1);
			if (next.type === 'punct' && next.value === '{') {
				let j = i + 2;
				let depth = 1;
				while (j < tokens.length && depth > 0) {
					const u = tokens[j];
					if (u.type === 'punct' && u.value === '{') depth++;
					else if (u.type === 'punct' && u.value === '}') depth--;
					j++;
				}
				if (at(j).type === 'word' && at(j).value === 'from') {
					const spec = at(j + 1);
					if (spec.type === 'string') { specs.push({ spec: spec.value, kind: 'static' }); i = j + 2; }
					else { unanalyzable.push({ form: 'export-from without literal specifier' }); i = j + 1; }
				} else {
					i = j; // 本地导出，无 specifier
				}
				continue;
			}
			if (next.type === 'punct' && next.value === '*') {
				// export * from 'x' / export * as ns from 'x'
				let j = i + 2;
				while (j < tokens.length && j <= i + 5 && !(tokens[j].type === 'word' && tokens[j].value === 'from')) j++;
				const spec = at(j + 1);
				if (at(j).type === 'word' && at(j).value === 'from' && spec.type === 'string') {
					specs.push({ spec: spec.value, kind: 'static' });
					i = j + 2;
				} else {
					unanalyzable.push({ form: 'export-star without literal specifier' });
					i += 2;
				}
				continue;
			}
			i++;
			continue;
		}
		if (t.value === 'require') {
			const next = at(i + 1);
			if (next.type === 'punct' && next.value === '(') {
				const arg = at(i + 2);
				const after = at(i + 3);
				if (arg.type === 'string' && after.type === 'punct' && (after.value === ')' || after.value === ',')) {
					specs.push({ spec: arg.value, kind: 'require' });
					i += 4;
				} else {
					unanalyzable.push({ form: 'non-literal require call' });
					i += 2;
				}
			} else {
				// 裸 require 引用（如 const r = require 别名）同样无法分析
				unanalyzable.push({ form: 'require reference without literal call' });
				i++;
			}
			continue;
		}
		i++;
	}
	return { specs, strings, unanalyzable };
}

// —— 闭包收集 ——

const toPosix = (p) => p.split(nodePath.sep).join('/');

/**
 * 收集一个入口文件的模块可达图：static/dynamic/require 三形态的字面量相对边全部
 * 递归展开（顶层 await import 会让"惰性"边在加载期执行，故不区分）；node: 内建与
 * 外部包记录 specifier 但不展开。
 * @param {string} entryAbs - 入口文件绝对路径
 * @param {string} [root] - 报告用的相对路径根（默认插件根；fixture 传自己的临时目录）
 * @returns {Promise<{ files: Set<string>, specs: { from: string, spec: string, kind: string }[], unanalyzable: { file: string, form: string }[], strings: { file: string, value: string, template: boolean, hasSubst?: boolean }[] }>}
 */
async function collectClosure(entryAbs, root = PLUGIN_ROOT) {
	const files = new Set();
	const specs = [];
	const unanalyzable = [];
	const strings = [];
	const queue = [entryAbs];
	while (queue.length) {
		const file = queue.pop();
		if (files.has(file)) continue;
		files.add(file);
		const rel = toPosix(nodePath.relative(root, file));
		let src;
		try {
			src = await fs.readFile(file, 'utf8');
		} catch (err) {
			throw new Error(`closure scan cannot read ${rel}（相对 specifier 必须是带扩展名的真实文件路径）: ${err.message}`);
		}
		const scan = scanSource(src);
		for (const u of scan.unanalyzable) unanalyzable.push({ file: rel, form: u.form });
		for (const s of scan.strings) strings.push({ file: rel, ...s });
		for (const { spec, kind } of scan.specs) {
			specs.push({ from: rel, spec, kind });
			if (spec.startsWith('.')) queue.push(nodePath.resolve(nodePath.dirname(file), spec));
		}
	}
	return { files, specs, unanalyzable, strings };
}

// —— 断言层 ——

function assertNoRtcSurface(specs) {
	const hits = specs.filter(({ spec }) => RTC_FORBIDDEN.test(spec));
	assert.deepEqual(
		hits, [],
		`升级链路 import 闭包不得触碰 RTC 面（webrtc/pion/bridge/file-manager）：${JSON.stringify(hits)}`,
	);
}

/**
 * 不可分析形态判红（fail-closed 核心）：白名单按 file+form 精确计数，
 * 实际次数多于/少于白名单、或白名单条目已消失，都判失败——防白名单腐化。
 * @param {{ file: string, form: string }[]} unanalyzable
 * @param {{ file: string, form: string, count: number }[]} [allow]
 */
function assertAnalyzable(unanalyzable, allow = []) {
	const counts = new Map();
	for (const u of unanalyzable) {
		const key = `${u.file} :: ${u.form}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const allowed = new Map(allow.map((a) => [`${a.file} :: ${a.form}`, a.count]));
	const violations = [];
	for (const [site, count] of counts) {
		if (allowed.get(site) !== count) violations.push({ site, count, allowedCount: allowed.get(site) ?? 0 });
	}
	for (const [site, allowedCount] of allowed) {
		if (!counts.has(site)) violations.push({ site, count: 0, allowedCount });
	}
	assert.deepEqual(
		violations, [],
		'闭包内出现扫描器无法静态分析的加载形态（fail-closed：扫不出即判红）。'
		+ '请改写为字面量 import/require；确属合法惰性加载原语时，更新本文件白名单并写明理由：'
		+ JSON.stringify(violations),
	);
}

function assertNoExternalDeps(specs, who) {
	// 只允许 node: 内建 + 插件内相对模块——升级器在依赖树受损时也必须能跑
	// （它正是修复依赖树的通道），不得引入外部 npm 包（外部包不被展开，
	// 名字不含黑名单词也可能内裹 RTC，一律禁入）。
	const external = specs.filter(({ spec }) => !spec.startsWith('.') && !spec.startsWith('node:'));
	assert.deepEqual(external, [], `${who} 闭包不得有外部依赖：${JSON.stringify(external)}`);
}

function assertNoNativeSpecs(specs) {
	const hits = specs.filter(({ spec }) => NATIVE_RTC_PKGS.test(spec));
	assert.deepEqual(
		hits, [],
		'插件入口可达图不得以任何字面量形态（static/dynamic/require）引入 native RTC 包——'
		+ `包损坏/二进制缺失会在加载期炸掉插件注册，升级通道随 RTC 同死。native SDK 只允许经 pion-preloader 惰性加载：${JSON.stringify(hits)}`,
	);
}

/**
 * 字符串/模板字面量层面的 native 包名命中（封 wrapper 函数间接加载）。
 * 含替换位的模板无法整体求值 → raw 内出现包名即命中（fail-closed）。
 * @param {{ value: string, template: boolean, hasSubst?: boolean }[]} strings
 */
function nativeStringHits(strings) {
	return strings.filter((s) => {
		if (s.template && s.hasSubst) {
			return /@coclaw\/pion-node|(?<![\w-])(?:werift|node-datachannel)(?![\w-])/.test(s.value);
		}
		return NATIVE_RTC_PKGS.test(s.value);
	});
}

function assertSoleNativeLoadPoint(hits) {
	assert.deepEqual(
		hits, NATIVE_LOAD_POINT_ALLOW,
		'native RTC 包名字符串在生产 src 只允许出现在 pion-preloader 的动态加载点。'
		+ '新增加载/引用点请先想清楚是否破坏"pion 失败不影响自动升级"红线，确属合法再更新白名单：'
		+ JSON.stringify(hits),
	);
}

// —— 审计入口（真实红线用例与 fixture 变异用例共用同一批函数，接线被削弱时 fixture 变红）——

async function auditUpgradeClosure(entryAbs, who, root) {
	const { specs, unanalyzable } = await collectClosure(entryAbs, root);
	assertNoRtcSurface(specs);
	assertAnalyzable(unanalyzable);
	assertNoExternalDeps(specs, who);
	return { specs, unanalyzable };
}

async function auditPluginEntry(entryAbs, allowUnanalyzable, root) {
	const { specs, unanalyzable } = await collectClosure(entryAbs, root);
	assertNoNativeSpecs(specs);
	assertAnalyzable(unanalyzable, allowUnanalyzable);
	return { specs, unanalyzable };
}

/**
 * 递归收集目录下全部生产 .js（剔除 *.test.js），返回 native 包名字符串命中清单。
 * @param {string[]} rootsAbs - 待扫描的文件或目录绝对路径
 * @param {string} relRoot - 报告用相对路径根
 * @returns {Promise<{ file: string, value: string }[]>}
 */
async function collectNativeStringHits(rootsAbs, relRoot) {
	const files = [];
	async function walk(p) {
		const stat = await fs.stat(p);
		if (stat.isDirectory()) {
			for (const name of (await fs.readdir(p)).sort()) {
				if (name === 'node_modules') continue;
				await walk(nodePath.join(p, name));
			}
			return;
		}
		if (p.endsWith('.js') && !p.endsWith('.test.js')) files.push(p);
	}
	for (const root of rootsAbs) await walk(root);
	const hits = [];
	for (const file of files.sort()) {
		const scan = scanSource(await fs.readFile(file, 'utf8'));
		for (const s of nativeStringHits(scan.strings)) {
			hits.push({ file: toPosix(nodePath.relative(relRoot, file)), value: s.value });
		}
	}
	return hits;
}

// —— 红线用例 ——

test('红线：scheduler（updater.js）import 闭包不触碰 RTC 面，且零外部依赖', async () => {
	await auditUpgradeClosure(nodePath.join(import.meta.dirname, 'updater.js'), 'scheduler');
});

test('红线：升级 worker（worker.js）import 闭包不触碰 RTC 面，且零外部依赖', async () => {
	const { specs } = await auditUpgradeClosure(nodePath.join(import.meta.dirname, 'worker.js'), 'worker');
	// worker 是独立 spawn 子进程：无 bridge 连接，禁止 remote-log（既有红线，一并钉死）
	const remoteLogHits = specs.filter(({ spec }) => /remote-log/.test(spec));
	assert.deepEqual(remoteLogHits, [], `worker 闭包禁止 remote-log：${JSON.stringify(remoteLogHits)}`);
});

test('红线：插件入口 index.js 可达图不得含 native RTC 包，不可分析加载形态判红', async () => {
	// 入口可达图若含 @coclaw/pion-node 一类 native 包，包损坏/二进制缺失会在模块加载期
	// 炸掉整个插件注册——scheduler、upgradeHealth 一并陪葬，升级通道随 RTC 同死。
	await auditPluginEntry(nodePath.resolve(PLUGIN_ROOT, 'index.js'), ENTRY_UNANALYZABLE_ALLOW);
});

test('红线：native RTC SDK 唯一生产加载点钉死在 pion-preloader（全 src 字符串级扫描）', async () => {
	const hits = await collectNativeStringHits(
		[nodePath.join(PLUGIN_ROOT, 'index.js'), nodePath.join(PLUGIN_ROOT, 'src')],
		PLUGIN_ROOT,
	);
	assertSoleNativeLoadPoint(hits);
});

// —— 扫描器语料自测：已实证的绕过形态 + 良性形态，扫描器被削弱时这里先红 ——

const SCANNER_CORPUS = [
	{
		name: '括号注释不遮蔽静态 import specifier（实证绕过形态 1）',
		src: "import /* guard() */ '@coclaw/pion-node';",
		specs: [{ spec: '@coclaw/pion-node', kind: 'static' }],
		forms: [],
	},
	{
		name: '行注释换行后接 specifier',
		src: "import // 说明\n'@coclaw/pion-node';",
		specs: [{ spec: '@coclaw/pion-node', kind: 'static' }],
		forms: [],
	},
	{
		name: 'from 与 specifier 间夹注释',
		src: "import x from /* c */ '@coclaw/pion-node';",
		specs: [{ spec: '@coclaw/pion-node', kind: 'static' }],
		forms: [],
	},
	{
		name: 'export-star 夹注释',
		src: "export * from/* c */'@coclaw/pion-node';",
		specs: [{ spec: '@coclaw/pion-node', kind: 'static' }],
		forms: [],
	},
	{
		name: 'export 具名 re-export（含 as from 干扰）',
		src: "export { a as from } from '@coclaw/pion-node';",
		specs: [{ spec: '@coclaw/pion-node', kind: 'static' }],
		forms: [],
	},
	{
		name: '顶层字面量动态 import 被收集（实证绕过形态 2）',
		src: "await import('@coclaw/pion-node');",
		specs: [{ spec: '@coclaw/pion-node', kind: 'dynamic' }],
		forms: [],
	},
	{
		name: '动态 import 括号内夹注释',
		src: "await import(/* c */ '@coclaw/pion-node');",
		specs: [{ spec: '@coclaw/pion-node', kind: 'dynamic' }],
		forms: [],
	},
	{
		name: 'createRequire 判红（实证绕过形态 3）',
		src: "import { createRequire } from 'node:module';\nconst __r = createRequire(import.meta.url);\n__r('@coclaw/pion-node');",
		specs: [{ spec: 'node:module', kind: 'static' }],
		forms: ['createRequire', 'createRequire'],
	},
	{
		name: 'createRequire 改名导入也判红（clause 内单词不因游标跳跃漏检）',
		src: "import { createRequire as cr } from 'node:module';\nconst r = cr(import.meta.url);\nr('@coclaw/pion-node');",
		specs: [{ spec: 'node:module', kind: 'static' }],
		forms: ['createRequire'],
	},
	{
		name: '非字面量动态 import 判红',
		src: 'const load = (s) => import(s);',
		specs: [],
		forms: ['non-literal dynamic import'],
	},
	{
		name: '字符串拼接动态 import 判红',
		src: "import('@coclaw/' + rest);",
		specs: [],
		forms: ['non-literal dynamic import'],
	},
	{
		name: '模板字面量动态 import 判红',
		src: 'import(`@coclaw/pion-node`);',
		specs: [],
		forms: ['non-literal dynamic import'],
	},
	{
		name: '非字面量 require 判红',
		src: 'require(mod);',
		specs: [],
		forms: ['non-literal require call'],
	},
	{
		name: '裸 require 别名判红',
		src: 'const r = require;',
		specs: [],
		forms: ['require reference without literal call'],
	},
	{
		name: 'require 字面量正常收集',
		src: "require('node:fs');",
		specs: [{ spec: 'node:fs', kind: 'require' }],
		forms: [],
	},
	{
		name: '模板替换位内 loader 调用判红',
		src: 'log(`x ${await import(spec)} y`);',
		specs: [],
		forms: ['loader call inside template substitution'],
	},
	{
		name: 'eval 判红',
		src: 'eval(code);',
		specs: [],
		forms: ['eval'],
	},
	{
		name: '良性：import.meta 不误报',
		src: 'const d = import.meta.dirname;',
		specs: [],
		forms: [],
	},
	{
		name: '良性：import 前缀单词不误报',
		src: 'importantFn(value);',
		specs: [],
		forms: [],
	},
	{
		name: '良性：字符串里的 import 文本不算代码',
		src: "const s = 'import x from \\'./y.js\\'';",
		specs: [],
		forms: [],
	},
	{
		name: '良性：正则字面量里的引号不搅乱词法',
		src: "const re = /don't import '@coclaw\\/pion-node'/;\nimport './real.js';",
		specs: [{ spec: './real.js', kind: 'static' }],
		forms: [],
	},
];

for (const c of SCANNER_CORPUS) {
	test(`扫描器语料：${c.name}`, () => {
		const { specs, unanalyzable } = scanSource(c.src);
		assert.deepEqual(specs, c.specs, `specs 提取不符（形态：${c.name}）`);
		assert.deepEqual(unanalyzable.map((u) => u.form), c.forms, `unanalyzable 判定不符（形态：${c.name}）`);
	});
}

// —— fixture 变异回归：把违规代码真实落盘，走完整闭包收集 + 真实断言链。
// 与红线用例共用 audit 函数——断言被 no-op、收集接线被削弱时这里必须变红。 ——

async function withFixture(files, fn) {
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'rtc-isolation-fixture-'));
	try {
		for (const [name, content] of Object.entries(files)) {
			await fs.writeFile(nodePath.join(dir, name), content);
		}
		await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test('变异回归：升级闭包内括号注释 import 必须判红', async () => {
	await withFixture({
		'entry.js': "import './dep.js';\n",
		'dep.js': "import /* guard() */ '@coclaw/pion-node';\n",
	}, async (dir) => {
		await assert.rejects(
			auditUpgradeClosure(nodePath.join(dir, 'entry.js'), 'fixture', dir),
			/RTC 面/,
		);
	});
});

test('变异回归：入口顶层字面量动态 import native 包必须判红', async () => {
	await withFixture({
		'entry.js': "await import('@coclaw/pion-node');\n",
	}, async (dir) => {
		await assert.rejects(
			auditPluginEntry(nodePath.join(dir, 'entry.js'), [], dir),
			/native RTC 包/,
		);
	});
});

test('变异回归：入口 createRequire 加载必须判红', async () => {
	await withFixture({
		'entry.js': "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nreq('@coclaw/pion-node');\n",
	}, async (dir) => {
		await assert.rejects(
			auditPluginEntry(nodePath.join(dir, 'entry.js'), [], dir),
			/无法静态分析/,
		);
	});
});

test('变异回归：wrapper 函数间接加载被字符串级钉子拦住', async () => {
	await withFixture({
		'm.js': "const load = (s) => import(s);\nexport async function boot() { return load('@coclaw/pion-node'); }\n",
	}, async (dir) => {
		const hits = await collectNativeStringHits([dir], dir);
		assert.deepEqual(hits, [{ file: 'm.js', value: '@coclaw/pion-node' }], 'wrapper 形态的包名字符串必须被收集');
		assert.throws(() => assertSoleNativeLoadPoint(hits), /唯一生产加载点|只允许出现在 pion-preloader/);
	});
});

test('变异回归：升级闭包引入外部依赖必须判红', async () => {
	await withFixture({
		'entry.js': "import 'axios';\n",
	}, async (dir) => {
		await assert.rejects(
			auditUpgradeClosure(nodePath.join(dir, 'entry.js'), 'fixture', dir),
			/外部依赖/,
		);
	});
});

test('变异回归对照：干净 fixture 全部审计通过（护栏不许误伤正常代码）', async () => {
	await withFixture({
		'entry.js': "import fs from 'node:fs';\nimport { x } from './m.js';\nexport const y = x;\n",
		'm.js': 'export const x = 1;\n',
	}, async (dir) => {
		await auditUpgradeClosure(nodePath.join(dir, 'entry.js'), 'fixture', dir);
		await auditPluginEntry(nodePath.join(dir, 'entry.js'), [], dir);
		assert.deepEqual(await collectNativeStringHits([dir], dir), []);
	});
});
