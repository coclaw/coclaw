import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { FileBackedQueue } from './file-backed-queue.js';

async function makeTmpDir(prefix = 'fbq-') {
	return await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
}

function silentLogger() {
	return { warn: () => {}, info: () => {}, error: () => {} };
}

// 统一构造 + init 的简单工厂，避免每个用例都写两行
async function makeQ(opts) {
	const q = new FileBackedQueue({ logger: silentLogger(), ...opts });
	await q.init();
	return q;
}

// 等待 iter.next() 进入 waiter 等待态，替代基于 setTimeout 的时序臆测。
async function waitForWaiter(q, n = 1, maxMs = 500) {
	const start = Date.now();
	while (q.waiters.length < n) {
		/* c8 ignore next 3 -- 超时分支仅在环境严重异常时触发 */
		if (Date.now() - start > maxMs) {
			throw new Error(`timeout waiting for waiter (have ${q.waiters.length}, want ${n})`);
		}
		await new Promise((resolve) => setImmediate(resolve));
	}
}

// --- constructor ---

test('constructor throws when dir missing', () => {
	assert.throws(
		() => new FileBackedQueue({ id: 'x' }),
		/dir is required/,
	);
});

test('constructor throws when called with no opts', () => {
	assert.throws(() => new FileBackedQueue(), /dir is required/);
});

test('constructor throws when id missing', () => {
	assert.throws(
		() => new FileBackedQueue({ dir: '/tmp/whatever' }),
		/id is required/,
	);
});

test('constructor throws on non-string dir', () => {
	assert.throws(() => new FileBackedQueue({ dir: 123, id: 'x' }), /dir is required/);
});

test('constructor throws on non-string id', () => {
	assert.throws(() => new FileBackedQueue({ dir: '/tmp', id: 123 }), /id is required/);
});

test('constructor rejects id with path-traversal sequences', () => {
	for (const badId of ['../escape', 'a/b', 'a\\b', '..', '.', 'a\0b', 'a b']) {
		assert.throws(
			() => new FileBackedQueue({ dir: '/tmp/whatever', id: badId }),
			/invalid/,
			`expected rejection for id=${JSON.stringify(badId)}`,
		);
	}
});

test('constructor accepts UUID-shaped id', () => {
	const q = new FileBackedQueue({
		dir: '/tmp/whatever', id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
		logger: silentLogger(),
	});
	assert.equal(q.id, '6ba7b810-9dad-11d1-80b4-00c04fd430c8');
});

test('constructor does not touch filesystem', async () => {
	const dir = await makeTmpDir();
	const before = await fs.readdir(dir);
	// 提前放置残留，确保构造不误删
	const residual = nodePath.join(dir, 'res.jsonl');
	await fs.writeFile(residual, 'old\n');
	const q = new FileBackedQueue({ dir, id: 'res', logger: silentLogger() });
	// 残留仍然在，构造没做任何 IO
	await fs.access(residual);
	const after = await fs.readdir(dir);
	assert.equal(after.length, before.length + 1);
	await q.init();
	// init 后残留被清理
	await assert.rejects(() => fs.access(residual));
	await q.destroy();
});

test('constructor rejects non-finite or non-positive memBudget / diskCap', () => {
	const base = { dir: '/tmp/whatever', id: 'cap', logger: silentLogger() };
	// 注意：undefined 会被解构默认值覆盖为默认值，不进入校验分支；故不列入
	for (const bad of [NaN, Infinity, -Infinity, 0, -1, '1', null]) {
		assert.throws(
			() => new FileBackedQueue({ ...base, memBudget: bad }),
			/memBudget must be a finite positive number/,
			`expected rejection for memBudget=${String(bad)}`,
		);
		assert.throws(
			() => new FileBackedQueue({ ...base, diskCap: bad }),
			/diskCap must be a finite positive number/,
			`expected rejection for diskCap=${String(bad)}`,
		);
	}
});

test('constructor accepts default memBudget and diskCap', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'def' });
	assert.equal(q.memBudget, 8 * 1024 * 1024);
	assert.equal(q.diskCap, 1024 * 1024 * 1024);
	await q.destroy();
});

// --- init ---

test('init is idempotent', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'idem', logger: silentLogger() });
	await q.init();
	await q.init(); // should not throw
	await q.enqueue('x');
	await q.destroy();
});

test('enqueue before init throws', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'noinit', logger: silentLogger() });
	await assert.rejects(() => q.enqueue('x'), /not initialized/);
});

test('init after destroy is a no-op', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'initafterdst', logger: silentLogger() });
	await q.destroy();
	await q.init(); // must not throw
	assert.equal(q.initialized, false);
});

test('init is best-effort on rm errors; authoritative cleanup happens at spill', async () => {
	// 残留文件位置被一个目录占住，rm(file) 会抛 EISDIR；init 吞下继续
	const dir = await makeTmpDir();
	const residualAsDir = nodePath.join(dir, 'initbest.jsonl');
	await fs.mkdir(residualAsDir, { recursive: true });
	await fs.writeFile(nodePath.join(residualAsDir, 'child'), 'keeps dir non-empty');

	const q = new FileBackedQueue({ dir, id: 'initbest', logger: silentLogger() });
	await q.init(); // must not throw despite rm failure
	assert.equal(q.initialized, true);

	// 清理
	await fs.rm(residualAsDir, { recursive: true, force: true });
	await q.destroy();
});

test('spill-time rm authoritatively cleans up cross-lifecycle residual', async () => {
	// 模拟上次运行留下的残留 jsonl
	const dir = await makeTmpDir();
	const stale = nodePath.join(dir, 'lifec.jsonl');
	await fs.writeFile(stale, 'STALE-DATA-SHOULD-BE-WIPED\n');

	const q = new FileBackedQueue({ dir, id: 'lifec', memBudget: 1, logger: silentLogger() });
	await q.init(); // init rm 成功清除 stale
	// 这里即使 init 的 rm 失败，__openWriteStream 的 rm 也会再清一次；此处只验证 spill 后文件内容不含 STALE
	await q.enqueue('aa'); // mem
	await q.enqueue('bb'); // spill → __openWriteStream rm + createWriteStream
	const content = await fs.readFile(stale, 'utf8');
	assert.equal(content, 'bb\n'); // 只有新数据，旧残留消失
	await q.destroy();
});

test('Symbol.asyncDispose delegates to destroy', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'disp' });
	await q.enqueue('x');
	await q[Symbol.asyncDispose]();
	assert.equal(q.destroyed, true);
});

// --- stats initial ---

test('stats returns initial zeros', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'stats' });
	assert.deepEqual(q.stats(), { memCount: 0, memBytes: 0, diskBytes: 0, writtenBytes: 0, spilled: false, fsBroken: false });
	await q.destroy();
});

// --- enqueue memory path ---

test('enqueue throws on non-string input', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'nstr' });
	await assert.rejects(() => q.enqueue(123), /jsonStr must be a string/);
	await assert.rejects(() => q.enqueue(null), /jsonStr must be a string/);
	await q.destroy();
});

test('enqueue in memory; stats reflect mem state', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'mem' });
	assert.equal(await q.enqueue('hello'), true);
	assert.equal(await q.enqueue('world!'), true);
	const s = q.stats();
	assert.equal(s.memCount, 2);
	assert.equal(s.memBytes, 5 + 6);
	assert.equal(s.diskBytes, 0);
	assert.equal(s.spilled, false);
	await q.destroy();
});

test('enqueue empty string works', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'empty' });
	assert.equal(await q.enqueue(''), true);
	assert.equal(q.stats().memCount, 1);
	const iter = q[Symbol.asyncIterator]();
	const r = await iter.next();
	assert.equal(r.value, '');
	await q.destroy();
});

// --- spill + refill ---

test('first message can overshoot memBudget (single overshoot semantics)', async () => {
	// 红线：admission 按 current ≥ threshold + single overshoot——首条入队前 memBytes=0 < memBudget，
	// size>memBudget 的首条也必须接受；下一条才看阈值。回归到 size>memBudget 拒接的实现会被这条抓住。
	const dir = await makeTmpDir();
	const q = await makeQ({ dir, id: 'overshoot-mem', memBudget: 2 });
	assert.equal(await q.enqueue('xxx'), true, 'first message size>memBudget must be accepted');
	assert.equal(q.stats().memBytes, 3);
	assert.equal(q.stats().spilled, false);
	// 下一条: mb=3≥2 → 必须走 spill, 不再进 mem
	assert.equal(await q.enqueue('y'), true);
	assert.equal(q.stats().spilled, true);
	await q.destroy();
});

test('first message can overshoot diskCap (single overshoot semantics)', async () => {
	// diskCap 同款 single overshoot：首条 size 即使大于 diskCap 也接受（mb+wb=0<阈值）。
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'overshoot-disk',
		memBudget: 100, diskCap: 2,
		onDrop: (reason, size) => drops.push({ reason, size }),
	});
	assert.equal(await q.enqueue('xxx'), true, 'first message size>diskCap must be accepted (mb=0<2)');
	// 下一条: mb(3)+wb(0)=3≥2 → drop disk-cap
	assert.equal(await q.enqueue('y'), false);
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'disk-cap');
	await q.destroy();
});

test('enqueue spills to disk when memBudget exceeded', async () => {
	const dir = await makeTmpDir();
	const q = await makeQ({ dir, id: 'spill', memBudget: 2 });
	assert.equal(await q.enqueue('aa'), true); // mb=0<2 → mem (single overshoot)，mb=2
	assert.equal(await q.enqueue('bb'), true); // mb=2≥2 → memFits=false → spill
	const s = q.stats();
	assert.equal(s.spilled, true);
	assert.equal(s.memCount, 1);
	assert.equal(s.memBytes, 2);
	assert.equal(s.diskBytes, 3); // 'bb\n' = 3 bytes
	// 文件存在
	await assert.doesNotReject(() => fs.stat(nodePath.join(dir, 'spill.jsonl')));
	await q.destroy();
});

test('FIFO preserved across spill and refill, file removed on drain', async () => {
	const dir = await makeTmpDir();
	const q = await makeQ({ dir, id: 'fifo', memBudget: 4 });
	const inputs = ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff'];
	for (const s of inputs) assert.equal(await q.enqueue(s), true);
	assert.equal(q.stats().spilled, true);

	const out = [];
	for await (const item of q) {
		out.push(item);
		if (out.length === inputs.length) break;
	}
	assert.deepEqual(out, inputs);
	assert.equal(q.stats().spilled, false);
	assert.equal(q.stats().diskBytes, 0);
	// 文件应已消失
	await assert.rejects(() => fs.stat(nodePath.join(dir, 'fifo.jsonl')));
	await q.destroy();
});

test('refill respects memBudget (partial fill, stays spilled, per-step stop)', async () => {
	// 每条 33 字节 payload；memBudget=33 让首条 single overshoot 进 mem，其余 spill。
	// refill 反向量控（current ≥ memBudget 停）使每次 refill 仅取 1 条到 mem，分批回填。
	// per-step 断言（readOffset 单调推进 34→68→102）pin 住"每次仅取 1 条"——
	// 一个 eager-fill 的实现（refill 一次性灌全部 3 条）会保持 FIFO 但破坏内存控制，
	// 仅断言最终 FIFO 抓不到该回归。
	const dir = await makeTmpDir();
	const payload = 'x'.repeat(32);
	const q = await makeQ({ dir, id: 'partial', memBudget: 33 });
	for (let i = 0; i < 4; i++) assert.equal(await q.enqueue(payload + i), true);
	assert.equal(q.stats().spilled, true);
	assert.equal(q.writtenBytes, 102, 'wb = 3 × (32 + 1)');
	assert.equal(q.readOffset, 0);

	const iter = q[Symbol.asyncIterator]();
	// next #1：从 mem 取首条；尚未触发 refill
	assert.equal((await iter.next()).value, payload + '0');
	assert.equal(q.readOffset, 0, 'no refill yet (mem 还有过去的内容)');
	// next #2：mem 空 → refill 取 1 条（current ≥ 33 即停）→ shift
	assert.equal((await iter.next()).value, payload + '1');
	assert.equal(q.readOffset, 34, 'refill 单次仅取 1 条 (single overshoot stop)');
	// next #3：再 refill 1 条
	assert.equal((await iter.next()).value, payload + '2');
	assert.equal(q.readOffset, 68);
	// next #4：refill 取最后 1 条 + 触发 __dropFile 重置
	assert.equal((await iter.next()).value, payload + '3');
	assert.equal(q.stats().spilled, false);
	assert.equal(q.writtenBytes, 0, '__dropFile 重置 writtenBytes');
	await q.destroy();
});

// --- spill 边沿钩子（FBQ→monitor 联通）---

test('spill hooks: onSpillStart fires once at false→true; onSpillEnd at drain with drainedBytes', async () => {
	// 边沿契约：FBQ 内部翻转 spilled false→true 时调一次 onSpillStart；
	// drain 完成（__dropFile 真删文件）时调一次 onSpillEnd 带 drainedBytes（重置前快照）。
	// 多个 spill 周期（drain 后再 spill）应再次触发 start/end，幂等只在监视器内部去重。
	const dir = await makeTmpDir();
	const calls = [];
	const q = await makeQ({
		dir, id: 'spill-hook-edge',
		memBudget: 1, diskCap: 1024,
		onSpillStart: () => calls.push('start'),
		onSpillEnd: (n) => calls.push(`end:${n}`),
	});
	// 第一个 spill 周期
	assert.equal(await q.enqueue('a'), true);  // mem (single overshoot, mb=1)
	assert.equal(await q.enqueue('b'), true);  // spill 触发 start
	assert.equal(await q.enqueue('c'), true);  // 仍 spilled，append 不再触发 start
	assert.deepEqual(calls, ['start']);
	// drain 全部 → 触发 end with drainedBytes='b\n'+'c\n'=4
	const iter = q[Symbol.asyncIterator]();
	const out = [];
	for (let i = 0; i < 3; i++) out.push((await iter.next()).value);
	assert.deepEqual(out, ['a', 'b', 'c']);
	assert.equal(q.stats().spilled, false);
	assert.deepEqual(calls, ['start', 'end:4']);
	// 第二个 spill 周期：再次触发 start
	assert.equal(await q.enqueue('d'), true);  // mem
	assert.equal(await q.enqueue('e'), true);  // spill 第二次 start
	assert.deepEqual(calls, ['start', 'end:4', 'start']);
	await q.destroy();
});

test('spill hooks: destroy does NOT dispatch onSpillEnd', async () => {
	// destroy 是清理离场路径，由 close 汇总信号承载，不应再调 onSpillEnd 让监视器误以为 drain 完成。
	const dir = await makeTmpDir();
	const calls = [];
	const q = await makeQ({
		dir, id: 'spill-destroy-no-end',
		memBudget: 1, diskCap: 1024,
		onSpillEnd: (n) => calls.push(n),
	});
	assert.equal(await q.enqueue('a'), true);
	assert.equal(await q.enqueue('b'), true);  // spill
	assert.equal(q.stats().spilled, true);
	await q.destroy();
	assert.deepEqual(calls, [], 'destroy must not invoke onSpillEnd (close summary covers it)');
});

test('spill hooks: __handleFsError does NOT dispatch onSpillEnd', async () => {
	// 故障删档（write callback err 触发 __handleFsError）由 fs-broken 信号承载，不应混入 spill-end。
	const dir = await makeTmpDir();
	const calls = [];
	const q = await makeQ({
		dir, id: 'spill-fsbroken-no-end',
		memBudget: 1, diskCap: 1024,
		onSpillEnd: (n) => calls.push(n),
	});
	assert.equal(await q.enqueue('a'), true); // mem
	assert.equal(await q.enqueue('b'), true); // spill
	// monkey-patch write 让 callback err，复制 __handleFsError 触发路径
	q.writeStream.write = (chunk, cb) => cb(new Error('synthetic write fail'));
	assert.equal(await q.enqueue('c'), false);
	assert.equal(q.stats().fsBroken, true);
	assert.deepEqual(calls, [], '__handleFsError must not invoke onSpillEnd');
	await q.destroy();
});

// --- diskCap ---

test('enqueue rejected when exceeding diskCap; onDrop receives disk-cap', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	// admission 风格：current ≥ threshold（与 MemoryQueue 一致），允许 single overshoot。
	// memBudget=2: 'aa' 进 mem (mb=0<2 OK 落地为 overshoot)，'bb' mem 满走 spill (wb=3)；
	// diskCap=5: 'c' admission mb(2)+wb(3) = 5 ≥ 5 → drop
	const q = await makeQ({
		dir, id: 'cap',
		memBudget: 2, diskCap: 5,
		onDrop: (reason, size) => drops.push({ reason, size }),
	});
	assert.equal(await q.enqueue('aa'), true); // mem (single overshoot)
	assert.equal(await q.enqueue('bb'), true); // spill, disk 3 bytes (含 \n)
	assert.equal(await q.enqueue('c'), false); // mb(2)+wb(3)=5 ≥ 5 → drop
	assert.deepEqual(drops, [{ reason: 'disk-cap', size: 1 }]);
	await q.destroy();
});

test('diskCap caps total occupancy (mem+writtenBytes), not just backlog; recovers after full drain', async () => {
	// 关键回归：producer/consumer 持续交错、readOffset 追不上 writtenBytes 时，
	// 物理文件仍然不会无界增长；admission 基于 mem+writtenBytes 总占用保证 diskCap 是阈值（允许 single overshoot）。
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'phys',
		memBudget: 1, diskCap: 10,
		onDrop: (reason, size) => drops.push({ reason, size }),
	});

	// enqueue 6 条 'a'：第 1 条进 mem（mb=0<1 → overshoot, mb=1），后 5 条 spill（每条含 \n=2 字节）
	// 入队后 memBytes=1, writtenBytes=10
	for (let i = 0; i < 6; i++) assert.equal(await q.enqueue('a'), true);
	// 第 7 条 admission：mb(1)+wb(10) = 11 ≥ 10 → drop
	assert.equal(await q.enqueue('a'), false);
	assert.equal(drops.length, 1);

	// 消费者读一条（mem 中的 'a'）→ memBytes=0, writtenBytes 不变
	const iter = q[Symbol.asyncIterator]();
	assert.equal((await iter.next()).value, 'a');

	// 消费者继续读：refill 把 1 条从 disk 取到 mem (single overshoot)，然后 shift。writtenBytes 仍不变（未触发 __dropFile）
	assert.equal((await iter.next()).value, 'a');

	// 此刻 memBytes 接近 0、writtenBytes 仍 10；admission：0+10 ≥ 10 → drop
	assert.equal(await q.enqueue('a'), false);
	assert.equal(drops.length, 2);

	// 持续消费直到完全 drain → __dropFile 重置 writtenBytes=0
	while (q.writtenBytes > 0) {
		const r = await Promise.race([
			iter.next(),
			new Promise((_, rej) => setTimeout(() => rej(new Error('drain stalled')), 500)),
		]);
		if (r.done) break;
	}
	assert.equal(q.stats().spilled, false);
	assert.equal(q.writtenBytes, 0);

	// drain 完后 admission 重置，新 enqueue 可以重新被接受
	assert.equal(await q.enqueue('x'), true);
	await q.destroy();
});

test('file and directory are created with restrictive mode (0o600 / 0o700)', async () => {
	const dir = await makeTmpDir();
	// 嵌入 nested 目录，确保 mkdir 真的创建目录而不是复用已存在的 base
	const nested = nodePath.join(dir, 'nested');
	const q = await makeQ({ dir: nested, id: 'perm', memBudget: 1 });
	await q.enqueue('aa'); // mem
	await q.enqueue('bb'); // spill → opens stream，创建文件与父目录

	// 非 linux 平台权限语义不同；这里只在 posix 下断言
	if (process.platform !== 'win32') {
		const fileStat = await fs.stat(nodePath.join(nested, 'perm.jsonl'));
		assert.equal(fileStat.mode & 0o777, 0o600, `file mode should be 0o600, got ${(fileStat.mode & 0o777).toString(8)}`);
		const dirStat = await fs.stat(nested);
		assert.equal(dirStat.mode & 0o777, 0o700, `dir mode should be 0o700, got ${(dirStat.mode & 0o777).toString(8)}`);
	}
	await q.destroy();
});

test('onDrop that throws does not break enqueue', async () => {
	const dir = await makeTmpDir();
	const q = await makeQ({
		dir, id: 'cap2',
		memBudget: 2, diskCap: 1,
		onDrop: () => { throw new Error('onDrop bug'); },
	});
	// 'a' admission: 0+0=0<1 → 进 mem (single overshoot)，mb=1
	assert.equal(await q.enqueue('a'), true);
	// 'b' admission: mb(1)+wb(0)=1 ≥ 1 → drop disk-cap；onDrop 抛错被 catch 不传染 enqueue 契约
	assert.equal(await q.enqueue('b'), false);
	assert.equal(await q.enqueue('c'), false);
	await q.destroy();
});

// --- bypass admission ---

test('bypass admission: predicate hits, enqueue accepted past diskCap; onDrop not invoked', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	// 与 line 282 同基线（memBudget=2 / diskCap=5）：'aa' mem + 'bb' spill 后 'c' 触顶
	// 现加 bypassAdmission 永真 → 'c' 应被接受、不触发 onDrop
	const q = await makeQ({
		dir, id: 'bypass-hit',
		memBudget: 2, diskCap: 5,
		bypassAdmission: () => true,
		onDrop: (reason, size) => drops.push({ reason, size }),
	});
	assert.equal(await q.enqueue('aa'), true);
	assert.equal(await q.enqueue('bb'), true);
	assert.equal(await q.enqueue('c'), true);
	assert.deepEqual(drops, []);
	await q.destroy();
});

test('bypass admission: non-bypass traffic still drops, bypass traffic accepted on same instance', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	// 谓词按内容选择性放行：包含 'pass' 的视为白名单
	const q = await makeQ({
		dir, id: 'bypass-mixed',
		memBudget: 2, diskCap: 5,
		bypassAdmission: (s) => s.includes('pass'),
		onDrop: (reason, size) => drops.push({ reason, size }),
	});
	assert.equal(await q.enqueue('aa'), true);
	assert.equal(await q.enqueue('bb'), true);
	// 非白名单触顶 → drop
	assert.equal(await q.enqueue('c'), false);
	assert.deepEqual(drops, [{ reason: 'disk-cap', size: 1 }]);
	// 同实例上的白名单仍可越过 diskCap 入队
	assert.equal(await q.enqueue('pass'), true);
	assert.deepEqual(drops, [{ reason: 'disk-cap', size: 1 }]);
	await q.destroy();
});

test('bypass admission: predicate throws → conservative drop (treated as non-bypass)', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'bypass-throw',
		memBudget: 2, diskCap: 5,
		bypassAdmission: () => { throw new Error('predicate bug'); },
		onDrop: (reason, size) => drops.push({ reason, size }),
	});
	assert.equal(await q.enqueue('aa'), true);
	assert.equal(await q.enqueue('bb'), true);
	// 谓词抛错 → 视为非白名单 → 仍走 disk-cap drop（不入队、不污染 enqueue 契约）
	assert.equal(await q.enqueue('c'), false);
	assert.deepEqual(drops, [{ reason: 'disk-cap', size: 1 }]);
	await q.destroy();
});

test('bypass admission: non-function values treated as absent (backward compatible)', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	// 传字符串/null/undefined 都等同于不传：行为退化到默认 admission
	const q = await makeQ({
		dir, id: 'bypass-nonfn',
		memBudget: 2, diskCap: 5,
		bypassAdmission: 'not-a-function',
		onDrop: (reason, size) => drops.push({ reason, size }),
	});
	assert.equal(await q.enqueue('aa'), true);
	assert.equal(await q.enqueue('bb'), true);
	assert.equal(await q.enqueue('c'), false);
	assert.deepEqual(drops, [{ reason: 'disk-cap', size: 1 }]);
	await q.destroy();
});

test('bypass admission: over-cap message is consumable end-to-end (no buried-in-queue)', async () => {
	const dir = await makeTmpDir();
	const q = await makeQ({
		dir, id: 'bypass-deliver',
		memBudget: 2, diskCap: 5,
		bypassAdmission: () => true,
	});
	assert.equal(await q.enqueue('aa'), true); // mem
	assert.equal(await q.enqueue('bb'), true); // spill
	// bypass 命中越过 diskCap：不仅 enqueue 返 true，后续也必须能被消费出来
	assert.equal(await q.enqueue('cc'), true);
	const seen = [];
	const iter = q[Symbol.asyncIterator]();
	for (let i = 0; i < 3; i++) seen.push((await iter.next()).value);
	assert.deepEqual(seen, ['aa', 'bb', 'cc']);
	await q.destroy();
});

test('bypass admission: predicate is lazy — uncongested mem path does not invoke the predicate', async () => {
	const dir = await makeTmpDir();
	let calls = 0;
	const q = await makeQ({
		dir, id: 'bypass-lazy-uncongested',
		memBudget: 100, diskCap: 1000, // 容量充裕：admission 不超 + fsBroken=false → 两条求值路径都被左短路
		bypassAdmission: () => { calls += 1; return true; },
	});
	// 全在 mem 路径（5×2B=10B 远不触发 spill），admission 与 fsBroken-overshoot 谓词位置都被左短路
	for (let i = 0; i < 5; i++) {
		assert.equal(await q.enqueue(`m${i}`), true);
	}
	assert.equal(q.stats().spilled, false, 'this case stays in mem');
	assert.equal(calls, 0, '容量充裕路径下谓词不应被求值');
	await q.destroy();
});

test('bypass admission: predicate is lazy — healthy spill path does not invoke the predicate', async () => {
	// 健康路径下 mem 满转 spill 不需要查 bypass 谓词（写盘 OK 即接受）；
	// 谓词仅在 admission 命中（disk-cap 拒收）或 fsBroken-overshoot（mem 桶接管容量层）才被求值。
	const dir = await makeTmpDir();
	let calls = 0;
	const q = await makeQ({
		dir, id: 'bypass-lazy-spill',
		memBudget: 1, diskCap: 1000, // mem 极小但 disk 充裕：每条都触发 spill 但 admission 不顶
		bypassAdmission: () => { calls += 1; return true; },
	});
	for (let i = 0; i < 4; i++) {
		assert.equal(await q.enqueue(`x${i}`), true);
	}
	assert.equal(q.stats().spilled, true, 'this case truly exercises the spill path');
	assert.equal(calls, 0, 'spill 路径下谓词不应被求值');
	await q.destroy();
});

test('bypass admission: predicate cached per enqueue — admission hit invokes once', async () => {
	const dir = await makeTmpDir();
	let calls = 0;
	// 复用 diskCap 触顶基线（memBudget=2 / diskCap=5）：'aa' mem + 'bb' spill 后第三条触顶
	const q = await makeQ({
		dir, id: 'bypass-lazy-admission',
		memBudget: 2, diskCap: 5,
		bypassAdmission: () => { calls += 1; return true; },
	});
	assert.equal(await q.enqueue('aa'), true);
	assert.equal(await q.enqueue('bb'), true);
	assert.equal(calls, 0, '前两条容量充裕，谓词不应被调');
	// 第三条：admission 命中（diskCap 超）+ bypass → 谓词调一次
	assert.equal(await q.enqueue('c'), true);
	assert.equal(calls, 1, 'admission 命中路径下谓词应仅调用一次');
	await q.destroy();
});

test('bypass admission: fsBroken short-circuits disk-cap admission without invoking the predicate', async () => {
	// A1 修复后的 lazy 契约：fsBroken=true 时 disk-cap admission 守卫让 :172 整体短路，
	// bypass 谓词在该位置不被调用（仅 :194 mem-overshoot 路径会调）。
	// 这条 pin 当前行为；日后若改回"让 bypass 在 fsBroken 模式下也参与 disk-cap 决策"会触红。
	const dir = await makeTmpDir();
	let calls = 0;
	const q = await makeQ({
		dir, id: 'bypass-fsbroken-no-eval',
		memBudget: 2, diskCap: 5,
		bypassAdmission: () => { calls += 1; return true; },
	});
	q.fsBroken = true;
	// 'aa' size=2 首条 single overshoot 进 mem (memFits=true，不调谓词)，calls=0
	// 'bb' size=2 mem 满 + fsBroken + bypass → bypassOvershoot，调谓词 1 次，calls=1
	// 'cc' size=2 同上，calls=2；此后 mb(6) >= diskCap(5)
	assert.equal(await q.enqueue('aa'), true);
	assert.equal(await q.enqueue('bb'), true);
	assert.equal(await q.enqueue('cc'), true);
	assert.equal(calls, 2);
	// 'dd' admission 命中（mb+wb=6 >= 5）但 fsBroken=true → :172 短路不调谓词；
	// 仅 :194 overshoot 路径调谓词一次（不再像 fsBroken=false 时被 admission 多调一次）
	assert.equal(await q.enqueue('dd'), true);
	assert.equal(calls, 3, 'admission 命中但 fsBroken 守卫赢 → 谓词仅在 overshoot 路径调用一次');
	await q.destroy();
});

test('bypass admission: predicate cached per enqueue — overshoot hit invokes once', async () => {
	const dir = await makeTmpDir();
	let calls = 0;
	// diskCap 充裕（admission 不会触顶）+ 人工 fsBroken + 小 memBudget → 第二条进 overshoot 路径
	const q = await makeQ({
		dir, id: 'bypass-lazy-overshoot',
		memBudget: 1, diskCap: 1000,
		bypassAdmission: () => { calls += 1; return true; },
	});
	q.fsBroken = true;
	assert.equal(await q.enqueue('a'), true); // 首条 pendingCount=0 → memFits 短路
	assert.equal(calls, 0);
	// 第二条：mem 满（memBudget=1）+ fsBroken 粘性 → bypassOvershoot 命中 → 谓词调一次
	assert.equal(await q.enqueue('b'), true);
	assert.equal(calls, 1, 'overshoot 命中路径下谓词应仅调用一次');
	await q.destroy();
});

test('bypass admission does NOT exempt physical IO failure (mkdir path); subsequent bypass overshoots mem (real-fsBroken end-to-end)', async () => {
	// 双重 invariant 端到端测试：
	//  1) 实际 IO 写入失败那一刻 bypass 不豁免（红线 3 真实意图）
	//  2) 写入失败让 __handleFsError 真粘性置 fsBroken 后，再来的 bypass 命中消息走 mem-overshoot 入队
	//     → 覆盖"真实 IO 失败 → 真 fsBroken → bypass overshoot"端到端，避免人工注入 fsBroken=true 的差异
	const base = await makeTmpDir();
	const blocker = nodePath.join(base, 'blocker');
	await fs.writeFile(blocker, 'not-a-dir');
	const dir = nodePath.join(blocker, 'sub'); // mkdir(sub) on file 'blocker' 会 ENOTDIR
	const drops = [];
	const q = new FileBackedQueue({
		dir, id: 'bypass-mkfail',
		memBudget: 1, // 小到一条就满，强迫第二条走 spill
		bypassAdmission: () => true,
		onDrop: (reason, size, err) => drops.push({ reason, size, err }),
		logger: silentLogger(),
	});
	await q.init();
	assert.equal(await q.enqueue('aa'), true); // mem 首条
	// 第二条让 cost 超 memBudget → 走 spill → mkdir 失败 → drop fs-error；bypass 不救
	assert.equal(await q.enqueue('bb'), false);
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'fs-error');
	assert.ok(drops[0].err instanceof Error);
	assert.equal(q.stats().fsBroken, true);
	// fsBroken 真粘性后（__handleFsError 走完，spilled=false / writtenBytes=0 / lastFsErr 已粘）：
	// 再来一条 bypass 命中消息——mem 仍满（pendingCount=1）→ memFits=false → bypassOvershoot=true → 入队
	assert.equal(await q.enqueue('cc'), true, 'real-fsBroken 后 bypass 应 overshoot mem');
	assert.equal(drops.length, 1, 'overshoot 不应调 onDrop');
	// 端到端：两条 mem 内消息都能被消费出来
	const iter = q[Symbol.asyncIterator]();
	assert.equal((await iter.next()).value, 'aa');
	assert.equal((await iter.next()).value, 'cc');
});

test('bypass admission overshoots memBudget under fsBroken (degraded mem-only mode mirrors MemoryQueue)', async () => {
	// 红线 3 边界：fsBroken 粘性后 spill 不可用，mem 桶就是事实容量层。
	// 此时 bypass 命中的消息应允许 overshoot 入队（与 MemoryQueue 同义），
	// 而不是因 mem-满 fall through 到 fsBroken 短路被报 fs-error 丢掉。
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'fsb-bypass-overshoot',
		memBudget: 2, diskCap: 1024,
		bypassAdmission: () => true,
		onDrop: (reason, size) => drops.push({ reason, size }),
	});
	q.fsBroken = true; // 人为粘性，模拟降级模式
	assert.equal(await q.enqueue('aa'), true); // mem 首条 single overshoot
	// 第二条 cost 超 memBudget；fsBroken=true + bypass 命中 → bypassOvershoot 路径入 mem，不丢、不调 onDrop
	assert.equal(await q.enqueue('bb'), true, 'bypass should overshoot mem budget under fsBroken');
	assert.deepEqual(drops, [], 'bypass-overshoot should not invoke onDrop');
	// 两条都应能消费出来
	const iter = q[Symbol.asyncIterator]();
	assert.equal((await iter.next()).value, 'aa');
	assert.equal((await iter.next()).value, 'bb');
	await q.destroy();
});

test('fsBroken short-circuit beats disk-cap admission for non-bypass (drops as fs-error, not disk-cap)', async () => {
	// 红线 3 边界：fsBroken 粘性后 spill 永远不可用；持续 bypass overshoot 把 mem 推过 diskCap
	// 阈值后，非 bypass 消息进来，admission 不应抢先报 disk-cap（该 reason 让运维误以为是容量问题，
	// 掩盖 fs 已坏的根因）。预期：drop reason='fs-error' 并带 lastFsErr。
	const dir = await makeTmpDir();
	const drops = [];
	let bypassFlag = true;
	const q = await makeQ({
		dir, id: 'fsb-disk-cap-precedence',
		memBudget: 2, diskCap: 5,
		bypassAdmission: () => bypassFlag,
		onDrop: (reason, size, err) => drops.push({ reason, size, err }),
	});
	const fakeErr = new Error('synthetic fs failure');
	fakeErr.code = 'ENOSPC';
	q.fsBroken = true;
	q.lastFsErr = fakeErr;
	// 通过 bypass overshoot 把 mem 推到 ≥ diskCap
	// 'aa' 首条 single overshoot: mb(0)<2 → mem, mb=2
	// 'bb' bypass overshoot: !memFits(2≥2) && fsBroken && bypass → mem, mb=4
	// 'cc' bypass overshoot: 同上, mb=6（≥ diskCap=5）
	assert.equal(await q.enqueue('aa'), true);
	assert.equal(await q.enqueue('bb'), true);
	assert.equal(await q.enqueue('cc'), true);
	assert.deepEqual(drops, [], 'bypass overshoots should not drop');
	// 现在 mem 已超 diskCap；非 bypass 消息进来：fsBroken 短路必须赢
	bypassFlag = false;
	assert.equal(await q.enqueue('dd'), false);
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'fs-error', 'non-bypass under fsBroken must drop as fs-error, not disk-cap');
	assert.equal(drops[0].err, fakeErr, 'fs-error drop carries lastFsErr');
	await q.destroy();
});

// --- maxMessageBytes 单条上限（接口对齐 MemoryQueue；与 sender 端 MAX_SINGLE_MSG_BYTES 同义）---

test('maxMessageBytes: single oversized message is dropped with reason=oversize', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'mmb-over',
		memBudget: 1024, diskCap: 4096, maxMessageBytes: 4,
		onDrop: (reason, size) => drops.push({ reason, size }),
	});
	assert.equal(await q.enqueue('abcde'), false); // 5 > 4
	assert.deepEqual(drops, [{ reason: 'oversize', size: 5 }]);
	assert.equal(q.stats().memCount, 0);
	await q.destroy();
});

test('maxMessageBytes: bypass does NOT exempt oversize (red-line: bypass 仅豁免容量层)', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'mmb-bypass',
		memBudget: 1024, diskCap: 4096, maxMessageBytes: 4,
		bypassAdmission: () => true,
		onDrop: (reason, size) => drops.push({ reason, size }),
	});
	assert.equal(await q.enqueue('abcde'), false);
	assert.deepEqual(drops, [{ reason: 'oversize', size: 5 }]);
	await q.destroy();
});

test('maxMessageBytes: equal-to-cap message is accepted', async () => {
	const dir = await makeTmpDir();
	const q = await makeQ({
		dir, id: 'mmb-eq',
		memBudget: 1024, diskCap: 4096, maxMessageBytes: 5,
	});
	assert.equal(await q.enqueue('abcde'), true);
	assert.equal(q.stats().memCount, 1);
	await q.destroy();
});

test('maxMessageBytes defaults to Infinity (backward-compatible)', async () => {
	const dir = await makeTmpDir();
	const q = await makeQ({ dir, id: 'mmb-def' });
	assert.equal(q.maxMessageBytes, Infinity);
	const huge = 'x'.repeat(64 * 1024);
	assert.equal(await q.enqueue(huge), true);
	await q.destroy();
});

test('constructor rejects non-finite or non-positive maxMessageBytes', () => {
	const base = { dir: '/tmp/whatever', id: 'mmb-bad', logger: silentLogger() };
	for (const bad of [NaN, -Infinity, 0, -1, '1', null]) {
		assert.throws(
			() => new FileBackedQueue({ ...base, maxMessageBytes: bad }),
			/maxMessageBytes must be Infinity or a finite positive number/,
			`expected rejection for maxMessageBytes=${String(bad)}`,
		);
	}
});

// --- asyncIterator waiting ---

test('asyncIterator waits for enqueue then delivers', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'wait' });
	const iter = q[Symbol.asyncIterator]();
	const pending = iter.next();
	await waitForWaiter(q); // 确认 next() 真的进入了 waiter 等待态
	await q.enqueue('late');
	const r = await pending;
	assert.equal(r.value, 'late');
	await q.destroy();
});

test('for-await break invokes iterator return() cleanly', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'brk' });
	for (const v of ['x', 'y', 'z']) await q.enqueue(v);
	let count = 0;
	for await (const _v of q) {
		count++;
		if (count === 2) break;
	}
	assert.equal(count, 2);
	await q.destroy();
});

// --- destroy ---

test('destroy is idempotent', async () => {
	const dir = await makeTmpDir();
	const q = await makeQ({ dir, id: 'dst' });
	await q.enqueue('x');
	await q.destroy();
	await q.destroy(); // should not throw
});

test('destroy ends active iterator', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'dst2' });
	const iter = q[Symbol.asyncIterator]();
	const pending = iter.next();
	await waitForWaiter(q);
	await q.destroy();
	const r = await pending;
	assert.equal(r.done, true);
});

test('enqueue after destroy returns false', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'dst3' });
	await q.destroy();
	assert.equal(await q.enqueue('x'), false);
});

test('destroy with spilled data closes stream and removes file', async () => {
	const dir = await makeTmpDir();
	const q = await makeQ({ dir, id: 'dst4', memBudget: 1 });
	await q.enqueue('aa'); // mem (first item)
	await q.enqueue('bb'); // spill
	assert.equal(q.stats().spilled, true);
	await q.destroy();
	await assert.rejects(() => fs.stat(nodePath.join(dir, 'dst4.jsonl')));
});

// --- destroy onBeforeClear (B-stage2 B8) ---

test('destroy(onBeforeClear): mutex 内拿原子残留快照，能看到 in-flight enqueue', async () => {
	// 与 MemoryQueue 同款契约（webrtc-peer 4 处清理点依赖此原子快照）：
	// sync 调 q.stats() 看不到 in-flight 入队（mutex 排队），destroy(callback) 在 mutex 内 fire
	const q = await makeQ({ dir: await makeTmpDir(), id: 'dst-snap', memBudget: 1024 });
	const enqueuePromise = q.enqueue('"in-flight"').catch(() => {});
	let snapshot = null;
	const destroyPromise = q.destroy((residual) => { snapshot = residual; });
	await enqueuePromise;
	await destroyPromise;
	assert.ok(snapshot, 'onBeforeClear 必须 fire');
	assert.equal(snapshot.memCount, 1, '应当看到 in-flight 入队的消息');
	assert.equal(snapshot.memBytes, Buffer.byteLength('"in-flight"', 'utf8'));
	// 6 字段形态对齐 MemoryQueue
	assert.equal(snapshot.diskBytes, 0);
	assert.equal(snapshot.writtenBytes, 0);
	assert.equal(snapshot.spilled, false);
	assert.equal(snapshot.fsBroken, false);
});

test('destroy(onBeforeClear): 6 字段反映真实磁盘状态（spilled / writtenBytes / diskBytes 非零）', async () => {
	// 关键差异 vs MemoryQueue：FBQ 的 6 字段在快照里反映真实磁盘状态，而不是恒 0
	const q = await makeQ({ dir: await makeTmpDir(), id: 'dst-disk', memBudget: 1 });
	await q.enqueue('aa'); // mem
	await q.enqueue('bb'); // spill: 'bb\n' = 3 bytes
	await q.enqueue('cc'); // spill: 'cc\n' = 3 bytes
	let snapshot = null;
	await q.destroy((residual) => { snapshot = residual; });
	assert.ok(snapshot);
	// 内存里仍有 'aa' 没被消费；disk 上有 'bb\n' + 'cc\n' = 6 bytes
	assert.equal(snapshot.memCount, 1);
	assert.equal(snapshot.memBytes, 2);
	assert.equal(snapshot.spilled, true);
	assert.equal(snapshot.writtenBytes, 6);
	assert.equal(snapshot.diskBytes, 6);
	assert.equal(snapshot.fsBroken, false);
});

test('destroy(onBeforeClear): callback 自身抛被吞，destroy 仍完成（silent swallow，与 MemoryQueue 镜像）', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'dst-throw' });
	await q.enqueue('x');
	await assert.doesNotReject(q.destroy(() => { throw new Error('callback boom'); }));
	assert.equal(q.destroyed, true);
});

test('destroy(onBeforeClear): 同步钩子契约——destroy 不 await 异步 callback（防 try/catch 改成 await catch 破坏 destroy 契约）', async () => {
	// 红线 5：onBeforeClear 是同步钩子；返回 Promise 时 rejection 不被捕获是 silent gotcha。
	// pin 方法：返回 thenable，但 destroy 不 await 时 then 永不被调；若将来有人把 try { onBeforeClear() }
	// 改成 try { await onBeforeClear() }，await 会触发 thenable.then() → awaited=true → 测试红。
	// 无 timing 依赖、无残留 Promise。
	const q = await makeQ({ dir: await makeTmpDir(), id: 'dst-async-noawait' });
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

test('destroy(onBeforeClear): 第二次 destroy 是 no-op，不 fire callback', async () => {
	// destroy 自身幂等保证 onBeforeClear 仅 fire 一次（与 monitor.summarized flag 互为兜底）
	const q = await makeQ({ dir: await makeTmpDir(), id: 'dst-idem' });
	let calls = 0;
	await q.destroy(() => { calls += 1; });
	await q.destroy(() => { calls += 1; });
	assert.equal(calls, 1);
});

test('destroy() 不传 callback 时行为不变（向后兼容）', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'dst-nocb', memBudget: 1 });
	await q.enqueue('aa');
	await q.enqueue('bb'); // spill
	// 不传 callback 应与 B8 之前行为完全一致：destroy 完成、文件被删
	await assert.doesNotReject(q.destroy());
	assert.equal(q.destroyed, true);
});

test('destroy 先排队、enqueue 后排队：mutex FIFO + destroyed 短路 → enqueue 拿到锁返 false', async () => {
	// 关键 race 不变量（对齐 MemoryQueue 同款测试）：destroy 与 enqueue 同 tick 并发，destroy 先入
	// mutex 队列时——destroy 的 mutex callback 先 fire（设 destroyed=true），enqueue 的 mutex callback
	// 后跑（看到 destroyed=true 直接返 false）。这条窗口在 webrtc-peer 同 connId 重建路径上是真实并发场景。
	const droppedReasons = [];
	const q = await makeQ({
		dir: await makeTmpDir(), id: 'dst-race',
		onDrop: (reason) => { droppedReasons.push(reason); },
	});
	// 同 tick 并发：destroy 先调用，先进 mutex 队列；enqueue 后调用，排第二
	const destroyP = q.destroy();
	const enqueueP = q.enqueue('"after-destroy-pending"');
	const [, ok] = await Promise.all([destroyP, enqueueP]);
	assert.equal(ok, false, 'enqueue must return false (destroyed short-circuit)');
	assert.equal(q.destroyed, true);
	// destroyed 短路是 silent drop——队列已死，不需要 noisy onDrop（连接清理的正常副作用）
	assert.deepEqual(droppedReasons, [], 'destroyed-short-circuit must not fire onDrop');
});

// --- clear ---

test('clear empties in-memory state, instance still usable', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'clr' });
	await q.enqueue('a');
	await q.enqueue('b');
	await q.clear();
	assert.deepEqual(q.stats(), { memCount: 0, memBytes: 0, diskBytes: 0, writtenBytes: 0, spilled: false, fsBroken: false });
	// still usable
	await q.enqueue('c');
	assert.equal(q.stats().memCount, 1);
	await q.destroy();
});

test('clear on spilled state deletes file and resets state', async () => {
	const dir = await makeTmpDir();
	const q = await makeQ({ dir, id: 'clr2', memBudget: 1 });
	await q.enqueue('aa'); // mem
	await q.enqueue('bb'); // spill
	assert.equal(q.stats().spilled, true);
	await q.clear();
	assert.equal(q.stats().spilled, false);
	await assert.rejects(() => fs.stat(nodePath.join(dir, 'clr2.jsonl')));
	// can enqueue again and it goes back to mem path
	await q.enqueue('x');
	assert.equal(q.stats().memCount, 1);
	assert.equal(q.stats().spilled, false);
	await q.destroy();
});

test('clear resets fsBroken so future spills can reopen', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'clrbrk', memBudget: 1 });
	q.fsBroken = true; // 人为模拟
	await q.clear();
	assert.equal(q.stats().fsBroken, false);
	await q.destroy();
});

test('clear after destroy is a no-op', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'clr3' });
	await q.destroy();
	await q.clear(); // should not throw
});

test('clear dispatches onSpillEnd when wasSpilled (monitor spillActive resync)', async () => {
	// 与 __dropFile 对称：clear() 让 spilled 翻 true→false 时也应调 onSpillEnd，
	// 否则监视器的 spillActive 永久卡住，下一轮真实 spill-start 被吞。
	const dir = await makeTmpDir();
	const calls = [];
	const q = await makeQ({
		dir, id: 'clear-spill-end',
		memBudget: 1, diskCap: 1024,
		onSpillStart: () => calls.push({ kind: 'start' }),
		onSpillEnd: (drainedBytes) => calls.push({ kind: 'end', drainedBytes }),
	});
	assert.equal(await q.enqueue('a'), true);  // mem (single overshoot, mb=1)
	assert.equal(await q.enqueue('b'), true);  // spill (wb=2)
	assert.equal(q.stats().spilled, true);
	await q.clear();
	assert.equal(q.stats().spilled, false);
	assert.deepEqual(calls, [
		{ kind: 'start' },
		{ kind: 'end', drainedBytes: 2 },
	]);
	await q.destroy();
});

test('clear does NOT dispatch onSpillEnd when not spilled', async () => {
	const dir = await makeTmpDir();
	const calls = [];
	const q = await makeQ({
		dir, id: 'clear-no-spill',
		memBudget: 100, diskCap: 1024,
		onSpillEnd: (drainedBytes) => calls.push({ drainedBytes }),
	});
	assert.equal(await q.enqueue('a'), true); // 全在 mem
	assert.equal(q.stats().spilled, false);
	await q.clear();
	assert.deepEqual(calls, [], 'clear with no spill should not dispatch onSpillEnd');
	await q.destroy();
});

// --- partial tail (defensive) ---

test('refill discards unterminated tail line and logs partial warn with size', async () => {
	const dir = await makeTmpDir();
	const warnings = [];
	const q = await makeQ({
		dir, id: 'part',
		memBudget: 1,
		logger: { warn: (...args) => warnings.push(args), info: () => {}, error: () => {} },
	});
	await q.enqueue('aa'); // mem (first item)
	await q.enqueue('bb'); // spill: 'bb\n' on disk

	const fp = nodePath.join(dir, 'part.jsonl');
	const st = await fs.stat(fp);
	await fs.truncate(fp, st.size - 1); // strip trailing \n → 'bb' partial

	const iter = q[Symbol.asyncIterator]();
	assert.equal((await iter.next()).value, 'aa');

	// Next call: mem empty, spilled true → refill. Partial tail discarded; spilled collapses.
	const pending = iter.next();
	await waitForWaiter(q);
	await q.destroy();
	const r = await pending;
	assert.equal(r.done, true);

	const partialWarns = warnings.filter(([msg]) => /partial tail discarded/.test(msg));
	assert.equal(partialWarns.length, 1);
	assert.deepEqual(partialWarns[0][1], { size: 2 });
});

test('refill with some valid lines plus unterminated tail keeps valid, discards partial', async () => {
	const dir = await makeTmpDir();
	const q = await makeQ({ dir, id: 'part2', memBudget: 1 });
	await q.enqueue('aa');    // mem
	await q.enqueue('bbb');   // spill. disk: 'bbb\n'
	await q.enqueue('cc');    // disk: 'bbb\ncc\n'

	const fp = nodePath.join(dir, 'part2.jsonl');
	const st = await fs.stat(fp);
	await fs.truncate(fp, st.size - 1); // strip final \n → cc partial

	const iter = q[Symbol.asyncIterator]();
	assert.equal((await iter.next()).value, 'aa');
	assert.equal((await iter.next()).value, 'bbb');

	// cc was partial → must be discarded.
	const pending = iter.next();
	await waitForWaiter(q);
	await q.destroy();
	const r = await pending;
	assert.equal(r.done, true);
});

test('refill drops file when external truncation puts readOffset past actualEnd', async () => {
	const dir = await makeTmpDir();
	const q = await makeQ({ dir, id: 'trunc', memBudget: 1 });
	await q.enqueue('aa'); // mem
	await q.enqueue('bb'); // spill
	await q.enqueue('cc'); // spill

	const iter = q[Symbol.asyncIterator]();
	assert.equal((await iter.next()).value, 'aa');
	assert.equal((await iter.next()).value, 'bb');

	// readOffset 现在推到 'bb\n' 末尾。外部截到更短。
	const fp = nodePath.join(dir, 'trunc.jsonl');
	await fs.truncate(fp, 2);

	const pending = iter.next();
	await waitForWaiter(q);
	await q.destroy();
	const r = await pending;
	assert.equal(r.done, true);
});

test('destroy after writeStream error does not hang', async () => {
	const dir = await makeTmpDir();
	const q = await makeQ({ dir, id: 'hng', memBudget: 1 });
	await q.enqueue('aa'); // mem
	await q.enqueue('bb'); // spill → opens stream
	q.writeStream.emit('error', new Error('simulated'));
	// Safety: if close path hangs, fail fast instead of hanging the whole suite.
	await Promise.race([
		q.destroy(),
		new Promise((_, reject) => setTimeout(() => reject(new Error('destroy hung')), 1000)),
	]);
});

test('iterator next() after destroy returns done', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'postd' });
	await q.destroy();
	const iter = q[Symbol.asyncIterator]();
	const r = await iter.next();
	assert.equal(r.done, true);
});

// --- fs errors ---

test('enqueue returns false when mkdir of parent dir fails and latches fsBroken', async () => {
	// 用一个不存在的嵌套父目录，放置文件当障碍让 mkdir 失败
	const base = await makeTmpDir();
	const blocker = nodePath.join(base, 'blocker');
	await fs.writeFile(blocker, 'not-a-dir');
	const dir = nodePath.join(blocker, 'sub'); // mkdir(sub) on file 'blocker' 会 ENOTDIR
	const drops = [];
	const q = new FileBackedQueue({
		dir, id: 'mkf',
		memBudget: 1,
		onDrop: (reason, size) => drops.push({ reason, size }),
		logger: silentLogger(),
	});
	await q.init(); // init 的 rm force 允许 ENOENT，不报错
	await q.enqueue('aa'); // mem (first item)
	const ok = await q.enqueue('bb'); // 尝试 spill → mkdir fails
	assert.equal(ok, false);
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'fs-error');
	// 前置 FS 失败同样进入粘性降级，不再反复重试
	assert.equal(q.stats().fsBroken, true);
	const ok2 = await q.enqueue('cc');
	assert.equal(ok2, false);
	assert.equal(drops.length, 2);
	// mem 路径仍可工作（pendingCount=1 的 'aa' 消费掉后，下一条首条被接受）
	const iter = q[Symbol.asyncIterator]();
	assert.equal((await iter.next()).value, 'aa');
	assert.equal(await q.enqueue('dd'), true); // mem safety valve
});

test('enqueue returns false when writeStream emits error; queue enters fsBroken', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'werr',
		memBudget: 1,
		onDrop: (reason, size) => drops.push({ reason, size }),
	});
	await q.enqueue('aa'); // mem
	await q.enqueue('bb'); // spill, opens stream
	q.writeStream.emit('error', new Error('simulated stream error'));
	// 下一轮 enqueue 走 spill 路径应直接被 fsBroken 拦下
	const ok = await q.enqueue('cc');
	assert.equal(ok, false);
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'fs-error');
	assert.equal(q.stats().fsBroken, true);
	await q.destroy();
});

test('enqueue returns false when write callback errors and enters fsBroken', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'wcb',
		memBudget: 1,
		onDrop: (reason, size) => drops.push({ reason, size }),
	});
	await q.enqueue('aa'); // mem
	await q.enqueue('bb'); // spill, opens stream
	// 替换 write 让 cb 直接报错
	q.writeStream.write = (_data, cb) => { cb(new Error('cb err')); };
	const ok = await q.enqueue('cc');
	assert.equal(ok, false);
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'fs-error');
	// #3 修复：cb err 时 catch 直接触发 __handleFsError，不依赖 stream 'error' event 闭环
	assert.equal(q.stats().fsBroken, true);
	// 后续 spill 请求被 fsBroken 粘性拦下
	const ok2 = await q.enqueue('dd');
	assert.equal(ok2, false);
	assert.equal(drops.length, 2);
	assert.equal(drops[1].reason, 'fs-error');
	await q.destroy();
});

// 关键回归：写流异步 error 后消费者必须不卡死，队列进入 fsBroken 降级
test('async write stream error wakes blocked consumer and enters fsBroken', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'stuck',
		memBudget: 1,
		onDrop: (reason, size) => drops.push({ reason, size }),
	});
	// 劫持 __openWriteStream：保持 mkdir 成功，但让接下来的 write 永远 cb err + emit error
	const origOpen = q.__openWriteStream.bind(q);
	q.__openWriteStream = async function() {
		await origOpen();
		this.writeStream.write = (_chunk, cb) => { process.nextTick(() => cb(new Error('simulated-write-fail'))); return false; };
		process.nextTick(() => this.writeStream.emit('error', new Error('simulated-async-open-fail')));
	};

	// 第一条入 mem（safety valve），第二条触发 spill 路径 → 我们的劫持生效
	await q.enqueue('aa');
	const okSpill = await q.enqueue('bb');
	assert.equal(okSpill, false); // write cb err

	// 关键断言：即便异步错误把 spilled 置 true 过，最终 fsBroken 粘性+唤醒全部消费者，consumer 不会卡死
	const iter = q[Symbol.asyncIterator]();
	const first = await Promise.race([
		iter.next(),
		new Promise((_, rej) => setTimeout(() => rej(new Error('consumer hung on first')), 800)),
	]);
	assert.equal(first.value, 'aa'); // mem 里的 'aa' 仍可消费

	// 消费完之后 memQueue 空，spilled=false（已被 __handleFsError 清），且 fsBroken=true
	assert.equal(q.stats().fsBroken, true);

	// 下一次 next() 应进入等待（而不是卡在 refill 里），通过 destroy 把它唤醒
	const pending = iter.next();
	await waitForWaiter(q);
	await q.destroy();
	const r = await pending;
	assert.equal(r.done, true);
});

// 关键回归：读侧 FS 错误（外部删文件、权限丢失等）也走 fsBroken 粘性降级，
// consumer 不会永远挂在 waiter 上。
test('refill stat error latches fsBroken and wakes blocked consumer', async () => {
	const dir = await makeTmpDir();
	const q = await makeQ({ dir, id: 'rstat', memBudget: 1 });
	await q.enqueue('aa'); // mem
	await q.enqueue('bb'); // spill: 'bb\n' on disk
	assert.equal(q.stats().spilled, true);

	// 消费掉 mem 里的 'aa'
	const iter = q[Symbol.asyncIterator]();
	assert.equal((await iter.next()).value, 'aa');

	// 外部删除 spill 文件，下一次 refill 的 stat 会 ENOENT
	await fs.rm(nodePath.join(dir, 'rstat.jsonl'), { force: true });

	// 下一次 next() 应触发 refill → stat fails → __handleFsError → wakeAll → 看到 nothing → 回到 waiter
	// 再把 destroy 拉起它退出
	const pending = iter.next();
	await waitForWaiter(q);
	// 此时 fsBroken 应已粘性置 true
	assert.equal(q.stats().fsBroken, true);
	assert.equal(q.stats().spilled, false);
	await q.destroy();
	const r = await pending;
	assert.equal(r.done, true);
});

test('fsBroken is sticky: after FS error, overflow enqueue keeps dropping', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'sticky',
		memBudget: 1,
		onDrop: (reason, size) => drops.push({ reason, size }),
	});
	await q.enqueue('aa'); // mem
	await q.enqueue('bb'); // spill, opens stream
	q.writeStream.emit('error', new Error('boom'));
	// 让 mutex 里的清理任务跑完
	await q.enqueue('cc'); // 第一次 drop
	const ok = await q.enqueue('dd'); // 第二次仍 drop
	assert.equal(ok, false);
	assert.equal(drops.length, 2);
	assert.equal(drops.every(d => d.reason === 'fs-error'), true);
	assert.equal(q.stats().fsBroken, true);
	// 但 mem 仍可继续：消费 'aa' 后 pendingCount=0，下一条 mem 路径再次首条被接受
	const iter = q[Symbol.asyncIterator]();
	assert.equal((await iter.next()).value, 'aa');
	const ee = await q.enqueue('ee');
	assert.equal(ee, true); // 接受到 mem（safety valve）
	await q.destroy();
});

// --- fs-error errno passthrough (B-stage2 B7) ---

test('fs-error drop carries err via onDrop third arg (mkdir path); err is sticky on subsequent drops', async () => {
	const base = await makeTmpDir();
	const blocker = nodePath.join(base, 'blocker');
	await fs.writeFile(blocker, 'not-a-dir');
	const dir = nodePath.join(blocker, 'sub'); // mkdir(sub) on file 'blocker' 会 ENOTDIR
	const drops = [];
	const q = new FileBackedQueue({
		dir, id: 'mkf-err',
		memBudget: 1,
		onDrop: (reason, size, err) => drops.push({ reason, size, err }),
		logger: silentLogger(),
	});
	await q.init();
	await q.enqueue('aa'); // mem
	await q.enqueue('bb'); // spill → mkdir fails
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'fs-error');
	assert.ok(drops[0].err instanceof Error);
	assert.ok(typeof drops[0].err.message === 'string' && drops[0].err.message.length > 0);

	// 第二轮 enqueue 走 fsBroken 粘性短路：仍应携带粘性 err
	await q.enqueue('cc');
	assert.equal(drops.length, 2);
	assert.ok(drops[1].err instanceof Error);
	assert.equal(drops[1].err.message, drops[0].err.message);
});

test('fs-error drop carries simulated err (writeStream emit error path)', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'werr-err',
		memBudget: 1,
		onDrop: (reason, size, err) => drops.push({ reason, size, err }),
	});
	await q.enqueue('aa');
	await q.enqueue('bb'); // spill, opens stream
	const simulated = new Error('simulated stream error');
	q.writeStream.emit('error', simulated);
	// 让异步 mutex 排队的 __handleFsError 跑完
	await new Promise((resolve) => setImmediate(resolve));
	// 下一轮 enqueue 走 fsBroken 短路
	await q.enqueue('cc');
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'fs-error');
	assert.equal(drops[0].err, simulated);
	await q.destroy();
});

test('fs-error drop carries simulated err (write cb error path)', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'wcb-err',
		memBudget: 1,
		onDrop: (reason, size, err) => drops.push({ reason, size, err }),
	});
	await q.enqueue('aa');
	await q.enqueue('bb'); // spill, opens stream
	const simulated = new Error('cb err');
	q.writeStream.write = (_data, cb) => { cb(simulated); };
	await q.enqueue('cc');
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'fs-error');
	assert.equal(drops[0].err, simulated);
	await q.destroy();
});

test('oversize drop does not carry err on onDrop third arg', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'oversize-noerr',
		memBudget: 100, diskCap: 1000, maxMessageBytes: 1,
		onDrop: (reason, size, err) => drops.push({ reason, size, err }),
	});
	await q.enqueue('aa'); // size=2 > maxMessageBytes(1) → oversize drop
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'oversize');
	assert.equal(drops[0].err, undefined);
	await q.destroy();
});

test('disk-cap drop carries memBytes/writtenBytes/diskCap components on onDrop third arg', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	// 监视器侧 disk-cap-start log 用这三个分量替换原"size only"——区分"队列总占用顶到阈值"vs"文件满"
	const q = await makeQ({
		dir, id: 'cap-components',
		memBudget: 2, diskCap: 5,
		onDrop: (reason, size, err) => drops.push({ reason, size, err }),
	});
	await q.enqueue('aa'); // mem (overshoot)
	await q.enqueue('bb'); // spill, wb=3
	await q.enqueue('c'); // mb(2)+wb(3)=5 ≥ 5 → drop
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'disk-cap');
	assert.deepEqual(drops[0].err, { memBytes: 2, writtenBytes: 3, diskCap: 5 });
	await q.destroy();
});

test('refill stat error caches err to lastFsErr (drop passthrough covered by other tests)', async () => {
	// refill 路径产生 err 后由 __handleFsError 缓存到 lastFsErr 是关键证据。
	// 从 lastFsErr 到 onDrop 第三参的透传链路由 writeStream/write-cb/clear 测试覆盖。
	const dir = await makeTmpDir();
	const q = await makeQ({ dir, id: 'rstat-err', memBudget: 1 });
	await q.enqueue('aa'); // mem
	await q.enqueue('bb'); // spill: 'bb\n' on disk
	const iter = q[Symbol.asyncIterator]();
	assert.equal((await iter.next()).value, 'aa');
	// 外部删文件让 refill 的 stat ENOENT
	await fs.rm(nodePath.join(dir, 'rstat-err.jsonl'), { force: true });
	const pending = iter.next();
	await waitForWaiter(q);
	assert.equal(q.stats().fsBroken, true);
	assert.ok(q.lastFsErr instanceof Error);
	assert.ok(typeof q.lastFsErr.message === 'string' && q.lastFsErr.message.length > 0);
	await q.destroy();
	await pending;
});

test('lastFsErr is sticky: first err wins, subsequent fs errors do not overwrite', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'sticky-first',
		memBudget: 1,
		onDrop: (reason, size, err) => drops.push({ reason, size, err }),
	});
	await q.enqueue('aa');
	await q.enqueue('bb');
	const firstErr = new Error('first-err');
	q.writeStream.emit('error', firstErr);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(q.lastFsErr, firstErr);

	// 重复触发 __handleFsError 时（fsBroken 已置）应早返回、不覆盖 lastFsErr
	await q.mutex.withLock(() => q.__handleFsError(new Error('second-err')));
	assert.equal(q.lastFsErr, firstErr); // 仍是第一个 err

	// 走 fsBroken 短路的 enqueue 拿到的也是第一个 err
	await q.enqueue('cc');
	assert.equal(drops.at(-1).err, firstErr);
	await q.destroy();
});

test('clear resets lastFsErr; no stale err leaks into next fs-error', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'clr-lastfs',
		memBudget: 1,
		onDrop: (reason, size, err) => drops.push({ reason, size, err }),
	});
	await q.enqueue('aa');
	await q.enqueue('bb'); // spill, opens stream
	const firstErr = new Error('first');
	q.writeStream.emit('error', firstErr);
	await new Promise((resolve) => setImmediate(resolve));
	await q.enqueue('cc'); // 拿粘性 firstErr
	assert.equal(drops.at(-1).err, firstErr);

	// clear 应同时重置 fsBroken 和 lastFsErr，确保旧 err 不漏到下一轮
	await q.clear();
	assert.equal(q.lastFsErr, null);

	// 模拟无新 err 来源的 fs-error 路径（人为粘性）：onDrop 第三参应为 null（lastFsErr 已被 clear）
	q.fsBroken = true;
	await q.enqueue('dd'); // mem 首条 safety valve
	await q.enqueue('ee'); // spill → fsBroken 短路 → drop with lastFsErr
	assert.equal(drops.at(-1).reason, 'fs-error');
	assert.notEqual(drops.at(-1).err, firstErr);
	assert.equal(drops.at(-1).err, null);
	await q.destroy();
});

// --- head pointer compaction ---

test('head pointer compacts on drain; memQueue array size bounded', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'head' });
	// 入队 200 条纯内存
	for (let i = 0; i < 200; i++) await q.enqueue(`i-${i}`);
	const iter = q[Symbol.asyncIterator]();
	// 消费一半，应触发若干次压缩
	for (let i = 0; i < 120; i++) await iter.next();
	// 压缩点：head > 64 且 head*2 >= memQueue.length
	// 消费 120 条之后 head 应多次重置，数组长度不会接近 200
	assert.ok(q.memQueue.length < 200, `memQueue length should shrink, got ${q.memQueue.length}`);
	// 剩余项仍能正确消费，FIFO
	for (let i = 120; i < 200; i++) {
		const r = await iter.next();
		assert.equal(r.value, `i-${i}`);
	}
	await q.destroy();
});

// --- integration-ish: many items through spill/refill ---

test('many items round-trip through spill', async () => {
	const q = await makeQ({ dir: await makeTmpDir(), id: 'many', memBudget: 2048 });
	const N = 200;
	for (let i = 0; i < N; i++) {
		assert.equal(await q.enqueue(`item-${i}`), true);
	}
	const out = [];
	for await (const item of q) {
		out.push(item);
		if (out.length === N) break;
	}
	assert.equal(out.length, N);
	for (let i = 0; i < N; i++) assert.equal(out[i], `item-${i}`);
	assert.equal(q.stats().spilled, false);
	await q.destroy();
});
