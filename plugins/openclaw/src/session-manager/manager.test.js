import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { createSessionManager } from './manager.js';

test('listAll should dedup by sessionId and prioritize live over reset', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	await fs.writeFile(
		nodePath.join(sessionsDir, 's1.jsonl'),
		'{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hello from live"}]}}\n',
		'utf8',
	);
	await fs.writeFile(
		nodePath.join(sessionsDir, 's1.jsonl.reset.2026-02-26T12-50-04.126Z'),
		'{"type":"message","message":{"role":"user","content":[{"type":"text","text":"reset session first user message"}]}}\n',
		'utf8',
	);
	await fs.writeFile(nodePath.join(sessionsDir, 's2.jsonl'), '{"role":"assistant"}\n', 'utf8');
	await fs.writeFile(nodePath.join(sessionsDir, 's3.jsonl.reset.2026-02-26T12-50-04.126Z'), '{"role":"assistant"}\n', 'utf8');
	await fs.writeFile(nodePath.join(sessionsDir, 's4.jsonl.deleted.2026-02-26T12-50-04.126Z'), '{"role":"assistant"}\n', 'utf8');
	await fs.writeFile(nodePath.join(sessionsDir, 's5.jsonl.delete.2026-02-26T12-50-04.126Z'), '{"role":"assistant"}\n', 'utf8');
	await fs.writeFile(nodePath.join(sessionsDir, 'sessions.json'), JSON.stringify({ key1: { sessionId: 's1' } }), 'utf8');

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.listAll({});
	assert.equal(res.total, 3);
	assert.equal(res.items.length > 0, true);
	assert.equal(res.items.some((it) => it.sessionId === 's1' && it.indexed === true && it.archiveType === 'live'), true);
	assert.equal(res.items.some((it) => it.sessionId === 's2' && it.indexed === false && it.archiveType === 'live'), true);
	assert.equal(res.items.some((it) => it.sessionId === 's3' && it.indexed === false && it.archiveType === 'reset'), true);
	assert.equal(res.items.some((it) => it.sessionId === 's4'), false);
	assert.equal(res.items.some((it) => it.sessionId === 's5'), false);
});

test('get should prioritize live transcript over reset and guard missing session', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	await fs.writeFile(nodePath.join(sessionsDir, 'x1.jsonl'), '{"from":"live"}\n', 'utf8');
	await fs.writeFile(nodePath.join(sessionsDir, 'x1.jsonl.reset.2026-02-26T12-50-04.126Z'), '{"from":"reset-new"}\nnot-json\n', 'utf8');
	await fs.writeFile(nodePath.join(sessionsDir, 'x1.jsonl.reset.2026-02-25T12-50-04.126Z'), '{"from":"reset-old"}\n', 'utf8');
	const warns = [];
	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn: (msg) => warns.push(String(msg)) } });
	const res = await manager.get({ sessionId: 'x1', limit: 10, cursor: 0 });
	assert.equal(res.total, 1);
	assert.equal(res.messages.length, 1);
	assert.equal(res.messages[0].from, 'live');

	// 仅有 reset 文件时应回退到 reset（含 bad json 行警告）
	await fs.unlink(nodePath.join(sessionsDir, 'x1.jsonl'));
	const res2 = await manager.get({ sessionId: 'x1', limit: 10, cursor: 0 });
	assert.equal(res2.messages[0].from, 'reset-new');
	assert.equal(warns.length > 0, true);

	await assert.rejects(manager.get({}), /sessionId required/);
	const missing = await manager.get({ sessionId: 'missing' });
	assert.equal(missing.total, 0);
	assert.equal(missing.messages.length, 0);
	assert.equal(missing.sessionId, 'missing');
});

test('listAll/get should normalize bad inputs and missing dirs', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });

	const list = await manager.listAll({
		agentId: ' ',
		limit: -10,
		cursor: -1,
	});
	assert.equal(list.agentId, 'main');
	assert.equal(list.total, 0);
	assert.equal(list.nextCursor, null);

	await fs.mkdir(nodePath.join(root, 'a1', 'sessions'), { recursive: true });
	await fs.writeFile(nodePath.join(root, 'a1', 'sessions', 's1.jsonl'), '{"x":1}\n', 'utf8');
	const list2 = await manager.listAll({ agentId: 'a1', limit: 9999, cursor: 0 });
	assert.equal(list2.items.length, 1);

	const get1 = await manager.get({ agentId: 'a1', sessionId: 's1', limit: 0, cursor: 9999 });
	assert.equal(get1.messages.length, 0);
	assert.equal(get1.nextCursor, null);
});

test('listAll should include indexed sessions without transcript files', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	// s1 有 transcript 文件且被索引
	await fs.writeFile(
		nodePath.join(sessionsDir, 's1.jsonl'),
		'{"type":"message","message":{"role":"user","content":"hello"}}\n',
		'utf8',
	);
	// s2 仅在 sessions.json 中，无 transcript 文件（如 reset 后未对话）
	await fs.writeFile(
		nodePath.join(sessionsDir, 'sessions.json'),
		JSON.stringify({
			'agent:main:main': { sessionId: 's2', updatedAt: Date.now() },
			key1: { sessionId: 's1' },
		}),
		'utf8',
	);

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.listAll({});

	assert.equal(res.total, 2);
	const s1 = res.items.find((it) => it.sessionId === 's1');
	const s2 = res.items.find((it) => it.sessionId === 's2');
	assert.ok(s1, 's1 should be in list');
	assert.equal(s1.indexed, true);
	assert.ok(s2, 's2 (no transcript) should be in list');
	assert.equal(s2.indexed, true);
	assert.equal(s2.sessionKey, 'agent:main:main');
	assert.equal(s2.fileName, null);
	assert.equal(s2.size, 0);
});

test('get should handle CRLF line endings in JSONL files', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	// 模拟 Windows 风格的 CRLF 换行
	await fs.writeFile(
		nodePath.join(sessionsDir, 'crlf.jsonl'),
		'{"type":"message","message":{"role":"user","content":"hello"}}\r\n{"type":"message","message":{"role":"assistant","content":"hi"}}\r\n',
		'utf8',
	);

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.get({ sessionId: 'crlf' });
	assert.equal(res.total, 2);
	assert.equal(res.messages[0].type, 'message');
	assert.equal(res.messages[0].message.content, 'hello');
	assert.equal(res.messages[1].message.content, 'hi');
});

// --- getById ---

test('getById - 返回完整 JSONL 行级结构', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	await fs.writeFile(
		nodePath.join(sessionsDir, 'g1.jsonl'),
		[
			'{"type":"header","version":"1","id":"g1"}',
			'{"type":"message","id":"msg1","message":{"role":"user","content":"hello"}}',
			'{"type":"message","id":"msg2","message":{"role":"assistant","content":"hi there"}}',
			'{"type":"summary","data":"ignored"}',
		].join('\n') + '\n',
		'utf8',
	);

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.getById({ sessionId: 'g1' });
	assert.equal(res.messages.length, 2);
	// 返回完整行，含 type、id、message
	assert.equal(res.messages[0].type, 'message');
	assert.equal(res.messages[0].id, 'msg1');
	assert.equal(res.messages[0].message.role, 'user');
	assert.equal(res.messages[0].message.content, 'hello');
	assert.equal(res.messages[1].type, 'message');
	assert.equal(res.messages[1].message.role, 'assistant');
	assert.equal(res.messages[1].message.content, 'hi there');
});

test('getById - 文件不存在返回空消息', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	await fs.mkdir(nodePath.join(root, 'main', 'sessions'), { recursive: true });
	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.getById({ sessionId: 'nonexistent' });
	assert.deepStrictEqual(res, { messages: [] });
});

test('getById - 缺少 sessionId 抛出错误', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	await assert.rejects(manager.getById({}), /sessionId required/);
});

test('getById - limit 限制返回最后 N 条', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	const lines = [];
	for (let i = 0; i < 10; i++) {
		lines.push(`{"type":"message","message":{"role":"user","content":"msg-${i}"}}`);
	}
	await fs.writeFile(nodePath.join(sessionsDir, 'g2.jsonl'), lines.join('\n') + '\n', 'utf8');

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.getById({ sessionId: 'g2', limit: 3 });
	assert.equal(res.messages.length, 3);
	// 取最后 3 条，返回完整行
	assert.equal(res.messages[0].message.content, 'msg-7');
	assert.equal(res.messages[2].message.content, 'msg-9');
});

test('getById - 跳过无效 message 行', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	await fs.writeFile(
		nodePath.join(sessionsDir, 'g3.jsonl'),
		[
			'{"type":"message","message":{"role":"user","content":"ok"}}',
			'not-json',
			'{"type":"message","message":{}}', // 无 role
			'{"type":"message","message":"not-object"}', // message 非对象
			'{"type":"message","message":{"role":"assistant","content":"fine"}}',
		].join('\n') + '\n',
		'utf8',
	);

	const warns = [];
	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn: (msg) => warns.push(msg) } });
	const res = await manager.getById({ sessionId: 'g3' });
	assert.equal(res.messages.length, 2);
	assert.equal(res.messages[0].message.content, 'ok');
	assert.equal(res.messages[1].message.content, 'fine');
	assert.ok(warns.length > 0, 'should have warned about bad json');
});

test('getById - fallback 到 reset 文件', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	await fs.writeFile(
		nodePath.join(sessionsDir, 'g4.jsonl.reset.2026-03-01T00-00-00.000Z'),
		'{"type":"message","message":{"role":"user","content":"from reset"}}\n',
		'utf8',
	);

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.getById({ sessionId: 'g4' });
	assert.equal(res.messages.length, 1);
	assert.equal(res.messages[0].message.content, 'from reset');
});

test('getById - CRLF 换行正确解析', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	await fs.writeFile(
		nodePath.join(sessionsDir, 'g5.jsonl'),
		'{"type":"message","message":{"role":"user","content":"crlf"}}\r\n{"type":"message","message":{"role":"assistant","content":"ok"}}\r\n',
		'utf8',
	);

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.getById({ sessionId: 'g5' });
	assert.equal(res.messages.length, 2);
	assert.equal(res.messages[0].message.content, 'crlf');
});

test('getById - agentId 参数正确路由', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'tester', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	await fs.writeFile(
		nodePath.join(sessionsDir, 'g6.jsonl'),
		'{"type":"message","message":{"role":"user","content":"from tester"}}\n',
		'utf8',
	);

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	// 默认 agentId=main，找不到
	const empty = await manager.getById({ sessionId: 'g6' });
	assert.deepStrictEqual(empty, { messages: [] });
	// 指定 agentId=tester
	const res = await manager.getById({ sessionId: 'g6', agentId: 'tester' });
	assert.equal(res.messages.length, 1);
	assert.equal(res.messages[0].message.content, 'from tester');
});

// --- 补充覆盖率：shouldReplaceByPriority 同优先级 updatedAt 比较 ---

test('listAll - 同一 sessionId 多个 reset 文件按 mtime 选最新', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	// 两个 reset 文件，通过 utimes 设置不同 mtime
	const oldFile = nodePath.join(sessionsDir, 'dup.jsonl.reset.2026-01-01T00-00-00.000Z');
	const newFile = nodePath.join(sessionsDir, 'dup.jsonl.reset.2026-03-01T00-00-00.000Z');
	await fs.writeFile(oldFile, '{"type":"message","message":{"role":"user","content":"old"}}\n', 'utf8');
	await fs.writeFile(newFile, '{"type":"message","message":{"role":"user","content":"new"}}\n', 'utf8');
	// 显式设置 mtime 确保 newFile 更新
	const oldTime = new Date('2026-01-01T00:00:00Z');
	const newTime = new Date('2026-03-01T00:00:00Z');
	await fs.utimes(oldFile, oldTime, oldTime);
	await fs.utimes(newFile, newTime, newTime);

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.listAll({});
	const item = res.items.find((it) => it.sessionId === 'dup');
	assert.ok(item);
	assert.equal(item.archiveType, 'reset');
	assert.ok(item.fileName.includes('2026-03-01'), 'should pick the file with newer mtime');
});

test('listAll - .jsonl.bak 文件被跳过', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	// .bak 文件不匹配 live 或 reset 模式
	await fs.writeFile(
		nodePath.join(sessionsDir, 'bak1.jsonl.bak.2026-01-01T00-00-00.000Z'),
		'{"type":"message"}\n',
		'utf8',
	);
	await fs.writeFile(
		nodePath.join(sessionsDir, 'ok1.jsonl'),
		'{"type":"message","message":{"role":"user","content":"visible"}}\n',
		'utf8',
	);

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.listAll({});
	assert.equal(res.total, 1);
	assert.equal(res.items[0].sessionId, 'ok1');
});

test('listAll - 分页 nextCursor 在剩余条目时返回字符串', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	for (let i = 0; i < 3; i++) {
		await fs.writeFile(nodePath.join(sessionsDir, `p${i}.jsonl`), '{"x":1}\n', 'utf8');
	}

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.listAll({ limit: 2, cursor: 0 });
	assert.equal(res.total, 3);
	assert.equal(res.items.length, 2);
	assert.equal(res.nextCursor, '2');
});

test('listAll/get - sessions 目录路径上有文件挡路时返回空（ENOTDIR）', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	// 把"sessions"位置创建为普通文件，使 readdir/access 抛 ENOTDIR
	await fs.mkdir(nodePath.join(root, 'main'), { recursive: true });
	await fs.writeFile(nodePath.join(root, 'main', 'sessions'), 'not-a-dir', 'utf8');

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const list = await manager.listAll({});
	assert.equal(list.total, 0);
	// resolveTranscriptFile：safeAccess(livePath) 命中 ENOTDIR → 走 reset 回退路径 → 再 readdir ENOTDIR → 空
	const got = await manager.get({ sessionId: 'x' });
	assert.equal(got.total, 0);
});

// === 默认构造（不注入 resolver）通过 setRuntime 端到端 ===
test('默认构造：通过 setRuntime 走 claw-paths 默认布局解析路径', async () => {
	const { setRuntime } = await import('../runtime.js');
	const tmpStateDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-rt-'));
	try {
		setRuntime({ state: { resolveStateDir: () => tmpStateDir } });
		const sessionsDir = nodePath.join(tmpStateDir, 'agents', 'main', 'sessions');
		await fs.mkdir(sessionsDir, { recursive: true });
		await fs.writeFile(
			nodePath.join(sessionsDir, 'sessions.json'),
			JSON.stringify({ k1: { sessionId: 'rt1' } }),
			'utf8',
		);
		await fs.writeFile(
			nodePath.join(sessionsDir, 'rt1.jsonl'),
			'{"type":"message","message":{"role":"user","content":[{"type":"text","text":"runtime path lookup"}]}}\n',
			'utf8',
		);

		const manager = createSessionManager({ logger: { warn() {} } });
		const list = await manager.listAll({});
		const found = list.items.find((it) => it.sessionId === 'rt1');
		assert.ok(found, 'should resolve sessions via runtime-injected state-dir');
		assert.equal(found.indexed, true);

		const detail = await manager.get({ sessionId: 'rt1' });
		assert.equal(detail.total, 1);
	} finally {
		setRuntime(null);
		await fs.rm(tmpStateDir, { recursive: true, force: true });
	}
});
