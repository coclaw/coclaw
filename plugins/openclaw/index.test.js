import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import plugin, { __resetPluginVersion } from './index.js';
import { createMockServer } from './src/mock-server.helper.js';
import { setRuntime } from './src/runtime.js';

/** 构造包含 runtime mock 的最小 api 对象 */
function createMockApi(handlers, extras = {}) {
	return {
		pluginConfig: {},
		runtime: {
			config: { loadConfig: () => ({}) },
			agent: { resolveAgentWorkspaceDir: () => '/tmp/mock-workspace' },
		},
		logger: { warn() {}, error() {}, log() {} },
		registerChannel() {},
		registerCommand(spec) { handlers.set('command', spec.handler); },
		registerCli() {},
		registerService() {},
		registerGatewayMethod(name, handler) { handlers.set(name, handler); },
		...extras,
	};
}

test('plugin register should register channel/command/cli/gateway methods', () => {
	const calls = {
		channel: 0,
		command: 0,
		cli: 0,
	};
	const handlers = new Map();
	let cliOpts = null;

	const serviceSpecs = [];
	plugin.register({
		pluginConfig: {},
		runtime: {
			config: { loadConfig: () => ({}) },
			agent: { resolveAgentWorkspaceDir: () => '/tmp/mock' },
		},
		logger: { warn() {}, error() {}, log() {} },
		registerChannel() {
			calls.channel += 1;
		},
		registerCommand(spec) {
			calls.command += 1;
			handlers.set('command', spec.handler);
		},
		registerCli(registrar, opts) {
			calls.cli += 1;
			cliOpts = opts;
		},
		registerService(spec) {
			serviceSpecs.push(spec);
		},
		registerGatewayMethod(name, handler) {
			handlers.set(name, handler);
		},
	});

	assert.equal(calls.channel, 1);
	assert.equal(calls.command, 1);
	assert.equal(calls.cli, 1);
	assert.deepEqual(cliOpts, { commands: ['coclaw'] });
	assert.equal(handlers.has('coclaw.info'), true);
	assert.equal(handlers.has('coclaw.info.get'), true);
	assert.equal(handlers.has('coclaw.info.patch'), true);
	assert.equal(handlers.has('coclaw.upgradeHealth'), true);
	assert.equal(handlers.has('nativeui.sessions.listAll'), true);
	assert.equal(handlers.has('nativeui.sessions.get'), true);
	assert.equal(handlers.has('coclaw.files.list'), true);
	assert.equal(handlers.has('coclaw.files.delete'), true);
	assert.equal(handlers.has('coclaw.files.mkdir'), true);
	assert.equal(handlers.has('coclaw.files.create'), true);
	assert.equal(typeof handlers.get('command'), 'function');
	const bridgeService = serviceSpecs.find(s => s.id === 'coclaw-realtime-bridge');
	const upgradeService = serviceSpecs.find(s => s.id === 'coclaw-auto-upgrade');
	assert.ok(bridgeService);
	assert.equal(typeof bridgeService.start, 'function');
	assert.equal(typeof bridgeService.stop, 'function');
	assert.ok(upgradeService);
	assert.equal(typeof upgradeService.start, 'function');
	assert.equal(typeof upgradeService.stop, 'function');
});

test('coclaw.info should return version and clawVersion', async () => {
	__resetPluginVersion();
	const handlers = new Map();
	const MOCK_CLAW_VERSION = '2026.3.14';
	plugin.register(createMockApi(handlers, {
		runtime: {
			version: MOCK_CLAW_VERSION,
			config: { loadConfig: () => ({}) },
			agent: { resolveAgentWorkspaceDir: () => '/tmp/mock' },
		},
	}));

	let infoOut = null;
	await handlers.get('coclaw.info')({
		respond(ok, payload) {
			infoOut = { ok, payload };
		},
	});
	assert.equal(infoOut.ok, true);
	assert.equal(typeof infoOut.payload.version, 'string');
	assert.equal(infoOut.payload.clawVersion, MOCK_CLAW_VERSION);
	assert.ok(Array.isArray(infoOut.payload.capabilities));
	assert.equal(typeof infoOut.payload.hostName, 'string');
	assert.ok(infoOut.payload.hostName.length > 0);
	// name 未设置时为 null
	assert.equal(infoOut.payload.name, null);
});

test('coclaw.info should omit clawVersion when runtime.version is absent', async () => {
	__resetPluginVersion();
	const handlers = new Map();
	plugin.register(createMockApi(handlers));

	let infoOut = null;
	await handlers.get('coclaw.info')({
		respond(ok, payload) {
			infoOut = { ok, payload };
		},
	});
	assert.equal(infoOut.ok, true);
	assert.equal(infoOut.payload.clawVersion, undefined);
});

test('coclaw.info should omit clawVersion when runtime.version is unknown', async () => {
	__resetPluginVersion();
	const handlers = new Map();
	plugin.register(createMockApi(handlers, {
		runtime: {
			version: 'unknown',
			config: { loadConfig: () => ({}) },
			agent: { resolveAgentWorkspaceDir: () => '/tmp/mock' },
		},
	}));

	let infoOut = null;
	await handlers.get('coclaw.info')({
		respond(ok, payload) {
			infoOut = { ok, payload };
		},
	});
	assert.equal(infoOut.ok, true);
	assert.equal(infoOut.payload.clawVersion, undefined);
});

test('coclaw.info.get should be an alias of coclaw.info', async () => {
	__resetPluginVersion();
	const handlers = new Map();
	plugin.register(createMockApi(handlers));

	let infoOut = null;
	await handlers.get('coclaw.info.get')({
		respond(ok, payload) {
			infoOut = { ok, payload };
		},
	});
	assert.equal(infoOut.ok, true);
	assert.equal(typeof infoOut.payload.version, 'string');
	assert.equal(typeof infoOut.payload.hostName, 'string');
});

test('coclaw.info.patch should set and return name', async () => {
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-info-patch-'));
	process.env.OPENCLAW_STATE_DIR = dir;
	setRuntime(null);

	const handlers = new Map();
	plugin.register(createMockApi(handlers));

	let out = null;
	await handlers.get('coclaw.info.patch')({
		params: { name: '  My Claw  ' },
		respond(ok, payload, error) {
			out = { ok, payload, error };
		},
	});
	assert.equal(out.ok, true);
	assert.equal(out.payload.name, 'My Claw');
	assert.equal(typeof out.payload.hostName, 'string');

	// 验证持久化：coclaw.info 应返回设置的名称
	__resetPluginVersion();
	let infoOut = null;
	await handlers.get('coclaw.info')({
		respond(ok, payload) {
			infoOut = { ok, payload };
		},
	});
	assert.equal(infoOut.payload.name, 'My Claw');
});

test('coclaw.info.patch should clear name when given empty string', async () => {
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-info-patch-'));
	process.env.OPENCLAW_STATE_DIR = dir;
	setRuntime(null);

	const handlers = new Map();
	plugin.register(createMockApi(handlers));

	// 先设置
	await handlers.get('coclaw.info.patch')({
		params: { name: 'Test' },
		respond() {},
	});

	// 再清除
	let out = null;
	await handlers.get('coclaw.info.patch')({
		params: { name: '' },
		respond(ok, payload) {
			out = { ok, payload };
		},
	});
	assert.equal(out.ok, true);
	assert.equal(out.payload.name, null);
});

test('coclaw.info.patch should clear name when given null', async () => {
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-info-patch-'));
	process.env.OPENCLAW_STATE_DIR = dir;
	setRuntime(null);

	const handlers = new Map();
	plugin.register(createMockApi(handlers));

	await handlers.get('coclaw.info.patch')({
		params: { name: 'Test' },
		respond() {},
	});

	let out = null;
	await handlers.get('coclaw.info.patch')({
		params: { name: null },
		respond(ok, payload) {
			out = { ok, payload };
		},
	});
	assert.equal(out.ok, true);
	assert.equal(out.payload.name, null);
});

test('coclaw.info.patch should reject missing name field', async () => {
	const handlers = new Map();
	plugin.register(createMockApi(handlers));

	let out = null;
	await handlers.get('coclaw.info.patch')({
		params: {},
		respond(ok, payload, error) {
			out = { ok, payload, error };
		},
	});
	assert.equal(out.ok, false);
	assert.ok(out.error.message.includes('required'));
});

test('coclaw.info.patch should reject undefined params', async () => {
	const handlers = new Map();
	plugin.register(createMockApi(handlers));

	let out = null;
	await handlers.get('coclaw.info.patch')({
		params: undefined,
		respond(ok, payload, error) {
			out = { ok, payload, error };
		},
	});
	assert.equal(out.ok, false);
	assert.ok(out.error.message.includes('required'));
});

test('coclaw.info.patch should reject name exceeding 63 chars', async () => {
	const handlers = new Map();
	plugin.register(createMockApi(handlers));

	let out = null;
	await handlers.get('coclaw.info.patch')({
		params: { name: 'a'.repeat(64) },
		respond(ok, payload, error) {
			out = { ok, payload, error };
		},
	});
	assert.equal(out.ok, false);
	assert.ok(out.error.message.includes('63'));
});

test('coclaw.info.patch should reject non-string name', async () => {
	const handlers = new Map();
	plugin.register(createMockApi(handlers));

	let out = null;
	await handlers.get('coclaw.info.patch')({
		params: { name: 123 },
		respond(ok, payload, error) {
			out = { ok, payload, error };
		},
	});
	assert.equal(out.ok, false);
	assert.ok(out.error.message.includes('string'));
});

test('gateway methods respond and catch errors', async () => {
	const handlers = new Map();
	plugin.register(createMockApi(handlers));

	let listOut = null;
	await handlers.get('nativeui.sessions.listAll')({
		params: {},
		respond(ok, payload) {
			listOut = { ok, payload };
		},
	});
	assert.equal(listOut.ok, true);
	await assert.rejects(() => handlers.get('nativeui.sessions.listAll')({
		params: {},
		respond() {
			throw new Error('respond failed');
		},
	}));

	let getOut = null;
	handlers.get('nativeui.sessions.get')({
		params: {},
		respond(ok, payload, error) {
			getOut = { ok, payload, error };
		},
	});
	assert.equal(getOut.ok, false);
	assert.equal(getOut.payload, undefined);
	assert.equal(typeof getOut.error?.message, 'string');

	let getOut2 = null;
	handlers.get('nativeui.sessions.get')({
		params: { sessionId: 1 },
		respond(ok, payload, error) {
			getOut2 = { ok, payload, error };
		},
	});
	assert.equal(getOut2.ok, false);

	// respondInvalid 覆盖：参数校验分支
	let invalidOut = null;
	handlers.get('coclaw.topics.get')({
		params: {},
		respond(ok, payload, error) {
			invalidOut = { ok, payload, error };
		},
	});
	assert.equal(invalidOut.ok, false);
	assert.equal(invalidOut.payload, undefined);
	assert.equal(invalidOut.error?.code, 'INVALID_INPUT');
	assert.equal(invalidOut.error?.message, 'topicId required');
});

test('command handler should cover help/unknown/error/success paths', async () => {
	const prevCwd = process.cwd();
	const prevHome = process.env.HOME;
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-index-'));
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.OPENCLAW_CONFIG_PATH = nodePath.join(dir, 'openclaw.json');
	await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, '{}', 'utf8');
	delete process.env.COCLAW_TUNNEL_CONFIG_PATH;
	setRuntime(null);
	process.env.HOME = nodePath.join(dir, 'home');
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const handlers = new Map();
	const mock = await createMockServer();
	try {
		plugin.register({
			pluginConfig: { serverUrl: mock.baseUrl, defaultName: 'd1' },
			logger: { warn() {}, error() {} },
			registerChannel() {},
			registerCli() {},
			registerService() {},
			registerGatewayMethod() {},
			registerCommand(spec) {
				handlers.set('command', spec.handler);
			},
		});
		const handler = handlers.get('command');
		const help = await handler({ args: 'help' });
		assert.equal(String(help.text).includes('/coclaw bind'), true);
		const unknown = await handler({ args: 'noop' });
		assert.equal(String(unknown.text).includes('/coclaw bind'), true);
		const failed = await handler({ args: 'bind' });
		assert.equal(String(failed.text).startsWith('Error:'), true);

		const bound = await handler({ args: 'bind 12345678 --name n1 --server ' + mock.baseUrl });
		assert.equal(String(bound.text).includes('bound to CoClaw'), true);
		const unbound = await handler({ args: 'unbind --server ' + mock.baseUrl });
		assert.equal(String(unbound.text).includes('unbound from CoClaw'), true);

		// 破坏 bindings 文件测试 service.start 容错（坏 JSON 应被容错删除，bridge 正常启动）
		const bindingsDir = nodePath.join(dir, 'coclaw');
		await fs.mkdir(bindingsDir, { recursive: true });
		const corruptPath = nodePath.join(bindingsDir, 'bindings.json');
		await fs.writeFile(corruptPath, '{bad', 'utf8');
		const svcs = [];
		plugin.register({
			pluginConfig: { serverUrl: mock.baseUrl },
			logger: { warn() {}, error() {}, log() {} },
			registerChannel() {},
			registerCli() {},
			registerService(spec) { svcs.push(spec); },
			registerGatewayMethod() {},
			registerCommand() {},
		});
		const bridgeSvc = svcs.find(s => s.id === 'coclaw-realtime-bridge');
		await bridgeSvc.start(); // 不应抛异常
		// 损坏文件应已被删除
		await assert.rejects(() => fs.access(corruptPath), { code: 'ENOENT' });
		await bridgeSvc.stop();
	}
	finally {
		process.chdir(prevCwd);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		await mock.close();
	}
});

// --- coclaw.files.* gateway methods ---

test('coclaw.files.list via gateway method', async () => {
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-files-'));
	try {
		await fs.writeFile(nodePath.join(dir, 'hello.txt'), 'hi', 'utf8');
		await fs.mkdir(nodePath.join(dir, 'sub'));

		const handlers = new Map();
		plugin.register(createMockApi(handlers, {
			runtime: {
				config: { loadConfig: () => ({}) },
				agent: { resolveAgentWorkspaceDir: () => dir },
			},
		}));

		let out = null;
		await handlers.get('coclaw.files.list')({
			params: { path: '.' },
			respond(ok, payload, error) { out = { ok, payload, error }; },
		});
		assert.equal(out.ok, true);
		assert.ok(Array.isArray(out.payload.files));
		const names = out.payload.files.map(f => f.name).sort();
		assert.ok(names.includes('hello.txt'));
		assert.ok(names.includes('sub'));
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('coclaw.files.mkdir via gateway method', async () => {
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-files-'));
	try {
		const handlers = new Map();
		plugin.register(createMockApi(handlers, {
			runtime: {
				config: { loadConfig: () => ({}) },
				agent: { resolveAgentWorkspaceDir: () => dir },
			},
		}));

		let out = null;
		await handlers.get('coclaw.files.mkdir')({
			params: { path: 'a/b/c' },
			respond(ok, payload, error) { out = { ok, payload, error }; },
		});
		assert.equal(out.ok, true);
		const stat = await fs.stat(nodePath.join(dir, 'a', 'b', 'c'));
		assert.ok(stat.isDirectory());
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('coclaw.files.create via gateway method', async () => {
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-files-'));
	try {
		const handlers = new Map();
		plugin.register(createMockApi(handlers, {
			runtime: {
				config: { loadConfig: () => ({}) },
				agent: { resolveAgentWorkspaceDir: () => dir },
			},
		}));

		let out = null;
		await handlers.get('coclaw.files.create')({
			params: { path: 'new.txt' },
			respond(ok, payload, error) { out = { ok, payload, error }; },
		});
		assert.equal(out.ok, true);
		const stat = await fs.stat(nodePath.join(dir, 'new.txt'));
		assert.ok(stat.isFile());
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('coclaw.files.delete via gateway method', async () => {
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-files-'));
	try {
		await fs.writeFile(nodePath.join(dir, 'del.txt'), 'bye', 'utf8');

		const handlers = new Map();
		plugin.register(createMockApi(handlers, {
			runtime: {
				config: { loadConfig: () => ({}) },
				agent: { resolveAgentWorkspaceDir: () => dir },
			},
		}));

		let out = null;
		await handlers.get('coclaw.files.delete')({
			params: { path: 'del.txt' },
			respond(ok, payload, error) { out = { ok, payload, error }; },
		});
		assert.equal(out.ok, true);
		await assert.rejects(() => fs.access(nodePath.join(dir, 'del.txt')), { code: 'ENOENT' });
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('coclaw.files.* gateway methods handle errors', async () => {
	const handlers = new Map();
	plugin.register(createMockApi(handlers, {
		runtime: {
			config: { loadConfig: () => ({}) },
			agent: { resolveAgentWorkspaceDir: () => '/nonexistent/workspace' },
		},
	}));

	// list 不存在的目录
	let out = null;
	await handlers.get('coclaw.files.list')({
		params: { path: 'nope' },
		respond(ok, payload, error) { out = { ok, payload, error }; },
	});
	assert.equal(out.ok, false);
	assert.ok(out.error?.code);

	// delete 不存在的文件
	let delOut = null;
	await handlers.get('coclaw.files.delete')({
		params: { path: 'nope.txt' },
		respond(ok, payload, error) { delOut = { ok, payload, error }; },
	});
	assert.equal(delOut.ok, false);

	// create 路径穿越
	let createOut = null;
	await handlers.get('coclaw.files.create')({
		params: { path: '../../../etc/evil' },
		respond(ok, payload, error) { createOut = { ok, payload, error }; },
	});
	assert.equal(createOut.ok, false);
	assert.equal(createOut.error?.code, 'PATH_DENIED');
});
