// @vitest-environment node
import { describe, test, expect, vi, afterEach } from 'vitest';
import {
	RemoteLog, useRemoteLog, remoteLog, __resetRemoteLog,
	clearRemoteLogBuffer, MAX_BUFFER, BATCH_SIZE,
} from './remote-log.js';
import {
	useSignalingConnection, __resetSignalingConnection,
} from './signaling-connection.js';

afterEach(() => {
	// 先 reset sigConn（触发 disconnect 事件时 remote-log 实例还在），再 reset remote-log
	__resetSignalingConnection();
	__resetRemoteLog();
});

describe('RemoteLog 类', () => {
	test('log() 将条目推入缓冲区（含 ts 和 text）', () => {
		const rl = new RemoteLog();
		rl.log('hello');
		expect(rl.__buffer).toHaveLength(1);
		expect(rl.__buffer[0].text).toBe('hello');
		expect(typeof rl.__buffer[0].ts).toBe('number');
	});

	test('缓冲区满时丢弃最旧条目', () => {
		const rl = new RemoteLog();
		for (let i = 0; i < MAX_BUFFER + 5; i++) {
			rl.log(`msg-${i}`);
		}
		expect(rl.__buffer).toHaveLength(MAX_BUFFER);
		expect(rl.__buffer[0].text).toBe('msg-5');
		expect(rl.__buffer[MAX_BUFFER - 1].text).toBe(`msg-${MAX_BUFFER + 4}`);
	});

	test('无 sender 时仅缓冲不发送', () => {
		const rl = new RemoteLog();
		rl.log('buffered');
		expect(rl.__buffer).toHaveLength(1);
	});

	test('setSender 注入后自动 flush 缓冲区', async () => {
		const rl = new RemoteLog();
		rl.log('a');
		rl.log('b');
		const sent = [];
		rl.setSender((msg) => sent.push(msg));
		await vi.waitFor(() => expect(rl.__buffer).toHaveLength(0));
		expect(sent).toHaveLength(1);
		expect(sent[0].type).toBe('log');
		expect(sent[0].logs.map(l => l.text)).toEqual(['a', 'b']);
	});

	test('log() 在 sender 可用时自动 flush', async () => {
		const rl = new RemoteLog();
		const sent = [];
		rl.setSender((msg) => sent.push(msg));
		await vi.waitFor(() => expect(rl.__flushing).toBe(false));
		rl.log('live');
		await vi.waitFor(() => expect(rl.__buffer).toHaveLength(0));
		expect(sent.some(m => m.logs.some(l => l.text === 'live'))).toBe(true);
	});

	test('flush 按 BATCH_SIZE 分批发送', async () => {
		const rl = new RemoteLog();
		const count = BATCH_SIZE * 2 + 3;
		for (let i = 0; i < count; i++) {
			rl.log(`item-${i}`);
		}
		const sent = [];
		rl.setSender((msg) => sent.push(msg));
		await vi.waitFor(() => expect(rl.__buffer).toHaveLength(0));
		expect(sent).toHaveLength(3);
		expect(sent[0].logs).toHaveLength(BATCH_SIZE);
		expect(sent[1].logs).toHaveLength(BATCH_SIZE);
		expect(sent[2].logs).toHaveLength(3);
	});

	test('sender 抛异常时停止 flush 并保留缓冲区', async () => {
		const rl = new RemoteLog();
		rl.log('a');
		rl.log('b');
		let callCount = 0;
		rl.setSender(() => { callCount++; throw new Error('fail'); });
		await new Promise(r => setTimeout(r, 20));
		expect(callCount).toBe(1);
		expect(rl.__buffer).toHaveLength(2);
	});

	// __sendRaw 在 WS 不可用 / send 内部失败时返回 false（不抛）。
	// 旧实现忽略返回值直接 splice，导致这一批 log 静默丢失（"WS 看似 connected
	// 但马上要断" 的窗口尤其常见）。修法：返回 false → 中断 flush 保留缓冲。
	test('sender 返回 false 时不 splice，缓冲区保留供下次 flush', async () => {
		const rl = new RemoteLog();
		rl.log('a');
		rl.log('b');
		let callCount = 0;
		rl.setSender(() => { callCount++; return false; });
		await new Promise(r => setTimeout(r, 20));
		expect(callCount).toBe(1);
		// 关键：返回 false 视为发送未成功，缓冲不被清
		expect(rl.__buffer).toHaveLength(2);
		expect(rl.__buffer[0].text).toBe('a');
		expect(rl.__buffer[1].text).toBe('b');

		// 下次 setSender（成功 sender）应能把缓冲发出去
		const sent = [];
		rl.setSender((msg) => { sent.push(msg); });
		await vi.waitFor(() => expect(rl.__buffer).toHaveLength(0));
		expect(sent).toHaveLength(1);
		expect(sent[0].logs.map((l) => l.text)).toEqual(['a', 'b']);
	});

	test('clearBuffer 清空缓冲区', () => {
		const rl = new RemoteLog();
		rl.log('a');
		rl.log('b');
		expect(rl.__buffer).toHaveLength(2);
		rl.clearBuffer();
		expect(rl.__buffer).toHaveLength(0);
	});

	test('sender 置 null 后 flush 中断', async () => {
		const rl = new RemoteLog();
		for (let i = 0; i < BATCH_SIZE + 5; i++) {
			rl.log(`msg-${i}`);
		}
		const sent = [];
		rl.setSender((msg) => {
			sent.push(msg);
			rl.setSender(null); // 第一批发送后断开
		});
		await new Promise(r => setTimeout(r, 50));
		expect(sent).toHaveLength(1);
		expect(sent[0].logs).toHaveLength(BATCH_SIZE);
		expect(rl.__buffer).toHaveLength(5);
	});
});

describe('useRemoteLog 单例 + SignalingConnection 集成', () => {
	test('useRemoteLog 返回单例', () => {
		const a = useRemoteLog();
		const b = useRemoteLog();
		expect(a).toBe(b);
	});

	test('__resetRemoteLog 清空单例', () => {
		const a = useRemoteLog();
		__resetRemoteLog();
		const b = useRemoteLog();
		expect(a).not.toBe(b);
	});

	test('remoteLog 便捷函数自动初始化并缓冲', () => {
		remoteLog('test-msg');
		const rl = useRemoteLog();
		expect(rl.__buffer).toHaveLength(1);
		expect(rl.__buffer[0].text).toBe('test-msg');
	});

	test('sigConn 状态变为 connected 时注入 sender 并 flush', async () => {
		// 先初始化 sigConn 单例（MockWebSocket）
		class MockWS {
			constructor() { this.readyState = 0; this.__listeners = {}; this.sent = []; }
			addEventListener(e, cb) { (this.__listeners[e] ??= []).push(cb); }
			removeEventListener() {}
			send(d) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(d); }
			close() { this.readyState = 3; }
		}
		const sigConn = useSignalingConnection({ WebSocket: MockWS });

		const rl = useRemoteLog();
		rl.log('before-connect');
		expect(rl.__buffer).toHaveLength(1);

		// 模拟 sigConn 状态变为 connected
		sigConn.connect();
		const ws = sigConn.__ws;
		ws.readyState = 1;
		(ws.__listeners['open'] ?? []).forEach(cb => cb());

		await vi.waitFor(() => expect(rl.__buffer).toHaveLength(0));
		const logMsg = ws.sent.find(s => {
			try { return JSON.parse(s).type === 'log'; } catch { return false; }
		});
		expect(logMsg).toBeTruthy();
		expect(JSON.parse(logMsg).logs[0].text).toBe('before-connect');
	});

	test('sigConn 断开时清除 sender', async () => {
		class MockWS {
			constructor() { this.readyState = 0; this.__listeners = {}; this.sent = []; }
			addEventListener(e, cb) { (this.__listeners[e] ??= []).push(cb); }
			removeEventListener() {}
			send(d) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(d); }
			close() { this.readyState = 3; (this.__listeners['close'] ?? []).forEach(cb => cb({ code: 1000 })); }
		}
		const sigConn = useSignalingConnection({ WebSocket: MockWS });
		sigConn.connect();
		const ws = sigConn.__ws;
		ws.readyState = 1;
		(ws.__listeners['open'] ?? []).forEach(cb => cb());

		const rl = useRemoteLog();
		await vi.waitFor(() => expect(rl.__flushing).toBe(false));

		// 断开
		sigConn.disconnect();
		const sentBefore = ws.sent.length;
		rl.log('after-disconnect');
		await new Promise(r => setTimeout(r, 20));
		expect(ws.sent.length).toBe(sentBefore);
		expect(rl.__buffer.length).toBeGreaterThanOrEqual(1);
	});

	test('clearRemoteLogBuffer 清空单例缓冲区；未初始化时为 no-op', () => {
		// 未初始化时为 no-op，不抛异常
		expect(() => clearRemoteLogBuffer()).not.toThrow();

		// 初始化后清空
		const rl = useRemoteLog();
		rl.log('pending');
		expect(rl.__buffer).toHaveLength(1);
		clearRemoteLogBuffer();
		expect(rl.__buffer).toHaveLength(0);
	});

	test('sigConn 已 connected 时 useRemoteLog 立即注入 sender', async () => {
		class MockWS {
			constructor() { this.readyState = 0; this.__listeners = {}; this.sent = []; }
			addEventListener(e, cb) { (this.__listeners[e] ??= []).push(cb); }
			removeEventListener() {}
			send(d) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(d); }
			close() { this.readyState = 3; }
		}
		const sigConn = useSignalingConnection({ WebSocket: MockWS });
		sigConn.connect();
		const ws = sigConn.__ws;
		ws.readyState = 1;
		(ws.__listeners['open'] ?? []).forEach(cb => cb());

		// sigConn 已 connected，此时初始化 remoteLog
		const rl = useRemoteLog();
		rl.log('immediate');
		await vi.waitFor(() => expect(rl.__buffer).toHaveLength(0));
		const logMsg = ws.sent.find(s => {
			try { return JSON.parse(s).type === 'log'; } catch { return false; }
		});
		expect(logMsg).toBeTruthy();
	});
});
