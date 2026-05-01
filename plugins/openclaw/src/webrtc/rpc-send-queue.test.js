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

/**
 * Invariant 断言：从原始 data 重新推算真值字节数，而非信任 item.bytes 字段。
 * 这样能同时检出两类 drift：(1) item.bytes 写错；(2) queueBytes 累加扣减写错。
 */
function assertQueueInvariant(q, label = '') {
	let actualBytes = 0;
	for (const item of q.queue) {
		const trueBytes = item.isString
			? Buffer.byteLength(item.data, 'utf8')
			: item.data.length;
		assert.equal(
			item.bytes, trueBytes,
			`${label}item.bytes drift: tracked=${item.bytes}, actual=${trueBytes}`,
		);
		actualBytes += trueBytes;
	}
	assert.equal(
		q.queueBytes, actualBytes,
		`${label}queueBytes drift: tracked=${q.queueBytes}, actual=${actualBytes}, queue.length=${q.queue.length}`,
	);
	if (q.queue.length === 0) {
		assert.equal(q.queueBytes, 0, `${label}queue empty but queueBytes=${q.queueBytes}`);
	}
}

// 合成"队列已满"场景的测试辅助：直接注入一个占指定字节数的 binary item
function injectBinaryItem(q, bytes) {
	const buf = Buffer.alloc(bytes);
	q.queue.push({ data: buf, isString: false, bytes });
	q.queueBytes += bytes;
	return buf;
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

test('send: 队列非空时，新消息的 chunks 全部入队（不插队），非分片消息以 string 形式保留类型', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 100 });
	// 先塞满使 fast-path 暂停
	dc.bufferedAmount = DC_HIGH_WATER_MARK;
	const first = '"first msg fits one chunk"';
	q.send(first);
	const queueLenAfterFirst = q.queue.length;
	assert.equal(queueLenAfterFirst, 1, 'small non-chunked msg enqueues as 1 item');
	// 关键回归：非分片消息入队必须保留 string 类型（早期 bug 是被 Buffer 化导致 UI 当分片残片静默丢）
	assert.equal(typeof q.queue[0].data, 'string', 'non-chunked msg must remain a string on enqueue');
	assert.equal(q.queue[0].isString, true);
	assert.equal(q.queue[0].data, first, 'string content matches original');
	assert.equal(q.queueBytes, Buffer.byteLength(first, 'utf8'));
	assertQueueInvariant(q, 'after first: ');

	// 第二条消息应全部追加到队尾（dc.sent 不增加）
	const sentBefore = dc.sent.length;
	q.send('"second"');
	assert.equal(dc.sent.length, sentBefore, 'no fast-path when queue non-empty');
	assert.ok(q.queue.length > queueLenAfterFirst);
	assertQueueInvariant(q, 'after second: ');
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

test('send: MAX_SINGLE_MSG_BYTES 超限（不分片路径）→ drop', () => {
	resetRemoteLog();
	// maxMessageSize = 60MB > 50MB 硬上限，使得 50MB+ 消息走"不分片"路径
	const { dc, logger, q } = makeQueue({}, { maxMessageSize: 60 * 1024 * 1024 });
	const huge = jsonOfBytes(MAX_SINGLE_MSG_BYTES + 100);
	const ok = q.send(huge);
	assert.equal(ok, false);
	assert.equal(dc.sent.length, 0);
	assert.equal(q.queue.length, 0);
	assert.equal(q.droppedCount, 1);
	assert.ok(logger.warnings.some((w) => w.includes('single-msg-oversize')));
	assertQueueInvariant(q);
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
	injectBinaryItem(q, MAX_QUEUE_BYTES + 1024);

	const ok = q.send('{"small":true}');
	assert.equal(ok, false);
	assert.equal(q.droppedCount, 1);
	assert.ok(logger.warnings.some(w => w.includes('overflow-start')));
	// overflow-start 应被触发
	assert.equal(q.queueOverflowActive, true);
	assert.ok(remoteLogBuffer.some(e => e.text.includes('rpc-queue.overflow-start')));

	// drain 应能正常发送已入队的 chunk（虽然 bufferedAmount 会瞬间顶到 HIGH）
	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();
	assert.equal(dc.sent.length, 1);
});

test('send: overflow 持续期间多次 drop 只 warn 一次（避免 DC 卡死时刷屏）', () => {
	resetRemoteLog();
	const { logger, q } = makeQueue({}, { maxMessageSize: 65536 });
	// 预置溢出（模拟 UI 离线 + ICE 失败 → DC 不 drain，队列卡满）
	injectBinaryItem(q, MAX_QUEUE_BYTES + 1);

	// 连续 100 次 drop，应只产生 1 次 overflow-start warn
	for (let i = 0; i < 100; i += 1) q.send(`{"i":${i}}`);

	const startWarns = logger.warnings.filter(w => w.includes('overflow-start'));
	assert.equal(startWarns.length, 1, 'overflow-start warn should fire only once');
	const startRemoteLogs = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.overflow-start'));
	assert.equal(startRemoteLogs.length, 1, 'overflow-start remoteLog should fire only once');
	// overflow-start 内容契约：携带触发瞬间的 queueBytes
	assert.match(startWarns[0], /queueBytes=\d+/);
	assert.match(startRemoteLogs[0].text, /queueBytes=\d+/);
	// overflow 持续期间不应产生任何 overflow-end log（DC 没机会 drain）
	assert.equal(logger.infos.filter(s => s.includes('overflow-end')).length, 0);
	assert.equal(remoteLogBuffer.filter(e => e.text.includes('overflow-end')).length, 0);
	// 但 dropped 计数仍累加
	assert.equal(q.droppedCount, 100);
});

test('send: overflow 持续期间 single-msg-oversize 仍每次 warn（不被静默吞掉）', () => {
	resetRemoteLog();
	const { logger, q } = makeQueue({}, { maxMessageSize: 65536 });
	// 预置溢出
	injectBinaryItem(q, MAX_QUEUE_BYTES + 1);
	// 先打一次 queue-full 进入 overflow 状态
	q.send('{"trigger":1}');
	assert.equal(q.queueOverflowActive, true);
	const baselineWarns = logger.warnings.length;

	// overflow 期间连续 3 条单条超大消息：每条都应 warn（应用 bug，不该被合并）
	const huge = jsonOfBytes(MAX_SINGLE_MSG_BYTES + 100);
	for (let i = 0; i < 3; i += 1) {
		const ok = q.send(huge);
		assert.equal(ok, false);
	}
	const oversizeWarns = logger.warnings
		.slice(baselineWarns)
		.filter(w => w.includes('single-msg-oversize'));
	assert.equal(oversizeWarns.length, 3, 'single-msg-oversize warn must fire on every occurrence');
	// 但 overflow 状态机不受影响（仍是 active，不需要再 emit start）
	assert.equal(q.queueOverflowActive, true);
	assert.equal(
		remoteLogBuffer.filter(e => e.text.includes('overflow-start')).length,
		1,
		'single-msg-oversize must not retrigger overflow-start',
	);
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
	const initialBytes = q.queueBytes;
	assert.ok(initialLen > 1);
	assertQueueInvariant(q, 'after enqueue: ');

	// drain 时第二次 send 开始抛
	dc.bufferedAmount = 0;
	dc.sendThrowAt = 1;
	q.onBufferedAmountLow();

	// 只发出 1 个，剩余保留；queueBytes 应精确 = initialBytes - 第一个 chunk 长度
	assert.equal(dc.sent.length, 1);
	assert.equal(q.queue.length, initialLen - 1);
	assert.equal(q.queueBytes, initialBytes - dc.sent[0].length, 'queueBytes must match actual after partial drain');
	assertQueueInvariant(q, 'after partial drain with throw: ');
	assert.ok(logger.warnings.some(w => w.includes('drain send failed')));

	// 关闭 throw 后重新 drain 应能继续
	dc.sendShouldThrow = false;
	dc.sendThrowAt = -1;
	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();
	assert.equal(q.queue.length, 0);
	assertQueueInvariant(q, 'after final drain: ');
});

test('FIFO 顺序：多条消息交错入队，chunks 按调用顺序输出', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 50 });
	dc.bufferedAmount = DC_HIGH_WATER_MARK;
	const mid = jsonOfBytes(200);
	const mid2 = jsonOfBytes(200);
	q.send(mid);
	q.send(mid2);
	assertQueueInvariant(q, 'after two sends: ');

	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();
	assertQueueInvariant(q, 'after drain: ');

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
	// 全部输出必须是 binary 帧（Buffer），string 帧绝不会出现在分片消息中
	for (const sent of dc.sent) assert.ok(Buffer.isBuffer(sent));
});

test('FIFO 顺序：非分片 + 分片消息混合，小消息不插队', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 50 });
	dc.bufferedAmount = DC_HIGH_WATER_MARK;

	// 第一条：小消息不分片（入队保留 string 类型，msgId 不会被 getNextMsgId 消费）
	const small = '"small"';
	q.send(small);
	const afterFirst = q.queue.length;
	assert.equal(afterFirst, 1, 'small msg enqueued as a single item');
	assert.equal(typeof q.queue[0].data, 'string', 'non-chunked msg keeps string type on enqueue');
	assert.equal(q.queue[0].isString, true);
	assertQueueInvariant(q, 'after small: ');

	// 第二条：大消息分片
	const big = jsonOfBytes(200);
	q.send(big);
	assert.ok(q.queue.length > afterFirst + 1, 'big msg produces multiple chunks');
	assertQueueInvariant(q, 'after big: ');

	// drain：小消息应先出
	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();
	assertQueueInvariant(q, 'after drain: ');
	// 第一个发送的必须是原 string（关键回归：UI 端按 string 帧识别为完整消息）
	assert.equal(typeof dc.sent[0], 'string', 'first emitted frame must be a string frame, not Buffer');
	assert.equal(dc.sent[0], small);
	// 其余必是带 header 的分片 chunk Buffer（msgId 相同）
	assert.ok(Buffer.isBuffer(dc.sent[1]));
	const bigMsgId = dc.sent[1].readUInt32BE(1);
	for (let j = 2; j < dc.sent.length; j += 1) {
		assert.ok(Buffer.isBuffer(dc.sent[j]));
		assert.equal(dc.sent[j].readUInt32BE(1), bigMsgId, 'chunks of big msg share msgId');
	}
});

// --- drop 上报 ---

test('remoteLog: 首次进入溢出 → overflow-start 一次', () => {
	resetRemoteLog();
	const { q } = makeQueue({}, { maxMessageSize: 65536 });
	// 预置溢出状态
	injectBinaryItem(q, MAX_QUEUE_BYTES + 1);

	// 第一次 drop → overflow-start
	q.send('{"a":1}');
	const startCount = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.overflow-start')).length;
	assert.equal(startCount, 1);

	// 第二次 drop 不再 log start
	q.send('{"b":2}');
	const startCount2 = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.overflow-start')).length;
	assert.equal(startCount2, 1);
});

test('remoteLog: drain 排空至 < MAX → overflow-end 一次（warn+info+remoteLog 同步翻转，含累计 dropped）', () => {
	resetRemoteLog();
	const { dc, logger, q } = makeQueue({}, { maxMessageSize: 100 });
	// 制造 overflow：入队 > MAX 且累加多次 drop
	injectBinaryItem(q, MAX_QUEUE_BYTES + 50);
	for (let i = 0; i < 5; i += 1) q.send(`{"drop":${i}}`); // 5 次 drop，仅首次 overflow-start
	assert.equal(q.queueOverflowActive, true);
	assert.equal(q.droppedCount, 5);

	// drain 应把 bigChunk 发出，queueBytes 归 0，触发 overflow-end
	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();
	assertQueueInvariant(q, 'after drain: ');
	assert.equal(q.queueOverflowActive, false);

	// remoteLog: overflow-end 一次，内容必须带累计 dropped/droppedBytes
	const endLogs = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.overflow-end'));
	assert.equal(endLogs.length, 1);
	assert.match(endLogs[0].text, /dropped=5\b/);
	assert.match(endLogs[0].text, /droppedBytes=\d+/);

	// 本地 logger.info 与 remoteLog 同步翻转（一次），同样带累计字段
	const infoEnds = logger.infos.filter(s => s.includes('overflow-end'));
	assert.equal(infoEnds.length, 1);
	assert.match(infoEnds[0], /dropped=5\b/);
});

test('remoteLog: overflow 循环（start → end → start 再次）状态机双向可翻转', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 100 });

	// 第一轮：制造溢出 → overflow-start
	injectBinaryItem(q, MAX_QUEUE_BYTES + 50);
	q.send('{"a":1}'); // drop，overflow-start #1
	assert.equal(q.queueOverflowActive, true);
	assert.equal(
		remoteLogBuffer.filter(e => e.text.includes('rpc-queue.overflow-start')).length,
		1,
	);

	// drain 清空 → overflow-end #1 → overflowActive 翻回 false
	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();
	assertQueueInvariant(q);
	assert.equal(q.queueOverflowActive, false);
	assert.equal(
		remoteLogBuffer.filter(e => e.text.includes('rpc-queue.overflow-end')).length,
		1,
	);

	// 第二轮：再次制造溢出 → overflow-start #2（状态机应能再次翻转）
	injectBinaryItem(q, MAX_QUEUE_BYTES + 50);
	q.send('{"b":2}'); // drop，overflow-start #2
	assert.equal(q.queueOverflowActive, true);
	assert.equal(
		remoteLogBuffer.filter(e => e.text.includes('rpc-queue.overflow-start')).length,
		2,
		'second overflow-start must fire after a full cycle',
	);
});

test('remoteLog: close 汇总 stats（dropped > 0 或 residual > 0）', () => {
	resetRemoteLog();
	const { q } = makeQueue({}, { maxMessageSize: 65536 });
	// 制造 drop
	injectBinaryItem(q, MAX_QUEUE_BYTES + 1);
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

test('remoteLog: close 仅 residual > 0（无 drops） → 汇总 log', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 100 });
	// 制造残留：bufferedAmount 高使所有 chunks 入队，未触发 drop
	dc.bufferedAmount = DC_HIGH_WATER_MARK;
	q.send(jsonOfBytes(500));
	assert.ok(q.queue.length > 0);
	assert.equal(q.droppedCount, 0);

	q.close();
	const closeLog = remoteLogBuffer.find(e => e.text.includes('rpc-queue.close'));
	assert.ok(closeLog, 'close log expected when residual > 0');
	assert.ok(closeLog.text.includes('dropped=0'));
	assert.ok(/residualChunks=[1-9]/.test(closeLog.text), 'residualChunks > 0');
});

test('remoteLog: close 仅 drops > 0（无 residual）→ 汇总 log', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 100 });
	// 制造 drop：queueBytes 溢出但手动清空 queue 后再 close
	injectBinaryItem(q, MAX_QUEUE_BYTES);
	q.send('{"drop":"me"}'); // 触发 drop
	assert.equal(q.droppedCount, 1);

	// 先 drain 清空
	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();
	assert.equal(q.queue.length, 0);
	assertQueueInvariant(q, 'after drain: ');

	q.close();
	const closeLog = remoteLogBuffer.find(e => e.text.includes('rpc-queue.close'));
	assert.ok(closeLog, 'close log expected when drops > 0');
	assert.ok(closeLog.text.includes('dropped=1'));
	assert.ok(closeLog.text.includes('residualChunks=0'));
});

// --- edge ---

test('buildChunks 抛异常被 send 内部捕获 → 返回 false，warn + remoteLog 上报，dropped 计数累加', () => {
	resetRemoteLog();
	const { dc, logger, q } = makeQueue({}, { maxMessageSize: HEADER_SIZE });
	// maxMessageSize == HEADER_SIZE 使 chunkPayloadSize=0，buildChunks 内部 throw
	const payload = jsonOfBytes(100);
	let ok;
	assert.doesNotThrow(() => { ok = q.send(payload); }, 'send 必须吃掉 buildChunks 异常，不能抛回 gateway');
	assert.equal(ok, false);
	assert.equal(dc.sent.length, 0);
	assert.equal(q.queue.length, 0);
	assert.equal(q.droppedCount, 1);
	assert.equal(q.droppedBytes, Buffer.byteLength(payload, 'utf8'));
	assert.ok(logger.warnings.some(w => w.includes('build-chunks-failed')));
	assert.ok(logger.warnings.some(w => /err=.*too small/.test(w)));
	assert.ok(remoteLogBuffer.some(e => e.text.includes('rpc-queue.build-chunks-failed')));
	// 配置错误不应触发 overflow 状态机
	assert.equal(q.queueOverflowActive, false);
});

test('分片路径单条上限按 payload 字节判断（payload 不超但帧字节累计超 → 不应误判 drop）', () => {
	resetRemoteLog();
	// payload = MAX_SINGLE_MSG_BYTES 恰好等于上限；maxMessageSize=65536 → ~800 chunks，
	// 帧字节 ≈ 50 MB + 4 KB > 上限。旧实现按 frameBytes 比会误 drop，修复后按 payloadBytes 比应入队。
	// bufferedAmount=HIGH 让所有 chunks 直接走入队，避免 fast-path 实发 50 MB 数据。
	const { logger, q } = makeQueue(
		{ bufferedAmount: DC_HIGH_WATER_MARK },
		{ maxMessageSize: 65536 },
	);
	const payload = jsonOfBytes(MAX_SINGLE_MSG_BYTES);
	const ok = q.send(payload);
	assert.equal(ok, true, 'payload 恰好等于上限应入队，不能因 header 累计而误判');
	assert.equal(q.droppedCount, 0);
	// queueBytes 累计的是帧字节（含 header），应大于 payload 字节
	assert.ok(q.queueBytes > MAX_SINGLE_MSG_BYTES, 'queueBytes 用帧字节核算，含 header 后超过 payload 上限');
	assert.ok(!logger.warnings.some(w => w.includes('single-msg-oversize')));
	// 立即 close 释放占用
	q.close();
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
	injectBinaryItem(q, MAX_QUEUE_BYTES);
	const ok = q.send('{"x":1}');
	assert.equal(ok, false);
	assert.equal(q.droppedCount, 1);
	assert.ok(logger.warnings.some((w) => w.includes('overflow-start')));
});

test('边界：queueBytes = MAX_QUEUE_BYTES - 1 时新消息仍可入队', () => {
	resetRemoteLog();
	const { q } = makeQueue({ bufferedAmount: 2 * 1024 * 1024 }, { maxMessageSize: 65536 });
	injectBinaryItem(q, MAX_QUEUE_BYTES - 1);
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
	injectBinaryItem(q, MAX_QUEUE_BYTES + 1);
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
	injectBinaryItem(q, MAX_QUEUE_BYTES + 1);
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

test('契约: logger.warn 自身抛异常时 send 不抛（safe wrapper 兜底）', () => {
	resetRemoteLog();
	const dc = makeMockDc();
	const evilLogger = {
		warn: () => { throw new Error('logger broken'); },
		info: () => { throw new Error('logger broken'); },
		error: () => {},
		debug: () => {},
	};
	const q = new RpcSendQueue({
		dc,
		maxMessageSize: HEADER_SIZE, // 触发 buildChunks 抛 → 进入 build-chunks-failed 分支 → 调 logger.warn
		getNextMsgId: nextMsgId,
		logger: evilLogger,
	});
	// build-chunks-failed 路径
	let ok;
	assert.doesNotThrow(() => { ok = q.send(jsonOfBytes(100)); });
	assert.equal(ok, false);
	assert.equal(q.droppedCount, 1);
	q.close();
});

test('契约: __safeInfo 在 logger.info 抛时不传染（drain overflow-end 路径）', () => {
	resetRemoteLog();
	const dc = makeMockDc();
	const evilLogger = {
		warn: () => {},
		info: () => { throw new Error('logger.info broken'); },
		error: () => {},
		debug: () => {},
	};
	const q = new RpcSendQueue({
		dc,
		maxMessageSize: 65536,
		getNextMsgId: nextMsgId,
		logger: evilLogger,
	});
	// 制造 overflow-start 后，drain 触发 overflow-end → 命中 __safeInfo
	injectBinaryItem(q, MAX_QUEUE_BYTES + 50);
	q.send('{"x":1}'); // 触发 overflow-start
	assert.equal(q.queueOverflowActive, true);
	dc.bufferedAmount = 0;
	assert.doesNotThrow(() => q.onBufferedAmountLow(), 'overflow-end 路径中 logger.info 抛不应传染到 drain');
	assert.equal(q.queueOverflowActive, false);
});


test('契约: 非 string 入参（Buffer/null/undefined/对象）→ drop 返回 false，不调用 Buffer.byteLength', () => {
	resetRemoteLog();
	const cases = [
		{ name: 'Buffer', value: Buffer.from('not a string') },
		{ name: 'null', value: null },
		{ name: 'undefined', value: undefined },
		{ name: 'object', value: { a: 1 } },
		{ name: 'number', value: 42 },
	];
	for (const { name, value } of cases) {
		const { logger, q } = makeQueue();
		const ok = q.send(value);
		assert.equal(ok, false, `${name}: 应 drop`);
		assert.equal(q.droppedCount, 1, `${name}: droppedCount 应+1`);
		assert.ok(
			logger.warnings.some(w => w.includes('non-string-input')),
			`${name}: 应 warn non-string-input`,
		);
	}
});

// --- 字节一致性（invariant）贯穿场景 ---

test('invariant: send/drain/drop/close 混合序列后 queueBytes 始终等于 chunk 长度之和', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 100 });
	assertQueueInvariant(q, 'init: ');

	// 步 1：fast-path 直发（不入队）
	q.send('{"a":1}');
	assertQueueInvariant(q, 'step1 direct send: ');
	assert.equal(q.queueBytes, 0);

	// 步 2：塞满 bufferedAmount 让大消息全部入队
	dc.bufferedAmount = DC_HIGH_WATER_MARK;
	q.send(jsonOfBytes(500));
	assertQueueInvariant(q, 'step2 enqueue chunks: ');
	const step2Bytes = q.queueBytes;
	assert.ok(step2Bytes > 0);

	// 步 3：非分片小消息入队（队列非空）
	q.send('{"tiny":true}');
	assertQueueInvariant(q, 'step3 enqueue small: ');
	assert.ok(q.queueBytes > step2Bytes);

	// 步 4：drain 部分（bufferedAmount 略低于 HIGH，发一两个后再次顶到）
	dc.bufferedAmount = DC_HIGH_WATER_MARK - 50;
	q.onBufferedAmountLow();
	assertQueueInvariant(q, 'step4 partial drain: ');

	// 步 5：drain 全部
	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();
	assertQueueInvariant(q, 'step5 full drain: ');
	assert.equal(q.queue.length, 0);
	assert.equal(q.queueBytes, 0);

	// 步 6：注入饱和状态 + 一次 drop
	injectBinaryItem(q, MAX_QUEUE_BYTES);
	assertQueueInvariant(q, 'step6 synthetic full: ');
	const ok = q.send('{"drop":"me"}');
	assert.equal(ok, false);
	assertQueueInvariant(q, 'step6 after drop: ');

	// 步 7：drain 清空
	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();
	assertQueueInvariant(q, 'step7 after full drain: ');

	// 步 8：close
	q.close();
	assert.equal(q.queue.length, 0);
	assert.equal(q.queueBytes, 0);
	assertQueueInvariant(q, 'step8 closed: ');
});

test('invariant: fast-path 分片成功/失败路径后 queueBytes 与 queue 长度一致', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({ bufferedAmount: 0 }, { maxMessageSize: 1000 });

	// 大消息分片，fast-path 部分发送后入队剩余
	q.send(jsonOfBytes(2 * 1024 * 1024));
	assertQueueInvariant(q, 'after partial fast-path: ');
	const bytesBefore = q.queueBytes;
	const lenBefore = q.queue.length;
	assert.ok(lenBefore > 0);
	assert.ok(bytesBefore > 0);

	// 下一条消息（fast-path 被 queue 非空挡住，全部入队）
	q.send(jsonOfBytes(50_000));
	assertQueueInvariant(q, 'after second enqueue: ');
	assert.ok(q.queueBytes > bytesBefore);

	// 模拟 dc.send 持续抛 → drain 在第 1 次就失败，不 shift
	dc.bufferedAmount = 0;
	dc.sendShouldThrow = true;
	q.onBufferedAmountLow();
	assertQueueInvariant(q, 'after failed drain: ');
	// 首个 chunk 应仍在队首（没被 shift）
	assert.equal(q.queue.length > 0, true);
});

// --- 回归：string 帧类型保留（早期 bug：被 Buffer 化导致 UI reassembler 当分片残片静默丢） ---

test('回归: 队列非空时入队的小 JSON，drain 出口必须是 string 帧而非 Buffer', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({}, { maxMessageSize: 65536 });
	// 让队列非空（强制走"非空入队"分支）：先塞一段二进制残片
	injectBinaryItem(q, 1024);
	const accepted = '{"runId":"r1","accepted":true}';
	const ok = q.send(accepted);
	assert.equal(ok, true);
	// 入队 item 必须保留 string 类型
	const queuedItem = q.queue[q.queue.length - 1];
	assert.equal(typeof queuedItem.data, 'string');
	assert.equal(queuedItem.isString, true);
	assert.equal(queuedItem.bytes, Buffer.byteLength(accepted, 'utf8'));

	// drain 出口验证：dc.send 收到的必须是 string，UI 端才会按完整消息派发
	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();
	assert.equal(q.queue.length, 0);
	const stringFrames = dc.sent.filter((s) => typeof s === 'string');
	assert.equal(stringFrames.length, 1, 'exactly one string frame drained');
	assert.equal(stringFrames[0], accepted);
});

test('回归: bufferedAmount >= HIGH 时入队的小 JSON，drain 出口必须是 string 帧而非 Buffer', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({ bufferedAmount: DC_HIGH_WATER_MARK }, { maxMessageSize: 65536 });
	const accepted = '{"runId":"r2","accepted":true}';
	const ok = q.send(accepted);
	assert.equal(ok, true);
	// 因高水位被入队，不走 fast-path
	assert.equal(dc.sent.length, 0);
	assert.equal(q.queue.length, 1);
	assert.equal(typeof q.queue[0].data, 'string');
	assert.equal(q.queue[0].isString, true);

	// 让 bufferedAmount 回落，drain
	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();
	assert.equal(dc.sent.length, 1);
	assert.equal(typeof dc.sent[0], 'string', 'must drain as string frame, not Buffer');
	assert.equal(dc.sent[0], accepted);
});

test('回归: 小 string 入队的 queueBytes 用 UTF-8 字节核算（非 string.length）', () => {
	resetRemoteLog();
	const { dc, q } = makeQueue({ bufferedAmount: DC_HIGH_WATER_MARK }, { maxMessageSize: 65536 });
	// 含多字节字符：字符数 ≠ UTF-8 字节数
	const multibyte = '"中文事件 emoji 🚀"';
	const expectedBytes = Buffer.byteLength(multibyte, 'utf8');
	assert.notEqual(expectedBytes, multibyte.length, 'sanity: char count != utf8 bytes');

	q.send(multibyte);
	assert.equal(q.queueBytes, expectedBytes);
	assertQueueInvariant(q, 'utf8 bytes accounting: ');

	// drain 后 bytes 归零
	dc.bufferedAmount = 0;
	q.onBufferedAmountLow();
	assert.equal(q.queueBytes, 0);
	assert.equal(dc.sent[0], multibyte);
});

// --- 白名单：agent run 类 RPC 响应在队列满时强行入队 ---

test('白名单: 队列满 + agent res 帧（payload 顶层 runId）→ 强行入队，不计入 dropped，不触发 overflow-start', () => {
	resetRemoteLog();
	const { dc, logger, q } = makeQueue({ bufferedAmount: DC_HIGH_WATER_MARK }, { maxMessageSize: 65536 });
	injectBinaryItem(q, MAX_QUEUE_BYTES + 1024);
	const baseBytes = q.queueBytes;
	const frame = JSON.stringify({
		type: 'res',
		id: 7,
		ok: true,
		payload: { runId: 'r-1', status: 'ok', summary: 'done' },
	});

	const ok = q.send(frame);

	assert.equal(ok, true, 'whitelist res frame must be accepted');
	assert.equal(q.droppedCount, 0, 'whitelist passthrough must not increment droppedCount');
	assert.equal(q.droppedBytes, 0);
	assert.equal(q.queueOverflowActive, false, 'whitelist must not flip overflow state');
	assert.ok(!logger.warnings.some((w) => w.includes('overflow-start')));
	assert.ok(!remoteLogBuffer.some((e) => e.text.includes('overflow-start')));
	assert.ok(q.queueBytes > baseBytes, 'whitelist message increases queueBytes (intentional overshoot)');
	assert.ok(q.queueBytes > MAX_QUEUE_BYTES);
	assertQueueInvariant(q, 'after whitelist enqueue: ');

	// 白名单帧入队后保留 string 类型（UI reassembler 才能按完整消息派发，避免被当分片残片丢）
	const tail = q.queue[q.queue.length - 1];
	assert.equal(typeof tail.data, 'string');
	assert.equal(tail.isString, true);
	assert.equal(tail.data, frame);

	// 后续非白名单消息照常 drop
	const ok2 = q.send('{"chatter":1}');
	assert.equal(ok2, false);
	assert.equal(q.droppedCount, 1);
	assert.equal(q.queueOverflowActive, true, 'first non-whitelist drop flips overflow');
});

test('白名单: 队列满 + agent.wait timeout 帧 → 强行入队，状态/日志不受影响', () => {
	resetRemoteLog();
	const { q, logger } = makeQueue({ bufferedAmount: DC_HIGH_WATER_MARK }, { maxMessageSize: 65536 });
	injectBinaryItem(q, MAX_QUEUE_BYTES + 1);
	const frame = JSON.stringify({
		type: 'res',
		id: 9,
		ok: true,
		payload: { runId: 'r-2', status: 'timeout' },
	});
	const ok = q.send(frame);
	assert.equal(ok, true);
	assert.equal(q.droppedCount, 0);
	assert.equal(q.droppedBytes, 0);
	assert.equal(q.queueOverflowActive, false);
	assert.ok(!logger.warnings.some((w) => w.includes('overflow-start')));
	assert.ok(!remoteLogBuffer.some((e) => e.text.includes('overflow-start')));
});

test('白名单: 队列满 + agent accepted 帧（phase-1）→ 强行入队，状态/日志不受影响', () => {
	resetRemoteLog();
	const { q, logger } = makeQueue({ bufferedAmount: DC_HIGH_WATER_MARK }, { maxMessageSize: 65536 });
	injectBinaryItem(q, MAX_QUEUE_BYTES + 1);
	const frame = JSON.stringify({
		type: 'res',
		id: 11,
		ok: true,
		payload: { runId: 'r-3', status: 'accepted', acceptedAt: 1700000000 },
	});
	const ok = q.send(frame);
	assert.equal(ok, true);
	assert.equal(q.droppedCount, 0);
	assert.equal(q.droppedBytes, 0);
	assert.equal(q.queueOverflowActive, false);
	assert.ok(!logger.warnings.some((w) => w.includes('overflow-start')));
	assert.ok(!remoteLogBuffer.some((e) => e.text.includes('overflow-start')));
});

test('白名单: 队列满 + 普通 res 帧（payload 无 runId）→ 仍 drop', () => {
	resetRemoteLog();
	const { q, logger } = makeQueue({}, { maxMessageSize: 65536 });
	injectBinaryItem(q, MAX_QUEUE_BYTES + 1);
	const frame = JSON.stringify({
		type: 'res',
		id: 13,
		ok: true,
		payload: { sessions: [{ id: 's1' }] },
	});
	const ok = q.send(frame);
	assert.equal(ok, false);
	assert.equal(q.droppedCount, 1);
	assert.ok(logger.warnings.some((w) => w.includes('overflow-start')));
});

test('白名单: 队列满 + 非 res 帧（event 类型且嵌套 runId）→ 仍 drop', () => {
	resetRemoteLog();
	const { q } = makeQueue({}, { maxMessageSize: 65536 });
	injectBinaryItem(q, MAX_QUEUE_BYTES + 1);
	// event 帧即使携带 runId 也不豁免（仅放 res 类）
	const frame = JSON.stringify({
		type: 'event',
		event: 'agent.delta',
		payload: { runId: 'r-4', text: 'hi' },
	});
	const ok = q.send(frame);
	assert.equal(ok, false);
	assert.equal(q.droppedCount, 1);
});

test('白名单: 队列满 + payload 嵌套层 runId（顶层无）→ 不命中，仍 drop（防误命中）', () => {
	resetRemoteLog();
	const { q } = makeQueue({}, { maxMessageSize: 65536 });
	injectBinaryItem(q, MAX_QUEUE_BYTES + 1);
	// 顶层 payload 无 runId，仅嵌套内部出现，不应被识别
	const frame = JSON.stringify({
		type: 'res',
		id: 15,
		ok: true,
		payload: { sessions: [{ runId: 'nested' }] },
	});
	const ok = q.send(frame);
	assert.equal(ok, false);
	assert.equal(q.droppedCount, 1);
});

test('白名单: 队列满 + JSON 解析失败的字符串 → 按非白名单 drop', () => {
	resetRemoteLog();
	const { q } = makeQueue({}, { maxMessageSize: 65536 });
	injectBinaryItem(q, MAX_QUEUE_BYTES + 1);
	const ok = q.send('{not json');
	assert.equal(ok, false);
	assert.equal(q.droppedCount, 1);
});

test('白名单: 单条超过 50MB 硬上限 → 仍 drop（白名单不豁免硬上限）', () => {
	resetRemoteLog();
	const { logger, q } = makeQueue({}, { maxMessageSize: 60 * 1024 * 1024 });
	// 构造超过 50MB 的 res 帧（payload.runId 命中白名单条件）
	const filler = 'x'.repeat(MAX_SINGLE_MSG_BYTES + 100);
	const frame = JSON.stringify({
		type: 'res',
		id: 17,
		ok: true,
		payload: { runId: 'r-huge', status: 'ok', summary: filler },
	});
	const ok = q.send(frame);
	assert.equal(ok, false, 'whitelist must not exempt hard cap');
	assert.equal(q.droppedCount, 1);
	assert.ok(logger.warnings.some((w) => w.includes('single-msg-oversize')));
});

test('白名单: 顶层 type !== res（如 type=req 含 runId）→ 不命中，仍 drop', () => {
	resetRemoteLog();
	const { q } = makeQueue({}, { maxMessageSize: 65536 });
	injectBinaryItem(q, MAX_QUEUE_BYTES + 1);
	const frame = JSON.stringify({
		type: 'req',
		id: 21,
		method: 'agent',
		payload: { runId: 'r-req' },
	});
	const ok = q.send(frame);
	assert.equal(ok, false);
	assert.equal(q.droppedCount, 1);
});

test('白名单: payload 缺失或 runId 为 falsy 值 → 不命中，仍 drop', () => {
	const cases = [
		{ name: 'runId=null', payload: { runId: null, status: 'ok' } },
		{ name: 'runId=undefined', payload: { status: 'ok' } },
		{ name: 'runId=空字符串', payload: { runId: '', status: 'ok' } },
		{ name: 'runId=0', payload: { runId: 0, status: 'ok' } },
		{ name: 'payload=null', payload: null },
	];
	for (const { name, payload } of cases) {
		resetRemoteLog();
		const { q } = makeQueue({}, { maxMessageSize: 65536 });
		injectBinaryItem(q, MAX_QUEUE_BYTES + 1);
		const frame = JSON.stringify({ type: 'res', id: 1, ok: true, payload });
		const ok = q.send(frame);
		assert.equal(ok, false, `${name} 应 drop`);
		assert.equal(q.droppedCount, 1, `${name} droppedCount 应+1`);
	}
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
