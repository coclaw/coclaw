import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { ChatHistoryManager } from './manager.js';

const silentLogger = { info() {}, warn() {}, error() {} };

async function makeTmpDir() {
	return fs.mkdtemp(nodePath.join(os.tmpdir(), 'chat-history-test-'));
}

async function setupManager(tmpDir, extraOpts = {}) {
	const rootDir = nodePath.join(tmpDir, 'agents');
	await fs.mkdir(nodePath.join(rootDir, 'main', 'sessions'), { recursive: true });
	const mgr = new ChatHistoryManager({
		rootDir,
		logger: silentLogger,
		...extraOpts,
	});
	return { mgr, rootDir };
}

// --- load ---

test('load - 文件不存在时初始化空数据', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.deepStrictEqual(history, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('load - 从磁盘恢复已有数据', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		const existing = {
			version: 1,
			'agent:main:main': [
				{ sessionId: 'sid-1', archivedAt: 1000 },
			],
		};
		await fs.writeFile(filePath, JSON.stringify(existing));
		await mgr.load('main');
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 1);
		assert.equal(history[0].sessionId, 'sid-1');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('load - 文件内容无效时回退到空数据', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		await fs.writeFile(filePath, 'not json');
		await mgr.load('main');
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.deepStrictEqual(history, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('load - 缺少 version 字段时回退空数据', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		await fs.writeFile(filePath, JSON.stringify({ noVersion: true }));
		await mgr.load('main');
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.deepStrictEqual(history, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('load - 已加载时跳过重复 load', async () => {
	const tmpDir = await makeTmpDir();
	try {
		let readCount = 0;
		const { mgr } = await setupManager(tmpDir, {
			readFile: async (path, enc) => {
				readCount++;
				return fs.readFile(path, enc);
			},
		});
		await mgr.load('main');
		assert.equal(readCount, 1);
		await mgr.load('main');
		assert.equal(readCount, 1, 'second load should skip');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('load - 并发 load 复用同一 Promise', async () => {
	const tmpDir = await makeTmpDir();
	try {
		let readCount = 0;
		const { mgr } = await setupManager(tmpDir, {
			readFile: async (path, enc) => {
				readCount++;
				await new Promise((r) => setTimeout(r, 50));
				return fs.readFile(path, enc);
			},
		});
		await Promise.all([
			mgr.load('main'),
			mgr.load('main'),
			mgr.load('main'),
		]);
		assert.equal(readCount, 1, 'concurrent loads should share one read');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// --- recordArchived ---

test('recordArchived - 记录孤儿 session 并持久化', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		await mgr.load('main');
		await mgr.recordArchived({
			agentId: 'main',
			sessionKey: 'agent:main:main',
			sessionId: 'sid-old',
		});

		// 内存验证
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 1);
		assert.equal(history[0].sessionId, 'sid-old');
		assert.ok(typeof history[0].archivedAt === 'number');

		// 磁盘验证
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
		assert.equal(data['agent:main:main'].length, 1);
		assert.equal(data['agent:main:main'][0].sessionId, 'sid-old');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('recordArchived - 新记录插入头部（最近的在前）', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		await mgr.recordArchived({ agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'sid-1' });
		await mgr.recordArchived({ agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'sid-2' });
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 2);
		assert.equal(history[0].sessionId, 'sid-2'); // 最近的在前
		assert.equal(history[1].sessionId, 'sid-1');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('recordArchived - 去重（同一 sessionId 不重复记录）', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		await mgr.recordArchived({ agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'sid-1' });
		await mgr.recordArchived({ agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'sid-1' });
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 1);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('recordArchived - 空 sessionKey 或 sessionId 时跳过', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		await mgr.recordArchived({ agentId: 'main', sessionKey: '', sessionId: 'sid-1' });
		await mgr.recordArchived({ agentId: 'main', sessionKey: 'agent:main:main', sessionId: '' });
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.deepStrictEqual(history, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('recordArchived - 不同 sessionKey 隔离', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		await mgr.recordArchived({ agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'sid-a' });
		await mgr.recordArchived({ agentId: 'main', sessionKey: 'agent:main:telegram:123', sessionId: 'sid-b' });

		const { history: h1 } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		const { history: h2 } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:telegram:123' });
		assert.equal(h1.length, 1);
		assert.equal(h1[0].sessionId, 'sid-a');
		assert.equal(h2.length, 1);
		assert.equal(h2[0].sessionId, 'sid-b');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// --- list ---

test('list - 未 load 的 agentId 会先从磁盘加载', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const rootDir = nodePath.join(tmpDir, 'agents');
		await fs.mkdir(nodePath.join(rootDir, 'lazy', 'sessions'), { recursive: true });
		// 在磁盘上预写数据
		const filePath = nodePath.join(rootDir, 'lazy', 'sessions', 'coclaw-chat-history.json');
		await fs.writeFile(filePath, JSON.stringify({
			version: 1,
			'agent:lazy:main': [{ sessionId: 'from-disk', archivedAt: 1000 }],
		}));
		const mgr = new ChatHistoryManager({ rootDir, logger: silentLogger });
		// 不调用 load，直接 list，应从磁盘加载
		const { history } = await mgr.list({ agentId: 'lazy', sessionKey: 'agent:lazy:main' });
		assert.equal(history.length, 1);
		assert.equal(history[0].sessionId, 'from-disk');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('recordArchived - 未 load 的 agentId 自动从磁盘加载（不抛错）', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const rootDir = nodePath.join(tmpDir, 'agents');
		await fs.mkdir(nodePath.join(rootDir, 'lazy', 'sessions'), { recursive: true });
		const mgr = new ChatHistoryManager({ rootDir, logger: silentLogger });
		// 不调用 load，直接 recordArchived
		await mgr.recordArchived({ agentId: 'lazy', sessionKey: 'agent:lazy:main', sessionId: 'sid-1' });
		const { history } = await mgr.list({ agentId: 'lazy', sessionKey: 'agent:lazy:main' });
		assert.equal(history.length, 1);
		assert.equal(history[0].sessionId, 'sid-1');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('list - 未 load 且无磁盘文件时初始化空数据', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const rootDir = nodePath.join(tmpDir, 'agents');
		await fs.mkdir(nodePath.join(rootDir, 'empty-agent', 'sessions'), { recursive: true });
		const mgr = new ChatHistoryManager({ rootDir, logger: silentLogger });
		// 不 load，直接 list
		const { history } = await mgr.list({ agentId: 'empty-agent', sessionKey: 'agent:empty-agent:main' });
		assert.deepStrictEqual(history, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('list - 不存在的 sessionKey 返回空数组', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:nonexistent' });
		assert.deepStrictEqual(history, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// --- 多 agentId 隔离 ---

test('多 agentId 隔离', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const rootDir = nodePath.join(tmpDir, 'agents');
		await fs.mkdir(nodePath.join(rootDir, 'main', 'sessions'), { recursive: true });
		await fs.mkdir(nodePath.join(rootDir, 'tester', 'sessions'), { recursive: true });
		const mgr = new ChatHistoryManager({ rootDir, logger: silentLogger });
		await mgr.load('main');
		await mgr.load('tester');
		await mgr.recordArchived({ agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'sid-m' });
		await mgr.recordArchived({ agentId: 'tester', sessionKey: 'agent:tester:main', sessionId: 'sid-t' });

		assert.equal((await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' })).history.length, 1);
		assert.equal((await mgr.list({ agentId: 'tester', sessionKey: 'agent:tester:main' })).history.length, 1);
		// 互不影响
		assert.equal((await mgr.list({ agentId: 'main', sessionKey: 'agent:tester:main' })).history.length, 0);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// --- 并发安全性 ---

test('并发 recordArchived 不丢失记录（mutex 串行化）', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		await mgr.load('main');

		const N = 20;
		const promises = Array.from({ length: N }, (_, i) =>
			mgr.recordArchived({
				agentId: 'main',
				sessionKey: 'agent:main:main',
				sessionId: `sid-${i}`,
			}),
		);
		await Promise.all(promises);

		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, N);

		// 所有 sessionId 都存在
		const ids = new Set(history.map((r) => r.sessionId));
		assert.equal(ids.size, N);

		// 磁盘验证
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
		assert.equal(data['agent:main:main'].length, N);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('并发 recordArchived 到不同 sessionKey 不互相阻塞', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');

		const promises = [];
		for (let i = 0; i < 10; i++) {
			promises.push(
				mgr.recordArchived({ agentId: 'main', sessionKey: 'agent:main:main', sessionId: `a-${i}` }),
				mgr.recordArchived({ agentId: 'main', sessionKey: 'agent:main:telegram:123', sessionId: `b-${i}` }),
			);
		}
		await Promise.all(promises);

		assert.equal((await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' })).history.length, 10);
		assert.equal((await mgr.list({ agentId: 'main', sessionKey: 'agent:main:telegram:123' })).history.length, 10);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('慢写入场景下并发 recordArchived 仍保持完整性', async () => {
	const tmpDir = await makeTmpDir();
	try {
		let writeCount = 0;
		const { mgr } = await setupManager(tmpDir, {
			writeJsonFile: async (filePath, value) => {
				writeCount++;
				await new Promise((r) => setTimeout(r, Math.random() * 10));
				const { atomicWriteJsonFile } = await import('../utils/atomic-write.js');
				return atomicWriteJsonFile(filePath, value);
			},
		});
		await mgr.load('main');

		const N = 15;
		const promises = Array.from({ length: N }, (_, i) =>
			mgr.recordArchived({
				agentId: 'main',
				sessionKey: 'agent:main:main',
				sessionId: `sid-${i}`,
			}),
		);
		await Promise.all(promises);

		assert.equal((await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' })).history.length, N);
		assert.equal(writeCount, N, 'each record should trigger one write');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('list() 在 recordArchived 写盘期间覆写缓存不导致数据丢失', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir, {
			writeJsonFile: async (filePath, value) => {
				// 写盘前让出事件循环，模拟 list() 在此期间插入
				await new Promise((r) => setTimeout(r, 20));
				const { atomicWriteJsonFile } = await import('../utils/atomic-write.js');
				return atomicWriteJsonFile(filePath, value);
			},
		});
		await mgr.load('main');

		// 第 1 次写入
		await mgr.recordArchived({ agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'sid-A' });

		// list() 从磁盘重载（此时磁盘有 sid-A），会覆写缓存
		await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });

		// 第 2 次写入——若不在 lock 内 reload，会基于 list() 的缓存（可能过期）写盘
		await mgr.recordArchived({ agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'sid-B' });

		// 两条记录都应存在
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 2, 'both records should survive');
		const ids = history.map((r) => r.sessionId);
		assert.ok(ids.includes('sid-A'), 'sid-A should be present');
		assert.ok(ids.includes('sid-B'), 'sid-B should be present');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});
