import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { createSessionManager } from './manager.js';

test('listAll should dedup by sessionId and prioritize reset over live', async () => {
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
		'{"type":"message","message":{"role":"user","content":[{"type":"text","text":"reset session first user message for title"}]}}\n',
		'utf8',
	);
	await fs.writeFile(nodePath.join(sessionsDir, 's2.jsonl'), '{"role":"assistant"}\n', 'utf8');
	await fs.writeFile(nodePath.join(sessionsDir, 's3.jsonl.reset.2026-02-26T12-50-04.126Z'), '{"role":"assistant"}\n', 'utf8');
	await fs.writeFile(nodePath.join(sessionsDir, 's4.jsonl.deleted.2026-02-26T12-50-04.126Z'), '{"role":"assistant"}\n', 'utf8');
	await fs.writeFile(nodePath.join(sessionsDir, 's5.jsonl.delete.2026-02-26T12-50-04.126Z'), '{"role":"assistant"}\n', 'utf8');
	await fs.writeFile(nodePath.join(sessionsDir, 'sessions.json'), JSON.stringify({ key1: { sessionId: 's1' } }), 'utf8');

	const manager = createSessionManager({ rootDir: root, logger: { warn() {} } });
	const res = manager.listAll({});
	assert.equal(res.total, 3);
	assert.equal(res.items.length > 0, true);
	assert.equal(res.items.some((it) => it.sessionId === 's1' && it.indexed === true && it.archiveType === 'reset'), true);
	assert.equal(res.items.some((it) => it.sessionId === 's2' && it.indexed === false && it.archiveType === 'live'), true);
	assert.equal(res.items.some((it) => it.sessionId === 's3' && it.indexed === false && it.archiveType === 'reset'), true);
	assert.equal(res.items.some((it) => it.sessionId === 's4'), false);
	assert.equal(res.items.some((it) => it.sessionId === 's5'), false);
	assert.equal(
		res.items.some((it) => it.sessionId === 's1' && it.derivedTitle === 'reset session first user message for title'),
		true,
	);
	assert.equal(
		res.items.some((it) => it.sessionId === 's2' && Object.prototype.hasOwnProperty.call(it, 'derivedTitle')),
		false,
	);
});

test('listAll should derive title from first user text and truncate long text', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	const longText = 'This is a very long user message that should be truncated nicely for derived session title display in list';
	await fs.writeFile(
		nodePath.join(sessionsDir, 't1.jsonl'),
		[
			'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"assistant first"}]}}',
			'{"type":"message","message":{"role":"user","content":[{"type":"text","text":"first user text"}]}}',
			`{"type":"message","message":{"role":"user","content":[{"type":"text","text":"${longText}"}]}}`,
		].join('\n') + '\n',
		'utf8',
	);
	await fs.writeFile(
		nodePath.join(sessionsDir, 't2.jsonl'),
		`{"type":"message","message":{"role":"user","content":[{"type":"text","text":"${longText}"}]}}\n`,
		'utf8',
	);

	const manager = createSessionManager({ rootDir: root, logger: { warn() {} } });
	const res = manager.listAll({});
	const t1 = res.items.find((it) => it.sessionId === 't1');
	const t2 = res.items.find((it) => it.sessionId === 't2');
	assert.equal(t1?.derivedTitle, 'first user text');
	assert.equal(typeof t2?.derivedTitle, 'string');
	assert.equal(t2.derivedTitle.endsWith('…'), true);
	assert.equal(t2.derivedTitle.length <= 60, true);
});

test('deriveTitle should strip OC-injected prefixes and suffixes', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	// 时间戳前缀
	await fs.writeFile(
		nodePath.join(sessionsDir, 'ts.jsonl'),
		'{"type":"message","message":{"role":"user","content":"[Mon 2026-03-02 16:16 GMT+8] 你好世界"}}\n',
		'utf8',
	);

	// cron:uuid 前缀
	await fs.writeFile(
		nodePath.join(sessionsDir, 'cron.jsonl'),
		'{"type":"message","message":{"role":"user","content":"[cron:d59196ed-27ee-42fc-ad60-8ad19aafd4ba workspace-backup] 执行任务"}}\n',
		'utf8',
	);

	// cron:uuid 无任务名
	await fs.writeFile(
		nodePath.join(sessionsDir, 'cron2.jsonl'),
		'{"type":"message","message":{"role":"user","content":"[cron:aabb1122-3344-5566-7788-99aabbccddee] 只有内容"}}\n',
		'utf8',
	);

	// 尾部 message_id
	await fs.writeFile(
		nodePath.join(sessionsDir, 'msgid.jsonl'),
		JSON.stringify({
			type: 'message',
			message: { role: 'user', content: '正常内容\n[message_id: abc-123]' },
		}) + '\n',
		'utf8',
	);

	// untrusted metadata 头部
	await fs.writeFile(
		nodePath.join(sessionsDir, 'meta.jsonl'),
		JSON.stringify({
			type: 'message',
			message: {
				role: 'user',
				content: 'Conversation info (untrusted metadata):\n```json\n{"id":"x"}\n```\n\n实际内容',
			},
		}) + '\n',
		'utf8',
	);

	// 清洗后为空
	await fs.writeFile(
		nodePath.join(sessionsDir, 'empty.jsonl'),
		'{"type":"message","message":{"role":"user","content":"[Mon 2026-03-02 16:16 GMT+8]  "}}\n',
		'utf8',
	);

	const manager = createSessionManager({ rootDir: root, logger: { warn() {} } });
	const res = manager.listAll({});
	const byId = (id) => res.items.find((it) => it.sessionId === id);

	assert.equal(byId('ts')?.derivedTitle, '你好世界');
	assert.equal(byId('cron')?.derivedTitle, 'workspace-backup 执行任务');
	assert.equal(byId('cron2')?.derivedTitle, '只有内容');
	assert.equal(byId('msgid')?.derivedTitle, '正常内容');
	assert.equal(byId('meta')?.derivedTitle, '实际内容');
	assert.equal(Object.prototype.hasOwnProperty.call(byId('empty'), 'derivedTitle'), false);
});

test('get should prioritize reset transcript and guard missing session', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const sessionsDir = nodePath.join(root, 'main', 'sessions');
	await fs.mkdir(sessionsDir, { recursive: true });

	await fs.writeFile(nodePath.join(sessionsDir, 'x1.jsonl'), '{"from":"live"}\n', 'utf8');
	await fs.writeFile(nodePath.join(sessionsDir, 'x1.jsonl.reset.2026-02-26T12-50-04.126Z'), '{"from":"reset-new"}\nnot-json\n', 'utf8');
	await fs.writeFile(nodePath.join(sessionsDir, 'x1.jsonl.reset.2026-02-25T12-50-04.126Z'), '{"from":"reset-old"}\n', 'utf8');
	const warns = [];
	const manager = createSessionManager({ rootDir: root, logger: { warn: (msg) => warns.push(String(msg)) } });
	const res = manager.get({ sessionId: 'x1', limit: 10, cursor: 0 });
	assert.equal(res.total, 1);
	assert.equal(res.messages.length, 1);
	assert.equal(res.messages[0].from, 'reset-new');
	assert.equal(warns.length > 0, true);

	assert.throws(() => manager.get({}), /sessionId required/);
	assert.throws(() => manager.get({ sessionId: 'missing' }), /not found/);
});

test('listAll/get should normalize bad inputs and missing dirs', async () => {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'smgr-'));
	const manager = createSessionManager({ rootDir: root, logger: { warn() {} } });

	const list = manager.listAll({
		agentId: ' ',
		limit: -10,
		cursor: -1,
	});
	assert.equal(list.agentId, 'main');
	assert.equal(list.total, 0);
	assert.equal(list.nextCursor, null);

	await fs.mkdir(nodePath.join(root, 'a1', 'sessions'), { recursive: true });
	await fs.writeFile(nodePath.join(root, 'a1', 'sessions', 's1.jsonl'), '{"x":1}\n', 'utf8');
	const list2 = manager.listAll({ agentId: 'a1', limit: 9999, cursor: 0 });
	assert.equal(list2.items.length, 1);

	const get1 = manager.get({ agentId: 'a1', sessionId: 's1', limit: 0, cursor: 9999 });
	assert.equal(get1.messages.length, 0);
	assert.equal(get1.nextCursor, null);
});
