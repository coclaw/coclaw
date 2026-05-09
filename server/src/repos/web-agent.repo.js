import { prisma } from '../db/prisma.js';
import { PRESETS, validatePresets } from './web-agent.presets.js';

/**
 * 启动时按 slug 双向同步预置清单
 * - 清单外的预置项（连同对应 WebAgentClick）级联删除
 * - 清单内的项 upsert（重启幂等）
 * - WHERE 限定 userId IS NULL，绝不误删用户自建条目
 */
export async function syncPresets({ presets = PRESETS, db = prisma } = {}) {
	validatePresets(presets);
	const slugs = presets.map(p => p.slug);

	await db.webAgent.deleteMany({
		where: {
			userId: null,
			slug: { notIn: slugs },
		},
	});

	for (const p of presets) {
		await db.webAgent.upsert({
			where: { slug: p.slug },
			update: { name: p.name, url: p.url, sort: p.sort },
			create: { slug: p.slug, name: p.name, url: p.url, sort: p.sort, userId: null },
		});
	}
}

/**
 * 返回当前用户可见的全部 Web Agent（系统预置 + 该用户自建）+ 该用户的 lastClickedAt
 * @param {bigint} userId
 */
export async function findAllForUser(userId, db = prisma) {
	const agents = await db.webAgent.findMany({
		where: {
			OR: [
				{ userId: null },
				{ userId },
			],
		},
		include: {
			clicks: {
				where: { userId },
				select: { lastClickedAt: true },
			},
		},
	});
	return agents.map(a => ({
		id: a.id,
		slug: a.slug,
		name: a.name,
		url: a.url,
		sort: a.sort,
		lastClickedAt: a.clicks[0]?.lastClickedAt ?? null,
	}));
}

/**
 * 校验某 webAgentId 对当前用户是否可见（系统预置或该用户自建）
 * @returns 命中时返回 id，否则返回 null
 */
export async function findVisibleAgentId({ userId, webAgentId }, db = prisma) {
	const agent = await db.webAgent.findFirst({
		where: {
			id: webAgentId,
			OR: [
				{ userId: null },
				{ userId },
			],
		},
		select: { id: true },
	});
	return agent?.id ?? null;
}

/**
 * 累加一次点击：clickCount += 1、lastClickedAt = now
 * 复合主键 upsert 的 where key 是 `userId_webAgentId`（prisma 自动 camelCase 拼接）
 */
export async function incrementClick({ userId, webAgentId, now = new Date() }, db = prisma) {
	return db.webAgentClick.upsert({
		where: { userId_webAgentId: { userId, webAgentId } },
		update: {
			clickCount: { increment: 1 },
			lastClickedAt: now,
		},
		create: {
			userId,
			webAgentId,
			clickCount: 1,
			lastClickedAt: now,
		},
	});
}
