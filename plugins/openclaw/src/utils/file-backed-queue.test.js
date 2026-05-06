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

test('enqueue spills to disk when memBudget exceeded', async () => {
	const dir = await makeTmpDir();
	const q = await makeQ({ dir, id: 'spill', memBudget: 3 });
	assert.equal(await q.enqueue('aa'), true); // 首条无论多大都入 mem（safety valve）
	assert.equal(await q.enqueue('bb'), true); // 2+2+overhead 超 budget → spill
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

test('refill respects memBudget (partial fill, stays spilled)', async () => {
	const dir = await makeTmpDir();
	// 用较大 budget 精细控制：每条 32 字节 payload，overhead 64 → 每条"成本" 96
	// budget 200 能装 2 条（96*2=192 ≤ 200），第三条 96*3=288 > 200 → 需要分批
	const payload = 'x'.repeat(32);
	const q = await makeQ({ dir, id: 'partial', memBudget: 200 });
	for (let i = 0; i < 4; i++) assert.equal(await q.enqueue(payload + i), true);
	assert.equal(q.stats().spilled, true);

	const iter = q[Symbol.asyncIterator]();
	const out = [];
	for (let i = 0; i < 4; i++) out.push((await iter.next()).value);
	assert.deepEqual(out, [payload + 0, payload + 1, payload + 2, payload + 3]);
	assert.equal(q.stats().spilled, false);
	await q.destroy();
});

// --- diskCap ---

test('enqueue rejected when exceeding diskCap; onDrop receives disk-cap', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	// memBudget=2 让 'bb' 溢出；diskCap=5（2+3='bb\n'）塞满后再入一条就触顶
	// memBytes=2 + writtenBytes=3 + new.size+1(=2) = 7 > 5 → drop
	const q = await makeQ({
		dir, id: 'cap',
		memBudget: 2, diskCap: 5,
		onDrop: (reason, size) => drops.push({ reason, size }),
	});
	assert.equal(await q.enqueue('aa'), true); // mem (first item)
	assert.equal(await q.enqueue('bb'), true); // spill, disk 3 bytes (含 \n)
	assert.equal(await q.enqueue('c'), false); // 2+3+2 > 5 → drop
	assert.deepEqual(drops, [{ reason: 'disk-cap', size: 1 }]);
	await q.destroy();
});

test('diskCap caps physical file size, not just backlog; recovers after full drain', async () => {
	// 关键回归：producer/consumer 持续交错、readOffset 追不上 writtenBytes 时，
	// 物理文件仍然不会无界增长；admission 基于 writtenBytes 保证 diskCap 是硬上限。
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'phys',
		memBudget: 1, diskCap: 10,
		onDrop: (reason, size) => drops.push({ reason, size }),
	});

	// enqueue 5 条 'a'：第 1 条进 mem（safety valve），后 4 条 spill，每条含 \n=2 字节
	// 入队后 memBytes=1, writtenBytes=8
	for (let i = 0; i < 5; i++) assert.equal(await q.enqueue('a'), true);
	// 下一条 admission：1 + 8 + 1 + 1 = 11 > 10 → drop
	assert.equal(await q.enqueue('a'), false);
	assert.equal(drops.length, 1);

	// 消费者读一条（mem 中的 'a'）→ memBytes=0, writtenBytes 不变
	const iter = q[Symbol.asyncIterator]();
	assert.equal((await iter.next()).value, 'a');

	// 消费者继续读：refill 把 1 条从 disk 取到 mem，然后 shift。writtenBytes 仍不变（未触发 __dropFile）
	assert.equal((await iter.next()).value, 'a');

	// 此刻 memBytes 接近 0、writtenBytes 仍 8（还没 drain 完）；admission：0+8+1+1=10 不>10 → accept
	// 这恰好卡在上限；再塞一条会变 0+10+1+1=12 > 10
	assert.equal(await q.enqueue('a'), true);
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
	// 'a' admission: mem+disk+size+1 = 0+0+1+1 = 2 > diskCap(1) → drop；onDrop 抛错被 catch
	assert.equal(await q.enqueue('a'), false);
	assert.equal(await q.enqueue('b'), false);
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

test('bypass admission does NOT exempt physical IO failure (mkdir path)', async () => {
	// 红线 3 真实意图：bypass 不豁免实际写入失败那一刻——而非 fsBroken 之后所有 mem-满 都叫 fs-error。
	// 这里用 ENOTDIR 真触发 mkdir 失败：'bb' 走 spill 真试图开流，开流失败 → drop('fs-error')。
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
	// 第二条会让 cost 超 memBudget → 走 spill → mkdir 失败 → drop fs-error，bypass 不救
	assert.equal(await q.enqueue('bb'), false);
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'fs-error');
	assert.ok(drops[0].err instanceof Error);
	assert.equal(q.stats().fsBroken, true);
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
	assert.equal(await q.enqueue('aa'), true); // mem 首条 safety valve
	// 第二条会让 cost 超 memBudget；fsBroken=true → 当前实现 fall through 到短路 drop fs-error
	// 修复后：bypass 命中应 overshoot 入队，不丢、不调 onDrop
	assert.equal(await q.enqueue('bb'), true, 'bypass should overshoot mem budget under fsBroken');
	assert.deepEqual(drops, [], 'bypass-overshoot should not invoke onDrop');
	// 两条都应能消费出来
	const iter = q[Symbol.asyncIterator]();
	assert.equal((await iter.next()).value, 'aa');
	assert.equal((await iter.next()).value, 'bb');
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

test('non-fs-error drops do not carry err on onDrop third arg', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = await makeQ({
		dir, id: 'cap-noerr',
		memBudget: 2, diskCap: 5,
		onDrop: (reason, size, err) => drops.push({ reason, size, err }),
	});
	await q.enqueue('aa');
	await q.enqueue('bb');
	await q.enqueue('c'); // disk-cap drop
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'disk-cap');
	assert.equal(drops[0].err, undefined);
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
