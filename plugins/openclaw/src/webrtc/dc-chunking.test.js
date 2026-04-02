import test from 'node:test';
import assert from 'node:assert/strict';
import {
	chunkAndSend,
	createReassembler,
	FLAG_BEGIN,
	FLAG_MIDDLE,
	FLAG_END,
	HEADER_SIZE,
	MAX_REASSEMBLY_BYTES,
	MAX_CHUNKS_PER_MSG,
} from './dc-chunking.js';

// --- helpers ---

function mockDc() {
	const sent = [];
	return {
		sent,
		send(data) { sent.push(data); },
	};
}

function silentLogger() {
	const warnings = [];
	return {
		warnings,
		info() {},
		warn(...args) { warnings.push(args.join(' ')); },
		error() {},
		debug() {},
	};
}

let globalMsgId = 0;
function nextMsgId() { return ++globalMsgId; }

// --- chunkAndSend ---

test('chunkAndSend: 小消息不分片，直接 send string', () => {
	const dc = mockDc();
	chunkAndSend(dc, '{"ok":true}', 100, nextMsgId);
	assert.equal(dc.sent.length, 1);
	assert.equal(typeof dc.sent[0], 'string');
	assert.equal(dc.sent[0], '{"ok":true}');
});

test('chunkAndSend: 恰好等于 maxMessageSize 不分片', () => {
	const dc = mockDc();
	const msg = 'x'.repeat(50);
	const byteLen = Buffer.byteLength(msg, 'utf8');
	chunkAndSend(dc, msg, byteLen, nextMsgId);
	assert.equal(dc.sent.length, 1);
	assert.equal(typeof dc.sent[0], 'string');
});

test('chunkAndSend: 超过 maxMessageSize 分片为 2 个 chunk', () => {
	const dc = mockDc();
	// maxMessageSize=30, HEADER_SIZE=5, chunkPayloadSize=25
	// 消息 31 字节 → ceil(31/25) = 2 chunks
	const msg = 'a'.repeat(31);
	let id = 0;
	chunkAndSend(dc, msg, 30, () => ++id);

	assert.equal(dc.sent.length, 2);
	assert.ok(Buffer.isBuffer(dc.sent[0]));
	assert.ok(Buffer.isBuffer(dc.sent[1]));

	// 首块 flag=BEGIN
	assert.equal(dc.sent[0][0], FLAG_BEGIN);
	// 末块 flag=END
	assert.equal(dc.sent[1][0], FLAG_END);

	// 两块 msgId 相同
	const msgId1 = dc.sent[0].readUInt32BE(1);
	const msgId2 = dc.sent[1].readUInt32BE(1);
	assert.equal(msgId1, msgId2);
	assert.equal(msgId1, 1);
});

test('chunkAndSend: 大消息产生正确数量的 chunk，每个 ≤ maxMessageSize', () => {
	const dc = mockDc();
	const msg = JSON.stringify({ data: 'x'.repeat(500) });
	const maxSize = 100;
	let id = 0;
	chunkAndSend(dc, msg, maxSize, () => ++id);

	assert.ok(dc.sent.length > 1);
	for (const chunk of dc.sent) {
		assert.ok(Buffer.isBuffer(chunk));
		assert.ok(chunk.length <= maxSize, `chunk size ${chunk.length} exceeds ${maxSize}`);
	}

	// 验证首/中/末 flag
	assert.equal(dc.sent[0][0], FLAG_BEGIN);
	assert.equal(dc.sent[dc.sent.length - 1][0], FLAG_END);
	for (let i = 1; i < dc.sent.length - 1; i++) {
		assert.equal(dc.sent[i][0], FLAG_MIDDLE);
	}
});

test('chunkAndSend: msgId 正确写入 uint32 BE', () => {
	const dc = mockDc();
	const msg = 'y'.repeat(50);
	chunkAndSend(dc, msg, 30, () => 42);
	assert.equal(dc.sent[0].readUInt32BE(1), 42);
});

test('chunkAndSend: 多字节 UTF-8 字符（中文）正确分片', () => {
	const dc = mockDc();
	// 每个中文字符 3 字节 UTF-8
	const msg = '你好世界测试分片重组功能';
	const byteLen = Buffer.byteLength(msg, 'utf8');
	assert.ok(byteLen > msg.length); // 确认多字节

	let id = 0;
	chunkAndSend(dc, msg, 20, () => ++id);
	assert.ok(dc.sent.length > 1);

	// 拼合所有 chunk 数据，解码后应等于原消息
	const payloads = dc.sent.map((buf) => buf.subarray(HEADER_SIZE));
	const merged = Buffer.concat(payloads);
	assert.equal(merged.toString('utf8'), msg);
});

test('chunkAndSend: maxMessageSize 太小抛异常', () => {
	const dc = mockDc();
	assert.throws(
		() => chunkAndSend(dc, 'x'.repeat(10), HEADER_SIZE, nextMsgId),
		/too small/,
	);
});

// --- createReassembler ---

test('createReassembler: string 消息直接回调', () => {
	const received = [];
	const r = createReassembler((s) => received.push(s));
	r.feed('{"type":"req"}');
	assert.equal(received.length, 1);
	assert.equal(received[0], '{"type":"req"}');
});

test('createReassembler: 2 chunk 分片消息正确重组', () => {
	const received = [];
	const r = createReassembler((s) => received.push(s));
	const original = '{"data":"hello world 12345"}';
	const bytes = Buffer.from(original, 'utf8');
	const mid = Math.floor(bytes.length / 2);

	// BEGIN chunk
	const begin = Buffer.allocUnsafe(HEADER_SIZE + mid);
	begin[0] = FLAG_BEGIN;
	begin.writeUInt32BE(1, 1);
	bytes.copy(begin, HEADER_SIZE, 0, mid);
	r.feed(begin);
	assert.equal(received.length, 0); // 未完成

	// END chunk
	const end = Buffer.allocUnsafe(HEADER_SIZE + (bytes.length - mid));
	end[0] = FLAG_END;
	end.writeUInt32BE(1, 1);
	bytes.copy(end, HEADER_SIZE, mid);
	r.feed(end);
	assert.equal(received.length, 1);
	assert.equal(received[0], original);
});

test('createReassembler: 多 chunk 分片正确重组', () => {
	const received = [];
	const r = createReassembler((s) => received.push(s));
	const original = 'A'.repeat(300);
	const bytes = Buffer.from(original, 'utf8');
	const chunkSize = 100;
	const msgId = 5;

	for (let i = 0; i < Math.ceil(bytes.length / chunkSize); i++) {
		const start = i * chunkSize;
		const endPos = Math.min(start + chunkSize, bytes.length);
		const total = Math.ceil(bytes.length / chunkSize);
		const flag = i === 0 ? FLAG_BEGIN : (i === total - 1 ? FLAG_END : FLAG_MIDDLE);
		const chunk = Buffer.allocUnsafe(HEADER_SIZE + (endPos - start));
		chunk[0] = flag;
		chunk.writeUInt32BE(msgId, 1);
		bytes.copy(chunk, HEADER_SIZE, start, endPos);
		r.feed(chunk);
	}

	assert.equal(received.length, 1);
	assert.equal(received[0], original);
});

test('createReassembler: 中文/emoji UTF-8 重组正确', () => {
	const received = [];
	const r = createReassembler((s) => received.push(s));
	const original = JSON.stringify({ msg: '你好世界🌍测试' });
	const bytes = Buffer.from(original, 'utf8');
	const chunkSize = 10;
	const msgId = 7;
	const total = Math.ceil(bytes.length / chunkSize);

	for (let i = 0; i < total; i++) {
		const start = i * chunkSize;
		const endPos = Math.min(start + chunkSize, bytes.length);
		const flag = i === 0 ? FLAG_BEGIN : (i === total - 1 ? FLAG_END : FLAG_MIDDLE);
		const chunk = Buffer.allocUnsafe(HEADER_SIZE + (endPos - start));
		chunk[0] = flag;
		chunk.writeUInt32BE(msgId, 1);
		bytes.copy(chunk, HEADER_SIZE, start, endPos);
		r.feed(chunk);
	}

	assert.equal(received.length, 1);
	assert.deepEqual(JSON.parse(received[0]), JSON.parse(original));
});

test('createReassembler: 分片中夹杂普通 string 消息，各自独立处理', () => {
	const received = [];
	const r = createReassembler((s) => received.push(s));
	const original = 'CHUNKED_MSG_DATA_HERE_12345';
	const bytes = Buffer.from(original, 'utf8');
	const mid = Math.floor(bytes.length / 2);
	const msgId = 10;

	// BEGIN chunk
	const begin = Buffer.allocUnsafe(HEADER_SIZE + mid);
	begin[0] = FLAG_BEGIN;
	begin.writeUInt32BE(msgId, 1);
	bytes.copy(begin, HEADER_SIZE, 0, mid);
	r.feed(begin);

	// 中间插入一条普通 string 消息
	r.feed('{"type":"event","event":"status"}');

	// END chunk
	const end = Buffer.allocUnsafe(HEADER_SIZE + (bytes.length - mid));
	end[0] = FLAG_END;
	end.writeUInt32BE(msgId, 1);
	bytes.copy(end, HEADER_SIZE, mid);
	r.feed(end);

	assert.equal(received.length, 2);
	// 第一条是插入的 string 消息
	assert.equal(received[0], '{"type":"event","event":"status"}');
	// 第二条是重组后的分片消息
	assert.equal(received[1], original);
});

test('createReassembler: 多条分片消息交错到达（不同 msgId）', () => {
	const received = [];
	const r = createReassembler((s) => received.push(s));
	const msgA = 'MESSAGE_A';
	const msgB = 'MESSAGE_B';
	const bytesA = Buffer.from(msgA, 'utf8');
	const bytesB = Buffer.from(msgB, 'utf8');

	// A BEGIN
	const aBegin = Buffer.allocUnsafe(HEADER_SIZE + 5);
	aBegin[0] = FLAG_BEGIN;
	aBegin.writeUInt32BE(20, 1);
	bytesA.copy(aBegin, HEADER_SIZE, 0, 5);
	r.feed(aBegin);

	// B BEGIN
	const bBegin = Buffer.allocUnsafe(HEADER_SIZE + 5);
	bBegin[0] = FLAG_BEGIN;
	bBegin.writeUInt32BE(21, 1);
	bytesB.copy(bBegin, HEADER_SIZE, 0, 5);
	r.feed(bBegin);

	// A END
	const aEnd = Buffer.allocUnsafe(HEADER_SIZE + (bytesA.length - 5));
	aEnd[0] = FLAG_END;
	aEnd.writeUInt32BE(20, 1);
	bytesA.copy(aEnd, HEADER_SIZE, 5);
	r.feed(aEnd);

	// B END
	const bEnd = Buffer.allocUnsafe(HEADER_SIZE + (bytesB.length - 5));
	bEnd[0] = FLAG_END;
	bEnd.writeUInt32BE(21, 1);
	bytesB.copy(bEnd, HEADER_SIZE, 5);
	r.feed(bEnd);

	assert.equal(received.length, 2);
	assert.equal(received[0], msgA);
	assert.equal(received[1], msgB);
});

test('createReassembler: 超过 MAX_REASSEMBLY_BYTES 丢弃并 warn', () => {
	const logger = silentLogger();
	const received = [];
	const r = createReassembler((s) => received.push(s), { logger });

	// 构造一个 BEGIN chunk，声称有大量数据
	const bigPayload = Buffer.alloc(1024);
	const begin = Buffer.allocUnsafe(HEADER_SIZE + bigPayload.length);
	begin[0] = FLAG_BEGIN;
	begin.writeUInt32BE(30, 1);
	bigPayload.copy(begin, HEADER_SIZE);
	r.feed(begin);

	// 模拟超过上限：通过修改内部状态不现实，改用填充大量 MIDDLE chunk
	// 简化：直接验证逻辑 — 构造一个 MIDDLE 使 totalBytes 超限
	const hugePayload = Buffer.alloc(MAX_REASSEMBLY_BYTES);
	const middle = Buffer.allocUnsafe(HEADER_SIZE + hugePayload.length);
	middle[0] = FLAG_MIDDLE;
	middle.writeUInt32BE(30, 1);
	hugePayload.copy(middle, HEADER_SIZE);
	r.feed(middle);

	assert.ok(logger.warnings.some((w) => w.includes('exceeded')));
	assert.equal(received.length, 0);

	// 后续同 msgId 的 END 应被忽略（已清理）
	const end = Buffer.allocUnsafe(HEADER_SIZE + 1);
	end[0] = FLAG_END;
	end.writeUInt32BE(30, 1);
	end[HEADER_SIZE] = 0x41;
	r.feed(end);
	assert.equal(received.length, 0);
});

test('createReassembler: reset 清空缓冲区', () => {
	const received = [];
	const r = createReassembler((s) => received.push(s));

	// 发 BEGIN 不发 END
	const begin = Buffer.allocUnsafe(HEADER_SIZE + 5);
	begin[0] = FLAG_BEGIN;
	begin.writeUInt32BE(40, 1);
	begin.write('hello', HEADER_SIZE);
	r.feed(begin);

	r.reset();

	// reset 后同 msgId 的 END 不应重组成功
	const end = Buffer.allocUnsafe(HEADER_SIZE + 5);
	end[0] = FLAG_END;
	end.writeUInt32BE(40, 1);
	end.write('world', HEADER_SIZE);
	r.feed(end);
	assert.equal(received.length, 0);
});

test('createReassembler: 重复 BEGIN 丢弃旧的未完成重组', () => {
	const logger = silentLogger();
	const received = [];
	const r = createReassembler((s) => received.push(s), { logger });

	// 第一次 BEGIN（msgId=50）
	const begin1 = Buffer.allocUnsafe(HEADER_SIZE + 3);
	begin1[0] = FLAG_BEGIN;
	begin1.writeUInt32BE(50, 1);
	begin1.write('OLD', HEADER_SIZE);
	r.feed(begin1);

	// 同 msgId 再次 BEGIN → 旧的应被丢弃
	const begin2 = Buffer.allocUnsafe(HEADER_SIZE + 3);
	begin2[0] = FLAG_BEGIN;
	begin2.writeUInt32BE(50, 1);
	begin2.write('NEW', HEADER_SIZE);
	r.feed(begin2);

	assert.ok(logger.warnings.some((w) => w.includes('orphan')));

	// END → 应重组 "NEW" 而非 "OLD"
	const end = Buffer.allocUnsafe(HEADER_SIZE + 4);
	end[0] = FLAG_END;
	end.writeUInt32BE(50, 1);
	end.write('_END', HEADER_SIZE);
	r.feed(end);

	assert.equal(received.length, 1);
	assert.equal(received[0], 'NEW_END');
});

test('createReassembler: chunk 太短被忽略', () => {
	const logger = silentLogger();
	const received = [];
	const r = createReassembler((s) => received.push(s), { logger });
	r.feed(Buffer.alloc(3)); // 小于 HEADER_SIZE
	assert.equal(received.length, 0);
	assert.ok(logger.warnings.some((w) => w.includes('too short')));
});

test('createReassembler: 超过 MAX_CHUNKS_PER_MSG 丢弃并 warn', () => {
	const logger = silentLogger();
	const received = [];
	const r = createReassembler((s) => received.push(s), { logger });
	const msgId = 60;

	// BEGIN
	const begin = Buffer.allocUnsafe(HEADER_SIZE + 1);
	begin[0] = FLAG_BEGIN;
	begin.writeUInt32BE(msgId, 1);
	begin[HEADER_SIZE] = 0x41;
	r.feed(begin);

	// 发 MAX_CHUNKS_PER_MSG 个 MIDDLE（填满上限）
	for (let i = 0; i < MAX_CHUNKS_PER_MSG; i++) {
		const mid = Buffer.allocUnsafe(HEADER_SIZE + 1);
		mid[0] = FLAG_MIDDLE;
		mid.writeUInt32BE(msgId, 1);
		mid[HEADER_SIZE] = 0x42;
		r.feed(mid);
		// 达到上限后应触发丢弃
		if (i === MAX_CHUNKS_PER_MSG - 1) {
			assert.ok(logger.warnings.some((w) => w.includes('too many chunks')));
		}
	}

	assert.equal(received.length, 0);

	// 后续 END 应被忽略
	const end = Buffer.allocUnsafe(HEADER_SIZE + 1);
	end[0] = FLAG_END;
	end.writeUInt32BE(msgId, 1);
	end[HEADER_SIZE] = 0x43;
	r.feed(end);
	assert.equal(received.length, 0);
});

test('createReassembler: MIDDLE/END 对未知 msgId 被忽略', () => {
	const logger = silentLogger();
	const received = [];
	const r = createReassembler((s) => received.push(s), { logger });

	const middle = Buffer.allocUnsafe(HEADER_SIZE + 3);
	middle[0] = FLAG_MIDDLE;
	middle.writeUInt32BE(999, 1);
	middle.write('abc', HEADER_SIZE);
	r.feed(middle);

	assert.equal(received.length, 0);
	assert.ok(logger.warnings.some((w) => w.includes('unknown msgId')));
});

// --- 集成测试：chunkAndSend + createReassembler ---

test('集成: chunkAndSend 分片 → createReassembler 重组 → 结果一致', () => {
	const dc = mockDc();
	const original = JSON.stringify({ type: 'res', data: 'x'.repeat(500), nested: { arr: [1, 2, 3] } });
	let id = 0;
	chunkAndSend(dc, original, 100, () => ++id);
	assert.ok(dc.sent.length > 1);

	const received = [];
	const r = createReassembler((s) => received.push(s));
	for (const chunk of dc.sent) {
		r.feed(chunk);
	}
	assert.equal(received.length, 1);
	assert.equal(received[0], original);
});

test('集成: 多条消息连续发送/接收，全部正确重组', () => {
	const dc = mockDc();
	const messages = [
		JSON.stringify({ id: 1, small: true }),
		JSON.stringify({ id: 2, data: 'y'.repeat(300) }),
		JSON.stringify({ id: 3, data: 'z'.repeat(200) }),
	];
	let id = 0;
	for (const msg of messages) {
		chunkAndSend(dc, msg, 80, () => ++id);
	}

	const received = [];
	const r = createReassembler((s) => received.push(s));
	for (const item of dc.sent) {
		r.feed(item);
	}

	assert.equal(received.length, 3);
	assert.equal(received[0], messages[0]);
	assert.equal(received[1], messages[1]);
	assert.equal(received[2], messages[2]);
});

test('集成: 分片消息中夹杂不分片消息，全部正确交付', () => {
	const dc = mockDc();
	const large = JSON.stringify({ type: 'res', data: 'L'.repeat(200) });
	const small = JSON.stringify({ type: 'event', event: 'ping' });
	let id = 0;

	// 先发大消息（会分片）
	chunkAndSend(dc, large, 80, () => ++id);
	const chunkedItems = [...dc.sent];

	// 再发小消息（不分片）
	dc.sent.length = 0;
	chunkAndSend(dc, small, 80, () => ++id);
	const smallItem = dc.sent[0];

	// 模拟接收：chunk1, chunk2, small, chunk3(END)
	const received = [];
	const r = createReassembler((s) => received.push(s));

	// 发前两个 chunk
	r.feed(chunkedItems[0]);
	r.feed(chunkedItems[1]);
	// 插入小消息
	r.feed(smallItem);
	// 发剩余 chunk
	for (let i = 2; i < chunkedItems.length; i++) {
		r.feed(chunkedItems[i]);
	}

	// 小消息先到达（string 立即交付），大消息后到达（END chunk 时交付）
	assert.equal(received.length, 2);
	assert.equal(received[0], small);
	assert.equal(received[1], large);
});
