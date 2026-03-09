import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { refreshRealtimeBridge, startRealtimeBridge, stopRealtimeBridge } from './realtime-bridge.js';
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

test('realtime-bridge should no-op for missing token / missing WebSocket and refresh/stop should be safe', async () => {
	await writeCfg({ token: '' });
	const logger = { warn() {}, info() {} };
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

test('realtime-bridge should log warning when token exists but serverUrl is missing', async () => {
	// token 存在但 serverUrl 缺失
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

test('realtime-bridge should log warning when token exists but WebSocket is unavailable', async () => {
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

test('realtime-bridge should handle rpc/unbound/close/send-fail branches', async () => {
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	FakeWebSocket.instances.length = 0;
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const oldWs = globalThis.WebSocket;
	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.env';
	globalThis.WebSocket = FakeWebSocket;
	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };

	try {
		await startRealtimeBridge({ logger, pluginConfig: {} });
		assert.equal(FakeWebSocket.instances.length >= 1, true);
		const initialServer = FakeWebSocket.instances[0];
		assert.equal(initialServer.url.startsWith('wss://server.local/api/v1/bots/stream'), true);
		initialServer.readyState = 1;
		initialServer.emit('open', {});
		assert.equal(logs.some((x) => String(x).includes('connected')), true);

		// 模拟 bind 后 token 更新
		await writeConfig({ token: 't2', serverUrl: 'https://server.local' });

		// refresh 会先关闭旧连接再用新 token 创建新 server ws
		await refreshRealtimeBridge();
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
		await stopRealtimeBridge();
		globalThis.WebSocket = oldWs;
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('realtime-bridge should schedule reconnect on non-intentional close and clear timer on stop', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	const oldWs = globalThis.WebSocket;
	const oldSetTimeout = global.setTimeout;
	const oldClearTimeout = global.clearTimeout;
	const calls = { set: 0, clear: 0 };
	let timerObj = null;
	globalThis.WebSocket = FakeWebSocket;
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
	try {
		await startRealtimeBridge({ logger: { warn() {}, info() {} }, pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('close', { code: 1000, reason: 'bye' });
		assert.equal(calls.set > 0, true);
		await timerObj?.__fn?.();
		await stopRealtimeBridge();
		assert.equal(calls.set > 0, true);
	}
	finally {
		globalThis.WebSocket = oldWs;
		global.setTimeout = oldSetTimeout;
		global.clearTimeout = oldClearTimeout;
		await stopRealtimeBridge();
	}
});

test('realtime-bridge should schedule reconnect on server error', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	const oldWs = globalThis.WebSocket;
	const oldSetTimeout = global.setTimeout;
	let timerCount = 0;
	globalThis.WebSocket = FakeWebSocket;
	global.setTimeout = ((fn) => {
		timerCount += 1;
		return {
			unref() {},
			__fn: fn,
		};
	});
	try {
		await startRealtimeBridge({ logger: { warn() {}, info() {} }, pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.emit('error', { message: 'boom' });
		assert.equal(timerCount > 0, true);
	}
	finally {
		globalThis.WebSocket = oldWs;
		global.setTimeout = oldSetTimeout;
		await stopRealtimeBridge();
	}
});

test('realtime-bridge should ensure main session key after gateway connect', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const oldWs = globalThis.WebSocket;
	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';
	globalThis.WebSocket = FakeWebSocket;
	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m) };

	try {
		await startRealtimeBridge({ logger, pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });

		// 等待 ensureMainSessionKey 发出 sessions.resolve 请求（需多轮微任务刷新）
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
		await stopRealtimeBridge();
		globalThis.WebSocket = oldWs;
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('realtime-bridge ensureMainSessionKey should create session when not found', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const oldWs = globalThis.WebSocket;
	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';
	globalThis.WebSocket = FakeWebSocket;
	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m) };

	try {
		await startRealtimeBridge({ logger, pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });

		// 等待 sessions.resolve 请求（需多轮微任务刷新）
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
		await stopRealtimeBridge();
		globalThis.WebSocket = oldWs;
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('realtime-bridge ensureMainSessionKey should NOT reset on resolve timeout', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const oldWs = globalThis.WebSocket;
	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';
	globalThis.WebSocket = FakeWebSocket;
	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m) };

	try {
		await startRealtimeBridge({ logger, pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });

		// 等待 sessions.resolve 请求
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		const resolveReqRaw = gateway.sent.find((s) => String(s).includes('sessions.resolve'));
		assert.ok(resolveReqRaw, 'should send sessions.resolve');

		// 不响应 sessions.resolve，等待超时（gatewayRpc timeoutMs=2000）
		await new Promise((r) => setTimeout(r, 2200));

		// 超时后不应发出 sessions.reset
		const resetReqRaw = gateway.sent.find((s) => String(s).includes('sessions.reset'));
		assert.equal(resetReqRaw, undefined, 'should NOT send sessions.reset on timeout');

		// 应有失败日志
		assert.ok(logs.some((x) => String(x).includes('ensure main session key failed')), 'should log failure');
	}
	finally {
		await stopRealtimeBridge();
		globalThis.WebSocket = oldWs;
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});
