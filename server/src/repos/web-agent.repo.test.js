import assert from 'node:assert/strict';
import test from 'node:test';

import {
	syncPresets,
	findAllForUser,
	findVisibleAgentId,
	incrementClick,
	setHiddenNow,
} from './web-agent.repo.js';

// 简易 MySQL/Prisma 模拟：模型 webAgent + webAgentClick 记忆数据，按 slug 唯一约束模拟
function makeFakeDb() {
	const state = {
		agents: [],          // {id, userId, slug, name, url, sort}
		clicks: [],          // {userId, webAgentId, clickCount, lastClickedAt, hiddenAt}
		nextId: 1,
	};
	const trace = { calls: [] };

	function findAgentBySlug(slug) {
		return state.agents.find(a => a.slug === slug) ?? null;
	}

	function deleteAgent(id) {
		// 级联清空对应 click 记录
		state.agents = state.agents.filter(a => a.id !== id);
		state.clicks = state.clicks.filter(c => c.webAgentId !== id);
	}

	const db = {
		webAgent: {
			deleteMany: async (args) => {
				trace.calls.push({ method: 'webAgent.deleteMany', args });
				const where = args?.where ?? {};
				const remove = state.agents.filter((a) => {
					if (where.userId !== undefined && a.userId !== where.userId) return false;
					if (where.slug?.notIn) {
						return !where.slug.notIn.includes(a.slug);
					}
					return true;
				});
				for (const a of remove) {
					deleteAgent(a.id);
				}
				return { count: remove.length };
			},
			upsert: async (args) => {
				trace.calls.push({ method: 'webAgent.upsert', args });
				const slug = args.where.slug;
				const existing = findAgentBySlug(slug);
				if (existing) {
					Object.assign(existing, args.update);
					return existing;
				}
				const created = {
					id: state.nextId++,
					userId: args.create.userId ?? null,
					slug: args.create.slug,
					name: args.create.name,
					url: args.create.url,
					sort: args.create.sort ?? null,
				};
				state.agents.push(created);
				return created;
			},
			findMany: async (args) => {
				trace.calls.push({ method: 'webAgent.findMany', args });
				const where = args.where;
				const includeClicks = args.include?.clicks;
				return state.agents
					.filter((a) => {
						const ors = where?.OR ?? [];
						if (ors.length === 0) return true;
						return ors.some((cond) => {
							if (cond.userId === null) return a.userId === null;
							if (cond.userId !== undefined) return a.userId === cond.userId;
							return false;
						});
					})
					.map(a => ({
						...a,
						clicks: includeClicks
							? state.clicks
								.filter(c => c.webAgentId === a.id && c.userId === includeClicks.where.userId)
								.map(c => ({ lastClickedAt: c.lastClickedAt, hiddenAt: c.hiddenAt ?? null }))
							: undefined,
					}));
			},
			findFirst: async (args) => {
				trace.calls.push({ method: 'webAgent.findFirst', args });
				const id = args.where.id;
				const ors = args.where.OR ?? [];
				const found = state.agents.find((a) => {
					if (a.id !== id) return false;
					if (ors.length === 0) return true;
					return ors.some((cond) => {
						if (cond.userId === null) return a.userId === null;
						if (cond.userId !== undefined) return a.userId === cond.userId;
						return false;
					});
				});
				if (!found) return null;
				return { id: found.id };
			},
		},
		webAgentClick: {
			upsert: async (args) => {
				trace.calls.push({ method: 'webAgentClick.upsert', args });
				const { userId, webAgentId } = args.where.userId_webAgentId;
				const existing = state.clicks.find(c => c.userId === userId && c.webAgentId === webAgentId);
				if (existing) {
					if (args.update.clickCount?.increment) {
						existing.clickCount += args.update.clickCount.increment;
					}
					if (args.update.lastClickedAt) {
						existing.lastClickedAt = args.update.lastClickedAt;
					}
					if (Object.prototype.hasOwnProperty.call(args.update, 'hiddenAt')) {
						existing.hiddenAt = args.update.hiddenAt;
					}
					return existing;
				}
				const created = {
					userId,
					webAgentId,
					clickCount: args.create.clickCount ?? 0,
					lastClickedAt: args.create.lastClickedAt ?? new Date(),
					hiddenAt: args.create.hiddenAt ?? null,
				};
				state.clicks.push(created);
				return created;
			},
			updateMany: async (args) => {
				trace.calls.push({ method: 'webAgentClick.updateMany', args });
				const where = args?.where ?? {};
				const matched = state.clicks.filter((c) => {
					if (where.userId !== undefined && c.userId !== where.userId) return false;
					if (where.webAgentId !== undefined && c.webAgentId !== where.webAgentId) return false;
					return true;
				});
				for (const c of matched) {
					if (Object.prototype.hasOwnProperty.call(args.data, 'hiddenAt')) {
						c.hiddenAt = args.data.hiddenAt;
					}
				}
				return { count: matched.length };
			},
		},
	};

	return { db, state, trace };
}

// 直接注入预置数据（绕过 syncPresets，便于测试 findAllForUser）
function seedAgent(state, agent) {
	state.agents.push({
		id: state.nextId++,
		userId: null,
		slug: null,
		name: '',
		url: '',
		sort: null,
		...agent,
	});
}

function seedClick(state, click) {
	state.clicks.push({
		clickCount: 1,
		lastClickedAt: new Date(),
		hiddenAt: null,
		...click,
	});
}

// ------- syncPresets -------

test('syncPresets: 空 DB 时 upsert 全部预置', async () => {
	const { db, state, trace } = makeFakeDb();
	const presets = [
		{ slug: 'a', name: 'A', url: 'https://a/', sort: 1 },
		{ slug: 'b', name: 'B', url: 'https://b/', sort: 2 },
	];

	await syncPresets({ presets, db });

	assert.equal(state.agents.length, 2);
	const slugs = state.agents.map(a => a.slug).sort();
	assert.deepEqual(slugs, ['a', 'b']);
	for (const a of state.agents) {
		assert.equal(a.userId, null);
	}
	// 调用顺序：先 deleteMany 后 upsert 序列
	assert.equal(trace.calls[0].method, 'webAgent.deleteMany');
	assert.equal(trace.calls[1].method, 'webAgent.upsert');
});

test('syncPresets: 跑两次结果一致（idempotent）', async () => {
	const { db, state } = makeFakeDb();
	const presets = [
		{ slug: 'a', name: 'A', url: 'https://a/', sort: 1 },
		{ slug: 'b', name: 'B', url: 'https://b/', sort: 2 },
	];

	await syncPresets({ presets, db });
	const ids1 = state.agents.map(a => a.id).sort();
	await syncPresets({ presets, db });
	const ids2 = state.agents.map(a => a.id).sort();

	assert.deepEqual(ids1, ids2);
	assert.equal(state.agents.length, 2);
});

test('syncPresets: 已有 DB 项的 name/url/sort 改动会被 update', async () => {
	const { db, state } = makeFakeDb();
	seedAgent(state, { slug: 'a', name: 'old name', url: 'https://old/', sort: 9 });

	await syncPresets({
		presets: [{ slug: 'a', name: 'new name', url: 'https://new/', sort: 1 }],
		db,
	});

	const agent = state.agents.find(x => x.slug === 'a');
	assert.equal(agent.name, 'new name');
	assert.equal(agent.url, 'https://new/');
	assert.equal(agent.sort, 1);
});

test('syncPresets: 从清单移除某条 → DB 中该条与其点击记录被级联清空', async () => {
	const { db, state } = makeFakeDb();
	seedAgent(state, { slug: 'a', name: 'A', url: 'https://a/', sort: 1 });
	seedAgent(state, { slug: 'b', name: 'B', url: 'https://b/', sort: 2 });
	const bId = state.agents.find(a => a.slug === 'b').id;
	seedClick(state, { userId: 100n, webAgentId: bId });
	seedClick(state, { userId: 101n, webAgentId: bId });

	await syncPresets({
		presets: [{ slug: 'a', name: 'A', url: 'https://a/', sort: 1 }],
		db,
	});

	assert.deepEqual(state.agents.map(a => a.slug), ['a']);
	// b 的点击记录已被级联清空
	assert.equal(state.clicks.filter(c => c.webAgentId === bId).length, 0);
});

test('syncPresets: 不会误删用户自建（userId IS NOT NULL）的条目', async () => {
	const { db, state } = makeFakeDb();
	seedAgent(state, { slug: 'a', name: 'A', url: 'https://a/', sort: 1 });
	seedAgent(state, { userId: 200n, slug: null, name: 'My GPT', url: 'https://my/', sort: null });

	await syncPresets({
		presets: [{ slug: 'a', name: 'A', url: 'https://a/', sort: 1 }],
		db,
	});

	const userBuilt = state.agents.find(a => a.userId === 200n);
	assert.ok(userBuilt, 'user-built agent should remain');
	assert.equal(userBuilt.name, 'My GPT');
});

test('syncPresets: 重复 slug 抛错（在删除/upsert 前 fail-fast）', async () => {
	const { db, state } = makeFakeDb();
	seedAgent(state, { slug: 'kept', name: 'X', url: 'https://x/', sort: 0 });
	const presets = [
		{ slug: 'a', name: 'A', url: 'https://a/', sort: 1 },
		{ slug: 'a', name: 'B', url: 'https://b/', sort: 2 },
	];

	await assert.rejects(
		() => syncPresets({ presets, db }),
		/duplicate preset slug: a/,
	);
	// fail-fast：DB 状态未变
	assert.equal(state.agents.length, 1);
	assert.equal(state.agents[0].slug, 'kept');
});

test('syncPresets: 字段缺失抛错（fail-fast）', async () => {
	const { db, state } = makeFakeDb();
	seedAgent(state, { slug: 'kept', name: 'X', url: 'https://x/', sort: 0 });

	await assert.rejects(
		() => syncPresets({
			presets: [{ slug: 'a', name: 'A', sort: 1 }], // 缺 url
			db,
		}),
		/invalid preset/,
	);
	assert.equal(state.agents.length, 1);
});

test('syncPresets: 默认参数（无 args）使用模块 PRESETS 与单例 prisma — 触发 deleteMany 被注入 db 拒绝', async () => {
	// 验证 default-arg 分支：传 db 但不传 presets
	const { db, state } = makeFakeDb();
	await syncPresets({ db });
	// 默认 PRESETS 共 5 项
	assert.equal(state.agents.length, 5);
});

test('syncPresets: presets=[] 时清空所有预置且保留用户自建', async () => {
	// 全下架边界：清单清空 = 所有预置被删除（含级联清空 click），但用户自建条目不受影响
	const { db, state } = makeFakeDb();
	seedAgent(state, { slug: 'a', name: 'A', url: 'https://a/', sort: 1 });
	seedAgent(state, { slug: 'b', name: 'B', url: 'https://b/', sort: 2 });
	seedAgent(state, { userId: 200n, slug: null, name: 'My', url: 'https://m/', sort: null });
	const aId = state.agents.find(a => a.slug === 'a').id;
	seedClick(state, { userId: 100n, webAgentId: aId });

	await syncPresets({ presets: [], db });

	// 预置全清空，含级联清空 click
	assert.equal(state.agents.filter(a => a.userId === null).length, 0);
	assert.equal(state.clicks.filter(c => c.webAgentId === aId).length, 0);
	// 用户自建保留
	const userBuilt = state.agents.find(a => a.userId === 200n);
	assert.ok(userBuilt, 'user-built agent should remain');
	assert.equal(userBuilt.name, 'My');
});

// ------- findAllForUser -------

test('findAllForUser: 返回预置 + 该用户自建，含未点过的 lastClickedAt=null', async () => {
	const { db, state } = makeFakeDb();
	seedAgent(state, { slug: 'a', name: 'A', url: 'https://a/', sort: 1 });
	seedAgent(state, { slug: 'b', name: 'B', url: 'https://b/', sort: 2 });
	seedAgent(state, { userId: 200n, slug: null, name: 'Mine', url: 'https://m/', sort: null });
	seedAgent(state, { userId: 201n, slug: null, name: 'NotMine', url: 'https://n/', sort: null });

	const items = await findAllForUser(200n, db);

	const slugs = items.map(i => i.slug ?? `mine:${i.name}`).sort();
	assert.deepEqual(slugs, ['a', 'b', 'mine:Mine']);
	for (const i of items) {
		assert.equal(i.lastClickedAt, null);
	}
});

test('findAllForUser: 点过的项 lastClickedAt 来自 clicks[0]', async () => {
	const { db, state } = makeFakeDb();
	seedAgent(state, { slug: 'a', name: 'A', url: 'https://a/', sort: 1 });
	const aId = state.agents[0].id;
	const clickedAt = new Date('2026-05-01T10:00:00Z');
	seedClick(state, { userId: 100n, webAgentId: aId, lastClickedAt: clickedAt });

	const items = await findAllForUser(100n, db);

	assert.equal(items.length, 1);
	assert.equal(items[0].slug, 'a');
	assert.equal(items[0].lastClickedAt.getTime(), clickedAt.getTime());
});

test('findAllForUser: 别人的点击记录不会泄露到当前用户的结果', async () => {
	const { db, state } = makeFakeDb();
	seedAgent(state, { slug: 'a', name: 'A', url: 'https://a/', sort: 1 });
	const aId = state.agents[0].id;
	seedClick(state, { userId: 999n, webAgentId: aId, lastClickedAt: new Date('2026-05-01') });

	const items = await findAllForUser(100n, db);

	assert.equal(items.length, 1);
	assert.equal(items[0].lastClickedAt, null);
});

test('findAllForUser: 字段顺序与设计一致（id/slug/name/url/sort/lastClickedAt/hiddenAt）', async () => {
	const { db, state } = makeFakeDb();
	seedAgent(state, { slug: 'a', name: 'A', url: 'https://a/', sort: 1 });

	const items = await findAllForUser(100n, db);

	assert.deepEqual(Object.keys(items[0]), ['id', 'slug', 'name', 'url', 'sort', 'lastClickedAt', 'hiddenAt']);
});

test('findAllForUser: hiddenAt 三态 — 没点过=null、点过未藏=null、点过已藏=Date', async () => {
	const { db, state } = makeFakeDb();
	seedAgent(state, { slug: 'a', name: 'A', url: 'https://a/', sort: 1 }); // 没点过
	seedAgent(state, { slug: 'b', name: 'B', url: 'https://b/', sort: 2 }); // 点过未藏
	seedAgent(state, { slug: 'c', name: 'C', url: 'https://c/', sort: 3 }); // 点过已藏
	const aId = state.agents.find(x => x.slug === 'a').id;
	const bId = state.agents.find(x => x.slug === 'b').id;
	const cId = state.agents.find(x => x.slug === 'c').id;
	seedClick(state, { userId: 100n, webAgentId: bId });
	const hiddenAt = new Date('2026-05-09T08:00:00Z');
	seedClick(state, { userId: 100n, webAgentId: cId, hiddenAt });

	const items = await findAllForUser(100n, db);

	const byId = Object.fromEntries(items.map(i => [i.id, i]));
	assert.equal(byId[aId].hiddenAt, null);
	assert.equal(byId[bId].hiddenAt, null);
	assert.equal(byId[cId].hiddenAt.getTime(), hiddenAt.getTime());
});

// ------- findVisibleAgentId -------

test('findVisibleAgentId: 命中预置返回 id', async () => {
	const { db, state } = makeFakeDb();
	seedAgent(state, { slug: 'a', name: 'A', url: 'https://a/', sort: 1 });
	const id = state.agents[0].id;

	const got = await findVisibleAgentId({ userId: 100n, webAgentId: id }, db);
	assert.equal(got, id);
});

test('findVisibleAgentId: 命中当前用户自建返回 id', async () => {
	const { db, state } = makeFakeDb();
	seedAgent(state, { userId: 100n, slug: null, name: 'Mine', url: 'https://m/', sort: null });
	const id = state.agents[0].id;

	const got = await findVisibleAgentId({ userId: 100n, webAgentId: id }, db);
	assert.equal(got, id);
});

test('findVisibleAgentId: 命中别人自建返回 null', async () => {
	const { db, state } = makeFakeDb();
	seedAgent(state, { userId: 999n, slug: null, name: 'NotMine', url: 'https://n/', sort: null });
	const id = state.agents[0].id;

	const got = await findVisibleAgentId({ userId: 100n, webAgentId: id }, db);
	assert.equal(got, null);
});

test('findVisibleAgentId: 不存在 id 返回 null', async () => {
	const { db } = makeFakeDb();
	const got = await findVisibleAgentId({ userId: 100n, webAgentId: 9999 }, db);
	assert.equal(got, null);
});

// ------- incrementClick -------

test('incrementClick: 首次点击 create clickCount=1', async () => {
	const { db, state } = makeFakeDb();

	await incrementClick({ userId: 100n, webAgentId: 1 }, db);

	assert.equal(state.clicks.length, 1);
	assert.equal(state.clicks[0].clickCount, 1);
	assert.equal(state.clicks[0].userId, 100n);
	assert.equal(state.clicks[0].webAgentId, 1);
});

test('incrementClick: 重复点击 increment clickCount + 刷新 lastClickedAt', async () => {
	const { db, state } = makeFakeDb();
	seedClick(state, {
		userId: 100n,
		webAgentId: 1,
		clickCount: 5,
		lastClickedAt: new Date('2026-01-01T00:00:00Z'),
	});

	const newAt = new Date('2026-05-01T10:00:00Z');
	await incrementClick({ userId: 100n, webAgentId: 1, now: newAt }, db);

	assert.equal(state.clicks.length, 1);
	assert.equal(state.clicks[0].clickCount, 6);
	assert.equal(state.clicks[0].lastClickedAt.getTime(), newAt.getTime());
});

test('incrementClick: where 使用复合主键 userId_webAgentId 拼接', async () => {
	const { db, trace } = makeFakeDb();
	await incrementClick({ userId: 100n, webAgentId: 1 }, db);
	const upsertCall = trace.calls.find(c => c.method === 'webAgentClick.upsert');
	assert.deepEqual(upsertCall.args.where.userId_webAgentId, { userId: 100n, webAgentId: 1 });
});

test('incrementClick: 已隐藏的行再次点击会清空 hiddenAt（"再点取消隐藏"）', async () => {
	const { db, state } = makeFakeDb();
	seedClick(state, {
		userId: 100n,
		webAgentId: 1,
		clickCount: 3,
		lastClickedAt: new Date('2026-04-01T00:00:00Z'),
		hiddenAt: new Date('2026-05-01T00:00:00Z'),
	});

	const newAt = new Date('2026-05-09T10:00:00Z');
	await incrementClick({ userId: 100n, webAgentId: 1, now: newAt }, db);

	assert.equal(state.clicks[0].clickCount, 4);
	assert.equal(state.clicks[0].lastClickedAt.getTime(), newAt.getTime());
	assert.equal(state.clicks[0].hiddenAt, null);
});

test('incrementClick: 首次点击 create 分支 hiddenAt 默认 null', async () => {
	const { db, state } = makeFakeDb();
	await incrementClick({ userId: 100n, webAgentId: 1 }, db);
	assert.equal(state.clicks.length, 1);
	assert.equal(state.clicks[0].hiddenAt, null);
});

test('incrementClick: 连续 3 次后 clickCount=3、lastClickedAt 取最后一次', async () => {
	const { db, state } = makeFakeDb();
	const t1 = new Date('2026-05-09T10:00:00Z');
	const t2 = new Date('2026-05-09T10:01:00Z');
	const t3 = new Date('2026-05-09T10:02:00Z');

	await incrementClick({ userId: 100n, webAgentId: 1, now: t1 }, db);
	await incrementClick({ userId: 100n, webAgentId: 1, now: t2 }, db);
	await incrementClick({ userId: 100n, webAgentId: 1, now: t3 }, db);

	assert.equal(state.clicks.length, 1);
	assert.equal(state.clicks[0].clickCount, 3);
	assert.equal(state.clicks[0].lastClickedAt.getTime(), t3.getTime());
});

// ------- setHiddenNow -------

test('setHiddenNow: 命中现有 click 行刷 hiddenAt 并返回 1', async () => {
	const { db, state } = makeFakeDb();
	seedClick(state, { userId: 100n, webAgentId: 1, clickCount: 2 });

	const t = new Date('2026-05-09T10:00:00Z');
	const affected = await setHiddenNow({ userId: 100n, webAgentId: 1, now: t }, db);

	assert.equal(affected, 1);
	assert.equal(state.clicks[0].hiddenAt.getTime(), t.getTime());
	// 不影响其它字段
	assert.equal(state.clicks[0].clickCount, 2);
});

test('setHiddenNow: 不存在的 click 行返回 0，不会凭空 INSERT', async () => {
	const { db, state } = makeFakeDb();
	const affected = await setHiddenNow({ userId: 100n, webAgentId: 1 }, db);
	assert.equal(affected, 0);
	assert.equal(state.clicks.length, 0);
});

test('setHiddenNow: 重复隐藏 → 每次刷成最新时间，幂等', async () => {
	const { db, state } = makeFakeDb();
	seedClick(state, { userId: 100n, webAgentId: 1 });
	const t1 = new Date('2026-05-01T00:00:00Z');
	const t2 = new Date('2026-05-09T10:00:00Z');

	const a1 = await setHiddenNow({ userId: 100n, webAgentId: 1, now: t1 }, db);
	const a2 = await setHiddenNow({ userId: 100n, webAgentId: 1, now: t2 }, db);

	assert.equal(a1, 1);
	assert.equal(a2, 1);
	assert.equal(state.clicks[0].hiddenAt.getTime(), t2.getTime());
});

test('setHiddenNow: where 仅命中当前 (userId, webAgentId) 一行，不殃及别人或别的 Agent', async () => {
	const { db, state } = makeFakeDb();
	seedClick(state, { userId: 100n, webAgentId: 1 });
	seedClick(state, { userId: 100n, webAgentId: 2 }); // 同人不同 agent
	seedClick(state, { userId: 200n, webAgentId: 1 }); // 同 agent 不同人

	await setHiddenNow({ userId: 100n, webAgentId: 1 }, db);

	const r1 = state.clicks.find(c => c.userId === 100n && c.webAgentId === 1);
	const r2 = state.clicks.find(c => c.userId === 100n && c.webAgentId === 2);
	const r3 = state.clicks.find(c => c.userId === 200n && c.webAgentId === 1);
	assert.ok(r1.hiddenAt instanceof Date);
	assert.equal(r2.hiddenAt, null);
	assert.equal(r3.hiddenAt, null);
});

// ------- scenario: 真实用户流（共享 fake DB 串测，验证多函数协作的端到端语义） -------

test('scenario: 用户首次 GET → 5 项预置全 lastClickedAt=null', async () => {
	// 模拟 server 启动 syncPresets + 新用户首次 GET
	const { db } = makeFakeDb();
	await syncPresets({ db });

	const items = await findAllForUser(100n, db);

	assert.equal(items.length, 5);
	for (const i of items) {
		assert.equal(i.lastClickedAt, null);
	}
});

test('scenario: 点击 deepseek 后 GET → 仅该项 lastClickedAt 非 null，其它仍 null', async () => {
	const { db } = makeFakeDb();
	await syncPresets({ db });

	// 找到 deepseek 的 id
	const before = await findAllForUser(100n, db);
	const deepseek = before.find(i => i.slug === 'deepseek');
	assert.ok(deepseek);

	const t = new Date('2026-05-09T10:00:00Z');
	await incrementClick({ userId: 100n, webAgentId: deepseek.id, now: t }, db);

	const after = await findAllForUser(100n, db);
	for (const i of after) {
		if (i.slug === 'deepseek') {
			assert.equal(i.lastClickedAt.getTime(), t.getTime());
		}
		else {
			assert.equal(i.lastClickedAt, null);
		}
	}
});

test('scenario: 用户 A 点击 → 用户 B 的视图完全不变', async () => {
	const { db } = makeFakeDb();
	await syncPresets({ db });
	const items = await findAllForUser(100n, db); // 任意用户都拿得到预置 id 列表
	const target = items[0];

	await incrementClick({ userId: 100n, webAgentId: target.id }, db);

	const aView = await findAllForUser(100n, db);
	const bView = await findAllForUser(200n, db);
	assert.ok(aView.find(i => i.id === target.id).lastClickedAt != null, 'A should see updated lastClickedAt');
	for (const i of bView) {
		assert.equal(i.lastClickedAt, null, `B should not see A's clicks (${i.slug})`);
	}
});

test('scenario: 用户 A 自建对用户 B 完全不可见', async () => {
	const { db, state } = makeFakeDb();
	await syncPresets({ db });
	// A 自建一条
	seedAgent(state, { userId: 100n, slug: null, name: 'A custom', url: 'https://a-custom/', sort: null });

	const aView = await findAllForUser(100n, db);
	const bView = await findAllForUser(200n, db);

	assert.equal(aView.length, 6);
	assert.ok(aView.find(i => i.name === 'A custom'));
	assert.equal(bView.length, 5);
	assert.equal(bView.find(i => i.name === 'A custom'), undefined);
});

test('scenario: 移除某 preset 后再次出现同 slug → 新 row 新 id，原 click 已被级联清空', async () => {
	const { db, state } = makeFakeDb();
	const v1 = [
		{ slug: 'a', name: 'A v1', url: 'https://a/', sort: 1 },
		{ slug: 'b', name: 'B v1', url: 'https://b/', sort: 2 },
	];
	await syncPresets({ presets: v1, db });
	const aIdV1 = state.agents.find(a => a.slug === 'a').id;
	await incrementClick({ userId: 100n, webAgentId: aIdV1 }, db);

	// 第二轮：移除 a（顺便保留 b 排除"全清"路径的干扰）
	const v2 = [{ slug: 'b', name: 'B v1', url: 'https://b/', sort: 2 }];
	await syncPresets({ presets: v2, db });
	assert.equal(state.agents.find(a => a.slug === 'a'), undefined);
	// 级联清空验证
	assert.equal(state.clicks.length, 0);

	// 第三轮：又把 a 加回来
	const v3 = [
		{ slug: 'a', name: 'A v3', url: 'https://a-new/', sort: 9 },
		{ slug: 'b', name: 'B v1', url: 'https://b/', sort: 2 },
	];
	await syncPresets({ presets: v3, db });
	const aRow = state.agents.find(a => a.slug === 'a');
	assert.ok(aRow);
	// 新 id（fake DB 自增不复用）
	assert.notEqual(aRow.id, aIdV1);
	assert.equal(aRow.name, 'A v3');
	assert.equal(aRow.url, 'https://a-new/');
	// 原 click 没"复活"——属于已清空状态
	assert.equal(state.clicks.length, 0);

	// 用户重新点击 → 从 1 开始
	await incrementClick({ userId: 100n, webAgentId: aRow.id }, db);
	assert.equal(state.clicks[0].clickCount, 1);
	assert.equal(state.clicks[0].webAgentId, aRow.id);
});

test('scenario: 用户点击 → 隐藏 → 再点击 → hiddenAt 自动清空（端到端"再点取消隐藏"）', async () => {
	const { db } = makeFakeDb();
	await syncPresets({ db });

	const before = await findAllForUser(100n, db);
	const target = before.find(i => i.slug === 'deepseek');
	assert.ok(target);

	// 1) 第一次点击
	await incrementClick({ userId: 100n, webAgentId: target.id, now: new Date('2026-05-09T09:00:00Z') }, db);
	let view = await findAllForUser(100n, db);
	assert.equal(view.find(i => i.id === target.id).hiddenAt, null);

	// 2) 隐藏
	const hideAt = new Date('2026-05-09T09:30:00Z');
	const affected = await setHiddenNow({ userId: 100n, webAgentId: target.id, now: hideAt }, db);
	assert.equal(affected, 1);
	view = await findAllForUser(100n, db);
	assert.equal(view.find(i => i.id === target.id).hiddenAt.getTime(), hideAt.getTime());

	// 3) 再次点击 → hiddenAt 被清空
	const reclickAt = new Date('2026-05-09T10:00:00Z');
	await incrementClick({ userId: 100n, webAgentId: target.id, now: reclickAt }, db);
	view = await findAllForUser(100n, db);
	const after = view.find(i => i.id === target.id);
	assert.equal(after.hiddenAt, null);
	assert.equal(after.lastClickedAt.getTime(), reclickAt.getTime());
});

test('scenario: syncPresets 改了 preset name/url 但保留已存在的 click 历史', async () => {
	const { db, state } = makeFakeDb();
	const v1 = [{ slug: 'a', name: 'A v1', url: 'https://a/', sort: 1 }];
	await syncPresets({ presets: v1, db });
	const aId = state.agents.find(a => a.slug === 'a').id;
	const t = new Date('2026-05-09T10:00:00Z');
	await incrementClick({ userId: 100n, webAgentId: aId, now: t }, db);
	assert.equal(state.clicks.length, 1);

	// 同 slug，改了 name + url + sort
	const v2 = [{ slug: 'a', name: 'A v2', url: 'https://a-new/', sort: 99 }];
	await syncPresets({ presets: v2, db });

	// 同一 row（id 不变）
	const aRowAfter = state.agents.find(a => a.slug === 'a');
	assert.equal(aRowAfter.id, aId);
	assert.equal(aRowAfter.name, 'A v2');
	assert.equal(aRowAfter.url, 'https://a-new/');
	assert.equal(aRowAfter.sort, 99);

	// click 行整数无变化
	assert.equal(state.clicks.length, 1);
	assert.equal(state.clicks[0].clickCount, 1);
	assert.equal(state.clicks[0].lastClickedAt.getTime(), t.getTime());

	// 用户 GET 看到新 name/url 但 lastClickedAt 仍是旧时间
	const items = await findAllForUser(100n, db);
	const aItem = items.find(i => i.slug === 'a');
	assert.equal(aItem.name, 'A v2');
	assert.equal(aItem.url, 'https://a-new/');
	assert.equal(aItem.lastClickedAt.getTime(), t.getTime());
});
