import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryQueue, DEFAULT_MEM_BUDGET } from './memory-queue.js';

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
});

// --- admission ---

test('admission: queueBytes >= memBudget → drop 新消息，返回 false + 触发 onDrop(queue-full)', async () => {
	const drops = [];
	const { q } = await makeQ({ memBudget: 100, onDrop: (reason, size) => drops.push({ reason, size }) });
	const big = jsonOfBytes(120); // > 100
	const ok1 = await q.enqueue(big);
	assert.equal(ok1, true);
	assert.ok(q.memBytes >= 100);

	const small = '{"x":1}';
	const ok2 = await q.enqueue(small);
	assert.equal(ok2, false);
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'queue-full');
	assert.equal(drops[0].size, Buffer.byteLength(small, 'utf8'));
});

test('admission 边界: queueBytes === memBudget → drop（与原 RpcSendQueue 行为对齐）', async () => {
	const drops = [];
	const { q } = await makeQ({ memBudget: 100, onDrop: (reason, size) => drops.push({ reason, size }) });
	const exact = jsonOfBytes(100);
	const ok1 = await q.enqueue(exact);
	assert.equal(ok1, true);
	assert.equal(q.memBytes, 100);
	const ok2 = await q.enqueue('{"y":2}');
	assert.equal(ok2, false);
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'queue-full');
});

test('admission 边界: queueBytes = memBudget - 1 时新消息仍可入队', async () => {
	const drops = [];
	const { q } = await makeQ({ memBudget: 100, onDrop: (r, s) => drops.push({ r, s }) });
	const almost = jsonOfBytes(99);
	const ok1 = await q.enqueue(almost);
	assert.equal(ok1, true);
	const ok2 = await q.enqueue('{"y":2}');
	assert.equal(ok2, true);
	assert.equal(drops.length, 0);
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

test('admission: 持续期间多次 drop 都触发 onDrop（内部不去重）+ size 准确', async () => {
	const drops = [];
	const { q } = await makeQ({ memBudget: 100, onDrop: (r, s) => drops.push({ r, s }) });
	await q.enqueue(jsonOfBytes(120));
	for (let i = 0; i < 100; i += 1) {
		const msg = `{"i":${i}}`;
		await q.enqueue(msg);
		// onDrop size 必须等于消息字节数
		assert.equal(drops[i].r, 'queue-full');
		assert.equal(drops[i].s, Buffer.byteLength(msg, 'utf8'));
	}
	assert.equal(drops.length, 100);
});

// --- bypassAdmission 白名单 ---

test('bypassAdmission: 命中 → 即使队列满也接受，不调 onDrop', async () => {
	const drops = [];
	const onlyA = (s) => /"bypass":true/.test(s);
	const { q } = await makeQ({
		memBudget: 100,
		bypassAdmission: onlyA,
		onDrop: (r, s) => drops.push({ r, s }),
	});
	await q.enqueue(jsonOfBytes(120));
	const baseBytes = q.memBytes;

	const ok = await q.enqueue('{"bypass":true,"data":"x"}');
	assert.equal(ok, true);
	assert.equal(drops.length, 0);
	assert.ok(q.memBytes > baseBytes);

	// 后续非白名单照常 drop
	const ok2 = await q.enqueue('{"plain":1}');
	assert.equal(ok2, false);
	assert.equal(drops.length, 1);
	assert.equal(drops[0].r, 'queue-full');
});

test('bypassAdmission: 谓词自身抛 → 视为非白名单（drop）', async () => {
	const drops = [];
	const evilBypass = () => { throw new Error('bypass broken'); };
	const { q } = await makeQ({
		memBudget: 100,
		bypassAdmission: evilBypass,
		onDrop: (r, s) => drops.push({ r, s }),
	});
	await q.enqueue(jsonOfBytes(120));
	const ok = await q.enqueue('{"x":1}');
	assert.equal(ok, false);
	assert.equal(drops.length, 1);
	assert.equal(drops[0].r, 'queue-full');
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

test('onDrop: 自身抛异常被 enqueue 内吞掉，不传染（warn 走 __safeWarn）', async () => {
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

test('destroy: 幂等，第二次调用不抛', async () => {
	const { q } = await makeQ();
	await q.destroy();
	await assert.doesNotReject(q.destroy());
	assert.equal(q.destroyed, true);
});

test('Symbol.asyncDispose 委托给 destroy', async () => {
	const { q } = await makeQ();
	await q.enqueue('"a"');
	await q[Symbol.asyncDispose]();
	assert.equal(q.destroyed, true);
});

test('destroy: 无日志输出（诊断职责已外移到 monitor）', async () => {
	const { q, logger } = await makeQ();
	await q.enqueue('"a"');
	await q.destroy();
	assert.equal(logger.warnings.length, 0);
	assert.equal(logger.infos.length, 0);
});

test('destroy(onBeforeClear): mutex 内拿原子残留快照，能看到 in-flight enqueue', async () => {
	// 修复 D-Finding 1：sync 调 q.stats() 看不到 in-flight 入队（mutex 排队），
	// 但 destroy(callback) 在 mutex 内 fire callback，能看到所有已排队的 enqueue
	const { q } = await makeQ();
	// in-flight: enqueue 不 await，立刻同步调 destroy
	const enqueuePromise = q.enqueue('"in-flight"').catch(() => {});
	let snapshot = null;
	const destroyPromise = q.destroy((residual) => { snapshot = residual; });
	await enqueuePromise;
	await destroyPromise;
	assert.ok(snapshot, 'onBeforeClear 必须 fire');
	assert.equal(snapshot.memCount, 1, '应当看到 in-flight 入队的消息');
	assert.equal(snapshot.memBytes, Buffer.byteLength('"in-flight"', 'utf8'));
	// 6 字段形态对齐 FBQ
	assert.equal(snapshot.diskBytes, 0);
	assert.equal(snapshot.writtenBytes, 0);
	assert.equal(snapshot.spilled, false);
	assert.equal(snapshot.fsBroken, false);
});

test('destroy(onBeforeClear): 无 in-flight 时残留为 0', async () => {
	const { q } = await makeQ();
	let snapshot = null;
	await q.destroy((residual) => { snapshot = residual; });
	assert.deepEqual(snapshot, {
		memCount: 0,
		memBytes: 0,
		diskBytes: 0,
		writtenBytes: 0,
		spilled: false,
		fsBroken: false,
	});
});

test('destroy(onBeforeClear): callback 自身抛被吞，destroy 仍完成', async () => {
	const { q } = await makeQ();
	await q.enqueue('"x"');
	await assert.doesNotReject(q.destroy(() => { throw new Error('callback boom'); }));
	assert.equal(q.destroyed, true);
});

test('destroy(onBeforeClear): 同步钩子契约——destroy 不 await 异步 callback（防 try/catch 改成 await catch 破坏 destroy 契约）', async () => {
	// onBeforeClear 是同步钩子；返回 Promise 时 rejection 不被捕获是 silent gotcha（与 FBQ 镜像）。
	// pin 方法：返回 thenable；destroy 不 await 时 then 永不被调；若改成 await，await 会触发 thenable.then()。
	// 无 timing 依赖、无残留 Promise。
	const { q } = await makeQ();
	let cbInvoked = false;
	let awaited = false;
	const cb = () => {
		cbInvoked = true;
		return { then(resolve) { awaited = true; resolve(); } };
	};
	await q.destroy(cb);
	assert.equal(cbInvoked, true, 'callback 应被调用');
	assert.equal(awaited, false, 'destroy 必须同步调用 onBeforeClear，不能 await thenable');
	assert.equal(q.destroyed, true);
});

test('destroy 先排队、enqueue 后排队：mutex FIFO + destroyed 短路 → enqueue 拿到锁返 false', async () => {
	// 关键 race 不变量：destroy 与 enqueue 同 tick 并发，destroy 先入 mutex 队列时——
	// destroy 的 mutex callback 先 fire（设 destroyed=true），enqueue 的 mutex callback
	// 后跑（看到 destroyed=true 直接返 false）。验证 mutex FIFO + destroyed short-circuit
	// 联合保护。这条窗口在 webrtc-peer 同 connId 重建路径上是 A1 引入的真实并发场景。
	const droppedReasons = [];
	const q = new MemoryQueue({
		id: 'race',
		onDrop: (reason) => { droppedReasons.push(reason); },
	});
	await q.init();

	// 同 tick 并发：destroy 先调用，先进 mutex 队列；enqueue 后调用，排第二
	const destroyP = q.destroy();
	const enqueueP = q.enqueue('"after-destroy-pending"');

	const [, ok] = await Promise.all([destroyP, enqueueP]);
	assert.equal(ok, false, 'enqueue must return false (destroyed short-circuit)');
	assert.equal(q.destroyed, true);
	// destroyed 短路是 silent drop——队列已死，不需要 noisy onDrop（连接清理的正常副作用）
	assert.deepEqual(droppedReasons, [], 'destroyed-short-circuit must not fire onDrop');
});

test('destroy(onBeforeClear): 第二次 destroy 是 no-op，不 fire callback', async () => {
	// destroy 自身幂等保证 onBeforeClear 仅 fire 一次（与 monitor 内部 summarized flag 互为兜底）
	const { q } = await makeQ();
	let calls = 0;
	await q.destroy(() => { calls += 1; });
	await q.destroy(() => { calls += 1; });
	assert.equal(calls, 1);
});

test('clear: 重置 mem，保留实例可用', async () => {
	const { q } = await makeQ({ memBudget: 100 });
	await q.enqueue(jsonOfBytes(120));
	await q.enqueue('{"x":1}'); // drop
	assert.ok(q.memBytes > 0);

	await q.clear();
	const s = q.stats();
	assert.equal(s.memCount, 0);
	assert.equal(s.memBytes, 0);
	// 清空后还能继续用
	const ok = await q.enqueue('"after-clear"');
	assert.equal(ok, true);
});

test('clear: destroyed 后 clear no-op', async () => {
	const { q } = await makeQ();
	await q.enqueue('"a"');
	await q.destroy();
	await q.clear();
	assert.equal(q.destroyed, true);
});

// --- stats ---

test('stats: 形态对齐 FBQ 的 6 字段（无诊断字段）', async () => {
	const { q } = await makeQ();
	await q.enqueue('"a"');
	const s = q.stats();
	assert.deepEqual(Object.keys(s).sort(), [
		'diskBytes', 'fsBroken', 'memBytes', 'memCount', 'spilled', 'writtenBytes',
	]);
	assert.equal(s.memCount, 1);
	assert.equal(s.memBytes, Buffer.byteLength('"a"', 'utf8'));
	assert.equal(s.diskBytes, 0);
	assert.equal(s.writtenBytes, 0);
	assert.equal(s.spilled, false);
	assert.equal(s.fsBroken, false);
});

// --- safe wrapper / tag（仅 __dispatchDrop catch 路径触发） ---

test('safe wrapper: logger 缺 warn 方法时 onDrop catch 路径不抛', async () => {
	const evilOnDrop = () => { throw new Error('onDrop broken'); };
	const { q } = await makeQ({ memBudget: 100, onDrop: evilOnDrop, logger: {} });
	await q.enqueue(jsonOfBytes(120));
	await assert.doesNotReject(q.enqueue('{"x":1}'));
});

test('safe wrapper: logger.warn 自身抛 → enqueue 不传染', async () => {
	const evilOnDrop = () => { throw new Error('onDrop broken'); };
	const evilLogger = {
		warn: () => { throw new Error('logger broken'); },
		info: () => {},
	};
	const { q } = await makeQ({ memBudget: 100, onDrop: evilOnDrop, logger: evilLogger });
	await q.enqueue(jsonOfBytes(120));
	let ok;
	await assert.doesNotReject(async () => { ok = await q.enqueue('{"x":1}'); });
	assert.equal(ok, false);
});

test('tag: 缺省时 onDrop catch 的 warn 不带 tag 后缀', async () => {
	const evilOnDrop = () => { throw new Error('onDrop broken'); };
	const { q, logger } = await makeQ({ memBudget: 100, onDrop: evilOnDrop });
	await q.enqueue(jsonOfBytes(120));
	await q.enqueue('{"x":1}');
	const threwWarns = logger.warnings.filter(w => w.includes('onDrop threw'));
	assert.equal(threwWarns.length, 1);
	assert.match(threwWarns[0], /^\[rpc-queue\] /);
});

test('tag: 设置时 onDrop catch 的 warn 含 tag 后缀', async () => {
	const evilOnDrop = () => { throw new Error('onDrop broken'); };
	const { q, logger } = await makeQ({ memBudget: 100, onDrop: evilOnDrop, tag: 'conn=T' });
	await q.enqueue(jsonOfBytes(120));
	await q.enqueue('{"x":1}');
	const threwWarns = logger.warnings.filter(w => w.includes('onDrop threw'));
	assert.equal(threwWarns.length, 1);
	assert.ok(threwWarns[0].includes('[rpc-queue conn=T]'));
});

// --- per-message hard cap：bypass 也不豁免 ---

test('maxMessageBytes: 超 cap 的帧直接 drop，不入队', async () => {
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
	assert.equal(onDrops.length, 1);
	assert.equal(onDrops[0].reason, 'oversize');
	assert.equal(onDrops[0].size, 120);
});

test('maxMessageBytes: bypass 命中也无法豁免（与 sender 端 50MB 硬上限对齐）', async () => {
	const onDrops = [];
	const { q } = await makeQ({
		memBudget: 10000,
		maxMessageBytes: 100,
		bypassAdmission: () => true,
		onDrop: (reason, size) => onDrops.push({ reason, size }),
	});
	const ok = await q.enqueue(jsonOfBytes(120));
	assert.equal(ok, false);
	assert.equal(q.memBytes, 0);
	assert.equal(onDrops[0].reason, 'oversize');
});

test('maxMessageBytes: 默认 Infinity → 任意大小都接受（兼容老调用方）', async () => {
	const { q } = await makeQ({ memBudget: 10000 });
	const ok = await q.enqueue(jsonOfBytes(5000));
	assert.equal(ok, true);
	assert.equal(q.memBytes, 5000);
});

test('maxMessageBytes: 边界值（=cap 入队，>cap drop）', async () => {
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
