import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { registerCoclawCli } from './cli-registrar.js';

// --- 辅助工具 ---

function createRpcSpawn(responseMap) {
	const calls = [];
	return {
		calls,
		spawn: (cmd, args) => {
			calls.push([cmd, ...args]);
			const child = new EventEmitter();
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.kill = () => {};
			process.nextTick(() => {
				// args: ['gateway', 'call', '<method>', '--json', ...]
				const method = args?.[2];
				const resp = typeof responseMap === 'function'
					? responseMap(method, args)
					: responseMap;
				if (resp?.error) {
					child.emit('error', new Error(resp.error));
				} else if (resp?.stderr) {
					child.stderr.emit('data', resp.stderr);
					child.emit('close', 1);
				} else {
					child.stdout.emit('data', JSON.stringify(resp?.data ?? {}));
					child.emit('close', 0);
				}
			});
			return child;
		},
	};
}

function createMockCmd(name) {
	const cmd = {
		name,
		commands: new Map(),
		desc: '',
		opts: [],
		actionFn: null,
		description(d) { cmd.desc = d; return cmd; },
		option(flags) { cmd.opts.push(flags); return cmd; },
		action(fn) { cmd.actionFn = fn; return cmd; },
		command(sub) {
			const child = createMockCmd(sub);
			cmd.commands.set(sub, child);
			return child;
		},
	};
	return cmd;
}

function createMockProgram() {
	return createMockCmd('root');
}

function withConsole(fn) {
	const logs = [];
	const errors = [];
	const oldLog = console.log;
	const oldErr = console.error;
	console.log = (...args) => logs.push(args.join(' '));
	console.error = (...args) => errors.push(args.join(' '));
	const prevExitCode = process.exitCode;
	return async () => {
		try {
			await fn();
			const exitCode = process.exitCode;
			return { logs, errors, exitCode };
		} finally {
			process.exitCode = prevExitCode;
			console.log = oldLog;
			console.error = oldErr;
		}
	};
}

// --- 注册结构测试 ---

test('registerCoclawCli should register coclaw command with bind/unbind/enroll subcommands', () => {
	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	const { spawn } = createRpcSpawn({});

	registerCoclawCli({ program, logger }, { spawn });

	assert.equal(program.commands.has('coclaw'), true);
	const coclaw = program.commands.get('coclaw');
	assert.equal(coclaw.desc, 'CoClaw bind/unbind commands');
	assert.equal(coclaw.commands.size, 3);

	const bind = coclaw.commands.get('bind <code>');
	assert.ok(bind);
	assert.equal(typeof bind.actionFn, 'function');

	const enroll = coclaw.commands.get('enroll');
	assert.ok(enroll);
	assert.equal(typeof enroll.actionFn, 'function');

	const unbind = coclaw.commands.get('unbind');
	assert.ok(unbind);
	assert.equal(typeof unbind.actionFn, 'function');
});

// --- bind CLI 测试 ---

test('bind CLI should send coclaw.bind RPC with code and serverUrl', async () => {
	const { spawn, calls } = createRpcSpawn({
		data: { status: { clawId: 'b1', rebound: false } },
	});

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn });

	const bind = program.commands.get('coclaw').commands.get('bind <code>');

	const { logs } = await withConsole(async () => {
		await bind.actionFn('12345678', { server: 'https://my.server.com' });
	})();

	assert.ok(logs.some((l) => l.includes('bound to CoClaw')));
	const rpcCall = calls.find((c) => c.includes('coclaw.bind'));
	assert.ok(rpcCall);
	const paramsIdx = rpcCall.indexOf('--params');
	assert.ok(paramsIdx !== -1);
	const parsed = JSON.parse(rpcCall[paramsIdx + 1]);
	assert.equal(parsed.code, '12345678');
	assert.equal(parsed.serverUrl, 'https://my.server.com');
});

test('bind CLI should send code without serverUrl when --server not provided', async () => {
	const { spawn, calls } = createRpcSpawn({
		data: { status: { clawId: 'b1', rebound: false } },
	});

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn });

	const bind = program.commands.get('coclaw').commands.get('bind <code>');

	await withConsole(async () => {
		await bind.actionFn('12345678', {});
	})();

	const rpcCall = calls.find((c) => c.includes('coclaw.bind'));
	const paramsIdx = rpcCall.indexOf('--params');
	const parsed = JSON.parse(rpcCall[paramsIdx + 1]);
	assert.equal(parsed.code, '12345678');
	assert.equal(parsed.serverUrl, undefined);
});

test('bind CLI should show previousClawId when rebinding', async () => {
	const { spawn } = createRpcSpawn({
		data: { status: { clawId: 'b-new', rebound: false, previousClawId: 'b-old' } },
	});

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn });

	const bind = program.commands.get('coclaw').commands.get('bind <code>');

	const { logs } = await withConsole(async () => {
		await bind.actionFn('newcode', {});
	})();

	assert.ok(logs.some((l) => l.includes('bound to CoClaw') && l.includes('previous Claw')));
});

test('bind CLI should retry on gateway unavailable', async () => {
	let callCount = 0;
	const { spawn } = createRpcSpawn((method) => {
		callCount += 1;
		if (method === 'coclaw.bind' && callCount <= 1) {
			return { error: 'spawn failed' };
		}
		return { data: { status: { clawId: 'b1', rebound: false } } };
	});

	const restartCalls = [];
	const mockRestart = async () => { restartCalls.push(1); };

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn, restartGateway: mockRestart });

	const bind = program.commands.get('coclaw').commands.get('bind <code>');

	const { logs } = await withConsole(async () => {
		await bind.actionFn('12345678', {});
	})();

	assert.equal(restartCalls.length, 1);
	assert.ok(logs.some((l) => l.includes('bound to CoClaw')));
});

test('bind CLI should show error on gateway unavailable after retry', async () => {
	const { spawn } = createRpcSpawn({ error: 'spawn failed' });
	const mockRestart = async () => {};

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn, restartGateway: mockRestart });

	const bind = program.commands.get('coclaw').commands.get('bind <code>');

	const { errors, exitCode } = await withConsole(async () => {
		await bind.actionFn('12345678', {});
	})();

	assert.ok(errors.some((l) => l.includes('Could not reach gateway')));
	assert.equal(exitCode, 1);
});

test('bind CLI should show UNBIND_FAILED error from RPC', async () => {
	const { spawn } = createRpcSpawn({
		stderr: 'Gateway call failed: GatewayClientRequestError: UNBIND_FAILED: Failed to unbind previous claw',
	});

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn });

	const bind = program.commands.get('coclaw').commands.get('bind <code>');

	const { errors, exitCode } = await withConsole(async () => {
		await bind.actionFn('12345678', {});
	})();

	assert.ok(errors.some((l) => l.includes('UNBIND_FAILED')));
	assert.equal(exitCode, 1);
});

// --- unbind CLI 测试 ---

test('unbind CLI should send coclaw.unbind RPC', async () => {
	const { spawn, calls } = createRpcSpawn({
		data: { status: { clawId: 'b1' } },
	});

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn });

	const unbind = program.commands.get('coclaw').commands.get('unbind');

	const { logs } = await withConsole(async () => {
		await unbind.actionFn({});
	})();

	assert.ok(logs.some((l) => l.includes('unbound from CoClaw')));
	assert.ok(calls.some((c) => c.includes('coclaw.unbind')));
});

test('unbind CLI should pass --server as serverUrl param', async () => {
	const { spawn, calls } = createRpcSpawn({
		data: { status: { clawId: 'b1' } },
	});

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn });

	const unbind = program.commands.get('coclaw').commands.get('unbind');

	await withConsole(async () => {
		await unbind.actionFn({ server: 'https://my.server.com' });
	})();

	const rpcCall = calls.find((c) => c.includes('coclaw.unbind'));
	const paramsIdx = rpcCall.indexOf('--params');
	const parsed = JSON.parse(rpcCall[paramsIdx + 1]);
	assert.equal(parsed.serverUrl, 'https://my.server.com');
});

test('unbind CLI should show NOT_BOUND error', async () => {
	const { spawn } = createRpcSpawn({
		stderr: 'Gateway call failed: GatewayClientRequestError: NOT_BOUND: not bound',
	});

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn });

	const unbind = program.commands.get('coclaw').commands.get('unbind');

	const { errors, exitCode } = await withConsole(async () => {
		await unbind.actionFn({});
	})();

	assert.ok(errors.some((l) => l.includes('Not bound')));
	assert.equal(exitCode, 1);
});

test('unbind CLI should retry on gateway unavailable', async () => {
	let callCount = 0;
	const { spawn } = createRpcSpawn((method) => {
		callCount += 1;
		if (method === 'coclaw.unbind' && callCount <= 1) {
			return { error: 'spawn failed' };
		}
		return { data: { status: { clawId: 'b1' } } };
	});

	const restartCalls = [];
	const mockRestart = async () => { restartCalls.push(1); };

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn, restartGateway: mockRestart });

	const unbind = program.commands.get('coclaw').commands.get('unbind');

	const { logs } = await withConsole(async () => {
		await unbind.actionFn({});
	})();

	assert.equal(restartCalls.length, 1);
	assert.ok(logs.some((l) => l.includes('unbound from CoClaw')));
});

test('unbind CLI should show generic error on non-NOT_BOUND RPC failure', async () => {
	const { spawn } = createRpcSpawn({
		stderr: 'Gateway call failed: GatewayClientRequestError: HTTP 500',
	});

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn });

	const unbind = program.commands.get('coclaw').commands.get('unbind');

	const { errors, exitCode } = await withConsole(async () => {
		await unbind.actionFn({});
	})();

	assert.ok(errors.some((l) => l.includes('HTTP 500')));
	assert.ok(!errors.some((l) => l.includes('Not bound')));
	assert.equal(exitCode, 1);
});

// --- enroll CLI 测试 ---

test('enroll CLI should output claim code on RPC success', async () => {
	const { spawn } = createRpcSpawn({
		data: {
			status: {
				code: '12345678',
				appUrl: 'https://im.coclaw.net/claim?code=12345678',
				expiresMinutes: 30,
			},
		},
	});

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn });

	const enroll = program.commands.get('coclaw').commands.get('enroll');

	const { logs } = await withConsole(async () => {
		await enroll.actionFn();
	})();

	assert.ok(logs.some((l) => l.includes('Claim code: 12345678')));
	assert.ok(logs.some((l) => l.includes('im.coclaw.net/claim?code=12345678')));
});

test('enroll CLI should pass --server as RPC params', async () => {
	const { spawn, calls } = createRpcSpawn({
		data: {
			status: {
				code: '55556666',
				appUrl: 'https://my.server.com/claim?code=55556666',
				expiresMinutes: 30,
			},
		},
	});

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn });

	const enroll = program.commands.get('coclaw').commands.get('enroll');

	const { logs } = await withConsole(async () => {
		await enroll.actionFn({ server: 'https://my.server.com' });
	})();

	const rpcCall = calls.find((c) => c.includes('coclaw.enroll'));
	assert.ok(rpcCall);
	const paramsIdx = rpcCall.indexOf('--params');
	const parsed = JSON.parse(rpcCall[paramsIdx + 1]);
	assert.equal(parsed.serverUrl, 'https://my.server.com');
	assert.ok(logs.some((l) => l.includes('55556666')));
});

test('enroll CLI should retry after gateway restart on RPC failure', async () => {
	let callCount = 0;
	const { spawn } = createRpcSpawn((method) => {
		callCount += 1;
		if (method === 'coclaw.enroll' && callCount <= 1) {
			return { error: 'spawn failed' };
		}
		return {
			data: {
				status: {
					code: '99998888',
					appUrl: 'https://im.coclaw.net/claim?code=99998888',
					expiresMinutes: 30,
				},
			},
		};
	});

	const restartCalls = [];
	const mockRestart = async () => { restartCalls.push(1); };

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn, restartGateway: mockRestart });

	const enroll = program.commands.get('coclaw').commands.get('enroll');

	const { logs } = await withConsole(async () => {
		await enroll.actionFn();
	})();

	assert.equal(restartCalls.length, 1);
	assert.ok(logs.some((l) => l.includes('99998888')));
});

test('enroll CLI should retry even when restart throws', async () => {
	let callCount = 0;
	const { spawn } = createRpcSpawn((method) => {
		callCount += 1;
		if (method === 'coclaw.enroll' && callCount <= 1) {
			return { error: 'spawn failed' };
		}
		return {
			data: {
				status: {
					code: '11112222',
					appUrl: 'https://im.coclaw.net/claim?code=11112222',
					expiresMinutes: 30,
				},
			},
		};
	});

	const mockRestart = async () => { throw new Error('restart failed'); };

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn, restartGateway: mockRestart });

	const enroll = program.commands.get('coclaw').commands.get('enroll');

	const { logs } = await withConsole(async () => {
		await enroll.actionFn();
	})();

	assert.ok(logs.some((l) => l.includes('11112222')));
});

test('enroll CLI should show fallback message when status lacks code/appUrl', async () => {
	const { spawn } = createRpcSpawn({
		data: { status: { partial: true } },
	});

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn });

	const enroll = program.commands.get('coclaw').commands.get('enroll');

	const { logs } = await withConsole(async () => {
		await enroll.actionFn();
	})();

	assert.ok(logs.some((l) => l.includes('Enroll request sent to gateway')));
});

test('enroll CLI should show error when RPC fails after retry', async () => {
	const { spawn } = createRpcSpawn({ error: 'spawn failed' });
	const mockRestart = async () => {};

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn, restartGateway: mockRestart });

	const enroll = program.commands.get('coclaw').commands.get('enroll');

	const { errors, exitCode } = await withConsole(async () => {
		await enroll.actionFn();
	})();

	assert.ok(errors.some((l) => l.includes('Could not reach gateway')));
	assert.equal(exitCode, 1);
});

test('enroll CLI should show business error without gateway restart', async () => {
	const { spawn } = createRpcSpawn({
		stderr: 'Gateway call failed: GatewayClientRequestError: Already bound. Run `openclaw coclaw unbind` to unbind first, then retry.',
	});

	const restartCalls = [];
	const mockRestart = async () => { restartCalls.push(1); };

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, logger }, { spawn, restartGateway: mockRestart });

	const enroll = program.commands.get('coclaw').commands.get('enroll');

	const { errors, exitCode } = await withConsole(async () => {
		await enroll.actionFn();
	})();

	assert.equal(restartCalls.length, 0);
	assert.ok(errors.some((l) => l.includes('Already bound')));
	assert.ok(!errors.some((l) => l.includes('GatewayClientRequestError')));
	assert.equal(exitCode, 1);
});
