import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { registerCoclawCli } from './cli-registrar.js';
import { saveHomedir, setHomedir, restoreHomedir } from './homedir-mock.helper.js';
import { createMockServer } from './mock-server.helper.js';
import { setRuntime } from './runtime.js';

function createMockSpawn({ fail = false } = {}) {
	const calls = [];
	const spawn = (cmd, args) => {
		calls.push([cmd, ...args].join(' '));
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		process.nextTick(() => {
			if (fail) {
				child.emit('error', new Error('spawn failed'));
			} else {
				child.stdout.emit('data', '{"status":"refreshed"}');
				child.emit('close', 0);
			}
		});
		return child;
	};
	return { spawn, calls };
}

const noopSpawn = createMockSpawn().spawn;

// 模拟 Commander.js 的最小 API
function createMockCmd(name) {
	const cmd = {
		name,
		commands: new Map(),
		desc: '',
		opts: [],
		actionFn: null,
		description(d) { cmd.desc = d; return cmd; },
		option(flags, desc) { cmd.opts.push({ flags, desc }); return cmd; },
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


async function setupDir(prefix) {
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.OPENCLAW_CONFIG_PATH = nodePath.join(dir, 'openclaw.json');
	await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, '{}', 'utf8');
	delete process.env.COCLAW_TUNNEL_CONFIG_PATH;
	setRuntime(null);
	return dir;
}

async function writeBindings(dir, data) {
	const bp = nodePath.join(dir, 'coclaw', 'bindings.json');
	await fs.mkdir(nodePath.dirname(bp), { recursive: true });
	await fs.writeFile(bp, JSON.stringify({ default: data }), 'utf8');
}

test('registerCoclawCli should register coclaw command with bind/unbind subcommands', () => {
	const program = createMockProgram();
	const logger = { info() {}, warn() {} };

	registerCoclawCli({ program, config: {}, logger }, { spawn: noopSpawn });

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

test('bind action should call bindBot and notify gateway', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const logs = [];
	const oldLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	const mock = await createMockServer();
	const dir = await setupDir('coclaw-cli-reg-bind-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const { spawn: mockSpawn, calls } = createMockSpawn();

	const program = createMockProgram();
	const infos = [];
	const logger = { info: (m) => infos.push(m), warn() {} };
	registerCoclawCli({ program, config: {}, logger }, { spawn: mockSpawn });

	const bind = program.commands.get('coclaw').commands.get('bind <code>');

	try {
		await bind.actionFn('12345678', { server: mock.baseUrl });
		assert.equal(logs.some((l) => l.includes('bound to CoClaw')), true);
		assert.equal(calls.some((c) => c.includes('coclaw.refreshBridge')), true);
		assert.equal(infos.some((l) => l.includes('Bridge connection')), true);
	} finally {
		console.log = oldLog;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
		await mock.close();
	}
});

test('bind action should rebind when already bound', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const logs = [];
	const oldLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	const mock = await createMockServer();
	const dir = await setupDir('coclaw-cli-reg-rebind-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	await writeBindings(dir, { botId: 'b-old', token: 'tk-old', serverUrl: 'http://127.0.0.1:1' });

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, config: {}, logger }, { spawn: noopSpawn });

	const bind = program.commands.get('coclaw').commands.get('bind <code>');

	try {
		await bind.actionFn('newcode', { server: mock.baseUrl });
		assert.ok(logs.some((l) => l.includes('bound to CoClaw')));
		assert.ok(logs.some((l) => l.includes('previous binding')));
	} finally {
		console.log = oldLog;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
		await mock.close();
	}
});

test('bind action should handle generic errors', async () => {
	const errors = [];
	const oldLog = console.log;
	const oldErr = console.error;
	console.log = () => {};
	console.error = (...args) => errors.push(args.join(' '));

	await setupDir('coclaw-cli-reg-generic-');

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, config: {}, logger }, { spawn: noopSpawn });

	const bind = program.commands.get('coclaw').commands.get('bind <code>');
	const prevExitCode = process.exitCode;

	try {
		// 不传 code（由于 Commander mock 直接传参，这里传空）
		await bind.actionFn('', {});
		assert.equal(errors.some((l) => l.includes('Error:')), true);
		assert.equal(process.exitCode, 1);
	} finally {
		process.exitCode = prevExitCode;
		console.log = oldLog;
		console.error = oldErr;
	}
});

test('unbind action should call unbindBot and notify gateway', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const logs = [];
	const oldLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	const mock = await createMockServer();
	const dir = await setupDir('coclaw-cli-reg-unbind-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	// 先 bind
	const { bindBot } = await import('./common/bot-binding.js');
	await bindBot({ code: '12345678', serverUrl: mock.baseUrl });

	const { spawn: mockSpawn, calls } = createMockSpawn();

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, config: {}, logger }, { spawn: mockSpawn });

	const unbind = program.commands.get('coclaw').commands.get('unbind');

	try {
		await unbind.actionFn({ server: mock.baseUrl });
		assert.equal(logs.some((l) => l.includes('unbound from CoClaw')), true);
		assert.equal(calls.some((c) => c.includes('coclaw.stopBridge')), true);
	} finally {
		console.log = oldLog;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
		await mock.close();
	}
});

test('unbind action should handle NOT_BOUND error', async () => {
	const errors = [];
	const oldLog = console.log;
	const oldErr = console.error;
	console.log = () => {};
	console.error = (...args) => errors.push(args.join(' '));

	await setupDir('coclaw-cli-reg-unbind-notbound-');

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, config: {}, logger }, { spawn: noopSpawn });

	const unbind = program.commands.get('coclaw').commands.get('unbind');
	const prevExitCode = process.exitCode;

	try {
		await unbind.actionFn({});
		assert.equal(errors.some((l) => l.includes('Not bound')), true);
		assert.equal(process.exitCode, 1);
	} finally {
		process.exitCode = prevExitCode;
		console.log = oldLog;
		console.error = oldErr;
	}
});

test('unbind action should succeed with warning when server fails', async () => {
	const logs = [];
	const oldLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	const dir = await setupDir('coclaw-cli-reg-unbind-err-');
	// 有 token 但 server 不可达
	await writeBindings(dir, { botId: 'b1', token: 'tk', serverUrl: 'http://127.0.0.1:1' });

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, config: {}, logger }, { spawn: noopSpawn });

	const unbind = program.commands.get('coclaw').commands.get('unbind');

	try {
		await unbind.actionFn({ server: 'http://127.0.0.1:1' });
		// 应该成功 unbind，日志中包含 server notification failed 提示
		assert.ok(logs.some((l) => l.includes('unbound') && l.includes('server notification failed')));
	} finally {
		console.log = oldLog;
	}
});

test('serverUrl should resolve from config when --server not provided', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const logs = [];
	const oldLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	const mock = await createMockServer();
	const dir = await setupDir('coclaw-cli-reg-cfgurl-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const config = {
		plugins: {
			entries: {
				'openclaw-coclaw': {
					config: { serverUrl: mock.baseUrl },
				},
			},
		},
	};

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, config, logger }, { spawn: noopSpawn });

	const bind = program.commands.get('coclaw').commands.get('bind <code>');

	try {
		await bind.actionFn('12345678', {});
		assert.equal(logs.some((l) => l.includes('bound to CoClaw')), true);
	} finally {
		console.log = oldLog;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
		await mock.close();
	}
});

test('enroll action should output claim code on RPC success', async () => {
	const logs = [];
	const oldLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	// 模拟 RPC 返回成功的 enroll 数据
	function createEnrollSpawn() {
		return () => {
			const child = new EventEmitter();
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.kill = () => {};
			process.nextTick(() => {
				child.stdout.emit('data', JSON.stringify({
					status: {
						code: '12345678',
						appUrl: 'https://im.coclaw.net/claim?code=12345678',
						expiresMinutes: 30,
					},
				}));
				child.emit('close', 0);
			});
			return child;
		};
	}

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, config: {}, logger }, { spawn: createEnrollSpawn() });

	const enroll = program.commands.get('coclaw').commands.get('enroll');

	try {
		await enroll.actionFn();
		assert.ok(logs.some((l) => l.includes('Claim code: 12345678')));
		assert.ok(logs.some((l) => l.includes('im.coclaw.net/claim?code=12345678')));
	} finally {
		console.log = oldLog;
	}
});

test('enroll action should pass --server as RPC params', async () => {
	const logs = [];
	const oldLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	const spawnCalls = [];
	function createEnrollSpawnWithCapture() {
		return (cmd, args) => {
			spawnCalls.push([cmd, ...args]);
			const child = new EventEmitter();
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.kill = () => {};
			process.nextTick(() => {
				child.stdout.emit('data', JSON.stringify({
					status: {
						code: '55556666',
						appUrl: 'https://my.server.com/claim?code=55556666',
						expiresMinutes: 30,
					},
				}));
				child.emit('close', 0);
			});
			return child;
		};
	}

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, config: {}, logger }, { spawn: createEnrollSpawnWithCapture() });

	const enroll = program.commands.get('coclaw').commands.get('enroll');

	try {
		await enroll.actionFn({ server: 'https://my.server.com' });
		// 验证 --params 包含 serverUrl
		const rpcCall = spawnCalls.find((c) => c.includes('coclaw.enroll'));
		assert.ok(rpcCall, 'should have called coclaw.enroll RPC');
		const paramsIdx = rpcCall.indexOf('--params');
		assert.ok(paramsIdx !== -1, 'should include --params flag');
		const parsedParams = JSON.parse(rpcCall[paramsIdx + 1]);
		assert.equal(parsedParams.serverUrl, 'https://my.server.com');
		// 验证输出了认领码
		assert.ok(logs.some((l) => l.includes('55556666')));
	} finally {
		console.log = oldLog;
	}
});

test('enroll action should retry after gateway restart on RPC failure', async () => {
	const errors = [];
	const logs = [];
	const oldLog = console.log;
	const oldErr = console.error;
	console.log = (...args) => logs.push(args.join(' '));
	console.error = (...args) => errors.push(args.join(' '));

	let callCount = 0;
	function createRetrySpawn() {
		return (cmd, args) => {
			const child = new EventEmitter();
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.kill = () => {};
			process.nextTick(() => {
				callCount += 1;
				if (args?.includes?.('coclaw.enroll')) {
					if (callCount <= 1) {
						child.emit('error', new Error('spawn failed'));
					} else {
						child.stdout.emit('data', JSON.stringify({
							status: {
								code: '99998888',
								appUrl: 'https://im.coclaw.net/claim?code=99998888',
								expiresMinutes: 30,
							},
						}));
						child.emit('close', 0);
					}
				} else {
					// gateway restart
					child.emit('close', 0);
				}
			});
			return child;
		};
	}

	const restartCalls = [];
	const mockRestart = async () => { restartCalls.push(1); };

	const program = createMockProgram();
	const infos = [];
	const logger = { info: (m) => infos.push(m), warn() {} };
	registerCoclawCli({ program, config: {}, logger }, {
		spawn: createRetrySpawn(),
		restartGateway: mockRestart,
	});

	const enroll = program.commands.get('coclaw').commands.get('enroll');

	try {
		await enroll.actionFn();
		assert.equal(restartCalls.length, 1);
		assert.ok(logs.some((l) => l.includes('99998888')));
	} finally {
		console.log = oldLog;
		console.error = oldErr;
	}
});

test('enroll action should retry even when restart throws', async () => {
	const logs = [];
	const oldLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	let callCount = 0;
	function createRetrySpawn() {
		return (cmd, args) => {
			const child = new EventEmitter();
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.kill = () => {};
			process.nextTick(() => {
				callCount += 1;
				if (args?.includes?.('coclaw.enroll')) {
					if (callCount <= 1) {
						child.emit('error', new Error('spawn failed'));
					} else {
						child.stdout.emit('data', JSON.stringify({
							status: {
								code: '11112222',
								appUrl: 'https://im.coclaw.net/claim?code=11112222',
								expiresMinutes: 30,
							},
						}));
						child.emit('close', 0);
					}
				}
			});
			return child;
		};
	}

	// restart 抛异常，但仍然会再次尝试 RPC
	const mockRestart = async () => { throw new Error('restart failed'); };

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, config: {}, logger }, {
		spawn: createRetrySpawn(),
		restartGateway: mockRestart,
	});

	const enroll = program.commands.get('coclaw').commands.get('enroll');

	try {
		await enroll.actionFn();
		assert.ok(logs.some((l) => l.includes('11112222')));
	} finally {
		console.log = oldLog;
	}
});

test('enroll action should show fallback message when status lacks code/appUrl', async () => {
	const logs = [];
	const oldLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	function createIncompleteSpawn() {
		return () => {
			const child = new EventEmitter();
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.kill = () => {};
			process.nextTick(() => {
				// RPC 成功但 status 不含 code/appUrl
				child.stdout.emit('data', JSON.stringify({ status: { partial: true } }));
				child.emit('close', 0);
			});
			return child;
		};
	}

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, config: {}, logger }, { spawn: createIncompleteSpawn() });

	const enroll = program.commands.get('coclaw').commands.get('enroll');

	try {
		await enroll.actionFn();
		assert.ok(logs.some((l) => l.includes('Enroll request sent to gateway')));
	} finally {
		console.log = oldLog;
	}
});

test('enroll action should show error when RPC fails after retry', async () => {
	const errors = [];
	const oldLog = console.log;
	const oldErr = console.error;
	console.log = () => {};
	console.error = (...args) => errors.push(args.join(' '));

	const { spawn: failSpawn } = createMockSpawn({ fail: true });
	const mockRestart = async () => {};

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, config: {}, logger }, {
		spawn: failSpawn,
		restartGateway: mockRestart,
	});

	const enroll = program.commands.get('coclaw').commands.get('enroll');
	const prevExitCode = process.exitCode;

	try {
		await enroll.actionFn();
		assert.ok(errors.some((l) => l.includes('Could not reach gateway')));
		assert.equal(process.exitCode, 1);
	} finally {
		process.exitCode = prevExitCode;
		console.log = oldLog;
		console.error = oldErr;
	}
});

test('gateway notify failure should warn', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const logs = [];
	const warns = [];
	const oldLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	const mock = await createMockServer();
	const dir = await setupDir('coclaw-cli-reg-restart-fail-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const { spawn: failSpawn } = createMockSpawn({ fail: true });
	const program = createMockProgram();
	const logger = { info() {}, warn: (m) => warns.push(m) };
	registerCoclawCli({ program, config: {}, logger }, { spawn: failSpawn });

	const bind = program.commands.get('coclaw').commands.get('bind <code>');

	try {
		await bind.actionFn('12345678', { server: mock.baseUrl });
		assert.equal(logs.some((l) => l.includes('bound to CoClaw')), true);
		assert.equal(warns.some((l) => l.includes('could not notify')), true);
	} finally {
		console.log = oldLog;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
		await mock.close();
	}
});
