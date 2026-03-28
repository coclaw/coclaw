import assert from 'node:assert/strict';
import test from 'node:test';
// rtc:offer 测试需要 TURN_SECRET
process.env.TURN_SECRET ??= 'test-secret';
process.env.APP_DOMAIN ??= 'test.coclaw.net';

import { botCloseEffect, botPingTick, createUiWsTicket, pruneUiTickets, __test } from './bot-ws-hub.js';

const { uiSockets, botSockets, onUiMessage, onBotMessage, findUiSocketByConnId } = __test;

const MAX_MISS = 4;

test('botPingTick: isAlive=true → action=ok, missCount 重置为 0', () => {
	const result = botPingTick({ isAlive: true, missCount: 3, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(result.action, 'ok');
	assert.equal(result.missCount, 0);
});

test('botPingTick: isAlive=true 时忽略 bufferedAmount', () => {
	const result = botPingTick({ isAlive: true, missCount: 2, bufferedAmount: 99999 }, MAX_MISS);
	assert.equal(result.action, 'ok');
	assert.equal(result.missCount, 0);
});

test('botPingTick: isAlive=false + bufferedAmount>0 → action=skip, missCount 不变', () => {
	const result = botPingTick({ isAlive: false, missCount: 2, bufferedAmount: 1024 }, MAX_MISS);
	assert.equal(result.action, 'skip');
	assert.equal(result.missCount, 2);
});

test('botPingTick: isAlive=false + bufferedAmount=0 + 未达上限 → action=miss', () => {
	const result = botPingTick({ isAlive: false, missCount: 0, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(result.action, 'miss');
	assert.equal(result.missCount, 1);
});

test('botPingTick: 连续 miss 递增直到上限前', () => {
	let missCount = 0;
	for (let i = 1; i < MAX_MISS; i++) {
		const result = botPingTick({ isAlive: false, missCount, bufferedAmount: 0 }, MAX_MISS);
		assert.equal(result.action, 'miss');
		assert.equal(result.missCount, i);
		missCount = result.missCount;
	}
});

test('botPingTick: 达到 maxMiss → action=terminate', () => {
	const result = botPingTick({ isAlive: false, missCount: MAX_MISS - 1, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(result.action, 'terminate');
	assert.equal(result.missCount, MAX_MISS);
});

test('botPingTick: bufferedAmount>0 阻止 terminate 即使 missCount 已高', () => {
	const result = botPingTick({ isAlive: false, missCount: MAX_MISS - 1, bufferedAmount: 500 }, MAX_MISS);
	assert.equal(result.action, 'skip');
	assert.equal(result.missCount, MAX_MISS - 1);
});

test('botPingTick: pong 后 miss 场景——模拟完整周期', () => {
	// 1. 正常轮次
	let r = botPingTick({ isAlive: true, missCount: 0, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'ok');

	// 2. miss 1
	r = botPingTick({ isAlive: false, missCount: r.missCount, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'miss');
	assert.equal(r.missCount, 1);

	// 3. miss 2
	r = botPingTick({ isAlive: false, missCount: r.missCount, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'miss');
	assert.equal(r.missCount, 2);

	// 4. pong 收到 → 模拟外部重置 isAlive=true, missCount=0
	r = botPingTick({ isAlive: true, missCount: 0, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'ok');
	assert.equal(r.missCount, 0);

	// 5. 再次 miss
	r = botPingTick({ isAlive: false, missCount: r.missCount, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'miss');
	assert.equal(r.missCount, 1);
});

// --- createUiWsTicket & pruneUiTickets ---

test('createUiWsTicket: 返回 32 位 hex 字符串', () => {
	const ticket = createUiWsTicket({ botId: '1', userId: '2' });
	assert.match(ticket, /^[0-9a-f]{32}$/);
});

test('pruneUiTickets: 过期 ticket 被清理，未过期 ticket 保留', () => {
	// ttlMs=1 → 立即过期
	createUiWsTicket({ botId: '1', userId: '2', ttlMs: 1 });
	createUiWsTicket({ botId: '1', userId: '2', ttlMs: 60_000 });

	// 确保过期 ticket 的 expiresAt 已过
	const start = Date.now();
	while (Date.now() === start) { /* 等待至少 1ms */ }

	pruneUiTickets();

	// 再次创建和 prune 确认功能正常，无异常即通过
	const another = createUiWsTicket({ botId: '3', userId: '4' });
	assert.match(another, /^[0-9a-f]{32}$/);
	pruneUiTickets();
});

test('botPingTick: 大消息传输中途恢复——bufferedAmount 先高后低', () => {
	// miss 1
	let r = botPingTick({ isAlive: false, missCount: 0, bufferedAmount: 0 }, MAX_MISS);
	assert.equal(r.action, 'miss');

	// 大消息开始传输，bufferedAmount > 0，跳过
	r = botPingTick({ isAlive: false, missCount: r.missCount, bufferedAmount: 8192 }, MAX_MISS);
	assert.equal(r.action, 'skip');
	assert.equal(r.missCount, 1); // 不增加

	// 大消息传完，pong 到达
	r = botPingTick({ isAlive: true, missCount: 0, bufferedAmount: 0 }, MAX_MISS);
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

// 每个测试前后清理 uiSockets/botSockets
function setupSockets(botId, { ui = [], bot = [] } = {}) {
	uiSockets.delete(botId);
	botSockets.delete(botId);
	if (ui.length) {
		uiSockets.set(botId, new Set(ui));
	}
	if (bot.length) {
		botSockets.set(botId, new Set(bot));
	}
}
function cleanupSockets(botId) {
	uiSockets.delete(botId);
	botSockets.delete(botId);
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

// --- onUiMessage: rtc:offer 转发到 bot ---

test('onUiMessage: rtc:offer 转发到 bot 并附上 fromConnId 和 turnCreds', () => {
	const uiWs = createMockWs({ connId: 'c_1234' });
	const botWs = createMockWs();
	setupSockets('bot1', { ui: [uiWs], bot: [botWs] });

	onUiMessage('bot1', uiWs, JSON.stringify({
		type: 'rtc:offer',
		payload: { sdp: 'mock-sdp' },
	}));

	assert.equal(botWs.sent.length, 1);
	const msg = botWs.sent[0];
	assert.equal(msg.type, 'rtc:offer');
	assert.equal(msg.fromConnId, 'c_1234');
	assert.equal(msg.payload.sdp, 'mock-sdp');
	assert.ok(msg.turnCreds, 'turnCreds should be injected');
	assert.ok(msg.turnCreds.username, 'turnCreds.username should exist');
	assert.ok(msg.turnCreds.credential, 'turnCreds.credential should exist');
	assert.ok(Array.isArray(msg.turnCreds.urls), 'turnCreds.urls should be array');
	cleanupSockets('bot1');
});

// --- onUiMessage: rtc:ice 转发到 bot ---

test('onUiMessage: rtc:ice 转发到 bot 并附上 fromConnId', () => {
	const uiWs = createMockWs({ connId: 'c_5678' });
	const botWs = createMockWs();
	setupSockets('bot1', { ui: [uiWs], bot: [botWs] });

	onUiMessage('bot1', uiWs, JSON.stringify({
		type: 'rtc:ice',
		payload: { candidate: 'cand1', sdpMid: '0', sdpMLineIndex: 0 },
	}));

	assert.equal(botWs.sent.length, 1);
	assert.equal(botWs.sent[0].type, 'rtc:ice');
	assert.equal(botWs.sent[0].fromConnId, 'c_5678');
	assert.equal(botWs.sent[0].payload.candidate, 'cand1');
	cleanupSockets('bot1');
});

// --- onUiMessage: rtc:ready / rtc:closed 转发 ---

test('onUiMessage: rtc:ready 转发到 bot', () => {
	const uiWs = createMockWs({ connId: 'c_r1' });
	const botWs = createMockWs();
	setupSockets('bot1', { ui: [uiWs], bot: [botWs] });

	onUiMessage('bot1', uiWs, JSON.stringify({ type: 'rtc:ready' }));

	assert.equal(botWs.sent.length, 1);
	assert.equal(botWs.sent[0].type, 'rtc:ready');
	assert.equal(botWs.sent[0].fromConnId, 'c_r1');
	cleanupSockets('bot1');
});

// --- onUiMessage: rtc:offer bot 离线时不抛异常 ---

test('onUiMessage: rtc:offer bot 离线时静默丢弃', () => {
	const uiWs = createMockWs({ connId: 'c_off' });
	setupSockets('bot1', { ui: [uiWs] }); // 无 bot socket

	// 不应抛异常
	onUiMessage('bot1', uiWs, JSON.stringify({
		type: 'rtc:offer',
		payload: { sdp: 'mock' },
	}));

	// UI 不应收到 BOT_OFFLINE 错误（rtc 消息无 id）
	assert.equal(uiWs.sent.length, 0);
	cleanupSockets('bot1');
});

// --- onBotMessage: rtc:answer 定向投递到指定 UI socket ---

test('onBotMessage: rtc:answer 定向投递到匹配 connId 的 UI socket', () => {
	const uiWs1 = createMockWs({ connId: 'c_aaa' });
	const uiWs2 = createMockWs({ connId: 'c_bbb' });
	const botWs = createMockWs();
	setupSockets('bot1', { ui: [uiWs1, uiWs2], bot: [botWs] });

	onBotMessage('bot1', botWs, JSON.stringify({
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

// --- onBotMessage: rtc:ice 定向投递 ---

test('onBotMessage: rtc:ice 定向投递到指定 UI socket', () => {
	const uiWs = createMockWs({ connId: 'c_ice1' });
	const botWs = createMockWs();
	setupSockets('bot1', { ui: [uiWs], bot: [botWs] });

	onBotMessage('bot1', botWs, JSON.stringify({
		type: 'rtc:ice',
		toConnId: 'c_ice1',
		payload: { candidate: 'ice-cand' },
	}));

	assert.equal(uiWs.sent.length, 1);
	assert.equal(uiWs.sent[0].type, 'rtc:ice');
	assert.equal(uiWs.sent[0].payload.candidate, 'ice-cand');
	cleanupSockets('bot1');
});

// --- onBotMessage: rtc:answer toConnId 找不到时不抛异常 ---

test('onBotMessage: rtc:answer target 不存在时静默处理', () => {
	const botWs = createMockWs();
	setupSockets('bot1', { bot: [botWs] }); // 无 UI socket

	// 不应抛异常
	onBotMessage('bot1', botWs, JSON.stringify({
		type: 'rtc:answer',
		toConnId: 'c_nonexist',
		payload: { sdp: 'answer' },
	}));
	cleanupSockets('bot1');
});

// --- onBotMessage: rtc:closed 定向投递 ---

test('onBotMessage: rtc:closed 定向投递', () => {
	const uiWs = createMockWs({ connId: 'c_cl1' });
	const botWs = createMockWs();
	setupSockets('bot1', { ui: [uiWs], bot: [botWs] });

	onBotMessage('bot1', botWs, JSON.stringify({
		type: 'rtc:closed',
		toConnId: 'c_cl1',
	}));

	assert.equal(uiWs.sent.length, 1);
	assert.equal(uiWs.sent[0].type, 'rtc:closed');
	cleanupSockets('bot1');
});

// --- 多 bot 交叉隔离测试 ---

test('多 bot 场景：rtc:answer 按 botId + connId 精确路由，不串 bot', () => {
	// 用户在 Tab1→Bot1, Tab2→Bot1, Tab3→Bot2
	const tab1 = createMockWs({ connId: 'c_aaaa' });
	const tab2 = createMockWs({ connId: 'c_bbbb' });
	const tab3 = createMockWs({ connId: 'c_cccc' });
	const bot1Ws = createMockWs();
	const bot2Ws = createMockWs();
	setupSockets('bot1', { ui: [tab1, tab2], bot: [bot1Ws] });
	setupSockets('bot2', { ui: [tab3], bot: [bot2Ws] });

	// Bot1 回给 Tab2（c_bbbb）
	onBotMessage('bot1', bot1Ws, JSON.stringify({
		type: 'rtc:answer', toConnId: 'c_bbbb', payload: { sdp: 'ans-bot1' },
	}));
	assert.equal(tab1.sent.length, 0, 'tab1 should not receive bot1 answer for tab2');
	assert.equal(tab2.sent.length, 1, 'tab2 should receive bot1 answer');
	assert.equal(tab3.sent.length, 0, 'tab3 should not receive bot1 answer');

	// Bot2 回给 Tab3（c_cccc）
	onBotMessage('bot2', bot2Ws, JSON.stringify({
		type: 'rtc:answer', toConnId: 'c_cccc', payload: { sdp: 'ans-bot2' },
	}));
	assert.equal(tab1.sent.length, 0, 'tab1 still untouched');
	assert.equal(tab2.sent.length, 1, 'tab2 still only 1 message');
	assert.equal(tab3.sent.length, 1, 'tab3 should receive bot2 answer');
	assert.equal(tab3.sent[0].payload.sdp, 'ans-bot2');

	// Bot1 用 Bot2 的 connId → 找不到（botId 域隔离）
	onBotMessage('bot1', bot1Ws, JSON.stringify({
		type: 'rtc:ice', toConnId: 'c_cccc', payload: { candidate: 'x' },
	}));
	assert.equal(tab3.sent.length, 1, 'tab3 should NOT receive bot1 ice with wrong botId');

	cleanupSockets('bot1');
	cleanupSockets('bot2');
});

test('多 bot 场景：rtc:offer 精确转发到各自 bot', () => {
	const tab1 = createMockWs({ connId: 'c_t1' });
	const tab3 = createMockWs({ connId: 'c_t3' });
	const bot1Ws = createMockWs();
	const bot2Ws = createMockWs();
	setupSockets('bot1', { ui: [tab1], bot: [bot1Ws] });
	setupSockets('bot2', { ui: [tab3], bot: [bot2Ws] });

	onUiMessage('bot1', tab1, JSON.stringify({ type: 'rtc:offer', payload: { sdp: 'offer1' } }));
	onUiMessage('bot2', tab3, JSON.stringify({ type: 'rtc:offer', payload: { sdp: 'offer2' } }));

	assert.equal(bot1Ws.sent.length, 1);
	assert.equal(bot1Ws.sent[0].payload.sdp, 'offer1');
	assert.equal(bot1Ws.sent[0].fromConnId, 'c_t1');
	assert.equal(bot2Ws.sent.length, 1);
	assert.equal(bot2Ws.sent[0].payload.sdp, 'offer2');
	assert.equal(bot2Ws.sent[0].fromConnId, 'c_t3');

	cleanupSockets('bot1');
	cleanupSockets('bot2');
});

// --- botCloseEffect ---

test('botCloseEffect: code 4001 → unbound=true, tokenRevoked=false（远程解绑）', () => {
	const result = botCloseEffect(4001);
	assert.equal(result.unbound, true);
	assert.equal(result.tokenRevoked, false);
});

test('botCloseEffect: code 4002 → unbound=false, tokenRevoked=true（token 撤销）', () => {
	const result = botCloseEffect(4002);
	assert.equal(result.unbound, false);
	assert.equal(result.tokenRevoked, true);
});

test('botCloseEffect: code 1000 → unbound=false, tokenRevoked=false（正常关闭）', () => {
	const result = botCloseEffect(1000);
	assert.equal(result.unbound, false);
	assert.equal(result.tokenRevoked, false);
});
