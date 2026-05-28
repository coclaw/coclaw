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

	// 全量字段核对 1：空白 agentId / 负 limit / 负 cursor 全部被规范化
	const list = await manager.listAll({
		agentId: ' ',
		limit: -10,
		cursor: -1,
	});
	assert.equal(list.agentId, 'main', 'agentId 空白应规范为 main');
	assert.equal(list.total, 0);
	assert.equal(list.cursor, '0', 'cursor 负数应被钳到 0 并返回字符串');
	assert.equal(list.nextCursor, null);
	assert.deepStrictEqual(list.items, [], '空目录 items 应为空数组');

	await fs.mkdir(nodePath.join(root, 'a1', 'sessions'), { recursive: true });
	await fs.writeFile(nodePath.join(root, 'a1', 'sessions', 's1.jsonl'), '{"x":1}\n', 'utf8');
	// 全量字段核对 2：超大 limit 被钳到上限（200），单条数据应一次性返回完
	const list2 = await manager.listAll({ agentId: 'a1', limit: 9999, cursor: 0 });
	assert.equal(list2.agentId, 'a1');
	assert.equal(list2.total, 1);
	assert.equal(list2.items.length, 1);
	assert.equal(list2.items[0].sessionId, 's1');
	assert.equal(list2.cursor, '0');
	assert.equal(list2.nextCursor, null, 'limit 被钳到 200 仍 > 总数 → 无下一页');

	// 全量字段核对 3：limit=0 被钳到下限 1，cursor 越界返回字符串原值，messages 应为空
	const get1 = await manager.get({ agentId: 'a1', sessionId: 's1', limit: 0, cursor: 9999 });
	assert.equal(get1.agentId, 'a1');
	assert.equal(get1.sessionId, 's1');
	assert.equal(get1.total, 1, 'total 应反映 transcript 实际行数（未受 cursor/limit 影响）');
	assert.equal(get1.cursor, '9999', 'cursor 在合法范围内透传，并字符串化');
	assert.equal(get1.nextCursor, null);
	assert.deepStrictEqual(get1.messages, []);
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

test('getById - 文件不存在抛 NOT_FOUND', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	await fs.mkdir(nodePath.join(root, 'main', 'sessions'), { recursive: true });
	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	await assert.rejects(
		manager.getById({ sessionId: 'nonexistent' }),
		(err) => err.code === 'NOT_FOUND',
	);
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
	// 全量内容核对：取最后 3 条，逐条断言字段（捕获 slice(-N) → slice(0,N) 类 mutation）
	assert.equal(res.messages[0].type, 'message');
	assert.equal(res.messages[0].message.role, 'user');
	assert.equal(res.messages[0].message.content, 'msg-7');
	assert.equal(res.messages[1].type, 'message');
	assert.equal(res.messages[1].message.content, 'msg-8', '中间位置 msg-8 必须存在，防止 slice 起点偏移');
	assert.equal(res.messages[2].type, 'message');
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
	// 有可解析行 + 个别坏行 → 容错返回好行，并在 badLines 记下坏行原文供排障
	assert.equal(res.badLines.length, 1, '仅 not-json 一行 parse 失败');
	assert.equal(res.badLines[0].index, 1, '坏行是第 2 个内容行（0-based index=1）');
	assert.equal(res.badLines[0].raw, 'not-json', '原文不截断');
	assert.equal(typeof res.badLines[0].error, 'string');
});

test('getById - 非空文件一行都解析不出抛 PARSE_FAILED', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	await fs.writeFile(nodePath.join(sessionsDir, 'corrupt.jsonl'), 'not-json\n{bad\nalso bad\n', 'utf8');
	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	await assert.rejects(
		manager.getById({ sessionId: 'corrupt' }),
		(err) => err.code === 'PARSE_FAILED',
	);
});

test('getById - 全合法 JSON 但无 message 行 → 良性空（不抛、无 badLines）', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	// 全是合法 JSON，但没有 type==='message' 且有 role 的行 → parseOk>0，不是损坏
	await fs.writeFile(
		nodePath.join(sessionsDir, 'meta.jsonl'),
		'{"type":"header","id":"meta"}\n{"type":"summary","data":"x"}\n',
		'utf8',
	);
	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.getById({ sessionId: 'meta' });
	assert.deepStrictEqual(res, { messages: [] }, '良性空不带 badLines');
});

test('getById - 空文件 / 全空白行 / 纯空格制表符行 → 良性空（不抛 PARSE_FAILED）', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	await fs.writeFile(nodePath.join(sessionsDir, 'empty.jsonl'), '', 'utf8');
	await fs.writeFile(nodePath.join(sessionsDir, 'blank.jsonl'), '\n\n\n', 'utf8');
	// 纯空格/制表符行：iterTextLines 会产出非零长度段（不是空段），靠 getById 内 line.trim() 兜底跳过
	await fs.writeFile(nodePath.join(sessionsDir, 'ws.jsonl'), '   \n\t\n  \t  \n', 'utf8');
	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	assert.deepStrictEqual(await manager.getById({ sessionId: 'empty' }), { messages: [] });
	// 全空白：iterTextLines skipEmpty 产零行 → parseOk=0 且 badLines=[]，不算损坏
	assert.deepStrictEqual(await manager.getById({ sessionId: 'blank' }), { messages: [] });
	// 纯空白行视同空行 → 良性空，不误判为 PARSE_FAILED
	assert.deepStrictEqual(await manager.getById({ sessionId: 'ws' }), { messages: [] });
});

test('getById - 空白行夹杂在内容行间：跳过不计入 badLines，index 按内容行计', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	// 第 1 内容行合法、中间夹纯空格行（应被跳过）、第 2 内容行是坏行
	await fs.writeFile(
		nodePath.join(sessionsDir, 'mixed.jsonl'),
		'{"type":"message","message":{"role":"user","content":"ok"}}\n   \nnot-json\n',
		'utf8',
	);
	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.getById({ sessionId: 'mixed' });
	assert.equal(res.messages.length, 1, '仅 1 条合法 message');
	assert.equal(res.messages[0].message.content, 'ok');
	assert.equal(res.badLines.length, 1, '空白行不进 badLines，仅 not-json 一行');
	assert.equal(res.badLines[0].raw, 'not-json');
	// 空白行被跳过（不占内容行序号）→ not-json 是第 2 个内容行 index=1
	assert.equal(res.badLines[0].index, 1, 'index 按非空白内容行计，空白行不占号');
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

test('getById - fallback 到 .deleted 文件', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	await fs.writeFile(
		nodePath.join(sessionsDir, 'gd.jsonl.deleted.2026-03-05T00-00-00.000Z'),
		'{"type":"message","message":{"role":"user","content":"from deleted"}}\n',
		'utf8',
	);

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.getById({ sessionId: 'gd' });
	assert.equal(res.messages.length, 1);
	assert.equal(res.messages[0].message.content, 'from deleted');
});

test('getById - 忽略 archiveStamp 不符合 ISO 格式的噪声文件', async () => {
	// 真实场景：rsync 或手工备份在归档旁留下 .jsonl.reset.<ts>.bak / .jsonl.reset.junk 这类文件
	// 字典序上 `<ts>.bak` 比 `<ts>` 大，不过滤的话会被当成更新的归档选中
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	await fs.writeFile(
		nodePath.join(sessionsDir, 'gn.jsonl.reset.2026-03-01T00-00-00.000Z'),
		'{"type":"message","message":{"role":"user","content":"clean reset"}}\n',
		'utf8',
	);
	// 这两个噪声文件的 archiveStamp（`.000Z.bak` / `junk`）应被 regex 拒掉
	await fs.writeFile(
		nodePath.join(sessionsDir, 'gn.jsonl.reset.2026-03-01T00-00-00.000Z.bak'),
		'{"type":"message","message":{"role":"user","content":"noise bak"}}\n',
		'utf8',
	);
	await fs.writeFile(
		nodePath.join(sessionsDir, 'gn.jsonl.deleted.junk'),
		'{"type":"message","message":{"role":"user","content":"noise junk"}}\n',
		'utf8',
	);
	// "形似合法但 digit count 错"：以数字开头、Z 结尾且年份比 clean 更新（2999 > 2026），
	// 但毫秒只有 2 位——锁死 regex 严格性。regex 若被改宽（如 /^\d.*Z$/），这条会被当成更新归档选中、断言失败
	await fs.writeFile(
		nodePath.join(sessionsDir, 'gn.jsonl.reset.2999-12-31T23-59-59.99Z'),
		'{"type":"message","message":{"role":"user","content":"noise lookalike"}}\n',
		'utf8',
	);

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.getById({ sessionId: 'gn' });
	assert.equal(res.messages.length, 1);
	assert.equal(res.messages[0].message.content, 'clean reset');
});

test('getById - archiveStamp 可省略毫秒（与上游 (?:\\.\\d{3})? 对齐）', async () => {
	// 上游 artifacts.ts ARCHIVE_TIMESTAMP_RE 毫秒为 optional；本测保证插件接受无毫秒形态
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	await fs.writeFile(
		nodePath.join(sessionsDir, 'gms.jsonl.reset.2026-03-01T00-00-00Z'),
		'{"type":"message","message":{"role":"user","content":"no-ms archive"}}\n',
		'utf8',
	);

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.getById({ sessionId: 'gms' });
	assert.equal(res.messages.length, 1);
	assert.equal(res.messages[0].message.content, 'no-ms archive');
});

test('getById - reset + deleted 共存按 ISO 时间戳取最新', async () => {
	// 用例 A：deleted 较新 → 取 deleted
	const rootA = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const dirA = nodePath.join(rootA, 'main', 'sessions');
	await fs.mkdir(dirA, { recursive: true });
	await fs.writeFile(
		nodePath.join(dirA, 'mix.jsonl.reset.2026-03-01T00-00-00.000Z'),
		'{"type":"message","message":{"role":"user","content":"reset-old"}}\n',
		'utf8',
	);
	await fs.writeFile(
		nodePath.join(dirA, 'mix.jsonl.deleted.2026-03-10T00-00-00.000Z'),
		'{"type":"message","message":{"role":"user","content":"deleted-new"}}\n',
		'utf8',
	);
	const mgrA = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(rootA, id, "sessions"), resolveStorePath: (id) => nodePath.join(rootA, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(rootA, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const resA = await mgrA.getById({ sessionId: 'mix' });
	assert.equal(resA.messages.length, 1);
	assert.equal(resA.messages[0].message.content, 'deleted-new');

	// 用例 B：反向——reset 较新 → 取 reset
	const rootB = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const dirB = nodePath.join(rootB, 'main', 'sessions');
	await fs.mkdir(dirB, { recursive: true });
	await fs.writeFile(
		nodePath.join(dirB, 'mix.jsonl.deleted.2026-03-01T00-00-00.000Z'),
		'{"type":"message","message":{"role":"user","content":"deleted-old"}}\n',
		'utf8',
	);
	await fs.writeFile(
		nodePath.join(dirB, 'mix.jsonl.reset.2026-03-10T00-00-00.000Z'),
		'{"type":"message","message":{"role":"user","content":"reset-new"}}\n',
		'utf8',
	);
	const mgrB = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(rootB, id, "sessions"), resolveStorePath: (id) => nodePath.join(rootB, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(rootB, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const resB = await mgrB.getById({ sessionId: 'mix' });
	assert.equal(resB.messages.length, 1);
	assert.equal(resB.messages[0].message.content, 'reset-new');
});

test('getById - 不传 limit 返回全部（验证 500 上限已去）', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	const ROWS = 501;
	const lines = [];
	for (let i = 0; i < ROWS; i++) {
		lines.push(`{"type":"message","message":{"role":"user","content":"m-${i}"}}`);
	}
	await fs.writeFile(nodePath.join(sessionsDir, 'big.jsonl'), lines.join('\n') + '\n', 'utf8');

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.getById({ sessionId: 'big' });
	assert.equal(res.messages.length, ROWS);
	assert.equal(res.messages[0].message.content, 'm-0');
	assert.equal(res.messages[ROWS - 1].message.content, `m-${ROWS - 1}`);
});

test('getById - 非数字/非正数 limit 一律视为不限', async () => {
	// 造 8 行 transcript，保证"被误当成数字截尾"的情形（'3', true=1, [2]=2）
	// 和"真截尾"行为有可分辨的差异
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	const ROWS = 8;
	const lines = [];
	for (let i = 0; i < ROWS; i++) {
		lines.push(`{"type":"message","message":{"role":"user","content":"v-${i}"}}`);
	}
	await fs.writeFile(nodePath.join(sessionsDir, 'gz.jsonl'), lines.join('\n') + '\n', 'utf8');

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	// 0 / 负 / 非数字（字符串数字、true、数组）/ null / NaN / Infinity / (0,1) 区间 → 全部 ROWS 条
	const limits = [0, -3, 'abc', '3', true, false, [2], [], {}, null, NaN, Infinity, -Infinity, 0.5, 0.999];
	for (const limit of limits) {
		const res = await manager.getById({ sessionId: 'gz', limit });
		assert.equal(res.messages.length, ROWS, `limit=${JSON.stringify(limit) ?? String(limit)} 应返回全部 ${ROWS} 条`);
	}
});

test('getById - limit 是正整数时真截尾（mutation 防护）', async () => {
	// 与上一条用例配套：显式钉死"limit 是 number 且 > 0 才截尾"，防 typeof 守卫退化
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	const lines = [];
	for (let i = 0; i < 8; i++) {
		lines.push(`{"type":"message","message":{"role":"user","content":"k-${i}"}}`);
	}
	await fs.writeFile(nodePath.join(sessionsDir, 'gk.jsonl'), lines.join('\n') + '\n', 'utf8');

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const r3 = await manager.getById({ sessionId: 'gk', limit: 3 });
	assert.equal(r3.messages.length, 3);
	assert.equal(r3.messages[0].message.content, 'k-5');
	assert.equal(r3.messages[2].message.content, 'k-7');
	// 小数被 Math.trunc 截到整数
	const r25 = await manager.getById({ sessionId: 'gk', limit: 2.9 });
	assert.equal(r25.messages.length, 2);
	assert.equal(r25.messages[0].message.content, 'k-6');
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
	// 默认 agentId=main，找不到 → 抛 NOT_FOUND
	await assert.rejects(
		manager.getById({ sessionId: 'g6' }),
		(err) => err.code === 'NOT_FOUND',
	);
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

	// follow-through 第二页：传入上一页的 nextCursor，应只剩 1 条且 nextCursor=null
	const res2 = await manager.listAll({ limit: 2, cursor: Number(res.nextCursor) });
	assert.equal(res2.total, 3);
	assert.equal(res2.items.length, 1);
	assert.equal(res2.nextCursor, null);
});

test('get - 文件存在但全为空行时返回 total=0', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	// 只有空行/换行，不含任何 JSON 行
	await fs.writeFile(nodePath.join(sessionsDir, 'empty.jsonl'), '\n\n\n', 'utf8');

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.get({ sessionId: 'empty' });
	assert.equal(res.total, 0);
	assert.equal(res.messages.length, 0);
	assert.equal(res.nextCursor, null);
});

test('listAll - sessions.json 内容损坏时静默回退，目录扫描仍工作', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	// 故意写入非法 JSON
	await fs.writeFile(nodePath.join(sessionsDir, 'sessions.json'), 'not-json-at-all{{{', 'utf8');
	await fs.writeFile(nodePath.join(sessionsDir, 'ok.jsonl'), '{"x":1}\n', 'utf8');

	const manager = createSessionManager({ resolveSessionsDir: (id) => nodePath.join(root, id, "sessions"), resolveStorePath: (id) => nodePath.join(root, id, "sessions", "sessions.json"), resolveTranscriptPath: (sid, id) => nodePath.join(root, id, "sessions", `${sid}.jsonl`), logger: { warn() {} } });
	const res = await manager.listAll({});
	// 索引解析失败回退为 {}，但目录里的 transcript 仍被列出
	assert.equal(res.total, 1);
	assert.equal(res.items[0].sessionId, 'ok');
	assert.equal(res.items[0].indexed, false);
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

// === 跨 yield 阈值的大 transcript 不丢消息 ===
test('get/getById - 跨越 yield 阈值的大 transcript 完整解析', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	// 默认 yieldEvery=100；造 350 行确保至少跨 3 次让出边界
	const ROW_COUNT = 350;
	const rows = [];
	for (let i = 0; i < ROW_COUNT; i++) {
		const role = i % 2 === 0 ? 'user' : 'assistant';
		rows.push(JSON.stringify({ type: 'message', message: { role, content: `c${i}` } }));
	}
	await fs.writeFile(nodePath.join(sessionsDir, 'big.jsonl'), `${rows.join('\n')}\n`, 'utf8');

	const manager = createSessionManager({
		resolveSessionsDir: (id) => nodePath.join(root, id, 'sessions'),
		resolveStorePath: (id) => nodePath.join(root, id, 'sessions', 'sessions.json'),
		resolveTranscriptPath: (sid, id) => nodePath.join(root, id, 'sessions', `${sid}.jsonl`),
		logger: { warn() {} },
	});

	const detail = await manager.get({ sessionId: 'big', limit: 500 });
	assert.equal(detail.total, ROW_COUNT);
	assert.equal(detail.messages.length, ROW_COUNT);
	// 完整顺序断言——让出穿插下任何 reorder/dup/skip 都立即暴露
	for (let i = 0; i < ROW_COUNT; i++) {
		assert.equal(detail.messages[i].message.content, `c${i}`, `get: row ${i} content mismatch`);
		assert.equal(detail.messages[i].message.role, i % 2 === 0 ? 'user' : 'assistant', `get: row ${i} role mismatch`);
	}

	const tail = await manager.getById({ sessionId: 'big', limit: 500 });
	assert.equal(tail.messages.length, ROW_COUNT);
	for (let i = 0; i < ROW_COUNT; i++) {
		assert.equal(tail.messages[i].message.content, `c${i}`, `getById: row ${i} content mismatch`);
	}
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

// listAllEntries: 把 sessions.json 中 (sessionKey, sessionId) 对全部摘出来，供启动期对账使用。
test('listAllEntries: 读 sessions.json 返回所有 sessionKey + 当前 sessionId', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-le-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	await fs.writeFile(
		nodePath.join(sessionsDir, 'sessions.json'),
		JSON.stringify({
			'agent:main:main': { sessionId: 'sid-main' },
			'agent:main:topic-1': { sessionId: 'sid-topic-1' },
		}),
		'utf8',
	);
	const manager = createSessionManager({
		resolveSessionsDir: (id) => nodePath.join(root, id, 'sessions'),
		resolveStorePath: (id) => nodePath.join(root, id, 'sessions', 'sessions.json'),
		resolveTranscriptPath: (sid, id) => nodePath.join(root, id, 'sessions', `${sid}.jsonl`),
		logger: { warn() {} },
	});
	const entries = await manager.listAllEntries('main');
	entries.sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
	assert.deepEqual(entries, [
		{ sessionKey: 'agent:main:main', sessionId: 'sid-main' },
		{ sessionKey: 'agent:main:topic-1', sessionId: 'sid-topic-1' },
	]);
});

test('listAllEntries: sessions.json 异常为数组 → 返回 [] + warn 暴露异常', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-le-arr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	await fs.writeFile(
		nodePath.join(sessionsDir, 'sessions.json'),
		JSON.stringify([{ sessionId: 'wrong' }]),
		'utf8',
	);
	const warns = [];
	const manager = createSessionManager({
		resolveSessionsDir: (id) => nodePath.join(root, id, 'sessions'),
		resolveStorePath: (id) => nodePath.join(root, id, 'sessions', 'sessions.json'),
		resolveTranscriptPath: (sid, id) => nodePath.join(root, id, 'sessions', `${sid}.jsonl`),
		logger: { warn: (m) => warns.push(String(m)) },
	});
	const entries = await manager.listAllEntries('main');
	assert.deepEqual(entries, []);
	assert.equal(warns.length, 1, '数组形态应打一条 warn');
	assert.match(warns[0], /sessions\.json for agent=main is an array/);
});

test('listAllEntries: 缺 sessions.json / 缺/坏 sessionId 行被跳过', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-le-empty-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	const manager = createSessionManager({
		resolveSessionsDir: (id) => nodePath.join(root, id, 'sessions'),
		resolveStorePath: (id) => nodePath.join(root, id, 'sessions', 'sessions.json'),
		resolveTranscriptPath: (sid, id) => nodePath.join(root, id, 'sessions', `${sid}.jsonl`),
		logger: { warn() {} },
	});

	// 1) 没有 sessions.json → 空数组
	assert.deepEqual(await manager.listAllEntries('main'), []);

	// 2) sessions.json 含异常项（缺 sessionId / 非字符串）→ 仅保留合法项
	await fs.writeFile(
		nodePath.join(sessionsDir, 'sessions.json'),
		JSON.stringify({
			'agent:main:main': { sessionId: 'sid-ok' },
			'agent:main:bad-empty': {},
			'agent:main:bad-num': { sessionId: 42 },
			'agent:main:bad-empty-str': { sessionId: '' },
		}),
		'utf8',
	);
	const entries = await manager.listAllEntries('main');
	assert.deepEqual(entries, [{ sessionKey: 'agent:main:main', sessionId: 'sid-ok' }]);
});

test('listAllEntries: sessions.json 内容损坏（非合法 JSON）→ 返回 [] 不抛错', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-le-corrupt-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	await fs.writeFile(nodePath.join(sessionsDir, 'sessions.json'), '{not valid json', 'utf8');
	const manager = createSessionManager({
		resolveSessionsDir: (id) => nodePath.join(root, id, 'sessions'),
		resolveStorePath: (id) => nodePath.join(root, id, 'sessions', 'sessions.json'),
		resolveTranscriptPath: (sid, id) => nodePath.join(root, id, 'sessions', `${sid}.jsonl`),
		logger: { warn() {} },
	});
	assert.deepEqual(await manager.listAllEntries('main'), []);
});

// --- c8 ignore 削减：DI 与默认参数覆盖 ---

test('createSessionManager - 不传 logger 时默认走 console（覆盖 logger ?? console 兜底）', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-defl-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	// 写一行坏 json 让 get 内部走 logger.warn 路径
	await fs.writeFile(nodePath.join(sessionsDir, 'g.jsonl'), '{"type":"message","message":{"role":"user","content":"ok"}}\nNOT-JSON\n', 'utf8');
	const origWarn = console.warn;
	const seen = [];
	console.warn = (...a) => { seen.push(a.map(String).join(' ')); };
	try {
		const mgr = createSessionManager({
			resolveSessionsDir: (id) => nodePath.join(root, id, 'sessions'),
			resolveStorePath: (id) => nodePath.join(root, id, 'sessions', 'sessions.json'),
			resolveTranscriptPath: (sid, id) => nodePath.join(root, id, 'sessions', `${sid}.jsonl`),
			// 故意不传 logger
		});
		const res = await mgr.get({ sessionId: 'g' });
		assert.equal(res.total, 1, 'bad json 行被跳过、合法行计数');
		assert.ok(seen.some((m) => m.includes('bad json line skipped')), '应通过默认 console.warn 报告坏行');
	}
	finally {
		console.warn = origWarn;
	}
});

test('listAllEntries - 不传 agentId 时默认 main（覆盖默认参数）', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-defaid-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	await fs.writeFile(
		nodePath.join(sessionsDir, 'sessions.json'),
		JSON.stringify({ 'agent:main:main': { sessionId: 'sid-main' } }),
		'utf8',
	);
	const mgr = createSessionManager({
		resolveSessionsDir: (id) => nodePath.join(root, id, 'sessions'),
		resolveStorePath: (id) => nodePath.join(root, id, 'sessions', 'sessions.json'),
		resolveTranscriptPath: (sid, id) => nodePath.join(root, id, 'sessions', `${sid}.jsonl`),
		logger: { warn() {} },
	});
	// 调用方不传 agentId → 默认走 main
	const entries = await mgr.listAllEntries();
	assert.deepEqual(entries, [{ sessionKey: 'agent:main:main', sessionId: 'sid-main' }]);
});

test('listAll - sessions.json 内容为合法 JSON 但非 object（如数字 42）→ 空索引兜底', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-nonobj-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	// 合法 JSON 但是数字字面量；readJsonSafe 不会抛、readIndex 内的 typeof !== 'object' 兜底返 {}
	await fs.writeFile(nodePath.join(sessionsDir, 'sessions.json'), '42', 'utf8');
	await fs.writeFile(nodePath.join(sessionsDir, 'a.jsonl'), '{"x":1}\n', 'utf8');
	const mgr = createSessionManager({
		resolveSessionsDir: (id) => nodePath.join(root, id, 'sessions'),
		resolveStorePath: (id) => nodePath.join(root, id, 'sessions', 'sessions.json'),
		resolveTranscriptPath: (sid, id) => nodePath.join(root, id, 'sessions', `${sid}.jsonl`),
		logger: { warn() {} },
	});
	const res = await mgr.listAll({});
	// 索引兜底为 {} → indexed=false；但目录扫描仍工作
	assert.equal(res.total, 1);
	assert.equal(res.items[0].sessionId, 'a');
	assert.equal(res.items[0].indexed, false);
});

test('listAll - sessions.json 中无 transcript 的 entry 缺 updatedAt → updatedAt 兜底为 0', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-noupd-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	// 索引中有 entry 但无 transcript 文件，且 entry 不含 updatedAt
	await fs.writeFile(
		nodePath.join(sessionsDir, 'sessions.json'),
		JSON.stringify({
			'agent:main:noupd': { sessionId: 'no-upd' },
			'agent:main:bad-sid': { /* 缺 sessionId */ },
		}),
		'utf8',
	);
	const mgr = createSessionManager({
		resolveSessionsDir: (id) => nodePath.join(root, id, 'sessions'),
		resolveStorePath: (id) => nodePath.join(root, id, 'sessions', 'sessions.json'),
		resolveTranscriptPath: (sid, id) => nodePath.join(root, id, 'sessions', `${sid}.jsonl`),
		logger: { warn() {} },
	});
	const res = await mgr.listAll({});
	assert.equal(res.total, 1, '缺 sessionId 的 entry 被防御性跳过，仅留 noupd');
	const item = res.items.find((it) => it.sessionId === 'no-upd');
	assert.ok(item);
	assert.equal(item.updatedAt, 0, '缺 updatedAt 时回落 0');
	assert.equal(item.fileName, null);
	assert.equal(item.indexed, true);
});

test('get - logger 缺 warn 方法时坏 json 行不致命（可选链兜底）', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-nowarn-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	await fs.writeFile(nodePath.join(sessionsDir, 'g.jsonl'), '{"type":"message"}\nBAD\n', 'utf8');
	// logger 不含 warn 方法 —— 验证 logger.warn?. 可选链不抛
	const mgr = createSessionManager({
		resolveSessionsDir: (id) => nodePath.join(root, id, 'sessions'),
		resolveStorePath: (id) => nodePath.join(root, id, 'sessions', 'sessions.json'),
		resolveTranscriptPath: (sid, id) => nodePath.join(root, id, 'sessions', `${sid}.jsonl`),
		logger: {},
	});
	const res = await mgr.get({ sessionId: 'g' });
	assert.equal(res.total, 1);
	// getById 同源代码路径同样测一遍：有 1 行合法 JSON（但非 message 行）→ 不抛 PARSE_FAILED，
	// 坏行 BAD 进 badLines；logger 缺 warn 方法时可选链不致命
	const r2 = await mgr.getById({ sessionId: 'g' });
	assert.deepEqual(r2.messages, [], 'getById 行只取 type==="message" 且有 role 的');
	assert.equal(r2.badLines.length, 1, 'BAD 行进 badLines');
	assert.equal(r2.badLines[0].raw, 'BAD');
});

test('get - 分页 nextCursor 在剩余条目时返回字符串（覆盖 ternary 非 null 分支）', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-cursor-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	const lines = [];
	for (let i = 0; i < 5; i++) {
		lines.push(`{"type":"message","message":{"role":"user","content":"m-${i}"}}`);
	}
	await fs.writeFile(nodePath.join(sessionsDir, 'p.jsonl'), lines.join('\n') + '\n', 'utf8');
	const mgr = createSessionManager({
		resolveSessionsDir: (id) => nodePath.join(root, id, 'sessions'),
		resolveStorePath: (id) => nodePath.join(root, id, 'sessions', 'sessions.json'),
		resolveTranscriptPath: (sid, id) => nodePath.join(root, id, 'sessions', `${sid}.jsonl`),
		logger: { warn() {} },
	});
	const res = await mgr.get({ sessionId: 'p', limit: 2, cursor: 0 });
	assert.equal(res.total, 5);
	assert.equal(res.messages.length, 2);
	assert.equal(res.nextCursor, '2', 'cursor+limit 仍 < total → nextCursor 字符串化');
	// 走到末尾：nextCursor 应回 null
	const res2 = await mgr.get({ sessionId: 'p', limit: 2, cursor: 4 });
	assert.equal(res2.messages.length, 1);
	assert.equal(res2.nextCursor, null);
});

test('listAllEntries: sessionKey 为空字符串的异常行被跳过', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-le-emptykey-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });
	await fs.writeFile(
		nodePath.join(sessionsDir, 'sessions.json'),
		JSON.stringify({
			'': { sessionId: 'sid-evil' },
			'agent:main:main': { sessionId: 'sid-ok' },
		}),
		'utf8',
	);
	const manager = createSessionManager({
		resolveSessionsDir: (id) => nodePath.join(root, id, 'sessions'),
		resolveStorePath: (id) => nodePath.join(root, id, 'sessions', 'sessions.json'),
		resolveTranscriptPath: (sid, id) => nodePath.join(root, id, 'sessions', `${sid}.jsonl`),
		logger: { warn() {} },
	});
	const entries = await manager.listAllEntries('main');
	assert.deepEqual(entries, [{ sessionKey: 'agent:main:main', sessionId: 'sid-ok' }]);
});
