/**
 * Auto-upgrade verify 集成冒烟测试
 *
 * 目的：在真实的 openclaw gateway + 已加载的 openclaw-coclaw 插件环境下，
 * 验证本次改动的核心假设：
 *   1. `openclaw gateway call coclaw.upgradeHealth --json` 命令可用、退出码 0
 *   2. stdout 是合法 JSON，且包含 `version` 字段为字符串
 *   3. version 等于 plugin 当前 package.json 里的 version
 *   4. `callUpgradeHealthOnce`（产品代码内部函数）能正确解析真实响应
 *   5. `pollUpgradeHealth` 正面路径（toVersion === 当前版本）立即返回 ok
 *   6. `pollUpgradeHealth` 负面路径（toVersion 不匹配）按预期 timeout 并给出
 *      version-mismatch 诊断
 *   7. `verifyUpgrade` 端到端链路（不触发 gateway restart）能串起来
 *   8. 旧 bug 现场：`openclaw plugins list` stdout 是否把 `openclaw-coclaw`
 *      折行——验证之前 `.includes('openclaw-coclaw')` 为何脆弱
 *
 * 本脚本**不触发** `openclaw gateway restart`，避免打断用户当前工作；
 * 如需手动验证 restart + poll 的联动，参考 verifyUpgrade 的用法自行改造。
 *
 * 运行：
 *   cd plugins/openclaw
 *   node src/auto-upgrade/integration-test.mjs
 *
 * 前置条件：
 *   - 本机 openclaw gateway 正在运行
 *   - openclaw-coclaw 插件已 `--link` 或从 npm 安装，状态 loaded
 *   - `openclaw` CLI 在 PATH 中
 *
 * 本脚本不进入 `pnpm test` 集合（test 脚本只匹配 *.test.js）。
 */
import { execFile, execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	pollUpgradeHealth,
	readDiskPackageVersion,
	verifyUpgrade,
} from './worker-verify.js';

const PLUGIN_DIR = nodePath.resolve(
	nodePath.dirname(fileURLToPath(import.meta.url)),
	'../..',
);

let passed = 0;
let failed = 0;

function ok(name, extra) {
	passed++;
	const suffix = extra ? ` — ${extra}` : '';
	console.log(`  \x1b[32m✓\x1b[0m ${name}${suffix}`);
}

function fail(name, reason) {
	failed++;
	console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${reason}`);
}

function section(title) {
	console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// --- helpers ---

/** 读本地 plugin package.json（不依赖产品代码，作为独立 ground truth） */
async function readPackageVersionGroundTruth() {
	const raw = await readFile(nodePath.join(PLUGIN_DIR, 'package.json'), 'utf8');
	return JSON.parse(raw).version;
}

/** 直接 shell 执行 openclaw CLI，拿 stdout + exit code */
function runCli(args, timeoutMs = 20_000) {
	try {
		const stdout = execSync(`openclaw ${args}`, {
			timeout: timeoutMs,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { ok: true, stdout };
	} catch (err) {
		return { ok: false, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '', code: err.status };
	}
}

// --- 测试开始 ---

async function main() {
	console.log(`Plugin dir: ${PLUGIN_DIR}`);
	const groundTruthVersion = await readPackageVersionGroundTruth();
	console.log(`package.json version (ground truth): ${groundTruthVersion}\n`);

	// ======================================================
	section('1. CLI 契约');
	// ======================================================

	const cliResult = runCli('gateway call coclaw.upgradeHealth --json');
	if (!cliResult.ok) {
		fail('openclaw gateway call coclaw.upgradeHealth --json exit=0',
			`exit=${cliResult.code} stderr=${cliResult.stderr?.slice(0, 200)}`);
		summary();
		return;
	}
	ok('openclaw gateway call coclaw.upgradeHealth --json exit=0');

	let payload;
	try {
		payload = JSON.parse(cliResult.stdout);
		ok('stdout 是合法 JSON');
	} catch (e) {
		fail('stdout 是合法 JSON', `parse 失败: ${e.message}, stdout=${cliResult.stdout.slice(0, 200)}`);
		summary();
		return;
	}

	if (typeof payload.version === 'string' && payload.version.length > 0) {
		ok('payload.version 是非空字符串', `version=${payload.version}`);
	} else {
		fail('payload.version 是非空字符串', `实际: ${JSON.stringify(payload)}`);
	}

	if (payload.version === groundTruthVersion) {
		ok('RPC 返回版本号 === package.json 版本号');
	} else {
		fail('RPC 返回版本号 === package.json 版本号',
			`RPC=${payload.version} package.json=${groundTruthVersion}`);
	}

	// ======================================================
	section('2. readDiskPackageVersion');
	// ======================================================

	const diskVersion = await readDiskPackageVersion(PLUGIN_DIR);
	if (diskVersion === groundTruthVersion) {
		ok('读到磁盘 version', `value=${diskVersion}`);
	} else {
		fail('读到磁盘 version', `got=${diskVersion} expected=${groundTruthVersion}`);
	}

	const nullVersion = await readDiskPackageVersion('/nonexistent/dir/path');
	if (nullVersion === null) {
		ok('不存在目录返回 null');
	} else {
		fail('不存在目录返回 null', `got=${nullVersion}`);
	}

	// ======================================================
	section('3. pollUpgradeHealth 正面路径（秒回 ok）');
	// ======================================================

	const positiveStart = Date.now();
	const positiveResult = await pollUpgradeHealth(groundTruthVersion, {
		totalTimeoutMs: 30_000,
		pollIntervalMs: 3_000,
	});
	const positiveElapsed = Date.now() - positiveStart;

	if (positiveResult.ok && positiveResult.version === groundTruthVersion) {
		ok('正面路径 ok=true version 匹配', `attempts=${positiveResult.attempts} elapsed=${positiveResult.elapsedMs}ms wall=${positiveElapsed}ms`);
	} else {
		fail('正面路径 ok=true version 匹配', JSON.stringify(positiveResult));
	}

	if (positiveResult.attempts === 1) {
		ok('正面路径仅 1 次 RPC 调用');
	} else {
		fail('正面路径仅 1 次 RPC 调用', `attempts=${positiveResult.attempts}`);
	}

	// ======================================================
	section('4. pollUpgradeHealth 负面路径（版本不匹配 → timeout）');
	// ======================================================

	const BOGUS_VERSION = '99999.0.0-smoke-test';
	const negativeStart = Date.now();
	// 短窗口 + 短间隔，预期 1~2 次调用后 timeout
	const negativeResult = await pollUpgradeHealth(BOGUS_VERSION, {
		totalTimeoutMs: 3_000,
		pollIntervalMs: 1_000,
	});
	const negativeElapsed = Date.now() - negativeStart;

	if (!negativeResult.ok) {
		ok('负面路径 ok=false', `attempts=${negativeResult.attempts} elapsed=${negativeResult.elapsedMs}ms wall=${negativeElapsed}ms`);
	} else {
		fail('负面路径 ok=false', JSON.stringify(negativeResult));
	}

	if (negativeResult.lastReason?.includes(`version-mismatch got=${groundTruthVersion} want=${BOGUS_VERSION}`)) {
		ok('负面路径 lastReason 指明 version-mismatch');
	} else {
		fail('负面路径 lastReason 指明 version-mismatch', `got=${negativeResult.lastReason}`);
	}

	if (negativeResult.lastVersion === groundTruthVersion) {
		ok('负面路径 lastVersion 为实际 RPC 返回值');
	} else {
		fail('负面路径 lastVersion 为实际 RPC 返回值', `got=${negativeResult.lastVersion}`);
	}

	// ======================================================
	section('5. verifyUpgrade 端到端（不触发 gateway restart 的路径）');
	// ======================================================
	// verifyUpgrade 内部会调 triggerGatewayRestart。我们不想真的 restart gateway，
	// 所以构造一个 execFileFn，拦截 gateway restart 命令，其他命令透传给真实 openclaw。
	// 这样 readDiskPackageVersion + pollUpgradeHealth 都走真实路径。

	let restartIntercepted = false;
	const interceptingExecFileFn = (cmd, args, opts, cb) => {
		const argsStr = args.join(' ');
		if (argsStr === 'gateway restart') {
			restartIntercepted = true;
			// 模拟成功，不真的重启
			cb(null, 'intercepted\n', '');
			return;
		}
		// 其他命令用真实 execFile
		execFile(cmd, args, opts, cb);
	};

	const logs = [];
	const result = await verifyUpgrade(
		PLUGIN_DIR,
		groundTruthVersion,
		{ execFileFn: interceptingExecFileFn, totalTimeoutMs: 15_000, pollIntervalMs: 2_000 },
		(msg) => logs.push(msg),
	);

	if (restartIntercepted) {
		ok('verifyUpgrade 调用了 triggerGatewayRestart（被拦截）');
	} else {
		fail('verifyUpgrade 调用了 triggerGatewayRestart', '未观测到 restart 命令');
	}

	if (result.ok && result.version === groundTruthVersion) {
		ok('verifyUpgrade 返回 ok=true 版本匹配');
	} else {
		fail('verifyUpgrade 返回 ok=true 版本匹配', JSON.stringify(result));
	}

	const diskLog = logs.find(l => l.includes('On-disk package.json version:'));
	if (diskLog?.includes(groundTruthVersion)) {
		ok('verifyUpgrade 日志含 on-disk version');
	} else {
		fail('verifyUpgrade 日志含 on-disk version', `logs=${JSON.stringify(logs)}`);
	}

	const verifiedLog = logs.find(l => l.includes('upgradeHealth verified:'));
	if (verifiedLog?.includes(`version=${groundTruthVersion}`)) {
		ok('verifyUpgrade 日志含 verified 标记');
	} else {
		fail('verifyUpgrade 日志含 verified 标记', `logs=${JSON.stringify(logs)}`);
	}

	// ======================================================
	section('6. 旧 bug 现场：plugins list stdout 是否稳定含 "openclaw-coclaw"');
	// ======================================================

	const listResult = runCli('plugins list');
	if (!listResult.ok) {
		fail('openclaw plugins list exit=0', `code=${listResult.code}`);
	} else {
		const fullIdPresent = listResult.stdout.includes('openclaw-coclaw');
		if (fullIdPresent) {
			ok('plugins list stdout 连续包含 "openclaw-coclaw"', '（旧 verify 在此宽度下会通过）');
		} else {
			// 检查是否因折行被打断
			const hasOpenclaw = listResult.stdout.includes('openclaw');
			const hasCoclawFragment = /\bcoclaw\b/.test(listResult.stdout);
			console.log(`  \x1b[33m⚠\x1b[0m plugins list stdout 未连续包含 "openclaw-coclaw"`);
			console.log(`      hasOpenclaw=${hasOpenclaw} hasCoclawFragment=${hasCoclawFragment}`);
			console.log(`      \x1b[33m这正是旧 verifyPluginLoaded 脆弱的现场：表格把长 ID 折行，.includes miss。\x1b[0m`);
			console.log(`      新代码不再依赖此判据，已绕开该陷阱。`);
			// 这不是测试失败，是一个 informative 的观察，所以算 passed
			passed++;
			console.log(`  \x1b[32m✓\x1b[0m 已记录折行现场（新代码不受影响）`);
		}
	}

	summary();
}

function summary() {
	console.log(`\n\x1b[1m结果\x1b[0m: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error('\n\x1b[31mFATAL\x1b[0m:', err);
	process.exit(2);
});
