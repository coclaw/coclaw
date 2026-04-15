import assert from 'node:assert/strict';
import test from 'node:test';

import { hasSseClients, registerSseClient, sendSnapshot, sendToUser, __test } from './claw-status-sse.js';

const { handleStatusEvent, handleInfoUpdatedEvent } = __test;

function createMockRes() {
	const written = [];
	const closeHandlers = [];
	return {
		written,
		write(data) {
			written.push(data);
		},
		on(event, handler) {
			if (event === 'close') {
				closeHandlers.push(handler);
			}
		},
		__triggerClose() {
			for (const h of closeHandlers) {
				h();
			}
		},
	};
}

test('hasSseClients: should return false when no clients registered', () => {
	assert.equal(hasSseClients(), false);
});

test('registerSseClient + sendToUser: should deliver data to correct user', () => {
	const res7 = createMockRes();
	const res8 = createMockRes();
	registerSseClient('7', res7);
	registerSseClient('8', res8);

	assert.equal(hasSseClients(), true);

	sendToUser('7', { event: 'bot.status', botId: '100', online: true });

	assert.equal(res7.written.length, 1);
	const parsed = JSON.parse(res7.written[0].replace('data: ', '').trim());
	assert.equal(parsed.event, 'bot.status');
	assert.equal(parsed.botId, '100');
	assert.equal(parsed.online, true);

	// userId=8 不应收到
	assert.equal(res8.written.length, 0);

	// 清理
	res7.__triggerClose();
	res8.__triggerClose();
});

test('registerSseClient: should clean up on res close', () => {
	const res = createMockRes();
	registerSseClient('9', res);

	assert.equal(hasSseClients(), true);

	res.__triggerClose();

	sendToUser('9', { event: 'test' });
	assert.equal(res.written.length, 0);
});

test('sendToUser: should be no-op for non-existent user', () => {
	// 不应抛异常
	sendToUser('999', { event: 'test' });
});

test('sendSnapshot: should push bot.snapshot event to single client', async () => {
	const res = createMockRes();
	const mockBots = [
		{ id: 1n, name: 'a', lastSeenAt: null, createdAt: null, updatedAt: null },
		{ id: 2n, name: 'b', lastSeenAt: null, createdAt: null, updatedAt: null },
	];
	const onlineIds = new Set(['2']);

	await sendSnapshot('20', res, {
		listClawsByUserIdImpl: async () => mockBots,
		listOnlineClawIdsImpl: () => onlineIds,
	});

	// 双事件：先 claw.snapshot 后 bot.snapshot
	assert.equal(res.written.length, 2);
	const clawEvt = JSON.parse(res.written[0].replace('data: ', '').trim());
	assert.equal(clawEvt.event, 'claw.snapshot');
	assert.equal(clawEvt.items.length, 2);
	assert.equal(clawEvt.items[0].id, '1');
	assert.equal(clawEvt.items[0].online, false);
	assert.equal(clawEvt.items[1].id, '2');
	assert.equal(clawEvt.items[1].online, true);
	const botEvt = JSON.parse(res.written[1].replace('data: ', '').trim());
	assert.equal(botEvt.event, 'bot.snapshot');
	assert.deepEqual(botEvt.items, clawEvt.items);
});

test('sendSnapshot: should not throw on res.write failure', async () => {
	const res = {
		write() { throw new Error('broken pipe'); },
		on() {},
	};

	// 不应抛异常
	await sendSnapshot('21', res, {
		listClawsByUserIdImpl: async () => [],
		listOnlineClawIdsImpl: () => new Set(),
	});
});

test('registerSseClient: multiple clients for same user should all receive data', () => {
	const res1 = createMockRes();
	const res2 = createMockRes();
	registerSseClient('10', res1);
	registerSseClient('10', res2);

	sendToUser('10', { event: 'bot.status', botId: '200', online: false });

	assert.equal(res1.written.length, 1);
	assert.equal(res2.written.length, 1);

	// 关闭一个，另一个仍可收到
	res1.__triggerClose();
	sendToUser('10', { event: 'bot.status', botId: '200', online: true });

	assert.equal(res1.written.length, 1); // 不再增加
	assert.equal(res2.written.length, 2);

	res2.__triggerClose();
});

// --- sendToUser: write 抛异常时不中断 ---

test('sendToUser: res.write 抛异常时静默捕获，不影响其他客户端', () => {
	const badRes = createMockRes();
	badRes.write = () => { throw new Error('broken pipe'); };
	const goodRes = createMockRes();
	registerSseClient('50', badRes);
	registerSseClient('50', goodRes);

	// 不应抛异常
	sendToUser('50', { event: 'bot.status', botId: '300', online: true });

	// goodRes 仍应收到数据
	assert.equal(goodRes.written.length, 1);

	// 清理
	badRes.__triggerClose();
	goodRes.__triggerClose();
});

// --- handleStatusEvent ---

test('handleStatusEvent: 无 SSE 客户端时直接返回', async () => {
	// 确保无客户端
	assert.equal(hasSseClients(), false);
	// 不应抛异常
	await handleStatusEvent({ clawId: '1', online: true }, {
		findClawByIdFn: () => { throw new Error('should not be called'); },
	});
});

test('handleStatusEvent: bot 存在时推送 claw.status + bot.status 双事件', async () => {
	const res = createMockRes();
	registerSseClient('100', res);

	const mockFindBot = async (id) => ({
		id,
		userId: 100n,
	});

	await handleStatusEvent({ clawId: '5', online: true }, {
		findClawByIdFn: mockFindBot,
	});

	assert.equal(res.written.length, 2);
	const clawEvt = JSON.parse(res.written[0].replace('data: ', '').trim());
	assert.equal(clawEvt.event, 'claw.status');
	assert.equal(clawEvt.clawId, '5');
	assert.equal(clawEvt.online, true);
	const botEvt = JSON.parse(res.written[1].replace('data: ', '').trim());
	assert.equal(botEvt.event, 'bot.status');
	assert.equal(botEvt.botId, '5');
	assert.equal(botEvt.clawId, '5');
	assert.equal(botEvt.online, true);

	res.__triggerClose();
});

test('handleStatusEvent: bot 不存在时不推送', async () => {
	const res = createMockRes();
	registerSseClient('101', res);

	await handleStatusEvent({ clawId: '999', online: false }, {
		findClawByIdFn: async () => null,
	});

	assert.equal(res.written.length, 0);

	res.__triggerClose();
});

test('handleStatusEvent: findClawById 抛异常时静默捕获', async () => {
	const res = createMockRes();
	registerSseClient('102', res);

	// 不应抛异常
	await handleStatusEvent({ clawId: '1', online: true }, {
		findClawByIdFn: async () => { throw new Error('db error'); },
	});

	assert.equal(res.written.length, 0);

	res.__triggerClose();
});

// --- handleInfoUpdatedEvent ---

test('handleInfoUpdatedEvent: 无 SSE 客户端时直接返回', async () => {
	assert.equal(hasSseClients(), false);
	await handleInfoUpdatedEvent({ clawId: '1', name: 'new-name' }, {
		findClawByIdFn: () => { throw new Error('should not be called'); },
	});
});

test('handleInfoUpdatedEvent: bot 存在时推送 claw.nameUpdated + bot.nameUpdated 双事件（仅 name 下发给用户侧 UI）', async () => {
	const res = createMockRes();
	registerSseClient('200', res);

	const mockFindBot = async (id) => ({
		id,
		userId: 200n,
	});

	// 事件载荷含 hostName/pluginVersion/agentModels，但用户侧 SSE 只下发 name
	await handleInfoUpdatedEvent({
		clawId: '10',
		name: 'my-bot',
		hostName: 'ubuntu',
		pluginVersion: '0.14.0',
		agentModels: [{ id: 'main', name: 'Main', model: 'claude-opus-4' }],
	}, { findClawByIdFn: mockFindBot });

	assert.equal(res.written.length, 2);
	const clawEvt = JSON.parse(res.written[0].replace('data: ', '').trim());
	assert.equal(clawEvt.event, 'claw.nameUpdated');
	assert.equal(clawEvt.clawId, '10');
	assert.equal(clawEvt.name, 'my-bot');
	assert.equal(clawEvt.hostName, undefined);
	assert.equal(clawEvt.pluginVersion, undefined);
	assert.equal(clawEvt.agentModels, undefined);
	const botEvt = JSON.parse(res.written[1].replace('data: ', '').trim());
	assert.equal(botEvt.event, 'bot.nameUpdated');
	assert.equal(botEvt.botId, '10');
	assert.equal(botEvt.clawId, '10');
	assert.equal(botEvt.name, 'my-bot');

	res.__triggerClose();
});

test('handleInfoUpdatedEvent: bot 不存在时不推送', async () => {
	const res = createMockRes();
	registerSseClient('201', res);

	await handleInfoUpdatedEvent({ clawId: '999', name: 'x' }, {
		findClawByIdFn: async () => null,
	});

	assert.equal(res.written.length, 0);

	res.__triggerClose();
});

test('handleInfoUpdatedEvent: findClawById 抛异常时静默捕获', async () => {
	const res = createMockRes();
	registerSseClient('202', res);

	await handleInfoUpdatedEvent({ clawId: '1', name: 'x' }, {
		findClawByIdFn: async () => { throw new Error('db error'); },
	});

	assert.equal(res.written.length, 0);

	res.__triggerClose();
});
