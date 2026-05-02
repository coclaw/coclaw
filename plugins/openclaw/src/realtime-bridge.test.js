import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import { after, test } from 'node:test';

import { WebSocket as WsWebSocket } from 'ws';
import { RealtimeBridge, classifyAgentLagStop, ensureAgentSession, gatewayAgentRpc, isFinalResMsg, restartRealtimeBridge, stopRealtimeBridge, waitForSessionsReady } from './realtime-bridge.js';
import { readConfig, writeConfig } from './config.js';
import { saveHomedir, setHomedir, restoreHomedir } from './homedir-mock.helper.js';
import { setRuntime } from './runtime.js';
import { remoteLog, __reset as resetRemoteLog, __buffer as remoteLogBuffer } from './remote-log.js';

// singleton 测试会调用真实 preloadNdc → initLogger 注册 native TSFN，
// 阻止进程退出。finally 中的 stop 不带 forceCleanup，cleanup ref 已丢失，
// 需直接调 ndc cleanup 兜底释放 TSFN。
after(async () => {
	try { await stopRealtimeBridge({ forceCleanup: true }); } catch { /* best-effort */ }
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

/** 默认 preloadPion mock：返回 null（pion 不可用，降级到 ndc） */
async function noopPreloadPion() {
	return null;
}

function createBridge(overrides = {}) {
	return new RealtimeBridge({
		WebSocket: FakeWebSocket,
		resolveGatewayAuthToken: () => '',
		preloadPion: noopPreloadPion,
		preloadNdc: noopPreloadNdc,
		gatewayReadyTimeoutMs: 50,
		...overrides,
	});
}

/**
 * 消化 gateway connect 成功后并发的后台流量：
 * - __ensureAllAgentSessions 发出的 agents.list + sessions.resolve
 * - __pushInstanceInfo → __collectAgentModels 发出的 agents.list（不影响主流程）
 * 所有未响应的 agents.list 统一回一份含 main 的列表，避免 RPC 等待超时拖慢测试。
 */
async function drainEnsureAllAgentSessions(gateway) {
	const respondedIds = new Set();
	const respondAgentsList = () => {
		for (const raw of gateway.sent) {
			const s = String(raw);
			if (!s.includes('agents.list')) continue;
			let msg;
			try { msg = JSON.parse(s); } catch { continue; }
			if (msg.method !== 'agents.list' || respondedIds.has(msg.id)) continue;
			respondedIds.add(msg.id);
			gateway.emit('message', { data: JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: { defaultId: 'main', agents: [{ id: 'main' }] } }) });
		}
	};
	// 第一轮等 __ensureAllAgentSessions 的 agents.list 发出
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	respondAgentsList();
	// 再等一轮：__pushInstanceInfo 在 readSettings / getPluginVersion 之后才发出 agents.list
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	respondAgentsList();
	// 响应 sessions.resolve for main
	const resolveRaw = gateway.sent.find((s) => String(s).includes('sessions.resolve') && String(s).includes('agent:main:main'));
	if (resolveRaw) {
		const rMsg = JSON.parse(String(resolveRaw));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: rMsg.id, ok: true, payload: { ok: true, key: 'agent:main:main' } }) });
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	}
}

// --- __resolveWebSocket 三态测试 ---

test('__resolveWebSocket should return ws package WebSocket when deps.WebSocket is omitted', () => {
	const bridge = new RealtimeBridge({});
	assert.equal(bridge.__resolveWebSocket(), WsWebSocket);
});

test('__resolveWebSocket should return null when deps.WebSocket is explicitly null', () => {
	const bridge = new RealtimeBridge({ WebSocket: null });
	assert.equal(bridge.__resolveWebSocket(), null);
});

test('__resolveWebSocket should return custom impl when deps.WebSocket is provided', () => {
	const bridge = new RealtimeBridge({ WebSocket: FakeWebSocket });
	assert.equal(bridge.__resolveWebSocket(), FakeWebSocket);
});

// --- 单例便捷 API 测试 ---

test('singleton API should no-op for missing token and restart/stop should be safe', async () => {
	await writeCfg({ token: '' });
	const logger = noopLogger();
	try {
		await restartRealtimeBridge({ logger, pluginConfig: { serverUrl: 'http://127.0.0.1:1' } });
		await restartRealtimeBridge({ logger, pluginConfig: { serverUrl: 'http://127.0.0.1:1' } });
		await stopRealtimeBridge();
		const cfg = await readConfig();
		assert.equal(cfg.token, '');
	}
	finally {
		await stopRealtimeBridge();
	}
});

test('restartRealtimeBridge should re-create singleton after stop (bind regression)', async () => {
	await writeCfg({ token: '' });
	const logger = noopLogger();
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
		await stopRealtimeBridge();
	}
});

test('stopRealtimeBridge({ forceCleanup: true }) should call __ndcCleanup', async () => {
	await writeCfg({ token: '' });
	const logger = noopLogger();
	try {
		const opts = { logger, pluginConfig: { serverUrl: 'http://127.0.0.1:1' } };
		await restartRealtimeBridge(opts);
		// restartRealtimeBridge 后 singleton 的 __ndcCleanup 取决于 preload 结果
		// （可能为 null 或真实 cleanup）。再次 stop 并 forceCleanup 应不抛异常。
		await stopRealtimeBridge({ forceCleanup: true });
	}
	finally {
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
	try {
		const opts = { logger, pluginConfig: {} };
		await restartRealtimeBridge(opts);
		// 再次 restart 不应报错，应正常替换
		await restartRealtimeBridge(opts);
		const result = await ensureAgentSession('main');
		assert.notEqual(result.error, 'bridge_not_started');
	}
	finally {
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

test('bridge should log warning when WebSocket is explicitly disabled (null)', async () => {
	await writeCfg({ token: 't1', serverUrl: 'http://127.0.0.1:3000' });
	const warns = [];
	const logger = { warn: (m) => warns.push(String(m)), info() {} };
	const bridge = new RealtimeBridge({ WebSocket: null });
	await bridge.start({ logger, pluginConfig: {} });
	assert.equal(warns.some((x) => x.includes('WebSocket not available')), true);
	await bridge.stop();
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

		// server WS 收到未识别的消息类型，静默忽略
		const gwSentBefore = gateway.sent.length;
		const serverSentBefore = server.sent.length;
		server.emit('message', { data: JSON.stringify({ type: 'rpc.req', id: '1', method: 'm1', params: { a: 1 } }) });
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(gateway.sent.length, gwSentBefore, 'unrecognized message should NOT be forwarded to gateway');
		assert.equal(server.sent.length, serverSentBefore, 'unrecognized message should NOT produce any response');

		// gateway message parse ignore / non-object / res / event（不再转发到 server WS）
		gateway.emit('message', { data: '{bad-json' });
		gateway.emit('message', { data: '123' });
		const serverSentBeforeGw = server.sent.length;
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: '1', ok: true, payload: { ok: 1 } }) });
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'e1', payload: { x: 1 } }) });
		assert.equal(server.sent.length, serverSentBeforeGw, 'gateway res/event should NOT be forwarded to server WS');

		// server message parse failed
		server.emit('message', { data: '{bad-json' });
		assert.equal(logs.some((x) => String(x).includes('parse failed')), true);

		// 未识别消息在任何状态下都被忽略
		gateway.readyState = 0;
		const serverSentBeforeOffline = server.sent.length;
		server.emit('message', { data: JSON.stringify({ type: 'rpc.req', id: '3', method: 'm3' }) });
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(server.sent.length, serverSentBeforeOffline, 'unrecognized message should be ignored regardless of gateway state');

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
		// 新行为回归锁：close handler 应记一次失败并调度下一次重试
		assert.equal(bridge.__gatewayAttempts, 1, 'one failure should have been counted');
		assert.ok(bridge.__gatewayRetryTimer, 'next retry should have been scheduled');
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

test('RealtimeBridge: stale server socket 迟到的 open 不应再注入 sender / 启心跳', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	const infoLogs = [];
	const bridge = createBridge();
	const customLogger = { warn() {}, info(msg) { infoLogs.push(String(msg)); }, debug() {} };
	try {
		await bridge.start({ logger: customLogger, pluginConfig: {} });
		const oldServer = FakeWebSocket.instances[0];
		oldServer.readyState = 1;
		oldServer.emit('open', {});
		const connectedCountAfterFirst = infoLogs.filter((l) => l.includes('realtime bridge connected')).length;
		assert.equal(connectedCountAfterFirst, 1);

		await writeConfig({ token: 't2', serverUrl: 'http://server.local' });
		await bridge.refresh();
		const newServer = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		newServer.readyState = 1;
		newServer.emit('open', {});
		const connectedCountAfterRefresh = infoLogs.filter((l) => l.includes('realtime bridge connected')).length;
		assert.equal(connectedCountAfterRefresh, 2);

		// 旧 sock 迟到的 open：guard 应阻止任何后续工作
		oldServer.emit('open', {});
		const connectedCountAfterStale = infoLogs.filter((l) => l.includes('realtime bridge connected')).length;
		assert.equal(connectedCountAfterStale, 2, 'stale open 不应再触发 connected 日志');
		assert.equal(bridge.serverWs, newServer);
	}
	finally {
		await bridge.stop();
	}
});

test('RealtimeBridge: stale server socket 迟到的 message 不应重置当前 sock 的 hb timeout', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const oldServer = FakeWebSocket.instances[0];
		oldServer.readyState = 1;
		oldServer.emit('open', {});

		await writeConfig({ token: 't2', serverUrl: 'http://server.local' });
		await bridge.refresh();
		const newServer = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		newServer.readyState = 1;
		newServer.emit('open', {});

		// spy __resetServerHbTimeout：旧 sock emit message 后 spy 不应被调
		let resetCalls = 0;
		const orig = bridge.__resetServerHbTimeout.bind(bridge);
		bridge.__resetServerHbTimeout = (sock) => { resetCalls += 1; return orig(sock); };

		oldServer.emit('message', { data: '{}' });
		assert.equal(resetCalls, 0, 'stale message 不应触发 __resetServerHbTimeout');

		newServer.emit('message', { data: '{}' });
		assert.equal(resetCalls, 1, 'current sock message 仍应触发 __resetServerHbTimeout');
	}
	finally {
		await bridge.stop();
	}
});

test('RealtimeBridge: stale server sock close 不应清当前 sock 的 heartbeat / connect timer', async () => {
	// __clearServerHeartbeat / __clearConnectTimer 都是 per-bridge 全局单槽，旧 sock 的 close
	// 事件若跑在 stale guard 前会清掉新 sock 的 heartbeat
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const oldServer = FakeWebSocket.instances[0];
		oldServer.readyState = 1;
		oldServer.emit('open', {});

		await writeConfig({ token: 't2', serverUrl: 'http://server.local' });
		await bridge.refresh();
		const newServer = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		newServer.readyState = 1;
		newServer.emit('open', {});

		// spy __clearServerHeartbeat：旧 sock close 后不应被调（guard 会早返回）
		let clearCalls = 0;
		const origClear = bridge.__clearServerHeartbeat.bind(bridge);
		bridge.__clearServerHeartbeat = () => { clearCalls += 1; return origClear(); };

		// 模拟旧 sock 迟到的 close：不影响新 sock 的 timer
		oldServer.readyState = 3;
		oldServer.emit('close', { code: 1006, reason: 'stale' });
		await new Promise((r) => setTimeout(r, 0));

		assert.equal(clearCalls, 0, 'stale close 不应触发 __clearServerHeartbeat');
		assert.equal(bridge.serverWs, newServer, '当前 serverWs 不应被旧 sock close 改写');
	}
	finally {
		await bridge.stop();
	}
});

test('RealtimeBridge: stale gateway ws 迟到的 connect.challenge 不应触发握手发送', async () => {
	// 与 server sock 已加的 stale guard 对称：旧 gateway ws 关闭后若仍有迟到的 connect.challenge，
	// __sendGatewayConnectRequest 会写 this.gatewayConnectReqId，污染当前 gateway ws 的握手状态
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gw1 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gw1.readyState = 1;
		gw1.emit('open', {});
		// 第一次 challenge：gw1 应正常发出 connect-request
		gw1.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const gw1SentAfterFirst = gw1.sent.length;
		assert.ok(gw1SentAfterFirst >= 1, 'gw1 should send connect-request on first challenge');

		// 模拟 gateway ws 已被新实例替换（无需真起新 ws，只需让 this.gatewayWs !== gw1）
		const sentinel = { __dummy: true };
		bridge.gatewayWs = sentinel;

		// 旧 gw1 迟到一个 connect.challenge：guard 应阻止任何后续工作
		gw1.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n2' } }) });
		assert.equal(gw1.sent.length, gw1SentAfterFirst, 'stale gw1 challenge 不应再触发 connect-request 发送');
		assert.equal(bridge.gatewayWs, sentinel, 'this.gatewayWs 不应被旧 ws 的 challenge handler 改写');
	}
	finally {
		await bridge.stop();
	}
});

test('__handleGatewayRequestFromDc: 缺 id/method 不向 gateway 转发，含 id 时回 INVALID_REQUEST', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	const bridge = createBridge();
	const broadcasted = [];
	const sentToGateway = [];
	bridge.webrtcPeer = {
		broadcast: (p) => broadcasted.push(p),
		destroy: () => {},
		closeAll: () => Promise.resolve(),
	};
	bridge.gatewayWs = { readyState: 1, send: (m) => sentToGateway.push(m), close: () => {} };
	bridge.gatewayReady = true;

	// 缺 id + 缺 method → drop + warn，不转发，不 broadcast
	await bridge.__handleGatewayRequestFromDc({}, 'connA');
	assert.equal(sentToGateway.length, 0);
	assert.equal(broadcasted.length, 0);

	// 有合法 id 但 method 缺失 → broadcast INVALID_REQUEST，不转发
	await bridge.__handleGatewayRequestFromDc({ id: 'req-1' }, 'connA');
	assert.equal(sentToGateway.length, 0);
	const inv = broadcasted.find((p) => p.error?.code === 'INVALID_REQUEST');
	assert.ok(inv, 'should broadcast INVALID_REQUEST when id is valid but method is missing');
	assert.equal(inv.id, 'req-1');

	// id 是数字（非 string）→ drop，不 broadcast
	const broadcastsBefore = broadcasted.length;
	await bridge.__handleGatewayRequestFromDc({ id: 123, method: 'm' }, 'connA');
	assert.equal(sentToGateway.length, 0);
	assert.equal(broadcasted.length, broadcastsBefore);

	// 合法 id + method → 正常转发到 gateway
	await bridge.__handleGatewayRequestFromDc({ id: 'req-ok', method: 'agents.list' }, 'connA');
	assert.equal(sentToGateway.length, 1);
	const sent = JSON.parse(sentToGateway[0]);
	assert.equal(sent.id, 'req-ok');
	assert.equal(sent.method, 'agents.list');
});

test('RealtimeBridge: __closeGatewayWs 主动关闭时立即清 lag probe', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		bridge.__startLagProbe('rid-test-1');
		bridge.__startLagProbe('rid-test-2');
		assert.equal(bridge.__agentLagProbes.size, 2);

		bridge.__closeGatewayWs();
		assert.equal(bridge.__agentLagProbes.size, 0, '__closeGatewayWs 应立即清掉所有 lag probe');
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

test('RealtimeBridge waitGatewayReady should handle ws reference change (DC path)', async () => {
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

		// mock webrtcPeer.broadcast 以捕获错误响应
		const broadcasted = [];
		bridge.webrtcPeer = { broadcast: (p) => broadcasted.push(p), destroy: () => {}, closeAll: () => Promise.resolve() };

		// 发起一个需要 gateway ready 的请求（此时 gateway 不 ready，会进入 waitGatewayReady 循环）
		// 在等待过程中 close gateway ws
		const reqP = bridge.__handleGatewayRequestFromDc({ id: 'test-req', method: 'test.m' });
		// 模拟 gateway ws 关闭
		gw.emit('close', {});
		await reqP;
		// 应通过 DC broadcast 收到 GATEWAY_OFFLINE 响应
		const offlineMsg = broadcasted.find((p) => p.error?.code === 'GATEWAY_OFFLINE');
		assert.ok(offlineMsg, 'should broadcast GATEWAY_OFFLINE via DC');
		assert.equal(offlineMsg.id, 'test-req');
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
	try {
		await restartRealtimeBridge({ logger: noopLogger(), pluginConfig: {}, __deps: { WebSocket: FakeWebSocket } });
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

// --- gateway 握手重试 + legacy 回退测试 ---

const FAKE_DEVICE_IDENTITY = {
	deviceId: 'fake-device-id',
	publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAtzDL7h2Z4PZiOmNjmyl+U2gKexygXrWLjOWMufVSZKU=\n-----END PUBLIC KEY-----\n',
	privateKeyPem: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJYc25BaxT+DkFPCYoNeX0a5Vtv3VPJ+o9iEHcuh3+G6\n-----END PRIVATE KEY-----\n',
};

const GATEWAY_RETRY_DELAYS = [5_000, 10_000, 20_000, 20_000, 20_000];

/**
 * 替换 global.setTimeout / clearTimeout，捕获 setTimeout 回调以便测试手动触发。
 * restore() 必须在测试 finally 中调用。fireFirstRetryTimer() 触发当前最早的未取消、未触发的
 * retry 定时器（只识别 GATEWAY_RETRY_DELAYS 中的延时值），返回 true/false 表示是否有可触发。
 */
function captureTimers() {
	const realSetTimeout = global.setTimeout;
	const realClearTimeout = global.clearTimeout;
	const timers = [];
	global.setTimeout = ((fn, ms) => {
		const obj = { __fn: fn, __ms: ms, __cancelled: false, __fired: false, unref() {} };
		timers.push(obj);
		return obj;
	});
	global.clearTimeout = ((t) => {
		if (t && typeof t === 'object' && typeof t.__ms === 'number') {
			t.__cancelled = true;
		}
	});
	return {
		timers,
		restore() {
			global.setTimeout = realSetTimeout;
			global.clearTimeout = realClearTimeout;
		},
		fireFirstRetryTimer() {
			const t = timers.find((x) => !x.__cancelled && !x.__fired && GATEWAY_RETRY_DELAYS.includes(x.__ms));
			if (!t) return false;
			t.__fired = true;
			t.__fn();
			return true;
		},
	};
}

async function bootGatewayWithChallenge(bridge) {
	await bridge.start({ logger: noopLogger(), pluginConfig: {} });
	const server = FakeWebSocket.instances[0];
	server.readyState = 1;
	server.emit('open', {});
	const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
	gateway.readyState = 1;
	gateway.emit('open', {});
	gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
	return { server, gateway };
}

function lastConnectReq(gateway) {
	const raw = gateway.sent.findLast?.((s) => String(s).includes('"method":"connect"'))
		?? [...gateway.sent].reverse().find((s) => String(s).includes('"method":"connect"'));
	return raw ? JSON.parse(String(raw)) : null;
}

/**
 * 采集本次测试里所有 remoteLog 的 text：
 *   - sock.sent 中已被 flush 出去的 batch（async flush 只同步 drain 一次就 await，后续会堵）
 *   - remoteLogBuffer 中尚未 flush 的残余
 * 两者合并即是这次测试发起的 remoteLog 全集，顺序不严格保证但对按模式断言足够。
 */
function collectRemoteLogTexts(serverWs) {
	const texts = [];
	for (const raw of serverWs.sent) {
		let msg;
		try { msg = JSON.parse(String(raw)); }
		catch { continue; }
		if (msg?.type === 'log' && Array.isArray(msg.logs)) {
			for (const entry of msg.logs) {
				if (entry && typeof entry.text === 'string') texts.push(entry.text);
			}
		}
	}
	for (const entry of remoteLogBuffer) {
		if (entry && typeof entry.text === 'string') texts.push(entry.text);
	}
	return texts;
}

test('v3 handshake signature failure triggers legacy fallback on the same WS', async () => {
	FakeWebSocket.instances.length = 0;
	resetRemoteLog();
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const bridge = createBridge({
		resolveGatewayAuthToken: () => 'tkn',
		loadDeviceIdentity: () => FAKE_DEVICE_IDENTITY,
	});
	try {
		const { gateway } = await bootGatewayWithChallenge(bridge);
		const v3Req = lastConnectReq(gateway);
		assert.ok(v3Req.params.device, 'first connect should carry device field (v3)');

		// v3 失败：device signature invalid
		gateway.emit('message', { data: JSON.stringify({
			type: 'res', id: v3Req.id, ok: false,
			error: { message: 'device signature invalid' },
		}) });

		// 同一条 WS 上已发出 legacy 握手（无 device 字段）
		assert.equal(gateway.readyState, 1, 'gateway WS should NOT be closed during fallback');
		const legacyReq = lastConnectReq(gateway);
		assert.notEqual(legacyReq.id, v3Req.id, 'legacy request should have a new id');
		assert.equal(legacyReq.params.device, undefined, 'legacy request must omit device field');
		assert.equal(legacyReq.params.auth?.token, 'tkn', 'auth token should be preserved');
		assert.deepEqual(legacyReq.params.scopes, ['operator.admin']);

		// bridge 内部状态
		assert.equal(bridge.__gatewayLegacyMode, true, 'legacy mode learned');
		assert.equal(bridge.__gatewayAttempts, 0, 'fallback in same WS should NOT count as failure');

		// remoteLog 仅一条 fallback，不应有 connect-failed / disconnected
		const server = FakeWebSocket.instances[0];
		const logs = collectRemoteLogTexts(server);
		assert.ok(logs.some((m) => /gateway\.handshake\.fallback v3→legacy/.test(m)));
		assert.ok(!logs.some((m) => /ws\.connect-failed peer=gateway/.test(m)));
	}
	finally {
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('legacy fallback success marks gateway ready and keeps legacy mode', async () => {
	FakeWebSocket.instances.length = 0;
	resetRemoteLog();
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const bridge = createBridge({
		resolveGatewayAuthToken: () => 'tkn',
		loadDeviceIdentity: () => FAKE_DEVICE_IDENTITY,
	});
	try {
		const { gateway } = await bootGatewayWithChallenge(bridge);
		const v3Req = lastConnectReq(gateway);
		gateway.emit('message', { data: JSON.stringify({
			type: 'res', id: v3Req.id, ok: false,
			error: { message: 'device signature invalid' },
		}) });
		const legacyReq = lastConnectReq(gateway);
		gateway.emit('message', { data: JSON.stringify({
			type: 'res', id: legacyReq.id, ok: true, payload: {},
		}) });

		assert.equal(bridge.gatewayReady, true);
		assert.equal(bridge.__gatewayLegacyMode, true);
		assert.equal(bridge.__gatewayAttempts, 0);

		const server = FakeWebSocket.instances[0];
		const logs = collectRemoteLogTexts(server);
		assert.ok(logs.some((m) => m === 'ws.connected peer=gateway'));
	}
	finally {
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('v3 handshake non-signature failure does NOT trigger legacy and schedules retry', async () => {
	FakeWebSocket.instances.length = 0;
	resetRemoteLog();
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const t = captureTimers();
	const bridge = createBridge({ loadDeviceIdentity: () => FAKE_DEVICE_IDENTITY });
	try {
		const { server, gateway } = await bootGatewayWithChallenge(bridge);
		const req = lastConnectReq(gateway);
		// "auth failed" 不含签名/协议关键词，不应触发 legacy 回退
		gateway.emit('message', { data: JSON.stringify({
			type: 'res', id: req.id, ok: false,
			error: { message: 'auth failed' },
		}) });
		assert.equal(gateway.readyState, 3, 'gateway ws closed after non-recoverable failure');
		assert.equal(bridge.__gatewayLegacyMode, false, 'legacy mode NOT set on non-signature failure');
		assert.equal(bridge.__gatewayAttempts, 1, 'one failure counted');
		// 下一次尝试已调度（delay[0]=5s）
		const retryTimer = t.timers.find((x) => !x.__cancelled && x.__ms === 5_000);
		assert.ok(retryTimer, 'a 5s retry timer should be scheduled');

		const logs = collectRemoteLogTexts(server);
		assert.ok(logs.some((m) => /ws\.connect-failed peer=gateway msg=auth failed/.test(m)));
		// connectFailReported 抑制重复的 disconnected 日志
		assert.equal(logs.filter((m) => /peer=gateway/.test(m)).length, 1,
			'only one gateway-related log (no duplicate disconnected)');
	}
	finally {
		t.restore();
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('learned legacy mode sends legacy handshake on subsequent WS challenge', async () => {
	FakeWebSocket.instances.length = 0;
	resetRemoteLog();
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const t = captureTimers();
	const bridge = createBridge({ loadDeviceIdentity: () => FAKE_DEVICE_IDENTITY });
	try {
		// 先经历一轮 v3→legacy→legacy 失败的完整流程，学会 legacyMode
		const { gateway: gw1 } = await bootGatewayWithChallenge(bridge);
		const v3 = lastConnectReq(gw1);
		gw1.emit('message', { data: JSON.stringify({
			type: 'res', id: v3.id, ok: false,
			error: { message: 'device signature invalid' },
		}) });
		const legacy = lastConnectReq(gw1);
		gw1.emit('message', { data: JSON.stringify({
			type: 'res', id: legacy.id, ok: false,
			error: { message: 'auth failed' },
		}) });
		assert.equal(gw1.readyState, 3);
		assert.equal(bridge.__gatewayLegacyMode, true);

		// 触发第一个重试定时器（5s），进入第二条 WS
		assert.equal(t.fireFirstRetryTimer(), true, 'first retry timer fired');
		const gw2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		assert.notEqual(gw2, gw1);
		gw2.readyState = 1;
		gw2.emit('open', {});
		gw2.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n2' } }) });

		const nextReq = lastConnectReq(gw2);
		assert.equal(nextReq.params.device, undefined, 'should use legacy directly (no device field)');
	}
	finally {
		t.restore();
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('gateway retry exhausts after 5 attempts and enters gave-up state', async () => {
	FakeWebSocket.instances.length = 0;
	resetRemoteLog();
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const t = captureTimers();
	const bridge = createBridge({ loadDeviceIdentity: () => FAKE_DEVICE_IDENTITY });
	try {
		// 首次尝试：fail with 'auth failed'
		const { gateway: gw0 } = await bootGatewayWithChallenge(bridge);
		const req0 = lastConnectReq(gw0);
		gw0.emit('message', { data: JSON.stringify({ type: 'res', id: req0.id, ok: false, error: { message: 'auth failed' } }) });
		assert.equal(bridge.__gatewayAttempts, 1);

		// 5 次重试，每次都失败
		const instancesBefore = [gw0];
		for (let i = 0; i < 5; i++) {
			assert.equal(t.fireFirstRetryTimer(), true, `retry #${i + 1} timer fired`);
			const gw = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
			assert.ok(!instancesBefore.includes(gw), `retry #${i + 1} should create a new WS`);
			instancesBefore.push(gw);
			gw.readyState = 1;
			gw.emit('open', {});
			gw.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: `n${i}` } }) });
			const req = lastConnectReq(gw);
			gw.emit('message', { data: JSON.stringify({ type: 'res', id: req.id, ok: false, error: { message: 'auth failed' } }) });
		}

		// 第 6 次失败（5 次重试用完） → gave-up
		assert.equal(bridge.__gatewayAttempts, 6);
		assert.equal(bridge.__gatewayGaveUp, true);
		assert.equal(bridge.__gatewayRetryTimer, null, 'no further timer scheduled after gave-up');

		// 再次触发 __ensureGatewayConnection 应是 no-op（不创建新 WS）
		const instancesCount = FakeWebSocket.instances.length;
		bridge.__ensureGatewayConnection();
		assert.equal(FakeWebSocket.instances.length, instancesCount);

		// remoteLog 有一条 gave-up
		const server = FakeWebSocket.instances[0];
		const logs = collectRemoteLogTexts(server);
		assert.ok(logs.some((m) => /gateway\.handshake\.gave-up attempts=6 lastReason=auth failed/.test(m)));
		// 刷屏治理：在这 6 次尝试中 ws.connect-failed 应该恰好 6 条
		assert.equal(logs.filter((m) => /ws\.connect-failed peer=gateway/.test(m)).length, 6);
	}
	finally {
		t.restore();
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('__waitGatewayReady returns false when gateway has given up', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const bridge = createBridge({ loadDeviceIdentity: () => FAKE_DEVICE_IDENTITY });
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});
		// 直接强置 gave-up 状态（模拟已经耗尽）
		bridge.__gatewayGaveUp = true;
		bridge.__closeGatewayWs();
		const ready = await bridge.__waitGatewayReady(25);
		assert.equal(ready, false);
	}
	finally {
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('gateway disconnection after successful handshake reschedules with fresh retry budget', async () => {
	FakeWebSocket.instances.length = 0;
	resetRemoteLog();
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const bridge = createBridge({ loadDeviceIdentity: () => FAKE_DEVICE_IDENTITY });
	try {
		const { gateway } = await bootGatewayWithChallenge(bridge);
		const req = lastConnectReq(gateway);
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: req.id, ok: true, payload: {} }) });
		await drainEnsureAllAgentSessions(gateway);
		assert.equal(bridge.gatewayReady, true);

		// 提前消化已有的后台定时器后再切到捕获模式，避免干扰
		const t = captureTimers();
		try {
			// 先跑掉 attempts 到 3，模拟之前已累计过失败（验证 wasReady 路径重置计数）
			bridge.__gatewayAttempts = 3;
			// 模拟 gateway 自行关闭
			gateway.readyState = 3;
			for (const fn of gateway.listeners.get('close') ?? []) {
				fn({ code: 1006, reason: 'remote' });
			}
			// wasReady=true → attempts 被重置为 0，然后 __onGatewayAttemptFailed 递增到 1
			assert.equal(bridge.__gatewayAttempts, 1);
			const retryTimer = t.timers.find((x) => !x.__cancelled && x.__ms === 5_000);
			assert.ok(retryTimer, 'should schedule retry with fresh 5s delay');
			// 成功后断开应打 disconnected 日志（connectFailReported=false）
			const server = FakeWebSocket.instances[0];
			const logs = collectRemoteLogTexts(server);
			assert.ok(logs.some((m) => /ws\.disconnected peer=gateway code=1006/.test(m)));
		}
		finally {
			t.restore();
		}
	}
	finally {
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('__onGatewayAttemptFailed is a no-op when retry timer already scheduled', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const t = captureTimers();
	const bridge = createBridge({ loadDeviceIdentity: () => FAKE_DEVICE_IDENTITY });
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});
		// 手动设置一个 retryTimer，模拟已经调度
		bridge.__gatewayRetryTimer = { __ms: 5_000, __cancelled: false, unref() {} };
		bridge.__gatewayLastReason = 'prev';
		const attemptsBefore = bridge.__gatewayAttempts;
		bridge.__onGatewayAttemptFailed('forced');
		assert.equal(bridge.__gatewayAttempts, attemptsBefore, 'should not increment when timer already set');
		assert.equal(bridge.__gatewayLastReason, 'prev',
			'lastReason should NOT be overwritten when guard short-circuits');
		// 清理手动设置的 timer 避免 stop() 误操作
		bridge.__gatewayRetryTimer = null;
	}
	finally {
		t.restore();
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('__onGatewayAttemptFailed is a no-op when bridge is stopped', async () => {
	FakeWebSocket.instances.length = 0;
	const bridge = createBridge({ loadDeviceIdentity: () => FAKE_DEVICE_IDENTITY });
	// bridge 从未 start，started=false
	bridge.__onGatewayAttemptFailed('forced');
	assert.equal(bridge.__gatewayAttempts, 0);
	assert.equal(bridge.__gatewayRetryTimer, null);
});

test('__closeGatewayWs cancels pending retry timer and resets attempts', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const t = captureTimers();
	const bridge = createBridge({ loadDeviceIdentity: () => FAKE_DEVICE_IDENTITY });
	try {
		const { gateway } = await bootGatewayWithChallenge(bridge);
		const req = lastConnectReq(gateway);
		// 先让握手失败，让 __onGatewayAttemptFailed 调度出一个 retry timer
		gateway.emit('message', { data: JSON.stringify({
			type: 'res', id: req.id, ok: false, error: { message: 'auth failed' },
		}) });
		const scheduled = t.timers.find((x) => !x.__cancelled && x.__ms === 5_000);
		assert.ok(scheduled, 'retry timer should exist');
		assert.equal(bridge.__gatewayAttempts, 1);

		// 模拟 server WS 失效：__closeGatewayWs 应取消 retry timer 并归零 attempts
		bridge.__closeGatewayWs();
		assert.equal(scheduled.__cancelled, true, 'retry timer should be cancelled');
		assert.equal(bridge.__gatewayRetryTimer, null);
		assert.equal(bridge.__gatewayAttempts, 0,
			'attempts reset so new server session starts with fresh retry budget');
		// __gatewayGaveUp / __gatewayLegacyMode 保留——只由 stop() 复位（设计意图）
		assert.equal(bridge.__gatewayGaveUp, false);
		assert.equal(bridge.__gatewayLegacyMode, false);
	}
	finally {
		t.restore();
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('refresh resets gateway retry state so next start attempts v3 from scratch', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const bridge = createBridge({ loadDeviceIdentity: () => FAKE_DEVICE_IDENTITY });
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		// 人工脏化新字段，模拟 bridge 正处于各种学到/终态
		bridge.__gatewayAttempts = 4;
		bridge.__gatewayGaveUp = true;
		bridge.__gatewayLegacyMode = true;
		bridge.__gatewayLastReason = 'prev failure';
		bridge.__gatewayRetryTimer = setTimeout(() => {}, 999_999);

		await bridge.refresh();

		assert.equal(bridge.__gatewayAttempts, 0);
		assert.equal(bridge.__gatewayGaveUp, false);
		assert.equal(bridge.__gatewayLegacyMode, false);
		assert.equal(bridge.__gatewayLastReason, null);
		assert.equal(bridge.__gatewayRetryTimer, null);
	}
	finally {
		await bridge.stop();
		process.chdir(prevCwd);
		restoreHomedir(prevHome);
	}
});

test('gateway ws error handler defensively closes the ws to unblock retry flow', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const bridge = createBridge({ loadDeviceIdentity: () => FAKE_DEVICE_IDENTITY });
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});
		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		// 触发 error 事件（未伴随 close）
		gateway.emit('error', { message: 'simulated' });
		// error handler 应主动调 ws.close(1011, ...) → readyState=3 + close 事件被 emit
		assert.equal(gateway.readyState, 3, 'error handler should have closed the ws');
		assert.equal(bridge.gatewayWs, null, 'close handler should have cleared gatewayWs');
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

		// 未识别的消息类型被静默忽略，只需确认不崩溃
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

test('RealtimeBridge WebRtcPeer onRequest should route to __handleGatewayRequestFromDc', async () => {
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

		// 追踪 DC broadcast
		const broadcasted = [];
		bridge.webrtcPeer.broadcast = (payload) => broadcasted.push(payload);

		// 调用 onRequest 模拟 DataChannel 收到 req
		const reqPayload = { type: 'req', id: 'ui-dc-1', method: 'agent', params: { text: 'hi' } };
		bridge.webrtcPeer.__onRequest(reqPayload, 'c_req1');

		// 等待 __waitGatewayReady 超时（已注入 50ms）+ 处理完成
		await new Promise((r) => setTimeout(r, 100));

		// gateway 未连接，应产生 GATEWAY_OFFLINE 错误响应 → broadcast to DC（不再发 server WS）
		const offlineBC = broadcasted.find((p) => p.type === 'res' && p.id === 'ui-dc-1' && p.error?.code === 'GATEWAY_OFFLINE');
		assert.ok(offlineBC, 'should broadcast GATEWAY_OFFLINE error via DC');
		// 确认不会发送到 server WS
		const serverOffline = server.sent.find((s) => {
			try { return JSON.parse(String(s)).error?.code === 'GATEWAY_OFFLINE'; }
			catch { return false; }
		});
		assert.equal(serverOffline, undefined, 'should NOT forward GATEWAY_OFFLINE to server WS');
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

test('RealtimeBridge gateway health/tick events are filtered (not forwarded to DC)', async () => {
	const { bridge, server, prevHome } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_filter',
				payload: { sdp: 'sdp' },
			}),
		});
		await new Promise((r) => setTimeout(r, 50));

		const broadcasted = [];
		bridge.webrtcPeer.broadcast = (payload) => broadcasted.push(payload);

		const gwWs = FakeWebSocket.instances.find((ws) => ws !== server);
		assert.ok(gwWs, 'gateway ws should exist');
		gwWs.readyState = 1;
		bridge.gatewayReady = true;

		// health / tick 被拦截
		gwWs.emit('message', { data: JSON.stringify({ type: 'event', event: 'health', payload: { ok: true } }) });
		gwWs.emit('message', { data: JSON.stringify({ type: 'event', event: 'tick', payload: { ts: 1 } }) });
		assert.equal(broadcasted.length, 0, 'health/tick must not be forwarded');

		// 其他 event 正常转发
		gwWs.emit('message', { data: JSON.stringify({ type: 'event', event: 'agent', payload: { runId: 'r1' } }) });
		assert.equal(broadcasted.length, 1);
		assert.equal(broadcasted[0].event, 'agent');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge GATEWAY_OFFLINE error should broadcast to webrtcPeer (DC path)', async () => {
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

		// 不连接 gateway → __handleGatewayRequestFromDc 会产生 GATEWAY_OFFLINE
		await bridge.__handleGatewayRequestFromDc({ id: 'req-off', method: 'test', params: {} });

		const offlineBC = broadcasted.find((p) => p.error?.code === 'GATEWAY_OFFLINE');
		assert.ok(offlineBC, 'GATEWAY_OFFLINE error should be broadcast');
		assert.equal(offlineBC.id, 'req-off');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge GATEWAY_SEND_FAILED error should broadcast to webrtcPeer (DC path)', async () => {
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

			await bridge.__handleGatewayRequestFromDc({ id: 'req-fail', method: 'test', params: {} });

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
		// 等待 pion preload（noopPreloadPion）完成后，ndc preload 才会被调用
		await new Promise((r) => setTimeout(r, 0));
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

test('RealtimeBridge start() aborts with pion cleanup when stop() during pion preload', async () => {
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	let cleanupCalled = false;
	let resolvePion;
	const bridge = createBridge({
		preloadPion: () => new Promise((resolve) => { resolvePion = resolve; }),
	});

	try {
		const startPromise = bridge.start({ logger: noopLogger() });
		// 等待 start → __preloadWebrtc → preloadPion() 被调用
		await new Promise((r) => setTimeout(r, 0));
		bridge.started = false; // 模拟 stop 已执行
		resolvePion({
			PeerConnection: class PionPC {},
			cleanup: async () => { cleanupCalled = true; },
			impl: 'pion',
		});
		await startPromise;
		// pion impl → start 应调用 cleanup 关闭 Go 进程
		assert.ok(cleanupCalled, 'pion cleanup should be called on race abort');
		assert.equal(bridge.__ndcPreloadResult, null, 'should not assign result after stop');
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('RealtimeBridge start() locally logs coclaw.env line and remoteLogs bridge.started (no env remoteLog)', async () => {
	resetRemoteLog();
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	const infoLogs = [];
	const logger = { ...noopLogger(), info: (m) => infoLogs.push(m) };
	const bridge = createBridge();

	try {
		await bridge.start({ logger });
		// bridge.started 是启动完成标记
		assert.ok(
			remoteLogBuffer.some(e => e.text === 'bridge.started'),
			'should remoteLog bridge.started',
		);
		// 启动时 coclaw.env 只本地 log，不进 remoteLog buffer——ws.open 才是唯一 remote 来源，避免重复
		assert.ok(
			!remoteLogBuffer.some(e => e.text.startsWith('coclaw.env ')),
			'should NOT remoteLog coclaw.env at start; ws.open is the single source',
		);
		// 本地 logger.info 输出 coclaw.env 一条，字段值必须具体（不能退化到 pending/unknown）
		const envInfo = infoLogs.find((m) => m.includes('coclaw.env '));
		assert.ok(envInfo, 'should log coclaw.env locally via logger.info');
		// impl 必须是已知 webrtc 实现之一；回归为 'pending' 即视为 fail
		assert.match(envInfo, /\bimpl=(?:pion|node-datachannel\(ndc\)|werift|none)\b/);
		// plugin 必须是语义版本；回归为 'unknown' 即视为 fail
		assert.match(envInfo, /\bplugin=\d+\.\d+\.\d+/);
		// openclaw 在测试环境 runtime=null 时为 'unknown'，生产环境为语义版本
		assert.match(envInfo, /\bopenclaw=(?:unknown|\d+\.\d+\.\d+)/);
		assert.match(envInfo, /\bplatform=/);
		assert.match(envInfo, /\bnode=v\d+/);
	} finally {
		await bridge.stop();
		await fs.rm(dir, { recursive: true, force: true });
		resetRemoteLog();
	}
});

test('RealtimeBridge __buildEnvLine reflects getRuntime version across branches', () => {
	const bridge = createBridge();
	// 为 __buildEnvLine 准备两个依赖字段（正常由 start() 赋值，这里直接注入做单元测试）
	bridge.__pluginVersion = '1.2.3';
	bridge.__implLabel = 'pion';

	// 分支 1：runtime 缺失 → openclaw=unknown
	setRuntime(null);
	assert.match(bridge.__buildEnvLine(), /\bopenclaw=unknown\b/);

	// 分支 2：runtime.version === 'unknown'（打包路径解析失败占位）→ openclaw=unknown
	setRuntime({ version: 'unknown' });
	assert.match(bridge.__buildEnvLine(), /\bopenclaw=unknown\b/);

	// 分支 3：正常版本 → openclaw=4.5.0
	setRuntime({ version: '4.5.0' });
	const line = bridge.__buildEnvLine();
	assert.match(line, /\bopenclaw=4\.5\.0\b/);
	// 同时验证 impl / plugin 也进入了同一行
	assert.match(line, /\bimpl=pion\b/);
	assert.match(line, /\bplugin=1\.2\.3\b/);

	// 清理全局 runtime，避免影响后续测试
	setRuntime(null);
});

test('RealtimeBridge ws.open re-emits coclaw.env on reconnect (after sender injected)', async () => {
	const prevHome = saveHomedir();
	FakeWebSocket.instances = [];
	await writeCfg({ token: 't', serverUrl: 'http://127.0.0.1:1' });
	const bridge = createBridge();
	try {
		resetRemoteLog();
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		// 第一次 ws open
		const server1 = FakeWebSocket.instances[0];
		server1.readyState = 1;
		server1.emit('open', {});
		await new Promise((r) => setTimeout(r, 10));

		// 第一次 open 期间发出的 ws.connected / coclaw.env / bridge.webrtc-impl 已被 sender flush 到 server1.sent
		const collectTexts = (sock) => {
			const out = [];
			for (const s of sock.sent) {
				try {
					const p = JSON.parse(s);
					if (p?.type === 'log') out.push(...p.logs.map((l) => l.text));
				} catch { /* skip */ }
			}
			return out;
		};
		const firstTexts = collectTexts(server1);
		const firstEnv = firstTexts.find((t) => t.startsWith('coclaw.env '));
		assert.ok(firstEnv, 'first ws.open should emit coclaw.env');

		// 模拟 ws 断开 → 重连
		server1.emit('close', { code: 1006, reason: 'server-restart' });
		await new Promise((r) => setTimeout(r, 10));
		// 触发 reconnect
		await bridge.__connectIfNeeded();
		const server2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		assert.notEqual(server1, server2, 'should create a new ws instance on reconnect');
		server2.readyState = 1;
		server2.emit('open', {});
		await new Promise((r) => setTimeout(r, 10));

		// 第二次 ws.open 必须再次发出 coclaw.env（覆盖 impl + plugin/openclaw 版本 + 平台信息）
		const secondTexts = collectTexts(server2);
		const reEmitted = secondTexts.find((t) => t.startsWith('coclaw.env '));
		assert.ok(reEmitted, 'reconnected ws.open should re-emit coclaw.env');
		// 收紧为具体值（防回归到 pending/unknown 被静默放行）
		assert.match(reEmitted, /\bimpl=(?:pion|node-datachannel\(ndc\)|werift|none)\b/);
		assert.match(reEmitted, /\bplugin=\d+\.\d+\.\d+/);
		assert.match(reEmitted, /\bopenclaw=(?:unknown|\d+\.\d+\.\d+)/);
		assert.match(reEmitted, /\bplatform=/);
		// 缓存不变量：两次连接发出的 envLine 内容必须字节一致
		assert.equal(reEmitted, firstEnv,
			'env line must be identical across reconnects (verifies cached plugin+openclaw+platform)');
	} finally {
		await bridge.stop();
		resetRemoteLog();
		restoreHomedir(prevHome);
	}
});

// --- __collectAgentModels 测试 ---

test('RealtimeBridge __collectAgentModels should map agents with name fallback and model.primary', async () => {
	const bridge = createBridge();
	bridge.__gatewayRpc = async (method, params, options) => {
		assert.equal(method, 'agents.list');
		assert.deepEqual(params, {});
		// 明确断言 timeoutMs，防止静默改参数导致等待行为改变
		assert.equal(options?.timeoutMs, 3000);
		return {
			ok: true,
			response: { payload: { agents: [
				{ id: 'main', name: 'Main Agent', model: { primary: 'claude-opus-4' } },
				{ id: 'proj-a', model: { primary: 'claude-sonnet-4' } }, // 无 name → 回退到 id
				{ id: 'no-model' }, // 无 model → primary 回退到 null
			] } },
		};
	};
	const models = await bridge.__collectAgentModels();
	assert.deepEqual(models, [
		{ id: 'main', name: 'Main Agent', model: 'claude-opus-4' },
		{ id: 'proj-a', name: 'proj-a', model: 'claude-sonnet-4' },
		{ id: 'no-model', name: 'no-model', model: null },
	]);
});

test('RealtimeBridge __collectAgentModels should return null when gateway rpc fails', async () => {
	const bridge = createBridge();
	bridge.__gatewayRpc = async () => ({ ok: false, error: 'gateway_not_ready' });
	const models = await bridge.__collectAgentModels();
	assert.equal(models, null);
});

test('RealtimeBridge __collectAgentModels should return null when agents payload is not an array', async () => {
	const bridge = createBridge();
	bridge.__gatewayRpc = async () => ({ ok: true, response: { payload: { defaultId: 'main' } } });
	const models = await bridge.__collectAgentModels();
	assert.equal(models, null);
});

test('RealtimeBridge __collectAgentModels should return null when gateway rpc throws', async () => {
	const bridge = createBridge();
	bridge.__gatewayRpc = async () => { throw new Error('unexpected'); };
	const models = await bridge.__collectAgentModels();
	assert.equal(models, null);
});

test('RealtimeBridge __collectAgentModels should return empty array when agents list is empty', async () => {
	const bridge = createBridge();
	bridge.__gatewayRpc = async () => ({ ok: true, response: { payload: { agents: [] } } });
	const models = await bridge.__collectAgentModels();
	assert.deepEqual(models, []);
});

// --- __pushInstanceInfo 测试 ---

test('RealtimeBridge __pushInstanceInfo should broadcast full info payload after gateway connect', async () => {
	FakeWebSocket.instances.length = 0;
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });

	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';

	try {
		await restartRealtimeBridge({
			logger: noopLogger(),
			pluginConfig: {},
			__deps: {
				WebSocket: FakeWebSocket,
				resolveGatewayAuthToken: () => '',
				preloadPion: noopPreloadPion,
				preloadNdc: noopPreloadNdc,
				gatewayReadyTimeoutMs: 50,
			},
		});
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });

		// 响应 ensureAllAgentSessions + __pushInstanceInfo 内部的 agents.list
		await drainEnsureAllAgentSessions(gateway);
		// 额外再等一轮，确保 broadcastPluginEvent 完成
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

		const eventMsgs = server.sent
			.map((s) => { try { return JSON.parse(String(s)); } catch { return null; } })
			.filter((m) => m?.type === 'event' && m?.event === 'coclaw.info.updated');
		assert.ok(eventMsgs.length >= 1, 'should emit coclaw.info.updated event');
		const payload = eventMsgs[eventMsgs.length - 1].payload;
		assert.ok('name' in payload, 'payload should contain name field');
		assert.ok('hostName' in payload, 'payload should contain hostName field');
		assert.ok('pluginVersion' in payload, 'payload should contain pluginVersion field');
		assert.ok('agentModels' in payload, 'payload should contain agentModels field');
		assert.equal(typeof payload.hostName, 'string');
		assert.ok(Array.isArray(payload.agentModels), 'agentModels should be array when agents.list succeeds');
		assert.equal(payload.agentModels.length, 1, 'drain helper returns exactly 1 agent (main)');
		// 对映射结果做三字段全断言，确保 __collectAgentModels 的 name/model 回退也在集成路径生效
		const first = payload.agentModels[0];
		assert.equal(first.id, 'main');
		assert.equal(first.name, 'main'); // drain helper 返回的 agents 仅带 id，name 应回退到 id
		assert.equal(first.model, null); // drain helper 返回的 agents 无 model 字段 → null
	}
	finally {
		await stopRealtimeBridge({ forceCleanup: true });
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		restoreHomedir(prevHome);
	}
});

test('RealtimeBridge __pushInstanceInfo should emit agentModels=null when agents.list fails', async () => {
	FakeWebSocket.instances.length = 0;
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });

	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';

	try {
		await restartRealtimeBridge({
			logger: noopLogger(),
			pluginConfig: {},
			__deps: {
				WebSocket: FakeWebSocket,
				resolveGatewayAuthToken: () => '',
				preloadPion: noopPreloadPion,
				preloadNdc: noopPreloadNdc,
				gatewayReadyTimeoutMs: 50,
			},
		});
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});

		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });

		// Poll-with-deadline：__ensureAllAgentSessions 和 __pushInstanceInfo 并发发 agents.list，
		// 后者需要先 await readSettings + getPluginVersion 才触发，慢 CI 上固定 microtask 数不可靠。
		// 循环扫描直到两个请求都被响应（或超时兜底）。
		const respondedIds = new Set();
		const deadline = Date.now() + 500;
		while (Date.now() < deadline) {
			let newlyResponded = false;
			for (const raw of gateway.sent) {
				const s = String(raw);
				if (!s.includes('agents.list')) continue;
				let msg;
				try { msg = JSON.parse(s); } catch { continue; }
				if (msg.method !== 'agents.list' || respondedIds.has(msg.id)) continue;
				respondedIds.add(msg.id);
				gateway.emit('message', { data: JSON.stringify({ type: 'res', id: msg.id, ok: false, error: { code: 'boom', message: 'rpc failed' } }) });
				newlyResponded = true;
			}
			// 收到至少 2 个请求且本轮无新请求 → 认为全部到齐
			if (!newlyResponded && respondedIds.size >= 2) break;
			await new Promise((r) => setTimeout(r, 1));
		}
		assert.ok(respondedIds.size >= 2, `should observe agents.list from both __ensureAllAgentSessions and __pushInstanceInfo (got ${respondedIds.size})`);
		// 给 broadcastPluginEvent 完成最后几个 await 的余地
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

		const eventMsgs = server.sent
			.map((s) => { try { return JSON.parse(String(s)); } catch { return null; } })
			.filter((m) => m?.type === 'event' && m?.event === 'coclaw.info.updated');
		assert.ok(eventMsgs.length >= 1, 'should still emit coclaw.info.updated despite agents.list failure');
		const payload = eventMsgs[eventMsgs.length - 1].payload;
		assert.equal(payload.agentModels, null, 'agentModels should be null when agents.list fails');
		assert.ok('name' in payload);
		assert.ok('hostName' in payload);
		assert.ok('pluginVersion' in payload);
	}
	finally {
		await stopRealtimeBridge({ forceCleanup: true });
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		restoreHomedir(prevHome);
	}
});

// --- agent run lag 探针 ---

test('lag probe: __startLagProbe registers entry and logs lag.start', () => {
	const logs = [];
	const bridge = createBridge();
	bridge.logger = {
		info: (m) => logs.push({ level: 'info', m: String(m) }),
		warn: (m) => logs.push({ level: 'warn', m: String(m) }),
	};
	bridge.__startLagProbe('rpc-1');
	assert.equal(bridge.__agentLagProbes.size, 1);
	assert.ok(bridge.__agentLagProbes.has('rpc-1'));
	assert.ok(logs.some((l) => l.m === '[coclaw] lag.start id=rpc-1'));
	// 同 id 重复启动 no-op
	bridge.__startLagProbe('rpc-1');
	assert.equal(bridge.__agentLagProbes.size, 1);
	bridge.__clearAllLagProbes();
});

test('lag probe: __stopLagProbe removes entry, logs summary, and is idempotent', () => {
	const logs = [];
	const bridge = createBridge();
	bridge.logger = {
		info: (m) => logs.push({ level: 'info', m: String(m) }),
		warn: (m) => logs.push({ level: 'warn', m: String(m) }),
	};
	bridge.__startLagProbe('rpc-2');
	bridge.__stopLagProbe('rpc-2', 'ok');
	assert.equal(bridge.__agentLagProbes.size, 0);
	const summary = logs.find((l) => l.m.startsWith('[coclaw] lag.summary id=rpc-2'));
	assert.ok(summary);
	assert.match(summary.m, /reason=ok dur=\d+ms ticks=\d+ max=\d+ms over100=\d+ sumOver=\d+ms/);
	// 不存在的 id no-op
	assert.doesNotThrow(() => bridge.__stopLagProbe('nope', 'ok'));
});

test('lag probe: __clearAllLagProbes clears every in-flight entry', () => {
	const bridge = createBridge();
	bridge.logger = noopLogger();
	bridge.__startLagProbe('a');
	bridge.__startLagProbe('b');
	bridge.__startLagProbe('c');
	assert.equal(bridge.__agentLagProbes.size, 3);
	bridge.__clearAllLagProbes();
	assert.equal(bridge.__agentLagProbes.size, 0);
});

test('lag probe: interval callback spike branch is exception-safe (gateway must not crash)', () => {
	// 把 setInterval / setTimeout / Date.now 都截下来，可手动制造 spike 触发条件。
	const oldSetInterval = global.setInterval;
	const oldSetTimeout = global.setTimeout;
	const oldDateNow = Date.now;
	let capturedIntervalFn = null;
	global.setInterval = ((fn) => {
		capturedIntervalFn = fn;
		return { unref() {} };
	});
	global.setTimeout = ((_fn) => ({ unref() {} }));
	let nowVal = 1000;
	Date.now = () => nowVal;
	try {
		const bridge = createBridge();
		bridge.logger = {
			info() {},
			warn: () => { throw new Error('logger broken'); },
		};
		bridge.__startLagProbe('rpc-x'); // lastTick = 1000
		// 推进时钟使 lag = (now - lastTick) - period = (1500 - 1000) - 200 = 300 > threshold(100)
		nowVal = 1500;
		assert.ok(capturedIntervalFn);
		// spike 分支会调用 logger.warn → 抛异常 → 应被 interval body 的 try/catch 吞掉
		assert.doesNotThrow(() => capturedIntervalFn());
		bridge.__clearAllLagProbes();
	}
	finally {
		global.setInterval = oldSetInterval;
		global.setTimeout = oldSetTimeout;
		Date.now = oldDateNow;
	}
});

test('lag probe: __startLagProbe is exception-safe when lag.start logger throws (must not bubble to caller)', () => {
	const bridge = createBridge();
	// 同一个 logger 同时让 info 抛 —— 模拟 __handleGatewayRequestFromDc 的 try 块里
	// __startLagProbe 抛出会被误判为 send 失败的灾难场景。
	bridge.logger = {
		info: () => { throw new Error('info broken'); },
		warn() {},
	};
	assert.doesNotThrow(() => bridge.__startLagProbe('rpc-z'));
	// 但 Map 仍应记录该探针（清理路径才能找到它）
	assert.equal(bridge.__agentLagProbes.has('rpc-z'), true);
	bridge.__clearAllLagProbes();
});

test('lag probe: __stopLagProbe is exception-safe when summary logger throws', () => {
	const bridge = createBridge();
	bridge.logger = {
		info: () => { throw new Error('info broken'); },
		warn() {},
	};
	bridge.__startLagProbe('rpc-y');
	assert.doesNotThrow(() => bridge.__stopLagProbe('rpc-y', 'ok'));
	assert.equal(bridge.__agentLagProbes.size, 0);
});

test('classifyAgentLagStop: returns null for non-res / non-string id / accepted', () => {
	assert.equal(classifyAgentLagStop({}), null, 'no type → null');
	assert.equal(classifyAgentLagStop({ type: 'event', id: 'x' }), null, 'event → null');
	assert.equal(classifyAgentLagStop({ type: 'res' }), null, 'no id → null');
	assert.equal(classifyAgentLagStop({ type: 'res', id: 123 }), null, 'numeric id → null');
	assert.equal(classifyAgentLagStop(null), null, 'null payload → null');
	assert.equal(classifyAgentLagStop(undefined), null, 'undefined payload → null');
	// accepted 是 phase-1 ack，不是终态
	assert.equal(classifyAgentLagStop({ type: 'res', id: 'a', payload: { status: 'accepted' } }), null);
});

test('classifyAgentLagStop: returns reason for ok / error / ok=false-no-status', () => {
	assert.equal(classifyAgentLagStop({ type: 'res', id: 'a', payload: { status: 'ok' } }), 'ok');
	assert.equal(classifyAgentLagStop({ type: 'res', id: 'a', ok: false, payload: { status: 'error' } }), 'error');
	// 参数校验失败：协议文档"特殊情况" — ok=false 且无 status 字段
	assert.equal(classifyAgentLagStop({ type: 'res', id: 'a', ok: false, error: { code: 'INVALID_REQUEST' } }), 'error');
	// 边界：res 且 ok=true 但无 status → 视为成功（防御性兜底）
	assert.equal(classifyAgentLagStop({ type: 'res', id: 'a', ok: true }), 'ok');
});

test('lag probe: __handleGatewayRequestFromDc starts probe only for method="agent"', async () => {
	FakeWebSocket.instances.length = 0;
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.lagstart';
	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});
		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n' } }) });
		const connectReq = gateway.sent.map((s) => { try { return JSON.parse(String(s)); } catch { return null; } }).find((m) => m?.method === 'connect');
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true }) });
		await drainEnsureAllAgentSessions(gateway);
		// gatewayReady=true 后调用 handler
		await bridge.__handleGatewayRequestFromDc({ method: 'agent', id: 'agent-rpc-1', params: {} });
		assert.equal(bridge.__agentLagProbes.has('agent-rpc-1'), true, 'agent method should start probe');
		await bridge.__handleGatewayRequestFromDc({ method: 'sessions.list', id: 'sess-rpc-1', params: {} });
		assert.equal(bridge.__agentLagProbes.has('sess-rpc-1'), false, 'non-agent method should NOT start probe');
		bridge.__clearAllLagProbes();
	}
	finally {
		await bridge.stop();
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		restoreHomedir(prevHome);
	}
});

test('lag probe: gateway WS close clears all in-flight probes (no 60s wait)', async () => {
	FakeWebSocket.instances.length = 0;
	const prevHome = saveHomedir();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });
	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.lagtest';
	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		// server WS open 才会触发 gateway WS 创建
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});
		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		assert.equal(gateway.url, 'ws://gw.lagtest');
		gateway.readyState = 1;
		// 不需要完成 connect 握手——close handler 在 ws 创建时就已注册
		bridge.__startLagProbe('rpc-stuck-1');
		bridge.__startLagProbe('rpc-stuck-2');
		assert.equal(bridge.__agentLagProbes.size, 2);
		gateway.emit('close', { code: 1006, reason: 'remote dropped' });
		assert.equal(bridge.__agentLagProbes.size, 0, 'WS close handler should clear all in-flight probes');
	}
	finally {
		await bridge.stop();
		process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		restoreHomedir(prevHome);
	}
});

test('lag probe: bridge.stop() clears any residual probes', async () => {
	const bridge = createBridge();
	await bridge.start({ logger: noopLogger(), pluginConfig: {} });
	bridge.__startLagProbe('rpc-stop-1');
	assert.equal(bridge.__agentLagProbes.size, 1);
	await bridge.stop();
	assert.equal(bridge.__agentLagProbes.size, 0);
});

// --- isFinalResMsg 单测 ---

test('isFinalResMsg: accepted is intermediate', () => {
	assert.equal(isFinalResMsg({ type: 'res', id: 'x', payload: { status: 'accepted' } }), false);
});

test('isFinalResMsg: ok / error / started / in_flight are final', () => {
	assert.equal(isFinalResMsg({ type: 'res', id: 'x', payload: { status: 'ok' } }), true);
	assert.equal(isFinalResMsg({ type: 'res', id: 'x', payload: { status: 'error' } }), true);
	assert.equal(isFinalResMsg({ type: 'res', id: 'x', payload: { status: 'started' } }), true);
	assert.equal(isFinalResMsg({ type: 'res', id: 'x', payload: { status: 'in_flight' } }), true);
});

test('isFinalResMsg: missing status is final (covers ok/false-without-status fallback)', () => {
	assert.equal(isFinalResMsg({ type: 'res', id: 'x', payload: {} }), true);
	assert.equal(isFinalResMsg({ type: 'res', id: 'x', ok: false }), true);
});

test('isFinalResMsg: non-res / null / undefined / non-object payload returns false', () => {
	assert.equal(isFinalResMsg({ type: 'event', event: 'agent' }), false);
	assert.equal(isFinalResMsg(null), false);
	assert.equal(isFinalResMsg(undefined), false);
	assert.equal(isFinalResMsg({ type: 'res', id: 'x', payload: null }), true);
});

// --- DC RPC 单播路由表测试 ---

/**
 * 构造一个已连接 server + 已就绪 gateway + 已创建 webrtcPeer 的 bridge。
 * 返回 { bridge, server, gwWs, prevHome }。调用方需在 finally 中 bridge.stop()。
 */
async function setupBridgeWithGateway(rtcConnId = 'c_dc') {
	const ctx = await setupConnectedBridge();
	const { bridge, server } = ctx;
	server.emit('message', {
		data: JSON.stringify({
			type: 'rtc:offer',
			fromConnId: rtcConnId,
			payload: { sdp: 'sdp' },
		}),
	});
	await new Promise((r) => setTimeout(r, 50));
	const gwWs = FakeWebSocket.instances.find((ws) => ws !== server);
	gwWs.readyState = 1;
	bridge.gatewayReady = true;
	bridge.gatewayWs = gwWs;
	return { ...ctx, gwWs };
}

test('dc unicast: terminal res hits sendTo, broadcast not called, mapping cleared', async () => {
	const { bridge, gwWs, prevHome } = await setupBridgeWithGateway('c_uc1');
	try {
		const sentTo = [];
		const broadcasted = [];
		bridge.webrtcPeer.sendTo = (connId, payload) => {
			sentTo.push({ connId, payload });
			return true;
		};
		bridge.webrtcPeer.broadcast = (payload) => broadcasted.push(payload);

		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-uuid-1', method: 'sessions.list', params: {} },
			'c_uc1'
		);
		assert.ok(bridge.__dcPendingRequests.has('ui-uuid-1'), 'mapping should be written after send');

		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-uuid-1', ok: true, payload: { status: 'ok', items: [] } }),
		});

		assert.equal(sentTo.length, 1, 'sendTo should be called once');
		assert.equal(sentTo[0].connId, 'c_uc1');
		assert.equal(sentTo[0].payload.id, 'ui-uuid-1');
		assert.equal(broadcasted.length, 0, 'broadcast must not be called for unicast hit');
		assert.equal(bridge.__dcPendingRequests.has('ui-uuid-1'), false, 'mapping cleared on terminal');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('dc unicast: agent two-stage keeps mapping on accepted, clears on terminal', async () => {
	const { bridge, gwWs, prevHome } = await setupBridgeWithGateway('c_agent');
	try {
		const sentTo = [];
		bridge.webrtcPeer.sendTo = (connId, payload) => { sentTo.push({ connId, payload }); return true; };
		bridge.webrtcPeer.broadcast = () => { throw new Error('broadcast should not be called'); };

		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-agent-1', method: 'agent', params: { input: 'hi' } },
			'c_agent'
		);
		// accepted 阶段：保留映射
		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-agent-1', ok: true, payload: { status: 'accepted', runId: 'r1' } }),
		});
		assert.equal(sentTo.length, 1);
		assert.equal(sentTo[0].payload.payload.status, 'accepted');
		assert.equal(bridge.__dcPendingRequests.has('ui-agent-1'), true, 'mapping kept on accepted');

		// 终态：清映射
		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-agent-1', ok: true, payload: { status: 'ok', result: 'done' } }),
		});
		assert.equal(sentTo.length, 2);
		assert.equal(bridge.__dcPendingRequests.has('ui-agent-1'), false, 'mapping cleared on terminal');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('dc unicast: approval two-stage follows same accepted/terminal pattern', async () => {
	const { bridge, gwWs, prevHome } = await setupBridgeWithGateway('c_apv');
	try {
		const sentTo = [];
		bridge.webrtcPeer.sendTo = (connId, payload) => { sentTo.push(payload); return true; };
		bridge.webrtcPeer.broadcast = () => { throw new Error('broadcast should not be called'); };

		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-apv-1', method: 'exec.approval.request', params: {} },
			'c_apv'
		);
		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-apv-1', ok: true, payload: { status: 'accepted' } }),
		});
		assert.equal(bridge.__dcPendingRequests.has('ui-apv-1'), true, 'kept on accepted');

		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-apv-1', ok: true, payload: { status: 'ok', decision: 'approved' } }),
		});
		assert.equal(sentTo.length, 2);
		assert.equal(bridge.__dcPendingRequests.has('ui-apv-1'), false);
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('dc unicast: chat.send single-frame status="started" clears immediately', async () => {
	const { bridge, gwWs, prevHome } = await setupBridgeWithGateway('c_chat');
	try {
		const sentTo = [];
		bridge.webrtcPeer.sendTo = (connId, payload) => { sentTo.push(payload); return true; };
		bridge.webrtcPeer.broadcast = () => { throw new Error('broadcast should not be called'); };

		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-chat-1', method: 'chat.send', params: {} },
			'c_chat'
		);
		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-chat-1', ok: true, payload: { status: 'started' } }),
		});
		assert.equal(sentTo.length, 1, 'sendTo called once');
		assert.equal(bridge.__dcPendingRequests.has('ui-chat-1'), false, 'cleared immediately on started (non-accepted)');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('dc unicast: single-stage RPC clears mapping on response', async () => {
	const { bridge, gwWs, prevHome } = await setupBridgeWithGateway('c_single');
	try {
		const sentTo = [];
		bridge.webrtcPeer.sendTo = (connId, payload) => { sentTo.push(payload); return true; };
		bridge.webrtcPeer.broadcast = () => { throw new Error('broadcast should not be called'); };

		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-resolve-1', method: 'sessions.resolve', params: {} },
			'c_single'
		);
		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-resolve-1', ok: true, payload: { status: 'ok', key: 'k' } }),
		});
		assert.equal(sentTo.length, 1);
		assert.equal(bridge.__dcPendingRequests.has('ui-resolve-1'), false);
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('dc unicast: collision deletes prior entry and warns', async () => {
	const { bridge, gwWs, prevHome } = await setupBridgeWithGateway('c_col1');
	try {
		const warns = [];
		bridge.logger = { ...bridge.logger, warn: (m) => warns.push(String(m)) };
		bridge.webrtcPeer.sendTo = () => true;
		bridge.webrtcPeer.broadcast = () => {};

		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-dup', method: 'sessions.list', params: {} },
			'c_col1'
		);
		assert.equal(bridge.__dcPendingRequests.get('ui-dup').connId, 'c_col1');

		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-dup', method: 'sessions.list', params: {} },
			'c_col2'
		);
		assert.ok(warns.some((m) => m.includes('duplicate dc reqId')), 'should warn on collision');
		assert.equal(bridge.__dcPendingRequests.get('ui-dup').connId, 'c_col2', 'mapping replaced with new connId');

		// 模拟旧响应到来：命中走单播分支（按 connId='c_col2' 发），符合"删旧后再写入新"语义
		const sentTo = [];
		bridge.webrtcPeer.sendTo = (connId, payload) => { sentTo.push({ connId, payload }); return true; };
		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-dup', ok: true, payload: { status: 'ok' } }),
		});
		assert.equal(sentTo.length, 1);
		assert.equal(sentTo[0].connId, 'c_col2');
		assert.equal(bridge.__dcPendingRequests.has('ui-dup'), false);
		// gwWs 变量被使用，避免 lint 告警
		assert.ok(gwWs);
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('dc unicast: GATEWAY_OFFLINE keeps broadcast and writes no mapping', async () => {
	const { bridge, prevHome } = await setupBridgeWithGateway('c_off');
	try {
		// 重置 gateway 为未就绪
		bridge.gatewayReady = false;
		bridge.gatewayWs = null;

		const broadcasted = [];
		bridge.webrtcPeer.broadcast = (payload) => broadcasted.push(payload);
		bridge.webrtcPeer.sendTo = () => { throw new Error('sendTo should not be called'); };

		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-off-1', method: 'sessions.list', params: {} },
			'c_off'
		);
		const offlineBC = broadcasted.find((p) => p.error?.code === 'GATEWAY_OFFLINE');
		assert.ok(offlineBC, 'OFFLINE should still be broadcast');
		assert.equal(bridge.__dcPendingRequests.size, 0, 'mapping not written for OFFLINE');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('dc unicast: GATEWAY_SEND_FAILED clears mapping then broadcasts', async () => {
	const { bridge, gwWs, prevHome } = await setupBridgeWithGateway('c_sfail');
	try {
		const broadcasted = [];
		bridge.webrtcPeer.broadcast = (payload) => broadcasted.push(payload);
		bridge.webrtcPeer.sendTo = () => true;
		gwWs.send = () => { throw new Error('send failed'); };

		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-sfail-1', method: 'sessions.list', params: {} },
			'c_sfail'
		);
		const failBC = broadcasted.find((p) => p.error?.code === 'GATEWAY_SEND_FAILED');
		assert.ok(failBC, 'SEND_FAILED should be broadcast');
		assert.equal(bridge.__dcPendingRequests.has('ui-sfail-1'), false, 'mapping cleared on send failure');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('dc unicast: gateway ws close clears entire pending table', async () => {
	const { bridge, gwWs, prevHome } = await setupBridgeWithGateway('c_close1');
	try {
		bridge.webrtcPeer.sendTo = () => true;
		bridge.webrtcPeer.broadcast = () => {};

		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-c-1', method: 'sessions.list', params: {} },
			'c_close1'
		);
		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-c-2', method: 'sessions.list', params: {} },
			'c_close1'
		);
		assert.equal(bridge.__dcPendingRequests.size, 2);

		gwWs.emit('close', { code: 1006, reason: 'remote dropped' });
		assert.equal(bridge.__dcPendingRequests.size, 0, 'all entries cleared on ws close');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('dc unicast: sendTo failure logs debug, no broadcast fallback', async () => {
	const { bridge, gwWs, prevHome } = await setupBridgeWithGateway('c_und');
	try {
		const debugs = [];
		bridge.logger = { ...bridge.logger, debug: (m) => debugs.push(String(m)) };
		const broadcasted = [];
		bridge.webrtcPeer.sendTo = () => false;
		bridge.webrtcPeer.broadcast = (p) => broadcasted.push(p);

		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-und-1', method: 'sessions.list', params: {} },
			'c_und'
		);
		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-und-1', ok: true, payload: { status: 'ok' } }),
		});
		// 阶段 1 后 ws.message listener 是 async（await sendTo），需要 flush 微任务
		for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
		assert.ok(debugs.some((m) => m.includes('dc res undeliverable') && m.includes('ui-und-1')));
		assert.equal(broadcasted.length, 0, 'must not fall back to broadcast');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('dc unicast: unmatched res falls back to broadcast', async () => {
	const { bridge, gwWs, prevHome } = await setupBridgeWithGateway('c_unmatch');
	try {
		const sentTo = [];
		const broadcasted = [];
		bridge.webrtcPeer.sendTo = (connId, payload) => { sentTo.push(payload); return true; };
		bridge.webrtcPeer.broadcast = (p) => broadcasted.push(p);

		// 直接发 res，未事先建立 mapping
		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-orphan-1', ok: true, payload: { status: 'ok' } }),
		});
		assert.equal(sentTo.length, 0);
		assert.equal(broadcasted.length, 1, 'unmatched res falls back to broadcast');
		assert.equal(broadcasted[0].id, 'ui-orphan-1');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('dc unicast: TTL scan clears expired entries and warns', async () => {
	const dir = await writeCfg({ token: 'rtc-tok', serverUrl: 'https://server.local' });
	const prevHome = saveHomedir();
	setHomedir(nodePath.join(dir, 'home'));
	await fs.mkdir(process.env.HOME, { recursive: true });

	const warns = [];
	const logger = {
		info() {}, debug() {},
		warn: (m) => warns.push(String(m)),
	};
	const bridge = new RealtimeBridge({
		WebSocket: FakeWebSocket,
		resolveGatewayAuthToken: () => '',
		preloadPion: noopPreloadPion,
		preloadNdc: noopPreloadNdc,
		gatewayReadyTimeoutMs: 50,
		dcReqTtlMs: 30,   // 30ms TTL
		dcReqScanMs: 20,  // 20ms 扫描
	});
	FakeWebSocket.instances.length = 0;
	try {
		await bridge.start({ logger, pluginConfig: {} });
		// 注入一条已过期条目（写入时已早于 now）
		bridge.__dcPendingRequests.set('ui-exp-1', { connId: 'c_exp', expireAt: Date.now() - 1000 });
		// 注入一条未过期条目
		bridge.__dcPendingRequests.set('ui-fresh-1', { connId: 'c_exp', expireAt: Date.now() + 60_000 });

		// 等待至少一次扫描
		await new Promise((r) => setTimeout(r, 80));

		assert.equal(bridge.__dcPendingRequests.has('ui-exp-1'), false, 'expired entry cleared');
		assert.equal(bridge.__dcPendingRequests.has('ui-fresh-1'), true, 'fresh entry kept');
		assert.ok(warns.some((m) => m.includes('dc pending entries expired') && m.includes('count=1')),
			'should warn on cleanup');
	} finally {
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

// --- 顶层 try/catch：sendTo 抛错不能让 listener 变 unhandledRejection 击穿 gateway ---

test('gateway ws message handler: broadcast 抛错时 listener 不产生 unhandledRejection', async () => {
	const { bridge, gwWs, prevHome } = await setupBridgeWithGateway('c_bcast_throw');
	const origListeners = process.listeners('unhandledRejection');
	process.removeAllListeners('unhandledRejection');
	const unhandled = [];
	const captureUnhandled = (reason) => unhandled.push(reason);
	process.on('unhandledRejection', captureUnhandled);
	try {
		// broadcast 抛错（unmatched res 路径走 (d) 兜底广播）
		bridge.webrtcPeer.broadcast = () => { throw new Error('boom from broadcast'); };
		bridge.webrtcPeer.sendTo = async () => true;

		// 不预先注册 mapping → 走 unmatched res → broadcast 兜底
		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-bcast-1', ok: true, payload: { status: 'ok' } }),
		});

		for (let i = 0; i < 15; i += 1) await new Promise((r) => setTimeout(r, 0));

		const leaked = unhandled.filter((e) => /boom from broadcast/.test(String(e?.message ?? e)));
		assert.equal(leaked.length, 0, `unhandledRejection leaked: ${leaked.map((e) => e?.message).join(', ')}`);
	} finally {
		process.removeListener('unhandledRejection', captureUnhandled);
		for (const l of origListeners) process.on('unhandledRejection', l);
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});

test('gateway ws message handler: sendTo 抛错时 listener 不产生 unhandledRejection', async () => {
	const { bridge, gwWs, prevHome } = await setupBridgeWithGateway('c_throw');
	const origListeners = process.listeners('unhandledRejection');
	process.removeAllListeners('unhandledRejection');
	const unhandled = [];
	const captureUnhandled = (reason) => unhandled.push(reason);
	process.on('unhandledRejection', captureUnhandled);
	try {
		// sendTo 抛错（async reject）—— 模拟 webrtcPeer 内部异常路径
		bridge.webrtcPeer.sendTo = async () => { throw new Error('boom from sendTo'); };
		bridge.webrtcPeer.broadcast = () => {};

		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-throw-1', method: 'sessions.list', params: {} },
			'c_throw',
		);
		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-throw-1', ok: true, payload: { status: 'ok' } }),
		});

		// 等待 microtasks + unhandledRejection event 派发
		for (let i = 0; i < 15; i += 1) await new Promise((r) => setTimeout(r, 0));

		// 关键：listener 顶层 try/catch 必须把 sendTo 的 reject 吃掉
		const leaked = unhandled.filter((e) => /boom from sendTo/.test(String(e?.message ?? e)));
		assert.equal(leaked.length, 0, `unhandledRejection leaked: ${leaked.map((e) => e?.message).join(', ')}`);
	} finally {
		process.removeListener('unhandledRejection', captureUnhandled);
		for (const l of origListeners) process.on('unhandledRejection', l);
		await bridge.stop();
		restoreHomedir(prevHome);
	}
});
