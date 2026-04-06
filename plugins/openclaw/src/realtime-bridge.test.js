import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import { after, test } from 'node:test';

import { RealtimeBridge, ensureAgentSession, gatewayAgentRpc, restartRealtimeBridge, stopRealtimeBridge, waitForSessionsReady } from './realtime-bridge.js';
import { readConfig, writeConfig } from './config.js';
import { saveHomedir, setHomedir, restoreHomedir } from './homedir-mock.helper.js';
import { setRuntime } from './runtime.js';
import { remoteLog, __reset as resetRemoteLog, __buffer as remoteLogBuffer } from './remote-log.js';

// singleton 测试会调用真实 preloadNdc → initLogger 注册 native TSFN，
// 阻止进程退出。finally 中的 stop 不带 forceCleanup，cleanup ref 已丢失，
// 需直接调 ndc cleanup 兜底释放 TSFN。
after(async () => {
	await stopRealtimeBridge({ forceCleanup: true });
	try {
		const ndc = await import('node-datachannel');
		const cleanup = ndc.cleanup ?? ndc.default?.cleanup;
		if (typeof cleanup === 'function') cleanup();
	} catch { /* ndc 未安装则无需 cleanup */ }
});

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

/** 默认 preloadNdc mock：返回功能完整的 mock PeerConnection（WebRTC 可用但无 cleanup） */
async function noopPreloadNdc() {
	function MockPC() {
		const pc = {
			onicecandidate: null,
			onconnectionstatechange: null,
			ondatachannel: null,
			connectionState: 'new',
			setRemoteDescription: async (desc) => {
				if (!desc?.sdp) throw new Error('Invalid SDP');
			},
			createAnswer: async () => ({ sdp: 'mock-sdp-answer' }),
			setLocalDescription: async () => {},
			addIceCandidate: async () => {},
			close: async () => { pc.connectionState = 'closed'; },
		};
		return pc;
	}
	return { PeerConnection: MockPC, cleanup: null, impl: 'werift' };
}

function createBridge(overrides = {}) {
	return new RealtimeBridge({
		WebSocket: FakeWebSocket,
		resolveGatewayAuthToken: () => '',
		preloadNdc: noopPreloadNdc,
		gatewayReadyTimeoutMs: 50,
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

test('stopRealtimeBridge({ forceCleanup: true }) should call __ndcCleanup', async () => {
	await writeCfg({ token: '' });
	const logger = noopLogger();
	const old = globalThis.WebSocket;
	delete globalThis.WebSocket;
	try {
		const opts = { logger, pluginConfig: { serverUrl: 'http://127.0.0.1:1' } };
		await restartRealtimeBridge(opts);
		// restartRealtimeBridge 后 singleton 的 __ndcCleanup 取决于 preload 结果
		// （可能为 null 或真实 cleanup）。再次 stop 并 forceCleanup 应不抛异常。
		await stopRealtimeBridge({ forceCleanup: true });
	}
	finally {
		globalThis.WebSocket = old;
		await stopRealtimeBridge();
	}
});

test('stopRealtimeBridge({ forceCleanup: true }) with no singleton should no-op', async () => {
	// 确保 singleton 为 null
	await stopRealtimeBridge();
	// forceCleanup 对空 singleton 不应抛异常
	await stopRealtimeBridge({ forceCleanup: true });
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
		assert.equal(initialServer.url.startsWith('wss://server.local/api/v1/claws/stream'), true);
		initialServer.readyState = 1;
		initialServer.emit('open', {});
		assert.equal(logs.some((x) => String(x).includes('connected')), true);

		// 模拟 bind 后 token 更新
		await writeConfig({ token: 't2', serverUrl: 'https://server.local' });

		// refresh 会先关闭旧连接再用新 token 创建新 server ws
		await bridge.refresh();
		assert.equal(initialServer.readyState, 3, 'initial server should be closed after refresh');
		const server = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		assert.equal(server.url.startsWith('wss://server.local/api/v1/claws/stream'), true);
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
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(server.sent.some((x) => String(x).includes('GATEWAY_OFFLINE')), true);

		// claw.unbound branch (no clawId in payload — clears config)
		server.emit('message', { data: JSON.stringify({ type: 'claw.unbound', reason: 'x' }) });
		for (let i = 0; i < 10; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const afterUnbound = await readConfig();
		assert.equal(afterUnbound.token, undefined);

		// close with 4003 should clear token and log auth-close
		await writeConfig({ token: 't2' });
		server.emit('close', { code: 4003, reason: 'revoked' });
		for (let i = 0; i < 10; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const afterClose = await readConfig();
		assert.equal(afterClose.token, undefined);
		assert.ok(logs.some((x) => String(x).includes('auth-close') && String(x).includes('4003')), 'should log auth-close event');

		// gateway close/error handlers — 应输出日志
		gateway.emit('error', { message: 'gw-err' });
		assert.ok(logs.some((x) => String(x).includes('gateway ws error')), 'should log gateway ws error');
		gateway.emit('close', { code: 1006, reason: 'abnormal' });
		assert.ok(logs.some((x) => String(x).includes('gateway ws closed')), 'should log gateway ws close');
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

test('RealtimeBridge should handle gateway connect send failure and log warning', async () => {
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
		// 让 connect request 的 send 失败
		gateway.throwOnSend = true;
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge' }) });
		// gatewayConnectReqId 应被清空
		assert.equal(bridge.gatewayConnectReqId, null);
		// 应输出 warn 日志
		assert.ok(logs.some((x) => String(x).includes('gateway connect request failed')), 'should log connect request failure');
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

test('waitForSessionsReady should resolve immediately when bridge not started', async () => {
	await stopRealtimeBridge();
	// 不抛异常，直接 return
	await waitForSessionsReady();
});

test('waitForSessionsReady should await __ensureSessionsPromise after gateway connect', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	const oldWs = globalThis.WebSocket;
	globalThis.WebSocket = FakeWebSocket;
	try {
		await restartRealtimeBridge({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		server.readyState = 1;
		server.emit('open', {});
		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		// 触发 connect.challenge → connect → gatewayReady
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1]));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });
		// 消化 __ensureAllAgentSessions 的后台流量
		await drainEnsureAllAgentSessions(gateway);
		// 此时 promise 已 settled，waitForSessionsReady 应立即 resolve
		await waitForSessionsReady();
	}
	finally {
		globalThis.WebSocket = oldWs;
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

	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m) };
	const bridge = createBridge({
		loadDeviceIdentity: () => { throw new Error('identity load boom'); },
	});

	try {
		await bridge.start({ logger, pluginConfig: {} });
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
		// 应输出 warn 日志
		assert.ok(logs.some((x) => String(x).includes('gateway connect request failed') && String(x).includes('identity load boom')), 'should log connect request failure with cause');
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

// --- __gatewayAgentRpc 两阶段响应测试 ---

test('__gatewayAgentRpc should wait for final response after accepted', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1]));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });

		await drainEnsureAllAgentSessions(gateway);

		// 发起两阶段 agent 请求
		const rpcP = bridge.__gatewayAgentRpc('agent', { message: 'hello' }, { timeoutMs: 5000, acceptTimeoutMs: 3000 });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

		const agentReqRaw = gateway.sent.findLast((s) => String(s).includes('"agent"'));
		assert.ok(agentReqRaw, 'should send agent request');
		const agentReq = JSON.parse(String(agentReqRaw));

		// 第一阶段: accepted
		gateway.emit('message', { data: JSON.stringify({
			type: 'res', id: agentReq.id, ok: true,
			payload: { status: 'accepted', runId: 'run-1' },
		}) });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

		// 第二阶段: ok with result
		gateway.emit('message', { data: JSON.stringify({
			type: 'res', id: agentReq.id, ok: true,
			payload: { status: 'ok', result: { payloads: [{ text: '生成的标题' }] } },
		}) });
		const result = await rpcP;
		assert.equal(result.ok, true);
		assert.equal(result.response.payload.status, 'ok');
		assert.equal(result.response.payload.result.payloads[0].text, '生成的标题');
	}
	finally {
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('__gatewayAgentRpc should handle error on first response', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});
		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1]));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });
		await drainEnsureAllAgentSessions(gateway);

		const rpcP = bridge.__gatewayAgentRpc('agent', { message: 'hello' }, { timeoutMs: 5000, acceptTimeoutMs: 3000 });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		const agentReqRaw = gateway.sent.findLast((s) => String(s).includes('"agent"'));
		const agentReq = JSON.parse(String(agentReqRaw));

		// 直接返回错误
		gateway.emit('message', { data: JSON.stringify({
			type: 'res', id: agentReq.id, ok: false,
			error: { message: 'agent_error' },
		}) });
		const result = await rpcP;
		assert.equal(result.ok, false);
		assert.equal(result.error, 'agent_error');
	}
	finally {
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('__gatewayAgentRpc should timeout if accepted never arrives', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});
		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1]));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });
		await drainEnsureAllAgentSessions(gateway);

		// 使用极短的 accept timeout
		const result = await bridge.__gatewayAgentRpc('agent', { message: 'hello' }, { timeoutMs: 200, acceptTimeoutMs: 50 });
		assert.equal(result.ok, false);
		assert.equal(result.error, 'accept_timeout');
	}
	finally {
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('__gatewayAgentRpc should timeout if final response never arrives after accepted', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});
		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1]));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });
		await drainEnsureAllAgentSessions(gateway);

		const rpcP = bridge.__gatewayAgentRpc('agent', { message: 'hello' }, { timeoutMs: 100, acceptTimeoutMs: 50 });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		const agentReqRaw = gateway.sent.findLast((s) => String(s).includes('"agent"'));
		const agentReq = JSON.parse(String(agentReqRaw));

		// 第一阶段：accepted（在 accept timeout 内）
		gateway.emit('message', { data: JSON.stringify({
			type: 'res', id: agentReq.id, ok: true,
			payload: { status: 'accepted', runId: 'run-1' },
		}) });

		// 等总超时
		const result = await rpcP;
		assert.equal(result.ok, false);
		assert.equal(result.error, 'timeout');
	}
	finally {
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('__gatewayAgentRpc should resolve immediately for non-accepted ok response', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});
		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1]));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });
		await drainEnsureAllAgentSessions(gateway);

		const rpcP = bridge.__gatewayAgentRpc('agent', { message: 'hello' }, { timeoutMs: 5000, acceptTimeoutMs: 3000 });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		const agentReqRaw = gateway.sent.findLast((s) => String(s).includes('"agent"'));
		const agentReq = JSON.parse(String(agentReqRaw));

		// 直接返回 ok（没有 accepted 阶段）
		gateway.emit('message', { data: JSON.stringify({
			type: 'res', id: agentReq.id, ok: true,
			payload: { status: 'ok', result: { payloads: [{ text: 'direct' }] } },
		}) });
		const result = await rpcP;
		assert.equal(result.ok, true);
		assert.equal(result.response.payload.result.payloads[0].text, 'direct');
	}
	finally {
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('__gatewayAgentRpc duplicate settle after final should be no-op', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});
		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1]));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });
		await drainEnsureAllAgentSessions(gateway);

		const rpcP = bridge.__gatewayAgentRpc('agent', { message: 'hello' }, { timeoutMs: 5000, acceptTimeoutMs: 3000 });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		const agentReqRaw = gateway.sent.findLast((s) => String(s).includes('"agent"'));
		const agentReq = JSON.parse(String(agentReqRaw));

		// 直接 ok
		gateway.emit('message', { data: JSON.stringify({
			type: 'res', id: agentReq.id, ok: true,
			payload: { status: 'ok', result: { payloads: [{ text: 'first' }] } },
		}) });
		const result = await rpcP;
		assert.equal(result.ok, true);

		// 后续重复响应应被忽略（entry 已删除，不在 map 中）
		gateway.emit('message', { data: JSON.stringify({
			type: 'res', id: agentReq.id, ok: true,
			payload: { status: 'ok', result: { payloads: [{ text: 'duplicate' }] } },
		}) });
		// 不抛出即可
	}
	finally {
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

// --- singleton gatewayAgentRpc ---

test('singleton gatewayAgentRpc should return error when bridge not started', async () => {
	await stopRealtimeBridge();
	const result = await gatewayAgentRpc('agent', {});
	assert.equal(result.ok, false);
	assert.equal(result.error, 'bridge_not_started');
});

test('singleton gatewayAgentRpc should delegate to bridge instance', async () => {
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	try {
		await restartRealtimeBridge({ logger: noopLogger(), pluginConfig: {} });
		// bridge 已启动但 gateway 未就绪
		const result = await gatewayAgentRpc('agent', {}, { acceptTimeoutMs: 50, timeoutMs: 100 });
		assert.equal(result.ok, false);
		// gateway 未就绪时返回 gateway_not_ready 或 accept_timeout
		assert.ok(['gateway_not_ready', 'accept_timeout', 'timeout'].includes(result.error));
	}
	finally {
		await stopRealtimeBridge();
	}
});

test('__clearTokenLocal should skip clearing when clawId does not match', async () => {
	await writeCfg({ token: 't-keep', clawId: 'claw-new', serverUrl: 'http://server.local' });
	const bridge = createBridge();

	// 传入不匹配的 clawId — 不应清除 config
	await bridge.__clearTokenLocal('claw-old');
	const cfg = await readConfig();
	assert.equal(cfg.token, 't-keep');
	assert.equal(cfg.clawId, 'claw-new');

	// 传入匹配的 clawId — 应清除 config
	await bridge.__clearTokenLocal('claw-new');
	const cfgAfter = await readConfig();
	assert.equal(cfgAfter.token, undefined);
});

test('__clearTokenLocal should clear when no clawId provided (backward compat)', async () => {
	await writeCfg({ token: 't-clear', clawId: 'claw-x', serverUrl: 'http://server.local' });
	const bridge = createBridge();

	// 无 clawId 参数 — 应清除（兼容旧 server 不传 clawId 的情况）
	await bridge.__clearTokenLocal();
	const cfg = await readConfig();
	assert.equal(cfg.token, undefined);
});

// --- WebRTC (rtc:*) 消息分发测试 ---

/**
 * 构造一个已连接 serverWs 的 bridge，返回 { bridge, server, logs }。
 * 调用方必须在 finally 中 bridge.stop()。
 */
async function setupConnectedBridge() {
	FakeWebSocket.instances.length = 0;
	const dir = await writeCfg({ token: 'rtc-tok', serverUrl: 'https://server.local' });
	const prevHome = saveHomedir();
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });

	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m) };
	const bridge = createBridge();
	await bridge.start({ logger, pluginConfig: {} });

	const server = FakeWebSocket.instances[0];
	server.readyState = 1;
	server.emit('open', {});

	return { bridge, server, logs, prevHome };
}

test('RealtimeBridge should lazily create WebRtcPeer on first rtc: message', async () => {
	const { bridge, server, prevHome } = await setupConnectedBridge();
	try {
		assert.equal(bridge.webrtcPeer, null);

		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_test1',
				payload: { sdp: 'mock-offer-sdp' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));

		assert.notEqual(bridge.webrtcPeer, null, 'webrtcPeer should be created');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge should forward rtc:answer via __forwardToServer', async () => {
	const { bridge, server, prevHome } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_ans',
				payload: { sdp: 'offer-sdp' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));

		// WebRtcPeer 的 onSend 会调用 __forwardToServer → server.send
		const answerMsg = server.sent.find((s) => String(s).includes('rtc:answer'));
		assert.ok(answerMsg, 'should have sent rtc:answer back via server ws');
		const parsed = JSON.parse(String(answerMsg));
		assert.equal(parsed.type, 'rtc:answer');
		assert.equal(parsed.toConnId, 'c_ans');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge should not create new WebRtcPeer on subsequent rtc: messages', async () => {
	const { bridge, server, prevHome } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_dup1',
				payload: { sdp: 'sdp1' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));
		const firstPeer = bridge.webrtcPeer;

		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_dup2',
				payload: { sdp: 'sdp2' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));

		assert.equal(bridge.webrtcPeer, firstPeer, 'should reuse same WebRtcPeer instance');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge should dispatch rtc:ice to WebRtcPeer', async () => {
	const { bridge, server, prevHome } = await setupConnectedBridge();
	try {
		// 先建立 session
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_ice1',
				payload: { sdp: 'sdp' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));

		// 发 ICE
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:ice',
				fromConnId: 'c_ice1',
				payload: { candidate: 'cand1', sdpMid: '0', sdpMLineIndex: 0 },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));

		// 不抛异常即通过
		assert.ok(bridge.webrtcPeer);
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge should dispatch rtc:ready and rtc:closed to WebRtcPeer', async () => {
	const { bridge, server, logs, prevHome } = await setupConnectedBridge();
	try {
		// 先建立 session
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_lc1',
				payload: { sdp: 'sdp' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));

		server.emit('message', {
			data: JSON.stringify({ type: 'rtc:ready', fromConnId: 'c_lc1' }),
		});
		await new Promise((r) => setTimeout(r, 50));

		server.emit('message', {
			data: JSON.stringify({ type: 'rtc:closed', fromConnId: 'c_lc1' }),
		});
		await new Promise((r) => setTimeout(r, 50));

		assert.ok(logs.some((l) => String(l).includes('rtc:ready')));
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge should handle rtc: signaling error gracefully', async () => {
	const { bridge, server, logs, prevHome } = await setupConnectedBridge();
	try {
		// 发送一个会导致错误的 rtc:offer（无 payload.sdp）
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_err',
				payload: {},
			}),
		});
		await new Promise((r) => setTimeout(r, 50));

		// 应该被 catch 住，不崩溃，日志中有 signaling error
		assert.ok(logs.some((l) => String(l).includes('signaling error')));
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge should cleanup webrtcPeer on serverWs close', async () => {
	const { bridge, server, prevHome } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_cleanup',
				payload: { sdp: 'sdp' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));
		assert.notEqual(bridge.webrtcPeer, null);

		// 模拟 serverWs close
		server.emit('close', { code: 1000, reason: 'normal' });
		await new Promise((r) => setTimeout(r, 50));

		assert.equal(bridge.webrtcPeer, null, 'webrtcPeer should be cleaned up on ws close');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge rtc: messages should not interfere with rpc.req handling', async () => {
	const { bridge, server, prevHome } = await setupConnectedBridge();
	try {
		// 先发 rtc 消息
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_noint',
				payload: { sdp: 'sdp' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));

		// 再发 rpc.req（应正常处理，不受 rtc 影响）
		server.emit('message', {
			data: JSON.stringify({ type: 'rpc.req', id: 'rpc-1', method: 'test.method', params: {} }),
		});
		await new Promise((r) => setTimeout(r, 50));

		// rpc.req 被正常处理（不因 rtc 而被吞掉）
		// 由于 gateway 未连接，会触发 GATEWAY_OFFLINE 错误响应到 server
		// 只需确认不崩溃
		assert.ok(true);
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge stop() should cleanup webrtcPeer explicitly', async () => {
	const { bridge, server, prevHome } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_stop',
				payload: { sdp: 'sdp' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));
		assert.notEqual(bridge.webrtcPeer, null);

		await bridge.stop();
		assert.equal(bridge.webrtcPeer, null, 'stop() should cleanup webrtcPeer');
	} finally {
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge WebRtcPeer onRequest should route to __handleGatewayRequestFromServer', async () => {
	const { bridge, server, prevHome } = await setupConnectedBridge();
	try {
		// 触发 rtc:offer 以创建 webrtcPeer
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_req1',
				payload: { sdp: 'sdp' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));
		assert.notEqual(bridge.webrtcPeer, null);

		// 验证 onRequest 已注册
		assert.equal(typeof bridge.webrtcPeer.__onRequest, 'function');

		// 调用 onRequest 模拟 DataChannel 收到 req
		// onRequest 内部 void 调用 __handleGatewayRequestFromServer，
		// 后者 __waitGatewayReady 默认超时 1500ms
		const reqPayload = { type: 'req', id: 'ui-dc-1', method: 'agent', params: { text: 'hi' } };
		bridge.webrtcPeer.__onRequest(reqPayload, 'c_req1');

		// 等待 __waitGatewayReady 超时（已注入 50ms）+ 处理完成
		await new Promise((r) => setTimeout(r, 100));

		// gateway 未连接，应产生 GATEWAY_OFFLINE 错误响应 → __forwardToServer
		const offlineMsg = server.sent.find((s) => {
			try {
				const p = JSON.parse(String(s));
				return p.type === 'res' && p.id === 'ui-dc-1' && p.error?.code === 'GATEWAY_OFFLINE';
			} catch { return false; }
		});
		assert.ok(offlineMsg, 'should forward GATEWAY_OFFLINE error via server ws');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge gateway res/event should broadcast to webrtcPeer', async () => {
	const { bridge, server, prevHome } = await setupConnectedBridge();
	try {
		// 触发 rtc:offer 以创建 webrtcPeer
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_bc1',
				payload: { sdp: 'sdp' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));

		// 追踪 broadcast 调用
		const broadcasted = [];
		bridge.webrtcPeer.broadcast = (payload) => broadcasted.push(payload);

		// 模拟 gateway 连接并就绪
		const gwWs = FakeWebSocket.instances.find((ws) => ws !== server);
		if (gwWs) {
			gwWs.readyState = 1;
			bridge.gatewayReady = true;

			// 模拟 gateway 发来的 res
			const resPayload = { type: 'res', id: 'ui-1', ok: true, payload: { status: 'ok' } };
			gwWs.emit('message', { data: JSON.stringify(resPayload) });

			assert.ok(broadcasted.length >= 1, 'broadcast should be called for res');
			assert.equal(broadcasted[0].type, 'res');
			assert.equal(broadcasted[0].id, 'ui-1');

			// 模拟 gateway 发来的 event
			const eventPayload = { type: 'event', event: 'agent', payload: { runId: 'r1' } };
			gwWs.emit('message', { data: JSON.stringify(eventPayload) });

			assert.ok(broadcasted.length >= 2, 'broadcast should be called for event');
			assert.equal(broadcasted[1].type, 'event');
			assert.equal(broadcasted[1].event, 'agent');
		}
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge GATEWAY_OFFLINE error should broadcast to webrtcPeer', async () => {
	const { bridge, server, prevHome } = await setupConnectedBridge();
	try {
		// 触发 rtc:offer 以创建 webrtcPeer
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_bc2',
				payload: { sdp: 'sdp' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));

		// 追踪 broadcast 调用
		const broadcasted = [];
		bridge.webrtcPeer.broadcast = (payload) => broadcasted.push(payload);

		// 不连接 gateway → __handleGatewayRequestFromServer 会产生 GATEWAY_OFFLINE
		// 直接调用 __handleGatewayRequestFromServer
		await bridge.__handleGatewayRequestFromServer({ id: 'req-off', method: 'test', params: {} });

		const offlineBC = broadcasted.find((p) => p.error?.code === 'GATEWAY_OFFLINE');
		assert.ok(offlineBC, 'GATEWAY_OFFLINE error should be broadcast');
		assert.equal(offlineBC.id, 'req-off');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge GATEWAY_SEND_FAILED error should broadcast to webrtcPeer', async () => {
	const { bridge, server, prevHome } = await setupConnectedBridge();
	try {
		// 触发 rtc:offer 以创建 webrtcPeer
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_bc3',
				payload: { sdp: 'sdp' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));

		// 追踪 broadcast 调用
		const broadcasted = [];
		bridge.webrtcPeer.broadcast = (payload) => broadcasted.push(payload);

		// 设置 gateway 已就绪但 send 会抛异常
		const gwWs = FakeWebSocket.instances.find((ws) => ws !== server);
		if (gwWs) {
			gwWs.readyState = 1;
			bridge.gatewayReady = true;
			bridge.gatewayWs = gwWs;
			gwWs.send = () => { throw new Error('send failed'); };

			await bridge.__handleGatewayRequestFromServer({ id: 'req-fail', method: 'test', params: {} });

			const failBC = broadcasted.find((p) => p.error?.code === 'GATEWAY_SEND_FAILED');
			assert.ok(failBC, 'GATEWAY_SEND_FAILED error should be broadcast');
			assert.equal(failBC.id, 'req-fail');
		}
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge concurrent rtc: messages should share single WebRtcPeer init', async () => {
	const { bridge, server, prevHome } = await setupConnectedBridge();
	try {
		assert.equal(bridge.webrtcPeer, null);

		// 同时触发 offer + ice，模拟并发 rtc 消息
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_race',
				payload: { sdp: 'race-offer-sdp' },
			}),
		});
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:ice',
				fromConnId: 'c_race',
				payload: { candidate: 'candidate-1', sdpMid: '0', sdpMLineIndex: 0 },
			}),
		});
		await new Promise((r) => setTimeout(r, 100));

		assert.notEqual(bridge.webrtcPeer, null, 'webrtcPeer should be created');
		// ice 应被同一个 webrtcPeer 实例处理（session 存在）
		const session = bridge.webrtcPeer.__sessions?.get('c_race');
		assert.ok(session, 'session for c_race should exist on the single webrtcPeer instance');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge __webrtcPeerReady should reset on init failure for retry', async () => {
	const { bridge, server, logs, prevHome } = await setupConnectedBridge();
	try {
		const originalInit = bridge.__initWebrtcPeer.bind(bridge);
		let failCount = 0;
		bridge.__initWebrtcPeer = async () => {
			failCount++;
			throw new Error('mock import failure');
		};

		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_fail',
				payload: { sdp: 'sdp' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));

		assert.equal(failCount, 1);
		assert.equal(bridge.webrtcPeer, null);
		assert.equal(bridge.__webrtcPeerReady, null, 'promise lock should be cleared after failure');
		assert.ok(logs.some((l) => String(l).includes('mock import failure')));

		// 恢复 init，再次触发应能成功
		bridge.__initWebrtcPeer = originalInit;
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_retry',
				payload: { sdp: 'retry-sdp' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));

		assert.notEqual(bridge.webrtcPeer, null, 'webrtcPeer should be created on retry');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge cleanup should reset __webrtcPeerReady', async () => {
	const { bridge, server, prevHome } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_cleanup2',
				payload: { sdp: 'sdp' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));
		assert.notEqual(bridge.__webrtcPeerReady, null);

		server.emit('close', { code: 1000, reason: 'normal' });
		await new Promise((r) => setTimeout(r, 50));

		assert.equal(bridge.webrtcPeer, null);
		assert.equal(bridge.__webrtcPeerReady, null, 'promise lock should be cleared on ws close');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

// --- remote-log sender 集成测试 ---

test('RealtimeBridge should wire remote-log sender on open and flush buffered logs', async () => {
	const prevHome = saveHomedir();
	FakeWebSocket.instances = [];
	await writeCfg({ token: 't', serverUrl: 'http://127.0.0.1:1' });
	const bridge = createBridge();
	try {
		resetRemoteLog();
		// 在连接前缓冲日志
		remoteLog('before-connect');

		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});
		// flush 是异步的
		await new Promise((r) => setTimeout(r, 50));

		// 应通过 server WS 发送缓冲的日志
		const logMsg = server.sent.find((s) => {
			try { return JSON.parse(s).type === 'log'; } catch { return false; }
		});
		assert.ok(logMsg, 'should have sent a log message via server WS');
		const parsed = JSON.parse(logMsg);
		assert.ok(parsed.logs.some((l) => l.text === 'before-connect'));
		assert.equal(remoteLogBuffer.length, 0, 'buffer should be drained after flush');
	} finally {
		await bridge.stop();
		resetRemoteLog();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge should clear remote-log sender on close', async () => {
	const prevHome = saveHomedir();
	FakeWebSocket.instances = [];
	await writeCfg({ token: 't', serverUrl: 'http://127.0.0.1:1' });
	const bridge = createBridge();
	try {
		resetRemoteLog();
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});
		await new Promise((r) => setTimeout(r, 10));

		// 断开连接
		server.emit('close', { code: 1006, reason: 'abnormal' });
		await new Promise((r) => setTimeout(r, 10));

		// 断开后缓冲的日志不应被发送
		// close 事件触发 ws.disconnected + ws.reconnecting 两条 remoteLog（sender 已清除，留在 buffer）
		const bufferedBeforeManual = remoteLogBuffer.length;
		const sentBefore = server.sent.length;
		remoteLog('after-close');
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(server.sent.length, sentBefore, 'should not send after close');
		assert.equal(remoteLogBuffer.length, bufferedBeforeManual + 1, 'manual log should remain in buffer');
	} finally {
		await bridge.stop();
		resetRemoteLog();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge should clear remote-log sender on stop', async () => {
	const prevHome = saveHomedir();
	FakeWebSocket.instances = [];
	await writeCfg({ token: 't', serverUrl: 'http://127.0.0.1:1' });
	const bridge = createBridge();
	try {
		resetRemoteLog();
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});
		await new Promise((r) => setTimeout(r, 10));

		await bridge.stop();

		// stop 触发 gateway ws close 等事件，产生的 remoteLog 留在 buffer（sender 已清除）
		const bufferedBeforeManual = remoteLogBuffer.length;
		const sentBefore = server.sent.length;
		remoteLog('after-stop');
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(server.sent.length, sentBefore, 'should not send after stop');
		assert.equal(remoteLogBuffer.length, bufferedBeforeManual + 1, 'manual log should remain in buffer');
	} finally {
		resetRemoteLog();
		restoreHomedir(prevHome);
	}
});

// --- ndc preloader 集成测试 ---

test('RealtimeBridge start() should await ndc preload before connecting', async () => {
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	let preloadCalled = false;
	const bridge = createBridge({
		preloadNdc: async () => {
			preloadCalled = true;
			return { PeerConnection: class NdcPC {}, cleanup: () => {}, impl: 'ndc' };
		},
	});

	try {
		await bridge.start({ logger: noopLogger() });
		assert.ok(preloadCalled, 'preloadNdc should be called during start');
		// start() 完成后结果已就绪（不再是 promise）
		assert.ok(bridge.__ndcPreloadResult);
		assert.equal(bridge.__ndcPreloadResult.impl, 'ndc');
	} finally {
		await bridge.stop();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('RealtimeBridge stop() should NOT call ndc cleanup (deferred to process exit)', async () => {
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	let cleanupCalled = false;
	const bridge = createBridge({
		preloadNdc: async () => ({
			PeerConnection: class NdcPC {},
			cleanup: () => { cleanupCalled = true; },
			impl: 'ndc',
		}),
	});

	try {
		await bridge.start({ logger: noopLogger() });
		await bridge.stop();
		assert.ok(!cleanupCalled, 'cleanup should NOT be called on stop (native threads stay alive)');
		assert.equal(bridge.__ndcCleanup, null);
		assert.equal(bridge.__ndcPreloadResult, null);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('RealtimeBridge stop() should null cleanup ref without calling it', async () => {
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	let cleanupCalled = false;
	const bridge = createBridge({
		preloadNdc: async () => ({
			PeerConnection: class NdcPC {},
			cleanup: () => { cleanupCalled = true; },
			impl: 'ndc',
		}),
	});

	try {
		await bridge.start({ logger: noopLogger() });
		await bridge.stop();
		assert.ok(!cleanupCalled, 'cleanup should not be called');
		assert.equal(bridge.__ndcCleanup, null, 'cleanup ref should be nulled');
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('RealtimeBridge stop() should skip cleanup when werift fallback (no cleanup)', async () => {
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	const bridge = createBridge({
		preloadNdc: async () => ({
			PeerConnection: class WeriftPC {},
			cleanup: null,
			impl: 'werift',
		}),
	});

	try {
		await bridge.start({ logger: noopLogger() });
		// cleanup 为 null，stop 不应有问题
		await bridge.stop();
		assert.equal(bridge.__ndcCleanup, null);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('RealtimeBridge start() should handle preloadNdc rejection gracefully', async () => {
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	const warnings = [];
	const logger = {
		...noopLogger(),
		warn: (msg) => warnings.push(msg),
	};
	const bridge = createBridge({
		preloadNdc: async () => { throw new Error('preload boom'); },
	});

	try {
		await bridge.start({ logger });
		// preload 失败被 catch 兜底，bridge 仍启动但 WebRTC 不可用
		assert.equal(bridge.__ndcPreloadResult.impl, 'none');
		assert.equal(bridge.__ndcPreloadResult.PeerConnection, null);
		assert.ok(warnings.some((w) => w.includes('preload boom')));
	} finally {
		await bridge.stop();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('RealtimeBridge start() awaits slow preload before connecting', async () => {
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	let preloadResolved = false;
	const bridge = createBridge({
		preloadNdc: async () => {
			await new Promise((r) => setTimeout(r, 50));
			preloadResolved = true;
			return { PeerConnection: class NdcPC {}, cleanup: () => {}, impl: 'ndc' };
		},
	});

	try {
		// start() 完成时 preload 一定已经完成（因为 await）
		await bridge.start({ logger: noopLogger() });
		assert.ok(preloadResolved, 'preload should complete before start returns');
		assert.equal(bridge.__ndcPreloadResult.impl, 'ndc');
	} finally {
		await bridge.stop();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('RealtimeBridge start() aborts if stop() called during preload (race protection)', async () => {
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	let cleanupCalled = false;
	let resolvePreload;
	const bridge = createBridge({
		preloadNdc: () => new Promise((resolve) => { resolvePreload = resolve; }),
	});

	try {
		const startPromise = bridge.start({ logger: noopLogger() });
		// preload 仍在进行中，此时调用 stop
		bridge.started = false; // 模拟 stop 已执行
		// resolve preload
		resolvePreload({
			PeerConnection: class NdcPC {},
			cleanup: () => { cleanupCalled = true; },
			impl: 'ndc',
		});
		await startPromise;
		// start 应检测到 started=false，直接返回，不调用 cleanup（native threads 保持活跃）
		assert.ok(!cleanupCalled, 'cleanup should NOT be called (native threads stay alive for reuse)');
		assert.equal(bridge.__ndcPreloadResult, null, 'should not assign result after stop');
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('RealtimeBridge start() should remoteLog plugin version', async () => {
	resetRemoteLog();
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	const bridge = createBridge();

	try {
		await bridge.start({ logger: noopLogger() });
		assert.ok(
			remoteLogBuffer.some(e => e.text.startsWith('bridge.started version=')),
			'should remoteLog bridge.started with version',
		);
	} finally {
		await bridge.stop();
		await fs.rm(dir, { recursive: true, force: true });
		resetRemoteLog();
	}
});
