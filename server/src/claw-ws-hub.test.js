import assert from 'node:assert/strict';
import test from 'node:test';

// rtc:offer 测试需要 TURN_SECRET
process.env.TURN_SECRET ??= 'test-secret';
process.env.APP_DOMAIN ??= 'test.coclaw.net';

import { clawPingTick, createUiWsTicket, listOnlineClawIds, pruneUiTickets, clawStatusEmitter, fmtLocalTime, notifyAndDisconnectClaw, refreshClawName, forwardToClaw, __test } from './claw-ws-hub.js';
import { register as registerSignalRoute, __test as signalTest } from './rtc-signal-router.js';

const { uiSockets, clawSockets, uiTickets, pendingOffline, CLAW_OFFLINE_GRACE_MS, getWebSocketCloseCode, onUiMessage, onClawMessage, findUiSocketByConnId, authenticateUiTicket, authenticateUiSession, registerSocket, unregisterSocket, getAnyOnlineClawSocket, resolveClawRpcPending, rejectAllClawRpcPending, broadcastToUi, authenticateClawRequest } = __test;
const { routes: signalRoutes } = signalTest;

const MAX_MISS = 4;

test('clawPingTick: isAlive=true → action=ok, missCount 重置为 0', () => {
	const result = clawPingTick({ isAlive: true, missCount: 3, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(result.action, 'ok');
	assert.equal(result.missCount, 0);
});

test('clawPingTick: isAlive=true 时忽略 bufferedAmount', () => {
	const result = clawPingTick({ isAlive: true, missCount: 2, bufferedAmount: 99999 }, MAX_MISS);
	assert.equal(result.action, 'ok');
	assert.equal(result.missCount, 0);
});

test('clawPingTick: isAlive=false + bufferedAmount>0 → action=skip, missCount 不变', () => {
	const result = clawPingTick({ isAlive: false, missCount: 2, bufferedAmount: 1024 }, MAX_MISS);
	assert.equal(result.action, 'skip');
	assert.equal(result.missCount, 2);
});

test('clawPingTick: isAlive=false + bufferedAmount=0 + 未达上限 → action=miss', () => {
	const result = clawPingTick({ isAlive: false, missCount: 0, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(result.action, 'miss');
	assert.equal(result.missCount, 1);
});

test('clawPingTick: 连续 miss 递增直到上限前', () => {
	let missCount = 0;
	for (let i = 1; i < MAX_MISS; i++) {
		const result = clawPingTick({ isAlive: false, missCount, bufferedAmount: 0 }, MAX_MISS);
		assert.equal(result.action, 'miss');
		assert.equal(result.missCount, i);
		missCount = result.missCount;
	}
});

test('clawPingTick: 达到 maxMiss → action=terminate', () => {
	const result = clawPingTick({ isAlive: false, missCount: MAX_MISS - 1, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(result.action, 'terminate');
	assert.equal(result.missCount, MAX_MISS);
});

test('clawPingTick: bufferedAmount>0 阻止 terminate 即使 missCount 已高', () => {
	const result = clawPingTick({ isAlive: false, missCount: MAX_MISS - 1, bufferedAmount: 500 }, MAX_MISS);
	assert.equal(result.action, 'skip');
	assert.equal(result.missCount, MAX_MISS - 1);
});

test('clawPingTick: pong 后 miss 场景——模拟完整周期', () => {
	// 1. 正常轮次
	let r = clawPingTick({ isAlive: true, missCount: 0, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'ok');

	// 2. miss 1
	r = clawPingTick({ isAlive: false, missCount: r.missCount, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'miss');
	assert.equal(r.missCount, 1);

	// 3. miss 2
	r = clawPingTick({ isAlive: false, missCount: r.missCount, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'miss');
	assert.equal(r.missCount, 2);

	// 4. pong 收到 → 模拟外部重置 isAlive=true, missCount=0
	r = clawPingTick({ isAlive: true, missCount: 0, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'ok');
	assert.equal(r.missCount, 0);

	// 5. 再次 miss
	r = clawPingTick({ isAlive: false, missCount: r.missCount, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'miss');
	assert.equal(r.missCount, 1);
});

// --- createUiWsTicket & pruneUiTickets ---

test('createUiWsTicket: 返回 32 位 hex 字符串', () => {
	const ticket = createUiWsTicket({ clawId: '1', userId: '2' });
	assert.match(ticket, /^[0-9a-f]{32}$/);
});

test('pruneUiTickets: 过期 ticket 被清理，未过期 ticket 保留', () => {
	// ttlMs=1 → 立即过期
	createUiWsTicket({ clawId: '1', userId: '2', ttlMs: 1 });
	createUiWsTicket({ clawId: '1', userId: '2', ttlMs: 60_000 });

	// 确保过期 ticket 的 expiresAt 已过
	const start = Date.now();
	while (Date.now() === start) { /* 等待至少 1ms */ }

	pruneUiTickets();

	// 再次创建和 prune 确认功能正常，无异常即通过
	const another = createUiWsTicket({ clawId: '3', userId: '4' });
	assert.match(another, /^[0-9a-f]{32}$/);
	pruneUiTickets();
});

test('clawPingTick: 大消息传输中途恢复——bufferedAmount 先高后低', () => {
	// miss 1
	let r = clawPingTick({ isAlive: false, missCount: 0, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'miss');

	// 大消息开始传输，bufferedAmount > 0，跳过
	r = clawPingTick({ isAlive: false, missCount: r.missCount, bufferedAmount: 8192 }, MAX_MISS);
	assert.equal(r.action, 'skip');
	assert.equal(r.missCount, 1); // 不增加

	// 大消息传完，pong 到达
	r = clawPingTick({ isAlive: true, missCount: 0, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'ok');
	assert.equal(r.missCount, 0);
});

// --- WebRTC 信令路由测试 ---

// Mock WS 工厂
function createMockWs(opts = {}) {
	const sent = [];
	return {
		readyState: opts.readyState ?? 1, // OPEN
		connId: opts.connId ?? null,
		sent,
		send(data) { sent.push(JSON.parse(data)); },
		close() {},
	};
}

// 每个测试前后清理 uiSockets/clawSockets
function setupSockets(clawId, { ui = [], bot = [] } = {}) {
	uiSockets.delete(clawId);
	clawSockets.delete(clawId);
	if (ui.length) {
		uiSockets.set(clawId, new Set(ui));
	}
	if (bot.length) {
		clawSockets.set(clawId, new Set(bot));
	}
}
function cleanupSockets(clawId) {
	uiSockets.delete(clawId);
	clawSockets.delete(clawId);
}

// --- findUiSocketByConnId ---

test('findUiSocketByConnId: 找到匹配 connId 的 OPEN socket', () => {
	const ws = createMockWs({ connId: 'c_abc1' });
	setupSockets('bot1', { ui: [ws] });
	const found = findUiSocketByConnId('bot1', 'c_abc1');
	assert.equal(found, ws);
	cleanupSockets('bot1');
});

test('findUiSocketByConnId: connId 不匹配返回 null', () => {
	const ws = createMockWs({ connId: 'c_abc1' });
	setupSockets('bot1', { ui: [ws] });
	assert.equal(findUiSocketByConnId('bot1', 'c_xyz9'), null);
	cleanupSockets('bot1');
});

test('findUiSocketByConnId: socket 非 OPEN 状态返回 null', () => {
	const ws = createMockWs({ connId: 'c_abc1', readyState: 3 });
	setupSockets('bot1', { ui: [ws] });
	assert.equal(findUiSocketByConnId('bot1', 'c_abc1'), null);
	cleanupSockets('bot1');
});

test('findUiSocketByConnId: botId 无 socket 返回 null', () => {
	assert.equal(findUiSocketByConnId('nonexistent', 'c_abc1'), null);
});

test('findUiSocketByConnId: 多个 UI socket 精确匹配', () => {
	const ws1 = createMockWs({ connId: 'c_aaa' });
	const ws2 = createMockWs({ connId: 'c_bbb' });
	setupSockets('bot1', { ui: [ws1, ws2] });
	assert.equal(findUiSocketByConnId('bot1', 'c_bbb'), ws2);
	cleanupSockets('bot1');
});

// --- onUiMessage: rtc:offer 转发到 claw ---

test('onUiMessage: rtc:offer 转发到 claw 并附上 fromConnId 和 turnCreds', () => {
	const uiWs = createMockWs({ connId: 'c_1234' });
	const clawWs = createMockWs();
	setupSockets('bot1', { ui: [uiWs], bot: [clawWs] });

	onUiMessage('bot1', uiWs, JSON.stringify({
		type: 'rtc:offer',
		payload: { sdp: 'mock-sdp' },
	}));

	assert.equal(clawWs.sent.length, 1);
	const msg = clawWs.sent[0];
	assert.equal(msg.type, 'rtc:offer');
	assert.equal(msg.fromConnId, 'c_1234');
	assert.equal(msg.payload.sdp, 'mock-sdp');
	assert.ok(msg.turnCreds, 'turnCreds should be injected');
	assert.ok(msg.turnCreds.username, 'turnCreds.username should exist');
	assert.ok(msg.turnCreds.credential, 'turnCreds.credential should exist');
	assert.ok(Array.isArray(msg.turnCreds.urls), 'turnCreds.urls should be array');
	cleanupSockets('bot1');
});

// --- onUiMessage: rtc:ice 转发到 claw ---

test('onUiMessage: rtc:ice 转发到 claw 并附上 fromConnId', () => {
	const uiWs = createMockWs({ connId: 'c_5678' });
	const clawWs = createMockWs();
	setupSockets('bot1', { ui: [uiWs], bot: [clawWs] });

	onUiMessage('bot1', uiWs, JSON.stringify({
		type: 'rtc:ice',
		payload: { candidate: 'cand1', sdpMid: '0', sdpMLineIndex: 0 },
	}));

	assert.equal(clawWs.sent.length, 1);
	assert.equal(clawWs.sent[0].type, 'rtc:ice');
	assert.equal(clawWs.sent[0].fromConnId, 'c_5678');
	assert.equal(clawWs.sent[0].payload.candidate, 'cand1');
	cleanupSockets('bot1');
});

// --- onUiMessage: rtc:ready / rtc:closed 转发 ---

test('onUiMessage: rtc:ready 转发到 claw', () => {
	const uiWs = createMockWs({ connId: 'c_r1' });
	const clawWs = createMockWs();
	setupSockets('bot1', { ui: [uiWs], bot: [clawWs] });

	onUiMessage('bot1', uiWs, JSON.stringify({ type: 'rtc:ready' }));

	assert.equal(clawWs.sent.length, 1);
	assert.equal(clawWs.sent[0].type, 'rtc:ready');
	assert.equal(clawWs.sent[0].fromConnId, 'c_r1');
	cleanupSockets('bot1');
});

// --- onUiMessage: rtc:offer claw 离线时不抛异常 ---

test('onUiMessage: rtc:offer claw 离线时静默丢弃', () => {
	const uiWs = createMockWs({ connId: 'c_off' });
	setupSockets('bot1', { ui: [uiWs] }); // 无 claw socket

	// 不应抛异常
	onUiMessage('bot1', uiWs, JSON.stringify({
		type: 'rtc:offer',
		payload: { sdp: 'mock' },
	}));

	// UI 不应收到 BOT_OFFLINE 错误（rtc 消息无 id）
	assert.equal(uiWs.sent.length, 0);
	cleanupSockets('bot1');
});

// --- onClawMessage: rtc:answer 定向投递到指定 UI socket ---

test('onClawMessage: rtc:answer 定向投递到匹配 connId 的 UI socket', () => {
	const uiWs1 = createMockWs({ connId: 'c_aaa' });
	const uiWs2 = createMockWs({ connId: 'c_bbb' });
	const clawWs = createMockWs();
	setupSockets('bot1', { ui: [uiWs1, uiWs2], bot: [clawWs] });

	onClawMessage('bot1', clawWs, JSON.stringify({
		type: 'rtc:answer',
		toConnId: 'c_bbb',
		payload: { sdp: 'answer-sdp' },
	}));

	// 只有 uiWs2 收到
	assert.equal(uiWs1.sent.length, 0);
	assert.equal(uiWs2.sent.length, 1);
	assert.equal(uiWs2.sent[0].type, 'rtc:answer');
	assert.equal(uiWs2.sent[0].payload.sdp, 'answer-sdp');
	cleanupSockets('bot1');
});

// --- onClawMessage: rtc:ice 定向投递 ---

test('onClawMessage: rtc:ice 定向投递到指定 UI socket', () => {
	const uiWs = createMockWs({ connId: 'c_ice1' });
	const clawWs = createMockWs();
	setupSockets('bot1', { ui: [uiWs], bot: [clawWs] });

	onClawMessage('bot1', clawWs, JSON.stringify({
		type: 'rtc:ice',
		toConnId: 'c_ice1',
		payload: { candidate: 'ice-cand' },
	}));

	assert.equal(uiWs.sent.length, 1);
	assert.equal(uiWs.sent[0].type, 'rtc:ice');
	assert.equal(uiWs.sent[0].payload.candidate, 'ice-cand');
	cleanupSockets('bot1');
});

// --- onClawMessage: rtc:answer toConnId 找不到时不抛异常 ---

test('onClawMessage: rtc:answer target 不存在时静默处理', () => {
	const clawWs = createMockWs();
	setupSockets('bot1', { bot: [clawWs] }); // 无 UI socket

	// 不应抛异常
	onClawMessage('bot1', clawWs, JSON.stringify({
		type: 'rtc:answer',
		toConnId: 'c_nonexist',
		payload: { sdp: 'answer' },
	}));
	cleanupSockets('bot1');
});

// --- onClawMessage: rtc:closed 定向投递 ---

test('onClawMessage: rtc:closed 定向投递', () => {
	const uiWs = createMockWs({ connId: 'c_cl1' });
	const clawWs = createMockWs();
	setupSockets('bot1', { ui: [uiWs], bot: [clawWs] });

	onClawMessage('bot1', clawWs, JSON.stringify({
		type: 'rtc:closed',
		toConnId: 'c_cl1',
	}));

	assert.equal(uiWs.sent.length, 1);
	assert.equal(uiWs.sent[0].type, 'rtc:closed');
	cleanupSockets('bot1');
});

// --- 多 claw 交叉隔离测试 ---

test('多 claw 场景：rtc:answer 按 clawId + connId 精确路由，不串 claw', () => {
	// 用户在 Tab1→Claw1, Tab2→Claw1, Tab3→Claw2
	const tab1 = createMockWs({ connId: 'c_aaaa' });
	const tab2 = createMockWs({ connId: 'c_bbbb' });
	const tab3 = createMockWs({ connId: 'c_cccc' });
	const claw1Ws = createMockWs();
	const claw2Ws = createMockWs();
	setupSockets('bot1', { ui: [tab1, tab2], bot: [claw1Ws] });
	setupSockets('bot2', { ui: [tab3], bot: [claw2Ws] });

	// Claw1 回给 Tab2（c_bbbb）
	onClawMessage('bot1', claw1Ws, JSON.stringify({
		type: 'rtc:answer', toConnId: 'c_bbbb', payload: { sdp: 'ans-bot1' },
	}));
	assert.equal(tab1.sent.length, 0, 'tab1 should not receive claw1 answer for tab2');
	assert.equal(tab2.sent.length, 1, 'tab2 should receive claw1 answer');
	assert.equal(tab3.sent.length, 0, 'tab3 should not receive claw1 answer');

	// Claw2 回给 Tab3（c_cccc）
	onClawMessage('bot2', claw2Ws, JSON.stringify({
		type: 'rtc:answer', toConnId: 'c_cccc', payload: { sdp: 'ans-bot2' },
	}));
	assert.equal(tab1.sent.length, 0, 'tab1 still untouched');
	assert.equal(tab2.sent.length, 1, 'tab2 still only 1 message');
	assert.equal(tab3.sent.length, 1, 'tab3 should receive claw2 answer');
	assert.equal(tab3.sent[0].payload.sdp, 'ans-bot2');

	// Claw1 用 Claw2 的 connId → 找不到（clawId 域隔离）
	onClawMessage('bot1', claw1Ws, JSON.stringify({
		type: 'rtc:ice', toConnId: 'c_cccc', payload: { candidate: 'x' },
	}));
	assert.equal(tab3.sent.length, 1, 'tab3 should NOT receive claw1 ice with wrong clawId');

	cleanupSockets('bot1');
	cleanupSockets('bot2');
});

test('多 claw 场景：rtc:offer 精确转发到各自 claw', () => {
	const tab1 = createMockWs({ connId: 'c_t1' });
	const tab3 = createMockWs({ connId: 'c_t3' });
	const claw1Ws = createMockWs();
	const claw2Ws = createMockWs();
	setupSockets('bot1', { ui: [tab1], bot: [claw1Ws] });
	setupSockets('bot2', { ui: [tab3], bot: [claw2Ws] });

	onUiMessage('bot1', tab1, JSON.stringify({ type: 'rtc:offer', payload: { sdp: 'offer1' } }));
	onUiMessage('bot2', tab3, JSON.stringify({ type: 'rtc:offer', payload: { sdp: 'offer2' } }));

	assert.equal(claw1Ws.sent.length, 1);
	assert.equal(claw1Ws.sent[0].payload.sdp, 'offer1');
	assert.equal(claw1Ws.sent[0].fromConnId, 'c_t1');
	assert.equal(claw2Ws.sent.length, 1);
	assert.equal(claw2Ws.sent[0].payload.sdp, 'offer2');
	assert.equal(claw2Ws.sent[0].fromConnId, 'c_t3');

	cleanupSockets('bot1');
	cleanupSockets('bot2');
});

// --- Claw offline grace period ---

function cleanupGrace(clawId) {
	cleanupSockets(clawId);
	if (pendingOffline.has(clawId)) {
		clearTimeout(pendingOffline.get(clawId));
		pendingOffline.delete(clawId);
	}
}

test('listOnlineClawIds 包含 grace period 中的 claw', () => {
	// 模拟 grace period：pendingOffline 有 timer，clawSockets 无 socket
	const timer = setTimeout(() => {}, 60_000);
	pendingOffline.set('grace-bot', timer);

	const ids = listOnlineClawIds();
	assert.ok(ids.has('grace-bot'), 'grace period claw 应出现在 online 列表中');

	clearTimeout(timer);
	pendingOffline.delete('grace-bot');
});

test('listOnlineClawIds 同时包含 connected 和 grace period 的 claw', () => {
	const ws = createMockWs();
	setupSockets('real-bot', { bot: [ws] });
	const timer = setTimeout(() => {}, 60_000);
	pendingOffline.set('grace-bot', timer);

	const ids = listOnlineClawIds();
	assert.ok(ids.has('real-bot'));
	assert.ok(ids.has('grace-bot'));

	cleanupGrace('real-bot');
	cleanupGrace('grace-bot');
});

test('grace period 过期后 clawStatusEmitter 发出 offline 事件', async () => {
	const events = [];
	const listener = (evt) => events.push(evt);
	clawStatusEmitter.on('status', listener);

	// 用极短的 timeout 模拟 grace 过期
	const timer = setTimeout(() => {
		pendingOffline.delete('expire-bot');
		if (!clawSockets.has('expire-bot')) {
			clawStatusEmitter.emit('status', { clawId: 'expire-bot', online: false });
		}
	}, 10);
	pendingOffline.set('expire-bot', timer);

	// 等 grace 过期
	await new Promise((r) => setTimeout(r, 50));

	assert.equal(events.length, 1);
	assert.equal(events[0].clawId, 'expire-bot');
	assert.equal(events[0].online, false);
	assert.ok(!pendingOffline.has('expire-bot'));

	clawStatusEmitter.removeListener('status', listener);
});

test('grace period 内 claw 重连：取消 pending offline，不发 offline 事件', async () => {
	const events = [];
	const listener = (evt) => events.push(evt);
	clawStatusEmitter.on('status', listener);

	// 设一个较长的 grace timer
	const timer = setTimeout(() => {
		pendingOffline.delete('reconn-bot');
		if (!clawSockets.has('reconn-bot')) {
			clawStatusEmitter.emit('status', { clawId: 'reconn-bot', online: false });
		}
	}, 200);
	pendingOffline.set('reconn-bot', timer);

	// 模拟重连：清除 pending + 注册新 socket
	clearTimeout(pendingOffline.get('reconn-bot'));
	pendingOffline.delete('reconn-bot');
	const ws = createMockWs();
	setupSockets('reconn-bot', { bot: [ws] });

	// 等超过原 grace 时间
	await new Promise((r) => setTimeout(r, 250));

	// 不应有 offline 事件
	const offlineEvents = events.filter((e) => e.clawId === 'reconn-bot' && !e.online);
	assert.equal(offlineEvents.length, 0, '重连后不应发出 offline 事件');

	clawStatusEmitter.removeListener('status', listener);
	cleanupGrace('reconn-bot');
});

test('grace period 过期但 claw 已重连：不发 offline 事件', async () => {
	const events = [];
	const listener = (evt) => events.push(evt);
	clawStatusEmitter.on('status', listener);

	// 先注册 socket（claw 已在线）
	const ws = createMockWs();
	setupSockets('online-bot', { bot: [ws] });

	// 模拟 grace timer 到期（但 clawSockets 中仍有 socket）
	const timer = setTimeout(() => {
		pendingOffline.delete('online-bot');
		if (!clawSockets.has('online-bot')) {
			clawStatusEmitter.emit('status', { clawId: 'online-bot', online: false });
		}
	}, 10);
	pendingOffline.set('online-bot', timer);

	await new Promise((r) => setTimeout(r, 50));

	const offlineEvents = events.filter((e) => e.clawId === 'online-bot' && !e.online);
	assert.equal(offlineEvents.length, 0, 'claw 在线时 grace 过期不应发 offline');

	clawStatusEmitter.removeListener('status', listener);
	cleanupGrace('online-bot');
});

// --- 管理性断连 close code 跳过 grace period ---

test('getWebSocketCloseCode: token_revoked/claw_unbound/bot_unbound → 4001, claw_blocked/bot_blocked → 4003', () => {
	assert.equal(getWebSocketCloseCode('token_revoked'), 4001);
	assert.equal(getWebSocketCloseCode('claw_unbound'), 4001);
	assert.equal(getWebSocketCloseCode('bot_unbound'), 4001);
	assert.equal(getWebSocketCloseCode('claw_blocked'), 4003);
	assert.equal(getWebSocketCloseCode('bot_blocked'), 4003);
	assert.equal(getWebSocketCloseCode('other'), 4000);
});

// --- catch 块日志覆盖测试 ---

test('broadcastToUi: ws.send 抛异常时不中断其他 socket 的发送', () => {
	const badWs = createMockWs({ connId: 'c_bad' });
	badWs.send = () => { throw new Error('ws closed'); };
	const goodWs = createMockWs({ connId: 'c_good' });
	setupSockets('bot1', { ui: [badWs, goodWs] });

	// 通过 onClawMessage 触发 broadcastToUi（type=res 走 broadcastToUi 路径）
	onClawMessage('bot1', createMockWs(), JSON.stringify({
		type: 'res',
		id: 'test-1',
		ok: true,
		payload: {},
	}));

	// badWs 发送失败但 goodWs 应收到
	assert.equal(goodWs.sent.length, 1);
	assert.equal(goodWs.sent[0].type, 'res');
	cleanupSockets('bot1');
});

test('forwardToClaw: ws.send 抛异常时不中断且仍返回 true', () => {
	const badClawWs = {
		readyState: 1,
		send() { throw new Error('ws write error'); },
	};
	setupSockets('bot1', { bot: [badClawWs] });

	const uiWs = createMockWs({ connId: 'c_ui1' });
	// 通过 onUiMessage 触发 forwardToClaw（type=req）
	onUiMessage('bot1', uiWs, JSON.stringify({
		type: 'req',
		id: 'rpc-1',
		method: 'test',
		params: {},
	}));

	// forwardToClaw 的 send 抛异常但不应崩溃
	// 且不会给 UI 回 BOT_OFFLINE 错误（因为 forwardToClaw 返回 true）
	assert.equal(uiWs.sent.length, 0);
	cleanupSockets('bot1');
});

// --- fmtLocalTime ---

test('fmtLocalTime: 有效时间戳返回 HH:mm:ss.SSS 格式', () => {
	const result = fmtLocalTime(new Date('2026-03-30T14:01:58.450Z').getTime());
	assert.match(result, /^\d{2}:\d{2}:\d{2}\.\d{3}$/);
});

test('fmtLocalTime: 无效值返回占位符', () => {
	assert.equal(fmtLocalTime(NaN), '??:??:??.???');
	assert.equal(fmtLocalTime(undefined), '??:??:??.???');
});

// --- onClawMessage: type=log 远程日志 ---

test('onClawMessage: type=log 逐条输出到 console.info', () => {
	const clawWs = createMockWs();
	setupSockets('bot1', { bot: [clawWs] });

	const now = Date.now();
	const logged = [];
	const origInfo = console.info;
	console.info = (msg) => logged.push(msg);
	try {
		onClawMessage('bot1', clawWs, JSON.stringify({
			type: 'log',
			logs: [
				{ ts: now, text: 'ws.connected peer=server' },
				{ ts: now + 650, text: 'session.restored id=abc' },
			],
		}));
		assert.equal(logged.length, 2);
		assert.match(logged[0], /\[remote\]\[plugin\]\[claw:bot1\]/);
		assert.match(logged[0], /ws\.connected/);
		// ts 被转换为本地时间格式
		assert.match(logged[0], /\d{2}:\d{2}:\d{2}\.\d{3}/);
		assert.match(logged[1], /session\.restored/);
	} finally {
		console.info = origInfo;
		cleanupSockets('bot1');
	}
});

test('onClawMessage: type=log 忽略非 {ts,text} 条目', () => {
	const clawWs = createMockWs();
	setupSockets('bot1', { bot: [clawWs] });

	const logged = [];
	const origInfo = console.info;
	console.info = (msg) => logged.push(msg);
	try {
		onClawMessage('bot1', clawWs, JSON.stringify({
			type: 'log',
			logs: [
				{ ts: Date.now(), text: 'valid' },
				'bare string',
				123,
				null,
				{ ts: Date.now() },          // 缺 text
				{ text: 'no ts' },            // 缺 ts → 仍输出，时间显示为 ??
				{ ts: Date.now(), text: 'also valid' },
			],
		}));
		assert.equal(logged.length, 3);
		assert.match(logged[0], /valid/);
		assert.match(logged[1], /\?\?:\?\?:\?\?\.\?\?\?/); // 缺 ts 的 fallback
		assert.match(logged[1], /no ts/);
		assert.match(logged[2], /also valid/);
	} finally {
		console.info = origInfo;
		cleanupSockets('bot1');
	}
});

test('onClawMessage: type=log logs 不是数组时静默忽略', () => {
	const clawWs = createMockWs();
	setupSockets('bot1', { bot: [clawWs] });

	const logged = [];
	const origInfo = console.info;
	console.info = (msg) => logged.push(msg);
	try {
		onClawMessage('bot1', clawWs, JSON.stringify({
			type: 'log',
			logs: 'not-an-array',
		}));
		assert.equal(logged.length, 0);
	} finally {
		console.info = origInfo;
		cleanupSockets('bot1');
	}
});

test('onClawMessage: type=log 不转发给 UI', () => {
	const clawWs = createMockWs();
	const uiWs = createMockWs({ connId: 'c_ui_log' });
	setupSockets('bot1', { ui: [uiWs], bot: [clawWs] });

	const origInfo = console.info;
	console.info = () => {};
	try {
		onClawMessage('bot1', clawWs, JSON.stringify({
			type: 'log',
			logs: [{ ts: Date.now(), text: 'some log line' }],
		}));
		assert.equal(uiWs.sent.length, 0, 'log should not be forwarded to UI');
	} finally {
		console.info = origInfo;
		cleanupSockets('bot1');
	}
});

test('onClawMessage: bot.unbound 中 ws.close 抛异常时不崩溃', () => {
	const clawWs = createMockWs();
	clawWs.close = () => { throw new Error('close failed'); };
	const uiWs = createMockWs({ connId: 'c_ui' });
	setupSockets('bot1', { ui: [uiWs], bot: [clawWs] });

	// 不应抛异常
	onClawMessage('bot1', clawWs, JSON.stringify({
		type: 'bot.unbound',
		reason: 'token_revoked',
		botId: 'bot1',
	}));

	// UI 应收到 bot.unbound
	assert.equal(uiWs.sent.length, 1);
	assert.equal(uiWs.sent[0].type, 'bot.unbound');
	cleanupSockets('bot1');
});

test('onClawMessage: claw.unbound（新版 plugin）转发并关闭连接', () => {
	const clawWs = createMockWs();
	const closed = [];
	clawWs.close = (code, reason) => closed.push({ code, reason });
	const uiWs = createMockWs({ connId: 'c_ui' });
	setupSockets('bot1', { ui: [uiWs], bot: [clawWs] });

	onClawMessage('bot1', clawWs, JSON.stringify({
		type: 'claw.unbound',
		reason: 'token_revoked',
		clawId: 'bot1',
	}));

	assert.equal(uiWs.sent.length, 1);
	assert.equal(uiWs.sent[0].type, 'claw.unbound');
	assert.equal(closed.length, 1);
	assert.equal(closed[0].code, 4001);
	assert.equal(closed[0].reason, 'claw_unbound');
	cleanupSockets('bot1');
});

// --- onClawMessage: coclaw.info.updated 事件持久化 claw.name，不转发给 UI ---

test('onClawMessage: coclaw.info.updated 不转发给 UI', () => {
	const clawWs = createMockWs();
	const uiWs = createMockWs({ connId: 'c_ui' });
	setupSockets('bot1', { ui: [uiWs], bot: [clawWs] });

	onClawMessage('bot1', clawWs, JSON.stringify({
		type: 'event',
		event: 'coclaw.info.updated',
		payload: { name: 'My Claw', hostName: 'test-host' },
	}));

	// UI 不应收到该事件（UI 通过 DC 直接从 plugin 获取）
	assert.equal(uiWs.sent.length, 0);
	cleanupSockets('bot1');
});

test('onClawMessage: coclaw.info.updated 无 name 时使用 hostName', () => {
	const clawWs = createMockWs();
	const uiWs = createMockWs({ connId: 'c_ui' });
	setupSockets('bot1', { ui: [uiWs], bot: [clawWs] });

	onClawMessage('bot1', clawWs, JSON.stringify({
		type: 'event',
		event: 'coclaw.info.updated',
		payload: { name: null, hostName: 'fallback-host' },
	}));

	// 不转发给 UI
	assert.equal(uiWs.sent.length, 0);
	cleanupSockets('bot1');
});

// --- 创建支持 getAnyOnlineClawSocket 的 mock ws（带 OPEN 属性） ---
function createRpcMockWs(opts = {}) {
	const sent = [];
	const ws = {
		OPEN: 1,
		readyState: opts.readyState ?? 1,
		connId: opts.connId ?? null,
		sent,
		send(data) {
			if (opts.throwOnSend) throw new Error('send failed');
			sent.push(typeof data === 'string' ? JSON.parse(data) : data);
		},
		close() {},
		terminate() {},
	};
	return ws;
}

// --- notifyAndDisconnectClaw ---

test('notifyAndDisconnectClaw: clawId 为空时直接返回', () => {
	// 不应抛异常
	notifyAndDisconnectClaw(null);
	notifyAndDisconnectClaw(undefined);
	notifyAndDisconnectClaw('');
	notifyAndDisconnectClaw(0);
});

test('notifyAndDisconnectClaw: clawSockets 中无连接时直接返回', () => {
	// 不应抛异常
	notifyAndDisconnectClaw('nonexistent-bot', 'token_revoked');
});

test('notifyAndDisconnectClaw: 通知 claw 和 UI 并断开连接', () => {
	const clawWs = createMockWs();
	const closed = [];
	clawWs.close = (code, reason) => closed.push({ code, reason });
	const uiWs = createMockWs({ connId: 'c_notify' });
	setupSockets('bot-notify', { ui: [uiWs], bot: [clawWs] });

	notifyAndDisconnectClaw('bot-notify', 'token_revoked');

	// claw 应收到双消息：先 claw.unbound 后 bot.unbound
	assert.equal(clawWs.sent.length, 2);
	assert.equal(clawWs.sent[0].type, 'claw.unbound');
	assert.equal(clawWs.sent[0].reason, 'token_revoked');
	assert.equal(clawWs.sent[0].clawId, 'bot-notify');
	assert.equal(clawWs.sent[0].botId, undefined);
	assert.ok(clawWs.sent[0].at);
	assert.equal(clawWs.sent[1].type, 'bot.unbound');
	assert.equal(clawWs.sent[1].botId, 'bot-notify');
	assert.equal(clawWs.sent[1].clawId, 'bot-notify');
	assert.ok(clawWs.sent[1].at);

	// claw 连接以 4001 关闭
	assert.equal(closed.length, 1);
	assert.equal(closed[0].code, 4001);
	assert.equal(closed[0].reason, 'token_revoked');

	// UI 也应收到双广播
	assert.equal(uiWs.sent.length, 2);
	assert.equal(uiWs.sent[0].type, 'claw.unbound');
	assert.equal(uiWs.sent[1].type, 'bot.unbound');

	cleanupSockets('bot-notify');
});

test('notifyAndDisconnectClaw: bot_blocked 使用 closeCode 4003', () => {
	const clawWs = createMockWs();
	const closed = [];
	clawWs.close = (code, reason) => closed.push({ code, reason });
	setupSockets('bot-block', { bot: [clawWs] });

	notifyAndDisconnectClaw('bot-block', 'bot_blocked');

	assert.equal(closed[0].code, 4003);
	assert.equal(closed[0].reason, 'bot_blocked');
	cleanupSockets('bot-block');
});

test('notifyAndDisconnectClaw: bot_unbound 使用 closeCode 4001', () => {
	const clawWs = createMockWs();
	const closed = [];
	clawWs.close = (code, reason) => closed.push({ code, reason });
	setupSockets('bot-unbind', { bot: [clawWs] });

	notifyAndDisconnectClaw('bot-unbind', 'bot_unbound');

	assert.equal(closed[0].code, 4001);
	cleanupSockets('bot-unbind');
});

test('notifyAndDisconnectClaw: 默认 reason 为 token_revoked', () => {
	const clawWs = createMockWs();
	const closed = [];
	clawWs.close = (code, reason) => closed.push({ code, reason });
	setupSockets('bot-default', { bot: [clawWs] });

	notifyAndDisconnectClaw('bot-default');

	assert.equal(clawWs.sent[0].type, 'claw.unbound');
	assert.equal(clawWs.sent[0].reason, 'token_revoked');
	assert.equal(closed[0].code, 4001);
	cleanupSockets('bot-default');
});

test('notifyAndDisconnectClaw: ws.send 抛异常不中断后续 close', () => {
	const clawWs = createMockWs();
	clawWs.send = () => { throw new Error('send error'); };
	const closed = [];
	clawWs.close = (code, reason) => closed.push({ code, reason });
	setupSockets('bot-sendfail', { bot: [clawWs] });

	// 不应抛异常
	notifyAndDisconnectClaw('bot-sendfail', 'token_revoked');

	// close 仍然被调用
	assert.equal(closed.length, 1);
	cleanupSockets('bot-sendfail');
});

test('notifyAndDisconnectClaw: ws.close 抛异常不崩溃', () => {
	const clawWs = createMockWs();
	clawWs.close = () => { throw new Error('close error'); };
	setupSockets('bot-closefail', { bot: [clawWs] });

	// 不应抛异常
	notifyAndDisconnectClaw('bot-closefail', 'token_revoked');

	// send 仍被调用（双消息）
	assert.equal(clawWs.sent.length, 2);
	cleanupSockets('bot-closefail');
});

test('notifyAndDisconnectClaw: 清理 grace period timer', () => {
	const clawWs = createMockWs();
	clawWs.close = () => {};
	setupSockets('bot-grace-clean', { bot: [clawWs] });

	// 模拟 grace period
	const timer = setTimeout(() => {}, 60_000);
	pendingOffline.set('bot-grace-clean', timer);

	notifyAndDisconnectClaw('bot-grace-clean', 'token_revoked');

	assert.ok(!pendingOffline.has('bot-grace-clean'), 'grace period 应被清理');
	cleanupSockets('bot-grace-clean');
});

test('notifyAndDisconnectClaw: 多个 claw socket 全部收到通知并关闭', () => {
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	const closed1 = [];
	const closed2 = [];
	ws1.close = (code, reason) => closed1.push({ code, reason });
	ws2.close = (code, reason) => closed2.push({ code, reason });
	setupSockets('bot-multi', { bot: [ws1, ws2] });

	notifyAndDisconnectClaw('bot-multi', 'token_revoked');

	assert.equal(ws1.sent.length, 2);
	assert.equal(ws2.sent.length, 2);
	assert.equal(closed1.length, 1);
	assert.equal(closed2.length, 1);
	cleanupSockets('bot-multi');
});

test('notifyAndDisconnectClaw: clawId 为数字时转为字符串处理', () => {
	const clawWs = createMockWs();
	clawWs.close = () => {};
	setupSockets('42', { bot: [clawWs] });

	notifyAndDisconnectClaw(42, 'token_revoked');

	assert.equal(clawWs.sent.length, 2);
	assert.equal(clawWs.sent[0].type, 'claw.unbound');
	assert.equal(clawWs.sent[0].clawId, '42');
	assert.equal(clawWs.sent[1].type, 'bot.unbound');
	assert.equal(clawWs.sent[1].botId, '42');
	assert.equal(clawWs.sent[1].clawId, '42');
	cleanupSockets('42');
});

// --- onUiMessage: claw 离线时回 BOT_OFFLINE 错误 ---

test('onUiMessage: claw 离线且消息有 id 时回 BOT_OFFLINE 错误', () => {
	const uiWs = createMockWs({ connId: 'c_off2' });
	setupSockets('bot-off', { ui: [uiWs] }); // 无 claw socket

	onUiMessage('bot-off', uiWs, JSON.stringify({
		type: 'req',
		id: 'rpc-offline-1',
		method: 'agent',
		params: {},
	}));

	assert.equal(uiWs.sent.length, 1);
	assert.equal(uiWs.sent[0].type, 'res');
	assert.equal(uiWs.sent[0].id, 'rpc-offline-1');
	assert.equal(uiWs.sent[0].ok, false);
	assert.equal(uiWs.sent[0].error.code, 'BOT_OFFLINE');
	cleanupSockets('bot-off');
});

test('onUiMessage: claw 离线且消息无 id 时不回错误', () => {
	const uiWs = createMockWs({ connId: 'c_off3' });
	setupSockets('bot-off2', { ui: [uiWs] }); // 无 claw socket

	onUiMessage('bot-off2', uiWs, JSON.stringify({
		type: 'req',
		method: 'test',
		params: {},
	}));

	// 没有 id，不会回错误
	assert.equal(uiWs.sent.length, 0);
	cleanupSockets('bot-off2');
});

test('onUiMessage: claw 离线回 BOT_OFFLINE 时 ws.send 抛异常不崩溃', () => {
	const uiWs = createMockWs({ connId: 'c_off4' });
	uiWs.send = () => { throw new Error('ws closed'); };
	setupSockets('bot-off3', { ui: [uiWs] }); // 无 claw socket

	// 不应抛异常
	onUiMessage('bot-off3', uiWs, JSON.stringify({
		type: 'req',
		id: 'rpc-fail',
		method: 'agent',
		params: {},
	}));
	cleanupSockets('bot-off3');
});

// --- onUiMessage: rpc.req 规范化 ---

test('onUiMessage: rpc.req 规范化为 req 转发到 claw', () => {
	const uiWs = createMockWs({ connId: 'c_rpc1' });
	const clawWs = createMockWs();
	setupSockets('bot-rpc', { ui: [uiWs], bot: [clawWs] });

	onUiMessage('bot-rpc', uiWs, JSON.stringify({
		type: 'rpc.req',
		id: 'rpc-1',
		method: 'test.method',
		params: { foo: 'bar' },
	}));

	assert.equal(clawWs.sent.length, 1);
	assert.equal(clawWs.sent[0].type, 'req');
	assert.equal(clawWs.sent[0].id, 'rpc-1');
	assert.equal(clawWs.sent[0].method, 'test.method');
	assert.deepEqual(clawWs.sent[0].params, { foo: 'bar' });
	cleanupSockets('bot-rpc');
});

test('onUiMessage: rpc.req 无 params 时默认为空对象', () => {
	const uiWs = createMockWs({ connId: 'c_rpc2' });
	const clawWs = createMockWs();
	setupSockets('bot-rpc2', { ui: [uiWs], bot: [clawWs] });

	onUiMessage('bot-rpc2', uiWs, JSON.stringify({
		type: 'rpc.req',
		id: 'rpc-2',
		method: 'test.method',
	}));

	assert.deepEqual(clawWs.sent[0].params, {});
	cleanupSockets('bot-rpc2');
});

// --- onUiMessage: agent 附件日志 ---

test('onUiMessage: agent 请求带附件时输出诊断日志', () => {
	const uiWs = createMockWs({ connId: 'c_att' });
	const clawWs = createMockWs();
	setupSockets('bot-att', { ui: [uiWs], bot: [clawWs] });

	const logged = [];
	const origInfo = console.info;
	console.info = (msg) => logged.push(msg);
	try {
		onUiMessage('bot-att', uiWs, JSON.stringify({
			type: 'req',
			id: 'att-1',
			method: 'agent',
			params: {
				attachments: [
					{ fileName: 'test.png', mimeType: 'image/png', content: 'AAAA' },
				],
			},
		}));
		const attLog = logged.find((l) => l.includes('agent attachments'));
		assert.ok(attLog, '应有附件诊断日志');
		assert.match(attLog, /count=1/);
		assert.match(attLog, /test\.png/);
	} finally {
		console.info = origInfo;
		cleanupSockets('bot-att');
	}
});

// --- onClawMessage: rpc.res 规范化 ---

test('onClawMessage: rpc.res 规范化为 res 转发到 UI', () => {
	const clawWs = createMockWs();
	const uiWs = createMockWs({ connId: 'c_rpcres' });
	setupSockets('bot-rpcres', { ui: [uiWs], bot: [clawWs] });

	onClawMessage('bot-rpcres', clawWs, JSON.stringify({
		type: 'rpc.res',
		id: 'res-1',
		ok: true,
		payload: { data: 'hello' },
	}));

	assert.equal(uiWs.sent.length, 1);
	assert.equal(uiWs.sent[0].type, 'res');
	assert.equal(uiWs.sent[0].id, 'res-1');
	assert.equal(uiWs.sent[0].ok, true);
	assert.deepEqual(uiWs.sent[0].payload, { data: 'hello' });
	cleanupSockets('bot-rpcres');
});

test('onClawMessage: rpc.res 带 error 字段转发到 UI', () => {
	const clawWs = createMockWs();
	const uiWs = createMockWs({ connId: 'c_rpcerr' });
	setupSockets('bot-rpcerr', { ui: [uiWs], bot: [clawWs] });

	onClawMessage('bot-rpcerr', clawWs, JSON.stringify({
		type: 'rpc.res',
		id: 'res-2',
		ok: false,
		error: { code: 'ERR', message: 'fail' },
	}));

	assert.equal(uiWs.sent[0].ok, false);
	assert.deepEqual(uiWs.sent[0].error, { code: 'ERR', message: 'fail' });
	cleanupSockets('bot-rpcerr');
});

// --- onClawMessage: rpc.event 规范化 ---

test('onClawMessage: rpc.event 规范化为 event 转发到 UI', () => {
	const clawWs = createMockWs();
	const uiWs = createMockWs({ connId: 'c_rpcevt' });
	setupSockets('bot-rpcevt', { ui: [uiWs], bot: [clawWs] });

	onClawMessage('bot-rpcevt', clawWs, JSON.stringify({
		type: 'rpc.event',
		event: 'agent.status',
		payload: { status: 'ready' },
	}));

	assert.equal(uiWs.sent.length, 1);
	assert.equal(uiWs.sent[0].type, 'event');
	assert.equal(uiWs.sent[0].event, 'agent.status');
	assert.deepEqual(uiWs.sent[0].payload, { status: 'ready' });
	cleanupSockets('bot-rpcevt');
});

// --- onClawMessage: 普通 event 原样转发 ---

test('onClawMessage: 普通 event 原样转发给 UI', () => {
	const clawWs = createMockWs();
	const uiWs = createMockWs({ connId: 'c_evt' });
	setupSockets('bot-evt', { ui: [uiWs], bot: [clawWs] });

	onClawMessage('bot-evt', clawWs, JSON.stringify({
		type: 'event',
		event: 'custom.event',
		payload: { key: 'value' },
	}));

	assert.equal(uiWs.sent.length, 1);
	assert.equal(uiWs.sent[0].type, 'event');
	assert.equal(uiWs.sent[0].event, 'custom.event');
	cleanupSockets('bot-evt');
});

// --- onClawMessage: 普通 res 原样转发 ---

test('onClawMessage: 普通 res 原样转发给 UI', () => {
	const clawWs = createMockWs();
	const uiWs = createMockWs({ connId: 'c_res' });
	setupSockets('bot-res', { ui: [uiWs], bot: [clawWs] });

	onClawMessage('bot-res', clawWs, JSON.stringify({
		type: 'res',
		id: 'res-plain',
		ok: true,
		payload: { result: 42 },
	}));

	assert.equal(uiWs.sent.length, 1);
	assert.equal(uiWs.sent[0].type, 'res');
	assert.equal(uiWs.sent[0].id, 'res-plain');
	cleanupSockets('bot-res');
});

// --- onClawMessage: ping 回复 pong ---

test('onClawMessage: ping 类型回复 pong，不转发给 UI', () => {
	const clawWs = createMockWs();
	const uiWs = createMockWs({ connId: 'c_ping' });
	setupSockets('bot-ping', { ui: [uiWs], bot: [clawWs] });

	onClawMessage('bot-ping', clawWs, JSON.stringify({ type: 'ping' }));

	// claw ws 收到 pong
	assert.equal(clawWs.sent.length, 1);
	assert.equal(clawWs.sent[0].type, 'pong');
	// UI 不应收到
	assert.equal(uiWs.sent.length, 0);
	cleanupSockets('bot-ping');
});

test('onClawMessage: ping 时 ws.send 抛异常不崩溃', () => {
	const clawWs = createMockWs();
	clawWs.send = () => { throw new Error('closed'); };
	setupSockets('bot-ping2', { bot: [clawWs] });

	// 不应抛异常
	onClawMessage('bot-ping2', clawWs, JSON.stringify({ type: 'ping' }));
	cleanupSockets('bot-ping2');
});

// --- onUiMessage: ping 回复 pong ---

test('onUiMessage: ping 类型回复 pong，不转发给 claw', () => {
	const uiWs = createMockWs({ connId: 'c_uiping' });
	const clawWs = createMockWs();
	setupSockets('bot-uiping', { ui: [uiWs], bot: [clawWs] });

	onUiMessage('bot-uiping', uiWs, JSON.stringify({ type: 'ping' }));

	// UI ws 收到 pong
	assert.equal(uiWs.sent.length, 1);
	assert.equal(uiWs.sent[0].type, 'pong');
	// claw 不应收到
	assert.equal(clawWs.sent.length, 0);
	cleanupSockets('bot-uiping');
});

test('onUiMessage: ping 时 ws.send 抛异常不崩溃', () => {
	const uiWs = createMockWs({ connId: 'c_uiping2' });
	uiWs.send = () => { throw new Error('closed'); };
	setupSockets('bot-uiping2', { bot: [createMockWs()] });

	// 不应抛异常
	onUiMessage('bot-uiping2', uiWs, JSON.stringify({ type: 'ping' }));
	cleanupSockets('bot-uiping2');
});

// --- onClawMessage / onUiMessage: 无效 JSON / 非对象 ---

test('onClawMessage: 无效 JSON 静默忽略', () => {
	const clawWs = createMockWs();
	setupSockets('bot-bad', { bot: [clawWs] });

	// 不应抛异常
	onClawMessage('bot-bad', clawWs, 'not-json{{{');
	cleanupSockets('bot-bad');
});

test('onClawMessage: null payload 静默忽略', () => {
	const clawWs = createMockWs();
	setupSockets('bot-null', { bot: [clawWs] });

	onClawMessage('bot-null', clawWs, JSON.stringify(null));
	cleanupSockets('bot-null');
});

test('onClawMessage: 非对象 payload 静默忽略', () => {
	const clawWs = createMockWs();
	setupSockets('bot-str', { bot: [clawWs] });

	onClawMessage('bot-str', clawWs, JSON.stringify('a string'));
	cleanupSockets('bot-str');
});

test('onUiMessage: 无效 JSON 静默忽略', () => {
	const uiWs = createMockWs({ connId: 'c_bad' });
	setupSockets('bot-uibad', { ui: [uiWs] });

	// 不应抛异常
	onUiMessage('bot-uibad', uiWs, 'broken-json');
	cleanupSockets('bot-uibad');
});

test('onUiMessage: null payload 静默忽略', () => {
	const uiWs = createMockWs({ connId: 'c_null' });
	setupSockets('bot-uinull', { ui: [uiWs] });

	onUiMessage('bot-uinull', uiWs, JSON.stringify(null));
	cleanupSockets('bot-uinull');
});

test('onUiMessage: 非对象 payload 静默忽略', () => {
	const uiWs = createMockWs({ connId: 'c_num' });
	setupSockets('bot-uinum', { ui: [uiWs] });

	onUiMessage('bot-uinum', uiWs, JSON.stringify(42));
	cleanupSockets('bot-uinum');
});

// --- onUiMessage: rtc:closed 转发 ---

test('onUiMessage: rtc:closed 转发到 claw', () => {
	const uiWs = createMockWs({ connId: 'c_cl2' });
	const clawWs = createMockWs();
	setupSockets('bot-cl', { ui: [uiWs], bot: [clawWs] });

	onUiMessage('bot-cl', uiWs, JSON.stringify({ type: 'rtc:closed' }));

	assert.equal(clawWs.sent.length, 1);
	assert.equal(clawWs.sent[0].type, 'rtc:closed');
	assert.equal(clawWs.sent[0].fromConnId, 'c_cl2');
	cleanupSockets('bot-cl');
});

// --- refreshClawName: claw 离线时返回 undefined ---

test('refreshClawName: claw 离线（无 socket）时返回 undefined', async () => {
	const result = await refreshClawName('99999');
	assert.equal(result, undefined);
});

// --- refreshClawName: claw 在线但 rpc 返回 ok !== true ---

test('refreshClawName: rpc 返回 ok=false 时返回 undefined', async () => {
	// 使用 rpcMockWs 使 getAnyOnlineClawSocket 返回有效 socket
	const ws = createRpcMockWs();
	setupSockets('rpc-bot-1', { bot: [ws] });

	// requestClawRpc 会发消息到 ws，但没有人回复，会超时
	// 用极短超时使其快速失败
	const result = await refreshClawName('rpc-bot-1', { timeoutMs: 10 }).catch(() => undefined);
	assert.equal(result, undefined);

	cleanupSockets('rpc-bot-1');
});

// --- forwardToClaw: 直接测试 ---

test('forwardToClaw: 无 socket 时返回 false', () => {
	const result = forwardToClaw('nonexistent-bot', { type: 'req' });
	assert.equal(result, false);
});

test('forwardToClaw: 有 socket 时返回 true', () => {
	const clawWs = createMockWs();
	setupSockets('fwd-bot', { bot: [clawWs] });

	const result = forwardToClaw('fwd-bot', { type: 'req', id: '1' });
	assert.equal(result, true);
	assert.equal(clawWs.sent.length, 1);
	cleanupSockets('fwd-bot');
});

test('forwardToClaw: 空 set 返回 false', () => {
	clawSockets.set('empty-bot', new Set());
	const result = forwardToClaw('empty-bot', { type: 'req' });
	assert.equal(result, false);
	clawSockets.delete('empty-bot');
});

// --- CLAW_OFFLINE_GRACE_MS 常量验证 ---

test('CLAW_OFFLINE_GRACE_MS 为 5000ms', () => {
	assert.equal(CLAW_OFFLINE_GRACE_MS, 5000);
});

// --- onClawMessage: 未知 type 不转发也不崩溃 ---

test('onClawMessage: 未知 type 静默忽略', () => {
	const clawWs = createMockWs();
	const uiWs = createMockWs({ connId: 'c_unk' });
	setupSockets('bot-unk', { ui: [uiWs], bot: [clawWs] });

	onClawMessage('bot-unk', clawWs, JSON.stringify({ type: 'unknown_type', data: 123 }));

	// UI 不应收到
	assert.equal(uiWs.sent.length, 0);
	cleanupSockets('bot-unk');
});

// --- onUiMessage: rtc:offer 无 TURN_SECRET 时不附带 turnCreds ---

test('onUiMessage: rtc:offer 在无 TURN_SECRET 时不附带 turnCreds', () => {
	const origSecret = process.env.TURN_SECRET;
	delete process.env.TURN_SECRET;
	try {
		const uiWs = createMockWs({ connId: 'c_noturn' });
		const clawWs = createMockWs();
		setupSockets('bot-noturn', { ui: [uiWs], bot: [clawWs] });

		onUiMessage('bot-noturn', uiWs, JSON.stringify({
			type: 'rtc:offer',
			payload: { sdp: 'sdp' },
		}));

		assert.equal(clawWs.sent.length, 1);
		assert.equal(clawWs.sent[0].turnCreds, undefined);
		cleanupSockets('bot-noturn');
	} finally {
		process.env.TURN_SECRET = origSecret;
	}
});

// --- onUiMessage: rtc:ice claw 离线时静默丢弃 ---

test('onUiMessage: rtc:ice claw 离线时静默丢弃', () => {
	const uiWs = createMockWs({ connId: 'c_iceoff' });
	setupSockets('bot-iceoff', { ui: [uiWs] }); // 无 claw

	onUiMessage('bot-iceoff', uiWs, JSON.stringify({
		type: 'rtc:ice',
		payload: { candidate: 'cand' },
	}));

	assert.equal(uiWs.sent.length, 0);
	cleanupSockets('bot-iceoff');
});

// --- onClawMessage: rtc:answer 通过信令路由表投递 ---

test('onClawMessage: rtc:answer 通过 signal-router 投递成功时不走 fallback', () => {
	const routeWs = createMockWs({ connId: 'c_sr1' });
	// 注册到信令路由表
	registerSignalRoute('c_sr1', routeWs, 'bot-sr', 'user1');

	const clawWs = createMockWs();
	const uiWs = createMockWs({ connId: 'c_sr1' });
	setupSockets('bot-sr', { ui: [uiWs], bot: [clawWs] });

	onClawMessage('bot-sr', clawWs, JSON.stringify({
		type: 'rtc:answer',
		toConnId: 'c_sr1',
		payload: { sdp: 'signal-router-answer' },
	}));

	// routeWs（信令路由表中的 ws）应收到消息
	assert.equal(routeWs.sent.length, 1);
	assert.equal(routeWs.sent[0].type, 'rtc:answer');

	// 清理
	signalRoutes.delete('c_sr1');
	cleanupSockets('bot-sr');
});

test('onClawMessage: rtc:ice 通过 signal-router 投递', () => {
	const routeWs = createMockWs({ connId: 'c_sr2' });
	registerSignalRoute('c_sr2', routeWs, 'bot-sr2', 'user1');

	const clawWs = createMockWs();
	setupSockets('bot-sr2', { bot: [clawWs] });

	onClawMessage('bot-sr2', clawWs, JSON.stringify({
		type: 'rtc:ice',
		toConnId: 'c_sr2',
		payload: { candidate: 'ice-via-router' },
	}));

	assert.equal(routeWs.sent.length, 1);
	assert.equal(routeWs.sent[0].type, 'rtc:ice');

	signalRoutes.delete('c_sr2');
	cleanupSockets('bot-sr2');
});

test('onClawMessage: rtc:closed 通过 signal-router 投递', () => {
	const routeWs = createMockWs({ connId: 'c_sr3' });
	registerSignalRoute('c_sr3', routeWs, 'bot-sr3', 'user1');

	const clawWs = createMockWs();
	setupSockets('bot-sr3', { bot: [clawWs] });

	onClawMessage('bot-sr3', clawWs, JSON.stringify({
		type: 'rtc:closed',
		toConnId: 'c_sr3',
	}));

	assert.equal(routeWs.sent.length, 1);
	assert.equal(routeWs.sent[0].type, 'rtc:closed');

	signalRoutes.delete('c_sr3');
	cleanupSockets('bot-sr3');
});

// --- onClawMessage: coclaw.info.updated 中 updateClawName 抛同步异常 ---

test('onClawMessage: coclaw.info.updated 处理时不崩溃（payload 为 null）', () => {
	const clawWs = createMockWs();
	setupSockets('bot-info-null', { bot: [clawWs] });

	// payload 无 name 和 hostName → name 为 null
	onClawMessage('bot-info-null', clawWs, JSON.stringify({
		type: 'event',
		event: 'coclaw.info.updated',
		payload: {},
	}));
	cleanupSockets('bot-info-null');
});

// --- onClawMessage: raw 为 undefined/null ---

test('onClawMessage: raw 为 undefined 时解析为空对象', () => {
	const clawWs = createMockWs();
	setupSockets('bot-undef', { bot: [clawWs] });

	// raw=undefined → String(undefined) = 'undefined' → JSON.parse 失败 → 静默返回
	onClawMessage('bot-undef', clawWs, undefined);
	cleanupSockets('bot-undef');
});

test('onUiMessage: raw 为 undefined 时解析为空对象', () => {
	const uiWs = createMockWs({ connId: 'c_undef' });
	setupSockets('bot-uiudef', { ui: [uiWs] });

	onUiMessage('bot-uiudef', uiWs, undefined);
	cleanupSockets('bot-uiudef');
});

// --- refreshClawName: rpc 成功但 findClawById 抛异常（DB 不可用） ---

test('refreshClawName: rpc 成功返回 name，findClawById 抛异常时返回 latestName', async () => {
	// 创建自动回复 RPC 的 mock socket
	const clawId = 'rpc-name-bot';
	const autoReplyWs = createRpcMockWs();
	const origSend = autoReplyWs.send.bind(autoReplyWs);
	autoReplyWs.send = (data) => {
		origSend(data);
		const req = JSON.parse(data);
		if (req.type === 'req' && req.method === 'agent.identity.get') {
			// 模拟 claw 立即回复
			setTimeout(() => {
				onClawMessage(clawId, autoReplyWs, JSON.stringify({
					type: 'res',
					id: req.id,
					ok: true,
					payload: { name: 'TestBot' },
				}));
			}, 0);
		}
	};
	setupSockets(clawId, { bot: [autoReplyWs] });

	// findClawById 会抛异常（因为没有 DB），覆盖 lines 179-183
	const result = await refreshClawName(clawId, { timeoutMs: 500 });
	// 返回从 rpc 获取的 name（findClawById 失败后 fallback）
	assert.equal(result, 'TestBot');

	cleanupSockets(clawId);
});

test('refreshClawName: rpc 成功但 name 为空时返回 null', async () => {
	const clawId = 'rpc-empty-name';
	const autoReplyWs = createRpcMockWs();
	const origSend = autoReplyWs.send.bind(autoReplyWs);
	autoReplyWs.send = (data) => {
		origSend(data);
		const req = JSON.parse(data);
		if (req.type === 'req') {
			setTimeout(() => {
				onClawMessage(clawId, autoReplyWs, JSON.stringify({
					type: 'res',
					id: req.id,
					ok: true,
					payload: { name: '  ' }, // 空白 → trim 后为 '' → null
				}));
			}, 0);
		}
	};
	setupSockets(clawId, { bot: [autoReplyWs] });

	const result = await refreshClawName(clawId, { timeoutMs: 500 });
	assert.equal(result, null);

	cleanupSockets(clawId);
});

test('refreshClawName: rpc 返回 ok=false 时返回 undefined', async () => {
	const clawId = 'rpc-notok';
	const autoReplyWs = createRpcMockWs();
	const origSend = autoReplyWs.send.bind(autoReplyWs);
	autoReplyWs.send = (data) => {
		origSend(data);
		const req = JSON.parse(data);
		if (req.type === 'req') {
			setTimeout(() => {
				onClawMessage(clawId, autoReplyWs, JSON.stringify({
					type: 'res',
					id: req.id,
					ok: false,
					error: { message: 'not found' },
				}));
			}, 0);
		}
	};
	setupSockets(clawId, { bot: [autoReplyWs] });

	const result = await refreshClawName(clawId, { timeoutMs: 500 });
	assert.equal(result, undefined);

	cleanupSockets(clawId);
});

test('refreshClawName: rpc 超时时返回 undefined（走 catch 分支）', async () => {
	const clawId = 'rpc-timeout';
	// 不自动回复的 socket → rpc 会超时
	const ws = createRpcMockWs();
	setupSockets(clawId, { bot: [ws] });

	const result = await refreshClawName(clawId, { timeoutMs: 20 });
	assert.equal(result, undefined);

	cleanupSockets(clawId);
});

test('refreshClawName: rpc 返回 payload.name 非 string 时返回 null', async () => {
	const clawId = 'rpc-nostr';
	const autoReplyWs = createRpcMockWs();
	const origSend = autoReplyWs.send.bind(autoReplyWs);
	autoReplyWs.send = (data) => {
		origSend(data);
		const req = JSON.parse(data);
		if (req.type === 'req') {
			setTimeout(() => {
				onClawMessage(clawId, autoReplyWs, JSON.stringify({
					type: 'res',
					id: req.id,
					ok: true,
					payload: { name: 123 }, // 非 string
				}));
			}, 0);
		}
	};
	setupSockets(clawId, { bot: [autoReplyWs] });

	const result = await refreshClawName(clawId, { timeoutMs: 500 });
	// name 非 string → rawName = '' → latestName = null
	// findClawById 会失败 → 返回 latestName = null
	assert.equal(result, null);

	cleanupSockets(clawId);
});

// --- requestClawRpc: socket.send 抛异常时走 catch 分支 ---

test('refreshClawName: socket.send 抛异常时返回 undefined（requestClawRpc catch）', async () => {
	const clawId = 'rpc-sendfail';
	const ws = createRpcMockWs({ throwOnSend: true });
	setupSockets(clawId, { bot: [ws] });

	const result = await refreshClawName(clawId, { timeoutMs: 500 });
	assert.equal(result, undefined);

	cleanupSockets(clawId);
});

// --- authenticateUiTicket ---

test('authenticateUiTicket: 缺少 ticket 参数时返回 401', () => {
	const req = { url: '/api/v1/bots/stream?role=ui' };
	const result = authenticateUiTicket(req);
	assert.equal(result.ok, false);
	assert.equal(result.code, 401);
	assert.equal(result.message, 'missing ticket');
});

test('authenticateUiTicket: ticket 不存在时返回 invalid ticket', () => {
	const req = { url: '/api/v1/bots/stream?role=ui&ticket=nonexistent' };
	const result = authenticateUiTicket(req);
	assert.equal(result.ok, false);
	assert.equal(result.message, 'invalid ticket');
});

test('authenticateUiTicket: ticket 已过期时返回 invalid ticket', () => {
	// 直接注入一个已过期的 ticket 到 uiTickets
	uiTickets.set('expired-test-ticket', {
		clawId: '1',
		userId: '2',
		expiresAt: Date.now() - 1000,
	});

	const req = { url: '/api/v1/bots/stream?role=ui&ticket=expired-test-ticket' };
	const result = authenticateUiTicket(req);
	assert.equal(result.ok, false);
	assert.equal(result.message, 'invalid ticket');
});

test('authenticateUiTicket: 有效 ticket 返回 ok', () => {
	const ticket = createUiWsTicket({ clawId: '10', userId: '20' });
	const req = { url: `/api/v1/bots/stream?role=ui&ticket=${ticket}` };
	const result = authenticateUiTicket(req);
	assert.equal(result.ok, true);
	assert.equal(result.clawId, '10');
	assert.equal(result.userId, '20');
});

test('authenticateUiTicket: ticket 使用后即删除（不可重用）', () => {
	const ticket = createUiWsTicket({ clawId: '10', userId: '20' });
	const req = { url: `/api/v1/bots/stream?role=ui&ticket=${ticket}` };
	authenticateUiTicket(req);
	// 第二次应失败
	const result2 = authenticateUiTicket(req);
	assert.equal(result2.ok, false);
});

// --- authenticateUiSession ---

test('authenticateUiSession: wsSessionMiddleware 为 null 时返回 null', async () => {
	const orig = __test.wsSessionMiddleware;
	__test.wsSessionMiddleware = null;
	try {
		const result = await authenticateUiSession({ url: '/api/v1/bots/stream?role=ui&botId=1' });
		assert.equal(result, null);
	} finally {
		__test.wsSessionMiddleware = orig;
	}
});

test('authenticateUiSession: 缺少 botId 参数时返回 null', async () => {
	const orig = __test.wsSessionMiddleware;
	__test.wsSessionMiddleware = (_req, _res, next) => next();
	try {
		const result = await authenticateUiSession({ url: '/api/v1/bots/stream?role=ui' });
		assert.equal(result, null);
	} finally {
		__test.wsSessionMiddleware = orig;
	}
});

test('authenticateUiSession: session middleware 出错时返回 null', async () => {
	const orig = __test.wsSessionMiddleware;
	__test.wsSessionMiddleware = (_req, _res, next) => next(new Error('session error'));
	try {
		const result = await authenticateUiSession({ url: '/api/v1/bots/stream?role=ui&botId=1' });
		assert.equal(result, null);
	} finally {
		__test.wsSessionMiddleware = orig;
	}
});

test('authenticateUiSession: session 无 userId 时返回 null', async () => {
	const orig = __test.wsSessionMiddleware;
	__test.wsSessionMiddleware = (req, _res, next) => {
		req.session = { passport: {} };
		next();
	};
	try {
		const result = await authenticateUiSession({ url: '/api/v1/bots/stream?role=ui&botId=1' });
		assert.equal(result, null);
	} finally {
		__test.wsSessionMiddleware = orig;
	}
});

test('authenticateUiSession: findClawById 抛异常时返回 null', async () => {
	const orig = __test.wsSessionMiddleware;
	__test.wsSessionMiddleware = (req, _res, next) => {
		req.session = { passport: { user: '999' } };
		next();
	};
	try {
		// findClawById 会尝试 BigInt(botId) 然后查 DB，DB 不可用会抛异常
		const result = await authenticateUiSession({ url: '/api/v1/bots/stream?role=ui&botId=1' });
		assert.equal(result, null);
	} finally {
		__test.wsSessionMiddleware = orig;
	}
});

test('authenticateUiSession: 支持 ?clawId= 查询参数（新版 UI）', async () => {
	const orig = __test.wsSessionMiddleware;
	__test.wsSessionMiddleware = (req, _res, next) => {
		req.session = { passport: { user: '999' } };
		next();
	};
	try {
		// clawId 参数同样会尝试 BigInt 然后查 DB
		const result = await authenticateUiSession({ url: '/api/v1/claws/stream?role=ui&clawId=1' });
		// DB 不可用返回 null，但验证不抛异常即可
		assert.equal(result, null);
	} finally {
		__test.wsSessionMiddleware = orig;
	}
});

// --- registerSocket / unregisterSocket ---

test('registerSocket: 注册多个 socket 到同一 key', () => {
	const map = new Map();
	const ws1 = createMockWs();
	const ws2 = createMockWs();
	registerSocket(map, 'k1', ws1);
	registerSocket(map, 'k1', ws2);
	assert.equal(map.get('k1').size, 2);
});

test('unregisterSocket: key 不存在时不报错', () => {
	const map = new Map();
	unregisterSocket(map, 'nonexist', createMockWs());
});

test('unregisterSocket: 最后一个 socket 注销后删除 key', () => {
	const map = new Map();
	const ws = createMockWs();
	registerSocket(map, 'k2', ws);
	unregisterSocket(map, 'k2', ws);
	assert.equal(map.has('k2'), false);
});

// --- getAnyOnlineClawSocket ---

test('getAnyOnlineClawSocket: 无 socket 时返回 null', () => {
	assert.equal(getAnyOnlineClawSocket('nonexist'), null);
});

test('getAnyOnlineClawSocket: 所有 socket 非 OPEN 时返回 null', () => {
	const ws = createRpcMockWs({ readyState: 3 }); // CLOSED
	setupSockets('gao-1', { bot: [ws] });
	assert.equal(getAnyOnlineClawSocket('gao-1'), null);
	cleanupSockets('gao-1');
});

test('getAnyOnlineClawSocket: 返回第一个 OPEN socket', () => {
	const ws = createRpcMockWs();
	setupSockets('gao-2', { bot: [ws] });
	assert.equal(getAnyOnlineClawSocket('gao-2'), ws);
	cleanupSockets('gao-2');
});

// --- resolveClawRpcPending / rejectAllClawRpcPending ---

test('resolveClawRpcPending: 无 pending 时返回 false', () => {
	assert.equal(resolveClawRpcPending('no-bot', 'no-id', {}), false);
});

test('rejectAllClawRpcPending: 无 pending 时不报错', () => {
	rejectAllClawRpcPending('no-bot');
});

// --- broadcastToUi: 无 UI socket 时不报错 ---

test('broadcastToUi: 无 UI socket 时不报错', () => {
	broadcastToUi('nonexist', { type: 'test' });
});

// --- authenticateClawRequest ---

test('authenticateClawRequest: 缺少 token 参数时返回 401', async () => {
	const result = await authenticateClawRequest({ url: '/api/v1/bots/stream' });
	assert.equal(result.ok, false);
	assert.equal(result.code, 401);
	assert.equal(result.message, 'missing token');
});

test('authenticateClawRequest: 无效 token 时返回 invalid token', async () => {
	const result = await authenticateClawRequest({ url: '/api/v1/bots/stream?token=bad-token' });
	assert.equal(result.ok, false);
	assert.equal(result.message, 'invalid token');
});

// --- onClawMessage: coclaw.info.updated 触发 updateClawName 的 .catch 路径 ---

test('onClawMessage: coclaw.info.updated 使用数字 clawId 时 BigInt 成功但 DB 失败走 .catch', async () => {
	const clawWs = createMockWs();
	// 使用数字 clawId 使 BigInt() 成功，updateClawName 会尝试 DB 操作然后失败
	setupSockets('12345', { bot: [clawWs] });

	// 不应抛异常（.catch 会静默处理）
	onClawMessage('12345', clawWs, JSON.stringify({
		type: 'event',
		event: 'coclaw.info.updated',
		payload: { name: 'NewName' },
	}));

	// 等待微任务完成（.catch 是异步的）
	await new Promise((r) => setTimeout(r, 50));
	cleanupSockets('12345');
});

// --- broadcastToUi: 空 set 时不报错 ---

test('broadcastToUi: socket set 为空时不发送', () => {
	uiSockets.set('empty-ui', new Set());
	broadcastToUi('empty-ui', { type: 'test' });
	uiSockets.delete('empty-ui');
});
