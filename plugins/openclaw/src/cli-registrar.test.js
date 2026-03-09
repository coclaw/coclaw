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
	assert.equal(coclaw.commands.size, 2);

	const bind = coclaw.commands.get('bind <code>');
	assert.ok(bind);
	assert.equal(typeof bind.actionFn, 'function');

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

test('bind action should handle ALREADY_BOUND error', async () => {
	const errors = [];
	const oldLog = console.log;
	const oldErr = console.error;
	console.log = () => {};
	console.error = (...args) => errors.push(args.join(' '));

	const dir = await setupDir('coclaw-cli-reg-already-');
	await writeBindings(dir, { botId: 'b-dup', token: 'tk-dup' });

	const program = createMockProgram();
	const logger = { info() {}, warn() {} };
	registerCoclawCli({ program, config: {}, logger }, { spawn: noopSpawn });

	const bind = program.commands.get('coclaw').commands.get('bind <code>');
	const prevExitCode = process.exitCode;

	try {
		await bind.actionFn('newcode', { server: 'http://127.0.0.1:1' });
		assert.equal(errors.some((l) => l.includes('Already bound to CoClaw')), true);
		assert.equal(errors.some((l) => l.includes('openclaw coclaw unbind')), true);
		assert.equal(process.exitCode, 1);
	} finally {
		process.exitCode = prevExitCode;
		console.log = oldLog;
		console.error = oldErr;
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
