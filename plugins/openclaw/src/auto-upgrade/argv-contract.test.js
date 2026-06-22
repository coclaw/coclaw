import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import nodePath from 'node:path';
import { spawnUpgradeWorker } from './updater-spawn.js';

// updater-spawn（拼 argv）与 worker（parseArgs 解析）各写一份 flag 字面量、无共享锚，
// 一侧改名另一侧的单测不红——本文件是跨侧契约测试，钉住两侧 flag 集合一致。
//
// worker 的 argv 解析写死在未导出且 c8-ignore 的 main() 里（无可导入的解析入口，
// 也不能真起 worker 进程），故 worker 侧只能"读源码"取真实 options 字面量；
// spawn 侧则真实执行 spawnUpgradeWorker、用 spawn 间谍捕获 argv。

/**
 * 从 worker.js 源码 main() 的 parseArgs options 块里抽出 option 名集合。
 * worker 的 option 一律 `name: { type: 'string' }`。
 * @returns {string[]}
 */
function extractWorkerOptionNames() {
	const src = readFileSync(nodePath.join(import.meta.dirname, 'worker.js'), 'utf8');
	const start = src.indexOf('options: {');
	assert.notEqual(start, -1, 'worker.js 应包含 parseArgs 的 options 块');
	// 大括号配平截出 options 对象主体，避免误抓块外内容
	let depth = 0;
	let end = -1;
	for (let i = src.indexOf('{', start); i < src.length; i++) {
		const ch = src[i];
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) { end = i; break; }
		}
	}
	assert.notEqual(end, -1, 'options 块大括号应配平');
	const block = src.slice(start, end + 1);
	const names = [...block.matchAll(/(\w+):\s*\{\s*type:\s*'string'/g)].map((m) => m[1]);
	assert.ok(names.length > 0, '应从 worker.js 抽到至少一个 option 名');
	return names;
}

test('updater-spawn 拼出的 argv flag 与 worker.js parseArgs options 严格一致', async () => {
	// 真实跑 spawnUpgradeWorker，注入 spawn 间谍捕获 argv（不真起进程）。
	// platform=darwin + scopeEnv={} 强制非 systemd 形态：spawnArgs 即裸 [workerPath, ...flags]。
	let capturedArgs = null;
	const fakeChild = { on() {}, unref() {}, pid: 4242 };
	const spawnFn = (_cmd, args) => { capturedArgs = args; return fakeChild; };

	const params = {
		pluginDir: '/tmp/plugin-dir',
		fromVersion: '1.0.0',
		toVersion: '1.2.3',
		baselineVersion: '0.9.0', // 传入 → spawn 会发出全部 6 个 flag
		pluginId: 'openclaw-coclaw',
		pkgName: '@coclaw/openclaw-coclaw',
		opts: { spawnFn, platform: 'darwin', scopeEnv: {} },
	};
	await spawnUpgradeWorker(params);
	assert.ok(capturedArgs, 'spawnFn 应被调用并捕获 argv');

	// 裸 spawn 形态：argv[0] 是 workerPath；worker 进程里的 process.argv.slice(2)
	// 等价于这里的 capturedArgs.slice(1)
	const workerArgv = capturedArgs.slice(1);

	// 用 worker.js 源码里真实的 option 名重建 strict 解析器（worker 全是 type:'string'）
	const workerNames = extractWorkerOptionNames();
	const options = Object.fromEntries(workerNames.map((n) => [n, { type: 'string' }]));

	// 核心契约：worker 的 strict parseArgs（同一 node:util 实现）必须能吃下 spawn 拼的 argv。
	// 任一侧改 flag 名 → 出现 unknown option → 抛错 → 本测试红。
	let values;
	assert.doesNotThrow(() => {
		({ values } = parseArgs({ args: workerArgv, options, strict: true }));
	}, 'worker 的 strict parseArgs 应接受 updater-spawn 拼出的全部 flag');

	// 正向：每个传入参数都被 worker 解出——防某侧悄悄丢 flag（strict 不报但值缺失）
	assert.equal(values.pluginDir, params.pluginDir);
	assert.equal(values.fromVersion, params.fromVersion);
	assert.equal(values.toVersion, params.toVersion);
	assert.equal(values.baselineVersion, params.baselineVersion);
	assert.equal(values.pluginId, params.pluginId);
	assert.equal(values.pkgName, params.pkgName);

	// 直接表达"两侧 flag 集合完全相等"：spawn 实发的 --flag 名 == worker 声明的 option 名
	const spawnFlags = workerArgv.filter((t) => t.startsWith('--')).map((t) => t.slice(2));
	assert.deepEqual([...spawnFlags].sort(), [...workerNames].sort(),
		'updater-spawn 实发 flag 集合应与 worker parseArgs options 集合完全一致');
});
