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

test('constructor cleans up pre-existing residue under subdir', async () => {
	const dir = await makeTmpDir();
	const subdir = nodePath.join(dir, 'res');
	await fs.mkdir(subdir, { recursive: true });
	await fs.writeFile(nodePath.join(subdir, 'stale.jsonl'), 'stale\n');

	const q = new FileBackedQueue({ dir, id: 'res', logger: silentLogger() });
	// subdir should have been removed by constructor
	await assert.rejects(() => fs.stat(subdir));
	await q.destroy();
});

test('constructor accepts default memBudget and diskCap', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'def', logger: silentLogger() });
	assert.equal(q.memBudget, 8 * 1024 * 1024);
	assert.equal(q.diskCap, 1024 * 1024 * 1024);
	await q.destroy();
});

// --- stats initial ---

test('stats returns initial zeros', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'stats', logger: silentLogger() });
	assert.deepEqual(q.stats(), { memCount: 0, memBytes: 0, diskBytes: 0, spilled: false });
	await q.destroy();
});

// --- enqueue memory path ---

test('enqueue throws on non-string input', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'nstr', logger: silentLogger() });
	await assert.rejects(() => q.enqueue(123), /jsonStr must be a string/);
	await assert.rejects(() => q.enqueue(null), /jsonStr must be a string/);
	await q.destroy();
});

test('enqueue in memory; stats reflect mem state', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'mem', logger: silentLogger() });
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
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'empty', logger: silentLogger() });
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
	const q = new FileBackedQueue({ dir, id: 'spill', memBudget: 3, logger: silentLogger() });
	assert.equal(await q.enqueue('aa'), true); // 2 bytes, fits
	assert.equal(await q.enqueue('bb'), true); // 2+2=4 > 3 → spill
	const s = q.stats();
	assert.equal(s.spilled, true);
	assert.equal(s.memCount, 1);
	assert.equal(s.memBytes, 2);
	assert.equal(s.diskBytes, 2);
	// Queue file exists
	const fp = nodePath.join(dir, 'spill', 'queue.jsonl');
	await assert.doesNotReject(() => fs.stat(fp));
	await q.destroy();
});

test('FIFO preserved across spill and refill, file removed on drain', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'fifo', memBudget: 4, logger: silentLogger() });
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
	// Queue file should be gone
	const fp = nodePath.join(dir, 'fifo', 'queue.jsonl');
	await assert.rejects(() => fs.stat(fp));
	await q.destroy();
});

test('refill respects memBudget (partial fill, stays spilled)', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'partial', memBudget: 2, logger: silentLogger() });
	// 5 items of 1 byte each: 'a','b','c','d','e'
	// 'a': fits. 'b': 1+1>2? No, 2<=2 fits. Hmm. Need tighter.
	// Use items of 2 bytes with budget 2.
	// Actually let's compute: each item 2 bytes, budget 2.
	// 'aa': 0+2<=2 → mem. 'bb': 2+2>2 → spill. 'cc': spill. 'dd': spill.
	for (const s of ['aa', 'bb', 'cc', 'dd']) {
		assert.equal(await q.enqueue(s), true);
	}
	assert.equal(q.stats().spilled, true);

	const iter = q[Symbol.asyncIterator]();
	// Consume 'aa' from mem. Inline refill runs when mem empties.
	assert.equal((await iter.next()).value, 'aa');
	// Next item: mem is empty, inline refill reads 'bb' (fits budget 2) then breaks (next item would exceed 2+2).
	assert.equal((await iter.next()).value, 'bb');
	assert.equal((await iter.next()).value, 'cc');
	assert.equal((await iter.next()).value, 'dd');
	assert.equal(q.stats().spilled, false);
	await q.destroy();
});

// --- diskCap ---

test('enqueue rejected when exceeding diskCap; onDrop receives disk-cap', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = new FileBackedQueue({
		dir, id: 'cap',
		memBudget: 2, diskCap: 4,
		onDrop: (reason, size) => drops.push({ reason, size }),
		logger: silentLogger(),
	});
	assert.equal(await q.enqueue('aa'), true); // mem 2
	assert.equal(await q.enqueue('bb'), true); // spill, disk 2, total 4
	assert.equal(await q.enqueue('c'), false); // total 4+1 > 4 → drop
	assert.deepEqual(drops, [{ reason: 'disk-cap', size: 1 }]);
	await q.destroy();
});

test('onDrop that throws does not break enqueue', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({
		dir, id: 'cap2',
		memBudget: 1, diskCap: 1,
		onDrop: () => { throw new Error('onDrop bug'); },
		logger: silentLogger(),
	});
	await q.enqueue('a');
	assert.equal(await q.enqueue('b'), false);
	await q.destroy();
});

// --- asyncIterator waiting ---

test('asyncIterator waits for enqueue then delivers', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'wait', logger: silentLogger() });
	const iter = q[Symbol.asyncIterator]();
	const pending = iter.next();
	await waitForWaiter(q); // 确认 next() 真的进入了 waiter 等待态
	await q.enqueue('late');
	const r = await pending;
	assert.equal(r.value, 'late');
	await q.destroy();
});

test('for-await break invokes iterator return() cleanly', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'brk', logger: silentLogger() });
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
	const q = new FileBackedQueue({ dir, id: 'dst', logger: silentLogger() });
	await q.enqueue('x');
	await q.destroy();
	await q.destroy(); // should not throw
	// subdir gone
	await assert.rejects(() => fs.stat(nodePath.join(dir, 'dst')));
});

test('destroy ends active iterator', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'dst2', logger: silentLogger() });
	const iter = q[Symbol.asyncIterator]();
	const pending = iter.next();
	await waitForWaiter(q);
	await q.destroy();
	const r = await pending;
	assert.equal(r.done, true);
});

test('enqueue after destroy returns false', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'dst3', logger: silentLogger() });
	await q.destroy();
	assert.equal(await q.enqueue('x'), false);
});

test('destroy with spilled data closes stream and removes subdir', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'dst4', memBudget: 1, logger: silentLogger() });
	await q.enqueue('aa'); // spill
	assert.equal(q.stats().spilled, true);
	await q.destroy();
	await assert.rejects(() => fs.stat(nodePath.join(dir, 'dst4')));
});

// --- clear ---

test('clear empties in-memory state, instance still usable', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'clr', logger: silentLogger() });
	await q.enqueue('a');
	await q.enqueue('b');
	await q.clear();
	assert.deepEqual(q.stats(), { memCount: 0, memBytes: 0, diskBytes: 0, spilled: false });
	// still usable
	await q.enqueue('c');
	assert.equal(q.stats().memCount, 1);
	await q.destroy();
});

test('clear on spilled state deletes file and resets state', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'clr2', memBudget: 2, logger: silentLogger() });
	await q.enqueue('aa');
	await q.enqueue('bb'); // spill
	assert.equal(q.stats().spilled, true);
	await q.clear();
	assert.equal(q.stats().spilled, false);
	const fp = nodePath.join(dir, 'clr2', 'queue.jsonl');
	await assert.rejects(() => fs.stat(fp));
	// can enqueue again and it goes back to mem path
	await q.enqueue('x');
	assert.equal(q.stats().memCount, 1);
	assert.equal(q.stats().spilled, false);
	await q.destroy();
});

test('clear after destroy is a no-op', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'clr3', logger: silentLogger() });
	await q.destroy();
	await q.clear(); // should not throw
});

// --- partial tail (defensive) ---

test('refill discards unterminated tail line and logs partial warn with size', async () => {
	const dir = await makeTmpDir();
	const warnings = [];
	const q = new FileBackedQueue({
		dir, id: 'part',
		memBudget: 2,
		logger: { warn: (...args) => warnings.push(args), info: () => {}, error: () => {} },
	});
	await q.enqueue('aa'); // mem
	await q.enqueue('bb'); // spill: 'bb\n' on disk

	const fp = nodePath.join(dir, 'part', 'queue.jsonl');
	const st = await fs.stat(fp);
	await fs.truncate(fp, st.size - 1); // strip trailing \n → 'bb' partial

	const iter = q[Symbol.asyncIterator]();
	assert.equal((await iter.next()).value, 'aa');

	// Next call: mem empty, spilled true → refill. Partial tail discarded; spilled collapses.
	// Must NOT yield 'bb' as a value — verify by asserting iter enters waiter state.
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
	const q = new FileBackedQueue({ dir, id: 'part2', memBudget: 3, logger: silentLogger() });
	await q.enqueue('aa');    // mem 2
	await q.enqueue('bbb');   // 2+3>3 spill. disk: 'bbb\n'
	await q.enqueue('cc');    // disk: 'bbb\ncc\n'

	const fp = nodePath.join(dir, 'part2', 'queue.jsonl');
	const st = await fs.stat(fp);
	await fs.truncate(fp, st.size - 1); // strip final \n → cc partial

	const iter = q[Symbol.asyncIterator]();
	assert.equal((await iter.next()).value, 'aa');
	assert.equal((await iter.next()).value, 'bbb'); // bbb valid

	// cc was partial → must be discarded. Assert iter goes into wait (no third value).
	const pending = iter.next();
	await waitForWaiter(q);
	await q.destroy();
	const r = await pending;
	assert.equal(r.done, true);
});

test('refill drops file when external truncation puts readOffset past actualEnd', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'trunc', memBudget: 2, logger: silentLogger() });
	await q.enqueue('aa'); // mem
	await q.enqueue('bb'); // spill
	await q.enqueue('cc'); // spill

	const iter = q[Symbol.asyncIterator]();
	assert.equal((await iter.next()).value, 'aa');
	assert.equal((await iter.next()).value, 'bb');

	// readOffset is now 3 (past 'bb\n'). Truncate file below it.
	const fp = nodePath.join(dir, 'trunc', 'queue.jsonl');
	await fs.truncate(fp, 2);

	// Next refill: readOffset(3) >= actualEnd(2) → drop file.
	const pending = iter.next();
	await waitForWaiter(q);
	await q.destroy();
	const r = await pending;
	assert.equal(r.done, true);
});

test('destroy after writeStream error does not hang', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'hng', memBudget: 1, logger: silentLogger() });
	await q.enqueue('aa'); // opens stream
	q.writeStream.emit('error', new Error('simulated'));
	// Safety: if close path hangs, fail fast instead of hanging the whole suite.
	await Promise.race([
		q.destroy(),
		new Promise((_, reject) => setTimeout(() => reject(new Error('destroy hung')), 1000)),
	]);
});

test('iterator next() after destroy returns done', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'postd', logger: silentLogger() });
	await q.destroy();
	const iter = q[Symbol.asyncIterator]();
	const r = await iter.next();
	assert.equal(r.done, true);
});

// --- fs errors ---

test('enqueue returns false when subdir path is occupied by a file (mkdir fails)', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = new FileBackedQueue({
		dir, id: 'mkf',
		memBudget: 1,
		onDrop: (reason, size) => drops.push({ reason, size }),
		logger: silentLogger(),
	});
	// Place a file at subdir path so mkdir(recursive:true) fails with ENOTDIR/EEXIST
	await fs.writeFile(nodePath.join(dir, 'mkf'), 'blocker');
	const ok = await q.enqueue('aa'); // triggers spill path → __openWriteStream → mkdir fails
	assert.equal(ok, false);
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'fs-error');
	assert.equal(drops[0].size, 2);
	// Clean up for assertion that directory was not left broken
	await fs.rm(nodePath.join(dir, 'mkf'), { force: true });
});

test('enqueue returns false when writeStream emits error before next write', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = new FileBackedQueue({
		dir, id: 'werr',
		memBudget: 1,
		onDrop: (reason, size) => drops.push({ reason, size }),
		logger: silentLogger(),
	});
	await q.enqueue('aa'); // spill, opens stream
	q.writeStream.emit('error', new Error('simulated stream error'));
	// writeErr is now set; next enqueue should see it and fail
	const ok = await q.enqueue('bb');
	assert.equal(ok, false);
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'fs-error');
	await q.destroy();
});

test('enqueue returns false when write callback errors', async () => {
	const dir = await makeTmpDir();
	const drops = [];
	const q = new FileBackedQueue({
		dir, id: 'wcb',
		memBudget: 1,
		onDrop: (reason, size) => drops.push({ reason, size }),
		logger: silentLogger(),
	});
	await q.enqueue('aa'); // opens stream
	// Replace write to fail via cb
	q.writeStream.write = (_data, cb) => { cb(new Error('cb err')); };
	const ok = await q.enqueue('bb');
	assert.equal(ok, false);
	assert.equal(drops.length, 1);
	assert.equal(drops[0].reason, 'fs-error');
	await q.destroy();
});

// --- integration-ish: many items through spill/refill ---

test('many items round-trip through spill', async () => {
	const dir = await makeTmpDir();
	const q = new FileBackedQueue({ dir, id: 'many', memBudget: 64, logger: silentLogger() });
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
