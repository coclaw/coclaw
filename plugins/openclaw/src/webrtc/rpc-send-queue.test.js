import test from 'node:test';
import assert from 'node:assert/strict';
import {
	RpcSendQueue,
	DC_HIGH_WATER_MARK,
	DC_LOW_WATER_MARK,
	MAX_QUEUE_BYTES,
	MAX_SINGLE_MSG_BYTES,
} from './rpc-send-queue.js';
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
		sendThrowAt: -1, // 在第 N 次 send 时抛（-1=不抛）
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
	return {
		warnings,
		info() {},
		warn(msg) { warnings.push(String(msg)); },
		error() {},
		debug() {},
	};
}

let globalMsgId = 0;
function nextMsgId() { return ++globalMsgId; }

function makeQueue(dcOpts = {}, queueOpts = {}) {
	const dc = makeMockDc(dcOpts);
	const logger = makeMockLogger();
	const q = new RpcSendQueue({
		dc,
		maxMessageSize: queueOpts.maxMessageSize ?? 1000,
		getNextMsgId: queueOpts.getNextMsgId ?? nextMsgId,
		logger,
		tag: queueOpts.tag ?? 'conn=T',
	});
	return { dc, logger, q };
}

// 构造恰好 `size` bytes（UTF-8）的 ASCII JSON 字符串
function jsonOfBytes(size) {
	// JSON 字符串形如 '"xxxx..."'：2 字节的 quote + n 个 x
	if (size < 2) throw new Error('size too small');
	return '"' + 'x'.repeat(size - 2) + '"';
}

// --- 构造器 ---

test('RpcSendQueue: 不传 dc 抛异常', () => {
	assert.throws(
		() => new RpcSendQueue({ dc: null, maxMessageSize: 100, getNextMsgId: nextMsgId }),
		/dc is required/,
	);
});

// --- 核心行为 ---

test('send: 空队列 + 低 bufferedAmount → 小消息 fast-path 直发（不进队列）', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 1000 });
	const ok = q.send('{"ok":true}');
	assert.equal(ok, true);
	assert.equal(dc.sent.length, 1);
	assert.equal(dc.sent[0], '{"ok":true}');
	assert.equal(q.queue.length, 0);
	assert.equal(q.queueBytes, 0);
});

test('send: 大消息 fast-path 部分发送（顶到 HIGH 暂停），剩余入队', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({ bufferedAmount: 0 }, { maxMessageSize: 1000 });
	// 构造 10 MB 消息 → 大概 10485 chunks
	const payload = jsonOfBytes(10 * 1024 * 1024);
	const ok = q.send(payload);
	assert.equal(ok, true);
	// fast-path 应发到 bufferedAmount >= HIGH 就停
	assert.ok(dc.sent.length > 0, 'fast-path should have sent some chunks');
	assert.ok(dc.bufferedAmount >= DC_HIGH_WATER_MARK, 'bufferedAmount should reach HIGH');
	// 剩余 chunks 入队
	assert.ok(q.queue.length > 0, 'residual chunks should be queued');
	assert.ok(q.queueBytes > 0);
});

test('send: 队列非空时，新消息的 chunks 全部入队（不插队）', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 100 });
	// 先塞满使 fast-path 暂停
	dc.bufferedAmount = DC_HIGH_WATER_MARK;
	q.send('"first msg fits one chunk"');
	const queueLenAfterFirst = q.queue.length;
	assert.ok(queueLenAfterFirst > 0, 'first message should be queued (bufferedAmount at HIGH)');

	// 第二条消息应全部追加到队尾（dc.sent 不增加）
	const sentBefore = dc.sent.length;
	q.send('"second"');
	assert.equal(dc.sent.length, sentBefore, 'no fast-path when queue non-empty');
	assert.ok(q.queue.length > queueLenAfterFirst);
});

test('drain: bufferedamountlow 事件触发顺序发送至 HIGH 再暂停或排空', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 100 });
	// 塞满 bufferedAmount，让所有 chunks 入队
	dc.bufferedAmount = DC_HIGH_WATER_MARK;
	q.send(jsonOfBytes(500));
	const initialQueueLen = q.queue.length;
	assert.ok(initialQueueLen > 0);

	// 模拟 SACK：bufferedAmount 降到 0
	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();

	// 全部 drain 到 dc.sent（bufferedAmount 单增，远未到 HIGH）
	assert.equal(q.queue.length, 0);
	assert.equal(q.queueBytes, 0);
	assert.equal(dc.sent.length, initialQueueLen);
});

test('drain: 部分排空（HIGH 再次顶到）→ 剩余保留在队列', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 100 });
	dc.bufferedAmount = DC_HIGH_WATER_MARK;
	q.send(jsonOfBytes(200_000));
	assert.ok(q.queue.length > 0);

	// bufferedAmount 降到 HIGH 以下一点点（只允许发几个 chunk）
	dc.bufferedAmount = DC_HIGH_WATER_MARK - 500;
	q.onBufferedAmountLow();

	// 至少发了一个但还有残留
	assert.ok(dc.sent.length >= 1);
	assert.ok(q.queue.length > 0);
	assert.ok(dc.bufferedAmount >= DC_HIGH_WATER_MARK);
});

test('send: MAX_SINGLE_MSG_BYTES 超限 → drop，返回 false，logger.warn 被调用', () => {
	resetRemoteLog();
	const { dc, logger, q } = makeQueue({}, { maxMessageSize: 65536 });
	// 生成超过 50 MB 的 JSON
	const huge = jsonOfBytes(MAX_SINGLE_MSG_BYTES + 100);
	const ok = q.send(huge);
	assert.equal(ok, false);
	assert.equal(dc.sent.length, 0);
	assert.equal(q.queue.length, 0);
	assert.equal(q.droppedCount, 1);
	assert.ok(q.droppedBytes > MAX_SINGLE_MSG_BYTES);
	assert.ok(logger.warnings.some(w => w.includes('single-msg-oversize')));
	// single-msg-oversize 不触发 overflow-start remoteLog
	assert.equal(q.queueOverflowActive, false);
	assert.ok(!remoteLogBuffer.some(e => e.text.includes('overflow-start')));
});

test('send: queueBytes >= MAX_QUEUE_BYTES → drop 新消息，不影响已入队的 drain', () => {
	resetRemoteLog();
	const { dc, logger, q } = makeQueue({}, { maxMessageSize: 65536 });
	// 直接注入队列使其超过 MAX（模拟之前单条溢出场景）
	const overshoot = Buffer.alloc(MAX_QUEUE_BYTES + 1024);
	q.queue.push(overshoot);
	q.queueBytes += overshoot.length;

	const ok = q.send('{"small":true}');
	assert.equal(ok, false);
	assert.equal(q.droppedCount, 1);
	assert.ok(logger.warnings.some(w => w.includes('queue-full')));
	// overflow-start 应被触发
	assert.equal(q.queueOverflowActive, true);
	assert.ok(remoteLogBuffer.some(e => e.text.includes('rpc-queue.overflow-start')));

	// drain 应能正常发送已入队的 chunk（虽然 bufferedAmount 会瞬间顶到 HIGH）
	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();
	assert.equal(dc.sent.length, 1);
});

test('send: 单条消息在队列未满（queueBytes < MAX）但自身超过 MAX 时仍可入队（overshoot）', () => {
	resetRemoteLog();
	const { q } = makeQueue({ bufferedAmount: DC_HIGH_WATER_MARK }, { maxMessageSize: 65536 });
	// 构造 20 MB 消息（超过 MAX_QUEUE_BYTES=10 MB，但低于 MAX_SINGLE_MSG_BYTES=50 MB）
	const twentyMB = jsonOfBytes(20 * 1024 * 1024);
	const ok = q.send(twentyMB);
	assert.equal(ok, true, 'oversized single message should be accepted when queue was empty');
	assert.equal(q.droppedCount, 0);
	// 入队（fast-path 被 bufferedAmount 高挡住）
	assert.ok(q.queue.length > 0);
	assert.ok(q.queueBytes > MAX_QUEUE_BYTES);
	// 下一条消息应被 drop
	const ok2 = q.send('{"next":true}');
	assert.equal(ok2, false);
});

test('close: 清空队列并重置状态', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 100 });
	dc.bufferedAmount = DC_HIGH_WATER_MARK;
	q.send(jsonOfBytes(500));
	assert.ok(q.queue.length > 0);

	q.close();
	assert.equal(q.closed, true);
	assert.equal(q.queue.length, 0);
	assert.equal(q.queueBytes, 0);
});

test('close: 幂等', () => {
	resetRemoteLog();
	const { q } = makeQueue();
	q.close();
	const entriesAfterFirst = remoteLogBuffer.length;
	q.close();
	// 第二次不再 log
	assert.equal(remoteLogBuffer.length, entriesAfterFirst);
});

test('send: DC close 后 send 返回 false', () => {
	resetRemoteLog();
	const { q } = makeQueue();
	q.close();
	const ok = q.send('{"after":"close"}');
	assert.equal(ok, false);
});

test('send: readyState !== open 时返回 false', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({ readyState: 'connecting' });
	const ok = q.send('{"x":1}');
	assert.equal(ok, false);
	assert.equal(dc.sent.length, 0);
});

test('drain: dc.send 抛异常时 drain 停止，残留 chunks 保留到下次 drain 或 close', () => {
	resetRemoteLog();
	const { dc, logger, q } = makeQueue({}, { maxMessageSize: 100 });
	// 先塞入队列
	dc.bufferedAmount = DC_HIGH_WATER_MARK;
	q.send(jsonOfBytes(500));
	const initialLen = q.queue.length;
	assert.ok(initialLen > 1);

	// drain 时第二次 send 开始抛
	dc.bufferedAmount = 0;
	dc.sendThrowAt = 1;
	q.onBufferedAmountLow();

	// 只发出 1 个，剩余保留
	assert.equal(dc.sent.length, 1);
	assert.equal(q.queue.length, initialLen - 1);
	assert.ok(logger.warnings.some(w => w.includes('drain send failed')));

	// 关闭 throw 后重新 drain 应能继续
	dc.sendShouldThrow = false;
	dc.sendThrowAt = -1;
	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();
	assert.equal(q.queue.length, 0);
});

test('FIFO 顺序：多条消息交错入队，chunks 按调用顺序输出', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 50 });
	dc.bufferedAmount = DC_HIGH_WATER_MARK;
	const mid = jsonOfBytes(200);
	const mid2 = jsonOfBytes(200);
	q.send(mid);
	q.send(mid2);

	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();

	// 所有 chunks 都应发送，按入队顺序
	// 验证 msgId：第一条消息的所有 chunks 在第二条之前
	const firstMsgId = dc.sent[0].readUInt32BE(1);
	let i = 0;
	while (i < dc.sent.length && dc.sent[i].readUInt32BE(1) === firstMsgId) i += 1;
	// 剩余应都是第二条消息的 chunks
	const secondMsgId = dc.sent[i]?.readUInt32BE(1);
	assert.notEqual(firstMsgId, secondMsgId);
	for (let j = i; j < dc.sent.length; j += 1) {
		assert.equal(dc.sent[j].readUInt32BE(1), secondMsgId);
	}
});

// --- drop 上报 ---

test('remoteLog: 首次进入溢出 → overflow-start 一次', () => {
	resetRemoteLog();
	const { q } = makeQueue({}, { maxMessageSize: 65536 });
	// 预置溢出状态
	const big = Buffer.alloc(MAX_QUEUE_BYTES + 1);
	q.queue.push(big);
	q.queueBytes += big.length;

	// 第一次 drop → overflow-start
	q.send('{"a":1}');
	const startCount = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.overflow-start')).length;
	assert.equal(startCount, 1);

	// 第二次 drop 不再 log start
	q.send('{"b":2}');
	const startCount2 = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.overflow-start')).length;
	assert.equal(startCount2, 1);
});

test('remoteLog: drain 排空至 < MAX → overflow-end 一次', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 100 });
	// 制造 overflow：入队 > MAX 且触发 drop
	const bigChunk = Buffer.alloc(MAX_QUEUE_BYTES + 50);
	q.queue.push(bigChunk);
	q.queueBytes = bigChunk.length;
	q.send('{"trigger":"drop"}'); // 引发 overflow-start
	assert.equal(q.queueOverflowActive, true);

	// drain 应把 bigChunk 发出，queueBytes 归 0，触发 overflow-end
	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();
	assert.equal(q.queueOverflowActive, false);
	const endCount = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.overflow-end')).length;
	assert.equal(endCount, 1);
});

test('remoteLog: close 汇总 stats（dropped > 0 或 residual > 0）', () => {
	resetRemoteLog();
	const { q } = makeQueue({}, { maxMessageSize: 65536 });
	// 制造 drop
	q.queue.push(Buffer.alloc(MAX_QUEUE_BYTES + 1));
	q.queueBytes = MAX_QUEUE_BYTES + 1;
	q.send('{"x":1}');
	q.close();
	const closeLog = remoteLogBuffer.find(e => e.text.includes('rpc-queue.close'));
	assert.ok(closeLog);
	assert.ok(closeLog.text.includes('dropped=1'));
	assert.ok(closeLog.text.includes('residualChunks=1'));
});

test('remoteLog: close 无事件时不产生 close log', () => {
	resetRemoteLog();
	const { q } = makeQueue();
	q.close();
	const closeLog = remoteLogBuffer.find(e => e.text.includes('rpc-queue.close'));
	assert.equal(closeLog, undefined);
});

// --- edge ---

test('buildChunks 抛异常时透传给调用方（maxMessageSize 太小）', () => {
	resetRemoteLog();
	const { q } = makeQueue({}, { maxMessageSize: HEADER_SIZE });
	// 超过 maxMessageSize 才会触发 chunking 路径 → 抛
	assert.throws(
		() => q.send(jsonOfBytes(100)),
		/too small/,
	);
});

test('fast-path 首次 dc.send 抛异常 → 剩余 chunks 不入队，返回 false（分片路径）', () => {
	resetRemoteLog();
	const { dc, logger, q } = makeQueue({}, { maxMessageSize: 100 });
	dc.sendShouldThrow = true;
	const ok = q.send(jsonOfBytes(500)); // 需分片
	assert.equal(ok, false);
	assert.equal(q.queue.length, 0);
	// 第 0 个 chunk 就失败，i=0
	assert.ok(logger.warnings.some(w => w.includes('fast-path send failed at chunk 0/')));
});

test('fast-path 第 N 个 chunk 抛异常 → 前 N-1 个已发到 dc，剩余不入队', () => {
	resetRemoteLog();
	const { dc, logger, q } = makeQueue({}, { maxMessageSize: 100 });
	// 前 2 次 send 成功，第 3 次起抛
	dc.sendThrowAt = 2;
	const ok = q.send(jsonOfBytes(500));
	assert.equal(ok, false);
	// dc.sent 中有前 2 个 chunk（已发出）
	assert.equal(dc.sent.length, 2);
	// queue 中 0 个 chunk（失败后剩余丢弃，不入队）
	assert.equal(q.queue.length, 0);
	assert.equal(q.queueBytes, 0);
	// 日志指明失败发生在 chunk 2/N
	assert.ok(logger.warnings.some(w => /fast-path send failed at chunk 2\//.test(w)));
});

test('fast-path 首次 dc.send 抛异常 → 返回 false（不分片路径）', () => {
	resetRemoteLog();
	const { dc, logger, q } = makeQueue({}, { maxMessageSize: 10000 });
	dc.sendShouldThrow = true;
	const ok = q.send('{"small":true}');
	assert.equal(ok, false);
	assert.equal(q.queue.length, 0);
	assert.ok(logger.warnings.some(w => w.includes('fast-path send failed')));
});

test('fast-path: 循环前 readyState 变为 closing → 未发送的 chunks 全部入队', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 100 });
	// 第 2 次 send 之前把 readyState 改为 closing（静默），下一次 while 条件读到 closing 退出
	const origSend = dc.send;
	let n = 0;
	dc.send = function(data) {
		n += 1;
		if (n === 2) {
			dc.readyState = 'closing';
		}
		origSend.call(dc, data);
	};
	const ok = q.send(jsonOfBytes(500));
	// fast-path 发了前 2 个 chunk 后，while 条件 readyState === 'open' 不满足，停止
	// 剩余 chunks 经 "剩余入队" for 循环进入队列
	assert.equal(ok, true);
	assert.equal(dc.sent.length, 2);
	assert.ok(q.queue.length > 0);
	const total = dc.sent.length + q.queue.length;
	assert.ok(total > 2, 'at least 3 chunks expected for 500-byte payload at maxMsg=100');
});

test('fast-path: readyState 变 closing 后 dc.send 抛异常（模拟真实 pion 行为）→ 剩余丢弃', () => {
	resetRemoteLog();
	const { dc, logger, q } = makeQueue({}, { maxMessageSize: 100 });
	// 真实 pion-node：readyState !== 'open' 时 send 抛 InvalidStateError
	// 此测试验证 fast-path 的 try/catch 能正确处理 send 抛，与 readyState 门控形成双保险
	const origSend = dc.send;
	let n = 0;
	dc.send = function(data) {
		n += 1;
		if (n === 3) dc.readyState = 'closing';
		if (dc.readyState !== 'open') {
			throw new Error('InvalidStateError: not open');
		}
		origSend.call(dc, data);
	};
	const ok = q.send(jsonOfBytes(500));
	// 前 2 次成功 push；第 3 次 send 先切 closing 再抛
	assert.equal(ok, false);
	assert.equal(dc.sent.length, 2);
	assert.equal(q.queue.length, 0);
	assert.ok(logger.warnings.some((w) => /fast-path send failed at chunk/.test(w)));
});

test('边界：queueBytes === MAX_QUEUE_BYTES 时新消息被 drop', () => {
	resetRemoteLog();
	const { logger, q } = makeQueue({}, { maxMessageSize: 65536 });
	// 恰好等于 MAX
	q.queue.push(Buffer.alloc(MAX_QUEUE_BYTES));
	q.queueBytes = MAX_QUEUE_BYTES;
	const ok = q.send('{"x":1}');
	assert.equal(ok, false);
	assert.equal(q.droppedCount, 1);
	assert.ok(logger.warnings.some((w) => w.includes('queue-full')));
});

test('边界：queueBytes = MAX_QUEUE_BYTES - 1 时新消息仍可入队', () => {
	resetRemoteLog();
	const { q } = makeQueue({ bufferedAmount: 2 * 1024 * 1024 }, { maxMessageSize: 65536 });
	q.queue.push(Buffer.alloc(MAX_QUEUE_BYTES - 1));
	q.queueBytes = MAX_QUEUE_BYTES - 1;
	const ok = q.send('{"y":2}');
	assert.equal(ok, true);
	assert.equal(q.droppedCount, 0);
});

test('drain: DC readyState 从 open 变为 closing 途中停止', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 100 });
	dc.bufferedAmount = DC_HIGH_WATER_MARK;
	q.send(jsonOfBytes(500));
	const qLen = q.queue.length;
	assert.ok(qLen > 1);

	dc.bufferedAmount = 0;
	dc.readyState = 'closing';
	q.onBufferedAmountLow();
	// drain 循环条件 readyState === 'open' 不满足，立即停止
	assert.equal(dc.sent.length, 0);
	assert.equal(q.queue.length, qLen);
});

test('drain: 关闭状态下不执行', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 100 });
	dc.bufferedAmount = DC_HIGH_WATER_MARK;
	q.send(jsonOfBytes(500));
	q.close();
	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();
	// close 已清空队列，且 closed 短路
	assert.equal(dc.sent.length, 0);
});

test('tag 为空时日志不含额外前缀（分支覆盖）', () => {
	resetRemoteLog();
	const dc = makeMockDc();
	const logger = makeMockLogger();
	const q = new RpcSendQueue({
		dc,
		maxMessageSize: 65536,
		getNextMsgId: nextMsgId,
		logger,
		// 不传 tag
	});
	// 制造一次 drop
	q.queue.push(Buffer.alloc(MAX_QUEUE_BYTES + 1));
	q.queueBytes = MAX_QUEUE_BYTES + 1;
	q.send('{"x":1}');
	// 日志中不应有 "conn="
	assert.ok(logger.warnings.every(w => !w.includes('conn=')));
});

test('logger 缺失时 warn 不抛（?./?? fallback 分支）', () => {
	resetRemoteLog();
	const dc = makeMockDc();
	const q = new RpcSendQueue({
		dc,
		maxMessageSize: 65536,
		getNextMsgId: nextMsgId,
		logger: {}, // 无 warn 方法
	});
	q.queue.push(Buffer.alloc(MAX_QUEUE_BYTES + 1));
	q.queueBytes = MAX_QUEUE_BYTES + 1;
	// 不应抛
	assert.doesNotThrow(() => q.send('{"x":1}'));
});

test('未传 logger 时 fallback 到 console', () => {
	resetRemoteLog();
	const dc = makeMockDc();
	const q = new RpcSendQueue({
		dc,
		maxMessageSize: 65536,
		getNextMsgId: nextMsgId,
		// 不传 logger
	});
	assert.equal(q.logger, console);
});

// --- 常量 sanity ---

test('常量值符合设计（DC_LOW_WATER < DC_HIGH_WATER < MAX_QUEUE < MAX_SINGLE_MSG）', () => {
	assert.ok(DC_LOW_WATER_MARK < DC_HIGH_WATER_MARK);
	assert.ok(DC_HIGH_WATER_MARK < MAX_QUEUE_BYTES);
	assert.ok(MAX_QUEUE_BYTES < MAX_SINGLE_MSG_BYTES);
	assert.equal(DC_HIGH_WATER_MARK, 1024 * 1024);
	assert.equal(DC_LOW_WATER_MARK, 256 * 1024);
	assert.equal(MAX_QUEUE_BYTES, 10 * 1024 * 1024);
	assert.equal(MAX_SINGLE_MSG_BYTES, 50 * 1024 * 1024);
});
