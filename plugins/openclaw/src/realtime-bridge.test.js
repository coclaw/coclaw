import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { RealtimeBridge, refreshRealtimeBridge, startRealtimeBridge, stopRealtimeBridge } from './realtime-bridge.js';
import { readConfig, writeConfig } from './config.js';
import { saveHomedir, setHomedir, restoreHomedir } from './homedir-mock.helper.js';
import { setRuntime } from './runtime.js';

class FakeWebSocket {
	static instances = [];
	constructor(url) {
		this.url = url;
		this.readyState = 0;
		this.sent = [];
		this.listeners = new Map();
		FakeWebSocket.instances.push(this);
	}
	addEventListener(name, fn) {
		const arr = this.listeners.get(name) ?? [];
		arr.push(fn);
		this.listeners.set(name, arr);
	}
	removeEventListener(name, fn) {
		const arr = this.listeners.get(name) ?? [];
		const idx = arr.indexOf(fn);
		if (idx >= 0) arr.splice(idx, 1);
	}
	emit(name, payload) {
		for (const fn of this.listeners.get(name) ?? []) {
			fn(payload);
		}
	}
	send(payload) {
		if (this.throwOnSend) {
			throw new Error('send failed');
		}
		this.sent.push(payload);
	}
	close(code, reason) {
		if (this.throwOnClose) {
			throw new Error('close failed');
		}
		this.readyState = 3;
		this.emit('close', { code, reason });
	}
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

async function writeCfg(data) {
	const dir = await setupDir('coclaw-rb-');
	await writeConfig(data);
	return dir;
}

function noopLogger() {
	return { warn() {}, info() {}, debug() {} };
}

function createBridge(overrides = {}) {
	return new RealtimeBridge({
		WebSocket: FakeWebSocket,
		resolveGatewayAuthToken: () => '',
		...overrides,
	});
}

// --- 单例便捷 API 测试 ---

test('singleton API should no-op for missing token / missing WebSocket and refresh/stop should be safe', async () => {
	await writeCfg({ token: '' });
	const logger = noopLogger();
	const old = globalThis.WebSocket;
	delete globalThis.WebSocket;
	try {
		await startRealtimeBridge({ logger, pluginConfig: { serverUrl: 'http://127.0.0.1:1' } });
		await refreshRealtimeBridge();
		await stopRealtimeBridge();
		const cfg = await readConfig();
		assert.equal(cfg.token, '');
	}
	finally {
		globalThis.WebSocket = old;
		await stopRealtimeBridge();
	}
});

test('singleton API should log warning when token exists but serverUrl is missing', async () => {
	await writeCfg({ token: 't1' });
	const warns = [];
	const logger = { warn: (m) => warns.push(String(m)), info() {} };
	try {
		await startRealtimeBridge({ logger, pluginConfig: {} });
		assert.equal(warns.some((x) => x.includes('missing serverUrl')), true);
	}
	finally {
		await stopRealtimeBridge();
	}
});

test('singleton API should log warning when token exists but WebSocket is unavailable', async () => {
	await writeCfg({ token: 't1', serverUrl: 'http://127.0.0.1:3000' });
	const warns = [];
	const logger = { warn: (m) => warns.push(String(m)), info() {} };
	const old = globalThis.WebSocket;
	delete globalThis.WebSocket;
	try {
		await startRealtimeBridge({ logger, pluginConfig: {} });
		assert.equal(warns.some((x) => x.includes('WebSocket not available')), true);
	}
	finally {
		globalThis.WebSocket = old;
		await stopRealtimeBridge();
	}
});

// --- DI 类测试 ---

test('RealtimeBridge should handle rpc/unbound/close/send-fail branches', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	FakeWebSocket.instances.length = 0;
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.env';
	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m) };
	const bridge = createBridge();

	try {
		await bridge.start({ logger, pluginConfig: {} });
		assert.equal(FakeWebSocket.instances.length >= 1, true);
		const initialServer = FakeWebSocket.instances[0];
		assert.equal(initialServer.url.startsWith('wss://server.local/api/v1/bots/stream'), true);
		initialServer.readyState = 1;
		initialServer.emit('open', {});
		assert.equal(logs.some((x) => String(x).includes('connected')), true);

		// 模拟 bind 后 token 更新
		await writeConfig({ token: 't2', serverUrl: 'https://server.local' });

		// refresh 会先关闭旧连接再用新 token 创建新 server ws
		await bridge.refresh();
		assert.equal(initialServer.readyState, 3, 'initial server should be closed after refresh');
		const server = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		assert.equal(server.url.startsWith('wss://server.local/api/v1/bots/stream'), true);
		assert.equal(server.url.includes('token=t2'), true, 'new connection should use updated token');
		assert.equal(server !== initialServer, true, 'should be a different WebSocket instance');
		// open 后 ensureGatewayConnection 创建 gateway ws
		server.readyState = 1;
		server.emit('open', {});
		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		assert.equal(gateway.url, 'ws://gw.env');
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });

		// 等待 ensureMainSessionKey 发出 sessions.resolve 请求并响应
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		const resolveReqRaw = gateway.sent.find((s) => String(s).includes('sessions.resolve'));
		if (resolveReqRaw) {
			const resolveReqMsg = JSON.parse(String(resolveReqRaw));
			gateway.emit('message', { data: JSON.stringify({ type: 'res', id: resolveReqMsg.id, ok: true, payload: { ok: true, key: 'agent:main:main' } }) });
			for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
		}

		// rpc.req happy path
		server.emit('message', { data: JSON.stringify({ type: 'rpc.req', id: '1', method: 'm1', params: { a: 1 } }) });
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(gateway.sent.length > 0, true);

		// rpc.req send failed branch
		gateway.throwOnSend = true;
		server.emit('message', { data: JSON.stringify({ type: 'rpc.req', id: '2', method: 'm2', params: {} }) });
		await new Promise((r) => setTimeout(r, 0));
		gateway.throwOnSend = false;
		assert.equal(server.sent.some((x) => String(x).includes('GATEWAY_SEND_FAILED')), true);

		// gateway message parse ignore / non-object / res / event
		gateway.emit('message', { data: '{bad-json' });
		gateway.emit('message', { data: '123' });
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: '1', ok: true, payload: { ok: 1 } }) });
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'e1', payload: { x: 1 } }) });
		assert.equal(server.sent.length >= 2, true);

		// server message parse failed
		server.emit('message', { data: '{bad-json' });
		assert.equal(logs.some((x) => String(x).includes('parse failed')), true);

		// rpc.req when gateway offline -> GATEWAY_OFFLINE
		gateway.readyState = 0;
		server.emit('message', { data: JSON.stringify({ type: 'rpc.req', id: '3', method: 'm3' }) });
		await new Promise((r) => setTimeout(r, 1600));
		assert.equal(server.sent.some((x) => String(x).includes('GATEWAY_OFFLINE')), true);

		// bot.unbound branch
		server.emit('message', { data: JSON.stringify({ type: 'bot.unbound', reason: 'x' }) });
		for (let i = 0; i < 10; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const afterUnbound = await readConfig();
		assert.equal(afterUnbound.token, undefined);

		// close with 4003 should clear token
		await writeConfig({ token: 't2' });
		server.emit('close', { code: 4003, reason: 'revoked' });
		for (let i = 0; i < 10; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const afterClose = await readConfig();
		assert.equal(afterClose.token, undefined);

		// gateway close/error handlers
		gateway.emit('error', {});
		gateway.emit('close', {});
	}
	finally {
		await bridge.stop();
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge should schedule reconnect on non-intentional close and clear timer on stop', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	const oldSetTimeout = global.setTimeout;
	const oldClearTimeout = global.clearTimeout;
	const calls = { set: 0, clear: 0 };
	let timerObj = null;
	global.setTimeout = ((fn, _ms) => {
		calls.set += 1;
		timerObj = {
			unref() {},
			__fn: fn,
		};
		return timerObj;
	});
	global.clearTimeout = (() => {
		calls.clear += 1;
	});
	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('close', { code: 1000, reason: 'bye' });
		assert.equal(calls.set > 0, true);
		await timerObj?.__fn?.();
		await bridge.stop();
		assert.equal(calls.set > 0, true);
	}
	finally {
		global.setTimeout = oldSetTimeout;
		global.clearTimeout = oldClearTimeout;
		await bridge.stop();
	}
});

test('RealtimeBridge should schedule reconnect on server error', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	const oldSetTimeout = global.setTimeout;
	let timerCount = 0;
	global.setTimeout = ((fn) => {
		timerCount += 1;
		return {
			unref() {},
			__fn: fn,
		};
	});
	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.emit('error', { message: 'boom' });
		assert.equal(timerCount > 0, true);
	}
	finally {
		global.setTimeout = oldSetTimeout;
		await bridge.stop();
	}
});

test('RealtimeBridge should ensure main session key after gateway connect', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';
	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m) };
	const bridge = createBridge();

	try {
		await bridge.start({ logger, pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });

		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		const resolveReqRaw = gateway.sent.find((s) => String(s).includes('sessions.resolve'));
		assert.ok(resolveReqRaw, 'should send sessions.resolve after gateway connect');
		const resolveReq = JSON.parse(String(resolveReqRaw));
		assert.equal(resolveReq.method, 'sessions.resolve');
		assert.equal(resolveReq.params.key, 'agent:main:main');

		// 模拟 session 已存在
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: resolveReq.id, ok: true, payload: { ok: true, key: 'agent:main:main' } }) });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		assert.ok(logs.some((x) => String(x).includes('main session key ensure: ready')), 'should log ready');
	}
	finally {
		await bridge.stop();
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge ensureMainSessionKey should create session when not found', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';
	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m) };
	const bridge = createBridge();

	try {
		await bridge.start({ logger, pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });

		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		const resolveReqRaw = gateway.sent.find((s) => String(s).includes('sessions.resolve'));
		assert.ok(resolveReqRaw, 'should send sessions.resolve');
		const resolveReq = JSON.parse(String(resolveReqRaw));

		// 模拟 session 不存在
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: resolveReq.id, ok: false, error: { message: 'not found' } }) });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

		// 应发出 sessions.reset 请求
		const resetReqRaw = gateway.sent.find((s) => String(s).includes('sessions.reset'));
		assert.ok(resetReqRaw, 'should send sessions.reset when session not found');
		const resetReq = JSON.parse(String(resetReqRaw));
		assert.equal(resetReq.method, 'sessions.reset');
		assert.equal(resetReq.params.key, 'agent:main:main');
		assert.equal(resetReq.params.reason, 'new');

		// 模拟 reset 成功
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: resetReq.id, ok: true, payload: { ok: true, key: 'agent:main:main', entry: { sessionId: 'new-uuid' } } }) });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		assert.ok(logs.some((x) => String(x).includes('main session key ensure: created')), 'should log created');
	}
	finally {
		await bridge.stop();
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge ensureMainSessionKey should NOT reset on resolve timeout', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';
	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m) };
	const bridge = createBridge();

	try {
		await bridge.start({ logger, pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });

		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		const resolveReqRaw = gateway.sent.find((s) => String(s).includes('sessions.resolve'));
		assert.ok(resolveReqRaw, 'should send sessions.resolve');

		// 不响应 sessions.resolve，等待超时
		await new Promise((r) => setTimeout(r, 2200));

		const resetReqRaw = gateway.sent.find((s) => String(s).includes('sessions.reset'));
		assert.equal(resetReqRaw, undefined, 'should NOT send sessions.reset on timeout');
		assert.ok(logs.some((x) => String(x).includes('ensure main session key failed')), 'should log failure');
	}
	finally {
		await bridge.stop();
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge should handle connect timeout', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };

	// 拦截 setTimeout 以捕获 connect timeout 回调
	const oldSetTimeout = global.setTimeout;
	const oldClearTimeout = global.clearTimeout;
	const timers = [];
	global.setTimeout = ((fn, ms) => {
		const obj = { __fn: fn, __ms: ms, unref() {} };
		timers.push(obj);
		return obj;
	});
	global.clearTimeout = ((t) => {
		const idx = timers.indexOf(t);
		if (idx >= 0) timers[idx].__cancelled = true;
	});

	const bridge = createBridge();
	try {
		await bridge.start({ logger, pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		// 不触发 'open'，模拟连接超时

		// 执行 connect timeout 回调
		const connectTimerFn = timers.find((t) => !t.__cancelled && t.__ms === 10_000);
		assert.ok(connectTimerFn, 'should have a connect timeout timer');
		connectTimerFn.__fn();

		assert.equal(logs.some((x) => String(x).includes('connect timeout')), true);
		assert.equal(server.readyState, 3, 'server socket should be closed on timeout');
	}
	finally {
		global.setTimeout = oldSetTimeout;
		global.clearTimeout = oldClearTimeout;
		await bridge.stop();
	}
});

test('RealtimeBridge should handle gateway connect failure', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';
	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m) };
	const bridge = createBridge();

	try {
		await bridge.start({ logger, pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge' }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));

		// 模拟 gateway connect 失败
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: false, error: { message: 'auth failed' } }) });
		assert.ok(logs.some((x) => String(x).includes('gateway connect failed')));
		assert.equal(gateway.readyState, 3, 'gateway should be closed after connect failure');
	}
	finally {
		await bridge.stop();
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge should handle gateway connect send failure', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';
	const bridge = createBridge();

	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		// 让 connect request 的 send 失败
		gateway.throwOnSend = true;
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge' }) });
		// gatewayConnectReqId 应被清空
		assert.equal(bridge.gatewayConnectReqId, null);
		gateway.throwOnSend = false;
	}
	finally {
		await bridge.stop();
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge should handle stale socket close after refresh', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const oldServer = FakeWebSocket.instances[0];
		oldServer.readyState = 1;
		oldServer.emit('open', {});

		// refresh 创建新连接
		await writeConfig({ token: 't2', serverUrl: 'http://server.local' });
		await bridge.refresh();
		const newServer = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		assert.equal(newServer !== oldServer, true);

		// 旧 socket 的 close 事件触发（stale socket），bridge 应忽略
		// 手动触发旧 socket 的 close 而不通过 .close() 方法（模拟延迟 close 事件）
		for (const fn of oldServer.listeners.get('close') ?? []) {
			fn({ code: 1000, reason: 'old' });
		}
		// newServer 应仍然是 bridge 的 serverWs
		assert.equal(bridge.serverWs, newServer);
	}
	finally {
		await bridge.stop();
	}
});

test('RealtimeBridge should ignore error on stale socket', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const oldServer = FakeWebSocket.instances[0];
		oldServer.readyState = 1;

		// refresh 后 oldServer 不再是当前 serverWs
		await writeConfig({ token: 't2', serverUrl: 'http://server.local' });
		await bridge.refresh();
		const newServer = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

		// 旧 socket error 应被忽略
		for (const fn of oldServer.listeners.get('error') ?? []) {
			fn({ message: 'stale error' });
		}
		assert.equal(bridge.serverWs, newServer);
	}
	finally {
		await bridge.stop();
	}
});

test('RealtimeBridge waitGatewayReady should handle ws reference change', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';
	const bridge = createBridge();

	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		// gateway ws 创建但不 ready
		const gw = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gw.readyState = 1;

		// 发起一个需要 gateway ready 的请求（此时 gateway 不 ready，会进入 waitGatewayReady 循环）
		// 在等待过程中 close gateway ws
		const reqP = bridge.__handleGatewayRequestFromServer({ id: 'test-req', method: 'test.m' });
		// 模拟 gateway ws 关闭
		gw.emit('close', {});
		await reqP;
		// 应收到 GATEWAY_OFFLINE 响应
		assert.equal(server.sent.some((x) => String(x).includes('GATEWAY_OFFLINE')), true);
	}
	finally {
		await bridge.stop();
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge ensureMainSessionKey should handle sessions.reset failure', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';
	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m) };
	const bridge = createBridge();

	try {
		await bridge.start({ logger, pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge' }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });

		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		const resolveReqRaw = gateway.sent.find((s) => String(s).includes('sessions.resolve'));
		const resolveReq = JSON.parse(String(resolveReqRaw));

		// session 不存在
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: resolveReq.id, ok: false, error: { message: 'not found' } }) });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

		// reset 也失败
		const resetReqRaw = gateway.sent.find((s) => String(s).includes('sessions.reset'));
		const resetReq = JSON.parse(String(resetReqRaw));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: resetReq.id, ok: false, error: { message: 'reset failed' } }) });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

		assert.ok(logs.some((x) => String(x).includes('ensure main session key failed')));
		assert.equal(bridge.mainSessionEnsured, false);
	}
	finally {
		await bridge.stop();
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge should skip mainSessionKey if already ensured', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';
	const bridge = createBridge();

	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		// 手动设置 mainSessionEnsured
		bridge.mainSessionEnsured = true;

		// 直接调用应该立即返回 ready
		const result = await bridge.__ensureMainSessionKey();
		assert.deepEqual(result, { ok: true, state: 'ready' });
	}
	finally {
		await bridge.stop();
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge server heartbeat interval should send ping when socket is open', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });

	const oldSetInterval = global.setInterval;
	const oldClearInterval = global.clearInterval;
	const oldSetTimeout = global.setTimeout;
	const oldClearTimeout = global.clearTimeout;
	const intervals = [];
	const timeouts = [];
	global.setInterval = ((fn, ms) => {
		const obj = { __fn: fn, __ms: ms, unref() {} };
		intervals.push(obj);
		return obj;
	});
	global.clearInterval = (() => {});
	global.setTimeout = ((fn, ms) => {
		const obj = { __fn: fn, __ms: ms, unref() {} };
		timeouts.push(obj);
		return obj;
	});
	global.clearTimeout = (() => {});

	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		// 找到 heartbeat interval 回调（25s）
		const hbInterval = intervals.find((t) => t.__ms === 25_000);
		assert.ok(hbInterval, 'should have heartbeat interval at 25s');

		// socket OPEN → 发送 ping
		hbInterval.__fn();
		assert.ok(server.sent.some((x) => String(x).includes('"type":"ping"')), 'should send ping when open');

		// socket 非 OPEN → 不发送
		const sentBefore = server.sent.length;
		server.readyState = 0;
		hbInterval.__fn();
		assert.equal(server.sent.length, sentBefore, 'should NOT send ping when not open');
	}
	finally {
		global.setInterval = oldSetInterval;
		global.clearInterval = oldClearInterval;
		global.setTimeout = oldSetTimeout;
		global.clearTimeout = oldClearTimeout;
		await bridge.stop();
	}
});

test('RealtimeBridge server heartbeat timeout should close socket', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });

	const oldSetInterval = global.setInterval;
	const oldClearInterval = global.clearInterval;
	const oldSetTimeout = global.setTimeout;
	const oldClearTimeout = global.clearTimeout;
	const intervals = [];
	const timeouts = [];
	global.setInterval = ((fn, ms) => {
		const obj = { __fn: fn, __ms: ms, unref() {} };
		intervals.push(obj);
		return obj;
	});
	global.clearInterval = (() => {});
	global.setTimeout = ((fn, ms) => {
		const obj = { __fn: fn, __ms: ms, unref() {} };
		timeouts.push(obj);
		return obj;
	});
	global.clearTimeout = (() => {});

	const warns = [];
	const logger = { warn: (m) => warns.push(String(m)), info() {}, debug() {} };
	const bridge = createBridge();
	try {
		await bridge.start({ logger, pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		// 找到 heartbeat timeout 回调（45s）
		const hbTimeout = timeouts.find((t) => t.__ms === 45_000);
		assert.ok(hbTimeout, 'should have heartbeat timeout at 45s');

		// 触发超时 → 应关闭 socket
		hbTimeout.__fn();
		assert.ok(warns.some((x) => x.includes('heartbeat timeout')), 'should log heartbeat timeout');
		assert.equal(server.readyState, 3, 'socket should be closed after heartbeat timeout');
	}
	finally {
		global.setInterval = oldSetInterval;
		global.clearInterval = oldClearInterval;
		global.setTimeout = oldSetTimeout;
		global.clearTimeout = oldClearTimeout;
		await bridge.stop();
	}
});

test('RealtimeBridge heartbeat ping should not crash when send throws', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });

	const oldSetInterval = global.setInterval;
	const oldClearInterval = global.clearInterval;
	const oldSetTimeout = global.setTimeout;
	const oldClearTimeout = global.clearTimeout;
	const intervals = [];
	global.setInterval = ((fn, ms) => {
		const obj = { __fn: fn, __ms: ms, unref() {} };
		intervals.push(obj);
		return obj;
	});
	global.clearInterval = (() => {});
	global.setTimeout = ((fn, ms) => ({ __fn: fn, __ms: ms, unref() {} }));
	global.clearTimeout = (() => {});

	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const hbInterval = intervals.find((t) => t.__ms === 25_000);
		assert.ok(hbInterval);

		// send 抛异常时不应 crash
		server.throwOnSend = true;
		assert.doesNotThrow(() => hbInterval.__fn());
		server.throwOnSend = false;
	}
	finally {
		global.setInterval = oldSetInterval;
		global.clearInterval = oldClearInterval;
		global.setTimeout = oldSetTimeout;
		global.clearTimeout = oldClearTimeout;
		await bridge.stop();
	}
});

test('RealtimeBridge heartbeat timeout should not crash when close throws', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });

	const oldSetInterval = global.setInterval;
	const oldClearInterval = global.clearInterval;
	const oldSetTimeout = global.setTimeout;
	const oldClearTimeout = global.clearTimeout;
	const timeouts = [];
	global.setInterval = ((fn, ms) => ({ __fn: fn, __ms: ms, unref() {} }));
	global.clearInterval = (() => {});
	global.setTimeout = ((fn, ms) => {
		const obj = { __fn: fn, __ms: ms, unref() {} };
		timeouts.push(obj);
		return obj;
	});
	global.clearTimeout = (() => {});

	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const hbTimeout = timeouts.find((t) => t.__ms === 45_000);
		assert.ok(hbTimeout);

		// close 抛异常时不应 crash
		server.throwOnClose = true;
		assert.doesNotThrow(() => hbTimeout.__fn());
		server.throwOnClose = false;
	}
	finally {
		global.setInterval = oldSetInterval;
		global.clearInterval = oldClearInterval;
		global.setTimeout = oldSetTimeout;
		global.clearTimeout = oldClearTimeout;
		await bridge.stop();
	}
});
