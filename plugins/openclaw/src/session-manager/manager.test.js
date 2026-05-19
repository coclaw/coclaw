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
