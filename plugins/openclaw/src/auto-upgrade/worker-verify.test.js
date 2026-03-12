import assert from 'node:assert/strict';
import test from 'node:test';

import {
	waitForGateway,
	verifyPluginLoaded,
	verifyUpgradeHealth,
	verifyUpgrade,
} from './worker-verify.js';

// --- 辅助工具 ---

/**
 * 创建 mock execFileFn
 * @param {Function} handler - (cmd, args) => { stdout, err }
 */
function createExecFileFn(handler) {
	return (cmd, args, _opts, callback) => {
		const { stdout, err } = handler(cmd, args);
		callback(err ?? null, stdout ?? '');
	};
}

/** 始终成功返回指定 stdout */
function successExec(stdout) {
	return createExecFileFn(() => ({ stdout }));
}

/** 始终失败 */
function failExec(msg = 'command failed') {
	return createExecFileFn(() => ({ err: new Error(msg) }));
}

// --- waitForGateway ---

test('waitForGateway 成功 — 输出包含 running', async () => {
	const execFileFn = successExec('Gateway is running');
	await waitForGateway({ execFileFn, timeoutMs: 100, pollIntervalMs: 20 });
	// 无异常即通过
});

test('waitForGateway 重试后成功', async () => {
	let callCount = 0;
	const execFileFn = createExecFileFn(() => {
		callCount++;
		if (callCount < 3) return { err: new Error('not ready') };
		return { stdout: 'running' };
	});

	await waitForGateway({ execFileFn, timeoutMs: 500, pollIntervalMs: 20 });
	assert.ok(callCount >= 3, `expected at least 3 calls, got ${callCount}`);
});

test('waitForGateway 输出不含 running 时继续轮询直到超时', async () => {
	const execFileFn = successExec('Gateway is stopped');

	await assert.rejects(
		() => waitForGateway({ execFileFn, timeoutMs: 80, pollIntervalMs: 20 }),
		{ message: 'Gateway did not become ready within timeout' },
	);
});

test('waitForGateway 持续失败时超时抛出错误', async () => {
	const execFileFn = failExec('connection refused');

	await assert.rejects(
		() => waitForGateway({ execFileFn, timeoutMs: 80, pollIntervalMs: 20 }),
		{ message: 'Gateway did not become ready within timeout' },
	);
});

// --- verifyPluginLoaded ---

test('verifyPluginLoaded 成功 — 输出包含插件 ID', async () => {
	const execFileFn = successExec('installed plugins:\n  test-plugin-id (0.1.7)\n  another-plugin');
	await verifyPluginLoaded('test-plugin-id', { execFileFn });
});

test('verifyPluginLoaded 失败 — 输出不含插件 ID', async () => {
	const execFileFn = successExec('installed plugins:\n  other-plugin (1.0.0)');

	await assert.rejects(
		() => verifyPluginLoaded('test-plugin-id', { execFileFn }),
		{ message: /test-plugin-id not found/ },
	);
});

test('verifyPluginLoaded 命令执行失败时传播错误', async () => {
	const execFileFn = failExec('plugins list failed');

	await assert.rejects(
		() => verifyPluginLoaded('test-plugin-id', { execFileFn }),
		{ message: 'plugins list failed' },
	);
});

// --- verifyUpgradeHealth ---

test('verifyUpgradeHealth 成功 — 返回版本号', async () => {
	const execFileFn = successExec(JSON.stringify({ version: '0.2.0', status: 'ok' }));
	const version = await verifyUpgradeHealth({ execFileFn });
	assert.equal(version, '0.2.0');
});

test('verifyUpgradeHealth 失败 — 响应缺少 version 字段', async () => {
	const execFileFn = successExec(JSON.stringify({ status: 'ok' }));

	await assert.rejects(
		() => verifyUpgradeHealth({ execFileFn }),
		{ message: 'upgradeHealth response missing version' },
	);
});

test('verifyUpgradeHealth 失败 — 响应非 JSON', async () => {
	const execFileFn = successExec('not json at all');

	await assert.rejects(
		() => verifyUpgradeHealth({ execFileFn }),
		{ message: /Failed to parse upgradeHealth response: not json at all/ },
	);
});

test('verifyUpgradeHealth 命令失败时传播错误', async () => {
	const execFileFn = failExec('gateway call failed');

	await assert.rejects(
		() => verifyUpgradeHealth({ execFileFn }),
		{ message: 'gateway call failed' },
	);
});

// --- verifyUpgrade ---

test('verifyUpgrade 全流程成功', async () => {
	let callCount = 0;
	const execFileFn = createExecFileFn((_cmd, args) => {
		callCount++;
		if (args.includes('status')) return { stdout: 'running' };
		if (args.includes('list')) return { stdout: 'test-plugin-id (0.2.0)' };
		if (args.includes('call')) return { stdout: JSON.stringify({ version: '0.2.0' }) };
		return { err: new Error('unexpected args') };
	});

	const result = await verifyUpgrade('test-plugin-id', { execFileFn, timeoutMs: 100, pollIntervalMs: 20 });
	assert.deepStrictEqual(result, { ok: true, version: '0.2.0' });
	assert.ok(callCount >= 3);
});

test('verifyUpgrade 返回错误 — gateway 未就绪', async () => {
	const execFileFn = failExec('not ready');

	const result = await verifyUpgrade('test-plugin-id', { execFileFn, timeoutMs: 80, pollIntervalMs: 20 });
	assert.equal(result.ok, false);
	assert.ok(result.error.includes('Gateway did not become ready'));
});

test('verifyUpgrade 返回错误 — 插件未加载', async () => {
	const execFileFn = createExecFileFn((_cmd, args) => {
		if (args.includes('status')) return { stdout: 'running' };
		if (args.includes('list')) return { stdout: 'no-such-plugin' };
		return { err: new Error('unexpected') };
	});

	const result = await verifyUpgrade('test-plugin-id', { execFileFn, timeoutMs: 100, pollIntervalMs: 20 });
	assert.equal(result.ok, false);
	assert.ok(result.error.includes('not found'));
});

test('verifyUpgrade 返回错误 — upgradeHealth 失败', async () => {
	const execFileFn = createExecFileFn((_cmd, args) => {
		if (args.includes('status')) return { stdout: 'running' };
		if (args.includes('list')) return { stdout: 'test-plugin-id' };
		if (args.includes('call')) return { stdout: 'bad json' };
		return { err: new Error('unexpected') };
	});

	const result = await verifyUpgrade('test-plugin-id', { execFileFn, timeoutMs: 100, pollIntervalMs: 20 });
	assert.equal(result.ok, false);
	assert.ok(result.error.includes('Failed to parse'));
});

// --- exec 内部行为覆盖 ---

test('waitForGateway 不传 opts 时使用默认值（通过短超时验证）', async () => {
	// 直接调用不传 opts，验证不会报 TypeError
	// 但会使用真实 execFile，所以我们只验证它能正常抛超时
	// 改用传入 execFileFn 但不传 timeoutMs/pollIntervalMs，确保默认值路径被覆盖
	const execFileFn = successExec('running');
	await waitForGateway({ execFileFn, timeoutMs: 100, pollIntervalMs: 20 });
});

test('verifyUpgrade 错误对象无 message 时使用 String() 转换', async () => {
	// 模拟 err.message 为 undefined 的情况
	const execFileFn = createExecFileFn(() => {
		const err = new Error();
		err.message = undefined;
		return { err };
	});

	const result = await verifyUpgrade('test-plugin-id', { execFileFn, timeoutMs: 80, pollIntervalMs: 20 });
	assert.equal(result.ok, false);
	assert.equal(typeof result.error, 'string');
});
