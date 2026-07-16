import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import { after, afterEach, test } from 'node:test';

import { WebSocket as WsWebSocket } from 'ws';
import { GATEWAY_RETRY_DELAYS_MS, RealtimeBridge, __getSingletonForTest, classifyAgentLagStop, defaultResolveGatewayAuthToken, ensureAgentSession, gatewayAgentRpc, isFinalResMsg, restartRealtimeBridge, stopRealtimeBridge, waitForSessionsReady } from './realtime-bridge.js';
import { readConfig, writeConfig } from './config.js';
import { getRuntime, setRuntime } from './runtime.js';
import { remoteLog, __reset as resetRemoteLog, __buffer as remoteLogBuffer } from './remote-log.js';

// 钉住事件循环：本文件多处用例（如 __gatewayAgentRpc 的 timeout / accept_timeout 路径）
// await 的结果只能靠产品侧 .unref() 的超时定时器兜底 resolve（unref 是生产正确行为，
// 让网关能干净退出）。测试把网关的 WebSocket / 心跳等常驻 ref 句柄都 mock 掉了，事件循环
// 缺少 production 里的环境 ref 句柄；当某用例只剩 unref 定时器挂起时，Node 22 的 node:test
// 会在 beforeExit 把它判为 "Promise resolution is still pending but the event loop has
// already resolved" 并级联 cancel(cancelledByParent) 其后全部用例——被取消的用例覆盖率归零，
// 拖垮 100% 行门禁。（Node 22 必现、Node 24 已改此行为不复现；CI 跑 Node 22、本地 mac 多为
// Node 24，故本地不复现。）用一个 ref 的空转 interval 还原这份环境存活性，让 unref 定时器
// 确定性触发、用例确定性地跑；after() 里 clear 让进程正常退出。
const keepEventLoopAlive = setInterval(() => {}, 60_000);

// singleton 测试可能触发真实 preload（pion Go 进程），文件结束时兜底停掉 singleton
after(async () => {
	clearInterval(keepEventLoopAlive);
	try { await stopRealtimeBridge({ forceCleanup: true }); } catch { /* best-effort */ }
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

// 本文件内 setupDir 改动的 env / runtime 全部进队列，afterEach 统一恢复，
// 避免跨用例污染。__pendingCleanups 是同步入栈、异步出栈的简单 LIFO 即可——
// node:test 在单文件内顺序执行测试，无并发。
const __pendingCleanups = [];

afterEach(() => {
	while (__pendingCleanups.length) {
		const fn = __pendingCleanups.pop();
		try { fn(); } catch { /* best-effort restore */ }
	}
});

async function setupDir(prefix) {
	const prevCfgPath = process.env.OPENCLAW_CONFIG_PATH;
	const prevTunnelPath = process.env.COCLAW_TUNNEL_CONFIG_PATH;
	const prevRuntime = getRuntime();
	// 先入队 cleanup，再做实际修改——这样即便中途（mkdtemp / writeFile / setRuntime
	// 任一步）抛错，已经发生的局部修改也会被 afterEach 兜底恢复。
	__pendingCleanups.push(() => {
		if (prevCfgPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
		else process.env.OPENCLAW_CONFIG_PATH = prevCfgPath;
		if (prevTunnelPath === undefined) delete process.env.COCLAW_TUNNEL_CONFIG_PATH;
		else process.env.COCLAW_TUNNEL_CONFIG_PATH = prevTunnelPath;
		setRuntime(prevRuntime);
	});
	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
	process.env.OPENCLAW_CONFIG_PATH = nodePath.join(dir, 'openclaw.json');
	await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, '{}', 'utf8');
	delete process.env.COCLAW_TUNNEL_CONFIG_PATH;
	setRuntime({ state: { resolveStateDir: () => dir } });
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

/** 默认 preloadPion mock：返回功能完整的 mock PeerConnection（WebRTC 可用但无 cleanup） */
async function mockPreloadPion() {
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
	return { PeerConnection: MockPC, cleanup: null, impl: 'pion' };
}

function createBridge(overrides = {}) {
	return new RealtimeBridge({
		WebSocket: FakeWebSocket,
		resolveGatewayAuthToken: () => '',
		preloadPion: mockPreloadPion,
		gatewayReadyTimeoutMs: 50,
		...overrides,
	});
}

/**
 * 轮询等待条件成立。用于替代固定 setTimeout sleep——只等到下一步 assert
 * 真正所需的状态出现，避免无谓的等待时间。
 * @param {() => (boolean|Promise<boolean>)} pred - 条件函数；返回真即结束等待
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=1000] - 总超时；超时抛错让用例快速失败
 * @param {number} [opts.intervalMs=1] - 轮询间隔
 * @param {string} [opts.label] - 超时报错信息中的标签，便于排查
 */
async function waitFor(pred, opts = {}) {
	const timeoutMs = opts.timeoutMs ?? 1000;
	const intervalMs = opts.intervalMs ?? 1;
	const start = Date.now();
	for (;;) {
		if (await pred()) return;
		if (Date.now() - start > timeoutMs) {
			throw new Error(`waitFor timeout after ${timeoutMs}ms${opts.label ? ` (${opts.label})` : ''}`);
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
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

test('singleton API should no-op for missing binding token and restart/stop should be safe', async () => {
	await writeCfg({ token: '' });
	const logger = noopLogger();
	const __deps = { resolveGatewayAuthToken: () => 'tkn' };
	try {
		await restartRealtimeBridge({ logger, pluginConfig: { serverUrl: 'http://127.0.0.1:1' }, __deps });
		await restartRealtimeBridge({ logger, pluginConfig: { serverUrl: 'http://127.0.0.1:1' }, __deps });
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
		const opts = {
			logger,
			pluginConfig: { serverUrl: 'http://127.0.0.1:1' },
			__deps: { resolveGatewayAuthToken: () => 'tkn' },
		};
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
		const opts = {
			logger,
			pluginConfig: { serverUrl: 'http://127.0.0.1:1' },
			__deps: { resolveGatewayAuthToken: () => 'tkn' },
		};
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
		const opts = { logger, pluginConfig: {}, __deps: { resolveGatewayAuthToken: () => 'tkn' } };
		await restartRealtimeBridge(opts);
		// 旧 singleton 在第二次 restart 时必须被 stop（否则 WS / timers 泄漏）。
		// 引用钉死前一个实例，spy stop 计数，再触发 restart。
		const firstBridge = __getSingletonForTest();
		assert.ok(firstBridge, 'first restart 应建立 singleton');
		let stopCount = 0;
		const originalStop = firstBridge.stop.bind(firstBridge);
		firstBridge.stop = async (...args) => {
			stopCount += 1;
			return originalStop(...args);
		};
		// 再次 restart 应正常替换 + 旧实例被 stop
		await restartRealtimeBridge(opts);
		const secondBridge = __getSingletonForTest();
		assert.notEqual(secondBridge, firstBridge, '第二次 restart 应换实例');
		assert.equal(stopCount, 1, '旧 singleton 应被 stop 一次（restartRealtimeBridge 必须 await singleton.stop()）');
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
		await restartRealtimeBridge({
			logger,
			pluginConfig: {},
			__deps: { resolveGatewayAuthToken: () => 'tkn' },
		});
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
	FakeWebSocket.instances.length = 0;
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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

		// refresh 会先关闭旧连接再创建新 server ws + 新 gateway ws；
		// 新设计下 start() 主动启动内线，instances 末尾是 gateway，倒数第二个是 server。
		await bridge.refresh();
		assert.equal(initialServer.readyState, 3, 'initial server should be closed after refresh');
		const server = FakeWebSocket.instances[FakeWebSocket.instances.length - 2];
		assert.equal(server.url.startsWith('wss://server.local/api/v1/claws/stream'), true);
		assert.equal(server.url.includes('token=t2'), true, 'new connection should use updated token');
		assert.equal(server !== initialServer, true, 'should be a different WebSocket instance');
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
		// 不能用 server.sent.length 判断：同一条 WS 也在 drain remote-log 批次，会让总数偶发 ±1
		gateway.readyState = 0;
		server.emit('message', { data: JSON.stringify({ type: 'rpc.req', id: '3', method: 'm3' }) });
		await new Promise((r) => setTimeout(r, 100));
		const hasFrameForId3 = server.sent.some((s) => {
			try {
				const m = JSON.parse(String(s));
				return m && m.id === '3';
			} catch { return false; }
		});
		assert.equal(hasFrameForId3, false, 'unrecognized message should be ignored regardless of gateway state');

		// claw.unbound branch (no clawId in payload — clears config)
		server.emit('message', { data: JSON.stringify({ type: 'claw.unbound', reason: 'x' }) });
		await waitFor(async () => (await readConfig()).token === undefined, { label: 'token cleared on claw.unbound' });
		const afterUnbound = await readConfig();
		assert.equal(afterUnbound.token, undefined);

		// close with 4003 should clear token and log auth-close
		await writeConfig({ token: 't2' });
		server.emit('close', { code: 4003, reason: 'revoked' });
		await waitFor(async () => (await readConfig()).token === undefined, { label: 'token cleared on auth-close' });
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
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
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
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
	}
});

test('RealtimeBridge ensureAgentSession should create session when not found', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
	}
});

test('RealtimeBridge ensureAgentSession should NOT reset on resolve timeout', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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

		// 直接桩掉 __gatewayRpc，让 resolve 立即返回 timeout——避免等真 2s 定时器。
		// __gatewayRpc 自身 setTimeout → settle('timeout') 路径由独立用例覆盖
		// （'__gatewayRpc real setTimeout fires settle({ok:false, error:"timeout"}) when no res arrives'）；
		// 这里只关心 ensureAgentSession 上游的 reset 抑制。
		const sentBefore = gateway.sent.length;
		bridge.__gatewayRpc = async () => ({ ok: false, error: 'timeout' });
		const result = await bridge.ensureAgentSession('timeout-agent');
		assert.equal(result.ok, false);
		assert.equal(result.error, 'timeout');

		// 不应发送 sessions.reset（比对 stub 后新增的发送）
		const resetReqRaw = gateway.sent.slice(sentBefore).find((s) => String(s).includes('sessions.reset') && String(s).includes('timeout-agent'));
		assert.equal(resetReqRaw, undefined, 'should NOT send sessions.reset on timeout');
	}
	finally {
		await bridge.stop();
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
	}
});

test('__gatewayRpc real setTimeout fires settle({ok:false, error:"timeout"}) when no res arrives', async () => {
	// S1 补齐：覆盖 __gatewayRpc 内部 setTimeout(timeoutMs) 触发 settle('timeout') 的端到端路径。
	// 不 stub __gatewayRpc、不拦 setTimeout——直接走真实定时器（小 timeoutMs 控总耗时）。
	await writeCfg({});
	const bridge = createBridge();
	// 直接装一条已就绪的 gateway ws，跳过 __waitGatewayReady 的轮询/握手编排；
	// bridge.started 默认 false，__ensureGatewayConnection 会先在这里 early-return，
	// 不会尝试新建 ws，__waitGatewayReady 随后走同步快路径直接 return true。
	const gwWs = new FakeWebSocket('ws://gw.fake');
	gwWs.readyState = 1;
	bridge.gatewayWs = gwWs;
	bridge.gatewayReady = true;

	// __gatewayRpc 的 setTimeout 是 unref 的；本测试不走 start() / 没有真实 socket，
	// event loop 没有其它 keepalive 时 unref timer 不会阻止退出。挂一个 non-unref ticker
	// 撑到 settle('timeout') 真正发生。
	const keepalive = setInterval(() => {}, 25);
	try {
		const t0 = Date.now();
		const result = await bridge.__gatewayRpc('coclaw.noop', {}, { timeoutMs: 30 });
		const elapsed = Date.now() - t0;

		assert.deepEqual(result, { ok: false, error: 'timeout' });
		// 真 setTimeout 路径：至少等了一个 timer 周期，确认不是同步早退也不是 stub 提前返回
		assert.ok(elapsed >= 20, `expected real setTimeout delay (~30ms), got ${elapsed}ms`);
		// 请求帧已经发出（__gatewayRpc 走到了 ws.send 这一步）
		assert.equal(gwWs.sent.length, 1, 'should have sent exactly one req frame');
		const sentMsg = JSON.parse(String(gwWs.sent[0]));
		assert.equal(sentMsg.type, 'req');
		assert.equal(sentMsg.method, 'coclaw.noop');
		// settle 清理了 pending 表（避免内存泄漏 / 后续误投递）
		assert.equal(bridge.gatewayPendingRequests.has(sentMsg.id), false);
	} finally {
		clearInterval(keepalive);
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
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
	}
});

test('RealtimeBridge should handle gateway connect send failure and log warning', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
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

		// refresh 创建新连接（新 server + 新 gateway 各一个）
		await writeConfig({ token: 't2', serverUrl: 'http://server.local' });
		await bridge.refresh();
		// 新设计下 start() 主动建内线，instances 末尾是 gateway，倒数第二个是 server
		const newServer = FakeWebSocket.instances[FakeWebSocket.instances.length - 2];
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
		// 新设计下 start() 主动建内线，instances 末尾是 gateway，倒数第二个是 server
		const newServer = FakeWebSocket.instances[FakeWebSocket.instances.length - 2];
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
		// 新设计下 start() 主动建内线，instances 末尾是 gateway，倒数第二个是 server
		const newServer = FakeWebSocket.instances[FakeWebSocket.instances.length - 2];
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

test('RealtimeBridge: stale gateway ws close 不应清新 ws 的 lag probes / pending requests', async () => {
	// __clearAllLagProbes / gatewayPendingRequests / __dcPendingRequests 都是 per-bridge 共享状态。
	// 旧 ws 的 close 事件若跑在现有 stale guard (this.gatewayWs === ws) 块外，会清掉新 ws 的状态
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

		// 模拟 gateway ws 已被新实例替换，并预置一些"新 ws 的状态"
		const sentinel = { __dummy: true };
		bridge.gatewayWs = sentinel;
		bridge.gatewayPendingRequests.set('p1', () => {});
		bridge.__dcPendingRequests.set('d1', { connId: 'c1' });

		let lagClearCalls = 0;
		const origClearLag = bridge.__clearAllLagProbes.bind(bridge);
		bridge.__clearAllLagProbes = () => { lagClearCalls += 1; return origClearLag(); };

		// 旧 gw1 迟到的 close：guard 应阻止清理新 ws 的状态
		gw1.readyState = 3;
		gw1.emit('close', { code: 1006, reason: 'stale' });
		await new Promise((r) => setTimeout(r, 0));

		assert.equal(lagClearCalls, 0, 'stale close 不应触发 __clearAllLagProbes');
		assert.equal(bridge.gatewayPendingRequests.size, 1, '新 ws 的 pending request 不应被清');
		assert.equal(bridge.__dcPendingRequests.size, 1, '新 ws 的 DC RPC 路由不应被清');
		assert.equal(bridge.gatewayWs, sentinel, 'this.gatewayWs 不应被旧 ws close 清空');
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
		// 新设计下 start() 主动建内线，instances 末尾是 gateway，倒数第二个是 server
		const newServer = FakeWebSocket.instances[FakeWebSocket.instances.length - 2];
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
	const unicast = [];
	const sentToGateway = [];
	bridge.webrtcPeer = {
		broadcast: (p) => broadcasted.push(p),
		sendTo: (connId, p) => { unicast.push({ connId, payload: p }); return Promise.resolve(true); },
		destroy: () => {},
		closeAll: () => Promise.resolve(),
	};
	bridge.gatewayWs = { readyState: 1, send: (m) => sentToGateway.push(m), close: () => {} };
	bridge.gatewayReady = true;

	// 缺 id + 缺 method → drop + warn，不转发，不 broadcast 也不 sendTo
	await bridge.__handleGatewayRequestFromDc({}, 'connA');
	assert.equal(sentToGateway.length, 0);
	assert.equal(broadcasted.length, 0);
	assert.equal(unicast.length, 0);

	// 有合法 id 但 method 缺失 → 单播 INVALID_REQUEST 给发起方，不广播、不转发
	await bridge.__handleGatewayRequestFromDc({ id: 'req-1' }, 'connA');
	assert.equal(sentToGateway.length, 0);
	assert.equal(broadcasted.length, 0, 'INVALID_REQUEST 不应走 broadcast');
	const inv = unicast.find((u) => u.payload.error?.code === 'INVALID_REQUEST');
	assert.ok(inv, '应通过 sendTo 单播 INVALID_REQUEST');
	assert.equal(inv.connId, 'connA');
	assert.equal(inv.payload.id, 'req-1');

	// id 是数字（非 string）→ drop，不 broadcast 也不 sendTo
	const unicastBefore = unicast.length;
	await bridge.__handleGatewayRequestFromDc({ id: 123, method: 'm' }, 'connA');
	assert.equal(sentToGateway.length, 0);
	assert.equal(broadcasted.length, 0);
	assert.equal(unicast.length, unicastBefore);

	// 合法 id + method → 正常转发到 gateway
	await bridge.__handleGatewayRequestFromDc({ id: 'req-ok', method: 'agents.list' }, 'connA');
	assert.equal(sentToGateway.length, 1);
	const sent = JSON.parse(sentToGateway[0]);
	assert.equal(sent.id, 'req-ok');
	assert.equal(sent.method, 'agents.list');
});

test('__handleGatewayRequestFromDc: INVALID_REQUEST 只发给发起方 connId，不打扰其他连接', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'http://server.local' });
	const bridge = createBridge();
	const broadcasted = [];
	const unicast = [];
	bridge.webrtcPeer = {
		broadcast: (p) => broadcasted.push(p),
		sendTo: (connId, p) => { unicast.push({ connId, payload: p }); return Promise.resolve(true); },
		destroy: () => {},
		closeAll: () => Promise.resolve(),
	};
	bridge.gatewayWs = { readyState: 1, send: () => {}, close: () => {} };
	bridge.gatewayReady = true;

	// connA 发乱码请求 → 只 sendTo connA
	await bridge.__handleGatewayRequestFromDc({ id: 'r-A' }, 'connA');
	// connB 发乱码请求 → 只 sendTo connB
	await bridge.__handleGatewayRequestFromDc({ id: 'r-B' }, 'connB');

	assert.equal(broadcasted.length, 0, 'INVALID_REQUEST 不应广播给其他连接');
	assert.equal(unicast.length, 2);
	assert.equal(unicast[0].connId, 'connA');
	assert.equal(unicast[0].payload.error?.code, 'INVALID_REQUEST');
	assert.equal(unicast[0].payload.id, 'r-A');
	assert.equal(unicast[1].connId, 'connB');
	assert.equal(unicast[1].payload.error?.code, 'INVALID_REQUEST');
	assert.equal(unicast[1].payload.id, 'r-B');
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
		// 新设计下 start() 主动建内线，instances 末尾是 gateway，倒数第二个是 server
		const newServer = FakeWebSocket.instances[FakeWebSocket.instances.length - 2];

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
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
	}
});

test('RealtimeBridge ensureAgentSession should handle sessions.reset failure', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
	}
});

test('RealtimeBridge ensureAgentSession should default to main when agentId is empty', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
	}
});

test('RealtimeBridge __ensureAllAgentSessions should fallback to main when agents.list fails', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
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
		await restartRealtimeBridge({
			logger: noopLogger(),
			pluginConfig: {},
			__deps: { resolveGatewayAuthToken: () => 'tkn' },
		});
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
		await restartRealtimeBridge({ logger: noopLogger(), pluginConfig: {}, __deps: { WebSocket: FakeWebSocket, resolveGatewayAuthToken: () => 'tkn' } });
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

		// 第 1~2 次 miss：不应关闭 socket，应补发 ping 并调度下一轮
		for (let i = 1; i <= 2; i++) {
			const latestTimeout = timeouts[timeouts.length - 1];
			latestTimeout.__fn();
			assert.equal(server.readyState, 1, `miss ${i}: socket should still be open`);
			assert.ok(debugs.some((x) => x.includes(`heartbeat miss ${i}/3`)), `miss ${i}: should log miss`);
			// 应补发 ping
			assert.ok(server.sent.some((x) => String(x).includes('"type":"ping"')), `miss ${i}: should send compensatory ping`);
		}

		// 第 3 次 miss：应关闭 socket
		const lastTimeout = timeouts[timeouts.length - 1];
		lastTimeout.__fn();
		assert.ok(warns.some((x) => x.includes('heartbeat timeout') && x.includes('3 consecutive misses')), 'should log final timeout');
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

		// 触发前 2 次 miss（不关闭），然后第 3 次触发 close
		for (let i = 0; i < 2; i++) {
			const t = timeouts[timeouts.length - 1];
			t.__fn();
		}

		// 第 3 次 miss 时 close 抛异常不应 crash
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
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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

		// 声明协议范围 v3–v4：OpenClaw 网关自 v4 起拒绝不含 4 的范围（升级后 CoClaw 失联根因）
		assert.equal(connectReq.params.minProtocol, 3);
		assert.equal(connectReq.params.maxProtocol, 4);

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
	}
});

test('connect request should use empty nonce when challenge has no nonce', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
	}
});

test('connect should gracefully handle device identity load failure', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
	}
});

test('device identity should be cached across multiple connect attempts', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
	}
});

// --- gateway 握手重试 + legacy 回退测试 ---

const FAKE_DEVICE_IDENTITY = {
	deviceId: 'fake-device-id',
	publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAtzDL7h2Z4PZiOmNjmyl+U2gKexygXrWLjOWMufVSZKU=\n-----END PUBLIC KEY-----\n',
	privateKeyPem: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJYc25BaxT+DkFPCYoNeX0a5Vtv3VPJ+o9iEHcuh3+G6\n-----END PRIVATE KEY-----\n',
};

/**
 * 替换 global.setTimeout / clearTimeout，捕获 setTimeout 回调以便测试手动触发。
 * restore() 必须在测试 finally 中调用。fireFirstRetryTimer() 触发当前最早的未取消、未触发的
 * retry 定时器（只识别 GATEWAY_RETRY_DELAYS_MS 中的延时值），返回 true/false 表示是否有可触发。
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
			const t = timers.find((x) => !x.__cancelled && !x.__fired && GATEWAY_RETRY_DELAYS_MS.includes(x.__ms));
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
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
	}
});

test('legacy fallback success marks gateway ready and keeps legacy mode', async () => {
	FakeWebSocket.instances.length = 0;
	resetRemoteLog();
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
	}
});

test('v3 handshake non-signature failure does NOT trigger legacy and schedules retry', async () => {
	FakeWebSocket.instances.length = 0;
	resetRemoteLog();
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
		// 下一次尝试已调度（delay[0]=1s，前置档加快启动期重试）
		const retryTimer = t.timers.find((x) => !x.__cancelled && x.__ms === 1_000);
		assert.ok(retryTimer, 'a 1s retry timer should be scheduled');

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
	}
});

test('learned legacy mode sends legacy handshake on subsequent WS challenge', async () => {
	FakeWebSocket.instances.length = 0;
	resetRemoteLog();
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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

		// 触发第一个重试定时器（1s，前置档），进入第二条 WS
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
	}
});

test('gateway retry exhausts after all configured attempts and enters gave-up state', async () => {
	// 重试上限 = GATEWAY_RETRY_DELAYS_MS.length；首发失败 + N 次重试 = N+1 次尝试都失败 → gave-up。
	// 这里全程通过常量长度断言，预算调整时本测试不需要随之改动。
	const retryCount = GATEWAY_RETRY_DELAYS_MS.length;
	const totalAttempts = retryCount + 1;
	FakeWebSocket.instances.length = 0;
	resetRemoteLog();
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	process.chdir(dir);

	const t = captureTimers();
	const bridge = createBridge({ loadDeviceIdentity: () => FAKE_DEVICE_IDENTITY });
	try {
		// 首次尝试：fail with 'auth failed'
		const { gateway: gw0 } = await bootGatewayWithChallenge(bridge);
		const req0 = lastConnectReq(gw0);
		gw0.emit('message', { data: JSON.stringify({ type: 'res', id: req0.id, ok: false, error: { message: 'auth failed' } }) });
		assert.equal(bridge.__gatewayAttempts, 1);

		// 配置中的全部重试，每次都失败
		const instancesBefore = [gw0];
		for (let i = 0; i < retryCount; i++) {
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

		// 全部失败 → gave-up
		assert.equal(bridge.__gatewayAttempts, totalAttempts);
		assert.equal(bridge.__gatewayGaveUp, true);
		assert.equal(bridge.__gatewayRetryTimer, null, 'no further timer scheduled after gave-up');

		// 再次触发 __ensureGatewayConnection 应是 no-op（不创建新 WS）
		const instancesCount = FakeWebSocket.instances.length;
		bridge.__ensureGatewayConnection();
		assert.equal(FakeWebSocket.instances.length, instancesCount);

		// remoteLog 有一条 gave-up
		const server = FakeWebSocket.instances[0];
		const logs = collectRemoteLogTexts(server);
		const gaveUpRe = new RegExp(`gateway\\.handshake\\.gave-up attempts=${totalAttempts} lastReason=auth failed`);
		assert.ok(logs.some((m) => gaveUpRe.test(m)), `expected gave-up log with attempts=${totalAttempts}`);
		// 刷屏治理：所有尝试中 ws.connect-failed 应该恰好等于尝试次数
		assert.equal(logs.filter((m) => /ws\.connect-failed peer=gateway/.test(m)).length, totalAttempts);
	}
	finally {
		t.restore();
		await bridge.stop();
		process.chdir(prevCwd);
	}
});

test('gateway handshake startup-race recovery: first fails, 1s retry succeeds', async () => {
	// 前置档退避表（[1s, 1.5s, 1.5s, 1.5s, ...]）的真实部署目标场景：
	// gateway server 启动期 sidecars 还没就绪 → 首次握手收到
	// "gateway starting; retry shortly" → 1s 后第二次重试落进 server 已就绪窗口 → 成功。
	// 这是该退避表设计要解决的最常见场景，需端到端验证一遍。
	FakeWebSocket.instances.length = 0;
	resetRemoteLog();
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	process.chdir(dir);

	// 阶段一用 captureTimers 锁定 retry 调度并立即触发；阶段二恢复真定时器
	// 让握手成功路径里的 __ensureAllAgentSessions / drain 走原生异步 tick。
	const t = captureTimers();
	const bridge = createBridge({ loadDeviceIdentity: () => FAKE_DEVICE_IDENTITY });
	let gw2;
	try {
		// 首次握手：模拟 server 启动期回 UNAVAILABLE
		const { gateway: gw1 } = await bootGatewayWithChallenge(bridge);
		const req1 = lastConnectReq(gw1);
		gw1.emit('message', { data: JSON.stringify({
			type: 'res', id: req1.id, ok: false,
			error: { code: 'UNAVAILABLE', message: 'gateway starting; retry shortly', retryAfterMs: 500 },
		}) });
		assert.equal(bridge.gatewayReady, false);
		assert.equal(bridge.__gatewayAttempts, 1);
		assert.equal(bridge.__gatewayGaveUp, false);
		// 前置档：第一次重试 1s 后调度
		const retryTimer = t.timers.find((x) => !x.__cancelled && !x.__fired && x.__ms === 1_000);
		assert.ok(retryTimer, 'first retry scheduled at 1s (front-loaded)');

		// 触发重试：新 WS 实例同步创建
		assert.equal(t.fireFirstRetryTimer(), true, 'retry timer fires');
		gw2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		assert.notEqual(gw2, gw1, 'retry creates a new gateway WS');

		// 切回真定时器：后续握手成功 + drain 都走原生 setTimeout
		t.restore();
		gw2.readyState = 1;
		gw2.emit('open', {});
		gw2.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n2' } }) });
		const req2 = lastConnectReq(gw2);
		gw2.emit('message', { data: JSON.stringify({ type: 'res', id: req2.id, ok: true, payload: {} }) });
		await drainEnsureAllAgentSessions(gw2);

		// bridge 进入健康态，attempts 归零（"成功握手 → 重置失败计数"），无 gave-up
		assert.equal(bridge.gatewayReady, true, 'bridge healthy after retry succeeds');
		assert.equal(bridge.__gatewayAttempts, 0, 'attempts reset on successful handshake');
		assert.equal(bridge.__gatewayGaveUp, false);
		assert.equal(bridge.__gatewayRetryTimer, null, 'no further retry scheduled after success');

		// remoteLog 应有：第一次失败 + 第二次成功
		const server = FakeWebSocket.instances[0];
		const logs = collectRemoteLogTexts(server);
		assert.equal(
			logs.filter((m) => /ws\.connect-failed peer=gateway/.test(m)).length, 1,
			'exactly one connect-failed before recovery',
		);
		assert.ok(logs.some((m) => m === 'ws.connected peer=gateway'), 'connected log emitted on success');
	}
	finally {
		t.restore();
		await bridge.stop();
		process.chdir(prevCwd);
	}
});

test('__waitGatewayReady returns false when gateway has given up', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
	}
});

test('gateway disconnection after successful handshake reschedules with fresh retry budget', async () => {
	FakeWebSocket.instances.length = 0;
	resetRemoteLog();
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
			const retryTimer = t.timers.find((x) => !x.__cancelled && x.__ms === 1_000);
			assert.ok(retryTimer, 'should schedule retry with fresh 1s delay');
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
	}
});

test('__onGatewayAttemptFailed is a no-op when retry timer already scheduled', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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

test('外线 close 不再级联清 gateway retry timer / attempts（三线独立）', async () => {
	// 新契约：外/内/P2P 三条线各自独立。外线（plugin↔server）翻转不再清内线的累积失败状态，
	// 让新一轮外线会话不会"误重置"内线的退避节奏；内线状态只由 stop() 显式复位。
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	process.chdir(dir);

	const t = captureTimers();
	const bridge = createBridge({ loadDeviceIdentity: () => FAKE_DEVICE_IDENTITY });
	try {
		const { server, gateway } = await bootGatewayWithChallenge(bridge);
		const req = lastConnectReq(gateway);
		// 先让握手失败，调度出一个 retry timer + attempts++
		gateway.emit('message', { data: JSON.stringify({
			type: 'res', id: req.id, ok: false, error: { message: 'auth failed' },
		}) });
		const scheduled = t.timers.find((x) => !x.__cancelled && x.__ms === 1_000);
		assert.ok(scheduled, 'retry timer should exist');
		assert.equal(bridge.__gatewayAttempts, 1);

		// 模拟外线（server WS）非 auth-close 翻转：新设计下不应级联清内线状态。
		// 注：captureTimers 下 setTimeout 不真跑，故不能用 setTimeout 来 yield；close handler
		// 非 auth 分支整体同步（无 await），server.emit('close') 后状态已就绪，可直接断言。
		server.readyState = 3;
		server.emit('close', { code: 1006, reason: 'abnormal' });
		assert.equal(scheduled.__cancelled, false, '外线 close 不应取消内线 retry timer');
		assert.equal(bridge.__gatewayRetryTimer, scheduled, 'retry timer 实例应保持');
		assert.equal(bridge.__gatewayAttempts, 1, 'attempts 应跨外线翻转保留');

		// 显式 stop() 才会清这些（refresh 内部走相同复位）
		await bridge.stop();
		assert.equal(scheduled.__cancelled, true, 'stop() 才清 retry timer');
		assert.equal(bridge.__gatewayRetryTimer, null);
		assert.equal(bridge.__gatewayAttempts, 0);
		assert.equal(bridge.__gatewayGaveUp, false);
		assert.equal(bridge.__gatewayLegacyMode, false);
	}
	finally {
		t.restore();
		await bridge.stop();
		process.chdir(prevCwd);
	}
});

test('refresh resets gateway retry state so next start attempts v3 from scratch', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
	}
});

test('gateway ws error handler defensively closes the ws to unblock retry flow', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
	}
});

// --- __gatewayAgentRpc 两阶段响应测试 ---

test('__gatewayAgentRpc should wait for final response after accepted', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
	}
});

test('__gatewayAgentRpc should handle error on first response', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
	}
});

test('__gatewayAgentRpc should timeout if accepted never arrives', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
	}
});

test('__gatewayAgentRpc should timeout if final response never arrives after accepted', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
	}
});

test('__gatewayAgentRpc should resolve immediately for non-accepted ok response', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
	}
});

test('__gatewayAgentRpc duplicate settle after final should be no-op', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
		await restartRealtimeBridge({
			logger: noopLogger(),
			pluginConfig: {},
			__deps: { resolveGatewayAuthToken: () => 'tkn' },
		});
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
	await writeCfg({ token: 'rtc-tok', serverUrl: 'https://server.local' });

	const logs = [];
	const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: (m) => logs.push(m) };
	const bridge = createBridge();
	await bridge.start({ logger, pluginConfig: {} });

	const server = FakeWebSocket.instances[0];
	server.readyState = 1;
	server.emit('open', {});

	return { bridge, server, logs };
}

test('RealtimeBridge should lazily create WebRtcPeer on first rtc: message', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		assert.equal(bridge.webrtcPeer, null);

		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_test1',
				payload: { sdp: 'mock-offer-sdp' },
			}),
		});
		await waitFor(() => bridge.webrtcPeer !== null, { label: 'webrtcPeer created' });

		assert.notEqual(bridge.webrtcPeer, null, 'webrtcPeer should be created');
	} finally {
		await bridge.stop();
	}
});

test('RealtimeBridge should forward rtc:answer via __forwardToServer', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_ans',
				payload: { sdp: 'offer-sdp' },
			}),
		});
		await waitFor(() => server.sent.some((s) => String(s).includes('rtc:answer')), { label: 'rtc:answer forwarded' });

		// WebRtcPeer 的 onSend 会调用 __forwardToServer → server.send
		const answerMsg = server.sent.find((s) => String(s).includes('rtc:answer'));
		assert.ok(answerMsg, 'should have sent rtc:answer back via server ws');
		const parsed = JSON.parse(String(answerMsg));
		assert.equal(parsed.type, 'rtc:answer');
		assert.equal(parsed.toConnId, 'c_ans');
	} finally {
		await bridge.stop();
	}
});

test('RealtimeBridge should not create new WebRtcPeer on subsequent rtc: messages', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_dup1',
				payload: { sdp: 'sdp1' },
			}),
		});
		await waitFor(() => server.sent.some((s) => String(s).includes('"toConnId":"c_dup1"')), { label: 'first answer sent' });
		const firstPeer = bridge.webrtcPeer;

		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_dup2',
				payload: { sdp: 'sdp2' },
			}),
		});
		await waitFor(() => server.sent.some((s) => String(s).includes('"toConnId":"c_dup2"')), { label: 'second answer sent' });

		assert.equal(bridge.webrtcPeer, firstPeer, 'should reuse same WebRtcPeer instance');
	} finally {
		await bridge.stop();
	}
});

test('RealtimeBridge should dispatch rtc:ice to WebRtcPeer', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		// 先建立 session
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_ice1',
				payload: { sdp: 'sdp' },
			}),
		});
		await waitFor(() => server.sent.some((s) => String(s).includes('"toConnId":"c_ice1"')), { label: 'answer for c_ice1' });

		// 发 ICE
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:ice',
				fromConnId: 'c_ice1',
				payload: { candidate: 'cand1', sdpMid: '0', sdpMLineIndex: 0 },
			}),
		});
		// ICE 不抛即通过；让 handleSignaling 的微任务跑完
		for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));

		assert.ok(bridge.webrtcPeer);
	} finally {
		await bridge.stop();
	}
});

test('RealtimeBridge should dispatch rtc:ready and rtc:closed to WebRtcPeer', async () => {
	const { bridge, server, logs } = await setupConnectedBridge();
	try {
		// 先建立 session
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_lc1',
				payload: { sdp: 'sdp' },
			}),
		});
		await waitFor(() => server.sent.some((s) => String(s).includes('"toConnId":"c_lc1"')), { label: 'answer for c_lc1' });

		server.emit('message', {
			data: JSON.stringify({ type: 'rtc:ready', fromConnId: 'c_lc1' }),
		});
		await waitFor(() => logs.some((l) => String(l).includes('rtc:ready')), { label: 'rtc:ready logged' });

		server.emit('message', {
			data: JSON.stringify({ type: 'rtc:closed', fromConnId: 'c_lc1' }),
		});
		// rtc:closed 走 closeByConnId → 等 session 从 __sessions 移除
		await waitFor(() => !bridge.webrtcPeer?.__sessions?.has?.('c_lc1'), { label: 'session removed on closed' });

		assert.ok(logs.some((l) => String(l).includes('rtc:ready')));
	} finally {
		await bridge.stop();
	}
});

test('RealtimeBridge should handle rtc: signaling error gracefully with type+conn fields in log and remoteLog', async () => {
	resetRemoteLog();
	const { bridge, server, logs } = await setupConnectedBridge();
	try {
		// 发送一个会导致错误的 rtc:offer（无 payload.sdp）
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_err',
				payload: {},
			}),
		});
		await waitFor(() => logs.some((l) => String(l).includes('signaling error')), { label: 'signaling error logged' });

		// 钉死 signaling-error 日志携带 type / conn 细分字段（替代旧的"通用 signaling error"行）：
		// 让 server 端运维不必靠 err.message 字符串猜路径，直接看 type=、conn=
		// 当前实际来源是 webrtc-peer drain 的 per-item catch（同格式）；bridge 外层 catch
		// 现在只兜 __initWebrtcPeer() 失败，handleSignaling 自身不再抛
		// 正则用 \b 边界，避免 `type=rtc:offer-x` / `conn=c_err_x` 等子串误满足
		assert.ok(logs.some((l) => /signaling error/.test(String(l)) && /\btype=rtc:offer\b/.test(String(l)) && /\bconn=c_err\b/.test(String(l))),
			`expected signaling error log with type + conn fields, got: ${JSON.stringify(logs)}`);

		const remoteTexts = collectRemoteLogTexts(server);
		assert.ok(remoteTexts.some((t) => /^rtc\.signaling-error /.test(t) && /\btype=rtc:offer\b/.test(t) && /\bconn=c_err\b/.test(t)),
			`expected remoteLog rtc.signaling-error with type + conn fields, got: ${JSON.stringify(remoteTexts)}`);
	} finally {
		await bridge.stop();
	}
});

test('RealtimeBridge should keep webrtcPeer on serverWs non-auth close (4000 heartbeat timeout)', async () => {
	const { bridge, server, logs } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_keep',
				payload: { sdp: 'sdp' },
			}),
		});
		await waitFor(() => bridge.webrtcPeer !== null, { label: 'webrtcPeer created' });
		const peerBeforeClose = bridge.webrtcPeer;
		const fileHandlerBeforeClose = bridge.__fileHandler;
		// 替换 __scheduleReconnect 为 spy，避免真起 10s timer + 验证调度发生
		let reconnectCalls = 0;
		bridge.__scheduleReconnect = () => { reconnectCalls += 1; };

		// 非 auth-close（如心跳超时 4000、abnormal 1006）应保留 webrtcPeer / fileHandler
		server.emit('close', { code: 4000, reason: 'heartbeat_timeout' });
		// 让 close handler 跑完
		for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

		assert.equal(bridge.webrtcPeer, peerBeforeClose, 'webrtcPeer should be retained across non-auth ws close');
		assert.equal(bridge.__fileHandler, fileHandlerBeforeClose, 'fileHandler should be retained across non-auth ws close');
		assert.equal(reconnectCalls, 1, 'should schedule reconnect on non-auth close');
		assert.ok(logs.some((x) => String(x).includes('keep-pc')), 'should log keep-pc on non-auth disconnect');
	} finally {
		await bridge.stop();
	}
});

test('RealtimeBridge should keep webrtcPeer on serverWs abnormal close (1006)', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_keep_abnormal',
				payload: { sdp: 'sdp' },
			}),
		});
		await waitFor(() => bridge.webrtcPeer !== null, { label: 'webrtcPeer created' });
		const peerBeforeClose = bridge.webrtcPeer;
		const fileHandlerBeforeClose = bridge.__fileHandler;
		let reconnectCalls = 0;
		bridge.__scheduleReconnect = () => { reconnectCalls += 1; };

		server.emit('close', { code: 1006, reason: 'abnormal' });
		for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

		assert.equal(bridge.webrtcPeer, peerBeforeClose, 'webrtcPeer should be retained across abnormal close');
		assert.equal(bridge.__fileHandler, fileHandlerBeforeClose, 'fileHandler should be retained across abnormal close');
		assert.equal(reconnectCalls, 1, 'should schedule reconnect on abnormal close');
	} finally {
		await bridge.stop();
	}
});

test('RealtimeBridge should keep webrtcPeer on serverWs internal-error close (1011)', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_keep_1011',
				payload: { sdp: 'sdp' },
			}),
		});
		await waitFor(() => bridge.webrtcPeer !== null, { label: 'webrtcPeer created' });
		const peerBeforeClose = bridge.webrtcPeer;
		const fileHandlerBeforeClose = bridge.__fileHandler;
		let reconnectCalls = 0;
		bridge.__scheduleReconnect = () => { reconnectCalls += 1; };

		server.emit('close', { code: 1011, reason: 'server_internal_error' });
		for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

		assert.equal(bridge.webrtcPeer, peerBeforeClose, 'webrtcPeer should be retained across 1011 close');
		assert.equal(bridge.__fileHandler, fileHandlerBeforeClose, 'fileHandler should be retained across 1011 close');
		assert.equal(reconnectCalls, 1, 'should schedule reconnect on 1011 close');
	} finally {
		await bridge.stop();
	}
});

test('auth-close 也不级联关 gateway WS（仅卸 PC + fileHandler + token）', async () => {
	// 不变量补充：auth-close (4001/4003) 是唯一允许级联到 P2P 的路径，但仅卸 PC/fileHandler/token；
	// gateway WS（内线）作为本机连接不受外线鉴权状态影响，应保持原引用。
	const { bridge, server, gwWs } = await setupBridgeWithGateway('c_auth_keep_gw');
	try {
		const gwBefore = bridge.gatewayWs;
		const peerBefore = bridge.webrtcPeer;
		assert.ok(peerBefore, 'precondition: webrtcPeer must exist before auth-close');

		server.emit('close', { code: 4001, reason: 'unauthorized' });
		await waitFor(() => bridge.webrtcPeer === null, { label: 'webrtcPeer cleaned on auth-close' });

		assert.equal(bridge.gatewayWs, gwBefore, 'auth-close 不应关 gateway WS（内线独立）');
		assert.equal(gwBefore, gwWs, 'gateway WS 引用未变');
		// fileHandler 在 auth-close 内被清；webrtcPeer 也已清（上面 waitFor 验证过）
		assert.equal(bridge.__fileHandler, null, 'auth-close 仍应清 fileHandler');
	} finally {
		await bridge.stop();
	}
});

test('外死内活：server WS 非 auth-close 后 gateway WS 实例与就绪态保持，DC RPC 仍可达 gateway（核心收益）', async () => {
	// 本次重构核心场景：外线（server WS）瞬态翻转不应级联关掉内线，
	// DC RPC 通过 P2P → plugin → gateway 路径在外线断开窗口期仍能服务。
	const { bridge, server, gwWs } = await setupBridgeWithGateway('c_outer_dead');
	try {
		bridge.webrtcPeer.sendTo = () => true;
		bridge.webrtcPeer.broadcast = () => {};

		const gwBefore = bridge.gatewayWs;
		const peerBefore = bridge.webrtcPeer;
		const fhBefore = bridge.__fileHandler;

		// 模拟外线非 auth-close（4000/1006/1011 任一）
		server.emit('close', { code: 1006, reason: 'abnormal' });
		for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));

		assert.equal(bridge.gatewayWs, gwBefore, '外线 close 不应替换 gateway WS 实例');
		assert.equal(bridge.gatewayReady, true, 'gatewayReady 应跨外线翻转保持');
		assert.equal(bridge.webrtcPeer, peerBefore, 'webrtcPeer 应跨外线翻转保持');
		assert.equal(bridge.__fileHandler, fhBefore, 'fileHandler 应跨外线翻转保持');

		// 在外线断开窗口期发起一条 DC RPC，应仍能写路由表 + 抵达 gateway
		const sentBefore = gwWs.sent.length;
		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-after-outer-down', method: 'sessions.list', params: {} },
			'c_outer_dead'
		);
		assert.ok(bridge.__dcPendingRequests.has('ui-after-outer-down'),
			'DC RPC 路由表应在外线断时仍能写入');
		assert.ok(gwWs.sent.length > sentBefore, '请求应已抵达 gateway WS');
		const lastSent = JSON.parse(String(gwWs.sent[gwWs.sent.length - 1]));
		assert.equal(lastSent.id, 'ui-after-outer-down');
		assert.equal(lastSent.method, 'sessions.list');
	} finally {
		await bridge.stop();
	}
});

test('RealtimeBridge retained webrtcPeer should still process new rtc:offer signaling after non-auth close', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_first',
				payload: { sdp: 'sdp-first' },
			}),
		});
		await waitFor(() => bridge.webrtcPeer !== null && bridge.webrtcPeer.__sessions?.has?.('c_first'), { label: 'first session created' });
		const peerBeforeClose = bridge.webrtcPeer;
		bridge.__scheduleReconnect = () => {};

		// 非 auth-close → keep-PC
		server.emit('close', { code: 4000, reason: 'heartbeat_timeout' });
		for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
		assert.equal(bridge.webrtcPeer, peerBeforeClose, 'peer must be retained');

		// 直接驱动保留下来的 peer 处理一个新 offer，验证它不是僵尸：
		// signaling 内部不依赖 serverWs 实例（forwardToServer 在调用瞬间读 this.serverWs），
		// 只要 peer 仍可处理 handleSignaling、新 session 能被装配，重连后的复用就有保障。
		await bridge.webrtcPeer.handleSignaling({
			type: 'rtc:offer',
			fromConnId: 'c_second',
			payload: { sdp: 'sdp-second' },
		});
		assert.ok(bridge.webrtcPeer.__sessions?.has?.('c_second'), 'retained peer should accept new session post-close');
		assert.ok(bridge.webrtcPeer.__sessions?.has?.('c_first'), 'first session must still exist');
	} finally {
		await bridge.stop();
	}
});

test('RealtimeBridge should cleanup webrtcPeer on serverWs auth-close (4001) and clear local token', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_authclose',
				payload: { sdp: 'sdp' },
			}),
		});
		await waitFor(() => bridge.webrtcPeer !== null, { label: 'webrtcPeer created' });
		const peerBeforeClose = bridge.webrtcPeer;
		let closeAllCalls = 0;
		const origCloseAll = peerBeforeClose.closeAll.bind(peerBeforeClose);
		peerBeforeClose.closeAll = async () => { closeAllCalls += 1; return origCloseAll(); };

		server.emit('close', { code: 4001, reason: 'unauthorized' });
		await waitFor(() => bridge.webrtcPeer === null, { label: 'webrtcPeer cleaned on auth-close' });
		// auth-close 内 webrtcPeer 置 null 与 __clearTokenLocal 之间存在一段 await 链，
		// 显式等 token 清完再读，避免微任务时序差异（旧设计下被 __closeGatewayWs 的 await 链顺带同步过）。
		await waitFor(async () => (await readConfig()).token === undefined, { label: 'token cleared on auth-close' });

		assert.equal(closeAllCalls, 1, 'auth-close should invoke closeAll on retained peer');
		assert.equal(bridge.webrtcPeer, null, 'auth-close should still cleanup webrtcPeer');
		assert.equal(bridge.__fileHandler, null, 'auth-close should still cleanup fileHandler');
		const cfgAfter = await readConfig();
		assert.equal(cfgAfter.token, undefined, 'auth-close should clear local token');
	} finally {
		await bridge.stop();
	}
});

test('RealtimeBridge should cleanup webrtcPeer on serverWs auth-close (4003 forbidden) and clear local token', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_authclose_4003',
				payload: { sdp: 'sdp' },
			}),
		});
		await waitFor(() => bridge.webrtcPeer !== null, { label: 'webrtcPeer created' });
		const peerBeforeClose = bridge.webrtcPeer;
		let closeAllCalls = 0;
		const origCloseAll = peerBeforeClose.closeAll.bind(peerBeforeClose);
		peerBeforeClose.closeAll = async () => { closeAllCalls += 1; return origCloseAll(); };

		server.emit('close', { code: 4003, reason: 'forbidden' });
		await waitFor(() => bridge.webrtcPeer === null, { label: 'webrtcPeer cleaned on 4003 close' });
		// 4003 同 4001：webrtcPeer 置 null 与 token 清理之间有 await 链
		await waitFor(async () => (await readConfig()).token === undefined, { label: 'token cleared on 4003 close' });

		assert.equal(closeAllCalls, 1, '4003 should invoke closeAll on retained peer');
		assert.equal(bridge.webrtcPeer, null);
		assert.equal(bridge.__fileHandler, null);
		const cfgAfter = await readConfig();
		assert.equal(cfgAfter.token, undefined, '4003 should clear local token');
	} finally {
		await bridge.stop();
	}
});

// --- 懒加载竞态：销毁式 auth-close 撞 __initWebrtcPeer 在飞 ---
// __initWebrtcPeer 被 c8-ignore，这里用 spy 替换 + Deferred 闸门确定性复现窗口。

test('auth-close 撞 lazy init 在飞：先等 init 落地再清理（核心回归锁）', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		let closeAllCalls = 0;
		let cancelCleanupCalls = 0;
		const fakePeer = {
			handleSignaling: async () => {},
			closeAll: async () => { closeAllCalls += 1; },
		};
		const fakeHandler = { cancelCleanup: () => { cancelCleanupCalls += 1; } };
		let gateResolve;
		const gate = new Promise((res) => { gateResolve = res; });
		// 替换 lazy init 为闸门控制的赋值（赋值落地前一直 pending，peer 保持 null）
		bridge.__initWebrtcPeer = async () => {
			await gate;
			bridge.__fileHandler = fakeHandler;
			bridge.webrtcPeer = fakePeer;
		};
		const messageListener = server.listeners.get('message')[0];
		const closeListener = server.listeners.get('close')[0];

		// 投 rtc:offer 让 init 进 pending
		const msgP = messageListener({
			data: JSON.stringify({ type: 'rtc:offer', fromConnId: 'c_race', payload: { sdp: 'sdp' } }),
		});
		assert.equal(bridge.webrtcPeer, null, 'init 在飞时 peer 仍 null');
		assert.ok(bridge.__webrtcPeerReady, '__webrtcPeerReady 应为 pending promise');

		// 闸门 pending 时投 auth-close 4001，拿其返回 promise（先别 await 完）
		const closeP = closeListener({ code: 4001, reason: 'unauthorized' });
		// 放行 init → 赋值 peer/fileHandler
		gateResolve();
		// 等两条续体收敛
		await Promise.all([msgP, closeP]);

		assert.equal(closeAllCalls, 1, 'closeAll 应对落地的 peer 调用 1 次');
		assert.equal(cancelCleanupCalls, 1, 'cancelCleanup 应对落地的 fileHandler 调用 1 次');
		assert.equal(bridge.webrtcPeer, null, 'webrtcPeer 应被清空（无无主 PC）');
		assert.equal(bridge.__fileHandler, null, 'fileHandler 应被清空');
		assert.equal(bridge.__webrtcPeerReady, null, '__webrtcPeerReady 应被清空');
	} finally {
		await bridge.stop();
	}
});

test('auth-close 无 lazy init 在飞：await null?.catch 安全 no-op', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		assert.equal(bridge.__webrtcPeerReady, null, '前置：无 init 在飞');
		const closeListener = server.listeners.get('close')[0];
		// 不应抛
		await closeListener({ code: 4001, reason: 'unauthorized' });
		assert.equal(bridge.webrtcPeer, null);
		assert.equal(bridge.__fileHandler, null);
		assert.equal(bridge.__webrtcPeerReady, null);
	} finally {
		await bridge.stop();
	}
});

test('auth-close 撞 lazy init 在飞且 init reject：仍清理已赋值的 fileHandler、不抛', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		let cancelCleanupCalls = 0;
		const fakeHandler = { cancelCleanup: () => { cancelCleanupCalls += 1; } };
		let gateResolve;
		const gate = new Promise((res) => { gateResolve = res; });
		bridge.__initWebrtcPeer = async () => {
			await gate;
			bridge.__fileHandler = fakeHandler; // reject 前已赋 fileHandler
			throw new Error('init failed');
		};
		const messageListener = server.listeners.get('message')[0];
		const closeListener = server.listeners.get('close')[0];

		const msgP = messageListener({
			data: JSON.stringify({ type: 'rtc:offer', fromConnId: 'c_reject', payload: { sdp: 'sdp' } }),
		});
		const closeP = closeListener({ code: 4001, reason: 'unauthorized' });
		gateResolve();
		// 两续体都不应抛（msgP 的 init reject 被 rtc 块 try/catch 兜住，closeP 的 ?.catch 吞掉）
		await assert.doesNotReject(Promise.all([msgP, closeP]));

		assert.equal(cancelCleanupCalls, 1, 'init 抛前已赋的 fileHandler 仍应被 cancelCleanup');
		assert.equal(bridge.webrtcPeer, null);
		assert.equal(bridge.__fileHandler, null);
		assert.equal(bridge.__webrtcPeerReady, null);
	} finally {
		await bridge.stop();
	}
});

test('stop() 撞 lazy init 在飞：先等 init 落地再清理（孪生竞态回归锁）', async () => {
	const { bridge, server } = await setupConnectedBridge();
	let stopped = false;
	try {
		let closeAllCalls = 0;
		let cancelCleanupCalls = 0;
		const fakePeer = {
			handleSignaling: async () => {},
			closeAll: async () => { closeAllCalls += 1; },
		};
		const fakeHandler = { cancelCleanup: () => { cancelCleanupCalls += 1; } };
		let gateResolve;
		const gate = new Promise((res) => { gateResolve = res; });
		bridge.__initWebrtcPeer = async () => {
			await gate;
			bridge.__fileHandler = fakeHandler;
			bridge.webrtcPeer = fakePeer;
		};
		const messageListener = server.listeners.get('message')[0];

		// 投 rtc:offer 让 lazy init 进 pending（peer 仍 null）
		const msgP = messageListener({
			data: JSON.stringify({ type: 'rtc:offer', fromConnId: 'c_stoprace', payload: { sdp: 'sdp' } }),
		});
		assert.equal(bridge.webrtcPeer, null, 'init 在飞时 peer 仍 null');
		assert.ok(bridge.__webrtcPeerReady, '__webrtcPeerReady 应为 pending');

		// 闸门 pending 时调 stop()（先别 await 完）
		const stopP = bridge.stop();
		stopped = true;
		// 放行 init → 赋值 peer/fileHandler
		gateResolve();
		await Promise.all([msgP, stopP]);

		assert.equal(closeAllCalls, 1, 'closeAll 应对落地的 peer 调 1 次');
		assert.equal(cancelCleanupCalls, 1, 'cancelCleanup 应对落地的 fileHandler 调 1 次');
		assert.equal(bridge.webrtcPeer, null, 'webrtcPeer 应被清空（无无主 PC）');
		assert.equal(bridge.__fileHandler, null, 'fileHandler 应被清空');
		assert.equal(bridge.__webrtcPeerReady, null, '__webrtcPeerReady 应被清空');
	} finally {
		if (!stopped) await bridge.stop();
	}
});

test('RealtimeBridge __forwardToServer should log when ws not ready', async () => {
	const { bridge } = await setupConnectedBridge();
	const warns = [];
	bridge.logger = { info: () => {}, warn: (m) => warns.push(String(m)), debug: () => {}, error: () => {} };
	try {
		// 模拟 ws 处于断开状态
		bridge.serverWs = null;
		bridge.__forwardToServer({ type: 'rtc:answer', payload: {} });
		assert.ok(warns.some((x) => x.includes('forward dropped') && x.includes('rtc:answer')), 'should warn on drop with payload type');
	} finally {
		await bridge.stop();
	}
});

test('RealtimeBridge __forwardToServer should log when ws send throws', async () => {
	const { bridge, server } = await setupConnectedBridge();
	const warns = [];
	bridge.logger = { info: () => {}, warn: (m) => warns.push(String(m)), debug: () => {}, error: () => {} };
	try {
		server.throwOnSend = true;
		bridge.__forwardToServer({ type: 'rtc:answer', payload: {} });
		assert.ok(warns.some((x) => x.includes('forward send failed') && x.includes('rtc:answer')), 'should warn on send throw with payload type');
	} finally {
		server.throwOnSend = false;
		await bridge.stop();
	}
});

test('RealtimeBridge rtc: messages should not interfere with rpc.req handling', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		// 先发 rtc 消息
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_noint',
				payload: { sdp: 'sdp' },
			}),
		});
		await waitFor(() => bridge.webrtcPeer !== null, { label: 'webrtcPeer created' });

		// 再发 rpc.req（未识别消息被静默忽略，只需确认不崩溃）
		server.emit('message', {
			data: JSON.stringify({ type: 'rpc.req', id: 'rpc-1', method: 'test.method', params: {} }),
		});
		for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));

		assert.ok(true);
	} finally {
		await bridge.stop();
	}
});

test('RealtimeBridge stop() should cleanup webrtcPeer explicitly', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_stop',
				payload: { sdp: 'sdp' },
			}),
		});
		await waitFor(() => bridge.webrtcPeer !== null, { label: 'webrtcPeer created' });
		assert.notEqual(bridge.webrtcPeer, null);

		await bridge.stop();
		assert.equal(bridge.webrtcPeer, null, 'stop() should cleanup webrtcPeer');
	} finally {
	}
});

test('RealtimeBridge WebRtcPeer onRequest should route to __handleGatewayRequestFromDc', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		// 触发 rtc:offer 以创建 webrtcPeer
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_req1',
				payload: { sdp: 'sdp' },
			}),
		});
		await waitFor(() => bridge.webrtcPeer !== null, { label: 'webrtcPeer created' });
		assert.notEqual(bridge.webrtcPeer, null);

		// 验证 onRequest 已注册
		assert.equal(typeof bridge.webrtcPeer.__onRequest, 'function');

		// 追踪 DC broadcast
		const broadcasted = [];
		bridge.webrtcPeer.broadcast = (payload) => broadcasted.push(payload);

		// 调用 onRequest 模拟 DataChannel 收到 req
		const reqPayload = { type: 'req', id: 'ui-dc-1', method: 'agent', params: { text: 'hi' } };
		bridge.webrtcPeer.__onRequest(reqPayload, 'c_req1');

		// 等待 __waitGatewayReady 超时（已注入 50ms）→ broadcast GATEWAY_OFFLINE
		await waitFor(() => broadcasted.some((p) => p.type === 'res' && p.id === 'ui-dc-1' && p.error?.code === 'GATEWAY_OFFLINE'), { label: 'GATEWAY_OFFLINE broadcast', timeoutMs: 2000 });

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
	}
});

test('RealtimeBridge gateway res/event should broadcast to webrtcPeer', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		// 触发 rtc:offer 以创建 webrtcPeer
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_bc1',
				payload: { sdp: 'sdp' },
			}),
		});
		await waitFor(() => bridge.webrtcPeer !== null, { label: 'webrtcPeer created' });

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
	}
});

test('RealtimeBridge gateway health/tick events are filtered (not forwarded to DC)', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_filter',
				payload: { sdp: 'sdp' },
			}),
		});
		await waitFor(() => bridge.webrtcPeer !== null, { label: 'webrtcPeer created' });

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
	}
});

test('RealtimeBridge GATEWAY_OFFLINE error should broadcast to webrtcPeer (DC path)', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		// 触发 rtc:offer 以创建 webrtcPeer
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_bc2',
				payload: { sdp: 'sdp' },
			}),
		});
		await waitFor(() => bridge.webrtcPeer !== null, { label: 'webrtcPeer created' });

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
	}
});

test('RealtimeBridge GATEWAY_SEND_FAILED error should broadcast to webrtcPeer (DC path)', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		// 触发 rtc:offer 以创建 webrtcPeer
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_bc3',
				payload: { sdp: 'sdp' },
			}),
		});
		await waitFor(() => bridge.webrtcPeer !== null, { label: 'webrtcPeer created' });

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
	}
});

test('RealtimeBridge concurrent rtc: messages should share single WebRtcPeer init', async () => {
	const { bridge, server } = await setupConnectedBridge();
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
		await waitFor(() => bridge.webrtcPeer?.__sessions?.get?.('c_race'), { label: 'session for c_race' });

		assert.notEqual(bridge.webrtcPeer, null, 'webrtcPeer should be created');
		// ice 应被同一个 webrtcPeer 实例处理（session 存在）
		const session = bridge.webrtcPeer.__sessions?.get('c_race');
		assert.ok(session, 'session for c_race should exist on the single webrtcPeer instance');
	} finally {
		await bridge.stop();
	}
});

test('RealtimeBridge __webrtcPeerReady should reset on init failure for retry', async () => {
	const { bridge, server, logs } = await setupConnectedBridge();
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
		await waitFor(() => failCount > 0 && bridge.__webrtcPeerReady === null, { label: 'init failure cleared lock' });

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
		await waitFor(() => bridge.webrtcPeer !== null, { label: 'webrtcPeer created on retry' });

		assert.notEqual(bridge.webrtcPeer, null, 'webrtcPeer should be created on retry');
	} finally {
		await bridge.stop();
	}
});

test('RealtimeBridge auth-close should reset __webrtcPeerReady', async () => {
	const { bridge, server } = await setupConnectedBridge();
	try {
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_cleanup2',
				payload: { sdp: 'sdp' },
			}),
		});
		await waitFor(() => bridge.__webrtcPeerReady !== null && bridge.webrtcPeer !== null, { label: '__webrtcPeerReady set' });
		assert.notEqual(bridge.__webrtcPeerReady, null);

		server.emit('close', { code: 4001, reason: 'unauthorized' });
		await waitFor(() => bridge.webrtcPeer === null && bridge.__webrtcPeerReady === null, { label: '__webrtcPeerReady cleared' });

		assert.equal(bridge.webrtcPeer, null);
		assert.equal(bridge.__webrtcPeerReady, null, 'promise lock should be cleared on auth-close');
	} finally {
		await bridge.stop();
	}
});

// --- remote-log sender 集成测试 ---

test('RealtimeBridge should wire remote-log sender on open and flush buffered logs', async () => {
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
		// flush 是异步的——等到 buffered 'before-connect' 真正落到 server.sent
		// 注意：open 后会发若干其他 log（ws.connected/coclaw.env 等），不能只等"任意 log"——
		// 那些其他 log 先到时 buffered 'before-connect' 仍在 buffer 里
		await waitFor(() => remoteLogBuffer.length === 0 && server.sent.some((s) => {
			try {
				const p = JSON.parse(s);
				return p?.type === 'log' && Array.isArray(p?.logs) && p.logs.some((l) => l.text === 'before-connect');
			} catch { return false; }
		}), { label: 'before-connect flushed' });

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
	}
});

test('RealtimeBridge should clear remote-log sender on close', async () => {
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
	}
});

test('RealtimeBridge should clear remote-log sender on stop', async () => {
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
	}
});

// --- WebRTC preload（pion 单实现，无兜底）集成测试 ---

test('RealtimeBridge start() should await pion preload before connecting', async () => {
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	let preloadCalled = false;
	const bridge = createBridge({
		preloadPion: async () => {
			preloadCalled = true;
			return { PeerConnection: class PionPC {}, cleanup: null, impl: 'pion' };
		},
	});

	try {
		await bridge.start({ logger: noopLogger() });
		assert.ok(preloadCalled, 'preloadPion should be called during start');
		// start() 完成后结果已就绪（不再是 promise）
		assert.ok(bridge.__ndcPreloadResult);
		assert.equal(bridge.__ndcPreloadResult.impl, 'pion');
	} finally {
		await bridge.stop();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('RealtimeBridge stop() should call pion cleanup and null the refs', async () => {
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	let cleanupCalled = false;
	const bridge = createBridge({
		preloadPion: async () => ({
			PeerConnection: class PionPC {},
			cleanup: async () => { cleanupCalled = true; },
			impl: 'pion',
		}),
	});

	try {
		await bridge.start({ logger: noopLogger() });
		await bridge.stop();
		assert.ok(cleanupCalled, 'pion cleanup should be called on stop (closes Go process)');
		assert.equal(bridge.__ndcCleanup, null);
		assert.equal(bridge.__ndcPreloadResult, null);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('RealtimeBridge stop() should be a no-op cleanup when impl=none', async () => {
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	const bridge = createBridge({
		preloadPion: async () => null, // pion 不可用 → impl=none
	});

	try {
		await bridge.start({ logger: noopLogger() });
		assert.equal(bridge.__ndcPreloadResult.impl, 'none');
		// cleanup 为 null，stop 不应有问题
		await bridge.stop();
		assert.equal(bridge.__ndcCleanup, null);
		assert.equal(bridge.__ndcPreloadResult, null);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('RealtimeBridge start() should fall to impl=none when pion preload returns null', async () => {
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	const bridge = createBridge({
		preloadPion: async () => null,
	});

	try {
		await bridge.start({ logger: noopLogger() });
		// none 结果必须保持非空三字段契约（start/stop 竞态守卫直接读 .impl / .cleanup）
		assert.deepEqual(bridge.__ndcPreloadResult, { PeerConnection: null, cleanup: null, impl: 'none' });
		// versionPromise 已被 await：plugin 版本在 preload 返回前就绪，env 行不得退化 unknown
		assert.match(bridge.__pluginVersion, /^\d+\.\d+\.\d+/);
	} finally {
		await bridge.stop();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('RealtimeBridge start() should handle pion preload rejection gracefully (impl=none)', async () => {
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	const warnings = [];
	const logger = {
		...noopLogger(),
		warn: (msg) => warnings.push(msg),
	};
	const bridge = createBridge({
		preloadPion: async () => { throw new Error('preload boom'); },
	});

	try {
		await bridge.start({ logger });
		// preload 失败被 catch 兜底，bridge 仍启动但 WebRTC 不可用
		assert.deepEqual(bridge.__ndcPreloadResult, { PeerConnection: null, cleanup: null, impl: 'none' });
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
		preloadPion: async () => {
			await new Promise((r) => setTimeout(r, 50));
			preloadResolved = true;
			return { PeerConnection: class PionPC {}, cleanup: null, impl: 'pion' };
		},
	});

	try {
		// start() 完成时 preload 一定已经完成（因为 await）
		await bridge.start({ logger: noopLogger() });
		assert.ok(preloadResolved, 'preload should complete before start returns');
		assert.equal(bridge.__ndcPreloadResult.impl, 'pion');
	} finally {
		await bridge.stop();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('RealtimeBridge start() aborts when started=false flips mid-preload (pion null → none)', async () => {
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	let resolvePreload;
	const bridge = createBridge({
		preloadPion: () => new Promise((resolve) => { resolvePreload = resolve; }),
		// 跳过 plan-2 fs 预热，避免拖慢到 setTimeout(0) 也未到达 preload 阶段
		cleanupRpcQueueResiduals: async () => {},
		measureRpcQueueDiskCap: async () => 0,
	});

	try {
		const startPromise = bridge.start({ logger: noopLogger() });
		// 等待 start → __preloadWebrtc → preloadPion() 被调用
		await new Promise((r) => setTimeout(r, 0));
		// preload 仍在进行中，此时调用 stop
		bridge.started = false; // 模拟 stop() 的可观察副作用：started 翻 false（不真调 stop()，避免误触发 cleanup）
		// pion 不可用 → __preloadWebrtc 落到 none 字面量；竞态守卫须能安全读 .impl
		resolvePreload(null);
		await startPromise;
		assert.equal(bridge.__ndcPreloadResult, null, 'should not assign result after stop');
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('RealtimeBridge start() aborts with pion cleanup when started=false flips mid-pion-preload', async () => {
	const dir = await writeCfg({ serverUrl: 'http://127.0.0.1:1', token: 'tok' });
	let cleanupCalled = false;
	let resolvePion;
	const bridge = createBridge({
		preloadPion: () => new Promise((resolve) => { resolvePion = resolve; }),
		// 跳过 plan-2 fs 预热，避免拖慢到 setTimeout(0) 也未到达 preload 阶段
		cleanupRpcQueueResiduals: async () => {},
		measureRpcQueueDiskCap: async () => 0,
	});

	try {
		const startPromise = bridge.start({ logger: noopLogger() });
		// 等待 start → __preloadWebrtc → preloadPion() 被调用
		await new Promise((r) => setTimeout(r, 0));
		bridge.started = false; // 模拟 stop() 的可观察副作用：started 翻 false（不真调 stop()，避免误触发 cleanup）
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
		assert.match(envInfo, /\bimpl=(?:pion|none)\b/);
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

	// 本用例不走 setupDir，得自己管理 runtime——任一断言失败时也必须恢复，
	// 否则会跨用例污染（setupDir 的 cleanup 队列管不到这里裸调的 setRuntime）。
	const prevRuntime = getRuntime();
	try {
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
	} finally {
		setRuntime(prevRuntime);
	}
});

test('RealtimeBridge ws.open re-emits coclaw.env on reconnect (after sender injected)', async () => {
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
		assert.match(reEmitted, /\bimpl=(?:pion|none)\b/);
		assert.match(reEmitted, /\bplugin=\d+\.\d+\.\d+/);
		assert.match(reEmitted, /\bopenclaw=(?:unknown|\d+\.\d+\.\d+)/);
		assert.match(reEmitted, /\bplatform=/);
		// 缓存不变量：两次连接发出的 envLine 内容必须字节一致
		assert.equal(reEmitted, firstEnv,
			'env line must be identical across reconnects (verifies cached plugin+openclaw+platform)');
	} finally {
		await bridge.stop();
		resetRemoteLog();
	}
});

// --- __collectAgentModels 测试 ---

test('RealtimeBridge __collectAgentModels should map agents with name fallback and model.primary', async () => {
	const bridge = createBridge();
	bridge.__gatewayRpc = async (method, params, options) => {
		assert.equal(method, 'agents.list');
		assert.deepEqual(params, {});
		// 明确断言 timeoutMs，防止静默改参数导致等待行为改变。
		// 30s 给 OpenClaw manifest cache 偶发卡顿（issue #80697）留恢复窗口
		assert.equal(options?.timeoutMs, 30000);
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
	await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';

	try {
		await restartRealtimeBridge({
			logger: noopLogger(),
			pluginConfig: {},
			__deps: {
				WebSocket: FakeWebSocket,
				resolveGatewayAuthToken: () => 'tkn',
				preloadPion: mockPreloadPion,
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
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
	}
});

test('RealtimeBridge __pushInstanceInfo should omit agentModels field when agents.list fails', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';

	try {
		await restartRealtimeBridge({
			logger: noopLogger(),
			pluginConfig: {},
			__deps: {
				WebSocket: FakeWebSocket,
				resolveGatewayAuthToken: () => 'tkn',
				preloadPion: mockPreloadPion,
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
		// 漏报字段：server / UI 按 patch 语义保留旧值，避免 admin 仪表盘瞬时清空
		assert.equal(Object.hasOwn(payload, 'agentModels'), false, 'agentModels should be omitted when agents.list fails');
		assert.ok('name' in payload);
		assert.ok('hostName' in payload);
		assert.ok('pluginVersion' in payload);
	}
	finally {
		await stopRealtimeBridge({ forceCleanup: true });
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
	}
});

// step 2 — 推送拆两路：外线 open 时若内线已就绪也补推一次 instance info
// 用 prototype spy 直接计 __pushInstanceInfo 调用次数，从根上规避"等不够时长导致假通过"。
test('RealtimeBridge sock.open should re-push instance info when gateway already ready (inner-then-outer)', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';

	const origPush = RealtimeBridge.prototype.__pushInstanceInfo;
	let pushCalls = 0;
	RealtimeBridge.prototype.__pushInstanceInfo = function patchedPush() {
		pushCalls++;
		return origPush.call(this);
	};

	try {
		await restartRealtimeBridge({
			logger: noopLogger(),
			pluginConfig: {},
			__deps: {
				WebSocket: FakeWebSocket,
				resolveGatewayAuthToken: () => 'tkn',
				preloadPion: mockPreloadPion,
				gatewayReadyTimeoutMs: 50,
			},
		});
		const server = FakeWebSocket.instances[0];
		const gateway = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		// 关键：外线 server 不 open（保持 readyState=0），先让内线握手成功
		gateway.readyState = 1;
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });

		// 消化第一轮 agents.list（内线 connect-ok 触发的 __pushInstanceInfo），
		// 此时 broadcastPluginEvent 在 server 路径会因 server.readyState=0 直接 drop。
		await drainEnsureAllAgentSessions(gateway);

		assert.equal(pushCalls, 1, '内线 connect-ok 应触发一次 __pushInstanceInfo');
		const earlyEvents = server.sent
			.map((s) => { try { return JSON.parse(String(s)); } catch { return null; } })
			.filter((m) => m?.type === 'event' && m?.event === 'coclaw.info.updated');
		assert.equal(earlyEvents.length, 0, 'server 未 open 时第一次 push 应被 __forwardToServer drop');

		// 现在外线 open：sock.open 看到 gatewayReady=true，应主动补推一次
		server.readyState = 1;
		server.emit('open', {});

		// 补推会再发一轮 agents.list（__collectAgentModels），消化它
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		await drainEnsureAllAgentSessions(gateway);

		assert.equal(pushCalls, 2, '外线 open 看到 gatewayReady=true 应再触发一次 __pushInstanceInfo');
		const lateEvents = server.sent
			.map((s) => { try { return JSON.parse(String(s)); } catch { return null; } })
			.filter((m) => m?.type === 'event' && m?.event === 'coclaw.info.updated');
		assert.ok(lateEvents.length >= 1, 'server open 后应观察到补推的 coclaw.info.updated');
		const payload = lateEvents[lateEvents.length - 1].payload;
		assert.ok('name' in payload && 'hostName' in payload && 'pluginVersion' in payload && 'agentModels' in payload);
		// 深度断言：__collectAgentModels 走通时 agentModels 是数组（drain helper 返回 main 一项），
		// 防 agentModels=null 也通过的退化情形。
		assert.ok(Array.isArray(payload.agentModels), 'agentModels 应是数组（agents.list 走通）');
		assert.equal(payload.agentModels.length, 1, 'drain helper 返回 1 个 agent');
	}
	finally {
		await stopRealtimeBridge({ forceCleanup: true });
		RealtimeBridge.prototype.__pushInstanceInfo = origPush;
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
	}
});

// step 2 — 反向门控：外线 open 但内线未就绪时不触发 push（避免发不全的 info）
// 用 prototype spy 直接断言 __pushInstanceInfo 没被调用，避免依赖时序等待——守卫坏掉时
// __waitGatewayReady 要等 3s 才超时返回，靠 setTimeout(50) 等 broadcast 出现等不到。
test('RealtimeBridge sock.open should NOT push instance info when gateway not ready', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	const oldGw = process.env.COCLAW_GATEWAY_WS_URL;
	process.env.COCLAW_GATEWAY_WS_URL = 'ws://gw.local';

	const origPush = RealtimeBridge.prototype.__pushInstanceInfo;
	let pushCalls = 0;
	RealtimeBridge.prototype.__pushInstanceInfo = function patchedPush() {
		pushCalls++;
		return origPush.call(this);
	};

	try {
		await restartRealtimeBridge({
			logger: noopLogger(),
			pluginConfig: {},
			__deps: {
				WebSocket: FakeWebSocket,
				resolveGatewayAuthToken: () => 'tkn',
				preloadPion: mockPreloadPion,
				gatewayReadyTimeoutMs: 50,
			},
		});
		const server = FakeWebSocket.instances[0];
		// 内线不 open（gatewayReady 保持 false），仅 open 外线
		server.readyState = 1;
		server.emit('open', {});

		// 给 sock.open 同步 + 微任务一次完整跑完的机会（不依赖等到 broadcast 出现）
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

		assert.equal(pushCalls, 0, 'gatewayReady=false 时 sock.open 不应调用 __pushInstanceInfo');
	}
	finally {
		await stopRealtimeBridge({ forceCleanup: true });
		RealtimeBridge.prototype.__pushInstanceInfo = origPush;
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
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
	await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
	}
});

test('lag probe: gateway WS close clears all in-flight probes (no 60s wait)', async () => {
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
	}
});

test('lag probe: bridge.stop() clears any residual probes', async () => {
	await writeCfg({});
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
 * 返回 { bridge, server, gwWs, logs }（后两个继承自 setupConnectedBridge）。调用方需在 finally 中 bridge.stop()。
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
	await waitFor(() => bridge.webrtcPeer !== null, { label: 'webrtcPeer created in setupBridgeWithGateway' });
	const gwWs = FakeWebSocket.instances.find((ws) => ws !== server);
	gwWs.readyState = 1;
	bridge.gatewayReady = true;
	bridge.gatewayWs = gwWs;
	return { ...ctx, gwWs };
}

test('dc unicast: terminal res hits sendTo, broadcast not called, mapping cleared', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_uc1');
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
	}
});

test('dc unicast: agent two-stage keeps mapping on accepted, clears on terminal', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_agent');
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
	}
});

test('dc unicast: approval two-stage follows same accepted/terminal pattern', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_apv');
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
	}
});

test('dc unicast: chat.send single-frame status="started" clears immediately', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_chat');
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
	}
});

test('dc unicast: single-stage RPC clears mapping on response', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_single');
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
	}
});

test('dc unicast: collision deletes prior entry and warns', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_col1');
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
	}
});

test('dc unicast: GATEWAY_OFFLINE keeps broadcast and writes no mapping', async () => {
	const { bridge } = await setupBridgeWithGateway('c_off');
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
	}
});

test('dc unicast: GATEWAY_SEND_FAILED clears mapping then broadcasts', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_sfail');
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
	}
});

test('dc unicast: stop() 显式清空 P2P pending table（与 __runEventRoutes 同契约）', async () => {
	// 对称契约：内线 ws close 不再清表（4738 已覆盖），但显式销毁路径（stop / refresh）
	// 必须把表清干净，避免 refresh 后留下指向旧 connId 的孤儿条目。
	// 与 5115 test('run-event-routes: __closeGatewayWs() 不再清路由表；stop() 才清') 对称。
	const { bridge } = await setupBridgeWithGateway('c_dcstop');
	try {
		bridge.webrtcPeer.sendTo = () => true;
		bridge.webrtcPeer.broadcast = () => {};

		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-stop-1', method: 'sessions.list', params: {} },
			'c_dcstop'
		);
		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-stop-2', method: 'sessions.list', params: {} },
			'c_dcstop'
		);
		assert.equal(bridge.__dcPendingRequests.size, 2);

		bridge.__closeGatewayWs();
		assert.equal(bridge.__dcPendingRequests.size, 2,
			'__closeGatewayWs 不再清 P2P pending（解耦后由 TTL / stop 兜底）');

		await bridge.stop();
		assert.equal(bridge.__dcPendingRequests.size, 0,
			'stop() 必须显式清表，避免 refresh 后孤儿条目');
	} finally {
	}
});

test('dc unicast: gateway ws close 不再清空 P2P pending table（三线独立）', async () => {
	// 新契约：内线翻转不再级联清 P2P 路由表，避免 DC RPC 在内线瞬态抖动时被误清；
	// 已发出去的请求等 UI 30/60s 超时兜底；条目最终由 24h TTL 扫描器或显式 stop() 回收。
	const { bridge, gwWs } = await setupBridgeWithGateway('c_close1');
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
		assert.equal(bridge.__dcPendingRequests.size, 2,
			'gateway ws close 不应清 P2P pending（解耦后由 TTL / stop 兜底）');
	} finally {
		await bridge.stop();
	}
});

test('dc unicast: sendTo failure logs debug, no broadcast fallback', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_und');
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
	}
});

test('dc unicast: unmatched res falls back to broadcast', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_unmatch');
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
	}
});

test('dc unicast: TTL scan clears expired entries and warns', async () => {
	await writeCfg({ token: 'rtc-tok', serverUrl: 'https://server.local' });
	const warns = [];
	const logger = {
		info() {}, debug() {},
		warn: (m) => warns.push(String(m)),
	};
	const bridge = new RealtimeBridge({
		WebSocket: FakeWebSocket,
		resolveGatewayAuthToken: () => '',
		preloadPion: mockPreloadPion,
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

		// 等待扫描清掉过期条目
		await waitFor(() => !bridge.__dcPendingRequests.has('ui-exp-1'), { label: 'TTL scan cleared expired' });

		assert.equal(bridge.__dcPendingRequests.has('ui-exp-1'), false, 'expired entry cleared');
		assert.equal(bridge.__dcPendingRequests.has('ui-fresh-1'), true, 'fresh entry kept');
		assert.ok(warns.some((m) => m.includes('dc pending entries expired') && m.includes('count=1')),
			'should warn on cleanup');
	} finally {
		await bridge.stop();
	}
});

// --- runId → connId 路由表（agent event 单播）集成测试 ---

test('run-event-routes: res accepted with runId writes route', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_re1');
	try {
		bridge.webrtcPeer.sendTo = () => true;
		bridge.webrtcPeer.broadcast = () => {};

		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-re-1', method: 'agent', params: {} },
			'c_re1'
		);
		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-re-1', ok: true, payload: { status: 'accepted', runId: 'run-A' } }),
		});
		for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));

		assert.equal(bridge.__runEventRoutes.lookup('run-A'), 'c_re1', 'route added on accepted');
	} finally {
		await bridge.stop();
	}
});

test('run-event-routes: res non-accepted with runId removes route', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_re2');
	try {
		bridge.webrtcPeer.sendTo = () => true;
		bridge.webrtcPeer.broadcast = () => {};

		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-re-2', method: 'agent', params: {} },
			'c_re2'
		);
		// accepted 写入
		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-re-2', ok: true, payload: { status: 'accepted', runId: 'run-B' } }),
		});
		for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
		assert.equal(bridge.__runEventRoutes.lookup('run-B'), 'c_re2');

		// 终态 res（非 accepted）→ 删除
		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-re-2', ok: true, payload: { status: 'ok', runId: 'run-B' } }),
		});
		for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
		assert.equal(bridge.__runEventRoutes.lookup('run-B'), undefined, 'route removed on terminal');
	} finally {
		await bridge.stop();
	}
});

test('run-event-routes: event:agent hits unicast by runId', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_re3');
	try {
		const sentTo = [];
		const broadcasted = [];
		bridge.webrtcPeer.sendTo = (connId, payload) => { sentTo.push({ connId, payload }); return true; };
		bridge.webrtcPeer.broadcast = (p) => broadcasted.push(p);

		bridge.__runEventRoutes.add('run-C', 'c_re3', 'ui-re-3');

		gwWs.emit('message', {
			data: JSON.stringify({
				type: 'event',
				event: 'agent',
				payload: { runId: 'run-C', stream: 'reasoning', seq: 1, data: {} },
			}),
		});
		for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));

		assert.equal(sentTo.length, 1, 'unicast hit');
		assert.equal(sentTo[0].connId, 'c_re3');
		assert.equal(sentTo[0].payload.payload.runId, 'run-C');
		assert.equal(broadcasted.length, 0, 'no fallback broadcast on hit');
	} finally {
		await bridge.stop();
	}
});

test('run-event-routes: event:agent miss falls back to broadcast', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_re4');
	try {
		const sentTo = [];
		const broadcasted = [];
		bridge.webrtcPeer.sendTo = (connId, payload) => { sentTo.push({ connId, payload }); return true; };
		bridge.webrtcPeer.broadcast = (p) => broadcasted.push(p);

		// 不预先注册 → miss
		gwWs.emit('message', {
			data: JSON.stringify({
				type: 'event',
				event: 'agent',
				payload: { runId: 'run-D-orphan', stream: 'reasoning', seq: 1, data: {} },
			}),
		});
		for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));

		assert.equal(sentTo.length, 0, 'no unicast');
		assert.equal(broadcasted.length, 1, 'fallback broadcast');
		assert.equal(broadcasted[0].payload.runId, 'run-D-orphan');
	} finally {
		await bridge.stop();
	}
});

test('gateway forward: agent event 单播命中时把 rawData 作第 3 参传给 sendTo（跳过重新 stringify）', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_raw_fwd_1');
	try {
		const calls = [];
		bridge.webrtcPeer.sendTo = (connId, payload, rawStr) => {
			calls.push({ connId, payload, rawStr });
			return true;
		};
		bridge.webrtcPeer.broadcast = () => { throw new Error('should not broadcast on route hit'); };

		bridge.__runEventRoutes.add('run-raw-1', 'c_raw_fwd_1', 'ui-raw-1');

		// 故意构造非紧凑（多余空格）字符串：JSON.parse 仍可解析、
		// 若代码意外重新 stringify(parsed) 输出会是无空格紧凑形，与 fixture 不等 → 测试红。
		const eventStr = '{ "type": "event",  "event": "agent",  "payload": { "runId": "run-raw-1", "data": { "big": "xxxxxxxxxx" } } }';
		gwWs.emit('message', { data: eventStr });
		for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));

		assert.equal(calls.length, 1);
		assert.equal(calls[0].connId, 'c_raw_fwd_1');
		assert.equal(typeof calls[0].rawStr, 'string', 'rawStr 必须以字符串传入');
		assert.equal(calls[0].rawStr, eventStr, 'rawStr 必须是 gateway 原始字符串（含原始空格），不能是重新 stringify 的产物');
		assert.notEqual(calls[0].rawStr, JSON.stringify(calls[0].payload),
			'rawStr 与 stringify(payload) 必须不等，否则证据不足以证伪重新 stringify 退化');
		assert.equal(calls[0].payload.payload.runId, 'run-raw-1', 'payload 仍是 parsed 对象');
	} finally {
		await bridge.stop();
	}
});

test('gateway forward: agent event 兜底广播时把 rawData 作第 2 参传给 broadcast', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_raw_fwd_2');
	try {
		const calls = [];
		bridge.webrtcPeer.broadcast = (payload, rawStr) => { calls.push({ payload, rawStr }); };
		bridge.webrtcPeer.sendTo = () => { throw new Error('should not unicast on miss'); };

		// 不写路由 → miss → 兜底广播。fixture 用非紧凑形式锁住 rawData 透传
		const eventStr = '{ "type": "event",  "event": "agent",  "payload": { "runId": "run-raw-orphan" } }';
		gwWs.emit('message', { data: eventStr });
		for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));

		assert.equal(calls.length, 1);
		assert.equal(calls[0].rawStr, eventStr, 'broadcast 必须收到原始字符串');
		assert.notEqual(calls[0].rawStr, JSON.stringify(calls[0].payload),
			'rawStr 与 stringify(payload) 必须不等，否则证据不足以证伪重新 stringify 退化');
		assert.equal(calls[0].payload.payload.runId, 'run-raw-orphan');
	} finally {
		await bridge.stop();
	}
});

test('gateway forward: res 单播命中（__dcPendingRequests）时把 rawData 作第 3 参传给 sendTo', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_raw_fwd_3');
	try {
		const calls = [];
		bridge.webrtcPeer.sendTo = (connId, payload, rawStr) => {
			calls.push({ connId, payload, rawStr });
			return true;
		};
		bridge.webrtcPeer.broadcast = () => { throw new Error('should not broadcast on res route hit'); };

		// 写 reqId → connId 路由
		bridge.__dcPendingRequests.set('ui-raw-r1', {
			connId: 'c_raw_fwd_3',
			expireAt: Date.now() + 60_000,
		});

		// fixture 用非紧凑形式锁住 rawData 透传
		const resStr = '{ "type": "res",  "id": "ui-raw-r1",  "ok": true,  "payload": { "status": "ok", "runId": "run-raw-r1" } }';
		gwWs.emit('message', { data: resStr });
		for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));

		assert.equal(calls.length, 1);
		assert.equal(calls[0].connId, 'c_raw_fwd_3');
		assert.equal(calls[0].rawStr, resStr, 'sendTo 必须收到 res 的原始字符串');
		assert.notEqual(calls[0].rawStr, JSON.stringify(calls[0].payload),
			'rawStr 与 stringify(payload) 必须不等，否则证据不足以证伪重新 stringify 退化');
		assert.equal(calls[0].payload.id, 'ui-raw-r1');
	} finally {
		await bridge.stop();
	}
});

test('gateway forward: res 帧无 __dcPendingRequests 命中时回退兜底广播并透传 rawData', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_raw_fwd_4');
	try {
		const calls = [];
		bridge.webrtcPeer.broadcast = (payload, rawStr) => { calls.push({ payload, rawStr }); };
		bridge.webrtcPeer.sendTo = () => { throw new Error('should not unicast on res miss'); };

		// 不写 __dcPendingRequests → res miss → 走 (d) 兜底广播
		const resStr = '{ "type": "res",  "id": "ui-orphan-res",  "ok": true,  "payload": { "status": "ok" } }';
		gwWs.emit('message', { data: resStr });
		for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));

		assert.equal(calls.length, 1);
		assert.equal(calls[0].rawStr, resStr, 'res miss 兜底广播必须收到原始字符串');
		assert.notEqual(calls[0].rawStr, JSON.stringify(calls[0].payload),
			'rawStr 与 stringify(payload) 必须不等');
		assert.equal(calls[0].payload.id, 'ui-orphan-res');
	} finally {
		await bridge.stop();
	}
});

test('run-event-routes: gateway ws close 不再清路由表条目（三线独立）', async () => {
	// 新契约：内线翻转不再级联清 runId→connId 路由表，避免内线瞬态抖动时误清。
	// 路由表条目最终由 TTL 扫描器（默认 24h）或显式 stop()/destroy 回收。
	const { bridge, gwWs } = await setupBridgeWithGateway('c_re5');
	try {
		bridge.webrtcPeer.sendTo = () => true;
		bridge.webrtcPeer.broadcast = () => {};

		bridge.__runEventRoutes.add('run-E1', 'c_re5', 'r1');
		bridge.__runEventRoutes.add('run-E2', 'c_re5', 'r2');
		assert.equal(bridge.__runEventRoutes.__entries.size, 2);

		gwWs.emit('close', { code: 1006, reason: 'remote dropped' });
		assert.equal(bridge.__runEventRoutes.__entries.size, 2,
			'gateway ws close 不应清路由表（解耦后由 TTL / stop 兜底）');
	} finally {
		await bridge.stop();
	}
});

test('run-event-routes: stop destroys the route table', async () => {
	const { bridge } = await setupBridgeWithGateway('c_re6');
	try {
		const routes = bridge.__runEventRoutes;
		assert.ok(routes, 'routes should be initialized after start');
		assert.equal(routes.__destroyed, false);

		await bridge.stop();
		assert.equal(routes.__destroyed, true, 'destroy called on stop');
		assert.equal(bridge.__runEventRoutes, null, 'field nulled after stop');
	} finally {
	}
});

test('run-event-routes: same runId from different reqId does not overwrite, event still routed to first writer', async () => {
	// 端到端守住 dump 决策点 3 的核心防御：attach（agent.wait 用同 runId）来抢路由时，
	// 路由表锁定首发；后续 event:agent 必须送给首发 conn，不送给 attach 方，也不退兜底广播。
	const { bridge, gwWs } = await setupBridgeWithGateway('c_re7a');
	try {
		const sentTo = [];
		const broadcasted = [];
		bridge.webrtcPeer.sendTo = (connId, payload) => { sentTo.push({ connId, payload }); return true; };
		bridge.webrtcPeer.broadcast = (p) => broadcasted.push(p);

		// 首发：c_re7a 拿走路由
		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-re-7a', method: 'agent', params: {} },
			'c_re7a'
		);
		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-re-7a', ok: true, payload: { status: 'accepted', runId: 'run-shared' } }),
		});
		for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
		assert.equal(bridge.__runEventRoutes.lookup('run-shared'), 'c_re7a');

		// attach：另一个 conn 通过 agent.wait 等同 runId，又来一条 accepted（不同 reqId）
		await bridge.__handleGatewayRequestFromDc(
			{ id: 'ui-re-7b', method: 'agent.wait', params: { runId: 'run-shared' } },
			'c_re7b'
		);
		gwWs.emit('message', {
			data: JSON.stringify({ type: 'res', id: 'ui-re-7b', ok: true, payload: { status: 'accepted', runId: 'run-shared' } }),
		});
		for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));

		assert.equal(bridge.__runEventRoutes.lookup('run-shared'), 'c_re7a', 'route locked to first writer');

		// 清掉前两次 res accepted 的 sendTo 记录，只看后续 event 的去向
		const sentToBaseline = sentTo.length;
		const broadcastedBaseline = broadcasted.length;

		// agent event 推到 bridge：必须 unicast 给首发 c_re7a，不送 c_re7b，也不广播
		gwWs.emit('message', {
			data: JSON.stringify({
				type: 'event',
				event: 'agent',
				payload: { runId: 'run-shared', stream: 'reasoning', seq: 1, data: {} },
			}),
		});
		for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));

		const eventSends = sentTo.slice(sentToBaseline);
		assert.equal(eventSends.length, 1, 'event 应仅 unicast 一次');
		assert.equal(eventSends[0].connId, 'c_re7a', 'event 必须送给首发 conn');
		assert.notEqual(eventSends[0].connId, 'c_re7b', 'event 绝不送给 attach 方');
		assert.equal(broadcasted.length, broadcastedBaseline, 'event 不应触发兜底广播');
	} finally {
		await bridge.stop();
	}
});

test('run-event-routes: lookup hit but sendTo fails drops event without broadcast fallback', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_re8');
	try {
		const broadcasted = [];
		bridge.webrtcPeer.sendTo = () => false;  // 模拟 PC 死 / DC 拒收
		bridge.webrtcPeer.broadcast = (p) => broadcasted.push(p);

		bridge.__runEventRoutes.add('run-H', 'c_re8', 'r-h');

		gwWs.emit('message', {
			data: JSON.stringify({
				type: 'event',
				event: 'agent',
				payload: { runId: 'run-H', stream: 'reasoning', seq: 1, data: {} },
			}),
		});
		for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));

		assert.equal(broadcasted.length, 0, 'sendTo failure must NOT fall back to broadcast');
	} finally {
		await bridge.stop();
	}
});

test('run-event-routes: event:agent without runId falls back to broadcast', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_re_norunid');
	try {
		const sentTo = [];
		const broadcasted = [];
		bridge.webrtcPeer.sendTo = (connId, payload) => { sentTo.push({ connId, payload }); return true; };
		bridge.webrtcPeer.broadcast = (p) => broadcasted.push(p);

		// runId 缺失 → 不进 (c2)，走 (d) 兜底
		gwWs.emit('message', {
			data: JSON.stringify({
				type: 'event',
				event: 'agent',
				payload: { stream: 'reasoning', seq: 1, data: {} },
			}),
		});
		// runId 是非 string（数字）→ 同样不进 (c2)
		gwWs.emit('message', {
			data: JSON.stringify({
				type: 'event',
				event: 'agent',
				payload: { runId: 12345, stream: 'reasoning', seq: 1, data: {} },
			}),
		});
		for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));

		assert.equal(sentTo.length, 0, '无 runId / runId 非 string 不应单播');
		assert.equal(broadcasted.length, 2, '两条都应走兜底广播');
	} finally {
		await bridge.stop();
	}
});

test('run-event-routes: __closeGatewayWs() 不再清路由表；stop() 才清', async () => {
	// 新契约：__closeGatewayWs 仅由显式销毁路径（stop/refresh）调用，自身不再清 P2P 路由。
	// 路由表的清理责任已上移到 stop() 显式 clear，避免内线瞬态翻转误清。
	const { bridge } = await setupBridgeWithGateway('c_re_closegw');
	try {
		bridge.__runEventRoutes.add('run-X', 'c_re_closegw', 'r-x');
		assert.equal(bridge.__runEventRoutes.__entries.size, 1);

		bridge.__closeGatewayWs();
		assert.equal(bridge.__runEventRoutes.__entries.size, 1,
			'__closeGatewayWs 不再清路由表（已下沉到 stop()）');

		// stop 时显式清（实际由 routes.destroy() 完成 clear + 标记 destroyed）
		await bridge.stop();
		// 注意 stop 后 __runEventRoutes 被置 null，不能直接读 __entries.size
		assert.equal(bridge.__runEventRoutes, null, 'stop 后路由表实例置 null');
	} finally {
	}
});

test('run-event-routes: stop then start recreates route table; new instance accepts new entries', async () => {
	const { bridge } = await setupBridgeWithGateway('c_re_refresh');
	try {
		const oldRoutes = bridge.__runEventRoutes;
		oldRoutes.add('run-old', 'c_re_refresh', 'r-old');
		assert.equal(oldRoutes.lookup('run-old'), 'c_re_refresh');

		// stop 销毁旧实例 + 字段置 null
		await bridge.stop();
		assert.equal(oldRoutes.__destroyed, true);
		assert.equal(bridge.__runEventRoutes, null);

		// start 应重建新实例（refresh 流程的核心约束）
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		assert.ok(bridge.__runEventRoutes, 'start 后新建路由表');
		assert.notEqual(bridge.__runEventRoutes, oldRoutes, '应是新实例不是旧的');
		assert.equal(bridge.__runEventRoutes.__destroyed, false, '新实例不应处于 destroyed 态');

		// 新实例可正常 add / lookup
		bridge.__runEventRoutes.add('run-new', 'c_new', 'r-new');
		assert.equal(bridge.__runEventRoutes.lookup('run-new'), 'c_new');
	} finally {
		await bridge.stop();
	}
});

test('run-event-routes: event:agent unicast sendTo throws — caught by listener, no unhandledRejection, no broadcast fallback', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_re_throw');
	const origListeners = process.listeners('unhandledRejection');
	process.removeAllListeners('unhandledRejection');
	const unhandled = [];
	const captureUnhandled = (reason) => unhandled.push(reason);
	process.on('unhandledRejection', captureUnhandled);
	try {
		const broadcasted = [];
		bridge.webrtcPeer.sendTo = async () => { throw new Error('boom from c2 sendTo'); };
		bridge.webrtcPeer.broadcast = (p) => broadcasted.push(p);

		bridge.__runEventRoutes.add('run-throw', 'c_re_throw', 'r-throw');

		gwWs.emit('message', {
			data: JSON.stringify({
				type: 'event',
				event: 'agent',
				payload: { runId: 'run-throw', stream: 'reasoning', seq: 1, data: {} },
			}),
		});

		for (let i = 0; i < 15; i += 1) await new Promise((r) => setTimeout(r, 0));

		const leaked = unhandled.filter((e) => /boom from c2 sendTo/.test(String(e?.message ?? e)));
		assert.equal(leaked.length, 0, `unhandledRejection leaked: ${leaked.map((e) => e?.message).join(', ')}`);
		assert.equal(broadcasted.length, 0, 'sendTo throw 不应触发兜底广播');
	} finally {
		process.removeListener('unhandledRejection', captureUnhandled);
		for (const l of origListeners) process.on('unhandledRejection', l);
		await bridge.stop();
	}
});

// --- 顶层 try/catch：sendTo 抛错不能让 listener 变 unhandledRejection 击穿 gateway ---

test('gateway ws message handler: broadcast 抛错时 listener 不产生 unhandledRejection', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_bcast_throw');
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
	}
});

test('gateway ws message handler: sendTo 抛错时 listener 不产生 unhandledRejection', async () => {
	const { bridge, gwWs } = await setupBridgeWithGateway('c_throw');
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
	}
});

// --- B-stage1 plan-2: rpc-queues/ 启动期预热 ---

test('bridge.start should create rpc-queues/ dir + set __diskCap to a number via default path', async () => {
	const dir = await writeCfg({ token: 't1', serverUrl: 'http://127.0.0.1:3000' });
	const bridge = createBridge();
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const queueDir = nodePath.join(dir, 'coclaw', 'rpc-queues');
		const st = await fs.stat(queueDir);
		assert.equal(st.isDirectory(), true);
		// 默认路径（不注入 stub）也应把 __diskCap 设为正整数——证明 measure 被真调用
		assert.equal(typeof bridge.__diskCap, 'number');
		assert.ok(bridge.__diskCap > 0);
	} finally {
		await bridge.stop();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('bridge.start should remove pre-existing *.jsonl residuals + preserve non-jsonl files', async () => {
	const dir = await writeCfg({ token: 't1', serverUrl: 'http://127.0.0.1:3000' });
	const bridge = createBridge();
	try {
		const queueDir = nodePath.join(dir, 'coclaw', 'rpc-queues');
		await fs.mkdir(queueDir, { recursive: true });
		await fs.writeFile(nodePath.join(queueDir, 'old.jsonl'), 'x', 'utf8');
		await fs.writeFile(nodePath.join(queueDir, 'keep.txt'), 'preserve', 'utf8');

		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		const remaining = (await fs.readdir(queueDir)).sort();
		assert.deepEqual(remaining, ['keep.txt']);
	} finally {
		await bridge.stop();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('bridge.start should populate __diskCap from injected measure stub', async () => {
	const dir = await writeCfg({ token: 't1', serverUrl: 'http://127.0.0.1:3000' });
	let measureCalls = 0;
	let cleanupCalls = 0;
	const bridge = createBridge({
		measureRpcQueueDiskCap: async () => { measureCalls += 1; return 12345; },
		cleanupRpcQueueResiduals: async () => { cleanupCalls += 1; },
	});
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		assert.equal(bridge.__diskCap, 12345, 'should take stub return value');
		assert.equal(measureCalls, 1, 'measure stub should be called exactly once');
		assert.equal(cleanupCalls, 1, 'cleanup stub should be called exactly once');
	} finally {
		await bridge.stop();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('bridge.start should swallow startup-prep failures (cleanup stub throws)', async () => {
	const dir = await writeCfg({ token: 't1', serverUrl: 'http://127.0.0.1:3000' });
	const warns = [];
	const logger = { warn: (m) => warns.push(String(m)), info() {}, debug() {} };
	// 覆盖 prep try/catch 的 awaited rejection 路径——同 catch 也兜 resolveStateDir() / nodePath.join
	// 同步抛，但本用例直接验证 cleanup/measure 自身 reject 时 bridge.start 不被卡死。
	const bridge = createBridge({
		cleanupRpcQueueResiduals: async () => { throw new Error('boom-prep'); },
	});
	try {
		await bridge.start({ logger, pluginConfig: {} });
		assert.equal(bridge.started, true, 'start should complete despite prep failure');
		assert.equal(bridge.__diskCap, null, '__diskCap should remain null on prep failure');
		assert.ok(
			warns.some((w) => w.includes('rpc-queues startup prep failed')),
			'should warn about startup prep failure',
		);
	} finally {
		await bridge.stop();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('bridge.start should bail out via 10s timeout if rpc-queues prep hangs', async (t) => {
	// fs hang 兜底（NFS / 网络挂载）：cleanup 永不 resolve 时，10s timeout 让 catch 兜底降级
	// 到 MemoryQueue（__queueDir / __diskCap 留 null），bridge 至少能起来。
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const dir = await writeCfg({ token: 't1', serverUrl: 'http://127.0.0.1:3000' });
	const warns = [];
	const logger = { warn: (m) => warns.push(String(m)), info() {}, debug() {} };
	const bridge = createBridge({
		// hang 模拟：永不 resolve（不 reject 也不 resolve）
		cleanupRpcQueueResiduals: () => new Promise(() => {}),
		measureRpcQueueDiskCap: async () => 12345, // 不会被调到（cleanup 卡住）
		// preload 注入 stub 避免 default 路径起 native pion
		preloadPion: async () => null,
	});
	try {
		const startPromise = bridge.start({ logger, pluginConfig: {} });
		// 让 microtask 跑一轮，进 prep 内部 await cleanup
		await new Promise((r) => setImmediate(r));
		// fake timer 推进到 10s 触发 timeout reject
		t.mock.timers.tick(10000);
		await startPromise;
		assert.equal(bridge.__diskCap, null, 'timeout 后 __diskCap 应留 null（自动降级）');
		assert.equal(bridge.__queueDir, null, 'timeout 后 __queueDir 应留 null（自动降级）');
		assert.ok(
			warns.some((w) => w.includes('rpc-queues startup prep failed') && w.includes('timeout')),
			'timeout 应通过 catch warn 一次',
		);
	} finally {
		await bridge.stop();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('bridge.start should skip preload when started=false flips during cleanup/measure', async () => {
	const dir = await writeCfg({ token: 't1', serverUrl: 'http://127.0.0.1:3000' });
	let preloadPionCalled = false;
	const bridge = createBridge({
		preloadPion: async () => { preloadPionCalled = true; return null; },
		// cleanup 异步——在它 await 期间手动设 started=false 模拟 stop()
		cleanupRpcQueueResiduals: async (_d, { logger: lg }) => {
			bridge.started = false; // 模拟 stop 在 cleanup 期间触发
			lg?.info?.('cleanup running');
		},
		measureRpcQueueDiskCap: async () => 999,
	});
	try {
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		// race 守卫应在 measure 之后、preload 之前 return
		assert.equal(preloadPionCalled, false, 'preloadPion should NOT be called after race guard');
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// === defaultResolveGatewayAuthToken ===

test('defaultResolveGatewayAuthToken: config.gateway.auth.token 优先于 env', () => {
	const prevEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
	process.env.OPENCLAW_GATEWAY_TOKEN = '  env-token-1  ';
	setRuntime({
		state: { resolveStateDir: () => '/tmp' },
		config: { loadConfig: () => ({ gateway: { auth: { token: 'rt-token' } } }) },
	});
	try {
		assert.equal(defaultResolveGatewayAuthToken(), 'rt-token');
	} finally {
		if (prevEnv === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
		else process.env.OPENCLAW_GATEWAY_TOKEN = prevEnv;
		setRuntime(null);
	}
});

test('defaultResolveGatewayAuthToken: env-only 场景兜底（cfg 无 token）', () => {
	const prevEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
	process.env.OPENCLAW_GATEWAY_TOKEN = '  env-token-1  ';
	setRuntime({
		state: { resolveStateDir: () => '/tmp' },
		config: { loadConfig: () => ({ gateway: { auth: {} } }) },
	});
	try {
		assert.equal(defaultResolveGatewayAuthToken(), 'env-token-1');
	} finally {
		if (prevEnv === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
		else process.env.OPENCLAW_GATEWAY_TOKEN = prevEnv;
		setRuntime(null);
	}
});

test('defaultResolveGatewayAuthToken: cfg 抛错时回退到 env 兜底', () => {
	const prevEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
	process.env.OPENCLAW_GATEWAY_TOKEN = 'env-fallback';
	const prevWarn = console.warn;
	let warned = false;
	console.warn = () => { warned = true; };
	setRuntime({
		state: { resolveStateDir: () => '/tmp' },
		config: { loadConfig: () => { throw new Error('boom'); } },
	});
	try {
		assert.equal(defaultResolveGatewayAuthToken(), 'env-fallback');
		assert.equal(warned, true, 'should warn on loadConfig throw');
	} finally {
		if (prevEnv === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
		else process.env.OPENCLAW_GATEWAY_TOKEN = prevEnv;
		console.warn = prevWarn;
		setRuntime(null);
	}
});

test('defaultResolveGatewayAuthToken: env 空 + runtime 缺 config.current 与 config.loadConfig 返回空', () => {
	const prevEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
	delete process.env.OPENCLAW_GATEWAY_TOKEN;
	setRuntime({ state: { resolveStateDir: () => '/tmp' } });
	try {
		assert.equal(defaultResolveGatewayAuthToken(), '');
	} finally {
		if (prevEnv !== undefined) process.env.OPENCLAW_GATEWAY_TOKEN = prevEnv;
		setRuntime(null);
	}
});

test('defaultResolveGatewayAuthToken: env 空 + runtime config.loadConfig 返回 token', () => {
	const prevEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
	delete process.env.OPENCLAW_GATEWAY_TOKEN;
	setRuntime({
		state: { resolveStateDir: () => '/tmp' },
		config: { loadConfig: () => ({ gateway: { auth: { token: '  rt-token  ' } } }) },
	});
	try {
		assert.equal(defaultResolveGatewayAuthToken(), 'rt-token');
	} finally {
		if (prevEnv !== undefined) process.env.OPENCLAW_GATEWAY_TOKEN = prevEnv;
		setRuntime(null);
	}
});

test('defaultResolveGatewayAuthToken: runtime config.loadConfig 无 token 返回空', () => {
	const prevEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
	delete process.env.OPENCLAW_GATEWAY_TOKEN;
	setRuntime({
		state: { resolveStateDir: () => '/tmp' },
		config: { loadConfig: () => ({ gateway: { auth: { token: '   ' } } }) },
	});
	try {
		assert.equal(defaultResolveGatewayAuthToken(), '');
	} finally {
		if (prevEnv !== undefined) process.env.OPENCLAW_GATEWAY_TOKEN = prevEnv;
		setRuntime(null);
	}
});

test('defaultResolveGatewayAuthToken: loadConfig 抛错时静默返回空', () => {
	const prevEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
	delete process.env.OPENCLAW_GATEWAY_TOKEN;
	const prevWarn = console.warn;
	let warned = false;
	console.warn = () => { warned = true; };
	setRuntime({
		state: { resolveStateDir: () => '/tmp' },
		config: { loadConfig: () => { throw new Error('boom'); } },
	});
	try {
		assert.equal(defaultResolveGatewayAuthToken(), '');
		assert.equal(warned, true, 'should warn on loadConfig throw');
	} finally {
		if (prevEnv !== undefined) process.env.OPENCLAW_GATEWAY_TOKEN = prevEnv;
		console.warn = prevWarn;
		setRuntime(null);
	}
});

// --- gateway ws close: plugin-initiated vs peer-initiated branches ---

test('gateway ws close: plugin-initiated emits ws.local-close and "by plugin" log', async () => {
	resetRemoteLog();
	const { bridge, server, logs } = await setupBridgeWithGateway('c_close_plugin');
	try {
		// 主动关本地 gateway ws（典型场景：server WS 失效时 plugin 主动收线）
		bridge.__closeGatewayWs();
		await new Promise((r) => setTimeout(r, 0));

		assert.ok(
			logs.some((m) => String(m).includes('gateway ws closed by plugin') && String(m).includes('reason=local-close')),
			'logger should report plugin-initiated close with local-close reason'
		);

		const texts = collectRemoteLogTexts(server);
		assert.ok(
			texts.some((t) => t.startsWith('ws.local-close') && t.includes('peer=gateway') && t.includes('reason=local-close')),
			'remoteLog should be ws.local-close peer=gateway reason=local-close'
		);
		assert.ok(
			!texts.some((t) => t.startsWith('ws.disconnected') && t.includes('peer=gateway')),
			'plugin-initiated close should not emit ws.disconnected'
		);
	} finally {
		await bridge.stop();
		resetRemoteLog();
	}
});

test('gateway ws close: peer-initiated emits ws.disconnected with code/reason and "by peer" log', async () => {
	resetRemoteLog();
	const { bridge, server, gwWs, logs } = await setupBridgeWithGateway('c_close_peer');
	try {
		// 模拟对端关闭：直接 emit close，不走 plugin 主动 close 路径，未设 __closedByPlugin
		gwWs.readyState = 3;
		gwWs.emit('close', { code: 1006, reason: 'abnormal' });
		await new Promise((r) => setTimeout(r, 0));

		assert.ok(
			logs.some((m) => String(m).includes('gateway ws closed by peer') && String(m).includes('code=1006') && String(m).includes('reason=abnormal')),
			'logger should report peer-initiated close with code/reason'
		);

		const texts = collectRemoteLogTexts(server);
		assert.ok(
			texts.some((t) => t.startsWith('ws.disconnected') && t.includes('peer=gateway') && t.includes('code=1006') && t.includes('reason=abnormal')),
			'remoteLog should be ws.disconnected peer=gateway code=1006 reason=abnormal'
		);
		assert.ok(
			!texts.some((t) => t.startsWith('ws.local-close') && t.includes('peer=gateway')),
			'peer-initiated close should not emit ws.local-close'
		);
	} finally {
		await bridge.stop();
		resetRemoteLog();
	}
});

// --- sessions.subscribe / sessions.changed 双源归档 ---

test('__sendSessionsSubscribe ok：写 sessions.subscribe.ok remoteLog', async () => {
	resetRemoteLog();
	const { bridge, server, gwWs, logs } = await setupBridgeWithGateway('c_subs_ok');
	try {
		const pending = bridge.__sendSessionsSubscribe();
		// gateway 端拿到 subscribe 请求
		const subscribeRaw = await waitForSent(gwWs, 'sessions.subscribe');
		const subscribeReq = JSON.parse(String(subscribeRaw));
		assert.equal(subscribeReq.method, 'sessions.subscribe');
		// 回 ok
		gwWs.emit('message', { data: JSON.stringify({ type: 'res', id: subscribeReq.id, ok: true, payload: {} }) });
		await pending;
		assert.ok(logs.some((m) => String(m).includes('sessions.subscribe ok')));
		const texts = collectRemoteLogTexts(server);
		assert.ok(texts.some((t) => t === 'sessions.subscribe.ok'));
	} finally {
		await bridge.stop();
		resetRemoteLog();
	}
});

test('__sendSessionsSubscribe 失败：ok=false 仅 warn + remoteLog.failed（无 sticky）', async () => {
	resetRemoteLog();
	const { bridge, server, gwWs, logs } = await setupBridgeWithGateway('c_subs_fail');
	try {
		const pending = bridge.__sendSessionsSubscribe();
		const subscribeRaw = await waitForSent(gwWs, 'sessions.subscribe');
		const subscribeReq = JSON.parse(String(subscribeRaw));
		gwWs.emit('message', { data: JSON.stringify({ type: 'res', id: subscribeReq.id, ok: false, error: { code: 'INVALID_REQUEST', message: 'transient error' } }) });
		await pending;
		assert.ok(logs.some((m) => String(m).includes('sessions.subscribe failed')));
		const texts = collectRemoteLogTexts(server);
		assert.ok(texts.some((t) => t.startsWith('sessions.subscribe.failed')));
	} finally {
		await bridge.stop();
		resetRemoteLog();
	}
});

test('__sendSessionsSubscribe gateway 中途关闭：settle 时 warn + remoteLog.failed (gateway_closed)', async () => {
	resetRemoteLog();
	const { bridge, server, gwWs, logs } = await setupBridgeWithGateway('c_subs_close');
	try {
		const pending = bridge.__sendSessionsSubscribe();
		await waitForSent(gwWs, 'sessions.subscribe');
		bridge.__closeGatewayWs();
		await pending;
		assert.ok(logs.some((m) => String(m).includes('sessions.subscribe failed') && String(m).includes('gateway_closed')));
		const texts = collectRemoteLogTexts(server);
		assert.ok(texts.some((t) => t.startsWith('sessions.subscribe.failed') && t.includes('gateway_closed')));
	} finally {
		await bridge.stop();
		resetRemoteLog();
	}
});

test('sessions.subscribe 失败后再次调用仍重发（无 sticky 阻止）', async () => {
	resetRemoteLog();
	const { bridge, gwWs } = await setupBridgeWithGateway('c_subs_fail_then_retry');
	try {
		// 第一次：模拟失败响应
		const first = bridge.__sendSessionsSubscribe();
		const firstRaw = await waitForSent(gwWs, 'sessions.subscribe');
		const firstReq = JSON.parse(String(firstRaw));
		gwWs.emit('message', { data: JSON.stringify({ type: 'res', id: firstReq.id, ok: false, error: { code: 'TRANSIENT', message: 'transient' } }) });
		await first;
		const countAfterFirst = gwWs.sent.filter((s) => String(s).includes('sessions.subscribe')).length;
		assert.equal(countAfterFirst, 1, '第一次调用发 1 次 subscribe');

		// 第二次：模拟下次握手再调，应当真的发出（不被 sticky 阻止），且成功
		const second = bridge.__sendSessionsSubscribe();
		await waitFor(
			() => gwWs.sent.filter((s) => String(s).includes('sessions.subscribe')).length >= 2,
			{ label: 'second sessions.subscribe sent after prior failure' },
		);
		const secondRaw = gwWs.sent.filter((s) => String(s).includes('sessions.subscribe')).pop();
		const secondReq = JSON.parse(String(secondRaw));
		gwWs.emit('message', { data: JSON.stringify({ type: 'res', id: secondReq.id, ok: true, payload: { subscribed: true } }) });
		await second;
		const countAfterSecond = gwWs.sent.filter((s) => String(s).includes('sessions.subscribe')).length;
		assert.equal(countAfterSecond, 2, '失败后再次调用应再发 1 次 subscribe');
	} finally {
		await bridge.stop();
		resetRemoteLog();
	}
});

test('每次握手成功（含重连）都重新发出 sessions.subscribe', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
		gateway.emit('open', {});

		// --- 第一次握手 ---
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq1 = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq1.id, ok: true, payload: {} }) });
		await waitFor(
			() => gateway.sent.some((s) => String(s).includes('sessions.subscribe')),
			{ label: 'first sessions.subscribe sent' },
		);
		const firstCount = gateway.sent.filter((s) => String(s).includes('sessions.subscribe')).length;
		assert.equal(firstCount, 1, '首次握手应发出 1 次 subscribe');

		// --- 模拟重连：再来一次 challenge + connect.res ---
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n2' } }) });
		const connectReq2 = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq2.id, ok: true, payload: {} }) });
		await waitFor(
			() => gateway.sent.filter((s) => String(s).includes('sessions.subscribe')).length >= 2,
			{ label: 'second sessions.subscribe sent after re-handshake' },
		);
		const secondCount = gateway.sent.filter((s) => String(s).includes('sessions.subscribe')).length;
		assert.ok(secondCount >= 2, '重连握手后应再次发出 subscribe');
	} finally {
		await bridge.stop();
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
	}
});

test('handshake 成功后自动发出 sessions.subscribe', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
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
		gateway.emit('open', {});
		gateway.emit('message', { data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }) });
		const connectReq = JSON.parse(String(gateway.sent[gateway.sent.length - 1] ?? '{}'));
		gateway.emit('message', { data: JSON.stringify({ type: 'res', id: connectReq.id, ok: true, payload: {} }) });

		// 等到握手成功 + 后续 RPC 都发出
		await waitFor(
			() => gateway.sent.some((s) => String(s).includes('sessions.subscribe')),
			{ label: 'sessions.subscribe sent after handshake' },
		);
		const subRaw = gateway.sent.find((s) => String(s).includes('sessions.subscribe'));
		const subMsg = JSON.parse(String(subRaw));
		assert.equal(subMsg.method, 'sessions.subscribe');
	} finally {
		await bridge.stop();
		if (oldGw === undefined) delete process.env.COCLAW_GATEWAY_WS_URL;
		else process.env.COCLAW_GATEWAY_WS_URL = oldGw;
		process.chdir(prevCwd);
	}
});

test('sessions.changed reason=create：调用 onSessionCreated 回调且不 broadcast', async () => {
	const calls = [];
	const broadcastCalls = [];
	const onSessionCreated = ({ sessionKey, sessionId }) => {
		calls.push({ sessionKey, sessionId });
	};
	const { bridge, gwWs } = await setupBridgeWithGateway('c_chg_create');
	try {
		bridge.__onSessionCreated = onSessionCreated;
		bridge.webrtcPeer.broadcast = (p) => broadcastCalls.push(p);
		gwWs.emit('message', {
			data: JSON.stringify({
				type: 'event',
				event: 'sessions.changed',
				payload: { reason: 'create', sessionKey: 'agent:main:main', sessionId: 'new-sid-1' },
			}),
		});
		await waitFor(() => calls.length === 1, { label: 'onSessionCreated invoked' });
		assert.equal(calls[0].sessionKey, 'agent:main:main');
		assert.equal(calls[0].sessionId, 'new-sid-1');
		// drain microtasks / event-loop ticks 确认 broadcast 没被调（M2: reason=create 调完回调直接 return）
		// 用 setTimeout(0) 5 轮匹配本文件其它 drain 处的惯例；优于固定 setTimeout(10) 在 CI 慢机上误漏报
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		assert.equal(broadcastCalls.length, 0, 'reason=create 不应 broadcast 到 UI');
	} finally {
		await bridge.stop();
	}
});

test('sessions.changed phase=message：不调回调也不 broadcast（cron_changed hook 是主通道，phase=message 不再兜底）', async () => {
	const calls = [];
	const broadcastCalls = [];
	const { bridge, gwWs } = await setupBridgeWithGateway('c_chg_phase_msg');
	try {
		bridge.__onSessionCreated = ({ sessionKey, sessionId }) => {
			calls.push({ sessionKey, sessionId });
		};
		bridge.webrtcPeer.broadcast = (p) => broadcastCalls.push(p);
		gwWs.emit('message', {
			data: JSON.stringify({
				type: 'event',
				event: 'sessions.changed',
				payload: { phase: 'message', sessionKey: 'agent:main:main', sessionId: 'cron-sid-1' },
			}),
		});
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		assert.equal(calls.length, 0, 'phase=message 不应触发 onSessionCreated 回调');
		assert.equal(broadcastCalls.length, 0, 'phase=message 不应 broadcast 到 UI');
	} finally {
		await bridge.stop();
	}
});

test('sessions.changed reason!=create：不调回调也不 broadcast（M2 过滤名单 drop）', async () => {
	const calls = [];
	const broadcastCalls = [];
	const { bridge, gwWs } = await setupBridgeWithGateway('c_chg_other');
	try {
		bridge.__onSessionCreated = (p) => calls.push(p);
		bridge.webrtcPeer.broadcast = (p) => broadcastCalls.push(p);
		for (const reason of ['new', 'reset', 'send', 'delete', 'update', 'message', 'lifecycle']) {
			gwWs.emit('message', {
				data: JSON.stringify({
					type: 'event',
					event: 'sessions.changed',
					payload: { reason, sessionKey: 'agent:main:main', sessionId: 'x' },
				}),
			});
		}
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		assert.equal(calls.length, 0, '非 create reason 不触发回调');
		assert.equal(broadcastCalls.length, 0, 'M2: sessions.changed 在过滤名单中，任何 reason 都不应 broadcast');
	} finally {
		await bridge.stop();
	}
});

test('session.message event 进入过滤名单：不触发回调也不 broadcast（M2）', async () => {
	const broadcastCalls = [];
	const { bridge, gwWs } = await setupBridgeWithGateway('c_chg_session_msg');
	try {
		bridge.webrtcPeer.broadcast = (p) => broadcastCalls.push(p);
		gwWs.emit('message', {
			data: JSON.stringify({
				type: 'event',
				event: 'session.message',
				payload: { sessionKey: 'agent:main:main', message: { role: 'user', content: 'hi' } },
			}),
		});
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		assert.equal(broadcastCalls.length, 0, 'M2: session.message 应被过滤名单 drop');
	} finally {
		await bridge.stop();
	}
});

test('sessions.changed 缺 sessionKey 或 sessionId：不调用回调也不 broadcast', async () => {
	const calls = [];
	const broadcastCalls = [];
	const { bridge, gwWs } = await setupBridgeWithGateway('c_chg_missing');
	try {
		bridge.__onSessionCreated = (p) => calls.push(p);
		bridge.webrtcPeer.broadcast = (p) => broadcastCalls.push(p);
		gwWs.emit('message', {
			data: JSON.stringify({
				type: 'event',
				event: 'sessions.changed',
				payload: { reason: 'create', sessionId: 'no-key' },
			}),
		});
		gwWs.emit('message', {
			data: JSON.stringify({
				type: 'event',
				event: 'sessions.changed',
				payload: { reason: 'create', sessionKey: 'agent:main:main' },
			}),
		});
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		assert.equal(calls.length, 0, '缺字段时不触发回调');
		assert.equal(broadcastCalls.length, 0, '缺字段的 reason=create 也走 return，不 broadcast');
	} finally {
		await bridge.stop();
	}
});

test('sessions.changed 回调抛错：bridge 不崩，warn 兜底', async () => {
	const logs = [];
	const { bridge, gwWs } = await setupBridgeWithGateway('c_chg_err');
	try {
		bridge.logger = { info() {}, warn: (m) => logs.push(m), debug() {} };
		bridge.__onSessionCreated = () => { throw new Error('callback boom'); };
		bridge.webrtcPeer.broadcast = () => {};
		gwWs.emit('message', {
			data: JSON.stringify({
				type: 'event',
				event: 'sessions.changed',
				payload: { reason: 'create', sessionKey: 'agent:main:main', sessionId: 'x' },
			}),
		});
		await waitFor(
			() => logs.some((m) => String(m).includes('sessions.changed handler error') && String(m).includes('callback boom')),
			{ label: 'callback error warned' },
		);
	} finally {
		await bridge.stop();
	}
});

test('sessions.changed 回调 async reject：bridge 不崩，warn 兜底', async () => {
	const logs = [];
	const { bridge, gwWs } = await setupBridgeWithGateway('c_chg_async_rej');
	try {
		bridge.logger = { info() {}, warn: (m) => logs.push(m), debug() {} };
		bridge.__onSessionCreated = () => Promise.reject(new Error('async boom'));
		bridge.webrtcPeer.broadcast = () => {};
		gwWs.emit('message', {
			data: JSON.stringify({
				type: 'event',
				event: 'sessions.changed',
				payload: { reason: 'create', sessionKey: 'agent:main:main', sessionId: 'x' },
			}),
		});
		await waitFor(
			() => logs.some((m) => String(m).includes('sessions.changed handler error') && String(m).includes('async boom')),
			{ label: 'async reject warned' },
		);
	} finally {
		await bridge.stop();
	}
});

test('onSessionCreated 通过构造器注入；stop/refresh 不动该字段', async () => {
	FakeWebSocket.instances.length = 0;
	const prevCwd = process.cwd();
	const dir = await writeCfg({ token: 't1', serverUrl: 'https://server.local' });
	process.chdir(dir);

	const calls = [];
	const onSessionCreated = (p) => calls.push(p);
	const bridge = createBridge({ onSessionCreated });
	try {
		assert.equal(bridge.__onSessionCreated, onSessionCreated, '构造器应直接 set callback');
		await bridge.start({ logger: noopLogger(), pluginConfig: {} });
		assert.equal(bridge.__onSessionCreated, onSessionCreated, 'start 不动 callback');
		await bridge.stop();
		assert.equal(bridge.__onSessionCreated, onSessionCreated, 'stop 后 callback 仍在（不重建实例就一直在）');
	} finally {
		// bridge 已在 try 内 stop；这里只复位环境
		process.chdir(prevCwd);
	}
});

test('未注入 onSessionCreated 时 __onSessionCreated 为 null', () => {
	const bridge = createBridge();
	assert.equal(bridge.__onSessionCreated, null, '默认应为 null（无回调路径）');
});

test('restartRealtimeBridge 把 opts.onSessionCreated 透传到新 singleton', async () => {
	await writeCfg({ token: '' });
	const logger = noopLogger();
	const cb = () => {};
	try {
		await restartRealtimeBridge({
			logger,
			pluginConfig: { serverUrl: 'http://127.0.0.1:1' },
			onSessionCreated: cb,
			__deps: { resolveGatewayAuthToken: () => 'tkn' },
		});
		assert.equal(__getSingletonForTest()?.__onSessionCreated, cb, 'singleton 应携带 opts.onSessionCreated');
		// 第二次 restart 是新实例，cb 必须重新传入才在
		await restartRealtimeBridge({
			logger,
			pluginConfig: { serverUrl: 'http://127.0.0.1:1' },
			__deps: { resolveGatewayAuthToken: () => 'tkn' },
		});
		assert.equal(__getSingletonForTest()?.__onSessionCreated, null, '第二次未传 onSessionCreated，新 singleton 应为 null');
	} finally {
		await stopRealtimeBridge();
	}
});

test('端到端 wiring：restartRealtimeBridge 装配的 cb 真收到 sessions.changed reason=create payload', async () => {
	// 这条用例补 R-C MUST-FIX 2：原本的两条 wiring 测试一条只断引用相等（cb 是空函数）、
	// 另一条用 `bridge.__onSessionCreated = xxx` 直接赋值绕过 wiring。没有一条用例真正
	// 走过"完整生产装配 → 收到 sessions.changed → cb 拿到 payload"链路。
	FakeWebSocket.instances.length = 0;
	await writeCfg({ token: 'wire-tok', serverUrl: 'https://server.local' });
	const calls = [];
	const cb = (p) => calls.push(p);
	try {
		await restartRealtimeBridge({
			logger: noopLogger(),
			pluginConfig: {},
			onSessionCreated: cb,
			__deps: {
				WebSocket: FakeWebSocket,
				resolveGatewayAuthToken: () => 'wire-tok',
				preloadPion: mockPreloadPion,
				gatewayReadyTimeoutMs: 50,
			},
		});
		const bridge = __getSingletonForTest();
		assert.ok(bridge, 'singleton 应已创建');
		// server WS handshake
		const server = FakeWebSocket.instances[0];
		server.readyState = 1;
		server.emit('open', {});
		// rtc:offer 触发 webrtcPeer + gatewayWs 创建（与 setupBridgeWithGateway 同形态）
		server.emit('message', {
			data: JSON.stringify({
				type: 'rtc:offer',
				fromConnId: 'c_wire_e2e',
				payload: { sdp: 'sdp' },
			}),
		});
		await waitFor(() => bridge.webrtcPeer !== null, { label: 'webrtcPeer created' });
		const gwWs = FakeWebSocket.instances.find((ws) => ws !== server);
		gwWs.readyState = 1;
		bridge.gatewayReady = true;
		bridge.gatewayWs = gwWs;
		// 触发 sessions.changed reason=create
		gwWs.emit('message', {
			data: JSON.stringify({
				type: 'event',
				event: 'sessions.changed',
				payload: { reason: 'create', sessionKey: 'agent:main:main', sessionId: 'wire-sid-99' },
			}),
		});
		await waitFor(() => calls.length === 1, { label: 'wiring cb invoked end-to-end' });
		assert.equal(calls[0].sessionKey, 'agent:main:main');
		assert.equal(calls[0].sessionId, 'wire-sid-99');
	} finally {
		await stopRealtimeBridge();
	}
});

/** waitForSent：等到 gw.sent 出现含指定子串的帧，返回原始字符串。 */
async function waitForSent(ws, needle, opts = {}) {
	await waitFor(
		() => ws.sent.some((s) => String(s).includes(needle)),
		{ ...opts, label: opts.label ?? `gateway sent ${needle}` },
	);
	return ws.sent.find((s) => String(s).includes(needle));
}
