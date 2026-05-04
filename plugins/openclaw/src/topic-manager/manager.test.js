import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { TopicManager } from './manager.js';

async function makeTmpDir() {
	return fs.mkdtemp(nodePath.join(os.tmpdir(), 'topic-mgr-test-'));
}

async function setupManager(tmpDir, extraOpts = {}) {
	const rootDir = nodePath.join(tmpDir, 'agents');
	await fs.mkdir(nodePath.join(rootDir, 'main', 'sessions'), { recursive: true });
	const mgr = new TopicManager({
		resolveSessionsDir: (id) => nodePath.join(rootDir, id, 'sessions'),
		logger: { info() {}, warn() {}, error() {} },
		...extraOpts,
	});
	return { mgr, rootDir };
}

test('load - 文件不存在时初始化空数据', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		const { topics } = mgr.list({ agentId: 'main' });
		assert.deepStrictEqual(topics, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('load - 从磁盘恢复已有数据', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-topics.json');
		const existing = {
			version: 1,
			topics: [{ topicId: 'aaa', agentId: 'main', title: 'Test', createdAt: 1000 }],
		};
		await fs.writeFile(filePath, JSON.stringify(existing));
		await mgr.load('main');
		const { topics } = mgr.list({ agentId: 'main' });
		assert.equal(topics.length, 1);
		assert.equal(topics[0].topicId, 'aaa');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('load - 文件内容无效时回退到空数据', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-topics.json');
		await fs.writeFile(filePath, 'not json');
		await mgr.load('main');
		const { topics } = mgr.list({ agentId: 'main' });
		assert.deepStrictEqual(topics, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('load - 文件格式合法但缺少 topics 数组时回退空数据', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-topics.json');
		await fs.writeFile(filePath, JSON.stringify({ version: 1 }));
		await mgr.load('main');
		const { topics } = mgr.list({ agentId: 'main' });
		assert.deepStrictEqual(topics, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('create - 创建 topic 并持久化', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		await mgr.load('main');
		const { topicId } = await mgr.create({ agentId: 'main' });
		assert.ok(typeof topicId === 'string' && topicId.length > 0);

		// 验证内存
		const { topics } = mgr.list({ agentId: 'main' });
		assert.equal(topics.length, 1);
		assert.equal(topics[0].topicId, topicId);
		assert.equal(topics[0].agentId, 'main');
		assert.equal(topics[0].title, null);
		assert.ok(typeof topics[0].createdAt === 'number');

		// 验证磁盘
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-topics.json');
		const raw = await fs.readFile(filePath, 'utf8');
		const data = JSON.parse(raw);
		assert.equal(data.topics.length, 1);
		assert.equal(data.topics[0].topicId, topicId);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('create - 新 topic 插入数组头部', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		const { topicId: id1 } = await mgr.create({ agentId: 'main' });
		const { topicId: id2 } = await mgr.create({ agentId: 'main' });
		const { topics } = mgr.list({ agentId: 'main' });
		assert.equal(topics.length, 2);
		assert.equal(topics[0].topicId, id2); // 最新的在前
		assert.equal(topics[1].topicId, id1);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('get - 查找存在的 topic', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		const { topicId } = await mgr.create({ agentId: 'main' });
		const { topic } = mgr.get({ topicId });
		assert.ok(topic);
		assert.equal(topic.topicId, topicId);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('get - 不存在的 topicId 返回 null', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		const { topic } = mgr.get({ topicId: 'nonexistent' });
		assert.equal(topic, null);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('updateTitle - 更新标题并持久化', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		await mgr.load('main');
		const { topicId } = await mgr.create({ agentId: 'main' });
		await mgr.updateTitle({ topicId, title: '新标题' });

		const { topic } = mgr.get({ topicId });
		assert.equal(topic.title, '新标题');

		// 验证磁盘
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-topics.json');
		const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
		assert.equal(data.topics[0].title, '新标题');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('updateTitle - topic 不存在时抛出错误', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		await assert.rejects(
			() => mgr.updateTitle({ topicId: 'nonexistent', title: 'x' }),
			/Topic not found/,
		);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('updateTitle - 并发场景下 mutex 内 topic 已被删除', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		const { topicId } = await mgr.create({ agentId: 'main' });
		// 锁内删除 topic 模拟竞态
		const store = mgr.__cache.get('main');
		// 记录 agentId 匹配以通过外层检查
		// 然后在锁获取后清空
		const updatePromise = mgr.updateTitle({ topicId, title: 'x' });
		// 在 mutex 外清空（下次 withLock 执行时找不到）
		store.topics.length = 0;
		await assert.rejects(updatePromise, /Topic not found/);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('delete - 删除 topic 及 .jsonl 文件', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		await mgr.load('main');
		const { topicId } = await mgr.create({ agentId: 'main' });
		// 创建模拟 .jsonl 文件
		const jsonlPath = nodePath.join(rootDir, 'main', 'sessions', `${topicId}.jsonl`);
		await fs.writeFile(jsonlPath, '{"type":"header"}\n');

		const result = await mgr.delete({ topicId });
		assert.deepStrictEqual(result, { ok: true });

		// 验证内存
		const { topics } = mgr.list({ agentId: 'main' });
		assert.equal(topics.length, 0);

		// 验证 .jsonl 已删除
		await assert.rejects(fs.access(jsonlPath), { code: 'ENOENT' });
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('delete - .jsonl 不存在时不报错', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		const { topicId } = await mgr.create({ agentId: 'main' });
		const result = await mgr.delete({ topicId });
		assert.deepStrictEqual(result, { ok: true });
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('delete - 不存在的 topicId 返回 ok: false', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		const result = await mgr.delete({ topicId: 'nonexistent' });
		assert.deepStrictEqual(result, { ok: false });
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('delete - unlink 非 ENOENT 错误应抛出', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir, {
			unlinkFile: async () => {
				const err = new Error('permission denied');
				err.code = 'EACCES';
				throw err;
			},
		});
		await mgr.load('main');
		const { topicId } = await mgr.create({ agentId: 'main' });
		await assert.rejects(() => mgr.delete({ topicId }), { code: 'EACCES' });
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('copyTranscript - 复制 .jsonl 为临时文件', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		await mgr.load('main');
		const { topicId } = await mgr.create({ agentId: 'main' });
		const jsonlPath = nodePath.join(rootDir, 'main', 'sessions', `${topicId}.jsonl`);
		await fs.writeFile(jsonlPath, '{"type":"header"}\n{"type":"message"}\n');

		const { tempId, tempPath } = await mgr.copyTranscript({ agentId: 'main', topicId });
		assert.ok(typeof tempId === 'string');
		assert.ok(tempPath.endsWith('.jsonl'));
		const content = await fs.readFile(tempPath, 'utf8');
		assert.equal(content, '{"type":"header"}\n{"type":"message"}\n');

		// 清理
		await mgr.cleanupTempFile(tempPath);
		await assert.rejects(fs.access(tempPath), { code: 'ENOENT' });
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('cleanupTempFile - 文件不存在时不报错', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		// 不抛出
		await mgr.cleanupTempFile('/tmp/nonexistent-file.jsonl');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('cleanupTempFile - 非 ENOENT 错误应抛出', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir, {
			unlinkFile: async () => {
				const err = new Error('permission denied');
				err.code = 'EACCES';
				throw err;
			},
		});
		await assert.rejects(() => mgr.cleanupTempFile('/tmp/file.jsonl'), { code: 'EACCES' });
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('list/get - 未 load 的 agentId 抛出错误', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		assert.throws(
			() => mgr.list({ agentId: 'unloaded' }),
			/not loaded/,
		);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// --- load 去重测试 ---

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
		// 再次 load 应跳过（已在 cache 中）
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
				// 模拟慢 I/O
				await new Promise((r) => setTimeout(r, 50));
				return fs.readFile(path, enc);
			},
		});
		// 并发发起多个 load
		await Promise.all([
			mgr.load('main'),
			mgr.load('main'),
			mgr.load('main'),
		]);
		assert.equal(readCount, 1, 'concurrent loads should share one read');
		const { topics } = mgr.list({ agentId: 'main' });
		assert.deepStrictEqual(topics, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// --- 并发安全性测试 ---

test('并发 create 不丢失 topic（mutex 串行化）', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');

		// 并发创建 20 个 topic
		const N = 20;
		const promises = Array.from({ length: N }, () => mgr.create({ agentId: 'main' }));
		const results = await Promise.all(promises);

		// 所有 topicId 都不同
		const ids = results.map((r) => r.topicId);
		assert.equal(new Set(ids).size, N, 'all topicIds should be unique');

		// 内存中有 N 个 topic
		const { topics } = mgr.list({ agentId: 'main' });
		assert.equal(topics.length, N);

		// 磁盘上也有 N 个
		const filePath = nodePath.join(tmpDir, 'agents', 'main', 'sessions', 'coclaw-topics.json');
		const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
		assert.equal(data.topics.length, N);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('并发 create + delete 不损坏数据', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');

		// 先创建 10 个
		const created = [];
		for (let i = 0; i < 10; i++) {
			created.push(await mgr.create({ agentId: 'main' }));
		}

		// 并发：创建 10 个新的 + 删除前 5 个旧的
		const createPromises = Array.from({ length: 10 }, () => mgr.create({ agentId: 'main' }));
		const deletePromises = created.slice(0, 5).map((c) => mgr.delete({ topicId: c.topicId }));
		await Promise.all([...createPromises, ...deletePromises]);

		const { topics } = mgr.list({ agentId: 'main' });
		// 10 初始 - 5 删除 + 10 新建 = 15
		assert.equal(topics.length, 15);

		// 被删除的不应存在
		for (const d of created.slice(0, 5)) {
			assert.equal(mgr.get({ topicId: d.topicId }).topic, null);
		}
		// 未删除的应仍存在
		for (const d of created.slice(5)) {
			assert.ok(mgr.get({ topicId: d.topicId }).topic);
		}
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('并发 updateTitle 不互相覆盖（各更新各的）', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');

		const t1 = await mgr.create({ agentId: 'main' });
		const t2 = await mgr.create({ agentId: 'main' });
		const t3 = await mgr.create({ agentId: 'main' });

		// 并发更新三个不同 topic 的标题
		await Promise.all([
			mgr.updateTitle({ topicId: t1.topicId, title: '标题1' }),
			mgr.updateTitle({ topicId: t2.topicId, title: '标题2' }),
			mgr.updateTitle({ topicId: t3.topicId, title: '标题3' }),
		]);

		assert.equal(mgr.get({ topicId: t1.topicId }).topic.title, '标题1');
		assert.equal(mgr.get({ topicId: t2.topicId }).topic.title, '标题2');
		assert.equal(mgr.get({ topicId: t3.topicId }).topic.title, '标题3');

		// 验证磁盘一致性
		const filePath = nodePath.join(tmpDir, 'agents', 'main', 'sessions', 'coclaw-topics.json');
		const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
		const diskT1 = data.topics.find((t) => t.topicId === t1.topicId);
		const diskT2 = data.topics.find((t) => t.topicId === t2.topicId);
		assert.equal(diskT1.title, '标题1');
		assert.equal(diskT2.title, '标题2');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('慢写入场景下并发 create 仍保持完整性', async () => {
	const tmpDir = await makeTmpDir();
	try {
		// 注入慢 writeJsonFile 模拟磁盘延迟
		let writeCount = 0;
		const { mgr } = await setupManager(tmpDir, {
			writeJsonFile: async (filePath, value) => {
				writeCount++;
				// 随机延迟 0-10ms
				await new Promise((r) => setTimeout(r, Math.random() * 10));
				const { atomicWriteJsonFile } = await import('../utils/atomic-write.js');
				return atomicWriteJsonFile(filePath, value);
			},
		});
		await mgr.load('main');

		const N = 15;
		const promises = Array.from({ length: N }, () => mgr.create({ agentId: 'main' }));
		await Promise.all(promises);

		assert.equal(mgr.list({ agentId: 'main' }).topics.length, N);
		assert.equal(writeCount, N, 'each create should trigger one write');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('多 agentId 隔离', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const rootDir = nodePath.join(tmpDir, 'agents');
		await fs.mkdir(nodePath.join(rootDir, 'main', 'sessions'), { recursive: true });
		await fs.mkdir(nodePath.join(rootDir, 'agent2', 'sessions'), { recursive: true });
		const mgr = new TopicManager({
			resolveSessionsDir: (id) => nodePath.join(rootDir, id, 'sessions'),
			logger: { info() {}, warn() {}, error() {} },
		});
		await mgr.load('main');
		await mgr.load('agent2');
		await mgr.create({ agentId: 'main' });
		await mgr.create({ agentId: 'agent2' });
		assert.equal(mgr.list({ agentId: 'main' }).topics.length, 1);
		assert.equal(mgr.list({ agentId: 'agent2' }).topics.length, 1);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// === 默认构造（不注入 resolveSessionsDir）端到端 ===
// 验证：通过 setRuntime 注入 state.resolveStateDir，TopicManager 不传 opts 时
// 走 claw-paths.agentSessionsDir → 文件落到 <state-dir>/agents/<id>/sessions/coclaw-topics.json

test('默认构造：通过 setRuntime 端到端落盘到 <state-dir>/agents/main/sessions/', async () => {
	const { setRuntime } = await import('../runtime.js');
	const tmpStateDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'topic-mgr-rt-'));
	try {
		setRuntime({ state: { resolveStateDir: () => tmpStateDir } });
		// 必要的目录由生产代码 atomicWriteJsonFile 之前创建——这里手动准备父目录
		await fs.mkdir(nodePath.join(tmpStateDir, 'agents', 'main', 'sessions'), { recursive: true });

		const mgr = new TopicManager({ logger: { info() {}, warn() {}, error() {} } });
		await mgr.load('main');
		const { topicId } = await mgr.create({ agentId: 'main' });

		const expectedFile = nodePath.join(tmpStateDir, 'agents', 'main', 'sessions', 'coclaw-topics.json');
		const raw = await fs.readFile(expectedFile, 'utf8');
		const parsed = JSON.parse(raw);
		assert.equal(parsed.topics.length, 1);
		assert.equal(parsed.topics[0].topicId, topicId);
	} finally {
		setRuntime(null);
		await fs.rm(tmpStateDir, { recursive: true, force: true });
	}
});
