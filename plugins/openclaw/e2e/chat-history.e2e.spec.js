// chat-history 归档 + subagent 过滤端到端。
// 前置：gateway running + 当前 plugin 已 link 到 stage。
// 跑法：`pnpm run e2e`（plugin 工作区）。
// 注意：e2e 会真改你机器上的 chat-history.json —— 本机务必是测试环境，
//       不要在你重要的工作 chat 上跑。

import test, { before } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { rpcCall, runAgent, restartGateway } from './lib/gateway-rpc.js';
import { readChatHistory, readEntries } from './lib/chat-history.js';

const AGENT_ID = 'main';
const SESSION_KEY = `agent:${AGENT_ID}:main`;
// hook 是 fire-and-forget——RPC 返回 ≠ chat-history.json 写完。
// 实测 plugin 通常 50ms 内完成，留点冗余。
const HOOK_FLUSH_MS = 150;

function snapshot(agentId = AGENT_ID, sessionKey = SESSION_KEY) {
	const list = readEntries(agentId, sessionKey);
	return {
		list, // 完整 entries（含 head 与 archived 段），用于 deepStrictEqual 整体不变断言
		length: list.length,
		head: list[0],
		archived: list.slice(1),
	};
}

// archivedAt 是 plugin 在 hook 命中时打的 Date.now()。
// 断言 timestamp 在测试本身时间窗内，能挡住"复用旧 archivedAt 没更新"这种漏档。
function assertTimestampInWindow(ts, startTime, label) {
	assert.ok(typeof ts === 'number', `${label}: expected number, got ${typeof ts}`);
	const upper = Date.now() + 1000; // 兜底 clock skew
	assert.ok(ts >= startTime && ts <= upper,
		`${label}: archivedAt=${ts} not in [${startTime}, ${upper}]`);
}

// 跑一次 dummy reset 做 warmup：链路重启（pnpm run link）后 plugin 可能短期内
// 同时存在新旧 ESM 实例（CLAUDE.md 第 1119 行硬约束 + TODO F5 隐患 B）。
// 先吃掉一次让残留 hook drain，避免后续断言被多余写淹没。
before(async () => {
	rpcCall('sessions.reset', { key: SESSION_KEY, reason: 'reset' });
	await delay(500);
});

test('reset reason=reset: head→pos[1], length+1, older history untouched', async () => {
	const testStart = Date.now();
	const before = snapshot();
	const res = rpcCall('sessions.reset', { key: SESSION_KEY, reason: 'reset' });
	assert.strictEqual(res.ok, true);
	const newSid = res.entry.sessionId;
	await delay(HOOK_FLUSH_MS);

	const after = snapshot();
	assert.strictEqual(after.length, before.length + 1, 'length should grow by 1');
	assert.strictEqual(after.head.sessionId, newSid, 'new sid should be head');
	assert.strictEqual(after.head.archivedAt, undefined, 'head should be unarchived');
	assert.ok(before.head, 'precondition: before.head must exist (warmup ensures this)');
	assert.strictEqual(after.archived[0].sessionId, before.head.sessionId,
		'previous head should move to pos[1]');
	assertTimestampInWindow(after.archived[0].archivedAt, testStart, 'previous head archivedAt');
	// archived[1..] 必须等于 before.archived（更早的归档段不能动）
	assert.deepStrictEqual(after.archived.slice(1), before.archived,
		'older archived tail must be unchanged');
});

test('reset reason=new: same shape as reason=reset, older history untouched', async () => {
	const testStart = Date.now();
	const before = snapshot();
	const res = rpcCall('sessions.reset', { key: SESSION_KEY, reason: 'new' });
	assert.strictEqual(res.ok, true);
	const newSid = res.entry.sessionId;
	await delay(HOOK_FLUSH_MS);

	const after = snapshot();
	assert.strictEqual(after.length, before.length + 1);
	assert.strictEqual(after.head.sessionId, newSid);
	assert.strictEqual(after.head.archivedAt, undefined);
	assert.strictEqual(after.archived[0].sessionId, before.head.sessionId);
	assertTimestampInWindow(after.archived[0].archivedAt, testStart, 'previous head archivedAt');
	assert.deepStrictEqual(after.archived.slice(1), before.archived,
		'older archived tail must be unchanged');
});

test('5 consecutive resets: length+5, fresh segment desc + before.head at pos[5], older tail untouched', async () => {
	const testStart = Date.now();
	const before = snapshot();
	const newSids = [];
	for (let i = 0; i < 5; i++) {
		const res = rpcCall('sessions.reset', { key: SESSION_KEY, reason: 'reset' });
		assert.strictEqual(res.ok, true);
		newSids.push(res.entry.sessionId);
		await delay(HOOK_FLUSH_MS);
	}

	const after = snapshot();
	assert.strictEqual(after.length, before.length + 5,
		'length should grow by exactly 5');
	assert.strictEqual(after.head.sessionId, newSids[4],
		'head should be the last reset sid');
	assert.strictEqual(after.head.archivedAt, undefined, 'head must be unarchived');

	// 刚归档的 5 个 sid 在 pos[1]..pos[5]，按头插顺序倒序：newSids[3], [2], [1], [0], before.head
	// 注：第 5 次 reset 把 newSids[3] 翻档放 pos[1]、把 newSids[4] 放 head；
	//     第 1 次 reset 翻 before.head 放 pos[1]，被后续 reset 推到 pos[5]。
	const expectedFreshSids = [...newSids.slice(0, 4).reverse(), before.head.sessionId];
	const actualFreshSids = after.archived.slice(0, 5).map((e) => e.sessionId);
	assert.deepStrictEqual(actualFreshSids, expectedFreshSids,
		'pos[1..5] should be [newSids[3..0] reverse + before.head]');

	// 这 5 个新归档 timestamp 都应落在测试窗口内 + 严格 desc
	const freshTimestamps = after.archived.slice(0, 5).map((e) => e.archivedAt);
	for (let i = 0; i < freshTimestamps.length; i++) {
		assertTimestampInWindow(freshTimestamps[i], testStart, `pos[${i + 1}] archivedAt`);
		if (i > 0) {
			assert.ok(freshTimestamps[i - 1] > freshTimestamps[i],
				`archivedAt[${i - 1}]=${freshTimestamps[i - 1]} should be > [${i}]=${freshTimestamps[i]}`);
		}
	}

	// pos[6..] 必须等于 before.archived（更早的归档段一字不动）
	assert.deepStrictEqual(after.archived.slice(5), before.archived,
		'older archived tail must be unchanged');
});

test('multi-agent isolation: reset on tester leaves main bucket entirely unchanged', async () => {
	const TESTER = 'tester';
	const TESTER_KEY = `agent:${TESTER}:main`;
	const mainBefore = snapshot();

	const res = rpcCall('sessions.reset', { key: TESTER_KEY, reason: 'reset' });
	assert.strictEqual(res.ok, true);
	const testerNewSid = res.entry.sessionId;
	await delay(HOOK_FLUSH_MS);

	// main 桶必须**整个 list**逐项不变（不止 head / length）
	const mainAfter = snapshot();
	assert.deepStrictEqual(mainAfter.list, mainBefore.list,
		'main bucket must be entirely unchanged when resetting a different agent');

	// tester 桶应该把新 sid 头插
	const testerList = readEntries(TESTER, TESTER_KEY);
	const testerHead = testerList[0];
	assert.strictEqual(testerHead?.sessionId, testerNewSid,
		'tester bucket should head-insert the new sid');
	assert.strictEqual(testerHead?.archivedAt, undefined,
		'tester head should be unarchived');
});

test('explicit fake sessionKey: sessions.create with `agent:main:explicit:<uuid>` is filtered + main bucket unchanged', async () => {
	const mainBefore = snapshot();
	const beforeRaw = readChatHistory(AGENT_ID) ?? {};
	const beforeKeys = Object.keys(beforeRaw);
	// 每次 fresh uuid，避免多次跑 e2e 复用同一 key 触发 OpenClaw 内部 dedupe
	const explicitKey = `agent:${AGENT_ID}:explicit:${randomUUID()}`;

	const res = rpcCall('sessions.create', { key: explicitKey });
	assert.strictEqual(res.ok, true);
	assert.strictEqual(res.key, explicitKey);
	await delay(HOOK_FLUSH_MS);

	// 顶级键集合必须完全相同（不增不减）
	const afterRaw = readChatHistory(AGENT_ID) ?? {};
	const afterKeys = Object.keys(afterRaw);
	assert.deepStrictEqual(afterKeys.sort(), beforeKeys.sort(),
		'chat-history.json top-level keys must be unchanged');

	// main 桶整 list 必须完全相同（explicit session 不能"顺手"动 main）
	const mainAfter = snapshot();
	assert.deepStrictEqual(mainAfter.list, mainBefore.list,
		'main bucket must be entirely unchanged by explicit session create');
});

test('subagent spawn: model actually invokes sessions_spawn, subagent sessionKey is filtered', { timeout: 90000 }, async () => {
	const beforeFile = readEntries(AGENT_ID, SESSION_KEY);
	const beforeKeys = Object.keys(readChatHistory(AGENT_ID) ?? {});

	const agentRes = runAgent(
		'请使用 Task 工具创建一个子代理来回答：1+1 等于几？把子代理的回答原样返回给我。',
		{ timeoutSec: 60 },
	);

	// **关键前置断言**：必须确认模型真的调了 sessions_spawn 工具。
	// 没调说明 prompt 没诱发 subagent spawn → 守卫根本没被触发 → 测试结论无效。
	const toolsUsed = agentRes?.result?.meta?.toolSummary?.tools ?? [];
	assert.ok(toolsUsed.includes('sessions_spawn'),
		`subagent never spawned — test inconclusive. tools used: ${JSON.stringify(toolsUsed)}`);
	await delay(HOOK_FLUSH_MS);

	// 顶级键不应出现 subagent 形态
	const afterKeys = Object.keys(readChatHistory(AGENT_ID) ?? {});
	const newKeys = afterKeys.filter((k) => !beforeKeys.includes(k));
	const subagentKeys = newKeys.filter((k) => /^agent:[^:]+:subagent:/.test(k));
	assert.deepStrictEqual(subagentKeys, [],
		`subagent sessionKeys should be filtered, found: ${JSON.stringify(subagentKeys)}`);

	// main 桶仍然存在；主对话 run 内部可能 reset 出新 session，因此允许 non-shrinking。
	// 不强断言整 list 相等——agent run 是主对话流，理论上 length 可能 +1（compaction-retry 等）。
	const afterMain = readEntries(AGENT_ID, SESSION_KEY);
	assert.ok(Array.isArray(afterMain) && afterMain.length >= beforeFile.length,
		'main bucket should still be present and non-shrinking');
});

// 韧性测试：reset 写完落盘后重启 plugin，验证已持久化数据完整。
// 放最后一个 test —— 重启过程中 gateway 短暂不可用，后续 test 无法继续。
// 注意：本测试**不**覆盖"atomic-write 在写入中途崩"的极端场景——那需要精确
// 控制 race window，不在 e2e 范围。atomic-write 行为本身由单测兜底（覆盖
// `__persist` 异常路径 / EEXIST tmp 文件等边界）。
test('gateway restart: persisted chat-history.json survives plugin restart', { timeout: 60000 }, async () => {
	const before = snapshot();
	const res = rpcCall('sessions.reset', { key: SESSION_KEY, reason: 'reset' });
	assert.strictEqual(res.ok, true);
	const newSid = res.entry.sessionId;
	await delay(HOOK_FLUSH_MS); // 等 hook 写完落盘

	await restartGateway({ readyTimeoutMs: 45000 });
	// gateway 起来后给 plugin register + bridge connect 留一点时间
	await delay(1000);

	const after = snapshot();
	assert.strictEqual(after.length, before.length + 1,
		'length should be persisted across restart');
	assert.strictEqual(after.head.sessionId, newSid,
		'new sid should still be unarchived head after restart');
	assert.strictEqual(after.head.archivedAt, undefined,
		'head should remain unarchived');

	// 文件应是 valid JSON
	const raw = readChatHistory(AGENT_ID);
	assert.ok(raw && typeof raw === 'object', 'chat-history.json should be parsable');
	assert.strictEqual(typeof raw.version, 'number', 'version field should be intact');
});
