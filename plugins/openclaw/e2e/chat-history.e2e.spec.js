// chat-history 归档 + subagent 过滤端到端。
// 前置：gateway running + 当前 plugin 已 link 到 stage。
// 跑法：`pnpm run e2e`（plugin 工作区）。
// 注意：e2e 会真改你机器上的 chat-history.json —— 本机务必是测试环境，
//       不要在你重要的工作 chat 上跑。

import test, { before } from 'node:test';
import assert from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { rpcCall, runAgent, restartGateway } from './lib/gateway-rpc.js';
import { readChatHistory, readEntries } from './lib/chat-history.js';

const AGENT_ID = 'main';
const SESSION_KEY = `agent:${AGENT_ID}:main`;
// hook 是 fire-and-forget——RPC 返回 ≠ chat-history.json 写完。
// 实测 plugin 通常 50ms 内完成，留点冗余。
const HOOK_FLUSH_MS = 150;

function snapshot() {
	const list = readEntries(AGENT_ID, SESSION_KEY);
	return {
		length: list.length,
		head: list[0],
		archived: list.slice(1),
	};
}

// 跑一次 dummy reset 做 warmup：链路重启（pnpm run link）后 plugin 可能短期内
// 同时存在新旧 ESM 实例（CLAUDE.md 第 1119 行硬约束 + TODO F5 隐患 B）。
// 先吃掉一次让残留 hook drain，避免后续断言被多余写淹没。
before(async () => {
	rpcCall('sessions.reset', { key: SESSION_KEY, reason: 'reset' });
	await delay(500);
});

test('reset reason=reset: head→pos[1], length+1', async () => {
	const before = snapshot();
	const res = rpcCall('sessions.reset', { key: SESSION_KEY, reason: 'reset' });
	assert.strictEqual(res.ok, true);
	const newSid = res.entry.sessionId;
	await delay(HOOK_FLUSH_MS);

	const after = snapshot();
	assert.strictEqual(after.length, before.length + 1, 'length should grow by 1');
	assert.strictEqual(after.head.sessionId, newSid, 'new sid should be head');
	assert.strictEqual(after.head.archivedAt, undefined, 'head should be unarchived');
	if (before.head) {
		assert.strictEqual(after.archived[0].sessionId, before.head.sessionId,
			'previous head should move to pos[1]');
		assert.ok(after.archived[0].archivedAt > 0,
			'previous head should now carry archivedAt');
	}
});

test('reset reason=new: same shape as reason=reset', async () => {
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
	assert.ok(after.archived[0].archivedAt > 0);
});

test('5 consecutive resets: length+5, archived segment strictly desc by archivedAt', async () => {
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

	// 这次循环刚归档的 5 段（pos[1]..pos[5]）应严格按 archivedAt desc。
	// 更早的历史段允许有存量乱序（pre-existing），不在断言里。
	const freshTimestamps = after.archived.slice(0, 5).map((e) => e.archivedAt);
	for (let i = 1; i < freshTimestamps.length; i++) {
		assert.ok(freshTimestamps[i - 1] > freshTimestamps[i],
			`archivedAt[${i - 1}]=${freshTimestamps[i - 1]} should be > [${i}]=${freshTimestamps[i]}`);
	}

	// 反序回查 5 个 sid 是否按头插顺序落在 pos[1..5]
	const expectedSlots = newSids.slice(0, 4).reverse(); // newSids[3], [2], [1], [0]
	const actualSlots = after.archived.slice(0, 4).map((e) => e.sessionId);
	assert.deepStrictEqual(actualSlots, expectedSlots,
		'freshly archived sids should occupy pos[1..4] in head-insert order');
});

test('multi-agent isolation: reset on tester does not touch main bucket', async () => {
	const TESTER = 'tester';
	const TESTER_KEY = `agent:${TESTER}:main`;
	const mainBefore = snapshot();

	const res = rpcCall('sessions.reset', { key: TESTER_KEY, reason: 'reset' });
	assert.strictEqual(res.ok, true);
	const testerNewSid = res.entry.sessionId;
	await delay(HOOK_FLUSH_MS);

	// main bucket should be unchanged
	const mainAfter = snapshot();
	assert.strictEqual(mainAfter.length, mainBefore.length,
		'main bucket length should not change when reseting a different agent');
	assert.strictEqual(mainAfter.head?.sessionId, mainBefore.head?.sessionId,
		'main head should not change');

	// tester bucket should carry the new sid as unarchived head
	const testerList = readEntries(TESTER, TESTER_KEY);
	const testerHead = testerList[0];
	assert.strictEqual(testerHead?.sessionId, testerNewSid,
		'tester bucket should head-insert the new sid');
	assert.strictEqual(testerHead?.archivedAt, undefined,
		'tester head should be unarchived');
});

test('explicit fake sessionKey: sessions.create with `agent:main:explicit:<uuid>` is filtered', async () => {
	const beforeKeys = Object.keys(readChatHistory(AGENT_ID) ?? {});
	const fakeUuid = '00000000-1111-2222-3333-aaaabbbbcccc';
	const explicitKey = `agent:${AGENT_ID}:explicit:${fakeUuid}`;

	const res = rpcCall('sessions.create', { key: explicitKey });
	assert.strictEqual(res.ok, true);
	assert.strictEqual(res.key, explicitKey);
	await delay(HOOK_FLUSH_MS);

	const afterKeys = Object.keys(readChatHistory(AGENT_ID) ?? {});
	const newKeys = afterKeys.filter((k) => !beforeKeys.includes(k));
	assert.deepStrictEqual(newKeys, [],
		`explicit sessionKey should be filtered, found new keys: ${JSON.stringify(newKeys)}`);
});

test('subagent spawn: chat-history.json top-level keys unchanged, subagent sessionKey filtered', { timeout: 90000 }, async () => {
	const beforeFile = readEntries(AGENT_ID, SESSION_KEY);
	const beforeKeys = Object.keys(readChatHistory(AGENT_ID) ?? {});

	const result = runAgent(
		'请使用 Task 工具创建一个子代理来回答：1+1 等于几？把子代理的回答原样返回给我。',
		{ timeoutSec: 60 },
	);
	// agent run 跑成功就行——不要求模型一定调对了 Task，但通常会调
	assert.ok(result?.ok !== false, 'agent run should not hard-fail');
	await delay(HOOK_FLUSH_MS);

	const afterKeys = Object.keys(readChatHistory(AGENT_ID) ?? {});
	// 最关键的断言：顶级键不应新增任何 `agent:<id>:subagent:<uuid>` 形态
	const newKeys = afterKeys.filter((k) => !beforeKeys.includes(k));
	const subagentKeys = newKeys.filter((k) => /^agent:[^:]+:subagent:/.test(k));
	assert.deepStrictEqual(subagentKeys, [],
		`subagent sessionKeys should be filtered, found: ${JSON.stringify(subagentKeys)}`);

	// main agent 的 entries 可以变（主对话 run 可能 reset 出新 session），
	// 也可以不变——这取决于模型是否在主链路里 reset 了 session。
	// 我们不强断言增量，只断言"main 桶仍然存在且未被 subagent 形态覆盖"。
	const afterMain = readEntries(AGENT_ID, SESSION_KEY);
	assert.ok(Array.isArray(afterMain) && afterMain.length >= beforeFile.length,
		'main bucket should still be present and non-shrinking');
});

// 韧性测试：systemd restart 模拟 plugin 进程被打断。验证 atomic-write 落盘。
// 放最后一个 test —— 重启过程中 gateway 短暂不可用，后续 test 无法继续。
test('gateway restart: chat-history.json survives plugin process termination (atomic write)', { timeout: 60000 }, async () => {
	const before = snapshot();
	const res = rpcCall('sessions.reset', { key: SESSION_KEY, reason: 'reset' });
	assert.strictEqual(res.ok, true);
	const newSid = res.entry.sessionId;
	await delay(HOOK_FLUSH_MS);

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

	// 文件应是 valid JSON 且没有半截写碎片
	const raw = readChatHistory(AGENT_ID);
	assert.ok(raw && typeof raw === 'object', 'chat-history.json should be parsable');
	assert.strictEqual(typeof raw.version, 'number', 'version field should be intact');
});
