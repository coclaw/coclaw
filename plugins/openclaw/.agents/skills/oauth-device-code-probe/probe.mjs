#!/usr/bin/env node
// 只读探针：枚举 OpenClaw 所有 provider 的 auth 方法，筛出 kind==='device_code' 的（也可改筛任意 kind），
// 用"捕获型 fake ctx"驱动它们的 run(ctx)，在亮出"含 URL 的验证 note"时立即中断（不轮询、不完成授权），
// 记录每家的 note 全文 / progress / 是否触发交互型 prompter / 返回结构，
// 用来回答：上游是否把这些登录流"归一化"了（note 格式、返回结构是否跨家一致）。
//
// 红线（务必保持）：
//   - 不动任何现有代码、不落盘任何凭据。
//   - 网络只到各家 usercode/device 端点拿一次码即停（读操作），绝不轮询到完成。
//   - 这脚本会把全部 provider 在本进程加载+登记一遍（有副作用、约数秒）——它是【进程外】只读探针，
//     别在生产 gateway 进程里直接 import 这套来做轻量查询。
//
// 用法：
//   node probe.mjs                      # 默认筛 device_code，结果写当前目录
//   node probe.mjs --kind oauth         # 改筛别的 kind（oauth/api_key/token/custom/all）
//   node probe.mjs --out tmp/x.json     # 指定结果文件
//   node probe.mjs --provider openai-codex   # 只跑某个 provider 的匹配方法

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import nodePath from 'node:path';
import os from 'node:os';
import { writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

// ---- 命令行参数 ----
function argValue(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const kindFilter = argValue('--kind', 'device_code'); // 'all' 表示不按 kind 过滤
const providerFilter = argValue('--provider', null); // 只跑某个 provider
const outPathArg = argValue('--out', null);

// ---- 解析全局安装的 openclaw 包（gateway 实际跑的那份），honor 它的 package.json exports ----
function resolveGlobalOpenClawDir() {
	const candidates = [];
	// 1. 当前 node 的全局 node_modules（最贴近 gateway 实际用的那份）
	try {
		const base = execSync('npm root -g', { encoding: 'utf8' }).trim();
		if (base) candidates.push(nodePath.join(base, 'openclaw'));
	} catch {
		/* ignore */
	}
	// 2. 从本脚本所在位置沿 node_modules 链解析（万一在能看到 openclaw 的上下文里跑）
	try {
		candidates.push(nodePath.dirname(createRequire(import.meta.url).resolve('openclaw/package.json')));
	} catch {
		/* ignore */
	}
	// 3. 扫所有 nvm node 版本的全局 node_modules（不写死版本号）
	try {
		const nvmVersions = nodePath.join(os.homedir(), '.nvm/versions/node');
		for (const v of readdirSync(nvmVersions)) {
			candidates.push(nodePath.join(nvmVersions, v, 'lib/node_modules/openclaw'));
		}
	} catch {
		/* ignore */
	}
	for (const dir of candidates) {
		if (dir && existsSync(nodePath.join(dir, 'package.json'))) return dir;
	}
	throw new Error(`cannot locate global openclaw package; tried: ${candidates.join(', ')}`);
}

const openclawDir = resolveGlobalOpenClawDir();
const requireFromPkg = createRequire(pathToFileURL(nodePath.join(openclawDir, 'package.json')));

async function importSubpath(specifier) {
	// 经包自己的 exports 解析子路径，再按绝对路径 import（内部相对 chunk / bare 依赖均相对该文件解析）
	const resolved = requireFromPkg.resolve(specifier);
	return import(pathToFileURL(resolved).href);
}

const { resolvePluginProviders, isPluginProvidersLoadInFlight } = await importSubpath(
	'openclaw/plugin-sdk/provider-catalog-runtime',
);

// 真实 config（默认 state-dir 的 openclaw.json）；拿不到就给空对象兜底
let config = {};
try {
	const cfgMod = await importSubpath('openclaw/plugin-sdk/config-runtime');
	if (typeof cfgMod.loadConfig === 'function') {
		config = cfgMod.loadConfig() ?? {};
	}
} catch (err) {
	console.error('[probe] loadConfig 失败，用空 config 兜底：', err?.message || err);
}

// ---- 哨兵 ----
class ProbeStop extends Error {} // 已捕获含 URL 的验证 note → 主动解栈中断
class ProbeInteractive extends Error {
	constructor(kind, message) {
		super(`interactive:${kind}${message ? ` (${message})` : ''}`);
		this.kind = kind;
	}
}
class ProbeTimeout extends Error {}

const URL_RE = /https?:\/\/[^\s)]+/;

// ---- 捕获型 ctx ----
function makeProbeCtx() {
	const sink = {
		notes: [],
		progress: [],
		promptCalls: { confirm: 0, text: 0, select: 0, multiselect: 0 },
		runtimeLog: [],
	};
	const prompter = {
		intro: async () => {},
		outro: async () => {},
		plain: async (m) => {
			sink.notes.push({ type: 'plain', message: m });
		},
		note: async (message, title) => {
			sink.notes.push({ type: 'note', title: title ?? null, message });
			// 只在"出现 URL 的那条 note"中断——有的 provider 第一条 note 是无 URL 的前导语，
			// 真正的验证信息在后面那条；所以按"含 URL"判定，不按"第一条"。
			if (URL_RE.test(message)) throw new ProbeStop();
		},
		select: async (p) => {
			sink.promptCalls.select++;
			throw new ProbeInteractive('select', p?.message);
		},
		multiselect: async (p) => {
			sink.promptCalls.multiselect++;
			throw new ProbeInteractive('multiselect', p?.message);
		},
		text: async (p) => {
			sink.promptCalls.text++;
			throw new ProbeInteractive('text', p?.message);
		},
		confirm: async (p) => {
			// 唯一会被设备码流合理调用的交互：如 "已登录是否重登" → 答 true 继续走登录拿码
			sink.promptCalls.confirm++;
			sink.notes.push({ type: 'confirm', message: p?.message ?? null, answered: true });
			return true;
		},
		progress: (label) => {
			sink.progress.push(label);
			return {
				update: (m) => sink.progress.push(`update: ${m}`),
				stop: (m) => sink.progress.push(`stop: ${m ?? ''}`),
			};
		},
	};
	const ctx = {
		config,
		env: process.env,
		prompter,
		runtime: {
			log: (...a) => sink.runtimeLog.push(a.map(String).join(' ')),
			error: (...a) => sink.runtimeLog.push('ERR ' + a.map(String).join(' ')),
			exit: () => {},
		},
		isRemote: true, // 远端语义：codex 等会跳过 openUrl、把码塞进 note
		openUrl: async () => {},
		oauth: {
			createVpsAwareHandlers: () => {
				throw new ProbeInteractive('oauth.createVpsAwareHandlers');
			},
		},
	};
	return { ctx, sink };
}

function withTimeout(promise, ms) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new ProbeTimeout()), ms);
		promise.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
}

function summarizeResult(r) {
	if (!r || typeof r !== 'object') return r;
	return {
		profilesCount: Array.isArray(r.profiles) ? r.profiles.length : null,
		profileIds: Array.isArray(r.profiles) ? r.profiles.map((p) => p?.profileId) : null,
		configPatchKeys: r.configPatch ? Object.keys(r.configPatch) : null,
		defaultModel: r.defaultModel ?? null,
		notes: r.notes ?? null,
	};
}

async function probeMethod(provider, method) {
	const { ctx, sink } = makeProbeCtx();
	const started = Date.now();
	let outcome;
	try {
		const result = await withTimeout(Promise.resolve().then(() => method.run(ctx)), 30000);
		outcome = { status: 'resolved-without-url-note', result: summarizeResult(result) };
	} catch (err) {
		if (err instanceof ProbeStop) outcome = { status: 'verification-note-captured' };
		else if (err instanceof ProbeInteractive)
			outcome = { status: 'needs-interactive-input', detail: err.message };
		else if (err instanceof ProbeTimeout) outcome = { status: 'timeout-no-url-note-30s' };
		else outcome = { status: 'error', error: String(err?.message || err) };
	}
	// 拎出"含 URL 且像验证信息"的那条 note（排除 help/faq 类兜底文案），单独展示便于比对格式
	const urlNotes = sink.notes.filter((n) => n.type === 'note' && URL_RE.test(n.message || ''));
	const urlNote =
		urlNotes.find((n) => !/faq|help|trouble|docs\.openclaw/i.test(n.message)) || urlNotes[0] || null;
	// 只要亮出了验证 URL note，无论 run 最终 resolve/reject（有的 provider 会把中途失败吞成空 profiles），
	// 真实结论都是"验证信息已亮出、登录可被驱动"——让标签如实反映
	if (urlNote && (outcome.status === 'resolved-without-url-note' || outcome.status === 'error')) {
		outcome = {
			status: 'verification-note-captured',
			viaRunSettled: outcome.status,
			...(outcome.result ? { runResult: outcome.result } : {}),
			...(outcome.error ? { runError: outcome.error } : {}),
		};
	}
	return {
		provider: provider.id,
		pluginId: provider.pluginId ?? null,
		method: method.id,
		label: method.label ?? null,
		kind: method.kind,
		elapsedMs: Date.now() - started,
		outcome,
		promptCalls: sink.promptCalls,
		progress: sink.progress,
		runtimeLog: sink.runtimeLog,
		verificationNote: urlNote
			? {
					title: urlNote.title,
					message: urlNote.message,
					urlInNote: (urlNote.message.match(URL_RE) || [null])[0],
				}
			: null,
		allNotes: sink.notes,
	};
}

// ---- 主流程 ----
console.error(`[probe] openclaw 包: ${openclawDir}`);
console.error(`[probe] kind 过滤: ${kindFilter}${providerFilter ? `, provider 过滤: ${providerFilter}` : ''}`);
console.error(
	'[probe] 调 resolvePluginProviders(mode=setup) 枚举全部 provider …（注意：进程外跑会触发 fallback load，把各 provider 插件在本进程 register 一遍，这正是要观察的 P2 行为）',
);

const t0 = Date.now();
let providers;
try {
	providers = resolvePluginProviders({ config, mode: 'setup' });
} catch (err) {
	console.error('[probe] resolvePluginProviders 抛错：', err);
	process.exit(1);
}
const loadMs = Date.now() - t0;
let inFlight = null;
try {
	inFlight = isPluginProvidersLoadInFlight({ config, mode: 'setup' });
} catch {
	/* ignore */
}

// 全景：每个 provider 的 auth 方法 kind
const landscape = providers.map((p) => ({
	id: p.id,
	pluginId: p.pluginId ?? null,
	authMethods: (p.auth || []).map((m) => ({ id: m.id, kind: m.kind, label: m.label ?? null })),
}));

const targets = [];
for (const p of providers) {
	if (providerFilter && p.id !== providerFilter) continue;
	for (const m of p.auth || []) {
		if ((kindFilter === 'all' || m.kind === kindFilter) && typeof m.run === 'function') {
			targets.push({ provider: p, method: m });
		}
	}
}

console.error(
	`[probe] providers=${providers.length}, load=${loadMs}ms, loadInFlight=${inFlight}, 匹配方法=${targets.length}`,
);
console.error(
	'[probe] 候选：',
	targets.map((t) => `${t.provider.id}:${t.method.id}(${t.method.kind})`).join(', ') || '(无)',
);

const results = [];
for (const t of targets) {
	console.error(`[probe] 驱动 ${t.provider.id}:${t.method.id} …`);
	// 串行跑，避免多家并发网络/日志互相干扰
	// eslint-disable-next-line no-await-in-loop
	const r = await probeMethod(t.provider, t.method);
	console.error(`        → ${r.outcome.status} (${r.elapsedMs}ms)`);
	results.push(r);
}

const report = {
	generatedAt: new Date().toISOString(),
	openclawDir,
	kindFilter,
	providerFilter,
	providerCount: providers.length,
	resolveLoadMs: loadMs,
	loadInFlight: inFlight,
	landscape,
	probed: results,
};

// 结果落盘：优先 --out，其次当前目录；写不动就退到系统临时目录，绝不丢
let outPath = outPathArg || nodePath.join(process.cwd(), 'oauth-device-code-probe-result.json');
try {
	writeFileSync(outPath, JSON.stringify(report, null, 2));
} catch {
	outPath = nodePath.join(os.tmpdir(), 'oauth-device-code-probe-result.json');
	writeFileSync(outPath, JSON.stringify(report, null, 2));
}
console.error(`[probe] 完整结果写入 ${outPath}`);

// ---- 人类可读小结 ----
console.log('\n================= 登录探针小结 =================\n');
console.log(`provider 总数: ${providers.length}   匹配方法数: ${targets.length}\n`);
for (const r of results) {
	console.log(`### ${r.provider}:${r.method}  [${r.kind}]  "${r.label ?? ''}"`);
	console.log(
		`  结果: ${r.outcome.status}${r.outcome.detail ? ' — ' + r.outcome.detail : ''}${r.outcome.error ? ' — ' + r.outcome.error : ''}${r.outcome.viaRunSettled ? ` (run 实际 settle: ${r.outcome.viaRunSettled})` : ''}`,
	);
	console.log(`  交互调用次数: ${JSON.stringify(r.promptCalls)}`);
	if (r.verificationNote) {
		console.log(`  验证 note 标题: ${JSON.stringify(r.verificationNote.title)}`);
		console.log(`  验证 note URL : ${r.verificationNote.urlInNote}`);
		console.log('  验证 note 全文:');
		for (const line of String(r.verificationNote.message).split('\n')) console.log('    | ' + line);
	} else {
		console.log('  验证 note: (未捕获到含 URL 的 note)');
		if (r.allNotes.length) {
			console.log('  实际收到的 note/交互序列:');
			for (const n of r.allNotes) console.log(`    - [${n.type}] ${JSON.stringify(n.title ?? n.message)}`);
		}
	}
	console.log('');
}
console.log('全 provider auth 全景（kind 候选筛选用）:');
for (const p of landscape) {
	const kinds = p.authMethods.map((m) => `${m.id}=${m.kind}`).join(', ') || '(无 auth)';
	console.log(`  - ${p.id}: ${kinds}`);
}
console.log('\n=================================================');

// 强制退出：被中断的 run 内部轮询可能在后台残留，避免进程挂住
process.exit(0);
