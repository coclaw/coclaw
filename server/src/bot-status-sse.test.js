import assert from 'node:assert/strict';
import test from 'node:test';

import { hasSseClients, registerSseClient, sendToUser } from './bot-status-sse.js';

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
