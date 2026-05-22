// cron 顶替主会话 sid 止血修复的 e2e 覆盖（dump tmp/cron-session-eviction--clear-dump.md 场景 4/5/9）。
// 前置：gateway running + 当前 plugin 已 link 到 stage。
// 跑法：`pnpm run e2e`（plugin 工作区）。
// 注意：会真改本机 chat-history.json。本机务必是测试环境，跑完不会自动回滚。
// 顺序：本 spec 中"reconcileAll 启动对账"会重启 gateway，置于最后一个 test。

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { rpcCall, restartGateway } from './lib/gateway-rpc.js';
import { readChatHistory, readEntries, chatHistoryPath } from './lib/chat-history.js';

// 直接读 sessions.json 取某个 sessionKey 当前 head sid（reconcileAll 的真实输入）。
// 不依赖 chat-history.json 中的 head，因为后者可能被前序 spec 注入污染。
function readSessionsHeadSid(agentId, sessionKey) {
	const dir = process.env.OPENCLAW_STATE_DIR || nodePath.join(os.homedir(), '.openclaw');
	const p = nodePath.join(dir, 'agents', agentId, 'sessions', 'sessions.json');
	const raw = fs.readFileSync(p, 'utf8');
	const data = JSON.parse(raw);
	return data?.[sessionKey]?.sessionId;
}

const AGENT_ID = 'main';
const SESSION_KEY = `agent:${AGENT_ID}:main`;
const TESTER = 'tester';
const TESTER_KEY = `agent:${TESTER}:main`;
const HOOK_FLUSH_MS = 150;

function snapshot(agentId = AGENT_ID, sessionKey = SESSION_KEY) {
	const list = readEntries(agentId, sessionKey);
	return { list, length: list.length, head: list[0], archived: list.slice(1) };
}

function assertTimestampInWindow(ts, startTime, label) {
	assert.ok(typeof ts === 'number', `${label}: expected number, got ${typeof ts}`);
	const upper = Date.now() + 1000;
	assert.ok(ts >= startTime && ts <= upper,
		`${label}: archivedAt=${ts} not in [${startTime}, ${upper}]`);
}

// 直接写盘 chat-history.json（仅 e2e 测试用，绕过 plugin atomic-write 走 fs 原子 rename）。
function writeChatHistoryAtomic(agentId, data) {
	const target = chatHistoryPath(agentId);
	const tmp = `${target}.e2e-tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
	fs.renameSync(tmp, target);
}

test('cron sessionKey guard: sessions.create with `agent:main:cron:<job>:run:<sid>` is filtered + main bucket unchanged', async () => {
	const beforeRaw = readChatHistory(AGENT_ID) ?? {};
	const beforeTopKeys = Object.keys(beforeRaw);
	const beforeMain = snapshot();
	// 每次 fresh 名字避免与历史残留撞 dedupe
	const cronKey = `agent:${AGENT_ID}:cron:e2e-job-${Date.now()}:run:fake-sid-${Date.now()}`;

	let res;
	try {
		res = rpcCall('sessions.create', { key: cronKey });
		assert.strictEqual(res.ok, true);
		assert.strictEqual(res.key, cronKey);
		await delay(HOOK_FLUSH_MS);

		// chat-history 顶级键集合应完全不变（cron 形态不入档）
		const afterRaw = readChatHistory(AGENT_ID) ?? {};
		const afterTopKeys = Object.keys(afterRaw);
		assert.deepStrictEqual(afterTopKeys.sort(), beforeTopKeys.sort(),
			'chat-history.json top-level keys must be unchanged');

		// 顶级键应该不出现任何 cron 形态
		const cronKeysInHistory = afterTopKeys.filter((k) => /^agent:[^:]+:cron:/.test(k));
		assert.deepStrictEqual(cronKeysInHistory, [],
			`cron sessionKeys should be filtered, found: ${JSON.stringify(cronKeysInHistory)}`);

		// main 桶整 list 完全不变
		const afterMain = snapshot();
		assert.deepStrictEqual(afterMain.list, beforeMain.list,
			'main bucket must be entirely unchanged by cron session create');
	} finally {
		// 清理：把测试创建的 cron session 删掉（不留 sessions.json 残留）。
		// 删失败也不挂——本测的核心断言已经过。
		if (res?.ok) {
			try { rpcCall('sessions.delete', { key: cronKey }); }
			catch { /* ignore */ }
		}
	}
});

test('__persist sanitize: pre-injected non-head unarchived entry gets archivedAt coerced on next reset', async () => {
	const testStart = Date.now();
	// 先 reset tester 一次，保证 tester 桶在 chat-history.json 里存在（避免 plugin 首次 load 时空 store）
	rpcCall('sessions.reset', { key: TESTER_KEY, reason: 'reset' });
	await delay(HOOK_FLUSH_MS);

	const before = snapshot(TESTER, TESTER_KEY);
	assert.ok(before.length >= 1, 'precondition: tester bucket should have at least head');

	// 注入一个 list[1] 缺 archivedAt 的脏 entry（模拟 cron 顶替/旧版本/异常 race 残留）
	const dirtySid = `e2e-dirty-${Date.now()}`;
	const raw = readChatHistory(TESTER);
	const list = raw[TESTER_KEY];
	// 在 head 之后插入脏 entry，让它落在 pos[1]（pos[1..] 应被 sanitize 修）
	list.splice(1, 0, { sessionId: dirtySid });
	writeChatHistoryAtomic(TESTER, raw);

	// 验证注入成功
	const injected = snapshot(TESTER, TESTER_KEY);
	assert.strictEqual(injected.archived[0]?.sessionId, dirtySid,
		'precondition: dirty entry should be at pos[1] after injection');
	assert.strictEqual(injected.archived[0]?.archivedAt, undefined,
		'precondition: dirty entry should lack archivedAt before sanitize');

	// 触发 tester reset → plugin recordSessionTransition → __persist → __sanitizeAllSessionKeys
	const res = rpcCall('sessions.reset', { key: TESTER_KEY, reason: 'reset' });
	assert.strictEqual(res.ok, true);
	const newSid = res.entry.sessionId;
	await delay(HOOK_FLUSH_MS);

	const after = snapshot(TESTER, TESTER_KEY);
	// 新 sid 头插 → length +1
	assert.strictEqual(after.length, injected.length + 1,
		'length should grow by 1 after reset');
	assert.strictEqual(after.head?.sessionId, newSid, 'new sid should be head');
	assert.strictEqual(after.head?.archivedAt, undefined, 'head should be unarchived');

	// 找到脏 entry 在新 list 里的位置（应该是 pos[2]：[newSid, oldHead-archived, dirty-now-archived, ...]）
	const dirtyEntry = after.list.find((it) => it?.sessionId === dirtySid);
	assert.ok(dirtyEntry, 'dirty entry should still be in list after sanitize');
	assert.strictEqual(typeof dirtyEntry.archivedAt, 'number',
		'sanitize should coerce missing archivedAt to a number');
	assertTimestampInWindow(dirtyEntry.archivedAt, testStart, 'dirty entry archivedAt');

	// 所有 pos[1..] 都应有 archivedAt（sanitize 全扫）
	const unarchivedNonHead = after.list.slice(1).filter((it) => it && !it.archivedAt);
	assert.deepStrictEqual(unarchivedNonHead, [],
		`all non-head entries should have archivedAt, found ${JSON.stringify(unarchivedNonHead)} unarchived`);
});

// gateway 重启型断言，必须放最后——重启过程中 gateway 短暂不可用，后续 test 无法继续。
test('reconcileAll on startup: pre-injected head/sessions.json divergence is reconciled after restart',
	{ timeout: 60000 },
	async () => {
		const testStart = Date.now();
		// reconcileAll 的真实输入是 sessions.json head sid，不是 chat-history head sid。
		// 必须直接读 sessions.json 取真 head，避免被前序 spec 残留的 chat-history fake head 干扰。
		const trueHeadSid = readSessionsHeadSid(AGENT_ID, SESSION_KEY);
		assert.ok(typeof trueHeadSid === 'string' && trueHeadSid,
			'precondition: sessions.json must have a head sid for main bucket');
		const before = snapshot();

		// 备份 chat-history.json（spec 失败时手工 restore 用），同步 dump baseline 便于事后比对
		const backupPath = nodePath.join(os.tmpdir(),
			`coclaw-chat-history-${AGENT_ID}.e2e-bak-${process.pid}-${Date.now()}.json`);
		const rawBefore = readChatHistory(AGENT_ID);
		fs.writeFileSync(backupPath, JSON.stringify(rawBefore, null, 2), 'utf8');

		// 模拟 cron 顶替的 chat-history 滞后场景：sessions.json head 已被 cron 换成新 sid，
		// chat-history head 仍指向旧 sid（cron_changed hook 漏发 / gateway 重启失同步）。
		// 等价做法：把 chat-history head 替换成一个 list 里没有的 fake sid（真 head 不在 list 中），
		// reconcileAll 喂 sessions.json head（真 head）进去时走 recordSessionTransition 一般路径：
		// 翻 fake 归档 + unshift 真 head 为新头。
		// 兼容：若前序 spec 失败留下了 trueHeadSid 在 list 其他位置（stale 防御未修齐），剔除以
		// 保证注入后真 head 不在 list 中。同时剔除既存的 e2e-fake-* 条目避免堆积。
		const fakeHeadSid = `e2e-fake-head-${Date.now()}`;
		rawBefore[SESSION_KEY] = rawBefore[SESSION_KEY]
			.filter((it) => it?.sessionId !== trueHeadSid
				&& !String(it?.sessionId ?? '').startsWith('e2e-fake-head-'));
		rawBefore[SESSION_KEY].unshift({ sessionId: fakeHeadSid });
		writeChatHistoryAtomic(AGENT_ID, rawBefore);

		// 验证注入成功
		const injected = snapshot();
		assert.strictEqual(injected.head?.sessionId, fakeHeadSid, 'precondition: fake head injected');
		assert.strictEqual(injected.head?.archivedAt, undefined,
			'precondition: fake head should be unarchived');
		assert.ok(!injected.list.some((it) => it?.sessionId === trueHeadSid),
			'precondition: true head sid should NOT be in chat-history list after replacement (cron eviction scenario)');

		// 重启 gateway → plugin register 触发 chatHistoryManager.load + listAllEntries + reconcileAll
		await restartGateway({ readyTimeoutMs: 45000 });
		await delay(1500); // 给 reconcileAll 一点时间跑完（fire-and-forget）

		const after = snapshot();

		// reconcileAll 看到 sessions.json head sid = trueHeadSid，与 chat-history head sid (fake) 不同
		// → recordSessionTransition 一般路径：翻 fake 归档（补 archivedAt） + unshift trueHead 为新头
		assert.strictEqual(after.head?.sessionId, trueHeadSid,
			'reconcileAll should restore the true head from sessions.json');
		assert.strictEqual(after.head?.archivedAt, undefined,
			'restored head must be unarchived');

		// fake sid 应已被翻档（pos[1] 含 archivedAt）+ archivedAt 落在测试窗内
		const fakeEntry = after.list.find((it) => it?.sessionId === fakeHeadSid);
		assert.ok(fakeEntry, 'fake sid should still be in list after reconcile');
		assert.strictEqual(typeof fakeEntry.archivedAt, 'number',
			'fake head should be archived after reconcile');
		assertTimestampInWindow(fakeEntry.archivedAt, testStart, 'fake head archivedAt');

		// 所有 pos[1..] 都应有 archivedAt（reconcile + sanitize 联合兜底）
		const unarchivedNonHead = after.list.slice(1).filter((it) => it && !it.archivedAt);
		assert.deepStrictEqual(unarchivedNonHead, [],
			`all non-head entries should have archivedAt after reconcile, found ${JSON.stringify(unarchivedNonHead)} unarchived`);

		// 备份文件留在 /tmp 便于事后审查；不主动删（spec 通过后保留几小时不影响磁盘）
		console.log(`[e2e-info] backup of chat-history.json saved to ${backupPath}`);
	});
