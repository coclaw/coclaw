import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { ChatHistoryManager, classifyChatHistorySessionKey } from './manager.js';
import { __reset as __resetRemoteLog, __buffer as __remoteLogBuf } from '../remote-log.js';

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

// T14: stale 事件防御——currentSessionId 已是 list 第二位（已归档），晚到的事件应被丢弃
test('recordSessionTransition - T14 stale 事件：currentSessionId 已在 list 其他位置应整体丢弃', async () => {
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
		// 建立 [S3, S2@arch]：用户连续 reset A→S2→S3
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'S2',
		});
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'S3',
		});
		const before = writeCount;
		// stale 事件：晚到的旧 transition 仍说 current=S2（S2 已被归档至 list[1]）
		// 期望：直接丢弃，不动 head S3，不让 S2 重复
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'S2', archivedSessionId: 'S1',
		});
		assert.equal(writeCount, before, 'stale 事件应不触发持久化');
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 2, 'list 仍是 [S3, S2@arch]');
		assert.equal(history[0].sessionId, 'S3');
		assert.equal(history[0].archivedAt, undefined, 'S3 仍是未归档头');
		assert.equal(history[1].sessionId, 'S2');
		assert.ok(typeof history[1].archivedAt === 'number');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// REPRO_LOST_ARCHIVED: A→B→C 快速连翻，sessions.changed 两条先到、session_start hook 两条后到。
// 第三条 hook (current=B, archived=A) 命中 stale 防御 → 直接 return，**A 这段从未被记录**。
// 即便冷启动 UI 也看不到 A。预期：list 应为 [C, B@arch, A@arch]；实际：list = [C, B@arch]。
// SKIP：双源 race 的更深问题，独立于 cron-eviction 止血任务；见 TODO.md 同名条目，根因修复时 unskip。
test('recordSessionTransition - REPRO 双源乱序：A→B→C 快速连翻，stale 防御吞掉 A 的归档信号', { skip: 'REPRO of double-source A→B→C race; out of scope for cron-eviction stop-bleed; see TODO.md' }, async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		// 1) B 的 sessions.changed 先到（不带 archivedSessionId） → [B]
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'B',
		});
		// 2) C 的 sessions.changed 再到（不带 archivedSessionId） → [C, B@arch]
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'C',
		});
		// 3) B 的 hook 此时才到，带 archivedSessionId=A → stale 防御命中 → return → A 丢了
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'B', archivedSessionId: 'A',
		});
		// 4) C 的 hook 最后到，带 archivedSessionId=B → no-op
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'C', archivedSessionId: 'B',
		});
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		// 期望：A、B、C 都在
		const ids = history.map((r) => r.sessionId);
		assert.ok(ids.includes('A'), `A 应在 list 中（实际：${JSON.stringify(ids)}）`);
		assert.ok(ids.includes('B'), 'B 应在 list 中');
		assert.ok(ids.includes('C'), 'C 应在 list 中');
		assert.equal(history.length, 3, 'list 应为 [C, B@arch, A@arch]');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// T15: archivedSessionId === currentSessionId 异常输入（上游契约异常），归一化丢弃避免双份
test('recordSessionTransition - T15 archivedSessionId 等于 currentSessionId：丢弃 archived 入参 + 打 remoteLog 暴露异常信号', async () => {
	const tmpDir = await makeTmpDir();
	__resetRemoteLog();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		// 空 list 起手 + archivedSessionId === currentSessionId
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'A', archivedSessionId: 'A',
		});
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 1, 'list 应仅含一项（未归档头）');
		assert.equal(history[0].sessionId, 'A');
		assert.equal(history[0].archivedAt, undefined, 'A 是未归档头，不应同时出现归档副本');
		// 归一化路径应打 remoteLog 暴露上游异常信号（不静默吃掉）
		const logs = __remoteLogBuf.filter((r) => r.text.startsWith('chat-history.archived-equals-current'));
		assert.equal(logs.length, 1, '应打一条 archived-equals-current remoteLog');
		assert.match(logs[0].text, /sessionKey=agent:main:main/);
		assert.match(logs[0].text, /sid=A/);
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
test('recordSessionTransition - T7 hook 先到，sessions.changed 后到幂等 no-op（且不重复写盘）', async () => {
	const tmpDir = await makeTmpDir();
	try {
		let writeCount = 0;
		const rootDir = nodePath.join(tmpDir, 'agents');
		await fs.mkdir(nodePath.join(rootDir, 'main', 'sessions'), { recursive: true });
		const mgr = new ChatHistoryManager({
			resolveSessionsDir: (id) => nodePath.join(rootDir, id, 'sessions'),
			logger: silentLogger,
			writeJsonFile: async (path, data) => {
				writeCount += 1;
				await fs.writeFile(path, JSON.stringify(data));
			},
		});
		await mgr.load('main');
		// 1) hook 路径：空 list + currentSessionId=A + archivedSessionId=X → [A, X@arch]
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'A', archivedSessionId: 'X',
		});
		const writeCountAfterHook = writeCount;
		// 2) sessions.changed 路径：head A 已是 current → no-op
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'A',
		});
		assert.equal(writeCount, writeCountAfterHook, '第二条幂等 no-op 不应触发写盘');
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
		const { mgr, rootDir } = await setupManager(tmpDir);
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
		// 直接读磁盘存储顺序（insertion order），与 list() 的展示排序解耦：本用例验证
		// recordSessionTransition 的插入语义（翻 head + splice 前任 + 头插），不验证 list()
		// 的归档段降序展示——Y/X 在同一次操作内归档、archivedAt 近乎相等，list 的相对序由
		// Date.now() 抢占决定，不应在此断言。
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		const list = JSON.parse(await fs.readFile(filePath, 'utf8'))['agent:main:main'];
		assert.equal(list.length, 3, 'A + Y@arch + X@arch 都要在');
		assert.equal(list[0].sessionId, 'A');
		assert.equal(list[0].archivedAt, undefined);
		assert.equal(list[1].sessionId, 'Y');
		assert.ok(typeof list[1].archivedAt === 'number');
		assert.equal(list[2].sessionId, 'X');
		assert.ok(typeof list[2].archivedAt === 'number');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// T8b: splice 位置判别——list 长度 ≥ 2 + new archivedSessionId + head 未归档
// 让 splice(1, 0, x) 与 push(x) mutation 在结果顺序上可区分；
// 现有 T6/T8 都在 splice 时 list 长度为 1（splice 等价于 push）测不到顺序错位。
test('recordSessionTransition - T8b 一般路径 splice 位置（list≥2 fixture，捕获 splice→push 漂移）', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		await mgr.load('main');
		// 1) 起手 hook 路径建 [A, X@arch]：head=A 未归档，X 在位置 1 归档
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'A', archivedSessionId: 'X',
		});
		// 2) 一般路径触发：current=B，archivedSessionId=Z（新值，不在 list 且 != head.sessionId=A）
		//    预期：翻 A 为 archived → splice(1, 0, Z@arch) → unshift(B)
		//    splice 落点正确：[B, A@arch, Z@arch, X@arch]
		//    若 mutation 改成 push(Z@arch)：[B, A@arch, X@arch, Z@arch] —— Z 位置错位
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'B', archivedSessionId: 'Z',
		});
		// 读磁盘存储顺序断言 splice 落点：本用例验证 splice→push 漂移，是 recordSessionTransition
		// 的插入语义；list() 的归档段降序展示会按 archivedAt 重排、掩盖 splice 落点，故必须读原始存储。
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		const list = JSON.parse(await fs.readFile(filePath, 'utf8'))['agent:main:main'];
		assert.equal(list.length, 4, 'list 应为 4 项');
		assert.equal(list[0].sessionId, 'B');
		assert.equal(list[0].archivedAt, undefined, 'B 是新 head 未归档');
		assert.equal(list[1].sessionId, 'A', 'A 应在第二位（前任头翻归档）');
		assert.ok(typeof list[1].archivedAt === 'number');
		assert.equal(list[2].sessionId, 'Z', 'Z 应在第三位（splice 插入位置）');
		assert.ok(typeof list[2].archivedAt === 'number');
		assert.equal(list[3].sessionId, 'X', 'X 应在末位（更早的历史）');
		assert.ok(typeof list[3].archivedAt === 'number');
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

// --- __sanitizeAllSessionKeys 守卫（__persist 内置；写盘前自愈非头位未归档项） ---

test('sanitize - list[1..] 非末位有 unarchived → 强制 archive + warn + remoteLog', async () => {
	const tmpDir = await makeTmpDir();
	__resetRemoteLog();
	const warns = [];
	try {
		const { mgr, rootDir } = await setupManager(tmpDir, {
			logger: { info() {}, warn: (m) => warns.push(String(m)), error() {} },
		});
		// 预置一份脏数据：list = [head, mid (unarchived), tail (archived)]
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		const dirty = {
			version: 1,
			'agent:main:main': [
				{ sessionId: 'head' },
				{ sessionId: 'mid' }, // 非头位但缺 archivedAt → 脏
				{ sessionId: 'tail', archivedAt: 1000 },
			],
		};
		await fs.writeFile(filePath, JSON.stringify(dirty));
		await mgr.load('main');
		// 触发任一次 record（即便 noop 路径，最终若有写盘也会走 __persist；这里通过
		// 一次会写盘的 transition 触发 sanitize）：unshift 新 head 'new'，老 head→archived
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'new',
		});
		const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
		const list = parsed['agent:main:main'];
		// 新结构：[new, head@arch, mid@arch, tail@1000]
		assert.equal(list.length, 4);
		assert.equal(list[0].sessionId, 'new');
		assert.equal(list[0].archivedAt, undefined, '新 head 不应被 sanitize 误归档');
		assert.equal(list[1].sessionId, 'head');
		assert.ok(typeof list[1].archivedAt === 'number');
		assert.equal(list[2].sessionId, 'mid');
		assert.ok(typeof list[2].archivedAt === 'number', 'sanitize 应补上 mid.archivedAt');
		assert.equal(list[3].sessionId, 'tail');
		assert.equal(list[3].archivedAt, 1000, 'tail 已有 archivedAt 不应被覆写');
		// warn + remoteLog 必须各打一条
		const sanitizeWarns = warns.filter((m) => m.includes('chat-history sanitize'));
		assert.equal(sanitizeWarns.length, 1, '应打一条 sanitize warn');
		assert.match(sanitizeWarns[0], /sid=mid/);
		const remoteLogs = __remoteLogBuf.filter((r) => r.text.startsWith('chat-history.sanitize-coerce'));
		assert.equal(remoteLogs.length, 1);
		assert.match(remoteLogs[0].text, /sid=mid/);
		assert.match(remoteLogs[0].text, /agentId=main/);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('sanitize - list[1..] 全 archived → noop（不 warn 不 remoteLog）', async () => {
	const tmpDir = await makeTmpDir();
	__resetRemoteLog();
	const warns = [];
	try {
		const { mgr, rootDir } = await setupManager(tmpDir, {
			logger: { info() {}, warn: (m) => warns.push(String(m)), error() {} },
		});
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		await fs.writeFile(filePath, JSON.stringify({
			version: 1,
			'agent:main:main': [
				{ sessionId: 'head' },
				{ sessionId: 'a', archivedAt: 1000 },
				{ sessionId: 'b', archivedAt: 2000 },
			],
		}));
		await mgr.load('main');
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'new',
		});
		// sanitize 应不动 a/b 的 archivedAt
		const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
		const list = parsed['agent:main:main'];
		assert.equal(list[2].archivedAt, 1000);
		assert.equal(list[3].archivedAt, 2000);
		assert.equal(warns.filter((m) => m.includes('chat-history sanitize')).length, 0);
		assert.equal(
			__remoteLogBuf.filter((r) => r.text.startsWith('chat-history.sanitize-coerce')).length, 0,
		);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('sanitize - list 仅一项（末位 unarchived）→ noop', async () => {
	const tmpDir = await makeTmpDir();
	__resetRemoteLog();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'A',
		});
		// 此时 list = [A]（未归档头位 + 没有 list[1..]）
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 1);
		assert.equal(history[0].sessionId, 'A');
		assert.equal(history[0].archivedAt, undefined, '单项 list 头位不应被 sanitize');
		assert.equal(
			__remoteLogBuf.filter((r) => r.text.startsWith('chat-history.sanitize-coerce')).length, 0,
		);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// --- reconcileAll：启动期对账 ---

test('reconcileAll - entries 中 sessionKey 头位与 currentSessionId 不一致 → 触发 transition（cron 顶替场景）', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		// 预置 head = A（cron 顶替前主会话）
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'A',
		});
		// 启动期发现 sessions.json 主会话已是 B（cron 顶替后） → 对账应翻 A 为 archived + 头插 B
		await mgr.reconcileAll('main', [
			{ sessionKey: 'agent:main:main', sessionId: 'B' },
		]);
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 2);
		assert.equal(history[0].sessionId, 'B');
		assert.equal(history[0].archivedAt, undefined, 'B 是新头位');
		assert.equal(history[1].sessionId, 'A');
		assert.ok(typeof history[1].archivedAt === 'number', 'A 应被归档');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('reconcileAll - entries 中头位 sid 与 currentSessionId 一致 → noop（幂等）', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		const writes = [];
		const wrappedMgr = new ChatHistoryManager({
			resolveSessionsDir: (id) => nodePath.join(rootDir, id, 'sessions'),
			logger: silentLogger,
			writeJsonFile: async (p, data) => {
				writes.push(p);
				await fs.writeFile(p, JSON.stringify(data));
			},
		});
		void mgr;
		await wrappedMgr.load('main');
		await wrappedMgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'A',
		});
		const writeCountBefore = writes.length;
		// 对账时 sessions.json 还是 A，与 head 一致 → 整体 no-op，不写盘
		await wrappedMgr.reconcileAll('main', [
			{ sessionKey: 'agent:main:main', sessionId: 'A' },
		]);
		assert.equal(writes.length, writeCountBefore, '幂等对账不应触发新写盘');
		// 仍只有一条记录
		const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
		assert.equal(parsed['agent:main:main'].length, 1);
		assert.equal(parsed['agent:main:main'][0].sessionId, 'A');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('reconcileAll - entries 非数组 / 空 → 静默忽略', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		await mgr.reconcileAll('main', undefined);
		await mgr.reconcileAll('main', null);
		await mgr.reconcileAll('main', []);
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.deepStrictEqual(history, []);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// 真实场景：用户笔记本 chat-history 38 段全带 archivedAt、无头位（5-16 backfill 脚本只追加 archived 项）
// 启动对账拿到 sessions.json 当前 sid (即 cron 顶进来的新 sid) 后，应把它头插，archived 历史段不动
test('reconcileAll - 全 archived 无头位（用户 backfill 现状）→ 头插新 sid 不动旧 archived', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		// 预置：list 全 archived，无未归档头位
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		await fs.writeFile(filePath, JSON.stringify({
			version: 1,
			'agent:main:main': [
				{ sessionId: 'sid-a', archivedAt: 3000 },
				{ sessionId: 'sid-b', archivedAt: 2000 },
				{ sessionId: 'sid-c', archivedAt: 1000 },
			],
		}));
		await mgr.load('main');
		await mgr.reconcileAll('main', [
			{ sessionKey: 'agent:main:main', sessionId: 'sid-new' },
		]);
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 4, '新 sid 头插，老 archived 不动');
		assert.equal(history[0].sessionId, 'sid-new');
		assert.equal(history[0].archivedAt, undefined, 'sid-new 是新头位');
		assert.equal(history[1].sessionId, 'sid-a');
		assert.equal(history[1].archivedAt, 3000, 'sid-a 时间戳保持');
		assert.equal(history[2].sessionId, 'sid-b');
		assert.equal(history[2].archivedAt, 2000);
		assert.equal(history[3].sessionId, 'sid-c');
		assert.equal(history[3].archivedAt, 1000);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// 并发：启动对账 fire-and-forget 跑的同时，cron_changed hook 也喂入新 sid。
// 两路同时进 recordSessionTransition，期望最终只一条新头位、无重复段且只写一次。
test('reconcileAll - 启动对账与并发事件路径喂入相同新 sid → 幂等，无重复段且只写一次新转换', async () => {
	const tmpDir = await makeTmpDir();
	try {
		let writeCount = 0;
		const rootDir = nodePath.join(tmpDir, 'agents');
		await fs.mkdir(nodePath.join(rootDir, 'main', 'sessions'), { recursive: true });
		const mgr = new ChatHistoryManager({
			resolveSessionsDir: (id) => nodePath.join(rootDir, id, 'sessions'),
			logger: silentLogger,
			writeJsonFile: async (path, data) => {
				writeCount += 1;
				await fs.writeFile(path, JSON.stringify(data));
			},
		});
		await mgr.load('main');
		// 预置老头位
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'sid-old',
		});
		const writesBefore = writeCount;
		// 启动对账 + 并发事件路径都喂新 sid（模拟两路同时到）
		await Promise.all([
			mgr.reconcileAll('main', [{ sessionKey: 'agent:main:main', sessionId: 'sid-new' }]),
			mgr.recordSessionTransition({
				agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'sid-new',
			}),
		]);
		assert.equal(writeCount - writesBefore, 1, '两路并发对同一 sid 转换只应触发一次写盘（另一路 head 已 current → no-op）');
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 2, '应该是 [sid-new, sid-old@arch]，不应重复段');
		assert.equal(history[0].sessionId, 'sid-new');
		assert.equal(history[0].archivedAt, undefined);
		assert.equal(history[1].sessionId, 'sid-old');
		assert.ok(typeof history[1].archivedAt === 'number');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// sanitize 不应误改"已归档 head"（如 backfill 数据：所有项含 archivedAt 包括首位）
test('sanitize - head 自带 archivedAt（backfill 数据）→ 不动 head 不打 warn', async () => {
	const tmpDir = await makeTmpDir();
	__resetRemoteLog();
	const warns = [];
	try {
		const { mgr, rootDir } = await setupManager(tmpDir, {
			logger: { info() {}, warn: (m) => warns.push(String(m)), error() {} },
		});
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		// 预置：head 也带 archivedAt（backfill 后的状态），后续 list[1..] 也全 archived
		await fs.writeFile(filePath, JSON.stringify({
			version: 1,
			'agent:main:main': [
				{ sessionId: 'sid-head', archivedAt: 5000 },
				{ sessionId: 'sid-mid', archivedAt: 3000 },
			],
		}));
		await mgr.load('main');
		// 触发写盘走 sanitize：reconcileAll 喂入新 sid 头插（这次会触发 __persist）
		await mgr.reconcileAll('main', [{ sessionKey: 'agent:main:main', sessionId: 'sid-new' }]);
		const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
		const list = parsed['agent:main:main'];
		// 新 head=sid-new，老 head=sid-head 保留 archivedAt=5000（不被 sanitize 覆盖）
		const headFound = list.find((it) => it.sessionId === 'sid-head');
		assert.equal(headFound.archivedAt, 5000, 'sid-head 已有 archivedAt 不应被 sanitize 覆盖');
		assert.equal(warns.filter((m) => m.includes('chat-history sanitize')).length, 0);
		assert.equal(
			__remoteLogBuf.filter((r) => r.text.startsWith('chat-history.sanitize-coerce')).length, 0,
		);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// sanitize 多 sessionKey 同时 dirty：__sanitizeAllSessionKeys 是全 store 扫描，应每个 sessionKey 都修
test('sanitize - 多 sessionKey 同时有非头位脏项 → 每个 sessionKey 都被修复', async () => {
	const tmpDir = await makeTmpDir();
	__resetRemoteLog();
	const warns = [];
	try {
		const { mgr, rootDir } = await setupManager(tmpDir, {
			logger: { info() {}, warn: (m) => warns.push(String(m)), error() {} },
		});
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		await fs.writeFile(filePath, JSON.stringify({
			version: 1,
			'agent:main:main': [
				{ sessionId: 'h1' },
				{ sessionId: 'd1' }, // dirty
			],
			'agent:tester:main': [
				{ sessionId: 'h2' },
				{ sessionId: 'd2' }, // dirty
			],
		}));
		await mgr.load('main');
		// 触发写盘
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: 'new-h1',
		});
		const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
		// 两个 sessionKey 的 dirty 项都应被补 archivedAt
		const d1 = parsed['agent:main:main'].find((it) => it.sessionId === 'd1');
		const d2 = parsed['agent:tester:main'].find((it) => it.sessionId === 'd2');
		assert.ok(typeof d1.archivedAt === 'number', 'd1 应被 sanitize 补 archivedAt');
		assert.ok(typeof d2.archivedAt === 'number', 'd2 应被 sanitize 补 archivedAt');
		const sanitizeWarns = warns.filter((m) => m.includes('chat-history sanitize'));
		assert.equal(sanitizeWarns.length, 2, '两条 sessionKey 应各打一条 sanitize warn');
		const remoteLogs = __remoteLogBuf.filter((r) => r.text.startsWith('chat-history.sanitize-coerce'));
		assert.equal(remoteLogs.length, 2);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// 单条 entry 写盘抛错时应被 catch 隔离，后续 entry 仍执行；caller 不被影响
test('reconcileAll - 单条 entry recordSessionTransition 抛错 → 隔离 + 后续仍执行', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const rootDir = nodePath.join(tmpDir, 'agents');
		await fs.mkdir(nodePath.join(rootDir, 'main', 'sessions'), { recursive: true });
		const warns = [];
		let callCount = 0;
		// 第一次写盘抛错（模拟磁盘故障），其余正常
		const mgr = new ChatHistoryManager({
			resolveSessionsDir: (id) => nodePath.join(rootDir, id, 'sessions'),
			logger: { info() {}, warn: (m) => warns.push(String(m)), error() {} },
			writeJsonFile: async (path, data) => {
				callCount += 1;
				if (callCount === 1) throw new Error('simulated disk fault');
				await fs.writeFile(path, JSON.stringify(data));
			},
		});
		await mgr.load('main');
		await mgr.reconcileAll('main', [
			{ sessionKey: 'agent:main:main', sessionId: 'A' }, // 第一条会抛
			{ sessionKey: 'agent:main:other', sessionId: 'B' }, // 第二条应成功
		]);
		// warn 必须打一条 reconcile entry failed
		const failWarns = warns.filter((m) => m.includes('chat-history reconcile entry failed'));
		assert.equal(failWarns.length, 1, '抛错条目应打 warn');
		assert.match(failWarns[0], /sessionKey=agent:main:main/);
		assert.match(failWarns[0], /simulated disk fault/);
		// 第二条应成功落盘
		const { history: otherHist } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:other' });
		assert.equal(otherHist.length, 1);
		assert.equal(otherHist[0].sessionId, 'B');
		// 关键：失败的第一条不应残留——磁盘上 agent:main:main 永远没写出去
		const { history: mainHist } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(mainHist.length, 0, '失败 entry 不应残留到磁盘（写盘抛错时内存脏数据被后续 reload 覆盖）');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('reconcileAll - entries 含非法行 → 跳过非法、合法行仍生效', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		await mgr.reconcileAll('main', [
			null,
			'not-an-object',
			{ sessionKey: 'agent:main:main' }, // 缺 sessionId → recordSessionTransition 内部早返
			{ sessionId: 'no-sk' }, // 缺 sessionKey → 内部早返
			{ sessionKey: 'agent:main:main', sessionId: 'X' }, // 合法
		]);
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 1);
		assert.equal(history[0].sessionId, 'X');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// --- recordSessionTransition 入参类型校验 (B1) ---

test('recordSessionTransition - currentSessionId 非字符串（object/number）→ 不写盘静默拒绝', async () => {
	const tmpDir = await makeTmpDir();
	try {
		let writeCount = 0;
		const { mgr } = await setupManager(tmpDir, {
			writeJsonFile: async () => { writeCount += 1; },
		});
		await mgr.load('main');
		for (const bad of [{ bad: true }, 123, [], true]) {
			await mgr.recordSessionTransition({
				agentId: 'main', sessionKey: 'agent:main:main', currentSessionId: bad,
			});
		}
		assert.equal(writeCount, 0, '非字符串 sessionId 不应触发写盘');
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 0, '非字符串 sessionId 不应留下任何 entry');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

test('recordSessionTransition - archivedSessionId 非字符串 → 视作未提供，仅头插 currentSessionId', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir);
		await mgr.load('main');
		await mgr.recordSessionTransition({
			agentId: 'main', sessionKey: 'agent:main:main',
			currentSessionId: 'A', archivedSessionId: { bad: true },
		});
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 1, '只剩头位 A，非字符串 archived 被丢弃');
		assert.equal(history[0].sessionId, 'A');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// --- classifyChatHistorySessionKey 独立单测 (B2 + 其他形态) ---

test('classifyChatHistorySessionKey - 合法主会话 / 非 agent 前缀 / 自定义 → ok=true', () => {
	assert.deepStrictEqual(classifyChatHistorySessionKey('agent:main:main'), { ok: true, reason: null });
	assert.deepStrictEqual(classifyChatHistorySessionKey('agent:tester:dashboard:abc'), { ok: true, reason: null });
	assert.deepStrictEqual(classifyChatHistorySessionKey('custom:not-agent'), { ok: true, reason: null });
});

test('classifyChatHistorySessionKey - explicit / subagent / cron 跳过', () => {
	assert.equal(classifyChatHistorySessionKey('agent:main:explicit:uuid').reason, 'explicit');
	assert.equal(classifyChatHistorySessionKey('agent:main:subagent:uuid').reason, 'subagent');
	assert.equal(classifyChatHistorySessionKey('agent:main:cron:job1:run:s1').reason, 'cron');
});

test('classifyChatHistorySessionKey - IM per-account DM accountId="cron" → 不应误判为 cron', () => {
	// 上游 schema：agent:<id>:<channel>:<accountId>:direct:<peerId>（routing/session-key.ts:196）
	// accountId 仅按 [a-z0-9_-]{1,64} 正则校验，"cron" 完全合法。
	// 上游 isCronSessionKey 只在 rest 起始处（即 parts[2]）匹配 cron，守卫必须与之对齐。
	const res = classifyChatHistorySessionKey('agent:main:telegram:cron:direct:user1');
	assert.equal(res.ok, true, 'IM DM accountId="cron" 应被识别为合法 chat');
});

test('classifyChatHistorySessionKey - IM per-account DM accountId="subagent" → 不应误判为 subagent', () => {
	// 与 cron 同源问题：上游 isSubagentSessionKey 也只在 rest 起始处匹配 subagent:，
	// 守卫不能用 indexOf 过宽匹配。
	const res = classifyChatHistorySessionKey('agent:main:telegram:subagent:direct:user1');
	assert.equal(res.ok, true, 'IM DM accountId="subagent" 应被识别为合法 chat');
});

test('classifyChatHistorySessionKey - 嵌套 cron:<jobId>:subagent:... → 由 cron 守卫挡住', () => {
	// cron 跑出的 subagent，上游 isSubagentSessionKey 对该形态返回 false（rest 起始不是 subagent:），
	// 由 cron 守卫捕获即可——避免与上游 subagent 概念冲突。
	const res = classifyChatHistorySessionKey('agent:main:cron:job1:subagent:foo');
	assert.deepStrictEqual(res, { ok: false, reason: 'cron' });
});

test('classifyChatHistorySessionKey - 非字符串 / 空串 / null → ok=false reason=null', () => {
	assert.deepStrictEqual(classifyChatHistorySessionKey(undefined), { ok: false, reason: null });
	assert.deepStrictEqual(classifyChatHistorySessionKey(null), { ok: false, reason: null });
	assert.deepStrictEqual(classifyChatHistorySessionKey(''), { ok: false, reason: null });
	assert.deepStrictEqual(classifyChatHistorySessionKey(123), { ok: false, reason: null });
});

// --- list() 已归档段排序（按 archivedAt 降序，活跃头钉首） ---

const ids = (history) => history.map((r) => r.sessionId);

// L1: 乱序合法 archivedAt → 已归档段重排为新→旧（杀「根本没排」变异）
test('list - 已归档段按 archivedAt 降序重排（乱序合法值）', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		await fs.writeFile(filePath, JSON.stringify({
			version: 1,
			'agent:main:main': [
				{ sessionId: 'head' }, // 活跃头：archivedAt undefined
				{ sessionId: 'old', archivedAt: 1000 },
				{ sessionId: 'new', archivedAt: 3000 },
				{ sessionId: 'mid', archivedAt: 2000 },
			],
		}));
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history[0].sessionId, 'head');
		assert.equal(history[0].archivedAt, undefined, '活跃头 archivedAt 仍是 undefined');
		assert.deepStrictEqual(ids(history.slice(1)), ['new', 'mid', 'old'], '归档段应新→旧');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// L2: 活跃头（archivedAt undefined）始终 index 0，不被卷进排序（杀「整数组一起 sort」变异）
test('list - 活跃头钉死 index 0，不参与归档段排序', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		await fs.writeFile(filePath, JSON.stringify({
			version: 1,
			'agent:main:main': [
				{ sessionId: 'head' }, // archivedAt undefined → 应居首
				{ sessionId: 'a', archivedAt: 5000 },
				{ sessionId: 'b', archivedAt: 1000 },
				{ sessionId: 'c', archivedAt: 9000 },
			],
		}));
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history[0].sessionId, 'head', '活跃头必须在 index 0');
		assert.equal(history[0].archivedAt, undefined);
		assert.deepStrictEqual(ids(history.slice(1)), ['c', 'a', 'b'], '归档段按 9000>5000>1000 降序');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// L3: NaN/字符串/对象/Infinity 等坏 archivedAt 不崩、沉到最旧端、length 不变（杀比较器变异）。
// NaN/Infinity 无法经 JSON 落盘（会变 null），故直接注入 cache + 让 readFile ENOENT 保留 cache。
test('list - 坏 archivedAt（NaN/字符串/对象/Infinity）沉底、不污染、不崩', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr } = await setupManager(tmpDir, {
			readFile: async () => { const e = new Error('no file'); e.code = 'ENOENT'; throw e; },
		});
		mgr.__cache.set('main', {
			version: 1,
			'agent:main:main': [
				{ sessionId: 'head' },
				{ sessionId: 'good1', archivedAt: 2000 },
				{ sessionId: 'badNaN', archivedAt: NaN },
				{ sessionId: 'badStr', archivedAt: 'abc' },
				{ sessionId: 'badObj', archivedAt: {} },
				{ sessionId: 'badInf', archivedAt: Infinity },
				{ sessionId: 'good2', archivedAt: 5000 },
			],
		});
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 7, 'length 不变');
		assert.equal(history[0].sessionId, 'head');
		assert.equal(history[1].sessionId, 'good2', '合法降序：5000 在前');
		assert.equal(history[2].sessionId, 'good1', '合法降序：2000 次之');
		// 坏值全部沉到末尾（保持 filter 原序），且合法值都在它们之前
		assert.deepStrictEqual(ids(history.slice(3)), ['badNaN', 'badStr', 'badObj', 'badInf']);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// L4: 老数据的数字串 archivedAt 仍被尊重（钉死 Number(x) 取舍）
test('list - 数字串 archivedAt 被尊重（Number 解析）', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		await fs.writeFile(filePath, JSON.stringify({
			version: 1,
			'agent:main:main': [
				{ sessionId: 'head' },
				{ sessionId: 'older', archivedAt: 1600000000000 },
				{ sessionId: 'newerStr', archivedAt: '1700000000000' }, // 数字串，应被尊重排更前
			],
		}));
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.deepStrictEqual(ids(history.slice(1)), ['newerStr', 'older'], '数字串 1.7e12 > 数字 1.6e12');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// L5: list 返回新数组、不原地排序污染 cache（杀原地 sort 变异）
test('list - 返回新数组，cache 内部数组保持磁盘原序不被原地排序', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		await fs.writeFile(filePath, JSON.stringify({
			version: 1,
			'agent:main:main': [
				{ sessionId: 'head' },
				{ sessionId: 'a', archivedAt: 1000 },
				{ sessionId: 'b', archivedAt: 3000 },
				{ sessionId: 'c', archivedAt: 2000 },
			],
		}));
		const first = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.deepStrictEqual(ids(first.history.slice(1)), ['b', 'c', 'a'], '首次输出已排序');
		// 返回的是新数组 ≠ cache 引用；cache 内部数组保持磁盘原序
		const cached = mgr.__cache.get('main')['agent:main:main'];
		assert.notEqual(cached, first.history, 'list 应返回新数组而非 cache 引用');
		assert.deepStrictEqual(ids(cached), ['head', 'a', 'b', 'c'], 'cache 数组应保磁盘原序，未被原地 sort');
		// 改动第一次结果不应影响第二次
		first.history.reverse();
		first.history.push({ sessionId: 'junk' });
		const second = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(second.history[0].sessionId, 'head');
		assert.deepStrictEqual(ids(second.history.slice(1)), ['b', 'c', 'a'], '第二次仍为正确序');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

// L6: 脏元素（null / 非对象）不崩、原样保留——恢复旧版透传容忍度（杀「filter 谓词去掉可选链」变异）
test('list - 数组含 null/非对象脏元素时不抛、原样保留、合法项仍降序', async () => {
	const tmpDir = await makeTmpDir();
	try {
		const { mgr, rootDir } = await setupManager(tmpDir);
		const filePath = nodePath.join(rootDir, 'main', 'sessions', 'coclaw-chat-history.json');
		// null / 数字 42 都能经 JSON 落盘并存活；混入合法头与两条合法归档
		await fs.writeFile(filePath, JSON.stringify({
			version: 1,
			'agent:main:main': [
				{ sessionId: 'head' },
				null,
				{ sessionId: 'old', archivedAt: 1000 },
				42,
				{ sessionId: 'new', archivedAt: 3000 },
			],
		}));
		const { history } = await mgr.list({ agentId: 'main', sessionKey: 'agent:main:main' });
		assert.equal(history.length, 5, '脏元素不被丢弃，length 不变');
		// 脏元素落 heads 段、原序保留（head, null, 42）
		assert.equal(history[0].sessionId, 'head');
		assert.equal(history[1], null, 'null 元素原样保留在输出里');
		assert.equal(history[2], 42, '非对象元素原样保留');
		// 合法归档段仍按 archivedAt 降序
		assert.equal(history[3].sessionId, 'new');
		assert.equal(history[4].sessionId, 'old');
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});
