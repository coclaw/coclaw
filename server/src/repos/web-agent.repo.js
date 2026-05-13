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
 * 返回可见的全部 Web Agent
 * - userId 非空：系统预置 + 该用户自建，附带 lastClickedAt / hiddenAt
 * - userId 为 null（匿名）：仅系统预置，lastClickedAt / hiddenAt 固定为 null
 * @param {bigint|null} userId
 */
export async function findAllForUser(userId, db = prisma) {
	if (userId == null) {
		const agents = await db.webAgent.findMany({
			where: { userId: null },
		});
		return agents.map(a => ({
			id: a.id,
			slug: a.slug,
			name: a.name,
			url: a.url,
			sort: a.sort,
			lastClickedAt: null,
			hiddenAt: null,
		}));
	}
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
				select: { lastClickedAt: true, hiddenAt: true },
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
		hiddenAt: a.clicks[0]?.hiddenAt ?? null,
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
 * 累加一次点击：clickCount += 1、lastClickedAt = now、hiddenAt 清空
 * 复合主键 upsert 的 where key 是 `userId_webAgentId`（prisma 自动 camelCase 拼接）
 * 再次点击会自动取消之前的"从最近列表移除"：update 分支显式将 hiddenAt 写为 null
 */
export async function incrementClick({ userId, webAgentId, now = new Date() }, db = prisma) {
	return db.webAgentClick.upsert({
		where: { userId_webAgentId: { userId, webAgentId } },
		update: {
			clickCount: { increment: 1 },
			lastClickedAt: now,
			hiddenAt: null,
		},
		create: {
			userId,
			webAgentId,
			clickCount: 1,
			lastClickedAt: now,
		},
	});
}

/**
 * 将 hiddenAt 标记为现在时刻；不存在的点击记录不会凭空 INSERT
 * @returns 受影响的行数（0 表示该用户从未点击过此 Agent）
 */
export async function setHiddenNow({ userId, webAgentId, now = new Date() }, db = prisma) {
	const result = await db.webAgentClick.updateMany({
		where: { userId, webAgentId },
		data: { hiddenAt: now },
	});
	return result.count;
}
