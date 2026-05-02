import test from 'node:test';
import assert from 'node:assert/strict';

import {
	RpcDcSender,
	DC_HIGH_WATER_MARK,
	DC_LOW_WATER_MARK,
	MAX_SINGLE_MSG_BYTES,
} from './rpc-dc-sender.js';
import { HEADER_SIZE } from './dc-chunking.js';
import { __reset as resetRemoteLog, __buffer as remoteLogBuffer } from '../remote-log.js';

// --- helpers ---

function makeMockDc({ bufferedAmount = 0, readyState = 'open' } = {}) {
	const sent = [];
	const dc = {
		readyState,
		bufferedAmount,
		bufferedAmountLowThreshold: 0,
		sendShouldThrow: false,
		sendThrowAt: -1,
		__sendCount: 0,
		send(data) {
			dc.__sendCount += 1;
			if (dc.sendShouldThrow || (dc.sendThrowAt >= 0 && dc.__sendCount > dc.sendThrowAt)) {
				throw new Error('mock dc.send error');
			}
			const len = typeof data === 'string'
				? Buffer.byteLength(data, 'utf8')
				: data.length;
			dc.bufferedAmount += len;
			sent.push(data);
		},
	};
	dc.sent = sent;
	return dc;
}

function makeMockLogger() {
	const warnings = [];
	const infos = [];
	return {
		warnings,
		infos,
		info(msg) { infos.push(String(msg)); },
		warn(msg) { warnings.push(String(msg)); },
		error() {},
		debug() {},
	};
}

let globalMsgId = 0;
function nextMsgId() { return ++globalMsgId; }

function makeSender(dcOpts = {}, opts = {}) {
	const dc = makeMockDc(dcOpts);
	const logger = makeMockLogger();
	const sender = new RpcDcSender({
		dc,
		maxMessageSize: opts.maxMessageSize ?? 1000,
		getNextMsgId: opts.getNextMsgId ?? nextMsgId,
		logger,
		tag: opts.tag ?? 'conn=T',
	});
	return { dc, logger, sender };
}

function jsonOfBytes(size) {
	if (size < 2) throw new Error('size too small');
	return '"' + 'x'.repeat(size - 2) + '"';
}

async function flushMicrotasks() {
	for (let i = 0; i < 5; i += 1) {
		await new Promise((r) => setImmediate(r));
	}
}

// --- 构造器 ---

test('RpcDcSender: 不传 dc 抛异常', () => {
	assert.throws(
		() => new RpcDcSender({ dc: null, maxMessageSize: 100, getNextMsgId: nextMsgId }),
		/dc is required/,
	);
});

test('RpcDcSender: 不传 opts 也抛 dc is required', () => {
	assert.throws(() => new RpcDcSender(), /dc is required/);
});

test('RpcDcSender: 不传 logger fallback 到 console', () => {
	const dc = makeMockDc();
	const sender = new RpcDcSender({ dc, maxMessageSize: 1000, getNextMsgId: nextMsgId });
	assert.equal(sender.logger, console);
});

// --- send 基础（fast-path / 阻塞）---

test('send: 空闲 bufferedAmount → 单条 string 立即发送', async () => {
	resetRemoteLog();
	const { dc, sender } = makeSender();
	await sender.send('{"ok":true}');
	assert.equal(dc.sent.length, 1);
	assert.equal(dc.sent[0], '{"ok":true}');
});

test('send: 大消息分片 → 全部 chunk 顺序发出', async () => {
	resetRemoteLog();
	const { dc, sender } = makeSender({}, { maxMessageSize: 100 });
	const big = jsonOfBytes(500);
	await sender.send(big);
	assert.ok(dc.sent.length >= 5);
	// 全 binary 帧（分片 chunk）
	for (const s of dc.sent) assert.ok(Buffer.isBuffer(s));
	// 同一消息 msgId 一致
	const msgId = dc.sent[0].readUInt32BE(1);
	for (const s of dc.sent) assert.equal(s.readUInt32BE(1), msgId);
});

test('send: bufferedAmount 顶到 HIGH → 阻塞，BAL 唤醒后继续', async () => {
	resetRemoteLog();
	const { dc, sender } = makeSender({ bufferedAmount: DC_HIGH_WATER_MARK }, { maxMessageSize: 1000 });
	const sendP = sender.send('{"x":1}');
	// 让 send 进入 __waitForRoom 阻塞
	await flushMicrotasks();
	// 此时不应已发送
	assert.equal(dc.sent.length, 0);
	assert.equal(sender.balWaiters.length, 1);

	// 模拟 SACK：bufferedAmount 降下来 → 触发 BAL
	dc.bufferedAmount = 0;
	sender.onBufferedAmountLow();
	await sendP;
	assert.equal(dc.sent.length, 1);
	assert.equal(sender.balWaiters.length, 0);
});

test('send: 多 chunk 中途阻塞，BAL 唤醒后继续到下一个', async () => {
	resetRemoteLog();
	const { dc, sender } = makeSender({}, { maxMessageSize: 100 });
	// 第一次 dc.send 后人为顶满 bufferedAmount
	const origSend = dc.send;
	let call = 0;
	dc.send = function (data) {
		call += 1;
		origSend.call(dc, data);
		if (call === 1) dc.bufferedAmount = DC_HIGH_WATER_MARK;
	};
	const sendP = sender.send(jsonOfBytes(500));
	await flushMicrotasks();
	// 应已发出 1 个 chunk 后阻塞
	assert.equal(dc.sent.length, 1);
	assert.equal(sender.balWaiters.length, 1);

	dc.bufferedAmount = 0;
	sender.onBufferedAmountLow();
	await flushMicrotasks();
	// 阻塞解除后会继续发送，可能再次顶到 HIGH（每次发完都设回 HIGH）
	// 所以反复 BAL 直到完成
	while (sender.balWaiters.length > 0) {
		dc.bufferedAmount = 0;
		sender.onBufferedAmountLow();
		await flushMicrotasks();
	}
	await sendP;
	assert.ok(dc.sent.length >= 5);
});

// --- 错误协议 ---

test('send: closed 后立即抛 SENDER_CLOSED', async () => {
	resetRemoteLog();
	const { sender } = makeSender();
	sender.close();
	await assert.rejects(sender.send('{"x":1}'), (err) => err.code === 'SENDER_CLOSED');
});

test('send: dc.readyState !== open → 抛 SENDER_CLOSED', async () => {
	resetRemoteLog();
	const { sender } = makeSender({ readyState: 'connecting' });
	await assert.rejects(sender.send('{"x":1}'), (err) => err.code === 'SENDER_CLOSED');
});

test('send: payload > MAX_SINGLE_MSG_BYTES → 抛 MESSAGE_OVERSIZED', async () => {
	resetRemoteLog();
	const { dc, logger, sender } = makeSender({}, { maxMessageSize: 60 * 1024 * 1024 });
	const huge = jsonOfBytes(MAX_SINGLE_MSG_BYTES + 100);
	await assert.rejects(sender.send(huge), (err) => err.code === 'MESSAGE_OVERSIZED');
	assert.equal(dc.sent.length, 0);
	assert.ok(logger.warnings.some((w) => w.includes('single-msg-oversize')));
});

test('send: payload 恰好 == MAX_SINGLE_MSG_BYTES → 接受', async () => {
	resetRemoteLog();
	const { sender } = makeSender({ bufferedAmount: 0 }, { maxMessageSize: 60 * 1024 * 1024 });
	const payload = jsonOfBytes(MAX_SINGLE_MSG_BYTES);
	// 不应抛
	await sender.send(payload);
});

test('send: buildChunks 抛 → 抛 BUILD_CHUNKS_FAILED 含 cause + remoteLog', async () => {
	resetRemoteLog();
	const { dc, logger, sender } = makeSender({}, { maxMessageSize: HEADER_SIZE });
	await assert.rejects(
		sender.send(jsonOfBytes(100)),
		(err) => err.code === 'BUILD_CHUNKS_FAILED' && err.cause instanceof Error,
	);
	assert.equal(dc.sent.length, 0);
	assert.ok(logger.warnings.some((w) => w.includes('build-chunks-failed')));
	assert.ok(remoteLogBuffer.some((e) => e.text.includes('rpc-dc-sender.build-chunks-failed')));
});

test('send: 分片路径 dc.send 抛 → SENDER_CLOSED 含 cause，剩余 chunks 不发', async () => {
	resetRemoteLog();
	const { dc, logger, sender } = makeSender({}, { maxMessageSize: 100 });
	dc.sendThrowAt = 2; // 第 3 次起抛
	await assert.rejects(
		sender.send(jsonOfBytes(500)),
		(err) => err.code === 'SENDER_CLOSED' && err.cause instanceof Error,
	);
	// 前 2 个 chunk 已发，第 3 个抛 → 后续不再尝试
	assert.equal(dc.sent.length, 2);
	assert.ok(logger.warnings.some((w) => w.includes('dc.send failed')));
});

test('send: 单条路径 dc.send 抛 → SENDER_CLOSED', async () => {
	resetRemoteLog();
	const { dc, sender } = makeSender({}, { maxMessageSize: 10000 });
	dc.sendShouldThrow = true;
	await assert.rejects(
		sender.send('{"small":true}'),
		(err) => err.code === 'SENDER_CLOSED',
	);
	assert.equal(dc.sent.length, 0);
});

// --- close 协议 ---

test('close: 阻塞中的 send 会被 reject SENDER_CLOSED', async () => {
	resetRemoteLog();
	const { sender } = makeSender({ bufferedAmount: DC_HIGH_WATER_MARK });
	const p = sender.send('{"x":1}');
	await flushMicrotasks();
	assert.equal(sender.balWaiters.length, 1);
	sender.close();
	await assert.rejects(p, (err) => err.code === 'SENDER_CLOSED');
	assert.equal(sender.balWaiters.length, 0);
});

test('close: 多个并发阻塞 send 全部 reject', async () => {
	resetRemoteLog();
	const { sender } = makeSender({ bufferedAmount: DC_HIGH_WATER_MARK });
	const p1 = sender.send('"a"');
	const p2 = sender.send('"b"');
	await flushMicrotasks();
	assert.equal(sender.balWaiters.length, 2);
	sender.close();
	await assert.rejects(p1, (err) => err.code === 'SENDER_CLOSED');
	await assert.rejects(p2, (err) => err.code === 'SENDER_CLOSED');
});

test('close: BAL 唤醒与 close 竞速 → continuation 重检 closed 不再写 dc', async () => {
	resetRemoteLog();
	const { dc, sender } = makeSender({ bufferedAmount: DC_HIGH_WATER_MARK });
	const p = sender.send('{"x":1}');
	await flushMicrotasks();
	assert.equal(sender.balWaiters.length, 1);

	// 模拟窄缝：BAL 先 splice 走 waiter 并 resolve（sync），紧接着 close（balWaiters 已空，
	// close 看不到 waiter 不 reject）。此时 continuation 尚未执行；唤醒后应重检 closed
	// 并抛 SENDER_CLOSED，避免在标记 closed 后又写一帧到 dc。
	sender.onBufferedAmountLow();
	sender.close();
	await assert.rejects(p, (err) => err.code === 'SENDER_CLOSED');
	assert.equal(dc.__sendCount, 0);
});

test('close: 幂等', () => {
	const { sender } = makeSender();
	sender.close();
	assert.equal(sender.closed, true);
	// 第二次不抛
	assert.doesNotThrow(() => sender.close());
});

test('close: 无 pending waiter 也安全', () => {
	const { sender } = makeSender();
	assert.doesNotThrow(() => sender.close());
});

// --- onBufferedAmountLow 行为 ---

test('onBufferedAmountLow: 无 pending waiter 不抛', () => {
	const { sender } = makeSender();
	assert.doesNotThrow(() => sender.onBufferedAmountLow());
});

test('onBufferedAmountLow: 唤醒所有 pending waiter（一次 splice）', async () => {
	resetRemoteLog();
	const { dc, sender } = makeSender({ bufferedAmount: DC_HIGH_WATER_MARK });
	const p1 = sender.send('"a"');
	const p2 = sender.send('"b"');
	await flushMicrotasks();
	assert.equal(sender.balWaiters.length, 2);

	// 让 dc.send 不再加 bufferedAmount，避免 send 完后又顶满
	dc.bufferedAmount = 0;
	dc.send = function (data) {
		dc.sent.push(data);
	};
	sender.onBufferedAmountLow();
	await Promise.all([p1, p2]);
	assert.equal(dc.sent.length, 2);
});

// --- maxMessageSize 热更新 ---

test('maxMessageSize 热更新：下次 send 用新值', async () => {
	resetRemoteLog();
	const { dc, sender } = makeSender({}, { maxMessageSize: 1000 });
	// 第一条小消息：1000 阈值下不分片
	await sender.send(jsonOfBytes(500));
	assert.equal(dc.sent.length, 1);
	assert.equal(typeof dc.sent[0], 'string');

	// 把阈值降到 100 → 同样大小的 payload 现在需要分片
	sender.maxMessageSize = 100;
	dc.sent.length = 0;
	dc.bufferedAmount = 0;
	await sender.send(jsonOfBytes(500));
	assert.ok(dc.sent.length >= 5, 'should split into chunks under new maxMessageSize');
	for (const s of dc.sent) assert.ok(Buffer.isBuffer(s));
});

// --- safe wrapper / tag ---

test('tag 缺省时日志不带前缀', async () => {
	resetRemoteLog();
	const dc = makeMockDc();
	const logger = makeMockLogger();
	const sender = new RpcDcSender({
		dc,
		maxMessageSize: HEADER_SIZE, // 触发 buildChunks 抛 → __safeWarn
		getNextMsgId: nextMsgId,
		logger,
	});
	await assert.rejects(sender.send(jsonOfBytes(100)));
	// 日志中无 conn=
	assert.ok(logger.warnings.every((w) => !w.includes('conn=')));
});

test('logger 缺 warn 方法时不抛（?./?? fallback）', async () => {
	const dc = makeMockDc();
	const sender = new RpcDcSender({
		dc,
		maxMessageSize: HEADER_SIZE,
		getNextMsgId: nextMsgId,
		logger: {},
	});
	await assert.rejects(sender.send(jsonOfBytes(100)));
});

test('logger.warn 自身抛 → send 抛的仍是协议错（safe wrapper 兜底）', async () => {
	const dc = makeMockDc();
	const evilLogger = {
		warn: () => { throw new Error('logger broken'); },
		info: () => {},
	};
	const sender = new RpcDcSender({
		dc,
		maxMessageSize: HEADER_SIZE,
		getNextMsgId: nextMsgId,
		logger: evilLogger,
	});
	await assert.rejects(
		sender.send(jsonOfBytes(100)),
		(err) => err.code === 'BUILD_CHUNKS_FAILED',
	);
});

// --- 常量 sanity ---

test('常量值符合设计（DC_LOW < DC_HIGH < MAX_SINGLE_MSG）', () => {
	assert.ok(DC_LOW_WATER_MARK < DC_HIGH_WATER_MARK);
	assert.ok(DC_HIGH_WATER_MARK < MAX_SINGLE_MSG_BYTES);
	assert.equal(DC_HIGH_WATER_MARK, 1024 * 1024);
	assert.equal(DC_LOW_WATER_MARK, 256 * 1024);
	assert.equal(MAX_SINGLE_MSG_BYTES, 50 * 1024 * 1024);
});

// --- 边界：close 后 onBufferedAmountLow 仍可调（不抛）---

test('close 后 onBufferedAmountLow 调用不抛（balWaiters 已空）', () => {
	const { sender } = makeSender();
	sender.close();
	assert.doesNotThrow(() => sender.onBufferedAmountLow());
});

// --- 边界：chunk 间 readyState/close 状态变化（__waitForRoom 早抛分支）---

test('chunk 间 dc.readyState 飞升 closing → 下一轮 __waitForRoom 早抛 SENDER_CLOSED', async () => {
	resetRemoteLog();
	const { dc, sender } = makeSender({}, { maxMessageSize: 100 });
	const origSend = dc.send;
	let call = 0;
	dc.send = function (data) {
		call += 1;
		origSend.call(dc, data);
		// 第一个 chunk 发完后切 closing：下一次 __waitForRoom 入口会看到 readyState 非 open
		if (call === 1) dc.readyState = 'closing';
	};
	await assert.rejects(
		sender.send(jsonOfBytes(500)),
		(err) => err.code === 'SENDER_CLOSED',
	);
	assert.equal(dc.sent.length, 1);
});

test('chunk 间 sender.close() → 下一轮 __waitForRoom 早抛 SENDER_CLOSED', async () => {
	resetRemoteLog();
	const { dc, sender } = makeSender({}, { maxMessageSize: 100 });
	const origSend = dc.send;
	let call = 0;
	dc.send = function (data) {
		call += 1;
		origSend.call(dc, data);
		if (call === 1) sender.close();
	};
	await assert.rejects(
		sender.send(jsonOfBytes(500)),
		(err) => err.code === 'SENDER_CLOSED',
	);
	assert.equal(dc.sent.length, 1);
});

// --- 边界：__waitForRoom 中 readyState 飞升 closing 之间 dc.send 抛 ---

test('readyState 飞升 closing 期间 dc.send 抛 → SENDER_CLOSED', async () => {
	resetRemoteLog();
	const { dc, sender } = makeSender({}, { maxMessageSize: 100 });
	const origSend = dc.send;
	let call = 0;
	dc.send = function (data) {
		call += 1;
		if (call === 3) {
			dc.readyState = 'closing';
			throw new Error('InvalidStateError: not open');
		}
		origSend.call(dc, data);
	};
	await assert.rejects(
		sender.send(jsonOfBytes(500)),
		(err) => err.code === 'SENDER_CLOSED',
	);
	// 前 2 个 chunk 成功
	assert.equal(dc.sent.length, 2);
});
