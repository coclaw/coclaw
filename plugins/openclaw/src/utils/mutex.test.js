import assert from 'node:assert/strict';
import test from 'node:test';

import { createMutex } from './mutex.js';

test('withLock 串行执行：并发调用按顺序完成', async () => {
	const mutex = createMutex();
	const order = [];

	const p1 = mutex.withLock(async () => {
		order.push('a-start');
		await delay(30);
		order.push('a-end');
		return 'a';
	});

	const p2 = mutex.withLock(async () => {
		order.push('b-start');
		await delay(10);
		order.push('b-end');
		return 'b';
	});

	const p3 = mutex.withLock(async () => {
		order.push('c-start');
		order.push('c-end');
		return 'c';
	});

	const results = await Promise.all([p1, p2, p3]);

	assert.deepEqual(results, ['a', 'b', 'c']);
	assert.deepEqual(order, [
		'a-start', 'a-end',
		'b-start', 'b-end',
		'c-start', 'c-end',
	]);
});

test('withLock 返回值透传', async () => {
	const mutex = createMutex();
	const result = await mutex.withLock(async () => 42);
	assert.equal(result, 42);
});

test('withLock 异常透传：fn 抛出的错误由调用侧捕获', async () => {
	const mutex = createMutex();

	await assert.rejects(
		() => mutex.withLock(async () => { throw new Error('boom'); }),
		{ message: 'boom' },
	);
});

test('withLock 异常后锁释放：后续调用不受阻塞', async () => {
	const mutex = createMutex();

	// 第一个调用失败
	await assert.rejects(
		() => mutex.withLock(async () => { throw new Error('fail'); }),
		{ message: 'fail' },
	);

	// 第二个调用应正常执行
	const result = await mutex.withLock(async () => 'ok');
	assert.equal(result, 'ok');
});

test('withLock 中间失败不影响队列中后续调用', async () => {
	const mutex = createMutex();
	const order = [];

	const p1 = mutex.withLock(async () => {
		order.push('a');
		return 'a';
	});

	const p2 = mutex.withLock(async () => {
		order.push('b');
		throw new Error('b-fail');
	});

	const p3 = mutex.withLock(async () => {
		order.push('c');
		return 'c';
	});

	const r1 = await p1;
	assert.equal(r1, 'a');

	await assert.rejects(() => p2, { message: 'b-fail' });

	const r3 = await p3;
	assert.equal(r3, 'c');

	assert.deepEqual(order, ['a', 'b', 'c']);
});

test('多个独立 mutex 互不干扰', async () => {
	const mutex1 = createMutex();
	const mutex2 = createMutex();
	const order = [];

	const p1 = mutex1.withLock(async () => {
		order.push('m1-start');
		await delay(30);
		order.push('m1-end');
	});

	const p2 = mutex2.withLock(async () => {
		order.push('m2-start');
		await delay(10);
		order.push('m2-end');
	});

	await Promise.all([p1, p2]);

	// m2 应在 m1 完成前就结束（两把锁独立）
	assert.equal(order.indexOf('m2-end') < order.indexOf('m1-end'), true);
});

test('withLock 保护 read-modify-write：并发递增不丢失', async () => {
	const mutex = createMutex();
	let counter = 0;

	// 模拟 10 个并发 read-modify-write
	const tasks = Array.from({ length: 10 }, () =>
		mutex.withLock(async () => {
			const val = counter;
			await delay(1); // 模拟异步间隙
			counter = val + 1;
		})
	);

	await Promise.all(tasks);
	assert.equal(counter, 10);
});

test('无锁保护时 read-modify-write 会丢失更新（对照测试）', async () => {
	let counter = 0;

	const tasks = Array.from({ length: 10 }, async () => {
		const val = counter;
		await delay(1);
		counter = val + 1;
	});

	await Promise.all(tasks);
	// 无锁时并发 read-modify-write 会 lost update，counter < 10
	assert.equal(counter < 10, true);
});

test('withLock 同步 fn 也能正常工作', async () => {
	const mutex = createMutex();
	const result = await mutex.withLock(() => Promise.resolve('sync-ish'));
	assert.equal(result, 'sync-ish');
});

test('withLock 支持 void fn（无返回值）', async () => {
	const mutex = createMutex();
	let called = false;
	const result = await mutex.withLock(async () => { called = true; });
	assert.equal(called, true);
	assert.equal(result, undefined);
});

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
