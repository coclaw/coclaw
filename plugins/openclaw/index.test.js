import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import { after, test } from 'node:test';

import plugin, { __resetPluginVersion } from './index.js';
import { createMockServer } from './src/mock-server.helper.js';
import { setRuntime, getRuntime } from './src/runtime.js';
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

/** 构造包含 runtime mock 的最小 api 对象（默认 full 模式，触发完整 register 副作用） */
function createMockApi(handlers, extras = {}) {
	return {
		registrationMode: 'full',
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
		registrationMode: 'full',
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
	assert.equal(getOut.error?.code, 'INVALID_INPUT');
	assert.equal(getOut.error?.message, 'sessionId required');

	let getOut2 = null;
	handlers.get('nativeui.sessions.get')({
		params: { sessionId: 1 },
		respond(ok, payload, error) {
			getOut2 = { ok, payload, error };
		},
	});
	assert.equal(getOut2.ok, false);
	assert.equal(getOut2.error?.code, 'INVALID_INPUT');

	// 空字符串 / 仅空白 也走 INVALID_INPUT（防 manager 抛 INTERNAL_ERROR）
	let getOut3 = null;
	handlers.get('nativeui.sessions.get')({
		params: { sessionId: '   ' },
		respond(ok, payload, error) {
			getOut3 = { ok, payload, error };
		},
	});
	assert.equal(getOut3.ok, false);
	assert.equal(getOut3.error?.code, 'INVALID_INPUT');

	// coclaw.bind / coclaw.unbind / coclaw.enroll 类型校验
	let bindOut = null;
	await handlers.get('coclaw.bind')({
		params: { code: 12345 },
		respond(ok, payload, error) { bindOut = { ok, payload, error }; },
	});
	assert.equal(bindOut.ok, false);
	assert.equal(bindOut.error?.code, 'INVALID_INPUT');
	assert.equal(bindOut.error?.message, 'code must be a non-empty string');

	let bindOut2 = null;
	await handlers.get('coclaw.bind')({
		params: { code: 'abc', serverUrl: 123 },
		respond(ok, payload, error) { bindOut2 = { ok, payload, error }; },
	});
	assert.equal(bindOut2.ok, false);
	assert.equal(bindOut2.error?.code, 'INVALID_INPUT');
	assert.equal(bindOut2.error?.message, 'serverUrl must be a non-empty string');

	let unbindOut = null;
	await handlers.get('coclaw.unbind')({
		params: { serverUrl: 123 },
		respond(ok, payload, error) { unbindOut = { ok, payload, error }; },
	});
	assert.equal(unbindOut.ok, false);
	assert.equal(unbindOut.error?.code, 'INVALID_INPUT');

	let enrollOut = null;
	await handlers.get('coclaw.enroll')({
		params: { serverUrl: {} },
		respond(ok, payload, error) { enrollOut = { ok, payload, error }; },
	});
	assert.equal(enrollOut.ok, false);
	assert.equal(enrollOut.error?.code, 'INVALID_INPUT');

	// coclaw.bind / coclaw.unbind / coclaw.enroll 拒绝空字符串 serverUrl：
	// 否则 "" 通过 typeof 校验，?? 不回退（"" 非 nullish），最终 unbindClaw 内
	// `if (baseUrl)` 为 false → 跳过 server 端解绑 → 清本地 config → 孤儿 bot
	let bindEmptyOut = null;
	await handlers.get('coclaw.bind')({
		params: { code: 'abc', serverUrl: '' },
		respond(ok, payload, error) { bindEmptyOut = { ok, payload, error }; },
	});
	assert.equal(bindEmptyOut.ok, false);
	assert.equal(bindEmptyOut.error?.code, 'INVALID_INPUT');
	assert.equal(bindEmptyOut.error?.message, 'serverUrl must be a non-empty string');

	let unbindEmptyOut = null;
	await handlers.get('coclaw.unbind')({
		params: { serverUrl: '' },
		respond(ok, payload, error) { unbindEmptyOut = { ok, payload, error }; },
	});
	assert.equal(unbindEmptyOut.ok, false);
	assert.equal(unbindEmptyOut.error?.code, 'INVALID_INPUT');
	assert.equal(unbindEmptyOut.error?.message, 'serverUrl must be a non-empty string');

	let enrollEmptyOut = null;
	await handlers.get('coclaw.enroll')({
		params: { serverUrl: '' },
		respond(ok, payload, error) { enrollEmptyOut = { ok, payload, error }; },
	});
	assert.equal(enrollEmptyOut.ok, false);
	assert.equal(enrollEmptyOut.error?.code, 'INVALID_INPUT');
	assert.equal(enrollEmptyOut.error?.message, 'serverUrl must be a non-empty string');

	// 纯空白 serverUrl 同样拒绝：否则 "   " 通过 length 校验、落到 new URL() 抛
	// Invalid URL → 用户看到 INTERNAL_ERROR 而不是 INVALID_INPUT
	let bindWsOut = null;
	await handlers.get('coclaw.bind')({
		params: { code: 'abc', serverUrl: '   ' },
		respond(ok, payload, error) { bindWsOut = { ok, payload, error }; },
	});
	assert.equal(bindWsOut.ok, false);
	assert.equal(bindWsOut.error?.code, 'INVALID_INPUT');
	assert.equal(bindWsOut.error?.message, 'serverUrl must be a non-empty string');

	let unbindWsOut = null;
	await handlers.get('coclaw.unbind')({
		params: { serverUrl: '\t\n ' },
		respond(ok, payload, error) { unbindWsOut = { ok, payload, error }; },
	});
	assert.equal(unbindWsOut.ok, false);
	assert.equal(unbindWsOut.error?.code, 'INVALID_INPUT');
	assert.equal(unbindWsOut.error?.message, 'serverUrl must be a non-empty string');

	let enrollWsOut = null;
	await handlers.get('coclaw.enroll')({
		params: { serverUrl: '  ' },
		respond(ok, payload, error) { enrollWsOut = { ok, payload, error }; },
	});
	assert.equal(enrollWsOut.ok, false);
	assert.equal(enrollWsOut.error?.code, 'INVALID_INPUT');
	assert.equal(enrollWsOut.error?.message, 'serverUrl must be a non-empty string');

	// coclaw.topics.update：不存在的 topic 应返回 NOT_FOUND（而非 INTERNAL_ERROR）
	let topicUpdOut = null;
	await handlers.get('coclaw.topics.update')({
		params: { topicId: 'topic-does-not-exist', changes: { title: 'x' } },
		respond(ok, payload, error) { topicUpdOut = { ok, payload, error }; },
	});
	assert.equal(topicUpdOut.ok, false);
	assert.equal(topicUpdOut.error?.code, 'NOT_FOUND');

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

test('coclaw.bind 与 coclaw.unbind 进入时取消进行中的 enroll', async () => {
	const prevCwd = process.cwd();
	const prevHome = process.env.HOME;
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'coclaw-cancel-enroll-'));
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.OPENCLAW_CONFIG_PATH = nodePath.join(dir, 'openclaw.json');
	await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, '{}', 'utf8');
	process.env.HOME = nodePath.join(dir, 'home');
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);
	setRuntime(null);

	// waitDelayMs=10000：claim-codes/wait 不会在测试期间返回，确保 activeEnrollAbort 一直保留
	const mock = await createMockServer({ waitDelayMs: 10_000 });
	const infoLogs = [];
	const handlers = new Map();
	plugin.register({
		registrationMode: 'full',
		pluginConfig: { serverUrl: mock.baseUrl },
		logger: {
			info(msg) { infoLogs.push(String(msg)); },
			warn() {},
			error() {},
		},
		registerChannel() {},
		registerCli() {},
		registerService() {},
		registerCommand() {},
		registerGatewayMethod(name, handler) { handlers.set(name, handler); },
	});

	try {
		// 1) enroll → 立即返回 code，后台 wait 因 mock 延迟而挂起
		await new Promise((resolve) => {
			handlers.get('coclaw.enroll')({
				params: { serverUrl: mock.baseUrl },
				respond() { resolve(); },
			});
		});
		assert.equal(
			infoLogs.some((l) => l.includes('cancelling active enroll')),
			false,
			'enroll 自身不应触发 cancel（无前置）',
		);

		// 2) bind 进入应取消该 enroll
		await new Promise((resolve) => {
			handlers.get('coclaw.bind')({
				params: { code: '12345678', serverUrl: mock.baseUrl },
				respond() { resolve(); },
			});
		});
		assert.equal(
			infoLogs.filter((l) => l.includes('cancelling active enroll')).length,
			1,
			'bind 应取消进行中的 enroll',
		);

		// 3) 再发起 enroll，然后 unbind 也应取消之
		await new Promise((resolve) => {
			handlers.get('coclaw.enroll')({
				params: { serverUrl: mock.baseUrl },
				respond() { resolve(); },
			});
		});
		await new Promise((resolve) => {
			handlers.get('coclaw.unbind')({
				params: { serverUrl: mock.baseUrl },
				respond() { resolve(); },
			});
		});
		assert.equal(
			infoLogs.filter((l) => l.includes('cancelling active enroll')).length,
			2,
			'unbind 应取消进行中的 enroll',
		);
	}
	finally {
		await stopRealtimeBridge({ forceCleanup: true }).catch(() => {});
		process.chdir(prevCwd);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		await mock.close();
	}
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
			registrationMode: 'full',
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
			registrationMode: 'full',
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

function withStubbedDiagState(embeddedStub, fn) {
	const hadE = Object.prototype.hasOwnProperty.call(globalThis, EMBEDDED_RUN_STATE_KEY);
	const prevE = globalThis[EMBEDDED_RUN_STATE_KEY];
	globalThis[EMBEDDED_RUN_STATE_KEY] = embeddedStub;
	try { return fn(); }
	finally {
		if (hadE) globalThis[EMBEDDED_RUN_STATE_KEY] = prevE;
		else delete globalThis[EMBEDDED_RUN_STATE_KEY];
	}
}

test('installAbortRegistryDiag patches .set/.delete and reports installed to remoteLog', () => {
	__resetRemoteLogPlugin();
	const embedded = { activeRuns: new Map() };
	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: () => {}, error: () => {} };
	withStubbedDiagState(embedded, () => {
		plugin.register(createMockApi(new Map(), { logger }));
	});
	// remoteLog 侧收到 abort.patch ok（仅 embedded.activeRuns 一个 label）
	const patchLogs = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.patch'));
	assert.equal(patchLogs.length, 1);
	assert.match(patchLogs[0].text, /installed=embedded\.activeRuns/);
	assert.match(patchLogs[0].text, /missing=none/);
	// 已 patch 的 Map 在后续 set/delete 时触发 info 日志
	embedded.activeRuns.set('sid-a', { abort: () => {} });
	embedded.activeRuns.delete('sid-a');
	const setLines = logs.filter((l) => /embedded\.activeRuns\.set key=sid-a/.test(l));
	const delLines = logs.filter((l) => /embedded\.activeRuns\.delete key=sid-a had=true/.test(l));
	assert.equal(setLines.length, 1);
	assert.equal(delLines.length, 1);
});

test('installAbortRegistryDiag reports missing label when side door absent', () => {
	__resetRemoteLogPlugin();
	withStubbedDiagState(undefined, () => {
		plugin.register(createMockApi(new Map()));
	});
	const patchLogs = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.patch'));
	assert.equal(patchLogs.length, 1);
	assert.match(patchLogs[0].text, /installed=none/);
	assert.match(patchLogs[0].text, /missing=embedded\.activeRuns/);
});

test('installAbortRegistryDiag skips already-patched Map (idempotent across register)', () => {
	__resetRemoteLogPlugin();
	const embedded = { activeRuns: new Map() };
	// 首次注册
	withStubbedDiagState(embedded, () => {
		plugin.register(createMockApi(new Map()));
	});
	const origSet = embedded.activeRuns.set;
	// 再次注册——patch 应跳过（__coclawDiagPatched 守卫），但依然报告 installed
	withStubbedDiagState(embedded, () => {
		plugin.register(createMockApi(new Map()));
	});
	assert.equal(embedded.activeRuns.set, origSet);
	const patchLogs = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.patch'));
	assert.equal(patchLogs.length, 2);
	assert.match(patchLogs[1].text, /installed=embedded\.activeRuns/);
});

test('installAbortRegistryDiag catches throw during symbol resolve and emits patch-failed', () => {
	__resetRemoteLogPlugin();
	// 构造一个 embedded state，访问 activeRuns 时抛异常——捕获后走 remoteLog patch-failed 路径
	const evilEmbedded = {
		get activeRuns() { throw new Error('embedded-boom'); },
	};
	const warns = [];
	const logger = { info: () => {}, warn: (m) => warns.push(m), error: () => {}, log: () => {} };
	withStubbedDiagState(evilEmbedded, () => {
		plugin.register(createMockApi(new Map(), { logger }));
	});
	const failedLogs = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.patch-failed'));
	assert.equal(failedLogs.length, 1);
	assert.match(failedLogs[0].text, /reason=embedded-boom/);
	assert.ok(warns.some((w) => /installAbortRegistryDiag failed/.test(w)));
});

test('installAbortRegistryDiag stringifies non-string Map keys in .set log', () => {
	__resetRemoteLogPlugin();
	const embedded = { activeRuns: new Map() };
	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: () => {}, error: () => {} };
	withStubbedDiagState(embedded, () => {
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

test('installAbortRegistryDiag does not patch map lacking .delete (typeof guard)', () => {
	__resetRemoteLogPlugin();
	// activeRuns 缺 .delete → 守卫生效、missing 中包含
	const embedded = {
		activeRuns: { set: () => {}, delete: null },
	};
	withStubbedDiagState(embedded, () => {
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
	const embedded = { activeRuns: m };
	const warns = [];
	const logger = { info() {}, warn(msg) { warns.push(msg); }, error() {}, log() {} };
	withStubbedDiagState(embedded, () => {
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
	const embedded = { activeRuns: proxyMap };
	withStubbedDiagState(embedded, () => {
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
	const embedded = { activeRuns: new Map() };
	const evilLogger = {
		info: () => { throw new Error('logger-boom'); },
		warn: () => {},
		error: () => {},
		log: () => {},
	};
	withStubbedDiagState(embedded, () => {
		plugin.register(createMockApi(new Map(), { logger: evilLogger }));
	});
	const handle = { abort: () => {} };
	// patch 后 .set 内的 logger.info 抛异常，但 set 本身仍要返回 origSet 的结果
	const ret = embedded.activeRuns.set('sid-y', handle);
	assert.equal(ret, embedded.activeRuns);
	assert.equal(embedded.activeRuns.get('sid-y'), handle);
});

test('coclaw.agent.abort emits abort.success remoteLog on hit', () => {
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
	const relevant = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.') && /sid-hit/.test(r.text));
	assert.equal(relevant.length, 1);
	assert.equal(relevant[0].text, 'abort.success sid=sid-hit');
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
	const rel = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.') && /sid-x/.test(r.text));
	assert.equal(rel.length, 1);
	assert.equal(rel[0].text, 'abort.not-supported sid=sid-x');
});

test('coclaw.agent.abort emits no remoteLog on not-found miss (UI 重试期常态)', () => {
	__resetRemoteLogPlugin();
	const handlers = new Map();
	const infos = [];
	const logger = { info: (m) => infos.push(m), warn() {}, error() {}, log() {} };
	plugin.register(createMockApi(handlers, { logger }));
	withStubbedEmbeddedRunState({ activeRuns: new Map() }, () => {
		handlers.get('coclaw.agent.abort')({
			params: { sessionId: 'sid-miss' },
			respond() {},
		});
	});
	// not-found 不打 remoteLog，避免重试期间噪音
	const rel = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.') && /sid-miss/.test(r.text));
	assert.equal(rel.length, 0);
	// 同样不打 [coclaw.agent.abort] result info 日志
	assert.ok(!infos.some((m) => /\[coclaw\.agent\.abort\] result.*sid-miss/.test(m)));
});

test('coclaw.agent.abort logs result info for ok=true / not-supported / abort-threw', () => {
	__resetRemoteLogPlugin();
	const handlers = new Map();
	const infos = [];
	const logger = { info: (m) => infos.push(m), warn() {}, error() {}, log() {} };
	plugin.register(createMockApi(handlers, { logger }));
	const handle = { abort: () => {} };
	withStubbedEmbeddedRunState({ activeRuns: new Map([['sid-ok', handle]]) }, () => {
		handlers.get('coclaw.agent.abort')({ params: { sessionId: 'sid-ok' }, respond() {} });
	});
	withStubbedEmbeddedRunState(undefined, () => {
		handlers.get('coclaw.agent.abort')({ params: { sessionId: 'sid-ns' }, respond() {} });
	});
	const throwHandle = { abort: () => { throw new Error('boom'); } };
	withStubbedEmbeddedRunState({ activeRuns: new Map([['sid-thr', throwHandle]]) }, () => {
		handlers.get('coclaw.agent.abort')({ params: { sessionId: 'sid-thr' }, respond() {} });
	});
	assert.ok(infos.some((m) => /result sessionId=sid-ok ok=true/.test(m)));
	assert.ok(infos.some((m) => /result sessionId=sid-ns ok=false reason=not-supported/.test(m)));
	assert.ok(infos.some((m) => /result sessionId=sid-thr ok=false reason=abort-threw error=boom/.test(m)));
});

test('coclaw.agent.abort skips remoteLog for invalid sessionId', () => {
	__resetRemoteLogPlugin();
	const handlers = new Map();
	plugin.register(createMockApi(handlers));
	handlers.get('coclaw.agent.abort')({
		params: {},
		respond() {},
	});
	const rel = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.success') || r.text.startsWith('abort.not-supported'));
	assert.equal(rel.length, 0);
});

// --- coclaw.agent.abort heuristic gone fallback (Phase B) ---

test('coclaw.agent.abort upgrades not-found to gone when both duration gates met', () => {
	__resetRemoteLogPlugin();
	const handlers = new Map();
	const infos = [];
	const logger = { info: (m) => infos.push(m), warn() {}, error() {}, log() {} };
	plugin.register(createMockApi(handlers, { logger }));
	let out = null;
	withStubbedEmbeddedRunState({ activeRuns: new Map() }, () => {
		handlers.get('coclaw.agent.abort')({
			params: { sessionId: 'sid-gone', runDuration: 3 * 60 * 1000, abortDuration: 60 * 1000 },
			respond(ok, payload, error) { out = { ok, payload, error }; },
		});
	});
	assert.equal(out.ok, true);
	assert.deepEqual(out.payload, { ok: false, reason: 'gone' });
	const rel = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.gone'));
	assert.equal(rel.length, 1);
	assert.equal(rel[0].text, 'abort.gone sid=sid-gone runDur=180000 abortDur=60000');
	assert.ok(infos.some((m) => /result sessionId=sid-gone ok=false reason=gone/.test(m)));
});

test('coclaw.agent.abort stays not-found when only run gate met (abort gate shy)', () => {
	__resetRemoteLogPlugin();
	const handlers = new Map();
	plugin.register(createMockApi(handlers));
	let out = null;
	withStubbedEmbeddedRunState({ activeRuns: new Map() }, () => {
		handlers.get('coclaw.agent.abort')({
			params: { sessionId: 'sid-half', runDuration: 5 * 60 * 1000, abortDuration: 30 * 1000 },
			respond(ok, payload, error) { out = { ok, payload, error }; },
		});
	});
	assert.equal(out.ok, true);
	assert.deepEqual(out.payload, { ok: false, reason: 'not-found' });
	// not-found 仍走静默路径——单闸命中不应升格、不应噪音上报
	const rel = __remoteLogBuffer.filter((r) => /sid-half/.test(r.text));
	assert.equal(rel.length, 0);
});

test('coclaw.agent.abort stays not-found when old UI omits durations (backward compat)', () => {
	__resetRemoteLogPlugin();
	const handlers = new Map();
	plugin.register(createMockApi(handlers));
	let out = null;
	withStubbedEmbeddedRunState({ activeRuns: new Map() }, () => {
		handlers.get('coclaw.agent.abort')({
			params: { sessionId: 'sid-old' },
			respond(ok, payload, error) { out = { ok, payload, error }; },
		});
	});
	assert.equal(out.ok, true);
	assert.deepEqual(out.payload, { ok: false, reason: 'not-found' });
	const rel = __remoteLogBuffer.filter((r) => /sid-old/.test(r.text));
	assert.equal(rel.length, 0);
});

test('coclaw.agent.abort treats non-numeric durations as undefined (no leak into log)', () => {
	__resetRemoteLogPlugin();
	const handlers = new Map();
	plugin.register(createMockApi(handlers));
	let out = null;
	withStubbedEmbeddedRunState({ activeRuns: new Map() }, () => {
		handlers.get('coclaw.agent.abort')({
			// 模拟旧 UI 误传字符串 / 中间件改写：handler 必须当作 undefined 处理而非 NaN 或字面值
			params: { sessionId: 'sid-bad', runDuration: '3min', abortDuration: null },
			respond(ok, payload, error) { out = { ok, payload, error }; },
		});
	});
	assert.equal(out.ok, true);
	assert.deepEqual(out.payload, { ok: false, reason: 'not-found' });
	// 非数字 durations 不应升格 → 不应有 abort.gone 字符串污染（防止 'runDur=null' / 'runDur=NaN' 之类脏值进 remoteLog）
	const rel = __remoteLogBuffer.filter((r) => /sid-bad/.test(r.text));
	assert.equal(rel.length, 0);
});

test('coclaw.agent.abort cross-tick progression: stays not-found until both gates met then upgrades to gone', () => {
	__resetRemoteLogPlugin();
	const handlers = new Map();
	const infos = [];
	const logger = { info: (m) => infos.push(m), warn() {}, error() {}, log() {} };
	plugin.register(createMockApi(handlers, { logger }));
	const handler = handlers.get('coclaw.agent.abort');
	// 模拟 UI 持续 500ms tick：sessionId 始终未注册（注册空窗），runDuration / abortDuration 单调增长
	const ticks = [
		{ runDuration: 0, abortDuration: 0 },                // t=0
		{ runDuration: 30 * 1000, abortDuration: 30 * 1000 },// t=30s 双闸都未达
		{ runDuration: 3 * 60 * 1000, abortDuration: 30 * 1000 }, // t=3min run 达 abort 未达
		{ runDuration: 4 * 60 * 1000, abortDuration: 60 * 1000 }, // 双闸都达 → 升格 gone
	];
	const outs = [];
	withStubbedEmbeddedRunState({ activeRuns: new Map() }, () => {
		for (const t of ticks) {
			let out = null;
			handler({
				params: { sessionId: 'sid-progress', ...t },
				respond(ok, payload, error) { out = { ok, payload, error }; },
			});
			outs.push(out);
		}
	});
	// 前 3 tick 都是 not-found，最后一 tick 升格 gone
	assert.deepEqual(outs[0].payload, { ok: false, reason: 'not-found' });
	assert.deepEqual(outs[1].payload, { ok: false, reason: 'not-found' });
	assert.deepEqual(outs[2].payload, { ok: false, reason: 'not-found' });
	assert.deepEqual(outs[3].payload, { ok: false, reason: 'gone' });
	// 升格前 plugin 静默（not-found 不打 info / remoteLog），升格那一刻打 1 条 abort.gone
	const goneRel = __remoteLogBuffer.filter((r) => r.text.startsWith('abort.gone'));
	assert.equal(goneRel.length, 1);
	assert.equal(goneRel[0].text, 'abort.gone sid=sid-progress runDur=240000 abortDur=60000');
	const goneInfos = infos.filter((m) => /sid-progress/.test(m));
	assert.equal(goneInfos.length, 1);
	assert.match(goneInfos[0], /reason=gone/);
});

// --- registrationMode 分叉：cli-metadata / discovery / setup-runtime / full ---

/**
 * 构造一个全 spy 的 api，记录每个 register* / on / setRuntime 的调用次数。
 * 不传 runtime（discovery 真实形态就是 runtime={}），让 mode 分叉壳子在缺 runtime 时也能跑。
 */
function createSpyApi(mode) {
	const calls = {
		channel: 0,
		cli: 0,
		command: 0,
		service: 0,
		gatewayMethod: 0,
		on: 0,
	};
	const handlers = new Map();
	const api = {
		registrationMode: mode,
		pluginConfig: {},
		runtime: {
			config: { loadConfig: () => ({}) },
			agent: { resolveAgentWorkspaceDir: () => '/tmp/mock-workspace' },
		},
		logger: { info() {}, warn() {}, error() {}, log() {} },
		registerChannel() { calls.channel += 1; },
		registerCli() { calls.cli += 1; },
		registerCommand() { calls.command += 1; },
		registerService() { calls.service += 1; },
		registerGatewayMethod(name, handler) { calls.gatewayMethod += 1; handlers.set(name, handler); },
		on() { calls.on += 1; },
	};
	return { api, calls, handlers };
}

// 锁定"setRuntime 仅在 full 模式调用"刻意偏差行为：
// 非 full 模式下 register 不应覆盖全局 runtime 单例，避免每 14s 一次的 discovery
// 把空对象塞进单例。本助手在每个非 full case 起手将单例置为已知哨兵，register 后断言哨兵不变。
const RUNTIME_SENTINEL = { __sentinel: 'discovery-must-not-overwrite' };

test('register cli-metadata mode: only registers CLI commands, no other side effects', () => {
	setRuntime(RUNTIME_SENTINEL);
	const { api, calls, handlers } = createSpyApi('cli-metadata');
	plugin.register(api);
	assert.equal(calls.cli, 1);
	assert.equal(calls.channel, 0);
	assert.equal(calls.command, 0);
	assert.equal(calls.service, 0);
	assert.equal(calls.gatewayMethod, 0);
	assert.equal(calls.on, 0);
	assert.equal(handlers.size, 0);
	// runtime 单例不被覆盖
	assert.equal(getRuntime(), RUNTIME_SENTINEL);
});

test('register discovery mode: only registers channel + CLI, no full side effects', () => {
	setRuntime(RUNTIME_SENTINEL);
	const { api, calls, handlers } = createSpyApi('discovery');
	plugin.register(api);
	// 上游 helper 行为：discovery 模式下 channel + cli 都参与 capture
	assert.equal(calls.channel, 1);
	assert.equal(calls.cli, 1);
	// full 模式专属副作用一律不应触发
	assert.equal(calls.command, 0);
	assert.equal(calls.service, 0);
	assert.equal(calls.gatewayMethod, 0);
	assert.equal(calls.on, 0);
	assert.equal(handlers.size, 0);
	// runtime 单例不被覆盖（这是与上游 helper 的刻意偏差）
	assert.equal(getRuntime(), RUNTIME_SENTINEL);
});

test('register setup-runtime mode: defensive bottom branch, equivalent to discovery', () => {
	// 本插件 package.json 无 setupEntry，setup-runtime 实际不会到此；
	// 此 case 验证防御兜底行为正确（与 discovery 等价：只 capture，不跑 full）
	setRuntime(RUNTIME_SENTINEL);
	const { api, calls, handlers } = createSpyApi('setup-runtime');
	plugin.register(api);
	assert.equal(calls.channel, 1);
	assert.equal(calls.cli, 1);
	assert.equal(calls.command, 0);
	assert.equal(calls.service, 0);
	assert.equal(calls.gatewayMethod, 0);
	assert.equal(calls.on, 0);
	assert.equal(handlers.size, 0);
	assert.equal(getRuntime(), RUNTIME_SENTINEL);
});

test('register full mode: all expected side effects fire with exact RPC method set', () => {
	const { api, calls, handlers } = createSpyApi('full');
	plugin.register(api);
	assert.equal(calls.channel, 1);
	assert.equal(calls.cli, 1);
	assert.equal(calls.command, 1);
	assert.equal(calls.service, 2);
	// session_start hook 注册
	assert.equal(calls.on, 1);
	// 精确锁定 RPC 方法集合：增删 method 时强制更新本测试，防止静默回归
	const expectedMethods = [
		'coclaw.bind',
		'coclaw.unbind',
		'coclaw.enroll',
		'nativeui.sessions.listAll',
		'nativeui.sessions.get',
		'coclaw.info',
		'coclaw.info.get',
		'coclaw.info.patch',
		'coclaw.topics.create',
		'coclaw.topics.list',
		'coclaw.topics.get',
		'coclaw.topics.getHistory',
		'coclaw.topics.update',
		'coclaw.topics.generateTitle',
		'coclaw.topics.delete',
		'coclaw.chatHistory.list',
		'coclaw.sessions.getById',
		'coclaw.agent.abort',
		'coclaw.upgradeHealth',
		'coclaw.files.list',
		'coclaw.files.delete',
		'coclaw.files.mkdir',
		'coclaw.files.create',
	];
	for (const m of expectedMethods) {
		assert.ok(handlers.has(m), `expected RPC method "${m}" to be registered`);
	}
	assert.equal(calls.gatewayMethod, expectedMethods.length, `gatewayMethod call count should equal expected method set size`);
});
