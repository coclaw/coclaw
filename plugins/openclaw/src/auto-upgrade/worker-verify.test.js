import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';

import {
	isVersionReached,
	triggerGatewayRestart,
	readDiskPackageVersion,
	pollUpgradeHealth,
	verifyUpgrade,
} from './worker-verify.js';

// --- isVersionReached（轮询成功判据与 L2 结局判据同构共用）---

test('isVersionReached - 版本相等达标（等号防"严格大于"回归）', () => {
	assert.equal(isVersionReached('1.1.0', '1.1.0'), true);
});

test('isVersionReached - 版本更新达标（dist-tag 前移）', () => {
	assert.equal(isVersionReached('1.1.1', '1.1.0'), true);
});

test('isVersionReached - 版本更老不达标', () => {
	assert.equal(isVersionReached('1.0.9', '1.1.0'), false);
});

test('isVersionReached - 同 x.y.z 的 pre-release 不达标，release 达标', () => {
	assert.equal(isVersionReached('1.1.0-beta.1', '1.1.0'), false);
	assert.equal(isVersionReached('1.1.0', '1.1.0-beta.1'), true);
});

// --- 辅助工具 ---

/**
 * 创建 mock execFileFn
 * @param {Function} handler - (cmd, args) => { stdout, stderr, err }
 */
function createExecFileFn(handler) {
	return (cmd, args, _opts, callback) => {
		const { stdout, stderr, err } = handler(cmd, args);
		callback(err ?? null, stdout ?? '', stderr ?? '');
	};
}

/** 快速 opts：短总超时 + 短轮询间隔，避免测试慢 */
function fastOpts(execFileFn, extra) {
	return { execFileFn, totalTimeoutMs: 200, pollIntervalMs: 20, ...extra };
}

/** 创建含 package.json 的临时目录 */
async function createTmpPluginDir(pkg) {
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'wv-test-'));
	if (pkg !== undefined) {
		await fs.writeFile(nodePath.join(dir, 'package.json'), pkg);
	}
	return dir;
}

async function cleanTmpDir(dir) {
	await fs.rm(dir, { recursive: true, force: true });
}

// ============================================================
// triggerGatewayRestart
// ============================================================

test('triggerGatewayRestart — 命令成功时返回 true', async () => {
	let called = false;
	const execFileFn = createExecFileFn((cmd, args) => {
		called = true;
		assert.equal(cmd, 'openclaw');
		assert.deepStrictEqual(args, ['gateway', 'restart']);
		return { stdout: 'ok' };
	});
	const ok = await triggerGatewayRestart({ execFileFn });
	assert.equal(called, true);
	assert.equal(ok, true);
});

test('triggerGatewayRestart — 命令失败时吞错不抛，返回 false', async () => {
	const execFileFn = createExecFileFn(() => ({ err: new Error('restart boom') }));
	// 未抛即为通过；返回 false 供回滚路径记 rollback-restart-failed 事件
	const ok = await triggerGatewayRestart({ execFileFn });
	assert.equal(ok, false);
});

// ============================================================
// readDiskPackageVersion
// ============================================================

test('readDiskPackageVersion — 读取合法 package.json 返回版本号', async () => {
	const dir = await createTmpPluginDir(JSON.stringify({ name: 'x', version: '1.2.3' }));
	try {
		const v = await readDiskPackageVersion(dir);
		assert.equal(v, '1.2.3');
	}
	finally {
		await cleanTmpDir(dir);
	}
});

test('readDiskPackageVersion — 目录不存在返回 null', async () => {
	const v = await readDiskPackageVersion('/nonexistent/path/definitely-not-there');
	assert.equal(v, null);
});

test('readDiskPackageVersion — JSON 非法返回 null', async () => {
	const dir = await createTmpPluginDir('not-json-at-all');
	try {
		const v = await readDiskPackageVersion(dir);
		assert.equal(v, null);
	}
	finally {
		await cleanTmpDir(dir);
	}
});

test('readDiskPackageVersion — version 非字符串返回 null', async () => {
	const dir = await createTmpPluginDir(JSON.stringify({ name: 'x', version: 123 }));
	try {
		const v = await readDiskPackageVersion(dir);
		assert.equal(v, null);
	}
	finally {
		await cleanTmpDir(dir);
	}
});

test('readDiskPackageVersion — package.json 缺 version 字段返回 null', async () => {
	const dir = await createTmpPluginDir(JSON.stringify({ name: 'x' }));
	try {
		const v = await readDiskPackageVersion(dir);
		assert.equal(v, null);
	}
	finally {
		await cleanTmpDir(dir);
	}
});

test('readDiskPackageVersion — package.json 内容为 JSON null 时返回 null', async () => {
	// JSON.parse('null') 返回 null；pkg?.version 走 optional chaining 短路
	const dir = await createTmpPluginDir('null');
	try {
		const v = await readDiskPackageVersion(dir);
		assert.equal(v, null);
	}
	finally {
		await cleanTmpDir(dir);
	}
});

// ============================================================
// pollUpgradeHealth
// ============================================================

test('pollUpgradeHealth — 首次调用即命中目标版本', async () => {
	let calls = 0;
	const execFileFn = createExecFileFn(() => {
		calls += 1;
		return { stdout: JSON.stringify({ version: '1.1.0' }) };
	});
	const result = await pollUpgradeHealth('1.1.0', fastOpts(execFileFn));
	assert.equal(result.ok, true);
	assert.equal(result.version, '1.1.0');
	assert.equal(result.attempts, 1);
	assert.equal(calls, 1);
	assert.equal(typeof result.elapsedMs, 'number');
});

test('pollUpgradeHealth — 前两次失败后第三次成功', async () => {
	let calls = 0;
	const execFileFn = createExecFileFn(() => {
		calls += 1;
		if (calls < 3) return { err: new Error('ECONNREFUSED'), stderr: '1006 closed' };
		return { stdout: JSON.stringify({ version: '2.0.0' }) };
	});
	const result = await pollUpgradeHealth('2.0.0', fastOpts(execFileFn, { totalTimeoutMs: 1000 }));
	assert.equal(result.ok, true);
	assert.equal(result.attempts, 3);
});

test('pollUpgradeHealth — 持续返回旧版本直到超时', async () => {
	const execFileFn = createExecFileFn(() => ({ stdout: JSON.stringify({ version: '0.9.0' }) }));
	const result = await pollUpgradeHealth('1.0.0', fastOpts(execFileFn));
	assert.equal(result.ok, false);
	assert.ok(result.attempts >= 1);
	assert.equal(result.lastVersion, '0.9.0');
	assert.match(result.lastReason, /version-too-old got=0\.9\.0 want>=1\.0\.0/);
});

test('pollUpgradeHealth — 观察到比 toVersion 更新的版本时视为成功', async () => {
	// 场景：scheduler 观察到 latest=1.0.0 并发起升级，执行时 npm 已前移到 1.0.1
	const execFileFn = createExecFileFn(() => ({ stdout: JSON.stringify({ version: '1.0.1' }) }));
	const result = await pollUpgradeHealth('1.0.0', fastOpts(execFileFn));
	assert.equal(result.ok, true);
	assert.equal(result.version, '1.0.1');
	assert.equal(result.attempts, 1);
});

test('pollUpgradeHealth — pre-release 版本判定遵循 semver（release > prerelease）', async () => {
	// 期望 1.0.0-rc.1，实际装上 1.0.0（release 比 pre-release 新），应视为成功
	const execFileFn = createExecFileFn(() => ({ stdout: JSON.stringify({ version: '1.0.0' }) }));
	const result = await pollUpgradeHealth('1.0.0-rc.1', fastOpts(execFileFn));
	assert.equal(result.ok, true);
	assert.equal(result.version, '1.0.0');
});

test('pollUpgradeHealth — 实际版本为 prerelease 而目标为 release 时视为过旧', async () => {
	// 期望 1.0.0，实际 1.0.0-rc.1（pre-release 旧于 release），不应视为成功
	const execFileFn = createExecFileFn(() => ({ stdout: JSON.stringify({ version: '1.0.0-rc.1' }) }));
	const result = await pollUpgradeHealth('1.0.0', fastOpts(execFileFn));
	assert.equal(result.ok, false);
	assert.equal(result.lastVersion, '1.0.0-rc.1');
	assert.match(result.lastReason, /version-too-old got=1\.0\.0-rc\.1 want>=1\.0\.0/);
});

test('pollUpgradeHealth — x.y.z 相同的两个 pre-release 之间视为过旧（冻结保守判定）', async () => {
	// 目标 1.0.0-rc.1，实际 1.0.0-rc.2：当前 isNewerVersion 对"同 x.y.z + 都是 pre-release"
	// 不做 pre-release 内部 tag 排序，一律返回 false（保守策略，宁可多轮询不误判）。
	// 本测试冻结该行为，防止后续若有人把判定改成 semver 严格比较而破坏 rc 链路上的保守性
	const execFileFn = createExecFileFn(() => ({ stdout: JSON.stringify({ version: '1.0.0-rc.2' }) }));
	const result = await pollUpgradeHealth('1.0.0-rc.1', fastOpts(execFileFn));
	assert.equal(result.ok, false);
	assert.match(result.lastReason, /version-too-old got=1\.0\.0-rc\.2 want>=1\.0\.0-rc\.1/);
});

test('pollUpgradeHealth — 响应 JSON 非法记录 invalid-json reason', async () => {
	const execFileFn = createExecFileFn(() => ({ stdout: 'not-json-output' }));
	const result = await pollUpgradeHealth('1.0.0', fastOpts(execFileFn));
	assert.equal(result.ok, false);
	assert.match(result.lastReason, /^invalid-json: not-json-output/);
});

test('pollUpgradeHealth — 响应缺少 version 字段记录 missing-version', async () => {
	const execFileFn = createExecFileFn(() => ({ stdout: JSON.stringify({ status: 'ok' }) }));
	const result = await pollUpgradeHealth('1.0.0', fastOpts(execFileFn));
	assert.equal(result.ok, false);
	assert.equal(result.lastReason, 'missing-version');
});

test('pollUpgradeHealth — exec 错误的 stderr 被纳入 reason', async () => {
	const execFileFn = createExecFileFn(() => ({
		err: new Error('spawn failed'),
		stderr: '  INVALID_REQUEST: unknown method: coclaw.upgradeHealth  ',
	}));
	const result = await pollUpgradeHealth('1.0.0', fastOpts(execFileFn));
	assert.equal(result.ok, false);
	assert.match(result.lastReason, /INVALID_REQUEST: unknown method: coclaw\.upgradeHealth/);
});

test('pollUpgradeHealth — exec 错误无 stderr 时用 message', async () => {
	const execFileFn = createExecFileFn(() => ({ err: new Error('gateway closed 1006') }));
	const result = await pollUpgradeHealth('1.0.0', fastOpts(execFileFn));
	assert.equal(result.ok, false);
	assert.match(result.lastReason, /gateway closed 1006/);
});

test('pollUpgradeHealth — reason 截断到 200 字', async () => {
	const longStderr = 'x'.repeat(500);
	const execFileFn = createExecFileFn(() => ({ err: new Error('boom'), stderr: longStderr }));
	const result = await pollUpgradeHealth('1.0.0', fastOpts(execFileFn));
	assert.equal(result.ok, false);
	// 冻结精确长度，防止截断参数被悄悄改小
	assert.equal(result.lastReason.length, 200);
});

test('pollUpgradeHealth — invalid-json reason 截断 output 到 120 字', async () => {
	const longOutput = 'a'.repeat(500);
	const execFileFn = createExecFileFn(() => ({ stdout: longOutput }));
	const result = await pollUpgradeHealth('1.0.0', fastOpts(execFileFn));
	assert.equal(result.ok, false);
	// "invalid-json: " (14) + 120 = 134
	assert.ok(result.lastReason.length <= 14 + 120);
});

test('pollUpgradeHealth — 版本不匹配后恢复为匹配', async () => {
	let calls = 0;
	const execFileFn = createExecFileFn(() => {
		calls += 1;
		if (calls === 1) return { stdout: JSON.stringify({ version: '0.9.0' }) };
		return { stdout: JSON.stringify({ version: '1.0.0' }) };
	});
	const result = await pollUpgradeHealth('1.0.0', fastOpts(execFileFn, { totalTimeoutMs: 500 }));
	assert.equal(result.ok, true);
	assert.equal(result.attempts, 2);
});

test('pollUpgradeHealth — 墙钟跳变不影响超时判定（使用单调时钟）', async () => {
	// 回归测试：早期实现用 Date.now() 算 elapsed，墙钟在 NTP 同步 / WSL2 host
	// resume 时偶发跳前数百毫秒，会让 break 提前触发，attempts=1 即退出失败。
	// 此用例把 Date.now 临时改为"第 3 次调用跳前 480ms"，模拟该场景；
	// 修复后函数走单调时钟，跳变不会影响其判定，仍能正常进入 iter 2 命中目标版本。
	const realNow = Date.now;
	let nCalls = 0;
	Date.now = () => {
		nCalls += 1;
		const t = realNow.call(Date);
		// 第 3 次调用恰好对应 iter 1 末尾的"剩余预算"判断
		if (nCalls === 3) return t + 480;
		return t;
	};
	let calls = 0;
	const execFileFn = createExecFileFn(() => {
		calls += 1;
		if (calls === 1) return { stdout: JSON.stringify({ version: '0.9.0' }) };
		return { stdout: JSON.stringify({ version: '1.0.0' }) };
	});
	try {
		const result = await pollUpgradeHealth('1.0.0', { execFileFn, totalTimeoutMs: 500, pollIntervalMs: 20 });
		assert.equal(result.ok, true);
		assert.equal(result.attempts, 2);
	}
	finally {
		Date.now = realNow;
	}
});

test('pollUpgradeHealth — pollIntervalMs >= totalTimeoutMs 时仅探测一次', async () => {
	let calls = 0;
	const execFileFn = createExecFileFn(() => {
		calls += 1;
		return { stdout: JSON.stringify({ version: '0.9.0' }) };
	});
	const result = await pollUpgradeHealth('1.0.0', {
		execFileFn,
		totalTimeoutMs: 50,
		pollIntervalMs: 200,
	});
	assert.equal(result.ok, false);
	assert.equal(result.attempts, 1);
	assert.equal(calls, 1);
	// 无 sleep 等待：elapsed 应远小于 pollIntervalMs
	assert.ok(result.elapsedMs < 100);
});

test('pollUpgradeHealth — version 为数字时 String() 归一化', async () => {
	const execFileFn = createExecFileFn(() => ({ stdout: JSON.stringify({ version: 2 }) }));
	const result = await pollUpgradeHealth('2', fastOpts(execFileFn));
	assert.equal(result.ok, true);
	assert.equal(result.version, '2');
});

test('pollUpgradeHealth — payload 为 null 时归类为 missing-version', async () => {
	const execFileFn = createExecFileFn(() => ({ stdout: 'null' }));
	const result = await pollUpgradeHealth('1.0.0', fastOpts(execFileFn));
	assert.equal(result.ok, false);
	assert.equal(result.lastReason, 'missing-version');
});

test('pollUpgradeHealth — err 无 message 时 reason 仍可字符串化', async () => {
	const execFileFn = createExecFileFn(() => {
		const err = new Error();
		err.message = undefined;
		return { err };
	});
	const result = await pollUpgradeHealth('1.0.0', fastOpts(execFileFn));
	assert.equal(result.ok, false);
	assert.equal(typeof result.lastReason, 'string');
});

// ============================================================
// verifyUpgrade（集成）
// ============================================================

test('verifyUpgrade — 全流程成功：触发 restart → 读磁盘 → 轮询 RPC 命中', async () => {
	const dir = await createTmpPluginDir(JSON.stringify({ name: 'x', version: '1.1.0' }));
	try {
		const logs = [];
		const log = (msg) => logs.push(msg);
		const execFileFn = createExecFileFn((_cmd, args) => {
			if (args.includes('restart')) return { stdout: 'ok' };
			if (args.includes('call')) return { stdout: JSON.stringify({ version: '1.1.0' }) };
			/* c8 ignore next -- 测试中不会触达 */
			return { stdout: '' };
		});
		const result = await verifyUpgrade(dir, '1.1.0', fastOpts(execFileFn), log);
		assert.equal(result.ok, true);
		assert.equal(result.version, '1.1.0');
		assert.ok(logs.some(l => l.includes('On-disk package.json version: 1.1.0')));
		assert.ok(logs.some(l => l.includes('upgradeHealth verified: version=1.1.0')));
		assert.ok(logs.some(l => l.includes('attempts=1')));
	}
	finally {
		await cleanTmpDir(dir);
	}
});

test('verifyUpgrade — 磁盘读不到版本时日志标为 unreadable 但不影响流程', async () => {
	const dir = await createTmpPluginDir();
	try {
		const logs = [];
		const log = (msg) => logs.push(msg);
		const execFileFn = createExecFileFn((_cmd, args) => {
			if (args.includes('restart')) return { stdout: 'ok' };
			if (args.includes('call')) return { stdout: JSON.stringify({ version: '0.5.0' }) };
			/* c8 ignore next -- 测试中不会触达 */
			return { stdout: '' };
		});
		const result = await verifyUpgrade(dir, '0.5.0', fastOpts(execFileFn), log);
		assert.equal(result.ok, true);
		assert.ok(logs.some(l => l.includes('On-disk package.json version: (unreadable)')));
	}
	finally {
		await cleanTmpDir(dir);
	}
});

test('verifyUpgrade — 超时失败时返回含 attempts/elapsed/lastReason 的 error 字符串', async () => {
	const dir = await createTmpPluginDir(JSON.stringify({ name: 'x', version: '0.9.0' }));
	try {
		const logs = [];
		const log = (msg) => logs.push(msg);
		const execFileFn = createExecFileFn((_cmd, args) => {
			if (args.includes('restart')) return { stdout: 'ok' };
			if (args.includes('call')) return { stdout: JSON.stringify({ version: '0.9.0' }) };
			/* c8 ignore next -- 测试中不会触达 */
			return { stdout: '' };
		});
		const result = await verifyUpgrade(dir, '1.0.0', fastOpts(execFileFn), log);
		assert.equal(result.ok, false);
		assert.match(result.error, /verify timeout: attempts=\d+ elapsed=\d+ms/);
		assert.match(result.error, /lastVersion=0\.9\.0/);
		assert.match(result.error, /version-too-old got=0\.9\.0 want>=1\.0\.0/);
		// 日志也应包含相同错误
		assert.ok(logs.some(l => l.includes('verify timeout')));
	}
	finally {
		await cleanTmpDir(dir);
	}
});

test('verifyUpgrade — gateway restart 失败也能继续进入轮询', async () => {
	const dir = await createTmpPluginDir(JSON.stringify({ name: 'x', version: '2.0.0' }));
	try {
		const execFileFn = createExecFileFn((_cmd, args) => {
			if (args.includes('restart')) return { err: new Error('restart boom') };
			if (args.includes('call')) return { stdout: JSON.stringify({ version: '2.0.0' }) };
			/* c8 ignore next -- 测试中不会触达 */
			return { stdout: '' };
		});
		const result = await verifyUpgrade(dir, '2.0.0', fastOpts(execFileFn), () => {});
		assert.equal(result.ok, true);
	}
	finally {
		await cleanTmpDir(dir);
	}
});

test('verifyUpgrade — 未传 log 时不抛异常', async () => {
	const dir = await createTmpPluginDir(JSON.stringify({ name: 'x', version: '1.0.0' }));
	try {
		const execFileFn = createExecFileFn((_cmd, args) => {
			if (args.includes('restart')) return { stdout: 'ok' };
			if (args.includes('call')) return { stdout: JSON.stringify({ version: '1.0.0' }) };
			/* c8 ignore next -- 测试中不会触达 */
			return { stdout: '' };
		});
		const result = await verifyUpgrade(dir, '1.0.0', fastOpts(execFileFn));
		assert.equal(result.ok, true);
	}
	finally {
		await cleanTmpDir(dir);
	}
});

test('verifyUpgrade — lastVersion/lastReason 为空时 error 字符串显示 (none)', async () => {
	const dir = await createTmpPluginDir(JSON.stringify({ name: 'x', version: '1.0.0' }));
	try {
		// totalTimeoutMs=0 导致 while 循环一次都不进入，attempts=0
		const execFileFn = createExecFileFn((_cmd, args) => {
			if (args.includes('restart')) return { stdout: 'ok' };
			/* c8 ignore next -- 不应到达：totalTimeoutMs=0 下 while 不会进入 */
			return { stdout: '' };
		});
		const result = await verifyUpgrade(dir, '1.0.0', { execFileFn, totalTimeoutMs: 0, pollIntervalMs: 20 }, () => {});
		assert.equal(result.ok, false);
		assert.match(result.error, /lastVersion=\(none\)/);
		assert.match(result.error, /lastReason=\(none\)/);
	}
	finally {
		await cleanTmpDir(dir);
	}
});
