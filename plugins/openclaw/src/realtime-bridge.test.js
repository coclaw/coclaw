import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { RealtimeBridge, ensureAgentSession, restartRealtimeBridge, stopRealtimeBridge } from './realtime-bridge.js';
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

/**
 * 消化 __ensureAllAgentSessions 的后台流量：
 * 响应 agents.list + 对应的 sessions.resolve（均返回成功）
 */
async function drainEnsureAllAgentSessions(gateway) {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	const agentsListRaw = gateway.sent.find((s) => String(s).includes('agents.list'));
	if (!agentsListRaw) return;
	const msg = JSON.parse(String(agentsListRaw));
	// 返回含 main 的列表，否则空数组也会 fallback 到 ['main']
	gateway.emit('message', { data: JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: { defaultId: 'main', agents: [{ id: 'main' }] } }) });
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	// 响应 sessions.resolve for main
	const resolveRaw = gateway.sent.find((s) => String(s).includes('sessions.resolve') && String(s).includes('agent:main:main'));
	if (resolveRaw) {
		const rMsg = JSON.parse(String(resolveRaw));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: rMsg.id, ok: true, payload: { ok: true, key: 'agent:main:main' } }) });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	}
}

// --- 单例便捷 API 测试 ---

test('singleton API should no-op for missing token / missing WebSocket and restart/stop should be safe', async () => {
	await writeCfg({ token: '' });
	const logger = noopLogger();
	const old = globalThis.WebSocket;
	delete globalThis.WebSocket;
	try {
		await restartRealtimeBridge({ logger, pluginConfig: { serverUrl: 'http://127.0.0.1:1' } });
		await restartRealtimeBridge({ logger, pluginConfig: { serverUrl: 'http://127.0.0.1:1' } });
		await stopRealtimeBridge();
		const cfg = await readConfig();
		assert.equal(cfg.token, '');
	}
	finally {
		globalThis.WebSocket = old;
		await stopRealtimeBridge();
	}
});

test('restartRealtimeBridge should re-create singleton after stop (bind regression)', async () => {
	await writeCfg({ token: '' });
	const logger = noopLogger();
	const old = globalThis.WebSocket;
	delete globalThis.WebSocket;
	try {
		// 模拟 bind 流程：restart → stop → restart
		const opts = { logger, pluginConfig: { serverUrl: 'http://127.0.0.1:1' } };
		await restartRealtimeBridge(opts);
		await stopRealtimeBridge();
		// stop 后 singleton 为 null，restart 应重新创建
		await restartRealtimeBridge(opts);
		const result = await ensureAgentSession('main');
		assert.notEqual(result.error, 'bridge_not_started');
	}
	finally {
		globalThis.WebSocket = old;
		await stopRealtimeBridge();
	}
});

test('restartRealtimeBridge should replace existing singleton when already running', async () => {
	await writeCfg({ token: '' });
	const logger = noopLogger();
	const old = globalThis.WebSocket;
	delete globalThis.WebSocket;
	try {
		const opts = { logger, pluginConfig: {} };
		await restartRealtimeBridge(opts);
		// 再次 restart 不应报错，应正常替换
		await restartRealtimeBridge(opts);
		const result = await ensureAgentSession('main');
		assert.notEqual(result.error, 'bridge_not_started');
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
		await restartRealtimeBridge({ logger, pluginConfig: {} });
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
		await restartRealtimeBridge({ logger, pluginConfig: {} });
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

		// 等待 __ensureAllAgentSessions 发出 agents.list + sessions.resolve
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		const agentsListRaw = gateway.sent.find((s) => String(s).includes('agents.list'));
		if (agentsListRaw) {
			const agentsListMsg = JSON.parse(String(agentsListRaw));
			gateway.emit('message', { data: JSON.stringify({ type: 'res', id: agentsListMsg.id, ok: true, payload: { defaultId: 'main', agents: [{ id: 'main' }] } }) });
			for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
			const resolveReqRaw = gateway.sent.find((s) => String(s).includes('sessions.resolve'));
			if (resolveReqRaw) {
				const resolveReqMsg = JSON.parse(String(resolveReqRaw));
				gateway.emit('message', { data: JSON.stringify({ type: 'res', id: resolveReqMsg.id, ok: true, payload: { ok: true, key: 'agent:main:main' } }) });
				for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
			}
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

test('RealtimeBridge should ensure all agent sessions after gateway connect', async () => {
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

		// 等待 agents.list 请求
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		const agentsListRaw = gateway.sent.find((s) => String(s).includes('agents.list'));
		assert.ok(agentsListRaw, 'should send agents.list after gateway connect');
		const agentsListReq = JSON.parse(String(agentsListRaw));

		// 返回两个 agent
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: agentsListReq.id, ok: true, payload: { defaultId: 'main', agents: [{ id: 'main' }, { id: 'ops' }] } }) });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

		// 应为每个 agent 发送 sessions.resolve
		const resolveReqs = gateway.sent
			.filter((s) => String(s).includes('sessions.resolve'))
			.map((s) => JSON.parse(String(s)));
		assert.equal(resolveReqs.length, 2, 'should send sessions.resolve for each agent');
		assert.ok(resolveReqs.some((r) => r.params.key === 'agent:main:main'));
		assert.ok(resolveReqs.some((r) => r.params.key === 'agent:ops:main'));

		// 响应两个 resolve 请求
		for (const req of resolveReqs) {
			gateway.emit('message', { data: JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { ok: true, key: req.params.key } }) });
		}
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		assert.ok(logs.some((x) => String(x).includes('ensure agent session: ready agentId=main')));
		assert.ok(logs.some((x) => String(x).includes('ensure agent session: ready agentId=ops')));
	}
	finally {
		await bridge.stop();
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge ensureAgentSession should create session when not found', async () => {
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

		await drainEnsureAllAgentSessions(gateway);

		// 手动调用 ensureAgentSession
		const ensureP = bridge.ensureAgentSession('tester');
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		const resolveReqRaw = gateway.sent.findLast((s) => String(s).includes('sessions.resolve') && String(s).includes('tester'));
		assert.ok(resolveReqRaw, 'should send sessions.resolve for tester');
		const resolveReq = JSON.parse(String(resolveReqRaw));
		assert.equal(resolveReq.params.key, 'agent:tester:main');

		// session 不存在
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: resolveReq.id, ok: false, error: { message: 'not found' } }) });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

		// 应发出 sessions.reset
		const resetReqRaw = gateway.sent.findLast((s) => String(s).includes('sessions.reset') && String(s).includes('tester'));
		assert.ok(resetReqRaw, 'should send sessions.reset when not found');
		const resetReq = JSON.parse(String(resetReqRaw));
		assert.equal(resetReq.params.key, 'agent:tester:main');
		assert.equal(resetReq.params.reason, 'new');

		// reset 成功
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: resetReq.id, ok: true, payload: { ok: true } }) });
		const result = await ensureP;
		assert.deepEqual(result, { ok: true, state: 'created' });
		assert.ok(logs.some((x) => String(x).includes('ensure agent session: created agentId=tester')));
	}
	finally {
		await bridge.stop();
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge ensureAgentSession should NOT reset on resolve timeout', async () => {
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

		await drainEnsureAllAgentSessions(gateway);

		// 手动调用并让 resolve 超时（ref 一个 timer 保持事件循环活跃）
		const keepAlive = setTimeout(() => {}, 5000);
		const result = await bridge.ensureAgentSession('timeout-agent');
		clearTimeout(keepAlive);
		assert.equal(result.ok, false);
		assert.equal(result.error, 'timeout');

		// 不应发送 sessions.reset
		const resetReqRaw = gateway.sent.find((s) => String(s).includes('sessions.reset') && String(s).includes('timeout-agent'));
		assert.equal(resetReqRaw, undefined, 'should NOT send sessions.reset on timeout');
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

test('RealtimeBridge ensureAgentSession should handle sessions.reset failure', async () => {
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

		await drainEnsureAllAgentSessions(gateway);

		// 手动调用 ensureAgentSession
		const ensureP = bridge.ensureAgentSession('fail-agent');
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		const resolveReqRaw = gateway.sent.findLast((s) => String(s).includes('sessions.resolve') && String(s).includes('fail-agent'));
		const resolveReq = JSON.parse(String(resolveReqRaw));

		// session 不存在
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: resolveReq.id, ok: false, error: { message: 'not found' } }) });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

		// reset 也失败
		const resetReqRaw = gateway.sent.findLast((s) => String(s).includes('sessions.reset') && String(s).includes('fail-agent'));
		const resetReq = JSON.parse(String(resetReqRaw));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: resetReq.id, ok: false, error: { message: 'reset failed' } }) });

		const result = await ensureP;
		assert.equal(result.ok, false);
		assert.equal(result.error, 'reset failed');
	}
	finally {
		await bridge.stop();
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge ensureAgentSession should default to main when agentId is empty', async () => {
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

		await drainEnsureAllAgentSessions(gateway);

		// 传空字符串应 fallback 到 main
		const ensureP = bridge.ensureAgentSession('  ');
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		const resolveReqRaw = gateway.sent.findLast((s) => String(s).includes('sessions.resolve') && String(s).includes('agent:main:main'));
		assert.ok(resolveReqRaw, 'empty agentId should fallback to main');
		const resolveReq = JSON.parse(String(resolveReqRaw));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: resolveReq.id, ok: true, payload: {} }) });
		const result = await ensureP;
		assert.equal(result.ok, true);
		assert.equal(result.state, 'ready');
	}
	finally {
		await bridge.stop();
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge __ensureAllAgentSessions should fallback to main when agents.list fails', async () => {
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
		const agentsListRaw = gateway.sent.find((s) => String(s).includes('agents.list'));
		assert.ok(agentsListRaw, 'should send agents.list');
		const agentsListReq = JSON.parse(String(agentsListRaw));

		// agents.list 失败
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: agentsListReq.id, ok: false, error: { message: 'method not found' } }) });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		assert.ok(logs.some((x) => String(x).includes('agents.list failed, falling back to main')));

		// 应 fallback 到仅 ensure main
		const resolveReqs = gateway.sent
			.filter((s) => String(s).includes('sessions.resolve'))
			.map((s) => JSON.parse(String(s)));
		assert.equal(resolveReqs.length, 1);
		assert.equal(resolveReqs[0].params.key, 'agent:main:main');

		// 响应 resolve
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: resolveReqs[0].id, ok: true, payload: {} }) });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	}
	finally {
		await bridge.stop();
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('singleton ensureAgentSession should return error when bridge not started', async () => {
	// 确保 singleton 为 null
	await stopRealtimeBridge();
	const result = await ensureAgentSession('main');
	assert.equal(result.ok, false);
	assert.equal(result.error, 'bridge_not_started');
});

test('singleton ensureAgentSession should delegate to bridge instance', async () => {
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	try {
		await restartRealtimeBridge({ logger: noopLogger(), pluginConfig: {} });
		// bridge 已启动但 gateway 未就绪，ensure 应返回 gateway_not_ready
		const result = await ensureAgentSession('main');
		assert.equal(result.ok, false);
		assert.equal(result.error, 'gateway_not_ready');
	}
	finally {
		await stopRealtimeBridge();
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

test('RealtimeBridge server heartbeat should tolerate consecutive misses before closing', async () => {
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
	const debugs = [];
	const logger = { warn: (m) => warns.push(String(m)), info() {}, debug: (m) => debugs.push(String(m)) };
	const bridge = createBridge();
	try {
		await bridge.start({ logger, pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		// 找到 heartbeat timeout 回调（45s）
		const hbTimeout = timeouts.find((t) => t.__ms === 45_000);
		assert.ok(hbTimeout, 'should have heartbeat timeout at 45s');

		// 第 1~3 次 miss：不应关闭 socket，应补发 ping 并调度下一轮
		for (let i = 1; i <= 3; i++) {
			const latestTimeout = timeouts[timeouts.length - 1];
			latestTimeout.__fn();
			assert.equal(server.readyState, 1, `miss ${i}: socket should still be open`);
			assert.ok(debugs.some((x) => x.includes(`heartbeat miss ${i}/4`)), `miss ${i}: should log miss`);
			// 应补发 ping
			assert.ok(server.sent.some((x) => String(x).includes('"type":"ping"')), `miss ${i}: should send compensatory ping`);
		}

		// 第 4 次 miss：应关闭 socket
		const lastTimeout = timeouts[timeouts.length - 1];
		lastTimeout.__fn();
		assert.ok(warns.some((x) => x.includes('heartbeat timeout') && x.includes('4 consecutive misses')), 'should log final timeout');
		assert.equal(server.readyState, 3, 'socket should be closed after max misses');
	}
	finally {
		global.setInterval = oldSetInterval;
		global.clearInterval = oldClearInterval;
		global.setTimeout = oldSetTimeout;
		global.clearTimeout = oldClearTimeout;
		await bridge.stop();
	}
});

test('RealtimeBridge server heartbeat miss count should reset on received message', async () => {
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

		// 触发 2 次 miss
		for (let i = 0; i < 2; i++) {
			const t = timeouts[timeouts.length - 1];
			t.__fn();
		}
		assert.equal(bridge.__serverHbMissCount, 2, 'miss count should be 2');

		// 收到消息 → __resetServerHbTimeout → miss count 归零
		server.emit('message', { data: JSON.stringify({ type: 'pong' }) });
		assert.equal(bridge.__serverHbMissCount, 0, 'miss count should reset on message');
		assert.equal(server.readyState, 1, 'socket should still be open');
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

		// 触发前 3 次 miss（不关闭），然后第 4 次触发 close
		for (let i = 0; i < 3; i++) {
			const t = timeouts[timeouts.length - 1];
			t.__fn();
		}

		// 第 4 次 miss 时 close 抛异常不应 crash
		server.throwOnClose = true;
		const lastTimeout = timeouts[timeouts.length - 1];
		assert.doesNotThrow(() => lastTimeout.__fn());
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

test('RealtimeBridge heartbeat miss compensatory ping should not crash when send throws', async () => {
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

		// miss 时补发 ping，send 抛异常不应 crash
		server.throwOnSend = true;
		const hbTimeout = timeouts.find((t) => t.__ms === 45_000);
		assert.doesNotThrow(() => hbTimeout.__fn());
		assert.equal(bridge.__serverHbMissCount, 1, 'should still increment miss count');
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

test('RealtimeBridge heartbeat miss should skip compensatory ping when socket not open', async () => {
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

		// socket 变为非 OPEN 后触发 miss，不应补发 ping
		const sentBefore = server.sent.length;
		server.readyState = 0;
		const hbTimeout = timeouts.find((t) => t.__ms === 45_000);
		hbTimeout.__fn();
		assert.equal(server.sent.length, sentBefore, 'should NOT send compensatory ping when not open');
		assert.equal(bridge.__serverHbMissCount, 1, 'should still increment miss count');
	}
	finally {
		global.setInterval = oldSetInterval;
		global.clearInterval = oldClearInterval;
		global.setTimeout = oldSetTimeout;
		global.clearTimeout = oldClearTimeout;
		await bridge.stop();
	}
});

// --- device identity 集成测试 ---

test('connect request should include device field with nonce from challenge', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const fakeIdentity = {
		deviceId: 'fake-device-id',
		publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAtzDL7h2Z4PZiOmNjmyl+U2gKexygXrWLjOWMufVSZKU=\n-----END PUBLIC KEY-----\n',
		privateKeyPem: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJYc25BaxT+DkFPCYoNeX0a5Vtv3VPJ+o9iEHcuh3+G6\n-----END PRIVATE KEY-----\n',
	};
	const bridge = createBridge({
		resolveGatewayAuthToken: () => 'test-token',
		loadDeviceIdentity: () => fakeIdentity,
	});

	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'test-nonce-123' } }) });

		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));
		assert.equal(connectReq.method, 'connect');

		// device 字段存在且正确
		const { device } = connectReq.params;
		assert.ok(device, 'connect params should have device field');
		assert.equal(device.id, 'fake-device-id');
		assert.equal(device.nonce, 'test-nonce-123');
		assert.ok(typeof device.publicKey === 'string' && device.publicKey.length > 0);
		assert.ok(typeof device.signature === 'string' && device.signature.length > 0);
		assert.ok(typeof device.signedAt === 'number' && device.signedAt > 0);

		// auth、scopes、caps 也存在
		assert.equal(connectReq.params.role, 'operator');
		assert.deepEqual(connectReq.params.scopes, ['operator.admin']);
		assert.deepEqual(connectReq.params.caps, ['tool-events']);
		assert.deepEqual(connectReq.params.auth, { token: 'test-token' });
	}
	finally {
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('connect request should use empty nonce when challenge has no nonce', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const fakeIdentity = {
		deviceId: 'did',
		publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAtzDL7h2Z4PZiOmNjmyl+U2gKexygXrWLjOWMufVSZKU=\n-----END PUBLIC KEY-----\n',
		privateKeyPem: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJYc25BaxT+DkFPCYoNeX0a5Vtv3VPJ+o9iEHcuh3+G6\n-----END PRIVATE KEY-----\n',
	};
	const bridge = createBridge({ loadDeviceIdentity: () => fakeIdentity });

	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		// challenge 不含 payload.nonce
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge' }) });

		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));
		assert.equal(connectReq.params.device.nonce, '');
	}
	finally {
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('connect should gracefully handle device identity load failure', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const bridge = createBridge({
		loadDeviceIdentity: () => { throw new Error('identity load boom'); },
	});

	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n' } }) });

		// 不应有 connect 请求发出（device 构建失败）
		assert.equal(gateway.sent.length, 0, 'no connect request should be sent');
		// gatewayConnectReqId 被清空
		assert.equal(bridge.gatewayConnectReqId, null, 'gatewayConnectReqId should be null after failure');
		// bridge 不崩溃，仍可正常 stop
	}
	finally {
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('device identity should be cached across multiple connect attempts', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	let loadCount = 0;
	const fakeIdentity = {
		deviceId: 'cached-id',
		publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAtzDL7h2Z4PZiOmNjmyl+U2gKexygXrWLjOWMufVSZKU=\n-----END PUBLIC KEY-----\n',
		privateKeyPem: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJYc25BaxT+DkFPCYoNeX0a5Vtv3VPJ+o9iEHcuh3+G6\n-----END PRIVATE KEY-----\n',
	};
	const bridge = createBridge({
		loadDeviceIdentity: () => { loadCount++; return fakeIdentity; },
	});

	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;

		// 多次 connect.challenge
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n2' } }) });
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n3' } }) });

		assert.equal(loadCount, 1, 'loadDeviceIdentity should be called only once');
	}
	finally {
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});
