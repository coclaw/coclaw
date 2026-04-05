import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { callGatewayMethod, escapeJsonForCmd } from './gateway-notify.js';

/**
 * 创建 mock spawn 函数
 * @param {object} [opts]
 * @param {string} [opts.stdout] - 模拟的 stdout 输出
 * @param {number} [opts.exitCode] - 模拟的退出码
 * @param {boolean} [opts.emitError] - 是否触发 error 事件
 * @param {boolean} [opts.noEvents] - 不触发任何事件（模拟超时场景）
 * @param {boolean} [opts.delayClose] - 延迟 close 事件（模拟进程不退出场景）
 * @returns {{ spawn: Function, calls: string[][] }}
 */
function createMockSpawn(opts = {}) {
	const calls = [];
	const spawn = (cmd, args) => {
		calls.push([cmd, ...args]);
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};

		if (opts.noEvents) return child;

		process.nextTick(() => {
			if (opts.emitError) {
				child.emit('error', new Error('mock spawn error'));
				return;
			}
			if (opts.stdout != null) {
				child.stdout.emit('data', opts.stdout);
			}
			if (!opts.delayClose) {
				child.emit('close', opts.exitCode ?? 0);
			}
		});
		return child;
	};
	return { spawn, calls };
}

test('callGatewayMethod should pass shell:false on non-Windows', async () => {
	let capturedOpts;
	const spawn = (cmd, args, opts) => {
		capturedOpts = opts;
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		process.nextTick(() => {
			child.stdout.emit('data', '{"status":"ok"}');
			child.emit('close', 0);
		});
		return child;
	};

	await callGatewayMethod('coclaw.bind', spawn, { isWin: false });
	assert.equal(capturedOpts.shell, false);
});

test('callGatewayMethod should pass shell:true on Windows', async () => {
	let capturedOpts;
	const spawn = (cmd, args, opts) => {
		capturedOpts = opts;
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		process.nextTick(() => {
			child.stdout.emit('data', '{"status":"ok"}');
			child.emit('close', 0);
		});
		return child;
	};

	await callGatewayMethod('coclaw.bind', spawn, { isWin: true });
	assert.equal(capturedOpts.shell, true);
});

test('callGatewayMethod should resolve ok with status field from result payload', async () => {
	// openclaw gateway call --json 直接输出 method 的 result payload
	const { spawn, calls } = createMockSpawn({
		stdout: '{"status":"refreshed"}',
	});

	const result = await callGatewayMethod('coclaw.bind', spawn);

	assert.deepEqual(result, { ok: true, status: 'refreshed' });
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], ['openclaw', 'gateway', 'call', 'coclaw.bind', '--json']);
});

test('callGatewayMethod should pass --params as raw JSON on non-Windows', async () => {
	const { spawn, calls } = createMockSpawn({
		stdout: '{"status":"ok"}',
	});

	const params = { serverUrl: 'https://example.com' };
	await callGatewayMethod('coclaw.enroll', spawn, { params, isWin: false });

	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], [
		'openclaw', 'gateway', 'call', 'coclaw.enroll', '--json',
		'--params', JSON.stringify(params),
	]);
});

test('callGatewayMethod should escape --params JSON for cmd.exe on Windows', async () => {
	const { spawn, calls } = createMockSpawn({
		stdout: '{"status":"ok"}',
	});

	const params = { serverUrl: 'https://example.com' };
	await callGatewayMethod('coclaw.enroll', spawn, { params, isWin: true });

	assert.equal(calls.length, 1);
	const json = JSON.stringify(params);
	assert.deepEqual(calls[0], [
		'openclaw', 'gateway', 'call', 'coclaw.enroll', '--json',
		'--params', escapeJsonForCmd(json),
	]);
});

test('callGatewayMethod should not pass --params when params not provided', async () => {
	const { spawn, calls } = createMockSpawn({
		stdout: '{"status":"ok"}',
	});

	await callGatewayMethod('coclaw.enroll', spawn);

	assert.deepEqual(calls[0], ['openclaw', 'gateway', 'call', 'coclaw.enroll', '--json']);
});

test('callGatewayMethod should pass --timeout when timeoutMs is provided', async () => {
	const { spawn, calls } = createMockSpawn({ stdout: '{"status":"ok"}' });

	await callGatewayMethod('coclaw.bind', spawn, { timeoutMs: 20000 });

	assert.deepEqual(calls[0], [
		'openclaw', 'gateway', 'call', 'coclaw.bind', '--json',
		'--timeout', '20000',
	]);
});

test('callGatewayMethod should not pass --timeout when timeoutMs is not provided', async () => {
	const { spawn, calls } = createMockSpawn({ stdout: '{"status":"ok"}' });

	await callGatewayMethod('coclaw.bind', spawn);

	assert.deepEqual(calls[0], ['openclaw', 'gateway', 'call', 'coclaw.bind', '--json']);
});

test('callGatewayMethod should pass both --timeout and --params', async () => {
	const { spawn, calls } = createMockSpawn({ stdout: '{"status":"ok"}' });
	const params = { code: '123' };

	await callGatewayMethod('coclaw.bind', spawn, { timeoutMs: 20000, params, isWin: false });

	assert.deepEqual(calls[0], [
		'openclaw', 'gateway', 'call', 'coclaw.bind', '--json',
		'--timeout', '20000',
		'--params', JSON.stringify(params),
	]);
});

test('callGatewayMethod should resolve ok for any valid JSON output', async () => {
	// 即使 JSON 中没有 status 字段，有合法输出即视为成功
	const { spawn } = createMockSpawn({
		stdout: '{"ok":true,"ts":12345}',
	});

	const result = await callGatewayMethod('coclaw.bind', spawn);

	assert.equal(result.ok, true);
	assert.equal(result.status, undefined);
});

test('callGatewayMethod should resolve immediately on stdout without waiting for close', async () => {
	// 模拟进程不退出的场景：有 stdout 但不触发 close
	const { spawn } = createMockSpawn({
		stdout: '{"status":"stopped"}',
		delayClose: true,
	});

	const result = await callGatewayMethod('coclaw.unbind', spawn, { killDelayMs: 10 });

	assert.equal(result.ok, true);
	assert.equal(result.status, 'stopped');
});

test('callGatewayMethod should resolve ok:false on spawn error event', async () => {
	const { spawn } = createMockSpawn({ emitError: true });

	const result = await callGatewayMethod('coclaw.bind', spawn);

	assert.equal(result.ok, false);
	assert.equal(result.error, 'spawn_error');
});

test('callGatewayMethod should resolve ok:false when spawn throws', async () => {
	const throwSpawn = () => { throw new Error('not found'); };

	const result = await callGatewayMethod('coclaw.bind', throwSpawn);

	assert.equal(result.ok, false);
	assert.equal(result.error, 'spawn_failed');
});

test('callGatewayMethod should resolve ok:false on non-zero exit without stdout', async () => {
	const { spawn } = createMockSpawn({ exitCode: 1 });

	const result = await callGatewayMethod('coclaw.bind', spawn);

	assert.equal(result.ok, false);
	assert.equal(result.error, 'exit_code_1');
});

test('callGatewayMethod should capture stderr as message on non-zero exit', async () => {
	const mockSpawn = () => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		process.nextTick(() => {
			child.stderr.emit('data', 'Gateway call failed: already bound');
			child.emit('close', 1);
		});
		return child;
	};

	const result = await callGatewayMethod('coclaw.enroll', mockSpawn);

	assert.equal(result.ok, false);
	assert.equal(result.error, 'exit_code_1');
	assert.equal(result.message, 'Gateway call failed: already bound');
});

test('callGatewayMethod should treat non-JSON stdout as success', async () => {
	const { spawn } = createMockSpawn({
		stdout: 'some non-json output',
	});

	const result = await callGatewayMethod('coclaw.bind', spawn);

	assert.equal(result.ok, true);
});

test('callGatewayMethod should timeout and resolve ok:false when no events', async () => {
	const { spawn } = createMockSpawn({ noEvents: true });

	const result = await callGatewayMethod('coclaw.bind', spawn, { timeoutMs: 50 });

	assert.equal(result.ok, false);
	assert.equal(result.error, 'timeout');
});

test('callGatewayMethod should ignore duplicate finish calls', async () => {
	// 模拟 stdout 触发 finish 后 close 再次触发
	const mockSpawn = () => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		process.nextTick(() => {
			child.stdout.emit('data', '{"status":"refreshed"}');
			child.emit('close', 0);
			child.emit('close', 0);
		});
		return child;
	};

	const result = await callGatewayMethod('coclaw.bind', mockSpawn, { timeoutMs: 50 });
	assert.equal(result.ok, true);
	assert.equal(result.status, 'refreshed');
});

test('callGatewayMethod should return empty_output on exit 0 without stdout', async () => {
	const { spawn } = createMockSpawn({ exitCode: 0 });

	const result = await callGatewayMethod('coclaw.bind', spawn);

	assert.equal(result.ok, false);
	assert.equal(result.error, 'empty_output');
});

test('callGatewayMethod should parse result on non-zero exit with stdout', async () => {
	const { spawn } = createMockSpawn({
		stdout: '{"status":"refreshed"}',
		exitCode: 1,
	});

	const result = await callGatewayMethod('coclaw.bind', spawn);

	assert.equal(result.ok, true);
	assert.equal(result.status, 'refreshed');
});

test('callGatewayMethod should wait for complete JSON before resolving', async () => {
	// 模拟分片输出：首片不是完整 JSON，不应立即 resolve
	const mockSpawn = () => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		process.nextTick(() => {
			// 先发送不完整的 JSON
			child.stdout.emit('data', '{"status":');
			// 再发送剩余部分
			child.stdout.emit('data', '"refreshed"}');
		});
		return child;
	};

	const result = await callGatewayMethod('coclaw.bind', mockSpawn, { timeoutMs: 100 });

	assert.equal(result.ok, true);
	assert.equal(result.status, 'refreshed');
});

test('callGatewayMethod should not start grace period twice on multiple data chunks', async () => {
	// 模拟多次 data 事件都匹配完整 JSON（startGracePeriod 的 early return 分支）
	const mockSpawn = () => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		process.nextTick(() => {
			child.stdout.emit('data', '{"status":"refreshed"}');
			// 第二次 data 事件仍然看起来像完整 JSON（因为 stdout 累积）
			child.stdout.emit('data', '');
		});
		return child;
	};

	const result = await callGatewayMethod('coclaw.bind', mockSpawn, { killDelayMs: 10 });
	assert.equal(result.ok, true);
	assert.equal(result.status, 'refreshed');
});

test('callGatewayMethod should handle child.kill() throwing', async () => {
	// 模拟 child.kill() 抛异常的场景（finish 中的 catch 分支）
	const mockSpawn = () => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => { throw new Error('kill failed'); };
		process.nextTick(() => {
			child.stdout.emit('data', '{"status":"refreshed"}');
			child.emit('close', 0);
		});
		return child;
	};

	const result = await callGatewayMethod('coclaw.bind', mockSpawn, { killDelayMs: 10 });
	assert.equal(result.ok, true);
	assert.equal(result.status, 'refreshed');
});

test('callGatewayMethod should parse stdout on timeout when output is not complete JSON', async () => {
	// 有 stdout 但不是完整 JSON（无法通过 tryResolveFromStdout 立即 resolve）
	const mockSpawn = () => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		process.nextTick(() => {
			child.stdout.emit('data', 'partial output without closing brace');
		});
		return child;
	};

	const result = await callGatewayMethod('coclaw.bind', mockSpawn, { timeoutMs: 50 });

	assert.equal(result.ok, true);
});

test('escapeJsonForCmd should wrap in double quotes and escape inner double quotes', () => {
	assert.equal(
		escapeJsonForCmd('{"serverUrl":"http://localhost:5173"}'),
		'"{\\\"serverUrl\\\":\\\"http://localhost:5173\\\"}"',
	);
});

test('escapeJsonForCmd should handle JSON without special chars', () => {
	assert.equal(escapeJsonForCmd('{}'), '"{}"');
});
