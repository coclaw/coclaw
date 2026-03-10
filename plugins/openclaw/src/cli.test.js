import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { main } from './cli.js';
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

async function setupDir(prefix) {
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.OPENCLAW_CONFIG_PATH = nodePath.join(dir, 'openclaw.json');
	await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, '{}', 'utf8');
	delete process.env.COCLAW_TUNNEL_CONFIG_PATH;
	setRuntime(null);
	return dir;
}

function bindingsPath(dir) {
	return nodePath.join(dir, 'coclaw', 'bindings.json');
}

async function writeBindings(dir, data) {
	const bp = bindingsPath(dir);
	await fs.mkdir(nodePath.dirname(bp), { recursive: true });
	await fs.writeFile(bp, JSON.stringify({ default: data }), 'utf8');
}

test('cli should print help and support bind/unbind flow', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const logs = [];
	const errors = [];
	const oldLog = console.log;
	const oldErr = console.error;
	console.log = (...args) => logs.push(args.join(' '));
	console.error = (...args) => errors.push(args.join(' '));

	const mock = await createMockServer();
	const dir = await setupDir('coclaw-cli-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	try {
		const helpCode = await main([], { spawn: noopSpawn });
		assert.equal(helpCode, 0);
		assert.equal(logs.some((line) => line.includes('Usage: coclaw')), true);

		const bindCode = await main(['bind', '12345678', '--server', mock.baseUrl], { spawn: noopSpawn });
		assert.equal(bindCode, 0);

		const unbindCode = await main(['unbind', '--server', mock.baseUrl], { spawn: noopSpawn });
		assert.equal(unbindCode, 0);

		await assert.rejects(() => main(['unknown'], { spawn: noopSpawn }), /unknown command/);
		assert.equal(errors.length, 0);
	}
	finally {
		console.log = oldLog;
		console.error = oldErr;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
		await mock.close();
	}
});

test('cli bind should re-throw errors from bindBot', async () => {
	await setupDir('coclaw-cli-rethrow-');
	await assert.rejects(() => main(['bind'], { spawn: noopSpawn }), /binding code is required/);
});

test('cli bind should rebind when already bound', async () => {
	const logs = [];
	const oldLog = console.log;
	const oldWarn = console.warn;
	console.log = (...args) => logs.push(args.join(' '));
	console.warn = () => {};

	const mock = await createMockServer();
	const dir = await setupDir('coclaw-cli-rebind-');
	await writeBindings(dir, { botId: 'b-old', token: 'tk-old', serverUrl: 'http://127.0.0.1:1' });

	try {
		const code = await main(['bind', 'newcode', '--server', mock.baseUrl], { spawn: noopSpawn });
		assert.equal(code, 0);
		assert.ok(logs.some((l) => l.includes('bound to CoClaw')));
		assert.ok(logs.some((l) => l.includes('previous binding')));
	}
	finally {
		console.log = oldLog;
		console.warn = oldWarn;
		await mock.close();
	}
});

test('cli bind success should notify gateway via RPC', async () => {
	const logs = [];
	const oldLog = console.log;
	const oldWarn = console.warn;
	console.log = (...args) => logs.push(args.join(' '));
	console.warn = () => {};

	const mock = await createMockServer();
	await setupDir('coclaw-cli-notify-');

	const { spawn: mockSpawn, calls } = createMockSpawn();

	try {
		const code = await main(['bind', '12345678', '--server', mock.baseUrl], { spawn: mockSpawn });
		assert.equal(code, 0);
		assert.equal(calls.some((c) => c.includes('coclaw.refreshBridge')), true);
		assert.equal(logs.some((line) => line.includes('Bridge connection')), true);
	}
	finally {
		console.log = oldLog;
		console.warn = oldWarn;
		await mock.close();
	}
});

test('cli bind success should warn when gateway notify fails', async () => {
	const logs = [];
	const warns = [];
	const oldLog = console.log;
	const oldWarn = console.warn;
	console.log = (...args) => logs.push(args.join(' '));
	console.warn = (...args) => warns.push(args.join(' '));

	const mock = await createMockServer();
	await setupDir('coclaw-cli-notify-fail-');

	const { spawn: failSpawn } = createMockSpawn({ fail: true });

	try {
		const code = await main(['bind', '12345678', '--server', mock.baseUrl], { spawn: failSpawn });
		assert.equal(code, 0);
		assert.equal(logs.some((line) => line.includes('bound to CoClaw')), true);
		assert.equal(warns.some((line) => line.includes('could not notify')), true);
	}
	finally {
		console.log = oldLog;
		console.warn = oldWarn;
		await mock.close();
	}
});

test('cli unbind success should notify gateway via RPC', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const logs = [];
	const oldLog = console.log;
	const oldWarn = console.warn;
	console.log = (...args) => logs.push(args.join(' '));
	console.warn = () => {};

	const mock = await createMockServer();
	const dir = await setupDir('coclaw-cli-unbind-notify-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	// 先 bind
	await main(['bind', '12345678', '--server', mock.baseUrl], { spawn: noopSpawn });
	logs.length = 0;

	const { spawn: mockSpawn, calls } = createMockSpawn();

	try {
		const code = await main(['unbind', '--server', mock.baseUrl], { spawn: mockSpawn });
		assert.equal(code, 0);
		assert.equal(calls.some((c) => c.includes('coclaw.stopBridge')), true);
		assert.equal(logs.some((line) => line.includes('Bridge connection')), true);
	}
	finally {
		console.log = oldLog;
		console.warn = oldWarn;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
		await mock.close();
	}
});

test('cli unbind success should warn when gateway notify fails', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const logs = [];
	const warns = [];
	const oldLog = console.log;
	const oldWarn = console.warn;
	console.log = (...args) => logs.push(args.join(' '));
	console.warn = (...args) => warns.push(args.join(' '));

	const mock = await createMockServer();
	const dir = await setupDir('coclaw-cli-unbind-notify-fail-');
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	// 先 bind
	await main(['bind', '12345678', '--server', mock.baseUrl], { spawn: noopSpawn });
	logs.length = 0;
	warns.length = 0;

	const { spawn: failSpawn } = createMockSpawn({ fail: true });

	try {
		const code = await main(['unbind', '--server', mock.baseUrl], { spawn: failSpawn });
		assert.equal(code, 0);
		assert.equal(logs.some((line) => line.includes('unbound from CoClaw')), true);
		assert.equal(warns.some((line) => line.includes('could not notify')), true);
	}
	finally {
		console.log = oldLog;
		console.warn = oldWarn;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
		await mock.close();
	}
});

test('cli unbind should return 1 when not bound', async () => {
	const errors = [];
	const oldLog = console.log;
	const oldErr = console.error;
	console.log = () => {};
	console.error = (...args) => errors.push(args.join(' '));

	await setupDir('coclaw-cli-unbind-notbound-');

	try {
		const code = await main(['unbind'], { spawn: noopSpawn });
		assert.equal(code, 1);
		assert.equal(errors.some((line) => line.includes('Not bound')), true);
	}
	finally {
		console.log = oldLog;
		console.error = oldErr;
	}
});

test('cli unbind should succeed with warning when server fails', async () => {
	const logs = [];
	const oldLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	const dir = await setupDir('coclaw-cli-unbind-rethrow-');
	// 有 token 但 server 不可达
	const bp = nodePath.join(dir, 'coclaw', 'bindings.json');
	await fs.mkdir(nodePath.dirname(bp), { recursive: true });
	await fs.writeFile(bp, JSON.stringify({ default: { botId: 'b1', token: 'tk', serverUrl: 'http://127.0.0.1:1' } }), 'utf8');

	try {
		const code = await main(['unbind', '--server', 'http://127.0.0.1:1'], { spawn: noopSpawn });
		assert.equal(code, 0);
		assert.ok(logs.some((l) => l.includes('unbound') && l.includes('server notification failed')));
	} finally {
		console.log = oldLog;
	}
});
