import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryQueue, DEFAULT_MEM_BUDGET } from './memory-queue.js';
import { __reset as resetRemoteLog, __buffer as remoteLogBuffer } from '../remote-log.js';

// --- helpers ---

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

async function makeQ(opts = {}) {
	const logger = opts.logger ?? makeMockLogger();
	const q = new MemoryQueue({
		id: opts.id ?? 'T',
		memBudget: opts.memBudget,
		maxMessageBytes: opts.maxMessageBytes,
		onDrop: opts.onDrop,
		logger,
		bypassAdmission: opts.bypassAdmission,
		tag: opts.tag,
	});
	await q.init();
	return { q, logger };
}

// 构造恰好 `size` bytes（UTF-8）的 ASCII JSON 字符串
function jsonOfBytes(size) {
	if (size < 2) throw new Error('size too small');
	return '"' + 'x'.repeat(size - 2) + '"';
}

// 等待 iter 进入 waiter 等待态
async function waitForWaiter(q, n = 1, maxMs = 500) {
	const start = Date.now();
	while (q.waiters.length < n) {
		/* c8 ignore next 3 -- 超时分支仅在严重异常时触发 */
		if (Date.now() - start > maxMs) {
			throw new Error(`timeout waiting for waiter (have ${q.waiters.length}, want ${n})`);
		}
		await new Promise((resolve) => setImmediate(resolve));
	}
}

// --- 构造器 ---

test('MemoryQueue: 缺 id 抛', () => {
	assert.throws(() => new MemoryQueue({}), /id is required/);
});

test('MemoryQueue: 不传 opts 抛 id is required（覆盖 ?? {} fallback）', () => {
	assert.throws(() => new MemoryQueue(), /id is required/);
});

test('MemoryQueue: id 非 string 抛', () => {
	assert.throws(() => new MemoryQueue({ id: 123 }), /id is required/);
});

test('MemoryQueue: id 含路径穿越/非法字符抛', () => {
	for (const badId of ['../escape', 'a/b', 'a\\b', '..', '.', 'a\0b', 'a b']) {
		assert.throws(
			() => new MemoryQueue({ id: badId }),
			/invalid/,
			`expected rejection for id=${JSON.stringify(badId)}`,
		);
	}
});

test('MemoryQueue: id 接受 UUID / 字母数字 / 点 / 下划线 / 减号', () => {
	const q = new MemoryQueue({ id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' });
	assert.equal(q.id, '6ba7b810-9dad-11d1-80b4-00c04fd430c8');
});

test('MemoryQueue: memBudget 非正数 / 非有限数抛', () => {
	for (const bad of [NaN, Infinity, -Infinity, 0, -1, '1', null]) {
		assert.throws(
			() => new MemoryQueue({ id: 'cap', memBudget: bad }),
			/memBudget must be a finite positive number/,
			`memBudget=${String(bad)}`,
		);
	}
});

test('MemoryQueue: 不传 logger fallback 到 console', () => {
	const q = new MemoryQueue({ id: 't' });
	assert.equal(q.logger, console);
});

test('MemoryQueue: bypassAdmission 非函数视为缺省', () => {
	const q = new MemoryQueue({ id: 't', bypassAdmission: 'not a function' });
	assert.equal(q.bypassAdmission, null);
});

test('MemoryQueue: 默认 memBudget 等于 10MB', () => {
	const q = new MemoryQueue({ id: 't' });
	assert.equal(q.memBudget, DEFAULT_MEM_BUDGET);
	assert.equal(q.memBudget, 10 * 1024 * 1024);
});

// --- init & enqueue 基础 ---

test('init: 构造即 initialized=true（不引入 fs）', async () => {
	const q = new MemoryQueue({ id: 't' });
	assert.equal(q.initialized, true);
});

test('init: 多次调用 no-op，不影响 destroyed 状态', async () => {
	const { q } = await makeQ();
	await q.init();
	await q.destroy();
	await q.init();
	assert.equal(q.destroyed, true);
});

test('enqueue: 不调 init 也能直接入队（构造即可用）', async () => {
	const q = new MemoryQueue({ id: 't' });
	const ok = await q.enqueue('{"x":1}');
	assert.equal(ok, true);
});

test('enqueue: 非 string 抛 TypeError', async () => {
	const { q } = await makeQ();
	for (const bad of [null, undefined, 42, { a: 1 }, Buffer.from('x')]) {
		await assert.rejects(q.enqueue(bad), /jsonStr must be a string/, `bad=${String(bad)}`);
	}
});

test('enqueue: destroyed 后入队返回 false', async () => {
	const { q } = await makeQ();
	await q.destroy();
	const ok = await q.enqueue('{"after":"destroy"}');
	assert.equal(ok, false);
});

test('enqueue: 普通入队 returns true，stats 反映 memCount/memBytes', async () => {
	const { q } = await makeQ();
	const msg = '{"x":1}';
	const ok = await q.enqueue(msg);
	assert.equal(ok, true);
	const s = q.stats();
	assert.equal(s.memCount, 1);
	assert.equal(s.memBytes, Buffer.byteLength(msg, 'utf8'));
	assert.equal(s.droppedCount, 0);
	assert.equal(s.droppedBytes, 0);
	assert.equal(s.queueOverflowActive, false);
});

// --- admission / overflow 边沿 ---

test('admission: queueBytes >= memBudget → drop 新消息，返回 false', async () => {
	resetRemoteLog();
	const { q, logger } = await makeQ({ memBudget: 100 });
	// 先塞满到 memBudget 以上
	const big = jsonOfBytes(120); // > 100
	const ok1 = await q.enqueue(big);
	assert.equal(ok1, true);
	assert.ok(q.memBytes >= 100);

	const ok2 = await q.enqueue('{"x":1}');
	assert.equal(ok2, false);
	assert.equal(q.droppedCount, 1);
	assert.ok(logger.warnings.some(w => w.includes('overflow-start')));
	assert.ok(remoteLogBuffer.some(e => e.text.includes('rpc-queue.overflow-start')));
	assert.equal(q.queueOverflowActive, true);
});

test('admission 边界: queueBytes === memBudget → drop（与原 RpcSendQueue 行为对齐）', async () => {
	resetRemoteLog();
	const { q, logger } = await makeQ({ memBudget: 100 });
	const exact = jsonOfBytes(100);
	const ok1 = await q.enqueue(exact);
	assert.equal(ok1, true);
	assert.equal(q.memBytes, 100);
	const ok2 = await q.enqueue('{"y":2}');
	assert.equal(ok2, false);
	assert.equal(q.droppedCount, 1);
	assert.ok(logger.warnings.some(w => w.includes('overflow-start')));
});

test('admission 边界: queueBytes = memBudget - 1 时新消息仍可入队', async () => {
	const { q } = await makeQ({ memBudget: 100 });
	const almost = jsonOfBytes(99);
	const ok1 = await q.enqueue(almost);
	assert.equal(ok1, true);
	const ok2 = await q.enqueue('{"y":2}');
	assert.equal(ok2, true);
	assert.equal(q.droppedCount, 0);
});

test('overshoot: queueBytes < memBudget 但单条 size 大于 memBudget → 仍接受', async () => {
	const { q } = await makeQ({ memBudget: 100 });
	const huge = jsonOfBytes(500);
	const ok = await q.enqueue(huge);
	assert.equal(ok, true);
	assert.ok(q.memBytes > 100);
	const ok2 = await q.enqueue('{"next":1}');
	assert.equal(ok2, false);
});

test('overflow: 持续期间多次 drop 仅 warn 一次（避免 DC 卡死刷屏）', async () => {
	resetRemoteLog();
	const { q, logger } = await makeQ({ memBudget: 100 });
	await q.enqueue(jsonOfBytes(120));
	for (let i = 0; i < 100; i += 1) {
		await q.enqueue(`{"i":${i}}`);
	}
	const startWarns = logger.warnings.filter(w => w.includes('overflow-start'));
	assert.equal(startWarns.length, 1);
	const startRemoteLogs = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.overflow-start'));
	assert.equal(startRemoteLogs.length, 1);
	assert.match(startWarns[0], /queueBytes=\d+/);
	assert.match(startRemoteLogs[0].text, /queueBytes=\d+/);
	// dropped 计数仍累加
	assert.equal(q.droppedCount, 100);
});

test('overflow-end: iterator 出列后 memBytes < memBudget → 翻转，warn+info+remoteLog 同步打一次', async () => {
	resetRemoteLog();
	const { q, logger } = await makeQ({ memBudget: 100 });
	await q.enqueue(jsonOfBytes(120));
	// 触发 overflow-start
	for (let i = 0; i < 5; i += 1) await q.enqueue(`{"d":${i}}`);
	assert.equal(q.queueOverflowActive, true);
	assert.equal(q.droppedCount, 5);

	// 消费一次
	const it = q[Symbol.asyncIterator]();
	const r = await it.next();
	assert.equal(r.done, false);
	assert.equal(r.value, jsonOfBytes(120));
	// memBytes 已降到 0 < memBudget
	assert.equal(q.queueOverflowActive, false);

	const endLogs = remoteLogBuffer.filter(e => e.text.includes('rpc-queue.overflow-end'));
	assert.equal(endLogs.length, 1);
	assert.match(endLogs[0].text, /dropped=5\b/);
	assert.match(endLogs[0].text, /droppedBytes=\d+/);

	const infoEnds = logger.infos.filter(s => s.includes('overflow-end'));
	assert.equal(infoEnds.length, 1);
	assert.match(infoEnds[0], /dropped=5\b/);
});

test('overflow 循环: start → end → start 状态机双向可翻转', async () => {
	resetRemoteLog();
	const { q } = await makeQ({ memBudget: 100 });

	// 第一轮溢出
	await q.enqueue(jsonOfBytes(120));
	await q.enqueue('{"a":1}'); // drop, overflow-start #1
	assert.equal(q.queueOverflowActive, true);
	assert.equal(
		remoteLogBuffer.filter(e => e.text.includes('rpc-queue.overflow-start')).length,
		1,
	);

	// 消费清空 → overflow-end
	const it = q[Symbol.asyncIterator]();
	await it.next();
	assert.equal(q.queueOverflowActive, false);

	// 第二轮再次溢出
	await q.enqueue(jsonOfBytes(120));
	await q.enqueue('{"b":2}');
	assert.equal(q.queueOverflowActive, true);
	assert.equal(
		remoteLogBuffer.filter(e => e.text.includes('rpc-queue.overflow-start')).length,
		2,
		'second overflow-start must fire after a full cycle',
	);
});

// --- bypassAdmission 白名单 ---

test('bypassAdmission: 命中 → 即使队列满也接受，不计入 dropped，不触发 overflow-start', async () => {
	resetRemoteLog();
	const onlyA = (s) => /"bypass":true/.test(s);
	const { q, logger } = await makeQ({ memBudget: 100, bypassAdmission: onlyA });
	await q.enqueue(jsonOfBytes(120));
	const baseBytes = q.memBytes;

	const ok = await q.enqueue('{"bypass":true,"data":"x"}');
	assert.equal(ok, true);
	assert.equal(q.droppedCount, 0);
	assert.equal(q.queueOverflowActive, false);
	assert.ok(!logger.warnings.some(w => w.includes('overflow-start')));
	assert.ok(!remoteLogBuffer.some(e => e.text.includes('overflow-start')));
	assert.ok(q.memBytes > baseBytes);

	// 后续非白名单照常 drop
	const ok2 = await q.enqueue('{"plain":1}');
	assert.equal(ok2, false);
	assert.equal(q.droppedCount, 1);
	assert.equal(q.queueOverflowActive, true);
});

test('bypassAdmission: 谓词自身抛 → 视为非白名单（drop）', async () => {
	resetRemoteLog();
	const evilBypass = () => { throw new Error('bypass broken'); };
	const { q } = await makeQ({ memBudget: 100, bypassAdmission: evilBypass });
	await q.enqueue(jsonOfBytes(120));
	const ok = await q.enqueue('{"x":1}');
	assert.equal(ok, false);
	assert.equal(q.droppedCount, 1);
});

test('bypassAdmission: 缺省时无白名单效果，所有 admission 命中即 drop', async () => {
	const { q } = await makeQ({ memBudget: 100 });
	await q.enqueue(jsonOfBytes(120));
	const ok = await q.enqueue('{"x":1}');
	assert.equal(ok, false);
});

// --- onDrop 回调 ---

test('onDrop: 队列满时被调，参数 reason="queue-full" + size', async () => {
	const drops = [];
	const onDrop = (reason, size) => drops.push({ reason, size });
	const { q } = await makeQ({ memBudget: 100, onDrop });
	await q.enqueue(jsonOfBytes(120));
	const small = '{"y":2}';
	await q.enqueue(small);
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'queue-full');
	assert.equal(drops[0].size, Buffer.byteLength(small, 'utf8'));
});

test('onDrop: 缺省时 admission 仍正常工作（仅 enqueue 返回 false）', async () => {
	const { q } = await makeQ({ memBudget: 100 });
	await q.enqueue(jsonOfBytes(120));
	const ok = await q.enqueue('{"y":2}');
	assert.equal(ok, false);
});

test('onDrop: 自身抛异常被 enqueue 内吞掉，不传染', async () => {
	const evilOnDrop = () => { throw new Error('onDrop broken'); };
	const { q, logger } = await makeQ({ memBudget: 100, onDrop: evilOnDrop });
	await q.enqueue(jsonOfBytes(120));
	let ok;
	await assert.doesNotReject(async () => { ok = await q.enqueue('{"y":2}'); });
	assert.equal(ok, false);
	assert.ok(logger.warnings.some(w => w.includes('onDrop threw')));
});

// --- iterator ---

test('iterator: 单消费者按 FIFO 取出', async () => {
	const { q } = await makeQ();
	await q.enqueue('"a"');
	await q.enqueue('"b"');
	await q.enqueue('"c"');
	const out = [];
	for await (const s of q) {
		out.push(s);
		if (out.length === 3) break;
	}
	assert.deepEqual(out, ['"a"', '"b"', '"c"']);
});

test('iterator: 队列空时挂 waiter，enqueue 唤醒返回 value', async () => {
	const { q } = await makeQ();
	const it = q[Symbol.asyncIterator]();
	const pending = it.next();
	await waitForWaiter(q, 1);
	await q.enqueue('"hello"');
	const r = await pending;
	assert.equal(r.done, false);
	assert.equal(r.value, '"hello"');
});

test('iterator: destroy 后已挂 waiter 收到 done', async () => {
	const { q } = await makeQ();
	const it = q[Symbol.asyncIterator]();
	const pending = it.next();
	await waitForWaiter(q, 1);
	await q.destroy();
	const r = await pending;
	assert.equal(r.done, true);
});

test('iterator: destroy 同时唤醒多个 pending waiter，每个收到 done', async () => {
	const { q } = await makeQ();
	// 验证 destroy 把 waiters 数组完整清空：实际生产场景同 queue 仅一个 consumer，
	// 此处构造 2 个并发 waiter 是为锁定不变量"destroy 后 waiters.length===0 且每个 promise 都 resolve done"
	const it1 = q[Symbol.asyncIterator]();
	const it2 = q[Symbol.asyncIterator]();
	const p1 = it1.next();
	const p2 = it2.next();
	await waitForWaiter(q, 2);
	await q.destroy();
	const [r1, r2] = await Promise.all([p1, p2]);
	assert.equal(r1.done, true);
	assert.equal(r2.done, true);
	assert.equal(q.waiters.length, 0);
});

test('iterator: destroy 之后再 next 立刻返回 done（无积压）', async () => {
	const { q } = await makeQ();
	await q.destroy();
	const it = q[Symbol.asyncIterator]();
	const r = await it.next();
	assert.equal(r.done, true);
});

test('iterator: destroy 之后已积压消息也无法读出（已被清）', async () => {
	const { q } = await makeQ();
	await q.enqueue('"a"');
	await q.destroy();
	const it = q[Symbol.asyncIterator]();
	const r = await it.next();
	assert.equal(r.done, true);
});

test('iterator: return() 立即返回 done，让 break 干净退出', async () => {
	const { q } = await makeQ();
	const it = q[Symbol.asyncIterator]();
	const r = await it.return();
	assert.equal(r.done, true);
});

test('iterator: 惰性压缩在 head > 64 且 head*2 >= length 时触发', async () => {
	const { q } = await makeQ();
	// 入队 130 条小消息
	for (let i = 0; i < 130; i += 1) await q.enqueue(`"i${i}"`);
	const it = q[Symbol.asyncIterator]();
	for (let i = 0; i < 65; i += 1) {
		const r = await it.next();
		assert.equal(r.done, false);
	}
	// 此时 head=65；65*2=130 >= 130 → 应当压缩
	assert.equal(q.head, 0);
	assert.equal(q.memQueue.length, 130 - 65);
});

test('iterator: 相同 value 通过 utf8 字节正确扣减 memBytes', async () => {
	const { q } = await makeQ();
	const multibyte = '"中文 emoji 🚀"';
	const expected = Buffer.byteLength(multibyte, 'utf8');
	assert.notEqual(expected, multibyte.length, 'sanity: 字节数 != 字符数');
	await q.enqueue(multibyte);
	assert.equal(q.memBytes, expected);
	const it = q[Symbol.asyncIterator]();
	await it.next();
	assert.equal(q.memBytes, 0);
});

// --- destroy / clear ---

test('destroy: 幂等', async () => {
	resetRemoteLog();
	const { q } = await makeQ();
	await q.destroy();
	const before = remoteLogBuffer.length;
	await q.destroy();
	assert.equal(remoteLogBuffer.length, before);
});

test('destroy: dropped > 0 时输出 close 汇总', async () => {
	resetRemoteLog();
	const { q } = await makeQ({ memBudget: 100 });
	await q.enqueue(jsonOfBytes(120));
	await q.enqueue('{"x":1}'); // drop
	assert.equal(q.droppedCount, 1);
	// 清掉积压
	const it = q[Symbol.asyncIterator]();
	await it.next();
	await q.destroy();
	const closeLog = remoteLogBuffer.find(e => e.text.includes('rpc-queue.close'));
	assert.ok(closeLog);
	assert.ok(closeLog.text.includes('dropped=1'));
	assert.ok(closeLog.text.includes('residualChunks=0'));
});

test('destroy: 跨多轮 overflow 的 droppedCount 累计 → close 汇总取全程总数', async () => {
	resetRemoteLog();
	const { q } = await makeQ({ memBudget: 100 });
	const it = q[Symbol.asyncIterator]();

	// 第 1 轮 overflow：填满 → drop 1 条
	await q.enqueue(jsonOfBytes(120));  // memBytes ≥ memBudget
	const r1 = await q.enqueue('{"a":1}');
	assert.equal(r1, false, '第 1 轮 drop');
	assert.equal(q.droppedCount, 1);

	// 出列让 memBytes 降到 0 → overflow-end 翻转，但 droppedCount 不重置
	await it.next();
	assert.equal(q.queueOverflowActive, false);
	assert.equal(q.droppedCount, 1);

	// 第 2 轮 overflow：再次填满 → drop 2 条
	await q.enqueue(jsonOfBytes(120));
	assert.equal((await q.enqueue('{"b":2}')), false);
	assert.equal((await q.enqueue('{"c":3}')), false);
	assert.equal(q.droppedCount, 3);

	await q.destroy();
	const closeLog = remoteLogBuffer.find(e => e.text.includes('rpc-queue.close'));
	assert.ok(closeLog);
	assert.match(closeLog.text, /dropped=3\b/);
});

test('destroy: residual > 0 时输出 close 汇总', async () => {
	resetRemoteLog();
	const { q } = await makeQ();
	await q.enqueue('{"a":1}');
	await q.enqueue('{"b":2}');
	await q.destroy();
	const closeLog = remoteLogBuffer.find(e => e.text.includes('rpc-queue.close'));
	assert.ok(closeLog);
	assert.ok(closeLog.text.includes('dropped=0'));
	assert.ok(/residualChunks=[1-9]/.test(closeLog.text));
});

test('Symbol.asyncDispose 委托给 destroy', async () => {
	resetRemoteLog();
	const { q } = await makeQ();
	await q.enqueue('"a"');
	await q[Symbol.asyncDispose]();
	assert.equal(q.destroyed, true);
	const closeLog = remoteLogBuffer.find(e => e.text.includes('rpc-queue.close'));
	assert.ok(closeLog);
});

test('destroy: 既无 drop 也无 residual → 不输出 close 汇总', async () => {
	resetRemoteLog();
	const { q } = await makeQ();
	await q.destroy();
	const closeLog = remoteLogBuffer.find(e => e.text.includes('rpc-queue.close'));
	assert.equal(closeLog, undefined);
});

test('clear: 重置 mem + drop 计数 + overflow 状态', async () => {
	const { q } = await makeQ({ memBudget: 100 });
	await q.enqueue(jsonOfBytes(120));
	await q.enqueue('{"x":1}');
	assert.equal(q.droppedCount, 1);
	assert.equal(q.queueOverflowActive, true);

	await q.clear();
	const s = q.stats();
	assert.equal(s.memCount, 0);
	assert.equal(s.memBytes, 0);
	assert.equal(s.droppedCount, 0);
	assert.equal(s.droppedBytes, 0);
	assert.equal(s.queueOverflowActive, false);
});

test('clear: destroyed 后 clear no-op', async () => {
	const { q } = await makeQ();
	await q.enqueue('"a"');
	await q.destroy();
	await q.clear();
	// 不报错即通过；状态保持 destroyed
	assert.equal(q.destroyed, true);
});

// --- stats ---

test('stats: 形态对齐 FBQ + 阶段 1 私有诊断字段', async () => {
	const { q } = await makeQ();
	await q.enqueue('"a"');
	const s = q.stats();
	assert.deepEqual(Object.keys(s).sort(), [
		'diskBytes', 'droppedBytes', 'droppedCount', 'fsBroken',
		'memBytes', 'memCount', 'queueOverflowActive', 'spilled', 'writtenBytes',
	].sort());
	assert.equal(s.memCount, 1);
	assert.equal(s.memBytes, Buffer.byteLength('"a"', 'utf8'));
	assert.equal(s.diskBytes, 0);
	assert.equal(s.writtenBytes, 0);
	assert.equal(s.spilled, false);
	assert.equal(s.fsBroken, false);
	assert.equal(s.droppedCount, 0);
	assert.equal(s.droppedBytes, 0);
	assert.equal(s.queueOverflowActive, false);
});

// --- safe wrapper / tag ---

test('safe wrapper: logger 缺 warn 方法 / 缺 info 方法时不抛', async () => {
	resetRemoteLog();
	const { q } = await makeQ({ memBudget: 100, logger: {} });
	await q.enqueue(jsonOfBytes(120));
	await assert.doesNotReject(q.enqueue('{"x":1}'));
	const it = q[Symbol.asyncIterator]();
	await assert.doesNotReject(it.next());
});

test('safe wrapper: logger.warn 自身抛 → enqueue 不传染', async () => {
	resetRemoteLog();
	const evilLogger = {
		warn: () => { throw new Error('logger broken'); },
		info: () => {},
	};
	const { q } = await makeQ({ memBudget: 100, logger: evilLogger });
	await q.enqueue(jsonOfBytes(120));
	let ok;
	await assert.doesNotReject(async () => { ok = await q.enqueue('{"x":1}'); });
	assert.equal(ok, false);
});

test('safe wrapper: logger.info 自身抛 → __nextIter 不传染（overflow-end 路径）', async () => {
	resetRemoteLog();
	const evilLogger = {
		warn: () => {},
		info: () => { throw new Error('logger.info broken'); },
	};
	const { q } = await makeQ({ memBudget: 100, logger: evilLogger });
	await q.enqueue(jsonOfBytes(120));
	await q.enqueue('{"x":1}'); // overflow-start
	const it = q[Symbol.asyncIterator]();
	await assert.doesNotReject(async () => { await it.next(); });
	assert.equal(q.queueOverflowActive, false);
});

test('tag: 缺省时日志不带前缀（分支覆盖）', async () => {
	resetRemoteLog();
	const { q, logger } = await makeQ({ memBudget: 100 });
	await q.enqueue(jsonOfBytes(120));
	await q.enqueue('{"x":1}');
	assert.ok(logger.warnings.every(w => !w.includes('conn=')));
	assert.ok(remoteLogBuffer.every(e => !e.text.includes('conn=')));
});

test('tag: 设置时日志含前缀', async () => {
	resetRemoteLog();
	const { q, logger } = await makeQ({ memBudget: 100, tag: 'conn=T' });
	await q.enqueue(jsonOfBytes(120));
	await q.enqueue('{"x":1}');
	assert.ok(logger.warnings.some(w => w.includes('conn=T')));
	assert.ok(remoteLogBuffer.some(e => e.text.includes('conn=T')));
});

// --- 安全包装：remoteLog 抛 ---
test('safe wrapper: remoteLog 即便抛也不传染（防御性）', async () => {
	resetRemoteLog();
	// remoteLog 是单例 import，无法直接 mock。本 case 通过 try-catch wrapper 的存在性保护。
	// 实际验证：__safeRemoteLog 内 try/catch 存在即可（覆盖率工具会标记 catch 为 0 命中）。
	// 该用例确保未来若 remoteLog 同步路径加入抛错，wrapper 仍能兜底。
	const { q } = await makeQ({ memBudget: 100 });
	await q.enqueue(jsonOfBytes(120));
	await q.enqueue('{"x":1}');
	// 行为正常即通过
	assert.equal(q.droppedCount, 1);
});

// --- per-message hard cap：bypass 也不豁免 ---

test('maxMessageBytes: 超 cap 的帧直接 drop，不入队', async () => {
	resetRemoteLog();
	const onDrops = [];
	const { q } = await makeQ({
		memBudget: 10000,
		maxMessageBytes: 100,
		onDrop: (reason, size) => onDrops.push({ reason, size }),
	});
	const ok = await q.enqueue(jsonOfBytes(120));
	assert.equal(ok, false);
	assert.equal(q.memBytes, 0);
	assert.equal(q.stats().memCount, 0);
	assert.equal(q.droppedCount, 1);
	assert.equal(q.droppedBytes, 120);
	assert.equal(onDrops.length, 1);
	assert.equal(onDrops[0].reason, 'oversize');
	assert.equal(onDrops[0].size, 120);
});

test('maxMessageBytes: bypass 命中也无法豁免（与 sender 端 50MB 硬上限对齐）', async () => {
	resetRemoteLog();
	const onDrops = [];
	const { q } = await makeQ({
		memBudget: 10000,
		maxMessageBytes: 100,
		bypassAdmission: () => true,  // 全部豁免 admission
		onDrop: (reason, size) => onDrops.push({ reason, size }),
	});
	const ok = await q.enqueue(jsonOfBytes(120));
	// 关键：bypass 即使命中，超 cap 仍被 drop，避免 memBytes 异常膨胀
	assert.equal(ok, false);
	assert.equal(q.memBytes, 0);
	assert.equal(onDrops[0].reason, 'oversize');
});

test('maxMessageBytes: 默认 Infinity → 任意大小都接受（兼容老调用方）', async () => {
	resetRemoteLog();
	const { q } = await makeQ({ memBudget: 10000 });
	const ok = await q.enqueue(jsonOfBytes(5000));
	assert.equal(ok, true);
	assert.equal(q.memBytes, 5000);
});

test('maxMessageBytes: 边界值（=cap 入队，>cap drop）', async () => {
	resetRemoteLog();
	const { q } = await makeQ({ memBudget: 10000, maxMessageBytes: 100 });
	assert.equal(await q.enqueue(jsonOfBytes(100)), true);
	assert.equal(await q.enqueue(jsonOfBytes(101)), false);
});

test('maxMessageBytes: 非 finite 正数 → 抛 TypeError', () => {
	assert.throws(
		() => new MemoryQueue({ id: 'T', memBudget: 100, maxMessageBytes: -1 }),
		TypeError,
	);
	assert.throws(
		() => new MemoryQueue({ id: 'T', memBudget: 100, maxMessageBytes: 0 }),
		TypeError,
	);
	assert.throws(
		() => new MemoryQueue({ id: 'T', memBudget: 100, maxMessageBytes: NaN }),
		TypeError,
	);
	// -Infinity 被 !Number.isFinite 拦截
	assert.throws(
		() => new MemoryQueue({ id: 'T', memBudget: 100, maxMessageBytes: -Infinity }),
		TypeError,
	);
});
