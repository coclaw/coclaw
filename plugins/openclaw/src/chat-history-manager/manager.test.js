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
		resolveSessionsDir: (id) => nodePath.join(rootDir, id, 'sessions'),
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

// --- recordSessionTransition ---

// T1: 首次入列（无 head）：仅写未归档头
test('recordSessionTransition - T1 首次入列，仅写未归档头', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		await mgr.load('main');
		await mgr.recordSessionTransition({
			agentId: 'main',
			sessionKey: 'agent:main:main',
			currentSessionId: 'A',
		});
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 1);
		assert.equal(history[0].sessionId, 'A');
		assert.equal(history[0].archivedAt, undefined, 'head should be unarchived');

		// 磁盘验证
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
		assert.equal(data['agent:main:main'].length, 1);
		assert.equal(data['agent:main:main'][0].sessionId, 'A');
		assert.equal(data['agent:main:main'][0].archivedAt, undefined);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// T2: hook 路径带 archivedSessionId，前任不在文件：未归档头 + 归档前任
test('recordSessionTransition - T2 空 list + 带 archivedSessionId：插入归档前任 + 头插当前', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		await mgr.recordSessionTransition({
			agentId: 'main',
			sessionKey: 'agent:main:main',
			currentSessionId: 'A',
			archivedSessionId: 'X',
		});
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 2);
		assert.equal(history[0].sessionId, 'A');
		assert.equal(history[0].archivedAt, undefined);
		assert.equal(history[1].sessionId, 'X');
		assert.ok(typeof history[1].archivedAt === 'number');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// T3: sessions.changed 路径（无 archivedSessionId）：从 head 推断前任
test('recordSessionTransition - T3 head 未归档时翻成归档，新 sid 头插', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		// 先建一个未归档头 X
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'X',
		});
		// sessions.changed 路径：只传 currentSessionId=A，head X 应被自动翻成归档
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'A',
		});
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 2);
		assert.equal(history[0].sessionId, 'A');
		assert.equal(history[0].archivedAt, undefined);
		assert.equal(history[1].sessionId, 'X');
		assert.ok(typeof history[1].archivedAt === 'number');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// T4: hook 路径，archivedSessionId 等于 head.sessionId：翻 head 为归档 + 头插新
test('recordSessionTransition - T4 archivedSessionId 等于 head：翻 head 不重复追加', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'X',
		});
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'A', archivedSessionId: 'X',
		});
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 2, 'X 应只出现一次');
		assert.equal(history[0].sessionId, 'A');
		assert.equal(history[1].sessionId, 'X');
		assert.ok(typeof history[1].archivedAt === 'number');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// T5: 幂等：head 已是 currentSessionId 时双源第二次到达 no-op
test('recordSessionTransition - T5 head 已是 current 且 archived 已在 list：完全 no-op', async () => {
	const tmpDir = await makeTmpDir();
	try {
		let writeCount = 0;
		const { mgr } = await setupManager(tmpDir, {
			writeJsonFile: async (filePath, value) => {
				writeCount++;
				const { atomicWriteJsonFile } = await import('../utils/atomic-write.js');
				return atomicWriteJsonFile(filePath, value);
			},
		});
		await mgr.load('main');
		// 先建 [A, X@arch]
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'A', archivedSessionId: 'X',
		});
		const before = writeCount;
		// 双源第二次到达：head A 仍是 current，X 已归档过
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'A', archivedSessionId: 'X',
		});
		assert.equal(writeCount, before, '幂等应不触发持久化');

		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 2);
		assert.equal(history[0].sessionId, 'A');
		assert.equal(history[1].sessionId, 'X');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// T13: 错位事件——head 已是 current 且 archivedSessionId 撞 head 自己（同一 sid 既是当前又声明为前任）
test('recordSessionTransition - T13 head 已是 current 且 archivedSessionId===head：完全 no-op', async () => {
	const tmpDir = await makeTmpDir();
	try {
		let writeCount = 0;
		const { mgr } = await setupManager(tmpDir, {
			writeJsonFile: async (filePath, value) => {
				writeCount++;
				const { atomicWriteJsonFile } = await import('../utils/atomic-write.js');
				return atomicWriteJsonFile(filePath, value);
			},
		});
		await mgr.load('main');
		// 建立 head=A（未归档）
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'A',
		});
		const before = writeCount;
		// 错位事件：current=A 同时 archivedSessionId=A
		// 期望：head 是 A 已是 current → archivedAlreadyInList=true → 分支 1 no-op，不写盘
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'A', archivedSessionId: 'A',
		});
		assert.equal(writeCount, before, '错位事件应不触发持久化');
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 1, 'list 仍只含一条 head');
		assert.equal(history[0].sessionId, 'A');
		assert.equal(history[0].archivedAt, undefined, 'A 仍是未归档头');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// T6: 双源最终一致 sessions.changed → hook：第二次能补 archivedSessionId 归档
test('recordSessionTransition - T6 sessions.changed 先到，hook 后到补 archivedSessionId', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		// 1) sessions.changed 路径：空 list + currentSessionId=A → [A]
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'A',
		});
		// 2) hook 路径：head 已是 A，但带新 archivedSessionId=X → 应在 head 后插入 X
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'A', archivedSessionId: 'X',
		});
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 2);
		assert.equal(history[0].sessionId, 'A');
		assert.equal(history[0].archivedAt, undefined, 'A 仍是未归档头');
		assert.equal(history[1].sessionId, 'X');
		assert.ok(typeof history[1].archivedAt === 'number');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// T7: 双源最终一致 hook → sessions.changed：第二次幂等 no-op
test('recordSessionTransition - T7 hook 先到，sessions.changed 后到幂等 no-op', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		// 1) hook 路径：空 list + currentSessionId=A + archivedSessionId=X → [A, X@arch]
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'A', archivedSessionId: 'X',
		});
		// 2) sessions.changed 路径：head A 已是 current → no-op
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'A',
		});
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 2);
		assert.equal(history[0].sessionId, 'A');
		assert.equal(history[1].sessionId, 'X');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// T8: archivedSessionId 与 head 不匹配（事件错位）：head 翻归档 + 追加 archivedTarget + 头插新
test('recordSessionTransition - T8 archivedSessionId 与 head 不匹配：保险不丢前任', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		// 先建 head Y（未归档）
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'Y',
		});
		// 错位事件：head 是 Y 但带 archivedSessionId=X
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'A', archivedSessionId: 'X',
		});
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 3, 'A + Y@arch + X@arch 都要在');
		assert.equal(history[0].sessionId, 'A');
		assert.equal(history[0].archivedAt, undefined);
		assert.equal(history[1].sessionId, 'Y');
		assert.ok(typeof history[1].archivedAt === 'number');
		assert.equal(history[2].sessionId, 'X');
		assert.ok(typeof history[2].archivedAt === 'number');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// T9: 缺 currentSessionId → return（无副作用）
test('recordSessionTransition - T9 缺 currentSessionId 时跳过', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', archivedSessionId: 'X',
		});
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: '',
		});
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.deepStrictEqual(history, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// T10: 缺 sessionKey → return
test('recordSessionTransition - T10 缺 sessionKey 时跳过', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: '', currentSessionId: 'A',
		});
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.deepStrictEqual(history, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// T11: 老数据迁移：磁盘全是归档 item，head 是归档项 → 仅 unshift currentSessionId
test('recordSessionTransition - T11 老数据迁移：head 已归档，仅头插 + dedupe archivedSessionId', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		// 模拟老版本磁盘数据：全部已归档
		await fs.writeFile(filePath, JSON.stringify({
			version: 1,
			'agent:main:main': [
				{ sessionId: 'X', archivedAt: 1000 },
				{ sessionId: 'Y', archivedAt: 500 },
			],
		}));
		// 新事件到达：currentSessionId=A，archivedSessionId=X（X 已在 list 中）
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'A', archivedSessionId: 'X',
		});
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 3, '仅头插 A，X 已存在不重复');
		assert.equal(history[0].sessionId, 'A');
		assert.equal(history[1].sessionId, 'X');
		assert.equal(history[1].archivedAt, 1000, 'X 的归档时间应保持原值');
		assert.equal(history[2].sessionId, 'Y');
		assert.equal(history[2].archivedAt, 500);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// T12: 并发 5 次不同 currentSessionId：mutex 串行化，5 个 sid 全部存在
test('recordSessionTransition - T12 并发多个 transition 全部串行入列', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		await mgr.load('main');
		const ids = ['A', 'B', 'C', 'D', 'E'];
		await Promise.all(ids.map((id) =>
			mgr.recordSessionTransition({
				agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: id,
			}),
		));
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 5, '5 个 sid 全部存在');
		const seen = new Set(history.map((r) => r.sessionId));
		for (const id of ids) {
			assert.ok(seen.has(id), `${id} 应存在`);
		}
		// 末位 head 未归档，其余已归档
		assert.equal(history[0].archivedAt, undefined);
		for (let i = 1; i < history.length; i++) {
			assert.ok(typeof history[i].archivedAt === 'number');
		}
		// 磁盘验证
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
		assert.equal(data['agent:main:main'].length, 5);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// --- list / 自动 lazy load ---

test('list - 未 load 的 agentId 会先从磁盘加载', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const rootDir = nodePath.join(tmpDir, 'agents');
		await fs.mkdir(nodePath.join(rootDir, 'lazy', 'sessions'), { recursive: true });
		const filePath = nodePath.join(rootDir, 'lazy', 'sessions', 'coclaw-chat-history.json');
		await fs.writeFile(filePath, JSON.stringify({
			version: 1,
			'agent:lazy:main': [{ sessionId: 'from-disk', archivedAt: 1000 }],
		}));
		const mgr = new ChatHistoryManager({ resolveSessionsDir: (id) => nodePath.join(rootDir, id, 'sessions'), logger: silentLogger });
		const { history } = await mgr.list({ agentId: 'lazy', sessionKey: 'agent:lazy:main' });
		assert.equal(history.length, 1);
		assert.equal(history[0].sessionId, 'from-disk');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('recordSessionTransition - 未 load 的 agentId 自动从磁盘加载（不抛错）', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const rootDir = nodePath.join(tmpDir, 'agents');
		await fs.mkdir(nodePath.join(rootDir, 'lazy', 'sessions'), { recursive: true });
		const mgr = new ChatHistoryManager({ resolveSessionsDir: (id) => nodePath.join(rootDir, id, 'sessions'), logger: silentLogger });
		await mgr.recordSessionTransition({
			agentId: 'lazy', sessionKey: 'agent:lazy:main', currentSessionId: 'sid-1',
		});
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
		const mgr = new ChatHistoryManager({ resolveSessionsDir: (id) => nodePath.join(rootDir, id, 'sessions'), logger: silentLogger });
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

// --- 多 sessionKey / 多 agentId 隔离 ---

test('recordSessionTransition - 不同 sessionKey 隔离', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'sid-a',
		});
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:telegram:123', currentSessionId: 'sid-b',
		});

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

test('多 agentId 隔离', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const rootDir = nodePath.join(tmpDir, 'agents');
		await fs.mkdir(nodePath.join(rootDir, 'main', 'sessions'), { recursive: true });
		await fs.mkdir(nodePath.join(rootDir, 'tester', 'sessions'), { recursive: true });
		const mgr = new ChatHistoryManager({ resolveSessionsDir: (id) => nodePath.join(rootDir, id, 'sessions'), logger: silentLogger });
		await mgr.load('main');
		await mgr.load('tester');
		await mgr.recordSessionTransition({ agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'sid-m' });
		await mgr.recordSessionTransition({ agentId: 'tester', sessionKey: 'agent:tester:main', currentSessionId: 'sid-t' });

		assert.equal((await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' })).history.length, 1);
		assert.equal((await mgr.list({ agentId: 'tester', sessionKey: 'agent:tester:main' })).history.length, 1);
		assert.equal((await mgr.list({ agentId: 'main', sessionKey: 'agent:tester:main' })).history.length, 0);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// --- 并发安全性 ---

test('并发 recordSessionTransition 不丢失记录（mutex 串行化）', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		await mgr.load('main');

		const N = 20;
		const promises = Array.from({ length: N }, (_, i) =>
			mgr.recordSessionTransition({
				agentId: 'main',
				sessionKey: 'agent:main:main',
				currentSessionId: `sid-${i}`,
			}),
		);
		await Promise.all(promises);

		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, N);
		const ids = new Set(history.map((r) => r.sessionId));
		assert.equal(ids.size, N);

		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
		assert.equal(data['agent:main:main'].length, N);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('并发 recordSessionTransition 到不同 sessionKey 不互相阻塞', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');

		const promises = [];
		for (let i = 0; i < 10; i++) {
			promises.push(
				mgr.recordSessionTransition({ agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: `a-${i}` }),
				mgr.recordSessionTransition({ agentId: 'main', sessionKey: 'agent:main:telegram:123', currentSessionId: `b-${i}` }),
			);
		}
		await Promise.all(promises);

		assert.equal((await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' })).history.length, 10);
		assert.equal((await mgr.list({ agentId: 'main', sessionKey: 'agent:main:telegram:123' })).history.length, 10);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('慢写入场景下并发 recordSessionTransition 仍保持完整性', async () => {
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
			mgr.recordSessionTransition({
				agentId: 'main',
				sessionKey: 'agent:main:main',
				currentSessionId: `sid-${i}`,
			}),
		);
		await Promise.all(promises);

		assert.equal((await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' })).history.length, N);
		assert.equal(writeCount, N, 'each transition should trigger one write');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('list() 在 recordSessionTransition 写盘期间覆写缓存不导致数据丢失', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir, {
			writeJsonFile: async (filePath, value) => {
				await new Promise((r) => setTimeout(r, 20));
				const { atomicWriteJsonFile } = await import('../utils/atomic-write.js');
				return atomicWriteJsonFile(filePath, value);
			},
		});
		await mgr.load('main');

		await mgr.recordSessionTransition({ agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'sid-A' });
		await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		await mgr.recordSessionTransition({ agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'sid-B' });

		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 2, 'both records should survive');
		const ids = history.map((r) => r.sessionId);
		assert.ok(ids.includes('sid-A'), 'sid-A should be present');
		assert.ok(ids.includes('sid-B'), 'sid-B should be present');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// === 默认构造（不注入 resolveSessionsDir）端到端 ===
test('默认构造：通过 setRuntime 端到端落盘到 <state-dir>/agents/main/sessions/', async () => {
	const { setRuntime } = await import('../runtime.js');
	const tmpStateDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'chat-hist-rt-'));
	try {
		setRuntime({ state: { resolveStateDir: () => tmpStateDir } });
		await fs.mkdir(nodePath.join(tmpStateDir, 'agents', 'main', 'sessions'), { recursive: true });

		const mgr = new ChatHistoryManager({ logger: silentLogger });
		await mgr.load('main');
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'current-1', archivedSessionId: 'orphan-1',
		});

		const expectedFile = nodePath.join(tmpStateDir, 'agents', 'main', 'sessions', 'coclaw-chat-history.json');
		const raw = await fs.readFile(expectedFile, 'utf8');
		const parsed = JSON.parse(raw);
		assert.equal(parsed.version, 1);
		assert.equal(parsed['agent:main:main'].length, 2);
		assert.equal(parsed['agent:main:main'][0].sessionId, 'current-1');
		assert.equal(parsed['agent:main:main'][0].archivedAt, undefined);
		assert.equal(parsed['agent:main:main'][1].sessionId, 'orphan-1');
		assert.ok(typeof parsed['agent:main:main'][1].archivedAt === 'number');
	} finally {
		setRuntime(null);
		await fs.rm(tmpStateDir, { recursive: true, force: true });
	}
});
