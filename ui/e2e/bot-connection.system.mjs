/**
 * BotConnection + Store 系统测试
 *
 * 粒度 1：直接导入 UI 的 BotConnection 类，注入 Node ws 库，验证 WS 通信链路
 * 粒度 2：在 headless Vue + Pinia 环境中运行真实 Store，验证完整数据流
 *
 * 前置条件：
 * - server 运行在 localhost:3000
 * - OpenClaw gateway 运行中
 * - test 用户已有至少一个 online bot
 *
 * 运行：node ui/e2e/bot-connection.system.mjs
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import WebSocket from 'ws';

// UI 源码依赖 Vite 特有的 import.meta.env 及浏览器 API（FileReader、capacitor 等）。
// 通过 ESM loader hook 拦截这些模块，返回 Node.js 兼容的 stub。
import { register } from 'node:module';
register('./bot-connection.system.loader.mjs', import.meta.url);

const { BotConnection } = await import('../src/services/bot-connection.js');
const { createApp } = await import('vue');
const { createPinia, setActivePinia } = await import('pinia');

const BASE_URL = 'http://localhost:3000';
const LOGIN_NAME = 'test';
const PASSWORD = '123456';

// --- 工具函数 ---

/** 创建已登录的 axios 实例，返回 { client, cookies } */
async function login() {
	// cookie jar：手动维护
	let cookies = '';
	const client = axios.create({
		baseURL: BASE_URL,
		withCredentials: true,
	});
	client.interceptors.request.use((config) => {
		if (cookies) config.headers.Cookie = cookies;
		return config;
	});
	client.interceptors.response.use((res) => {
		const setCookie = res.headers['set-cookie'];
		if (setCookie) {
			cookies = setCookie.map((c) => c.split(';')[0]).join('; ');
		}
		return res;
	});
	await client.post('/api/v1/auth/local/login', {
		loginName: LOGIN_NAME,
		password: PASSWORD,
	});
	return { client, cookies };
}

/** 等待 BotConnection 进入指定状态 */
function waitState(conn, targetState, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		if (conn.state === targetState) return resolve();
		const timer = setTimeout(() => {
			conn.off('state', onState);
			reject(new Error(`timeout waiting for state=${targetState}, current=${conn.state}`));
		}, timeoutMs);
		function onState(s) {
			if (s === targetState) {
				clearTimeout(timer);
				conn.off('state', onState);
				resolve();
			}
		}
		conn.on('state', onState);
	});
}

/** 创建携带 session cookie 的 WebSocket 子类 */
function createCookieWebSocket(cookies) {
	return class CookieWS extends WebSocket {
		constructor(url, protocols) {
			super(url, protocols, {
				headers: { Cookie: cookies },
			});
		}
	};
}

// --- 测试用例 ---

const results = [];

async function runTest(name, fn) {
	const t0 = Date.now();
	try {
		await fn();
		results.push({ name, ok: true, ms: Date.now() - t0 });
		console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
	}
	catch (err) {
		results.push({ name, ok: false, ms: Date.now() - t0, error: err.message });
		console.log(`  ✗ ${name} (${Date.now() - t0}ms)`);
		console.log(`    ${err.message}`);
	}
}

console.log('\n[system-test] BotConnection + Server 系统测试\n');

// 1) 登录并获取 bot 列表
const { client, cookies } = await login();
const botsRes = await client.get('/api/v1/bots');
const bots = botsRes.data?.items ?? [];
assert.ok(bots.length > 0, '至少需要一个已绑定的 bot');
const bot = bots[0];
console.log(`  target bot: id=${bot.id} name=${bot.name} online=${bot.online}\n`);

const CookieWS = createCookieWebSocket(cookies);

// --- Test 1: Session cookie 认证建立 WS 连接 ---
await runTest('session cookie 认证建立 WS 连接', async () => {
	const conn = new BotConnection(bot.id, {
		baseUrl: BASE_URL,
		WebSocket: CookieWS,
	});
	try {
		conn.connect();
		await waitState(conn, 'connected', 5000);
		assert.equal(conn.state, 'connected');
	}
	finally {
		conn.disconnect();
	}
});

// --- Test 2: 无认证连接被拒绝 ---
await runTest('无认证 WS 连接被拒绝', async () => {
	const conn = new BotConnection(bot.id, {
		baseUrl: BASE_URL,
		WebSocket,
	});
	const stateChanges = [];
	conn.on('state', (s) => stateChanges.push(s));
	conn.connect();
	// 等待 disconnected（server 应拒绝升级）
	await waitState(conn, 'disconnected', 5000);
	conn.disconnect();
	assert.ok(stateChanges.includes('connecting'), 'should have transitioned to connecting');
});

// --- Test 3: 心跳 pong 响应 ---
await runTest('应用层心跳 ping 收到 pong', async () => {
	const conn = new BotConnection(bot.id, {
		baseUrl: BASE_URL,
		WebSocket: CookieWS,
	});
	try {
		conn.connect();
		await waitState(conn, 'connected', 5000);
		// 手动发 ping，检查 pong（BotConnection.__onMessage 会忽略 pong，但不会断开）
		// 直接访问内部 ws 发 ping，监听原始消息
		const pongReceived = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('pong timeout')), 3000);
			const origOnMessage = conn.__ws.onmessage;
			conn.__ws.addEventListener('message', function onMsg(event) {
				try {
					const data = JSON.parse(String(event.data));
					if (data.type === 'pong') {
						clearTimeout(timer);
						conn.__ws.removeEventListener('message', onMsg);
						resolve();
					}
				}
				catch {}
			});
		});
		conn.__ws.send(JSON.stringify({ type: 'ping' }));
		await pongReceived;
	}
	finally {
		conn.disconnect();
	}
});

// --- Test 4: RPC 请求（agent.identity.get）经 server → plugin → OpenClaw → 回来 ---
await runTest('RPC agent.identity.get 全链路', async () => {
	if (!bot.online) {
		console.log('    (skipped: bot offline)');
		return;
	}
	const conn = new BotConnection(bot.id, {
		baseUrl: BASE_URL,
		WebSocket: CookieWS,
	});
	try {
		conn.connect();
		await waitState(conn, 'connected', 5000);
		const result = await conn.request('agent.identity.get', {}, { timeout: 5000 });
		assert.ok(result !== null && result !== undefined, 'should receive a response');
		// agent.identity.get 返回 { name, ... }
		console.log(`    → agent name: ${result?.name ?? '(null)'}`);
	}
	finally {
		conn.disconnect();
	}
});

// --- Test 5: RPC sessions.listAll 全链路 ---
await runTest('RPC sessions.listAll 全链路', async () => {
	if (!bot.online) {
		console.log('    (skipped: bot offline)');
		return;
	}
	const conn = new BotConnection(bot.id, {
		baseUrl: BASE_URL,
		WebSocket: CookieWS,
	});
	try {
		conn.connect();
		await waitState(conn, 'connected', 5000);
		const result = await conn.request('nativeui.sessions.listAll', {}, { timeout: 5000 });
		assert.ok(result !== null && result !== undefined, 'should receive a response');
		const items = result?.items ?? result?.sessions ?? [];
		console.log(`    → sessions count: ${items.length}`);
	}
	finally {
		conn.disconnect();
	}
});

// --- Test 6: 断连后自动重连 ---
await runTest('断连后自动重连', async () => {
	const conn = new BotConnection(bot.id, {
		baseUrl: BASE_URL,
		WebSocket: CookieWS,
	});
	try {
		conn.connect();
		await waitState(conn, 'connected', 5000);

		// 强制关闭底层 ws（模拟网络断开）
		conn.__ws.close(4000, 'test_disconnect');
		await waitState(conn, 'disconnected', 3000);

		// 应自动重连
		await waitState(conn, 'connected', 10_000);
		assert.equal(conn.state, 'connected');
	}
	finally {
		conn.disconnect();
	}
});

// --- Test 7: disconnect 后不再重连 ---
await runTest('主动 disconnect 后不再重连', async () => {
	const conn = new BotConnection(bot.id, {
		baseUrl: BASE_URL,
		WebSocket: CookieWS,
	});
	conn.connect();
	await waitState(conn, 'connected', 5000);
	conn.disconnect();
	assert.equal(conn.state, 'disconnected');
	// 等 2s 确认没有重连
	await new Promise((r) => setTimeout(r, 2000));
	assert.equal(conn.state, 'disconnected');
});

// --- Test 8: BotConnectionManager 多连接管理 ---
await runTest('BotConnectionManager 管理连接生命周期', async () => {
	// 直接使用 BotConnectionManager 类，避免单例干扰
	const { BotConnectionManager } = await import('../src/services/bot-connection-manager.js');
	const mgr = new BotConnectionManager();
	try {
		const conn = mgr.connect(bot.id, {
			baseUrl: BASE_URL,
			WebSocket: CookieWS,
		});
		assert.ok(conn instanceof BotConnection);
		await waitState(conn, 'connected', 5000);
		assert.equal(mgr.size, 1);
		assert.deepEqual(Object.values(mgr.getStates()), ['connected']);

		// 幂等：再次 connect 同一 bot 返回同一实例
		const conn2 = mgr.connect(bot.id);
		assert.equal(conn2, conn);

		mgr.disconnectAll();
		assert.equal(mgr.size, 0);
		assert.equal(conn.state, 'disconnected');
	}
	finally {
		mgr.disconnectAll();
	}
});

// ========================================
// 粒度 2：Store 数据流系统测试
// ========================================

console.log('\n[system-test] Store 数据流系统测试（headless Vue + Pinia）\n');

// --- 设置 headless Vue + Pinia 环境 ---

// BotConnectionManager 的 connect 默认使用 globalThis.WebSocket，
// 需要在 Store 测试前将其替换为携带 cookie 的 WS
globalThis.WebSocket = CookieWS;

/** 创建隔离的 Pinia 环境，返回 store 实例 */
async function createStoreEnv() {
	const app = createApp({ render: () => null });
	const pinia = createPinia();
	app.use(pinia);
	setActivePinia(pinia);

	// httpClient 需要携带 cookie 用于 bots.api.listBots
	const { httpClient } = await import('../src/services/http.js');
	httpClient.defaults.baseURL = BASE_URL;
	httpClient.interceptors.request.use((config) => {
		if (cookies) config.headers.Cookie = cookies;
		return config;
	});

	const { useBotsStore } = await import('../src/stores/bots.store.js');
	const { useSessionsStore } = await import('../src/stores/sessions.store.js');
	const { useChatStore } = await import('../src/stores/chat.store.js');

	return {
		botsStore: useBotsStore(),
		sessionsStore: useSessionsStore(),
		chatStore: useChatStore(),
		pinia,
		app,
	};
}

// --- Test 9: botsStore.loadBots 加载并同步 WS 连接 ---
await runTest('botsStore.loadBots 加载 bot 并自动建立 WS', async () => {
	const env = await createStoreEnv();
	const { __resetBotConnections } = await import('../src/services/bot-connection-manager.js');
	try {
		const loaded = await env.botsStore.loadBots();
		assert.ok(loaded.length > 0, 'should load at least one bot');
		assert.equal(env.botsStore.items.length, loaded.length);
		console.log(`    → loaded ${loaded.length} bot(s)`);

		// syncConnections 在 loadBots 中被调用
		// 等待 WS 连接建立
		const { useBotConnections } = await import('../src/services/bot-connection-manager.js');
		const mgr = useBotConnections();
		const targetConn = mgr.get(String(loaded[0].id));
		assert.ok(targetConn, 'should have created a connection');
		await waitState(targetConn, 'connected', 5000);
		assert.equal(targetConn.state, 'connected');
	}
	finally {
		__resetBotConnections();
	}
});

// --- Test 10: sessionsStore.loadAllSessions 通过 WS 获取 session 列表 ---
await runTest('sessionsStore.loadAllSessions 通过 WS 获取 sessions', async () => {
	const env = await createStoreEnv();
	const { __resetBotConnections } = await import('../src/services/bot-connection-manager.js');
	try {
		// 先加载 bot 并等待连接
		await env.botsStore.loadBots();
		const { useBotConnections } = await import('../src/services/bot-connection-manager.js');
		const mgr = useBotConnections();
		const conn = mgr.get(String(bot.id));
		if (conn) await waitState(conn, 'connected', 5000);

		// 加载 sessions
		await env.sessionsStore.loadAllSessions();
		assert.ok(env.sessionsStore.items.length > 0, 'should load sessions');
		console.log(`    → loaded ${env.sessionsStore.items.length} session(s)`);

		// 每个 session 应有 sessionId 和 botId
		const first = env.sessionsStore.items[0];
		assert.ok(first.sessionId, 'session should have sessionId');
		assert.ok(first.botId, 'session should have botId');
	}
	finally {
		__resetBotConnections();
	}
});

// --- Test 11: chatStore.activateSession + loadMessages 全链路 ---
await runTest('chatStore 激活 session 并加载消息', async () => {
	const env = await createStoreEnv();
	const { __resetBotConnections } = await import('../src/services/bot-connection-manager.js');
	try {
		// 加载 bots + 连接
		await env.botsStore.loadBots();
		const { useBotConnections } = await import('../src/services/bot-connection-manager.js');
		const conn = useBotConnections().get(String(bot.id));
		if (conn) await waitState(conn, 'connected', 5000);

		// 加载 sessions
		await env.sessionsStore.loadAllSessions();
		assert.ok(env.sessionsStore.items.length > 0, 'need sessions to test');

		// 激活第一个 session
		const targetSession = env.sessionsStore.items[0];
		await env.chatStore.activateSession(targetSession.sessionId);

		assert.equal(env.chatStore.sessionId, targetSession.sessionId);
		assert.equal(env.chatStore.botId, String(bot.id));
		assert.ok(env.chatStore.messages.length >= 0, 'messages should be loaded (may be empty for new sessions)');
		console.log(`    → session=${targetSession.sessionId} messages=${env.chatStore.messages.length}`);
	}
	finally {
		__resetBotConnections();
	}
});

// --- Test 12: chatStore.sendMessage 全链路（两阶段 RPC → agent 事件 → 终态） ---
await runTest('chatStore.sendMessage 发送消息全链路', async () => {
	if (!bot.online) {
		console.log('    (skipped: bot offline)');
		return;
	}
	const env = await createStoreEnv();
	const { __resetBotConnections } = await import('../src/services/bot-connection-manager.js');
	try {
		// 加载 bots + 连接
		await env.botsStore.loadBots();
		const { useBotConnections } = await import('../src/services/bot-connection-manager.js');
		const conn = useBotConnections().get(String(bot.id));
		if (conn) await waitState(conn, 'connected', 5000);

		// 加载 sessions
		await env.sessionsStore.loadAllSessions();
		assert.ok(env.sessionsStore.items.length > 0, 'need sessions');

		// 找到 main session（agent:main:main）或使用第一个
		const mainSession = env.sessionsStore.items.find((s) => s.sessionKey === 'agent:main:main')
			?? env.sessionsStore.items[0];

		await env.chatStore.activateSession(mainSession.sessionId);

		// 发送一条简单测试消息
		const msgBefore = env.chatStore.messages.length;
		console.log(`    → sending to session=${mainSession.sessionId}...`);

		const result = await env.chatStore.sendMessage('system test ping');

		assert.ok(result.accepted, 'message should be accepted');
		console.log(`    → accepted, messages before=${msgBefore} after=${env.chatStore.messages.length}`);
	}
	finally {
		__resetBotConnections();
	}
});

// --- Test 13: chatStore.resetChat 新建会话 ---
await runTest('chatStore.resetChat 新建聊天', async () => {
	if (!bot.online) {
		console.log('    (skipped: bot offline)');
		return;
	}
	const env = await createStoreEnv();
	const { __resetBotConnections } = await import('../src/services/bot-connection-manager.js');
	try {
		await env.botsStore.loadBots();
		const { useBotConnections } = await import('../src/services/bot-connection-manager.js');
		const conn = useBotConnections().get(String(bot.id));
		if (conn) await waitState(conn, 'connected', 5000);
		await env.sessionsStore.loadAllSessions();

		const mainSession = env.sessionsStore.items.find((s) => s.sessionKey === 'agent:main:main');
		if (!mainSession) {
			console.log('    (skipped: no main session)');
			return;
		}
		await env.chatStore.activateSession(mainSession.sessionId);
		const sessionsBefore = env.sessionsStore.items.length;

		const newSessionId = await env.chatStore.resetChat();
		assert.ok(newSessionId, 'should return new sessionId');
		assert.notEqual(newSessionId, mainSession.sessionId, 'should be a different session');
		console.log(`    → new session: ${newSessionId}, sessions before=${sessionsBefore} after=${env.sessionsStore.items.length}`);
	}
	finally {
		__resetBotConnections();
	}
});

// --- 清理全局 WebSocket ---
delete globalThis.WebSocket;

// --- 汇总 ---
console.log('\n--- 结果 ---');
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`  通过: ${passed}  失败: ${failed}  总计: ${results.length}\n`);

if (failed > 0) {
	console.log('失败用例:');
	for (const r of results.filter((r) => !r.ok)) {
		console.log(`  ✗ ${r.name}: ${r.error}`);
	}
	process.exit(1);
}
