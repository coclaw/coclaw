// @vitest-environment node
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	buildChunks,
	createReassembler,
	FLAG_BEGIN,
	FLAG_MIDDLE,
	FLAG_END,
	HEADER_SIZE,
	MAX_CHUNKS_PER_MSG,
	ORPHAN_REMOTE_LOG_WINDOW_MS,
} from './dc-chunking.js';
import { __resetRemoteLog, useRemoteLog } from '../services/remote-log.js';
import { __resetSignalingConnection } from '../services/signaling-connection.js';

describe('dc-chunking (UI 侧)', () => {
	// --- buildChunks ---

	test('小消息不分片，返回 null', () => {
		const result = buildChunks('{"ok":true}', 100, () => 1);
		expect(result).toBeNull();
	});

	test('恰好等于 maxMessageSize 不分片', () => {
		const msg = 'x'.repeat(50);
		const byteLen = new TextEncoder().encode(msg).byteLength;
		expect(buildChunks(msg, byteLen, () => 1)).toBeNull();
	});

	test('超过 maxMessageSize 产生正确的 chunk 数组', () => {
		const msg = 'a'.repeat(31);
		let id = 0;
		const chunks = buildChunks(msg, 30, () => ++id);

		expect(chunks).not.toBeNull();
		expect(chunks.length).toBe(2);
		expect(chunks[0]).toBeInstanceOf(ArrayBuffer);

		// 验证 flag
		expect(new Uint8Array(chunks[0])[0]).toBe(FLAG_BEGIN);
		expect(new Uint8Array(chunks[1])[0]).toBe(FLAG_END);

		// 每个 chunk ≤ maxMessageSize
		for (const c of chunks) {
			expect(c.byteLength).toBeLessThanOrEqual(30);
		}
	});

	test('大消息帧格式正确（BEGIN/MIDDLE/END）', () => {
		const msg = JSON.stringify({ data: 'x'.repeat(500) });
		let id = 0;
		const chunks = buildChunks(msg, 100, () => ++id);

		expect(chunks.length).toBeGreaterThan(2);
		expect(new Uint8Array(chunks[0])[0]).toBe(FLAG_BEGIN);
		expect(new Uint8Array(chunks[chunks.length - 1])[0]).toBe(FLAG_END);
		for (let i = 1; i < chunks.length - 1; i++) {
			expect(new Uint8Array(chunks[i])[0]).toBe(FLAG_MIDDLE);
		}
	});

	test('多字节 UTF-8 字符（中文/emoji）正确分片和重组', () => {
		const msg = JSON.stringify({ msg: '你好世界🌍测试分片' });
		let id = 0;
		const chunks = buildChunks(msg, 20, () => ++id);
		expect(chunks).not.toBeNull();

		const received = [];
		const r = createReassembler((s) => received.push(s));
		for (const c of chunks) r.feed(c);

		expect(received.length).toBe(1);
		expect(JSON.parse(received[0])).toEqual(JSON.parse(msg));
	});

	// --- createReassembler ---

	test('string 消息直接回调', () => {
		const received = [];
		const r = createReassembler((s) => received.push(s));
		r.feed('{"type":"req"}');
		expect(received).toEqual(['{"type":"req"}']);
	});

	test('分片中夹杂普通 string 消息，各自独立处理', () => {
		const received = [];
		const r = createReassembler((s) => received.push(s));
		const original = 'CHUNKED_DATA_12345678901234567890';
		let id = 0;
		const chunks = buildChunks(original, 20, () => ++id);

		// 发前半 chunk
		r.feed(chunks[0]);
		// 插入普通消息
		r.feed('{"type":"event"}');
		// 发剩余 chunk
		for (let i = 1; i < chunks.length; i++) r.feed(chunks[i]);

		expect(received.length).toBe(2);
		expect(received[0]).toBe('{"type":"event"}');
		expect(received[1]).toBe(original);
	});

	// --- 静默 drop 分支可观测性 ---

	describe('drop 分支日志', () => {
		let warnSpy;
		let remoteLogs;

		beforeEach(() => {
			warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			__resetRemoteLog();
			remoteLogs = [];
			useRemoteLog().setSender((msg) => {
				for (const e of msg.logs) remoteLogs.push(e.text);
			});
		});

		afterEach(() => {
			warnSpy.mockRestore();
			// 顺序：先 sigConn 后 remote-log，避免 sigConn disconnect 事件命中已 reset 的 remote-log 单例
			__resetSignalingConnection();
			__resetRemoteLog();
			vi.restoreAllMocks();
		});

		function makeChunk(flag, msgId, payload = '') {
			const bytes = new TextEncoder().encode(payload);
			const buf = new Uint8Array(HEADER_SIZE + bytes.length);
			buf[0] = flag;
			new DataView(buf.buffer).setUint32(1, msgId, false);
			buf.set(bytes, HEADER_SIZE);
			return buf.buffer;
		}

		async function flushRemote() {
			// useRemoteLog 内部 setTimeout 0 batch；让 microtask + macrotask 都跑一遍
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));
		}

		test('orphan chunk（非 BEGIN + pending miss）console.warn + remoteLog 各一条', async () => {
			const r = createReassembler(() => {});
			r.feed(makeChunk(FLAG_END, 42, 'tail'));

			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0][0]).toMatch(/orphan-chunk flag=END msgId=42/);
			await flushRemote();
			expect(remoteLogs).toHaveLength(1);
			expect(remoteLogs[0]).toMatch(/reassembler\.orphan flag=END msgId=42 suppressed=0/);
		});

		test('窗口期内连续 orphan：console.warn 每次都打，remoteLog 仅首条', async () => {
			const nowSpy = vi.spyOn(Date, 'now');
			const baseline = 1_000_000;
			const r = createReassembler(() => {});

			for (let i = 0; i < 3; i++) {
				nowSpy.mockReturnValue(baseline + i * 100);
				r.feed(makeChunk(FLAG_MIDDLE, 100 + i));
			}

			expect(warnSpy).toHaveBeenCalledTimes(3);
			nowSpy.mockRestore();
			await flushRemote();
			expect(remoteLogs).toHaveLength(1);
			expect(remoteLogs[0]).toMatch(/reassembler\.orphan/);
			expect(remoteLogs[0]).toMatch(/suppressed=0/);
		});

		test('窗口耗尽后下一条 orphan 触发新 remoteLog 并带 suppressed 累计数', async () => {
			const nowSpy = vi.spyOn(Date, 'now');
			const baseline = 1_000_000;
			nowSpy.mockReturnValue(baseline);
			const r = createReassembler(() => {});

			r.feed(makeChunk(FLAG_END, 1));
			await flushRemote();
			r.feed(makeChunk(FLAG_END, 2));
			r.feed(makeChunk(FLAG_END, 3));
			nowSpy.mockReturnValue(baseline + ORPHAN_REMOTE_LOG_WINDOW_MS + 1);
			r.feed(makeChunk(FLAG_END, 4));

			nowSpy.mockRestore();
			await flushRemote();
			expect(remoteLogs).toHaveLength(2);
			expect(remoteLogs[0]).toMatch(/suppressed=0/);
			expect(remoteLogs[1]).toMatch(/msgId=4 suppressed=2/);
		});

		test('short-frame 仅 console.warn 不触发 remoteLog', async () => {
			const r = createReassembler(() => {});
			r.feed(new Uint8Array(2).buffer);

			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0][0]).toMatch(/short-frame bytes=2/);
			await flushRemote();
			expect(remoteLogs).toHaveLength(0);
		});

		test('chunk 数超 MAX_CHUNKS_PER_MSG：警告 + 丢弃 pending', async () => {
			const r = createReassembler(() => {});
			r.feed(makeChunk(FLAG_BEGIN, 99, 'x'));
			// BEGIN 已占 chunks[0]；再喂 (MAX-1) 个 MIDDLE 把 chunks 推到 MAX，第 MAX+1 次触发 cap
			for (let i = 0; i < MAX_CHUNKS_PER_MSG - 1; i++) {
				r.feed(makeChunk(FLAG_MIDDLE, 99, 'x'));
			}
			expect(warnSpy).toHaveBeenCalledTimes(0);
			r.feed(makeChunk(FLAG_MIDDLE, 99, 'x'));
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0][0]).toMatch(/oversize msgId=99/);
			// pending 已清，再喂 END 走 orphan 分支
			r.feed(makeChunk(FLAG_END, 99, 'tail'));
			expect(warnSpy.mock.calls.at(-1)[0]).toMatch(/orphan-chunk/);
			await flushRemote();
			// remoteLog 仅来自 orphan，不来自 oversize
			expect(remoteLogs).toHaveLength(1);
			expect(remoteLogs[0]).toMatch(/reassembler\.orphan/);
		});

		test('begin-overwrite 仅 console.warn 不触发 remoteLog', async () => {
			const r = createReassembler(() => {});
			r.feed(makeChunk(FLAG_BEGIN, 7, 'a'));
			r.feed(makeChunk(FLAG_BEGIN, 7, 'b'));

			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0][0]).toMatch(/begin-overwrite msgId=7/);
			await flushRemote();
			expect(remoteLogs).toHaveLength(0);
		});
	});

	test('reset 清空缓冲区', () => {
		const received = [];
		const r = createReassembler((s) => received.push(s));

		// 发 BEGIN 不发 END
		const buf = new Uint8Array(HEADER_SIZE + 5);
		buf[0] = FLAG_BEGIN;
		new DataView(buf.buffer).setUint32(1, 1, false);
		buf.set(new TextEncoder().encode('hello'), HEADER_SIZE);
		r.feed(buf.buffer);

		r.reset();

		// END 不应重组
		const end = new Uint8Array(HEADER_SIZE + 5);
		end[0] = FLAG_END;
		new DataView(end.buffer).setUint32(1, 1, false);
		end.set(new TextEncoder().encode('world'), HEADER_SIZE);
		r.feed(end.buffer);

		expect(received.length).toBe(0);
	});
});

