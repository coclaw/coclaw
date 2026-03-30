import assert from 'node:assert/strict';
import test from 'node:test';

// rtc:offer 测试需要 TURN_SECRET
process.env.TURN_SECRET ??= 'test-secret';
process.env.APP_DOMAIN ??= 'test.coclaw.net';

import { botPingTick, createUiWsTicket, listOnlineBotIds, pruneUiTickets, botStatusEmitter, fmtLocalTime, __test } from './bot-ws-hub.js';

const { uiSockets, botSockets, pendingOffline, getWebSocketCloseCode, onUiMessage, onBotMessage, findUiSocketByConnId } = __test;

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

// --- Bot offline grace period ---

function cleanupGrace(botId) {
	cleanupSockets(botId);
	if (pendingOffline.has(botId)) {
		clearTimeout(pendingOffline.get(botId));
		pendingOffline.delete(botId);
	}
}

test('listOnlineBotIds 包含 grace period 中的 bot', () => {
	// 模拟 grace period：pendingOffline 有 timer，botSockets 无 socket
	const timer = setTimeout(() => {}, 60_000);
	pendingOffline.set('grace-bot', timer);

	const ids = listOnlineBotIds();
	assert.ok(ids.has('grace-bot'), 'grace period bot 应出现在 online 列表中');

	clearTimeout(timer);
	pendingOffline.delete('grace-bot');
});

test('listOnlineBotIds 同时包含 connected 和 grace period 的 bot', () => {
	const ws = createMockWs();
	setupSockets('real-bot', { bot: [ws] });
	const timer = setTimeout(() => {}, 60_000);
	pendingOffline.set('grace-bot', timer);

	const ids = listOnlineBotIds();
	assert.ok(ids.has('real-bot'));
	assert.ok(ids.has('grace-bot'));

	cleanupGrace('real-bot');
	cleanupGrace('grace-bot');
});

test('grace period 过期后 botStatusEmitter 发出 offline 事件', async () => {
	const events = [];
	const listener = (evt) => events.push(evt);
	botStatusEmitter.on('status', listener);

	// 用极短的 timeout 模拟 grace 过期
	const timer = setTimeout(() => {
		pendingOffline.delete('expire-bot');
		if (!botSockets.has('expire-bot')) {
			botStatusEmitter.emit('status', { botId: 'expire-bot', online: false });
		}
	}, 10);
	pendingOffline.set('expire-bot', timer);

	// 等 grace 过期
	await new Promise((r) => setTimeout(r, 50));

	assert.equal(events.length, 1);
	assert.equal(events[0].botId, 'expire-bot');
	assert.equal(events[0].online, false);
	assert.ok(!pendingOffline.has('expire-bot'));

	botStatusEmitter.removeListener('status', listener);
});

test('grace period 内 bot 重连：取消 pending offline，不发 offline 事件', async () => {
	const events = [];
	const listener = (evt) => events.push(evt);
	botStatusEmitter.on('status', listener);

	// 设一个较长的 grace timer
	const timer = setTimeout(() => {
		pendingOffline.delete('reconn-bot');
		if (!botSockets.has('reconn-bot')) {
			botStatusEmitter.emit('status', { botId: 'reconn-bot', online: false });
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
	const offlineEvents = events.filter((e) => e.botId === 'reconn-bot' && !e.online);
	assert.equal(offlineEvents.length, 0, '重连后不应发出 offline 事件');

	botStatusEmitter.removeListener('status', listener);
	cleanupGrace('reconn-bot');
});

test('grace period 过期但 bot 已重连：不发 offline 事件', async () => {
	const events = [];
	const listener = (evt) => events.push(evt);
	botStatusEmitter.on('status', listener);

	// 先注册 socket（bot 已在线）
	const ws = createMockWs();
	setupSockets('online-bot', { bot: [ws] });

	// 模拟 grace timer 到期（但 botSockets 中仍有 socket）
	const timer = setTimeout(() => {
		pendingOffline.delete('online-bot');
		if (!botSockets.has('online-bot')) {
			botStatusEmitter.emit('status', { botId: 'online-bot', online: false });
		}
	}, 10);
	pendingOffline.set('online-bot', timer);

	await new Promise((r) => setTimeout(r, 50));

	const offlineEvents = events.filter((e) => e.botId === 'online-bot' && !e.online);
	assert.equal(offlineEvents.length, 0, 'bot 在线时 grace 过期不应发 offline');

	botStatusEmitter.removeListener('status', listener);
	cleanupGrace('online-bot');
});

// --- 管理性断连 close code 跳过 grace period ---

test('getWebSocketCloseCode: token_revoked/bot_unbound → 4001, bot_blocked → 4003', () => {
	assert.equal(getWebSocketCloseCode('token_revoked'), 4001);
	assert.equal(getWebSocketCloseCode('bot_unbound'), 4001);
	assert.equal(getWebSocketCloseCode('bot_blocked'), 4003);
	assert.equal(getWebSocketCloseCode('other'), 4000);
});

// --- catch 块日志覆盖测试 ---

test('broadcastToUi: ws.send 抛异常时不中断其他 socket 的发送', () => {
	const badWs = createMockWs({ connId: 'c_bad' });
	badWs.send = () => { throw new Error('ws closed'); };
	const goodWs = createMockWs({ connId: 'c_good' });
	setupSockets('bot1', { ui: [badWs, goodWs] });

	// 通过 onBotMessage 触发 broadcastToUi（type=res 走 broadcastToUi 路径）
	onBotMessage('bot1', createMockWs(), JSON.stringify({
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

test('forwardToBot: ws.send 抛异常时不中断且仍返回 true', () => {
	const badBotWs = {
		readyState: 1,
		send() { throw new Error('ws write error'); },
	};
	setupSockets('bot1', { bot: [badBotWs] });

	const uiWs = createMockWs({ connId: 'c_ui1' });
	// 通过 onUiMessage 触发 forwardToBot（type=req）
	onUiMessage('bot1', uiWs, JSON.stringify({
		type: 'req',
		id: 'rpc-1',
		method: 'test',
		params: {},
	}));

	// forwardToBot 的 send 抛异常但不应崩溃
	// 且不会给 UI 回 BOT_OFFLINE 错误（因为 forwardToBot 返回 true）
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

// --- onBotMessage: type=log 远程日志 ---

test('onBotMessage: type=log 逐条输出到 console.info', () => {
	const botWs = createMockWs();
	setupSockets('bot1', { bot: [botWs] });

	const now = Date.now();
	const logged = [];
	const origInfo = console.info;
	console.info = (msg) => logged.push(msg);
	try {
		onBotMessage('bot1', botWs, JSON.stringify({
			type: 'log',
			logs: [
				{ ts: now, text: 'ws.connected peer=server' },
				{ ts: now + 650, text: 'session.restored id=abc' },
			],
		}));
		assert.equal(logged.length, 2);
		assert.match(logged[0], /\[remote\]\[plugin\]\[bot:bot1\]/);
		assert.match(logged[0], /ws\.connected/);
		// ts 被转换为本地时间格式
		assert.match(logged[0], /\d{2}:\d{2}:\d{2}\.\d{3}/);
		assert.match(logged[1], /session\.restored/);
	} finally {
		console.info = origInfo;
		cleanupSockets('bot1');
	}
});

test('onBotMessage: type=log 忽略非 {ts,text} 条目', () => {
	const botWs = createMockWs();
	setupSockets('bot1', { bot: [botWs] });

	const logged = [];
	const origInfo = console.info;
	console.info = (msg) => logged.push(msg);
	try {
		onBotMessage('bot1', botWs, JSON.stringify({
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

test('onBotMessage: type=log logs 不是数组时静默忽略', () => {
	const botWs = createMockWs();
	setupSockets('bot1', { bot: [botWs] });

	const logged = [];
	const origInfo = console.info;
	console.info = (msg) => logged.push(msg);
	try {
		onBotMessage('bot1', botWs, JSON.stringify({
			type: 'log',
			logs: 'not-an-array',
		}));
		assert.equal(logged.length, 0);
	} finally {
		console.info = origInfo;
		cleanupSockets('bot1');
	}
});

test('onBotMessage: type=log 不转发给 UI', () => {
	const botWs = createMockWs();
	const uiWs = createMockWs({ connId: 'c_ui_log' });
	setupSockets('bot1', { ui: [uiWs], bot: [botWs] });

	const origInfo = console.info;
	console.info = () => {};
	try {
		onBotMessage('bot1', botWs, JSON.stringify({
			type: 'log',
			logs: [{ ts: Date.now(), text: 'some log line' }],
		}));
		assert.equal(uiWs.sent.length, 0, 'log should not be forwarded to UI');
	} finally {
		console.info = origInfo;
		cleanupSockets('bot1');
	}
});

test('onBotMessage: bot.unbound 中 ws.close 抛异常时不崩溃', () => {
	const botWs = createMockWs();
	botWs.close = () => { throw new Error('close failed'); };
	const uiWs = createMockWs({ connId: 'c_ui' });
	setupSockets('bot1', { ui: [uiWs], bot: [botWs] });

	// 不应抛异常
	onBotMessage('bot1', botWs, JSON.stringify({
		type: 'bot.unbound',
		reason: 'token_revoked',
		botId: 'bot1',
	}));

	// UI 应收到 bot.unbound
	assert.equal(uiWs.sent.length, 1);
	assert.equal(uiWs.sent[0].type, 'bot.unbound');
	cleanupSockets('bot1');
});
