import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import { after, test } from 'node:test';

import plugin, { __resetPluginVersion } from './index.js';
import { createMockServer } from './src/mock-server.helper.js';
import { setRuntime } from './src/runtime.js';
import { stopRealtimeBridge } from './src/realtime-bridge.js';
import { __reset as __resetRemoteLogPlugin, __buffer as __remoteLogBuffer } from './src/remote-log.js';

// bridgeSvc.start() 触发真实 preloadNdc → initLogger TSFN，需在文件结束时清理
after(async () => {
	try { await stopRealtimeBridge({ forceCleanup: true }); } catch { /* best-effort */ }
	try {
		const ndc = await import('node-datachannel');
		const cleanup = ndc.cleanup ?? ndc.default?.cleanup;
		if (typeof cleanup === 'function') cleanup();
	} catch { /* ndc 未安装则无需 cleanup */ }
});

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
	assert.equal(handlers.has('coclaw.agent.abort'), true);
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
	process.env.OPENCLAW_STATE_DIR = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-info-'));
	setRuntime(null);
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
	process.env.OPENCLAW_STATE_DIR = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-info-'));
	setRuntime(null);
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
	process.env.OPENCLAW_STATE_DIR = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-info-'));
	setRuntime(null);
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
	process.env.OPENCLAW_STATE_DIR = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-info-'));
	setRuntime(null);
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

// --- coclaw.agent.abort gateway method ---

const EMBEDDED_RUN_STATE_KEY = Symbol.for('openclaw.embeddedRunState');

function withStubbedEmbeddedRunState(stub, fn) {
	const had = Object.prototype.hasOwnProperty.call(globalThis, EMBEDDED_RUN_STATE_KEY);
	const prev = globalThis[EMBEDDED_RUN_STATE_KEY];
	globalThis[EMBEDDED_RUN_STATE_KEY] = stub;
	try { return fn(); }
	finally {
		if (had) globalThis[EMBEDDED_RUN_STATE_KEY] = prev;
		else delete globalThis[EMBEDDED_RUN_STATE_KEY];
	}
}

test('coclaw.agent.abort rejects missing sessionId with INVALID_INPUT', () => {
	const handlers = new Map();
	plugin.register(createMockApi(handlers));
	let out = null;
	handlers.get('coclaw.agent.abort')({
		params: {},
		respond(ok, payload, error) { out = { ok, payload, error }; },
	});
	assert.equal(out.ok, false);
	assert.equal(out.error?.code, 'INVALID_INPUT');
});

test('coclaw.agent.abort rejects empty sessionId', () => {
	const handlers = new Map();
	plugin.register(createMockApi(handlers));
	let out = null;
	handlers.get('coclaw.agent.abort')({
		params: { sessionId: '' },
		respond(ok, payload, error) { out = { ok, payload, error }; },
	});
	assert.equal(out.ok, false);
	assert.equal(out.error?.code, 'INVALID_INPUT');
});

test('coclaw.agent.abort rejects non-string sessionId', () => {
	const handlers = new Map();
	plugin.register(createMockApi(handlers));
	let out = null;
	handlers.get('coclaw.agent.abort')({
		params: { sessionId: 123 },
		respond(ok, payload, error) { out = { ok, payload, error }; },
	});
	assert.equal(out.ok, false);
	assert.equal(out.error?.code, 'INVALID_INPUT');
});

test('coclaw.agent.abort returns not-supported when side door missing', () => {
	const handlers = new Map();
	plugin.register(createMockApi(handlers));
	let out = null;
	withStubbedEmbeddedRunState(undefined, () => {
		handlers.get('coclaw.agent.abort')({
			params: { sessionId: 'sid-1' },
			respond(ok, payload, error) { out = { ok, payload, error }; },
		});
	});
	assert.equal(out.ok, true);
	assert.deepEqual(out.payload, { ok: false, reason: 'not-supported' });
});

test('coclaw.agent.abort invokes handle.abort when side door supports sessionId', () => {
	const handlers = new Map();
	plugin.register(createMockApi(handlers));
	let aborted = 0;
	const handle = { abort: () => { aborted++; } };
	const state = { activeRuns: new Map([['sid-live', handle]]) };
	let out = null;
	withStubbedEmbeddedRunState(state, () => {
		handlers.get('coclaw.agent.abort')({
			params: { sessionId: 'sid-live' },
			respond(ok, payload, error) { out = { ok, payload, error }; },
		});
	});
	assert.equal(out.ok, true);
	assert.deepEqual(out.payload, { ok: true });
	assert.equal(aborted, 1);
});

test('coclaw.agent.abort returns not-found when sessionId not in activeRuns', () => {
	const handlers = new Map();
	plugin.register(createMockApi(handlers));
	const state = { activeRuns: new Map() };
	let out = null;
	withStubbedEmbeddedRunState(state, () => {
		handlers.get('coclaw.agent.abort')({
			params: { sessionId: 'sid-gone' },
			respond(ok, payload, error) { out = { ok, payload, error }; },
		});
	});
	assert.equal(out.ok, true);
	assert.deepEqual(out.payload, { ok: false, reason: 'not-found' });
});

test('coclaw.agent.abort handler catches respond() throw and reports INTERNAL_ERROR', () => {
	const handlers = new Map();
	const errorMsgs = [];
	const logger = { info() {}, warn() {}, error(m) { errorMsgs.push(m); }, log() {} };
	plugin.register(createMockApi(handlers, { logger }));
	let captured = null;
	let nthCall = 0;
	const respond = (ok, payload, error) => {
		nthCall++;
		if (nthCall === 1) throw new Error('respond-boom');
		captured = { ok, payload, error };
	};
	withStubbedEmbeddedRunState({ activeRuns: new Map() }, () => {
		handlers.get('coclaw.agent.abort')({
			params: { sessionId: 'sid-any' },
			respond,
		});
	});
	assert.equal(captured?.ok, false);
	assert.equal(captured?.error?.code, 'INTERNAL_ERROR');
	assert.match(String(captured?.error?.message), /respond-boom/);
	assert.ok(errorMsgs.some((m) => /handler threw.*respond-boom/.test(m)));
});

// --- installAbortRegistryDiag：productionalized monkey-patch 行为 ---

const REPLY_RUN_STATE_KEY = Symbol.for('openclaw.replyRunRegistry');

function withStubbedAllDiagState(embeddedStub, replyStub, fn) {
	const hadE = Object.prototype.hasOwnProperty.call(globalThis, EMBEDDED_RUN_STATE_KEY);
	const prevE = globalThis[EMBEDDED_RUN_STATE_KEY];
	const hadR = Object.prototype.hasOwnProperty.call(globalThis, REPLY_RUN_STATE_KEY);
	const prevR = globalThis[REPLY_RUN_STATE_KEY];
	globalThis[EMBEDDED_RUN_STATE_KEY] = embeddedStub;
	globalThis[REPLY_RUN_STATE_KEY] = replyStub;
	try { return fn(); }
	finally {
		if (hadE) globalThis[EMBEDDED_RUN_STATE_KEY] = prevE;
		else delete globalThis[EMBEDDED_RUN_STATE_KEY];
		if (hadR) globalThis[REPLY_RUN_STATE_KEY] = prevR;
		else delete globalThis[REPLY_RUN_STATE_KEY];
	}
}

test('installAbortRegistryDiag patches .set/.delete/.clear and reports installed to remoteLog', () => {
	__resetRemoteLogPlugin();
	const embedded = { activeRuns: new Map(), sessionIdsByKey: new Map() };
	const reply = { activeRunsByKey: new Map(), activeKeysBySessionId: new Map() };
	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: () => {}, error: () => {} };
	withStubbedAllDiagState(embedded, reply, () => {
		plugin.register(createMockApi(new Map(), { logger }));
	});
	// 安装日志应出现 4 个 label
	const installedLines = logs.filter((l) => /^\[coclaw\.diag\] installed/.test(l));
	assert.equal(installedLines.length, 4);
	// remoteLog 侧收到 abort.patch ok
	const patchLogs = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.patch'));
	assert.equal(patchLogs.length, 1);
	assert.match(patchLogs[0].text, /installed=embedded\.activeRuns,embedded\.sessionIdsByKey,reply\.activeRunsByKey,reply\.activeKeysBySessionId/);
	assert.match(patchLogs[0].text, /missing=none/);
	// 已 patch 的 Map 在后续 set/delete 时触发 info 日志
	embedded.activeRuns.set('sid-a', { abort: () => {} });
	embedded.activeRuns.delete('sid-a');
	embedded.activeRuns.clear();
	const setLines = logs.filter((l) => /embedded\.activeRuns\.set key=sid-a/.test(l));
	const delLines = logs.filter((l) => /embedded\.activeRuns\.delete key=sid-a had=true/.test(l));
	const clearLines = logs.filter((l) => /embedded\.activeRuns\.clear was=/.test(l));
	assert.equal(setLines.length, 1);
	assert.equal(delLines.length, 1);
	assert.equal(clearLines.length, 1);
});

test('installAbortRegistryDiag reports missing labels when side door partially absent', () => {
	__resetRemoteLogPlugin();
	// embedded.sessionIdsByKey 缺失、reply 全缺失
	const embedded = { activeRuns: new Map() };
	withStubbedAllDiagState(embedded, undefined, () => {
		plugin.register(createMockApi(new Map()));
	});
	const patchLogs = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.patch'));
	assert.equal(patchLogs.length, 1);
	assert.match(patchLogs[0].text, /installed=embedded\.activeRuns/);
	assert.match(patchLogs[0].text, /missing=embedded\.sessionIdsByKey,reply\.activeRunsByKey,reply\.activeKeysBySessionId/);
});

test('installAbortRegistryDiag skips already-patched Map (idempotent across register)', () => {
	__resetRemoteLogPlugin();
	const embedded = { activeRuns: new Map(), sessionIdsByKey: new Map() };
	const reply = { activeRunsByKey: new Map(), activeKeysBySessionId: new Map() };
	// 首次注册
	withStubbedAllDiagState(embedded, reply, () => {
		plugin.register(createMockApi(new Map()));
	});
	const origSet = embedded.activeRuns.set;
	// 再次注册——patch 应跳过（__coclawDiagPatched 守卫），但依然报告 installed
	withStubbedAllDiagState(embedded, reply, () => {
		plugin.register(createMockApi(new Map()));
	});
	assert.equal(embedded.activeRuns.set, origSet);
	// remoteLog 累计 2 条 abort.patch
	const patchLogs = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.patch'));
	assert.equal(patchLogs.length, 2);
	assert.match(patchLogs[1].text, /installed=embedded\.activeRuns/);
});

test('installAbortRegistryDiag catches throw during symbol resolve and emits patch-failed', () => {
	__resetRemoteLogPlugin();
	// 构造一个 reply state，访问 activeRunsByKey 时抛异常——捕获后走 remoteLog patch-failed 路径
	const embedded = { activeRuns: new Map(), sessionIdsByKey: new Map() };
	const evilReply = {
		get activeRunsByKey() { throw new Error('reply-boom'); },
		activeKeysBySessionId: new Map(),
	};
	const warns = [];
	const logger = { info: () => {}, warn: (m) => warns.push(m), error: () => {}, log: () => {} };
	withStubbedAllDiagState(embedded, evilReply, () => {
		plugin.register(createMockApi(new Map(), { logger }));
	});
	const failedLogs = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.patch-failed'));
	assert.equal(failedLogs.length, 1);
	assert.match(failedLogs[0].text, /reason=reply-boom/);
	assert.ok(warns.some((w) => /installAbortRegistryDiag failed/.test(w)));
});

test('installAbortRegistryDiag stringifies non-string Map keys in .set log', () => {
	__resetRemoteLogPlugin();
	const embedded = { activeRuns: new Map(), sessionIdsByKey: new Map() };
	const reply = { activeRunsByKey: new Map(), activeKeysBySessionId: new Map() };
	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: () => {}, error: () => {} };
	withStubbedAllDiagState(embedded, reply, () => {
		plugin.register(createMockApi(new Map(), { logger }));
	});
	// 非字符串 key（对象）
	embedded.activeRuns.set({ x: 1 }, { abort: () => {} });
	// 循环引用，JSON.stringify 抛 → 回退 String(k)
	const circular = {};
	circular.self = circular;
	embedded.activeRuns.set(circular, { abort: () => {} });
	const setLines = logs.filter((l) => /embedded\.activeRuns\.set/.test(l));
	assert.ok(setLines.some((l) => /key=\{"x":1\}/.test(l)));
	assert.ok(setLines.some((l) => /key=\[object Object\]/.test(l)));
});

test('installAbortRegistryDiag does not patch maps lacking .delete (typeof guard)', () => {
	__resetRemoteLogPlugin();
	// activeRuns 缺 .delete → 守卫生效、missing 中包含
	const embedded = {
		activeRuns: { set: () => {}, delete: null },
		sessionIdsByKey: new Map(),
	};
	const reply = { activeRunsByKey: new Map(), activeKeysBySessionId: new Map() };
	withStubbedAllDiagState(embedded, reply, () => {
		plugin.register(createMockApi(new Map()));
	});
	const patchLogs = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.patch'));
	assert.match(patchLogs[0].text, /missing=embedded\.activeRuns/);
});

test('patchMapLogging defineProperty 抛异常时 → 返回 false 不留半装 wrapper', () => {
	__resetRemoteLogPlugin();
	// 用 Object.freeze 模拟无法定义新属性的 Map（frozen Map 仍有 set/delete 但属性不可扩展）
	const m = new Map();
	const origSet = m.set;
	const origDel = m.delete;
	Object.freeze(m);
	const embedded = { activeRuns: m, sessionIdsByKey: new Map() };
	const reply = { activeRunsByKey: new Map(), activeKeysBySessionId: new Map() };
	const warns = [];
	const logger = { info() {}, warn(msg) { warns.push(msg); }, error() {}, log() {} };
	withStubbedAllDiagState(embedded, reply, () => {
		plugin.register(createMockApi(new Map(), { logger }));
	});
	// frozen map 应被报告为 missing（patch 失败时的兜底归类）
	const patchLogs = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.patch'));
	assert.match(patchLogs[0].text, /missing=embedded\.activeRuns/);
	// .set / .delete 引用未被覆盖
	assert.equal(m.set, origSet);
	assert.equal(m.delete, origDel);
	assert.ok(warns.some((w) => /cannot mark embedded\.activeRuns patched/.test(w)));
});

test('patchMapLogging size getter 抛异常时不阻断 .set/.delete 主流程', () => {
	__resetRemoteLogPlugin();
	// 模拟 OpenClaw 升级后用类似 Proxy 的实现：size 是 throwing getter
	const realMap = new Map();
	let throwing = false;
	const proxyMap = new Proxy(realMap, {
		get(target, prop) {
			if (prop === 'size' && throwing) throw new Error('size-boom');
			const v = target[prop];
			return typeof v === 'function' ? v.bind(target) : v;
		},
	});
	const embedded = { activeRuns: proxyMap, sessionIdsByKey: new Map() };
	withStubbedAllDiagState(embedded, undefined, () => {
		plugin.register(createMockApi(new Map()));
	});
	throwing = true;
	// 即使 size 抛异常，set/delete 主流程不能被诊断 log 带崩
	const handle = { abort: () => {} };
	assert.doesNotThrow(() => proxyMap.set('sid-x', handle));
	assert.equal(realMap.get('sid-x'), handle);
	assert.doesNotThrow(() => proxyMap.delete('sid-x'));
	assert.equal(realMap.has('sid-x'), false);
});

test('patchMapLogging logger.info 抛异常时不阻断 .set 主流程', () => {
	__resetRemoteLogPlugin();
	const embedded = { activeRuns: new Map(), sessionIdsByKey: new Map() };
	const evilLogger = {
		info: () => { throw new Error('logger-boom'); },
		warn: () => {},
		error: () => {},
		log: () => {},
	};
	withStubbedAllDiagState(embedded, undefined, () => {
		plugin.register(createMockApi(new Map(), { logger: evilLogger }));
	});
	const handle = { abort: () => {} };
	// patch 后 .set 内的 logger.info 抛异常，但 set 本身仍要返回 origSet 的结果
	const ret = embedded.activeRuns.set('sid-y', handle);
	assert.equal(ret, embedded.activeRuns);
	assert.equal(embedded.activeRuns.get('sid-y'), handle);
});

test('coclaw.agent.abort emits abort.request and abort.success remoteLog on hit', () => {
	__resetRemoteLogPlugin();
	const handlers = new Map();
	plugin.register(createMockApi(handlers));
	const handle = { abort: () => {} };
	const state = { activeRuns: new Map([['sid-hit', handle]]) };
	withStubbedEmbeddedRunState(state, () => {
		handlers.get('coclaw.agent.abort')({
			params: { sessionId: 'sid-hit' },
			respond() {},
		});
	});
	const relevant = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.'));
	assert.ok(relevant.some((r) => r.text === 'abort.request sid=sid-hit'));
	assert.ok(relevant.some((r) => r.text === 'abort.success sid=sid-hit'));
});

test('coclaw.agent.abort emits abort.not-supported remoteLog when side door absent', () => {
	__resetRemoteLogPlugin();
	const handlers = new Map();
	plugin.register(createMockApi(handlers));
	withStubbedEmbeddedRunState(undefined, () => {
		handlers.get('coclaw.agent.abort')({
			params: { sessionId: 'sid-x' },
			respond() {},
		});
	});
	const rel = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.'));
	assert.ok(rel.some((r) => r.text === 'abort.request sid=sid-x'));
	assert.ok(rel.some((r) => r.text === 'abort.not-supported sid=sid-x'));
});

test('coclaw.agent.abort emits abort.request only (no success/not-supported) on not-found miss', () => {
	__resetRemoteLogPlugin();
	const handlers = new Map();
	plugin.register(createMockApi(handlers));
	withStubbedEmbeddedRunState({ activeRuns: new Map() }, () => {
		handlers.get('coclaw.agent.abort')({
			params: { sessionId: 'sid-miss' },
			respond() {},
		});
	});
	const rel = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.') && /sid-miss/.test(r.text));
	assert.equal(rel.length, 1);
	assert.equal(rel[0].text, 'abort.request sid=sid-miss');
});

test('coclaw.agent.abort skips remoteLog for invalid sessionId', () => {
	__resetRemoteLogPlugin();
	const handlers = new Map();
	plugin.register(createMockApi(handlers));
	handlers.get('coclaw.agent.abort')({
		params: {},
		respond() {},
	});
	const rel = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.request') || r.text.startsWith('abort.success'));
	assert.equal(rel.length, 0);
});
