import assert from 'node:assert/strict';
import { test, describe, beforeEach, afterEach, mock } from 'node:test';

import { PrismaSessionStore } from './prisma-session-store.js';

function createMockPrisma() {
	return {
		expressSession: {
			findUnique: mock.fn(),
			upsert: mock.fn(),
			delete: mock.fn(),
			update: mock.fn(),
			deleteMany: mock.fn(),
		},
	};
}

function cb2promise(fn) {
	return new Promise((resolve, reject) => {
		fn((err, result) => {
			if (err) reject(err);
			else resolve(result);
		});
	});
}

describe('PrismaSessionStore', () => {
	let mockPrisma;
	let store;

	beforeEach(() => {
		mockPrisma = createMockPrisma();
		store = new PrismaSessionStore(mockPrisma, { pruneInterval: 0 });
	});

	afterEach(() => {
		store.shutdown();
	});

	// --- get ---

	test('get: 返回已存在且未过期的 session', async () => {
		const sessionData = { cookie: { maxAge: 86400000 }, user: 'test' };
		mockPrisma.expressSession.findUnique.mock.mockImplementation(() =>
			Promise.resolve({
				sid: 'sid1',
				data: JSON.stringify(sessionData),
				expiresAt: new Date(Date.now() + 86400000),
			})
		);

		const result = await cb2promise((cb) => store.get('sid1', cb));
		assert.deepEqual(result, sessionData);
		assert.equal(mockPrisma.expressSession.findUnique.mock.callCount(), 1);
		assert.deepEqual(
			mockPrisma.expressSession.findUnique.mock.calls[0].arguments[0],
			{ where: { sid: 'sid1' } }
		);
	});

	test('get: 记录不存在时返回 null', async () => {
		mockPrisma.expressSession.findUnique.mock.mockImplementation(() =>
			Promise.resolve(null)
		);

		const result = await cb2promise((cb) => store.get('none', cb));
		assert.equal(result, null);
	});

	test('get: 已过期时删除并返回 null', async () => {
		mockPrisma.expressSession.findUnique.mock.mockImplementation(() =>
			Promise.resolve({
				sid: 'expired',
				data: '{}',
				expiresAt: new Date(Date.now() - 1000),
			})
		);
		mockPrisma.expressSession.delete.mock.mockImplementation(() =>
			Promise.resolve()
		);

		const result = await cb2promise((cb) => store.get('expired', cb));
		assert.equal(result, null);
		assert.equal(mockPrisma.expressSession.delete.mock.callCount(), 1);
	});

	test('get: DB 错误时回调 err', async () => {
		const dbErr = new Error('db error');
		mockPrisma.expressSession.findUnique.mock.mockImplementation(() =>
			Promise.reject(dbErr)
		);

		await assert.rejects(
			() => cb2promise((cb) => store.get('sid1', cb)),
			(err) => err === dbErr
		);
	});

	// --- set ---

	test('set: 调用 upsert 并传递正确参数', async () => {
		mockPrisma.expressSession.upsert.mock.mockImplementation(() =>
			Promise.resolve()
		);

		const session = { cookie: { maxAge: 3600000 }, foo: 'bar' };
		const before = Date.now();
		await cb2promise((cb) => store.set('sid2', session, cb));
		const after = Date.now();

		assert.equal(mockPrisma.expressSession.upsert.mock.callCount(), 1);
		const args = mockPrisma.expressSession.upsert.mock.calls[0].arguments[0];
		assert.deepEqual(args.where, { sid: 'sid2' });
		assert.equal(args.create.sid, 'sid2');
		assert.equal(args.create.data, JSON.stringify(session));
		assert.equal(args.update.data, JSON.stringify(session));

		const expiresAt = args.create.expiresAt.getTime();
		assert.ok(expiresAt >= before + 3600000);
		assert.ok(expiresAt <= after + 3600000);
	});

	test('set: cookie.maxAge 缺失时使用默认 1 天', async () => {
		mockPrisma.expressSession.upsert.mock.mockImplementation(() =>
			Promise.resolve()
		);

		const session = {};
		const before = Date.now();
		await cb2promise((cb) => store.set('sid3', session, cb));

		const args = mockPrisma.expressSession.upsert.mock.calls[0].arguments[0];
		const expiresAt = args.create.expiresAt.getTime();
		assert.ok(expiresAt >= before + 86400000 - 100);
	});

	// --- destroy ---

	test('destroy: 调用 delete', async () => {
		mockPrisma.expressSession.delete.mock.mockImplementation(() =>
			Promise.resolve()
		);

		await cb2promise((cb) => store.destroy('sid4', cb));
		assert.equal(mockPrisma.expressSession.delete.mock.callCount(), 1);
		assert.deepEqual(
			mockPrisma.expressSession.delete.mock.calls[0].arguments[0],
			{ where: { sid: 'sid4' } }
		);
	});

	test('destroy: 记录不存在（P2025）视为成功', async () => {
		const notFound = new Error('not found');
		notFound.code = 'P2025';
		mockPrisma.expressSession.delete.mock.mockImplementation(() =>
			Promise.reject(notFound)
		);

		await cb2promise((cb) => store.destroy('none', cb));
	});

	test('destroy: 其他错误正常抛出', async () => {
		const dbErr = new Error('db error');
		mockPrisma.expressSession.delete.mock.mockImplementation(() =>
			Promise.reject(dbErr)
		);

		await assert.rejects(
			() => cb2promise((cb) => store.destroy('sid5', cb)),
			(err) => err === dbErr
		);
	});

	// --- touch ---

	test('touch: 仅更新 expiresAt', async () => {
		mockPrisma.expressSession.update.mock.mockImplementation(() =>
			Promise.resolve()
		);

		const session = { cookie: { maxAge: 7200000 } };
		const before = Date.now();
		await cb2promise((cb) => store.touch('sid6', session, cb));

		assert.equal(mockPrisma.expressSession.update.mock.callCount(), 1);
		const args = mockPrisma.expressSession.update.mock.calls[0].arguments[0];
		assert.deepEqual(args.where, { sid: 'sid6' });
		const expiresAt = args.data.expiresAt.getTime();
		assert.ok(expiresAt >= before + 7200000);
	});

	test('touch: 记录不存在（P2025）视为成功', async () => {
		const notFound = new Error('not found');
		notFound.code = 'P2025';
		mockPrisma.expressSession.update.mock.mockImplementation(() =>
			Promise.reject(notFound)
		);

		await cb2promise((cb) => store.touch('none', {}, cb));
	});

	// --- prune timer ---

	test('构造时可启动清理定时器，shutdown 后停止', () => {
		const timerStore = new PrismaSessionStore(mockPrisma, { pruneInterval: 60000 });
		assert.ok(timerStore.__pruneTimer !== null);

		timerStore.shutdown();
		assert.equal(timerStore.__pruneTimer, null);
	});

	test('pruneInterval=0 时不启动定时器', () => {
		assert.equal(store.__pruneTimer, null);
	});

	test('__prune 调用 deleteMany 清理过期记录', async () => {
		mockPrisma.expressSession.deleteMany.mock.mockImplementation(() =>
			Promise.resolve({ count: 2 })
		);

		store.__prune();
		assert.equal(mockPrisma.expressSession.deleteMany.mock.callCount(), 1);
		const args = mockPrisma.expressSession.deleteMany.mock.calls[0].arguments[0];
		assert.ok(args.where.expiresAt.lt instanceof Date);
	});
});
