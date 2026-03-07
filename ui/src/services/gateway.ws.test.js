import { describe, test, expect, vi, beforeEach } from 'vitest';

// mock bots.api
vi.mock('./bots.api.js', () => ({
	createBotWsTicket: vi.fn(() => Promise.resolve({ ticket: 'test-ticket' })),
}));

// 简易 WebSocket mock
class MockWebSocket {
	constructor() {
		this.listeners = {};
		this.sent = [];
		this.readyState = 1;
	}
	addEventListener(event, cb, opts) {
		if (!this.listeners[event]) this.listeners[event] = [];
		this.listeners[event].push({ cb, once: opts?.once });
	}
	removeEventListener(event, cb) {
		if (!this.listeners[event]) return;
		this.listeners[event] = this.listeners[event].filter((l) => l.cb !== cb);
	}
	send(data) {
		this.sent.push(JSON.parse(data));
	}
	close() {}
	// 测试辅助：触发事件
	__emit(event, data) {
		const handlers = this.listeners[event] ?? [];
		for (const h of handlers) {
			h.cb(data);
		}
		// 移除 once 监听
		this.listeners[event] = handlers.filter((h) => !h.once);
	}
}

let lastWs = null;
vi.stubGlobal('WebSocket', function (...args) {
	lastWs = new MockWebSocket(...args);
	// 自动触发 open
	setTimeout(() => lastWs.__emit('open'), 0);
	return lastWs;
});

import { createGatewayRpcClient } from './gateway.ws.js';

describe('createGatewayRpcClient', () => {
	beforeEach(() => {
		lastWs = null;
		vi.clearAllMocks();
	});

	test('request 发送 req 帧并解析 res', async () => {
		const client = await createGatewayRpcClient({ botId: 'b1' });
		const p = client.request('echo', { msg: 'hi' });

		const sent = lastWs.sent[0];
		expect(sent.type).toBe('req');
		expect(sent.method).toBe('echo');
		expect(sent.params.msg).toBe('hi');

		// 模拟服务端回复
		lastWs.__emit('message', { data: JSON.stringify({ type: 'res', id: sent.id, ok: true, payload: { echo: 'hi' } }) });
		const result = await p;
		expect(result.echo).toBe('hi');
	});

	test('request 解析错误 res', async () => {
		const client = await createGatewayRpcClient({ botId: 'b1' });
		const p = client.request('fail');

		const sent = lastWs.sent[0];
		lastWs.__emit('message', { data: JSON.stringify({ type: 'res', id: sent.id, ok: false, error: { message: 'bad', code: 'ERR' } }) });
		await expect(p).rejects.toThrow('bad');
	});

	test('on/off 注册和注销事件监听', async () => {
		const client = await createGatewayRpcClient({ botId: 'b1' });
		const cb = vi.fn();

		client.on('agent', cb);

		// 触发 event 帧
		lastWs.__emit('message', { data: JSON.stringify({ type: 'event', event: 'agent', payload: { runId: 'r1' } }) });
		expect(cb).toHaveBeenCalledTimes(1);
		expect(cb).toHaveBeenCalledWith({ runId: 'r1' });

		// 注销后不再触发
		client.off('agent', cb);
		lastWs.__emit('message', { data: JSON.stringify({ type: 'event', event: 'agent', payload: { runId: 'r2' } }) });
		expect(cb).toHaveBeenCalledTimes(1);
	});

	test('event 帧不影响 pending request', async () => {
		const client = await createGatewayRpcClient({ botId: 'b1' });
		const cb = vi.fn();
		client.on('agent', cb);

		const p = client.request('echo');
		const sent = lastWs.sent[0];

		// 先到达 event 帧
		lastWs.__emit('message', { data: JSON.stringify({ type: 'event', event: 'agent', payload: { x: 1 } }) });
		expect(cb).toHaveBeenCalledTimes(1);

		// 再到达 res 帧
		lastWs.__emit('message', { data: JSON.stringify({ type: 'res', id: sent.id, ok: true, payload: { ok: 1 } }) });
		const result = await p;
		expect(result.ok).toBe(1);
	});

	test('未注册的 event 不会报错', async () => {
		await createGatewayRpcClient({ botId: 'b1' });
		// 触发无人监听的 event，不应抛异常
		expect(() => {
			lastWs.__emit('message', { data: JSON.stringify({ type: 'event', event: 'unknown', payload: {} }) });
		}).not.toThrow();
	});

	test('多个监听同一事件均被调用', async () => {
		const client = await createGatewayRpcClient({ botId: 'b1' });
		const cb1 = vi.fn();
		const cb2 = vi.fn();
		client.on('agent', cb1);
		client.on('agent', cb2);

		lastWs.__emit('message', { data: JSON.stringify({ type: 'event', event: 'agent', payload: { v: 1 } }) });
		expect(cb1).toHaveBeenCalledTimes(1);
		expect(cb2).toHaveBeenCalledTimes(1);
	});

	test('ws close 拒绝所有 pending request', async () => {
		const client = await createGatewayRpcClient({ botId: 'b1' });
		const p = client.request('slow');
		lastWs.__emit('close', { code: 1006, reason: '' });
		await expect(p).rejects.toThrow('gateway ws closed');
	});

	// --- 两阶段响应（agent RPC 协议） ---

	test('onAccepted 收到 status=accepted 时回调但不 resolve', async () => {
		const client = await createGatewayRpcClient({ botId: 'b1' });
		const onAccepted = vi.fn();
		const p = client.request('agent', { message: 'hi' }, { onAccepted });

		const sent = lastWs.sent[0];

		// Phase 1: ack
		lastWs.__emit('message', { data: JSON.stringify({
			type: 'res', id: sent.id, ok: true,
			payload: { runId: 'r1', status: 'accepted', acceptedAt: 123 },
		}) });

		expect(onAccepted).toHaveBeenCalledWith({ runId: 'r1', status: 'accepted', acceptedAt: 123 });

		// Promise 仍挂起
		let resolved = false;
		p.then(() => { resolved = true; });
		await new Promise((r) => setTimeout(r, 0));
		expect(resolved).toBe(false);

		// Phase 2: final
		lastWs.__emit('message', { data: JSON.stringify({
			type: 'res', id: sent.id, ok: true,
			payload: { runId: 'r1', status: 'ok', summary: 'done' },
		}) });

		const result = await p;
		expect(result.status).toBe('ok');
	});

	test('两阶段模式：final error 正确 reject', async () => {
		const client = await createGatewayRpcClient({ botId: 'b1' });
		const onAccepted = vi.fn();
		const p = client.request('agent', { message: 'hi' }, { onAccepted });

		const sent = lastWs.sent[0];

		// Phase 1: ack
		lastWs.__emit('message', { data: JSON.stringify({
			type: 'res', id: sent.id, ok: true,
			payload: { runId: 'r1', status: 'accepted' },
		}) });
		expect(onAccepted).toHaveBeenCalled();

		// Phase 2: error
		lastWs.__emit('message', { data: JSON.stringify({
			type: 'res', id: sent.id, ok: false,
			error: { code: 'UNAVAILABLE', message: 'agent failed' },
		}) });

		await expect(p).rejects.toThrow('agent failed');
	});

	test('两阶段模式：参数校验失败直接 reject（无 ack）', async () => {
		const client = await createGatewayRpcClient({ botId: 'b1' });
		const onAccepted = vi.fn();
		const p = client.request('agent', { message: '' }, { onAccepted });

		const sent = lastWs.sent[0];

		// 直接返回错误（无 status，无 ack）
		lastWs.__emit('message', { data: JSON.stringify({
			type: 'res', id: sent.id, ok: false,
			error: { code: 'INVALID_REQUEST', message: 'message required' },
		}) });

		expect(onAccepted).not.toHaveBeenCalled();
		await expect(p).rejects.toThrow('message required');
	});

	test('无 onAccepted 时 accepted 响应直接 resolve（向后兼容）', async () => {
		const client = await createGatewayRpcClient({ botId: 'b1' });
		const p = client.request('agent', { message: 'hi' });

		const sent = lastWs.sent[0];

		// 没有 onAccepted，accepted 直接作为结果 resolve
		lastWs.__emit('message', { data: JSON.stringify({
			type: 'res', id: sent.id, ok: true,
			payload: { runId: 'r1', status: 'accepted' },
		}) });

		const result = await p;
		expect(result.status).toBe('accepted');
	});

	test('未知中间态触发 onUnknownStatus', async () => {
		const client = await createGatewayRpcClient({ botId: 'b1' });
		const onAccepted = vi.fn();
		const onUnknownStatus = vi.fn();
		const p = client.request('agent', {}, { onAccepted, onUnknownStatus });

		const sent = lastWs.sent[0];

		// 未知 status
		lastWs.__emit('message', { data: JSON.stringify({
			type: 'res', id: sent.id, ok: true,
			payload: { runId: 'r1', status: 'processing' },
		}) });

		expect(onAccepted).not.toHaveBeenCalled();
		expect(onUnknownStatus).toHaveBeenCalledWith('processing', { runId: 'r1', status: 'processing' });

		// waiter 仍保留，终态仍能 resolve
		lastWs.__emit('message', { data: JSON.stringify({
			type: 'res', id: sent.id, ok: true,
			payload: { runId: 'r1', status: 'ok' },
		}) });

		const result = await p;
		expect(result.status).toBe('ok');
	});
});
