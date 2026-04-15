import { prisma } from '../db/prisma.js';

export async function countUsers(db = prisma) {
	return db.user.count();
}

export async function countUsersCreatedSince(date, db = prisma) {
	return db.user.count({ where: { createdAt: { gte: date } } });
}

export async function countUsersActiveSince(date, db = prisma) {
	return db.user.count({ where: { lastLoginAt: { gte: date } } });
}

export async function topActiveUsers(limit, db = prisma) {
	const rows = await db.user.findMany({
		where: { lastLoginAt: { not: null } },
		orderBy: { lastLoginAt: 'desc' },
		take: limit,
		select: {
			id: true,
			name: true,
			lastLoginAt: true,
			localAuth: { select: { loginName: true } },
		},
	});
	return rows.map(u => ({
		id: u.id.toString(),
		name: u.name,
		loginName: u.localAuth?.loginName ?? null,
		lastLoginAt: u.lastLoginAt,
	}));
}

export async function latestRegisteredUsers(limit, db = prisma) {
	const rows = await db.user.findMany({
		orderBy: { createdAt: 'desc' },
		take: limit,
		select: { id: true, name: true, createdAt: true, localAuth: { select: { loginName: true } } },
	});
	return rows.map(u => ({
		id: u.id.toString(),
		name: u.name,
		loginName: u.localAuth?.loginName ?? null,
		createdAt: u.createdAt,
	}));
}

export async function countClaws(db = prisma) {
	return db.claw.count();
}

export async function countClawsCreatedSince(date, db = prisma) {
	return db.claw.count({ where: { createdAt: { gte: date } } });
}

export async function latestBoundClaws(limit, db = prisma) {
	const rows = await db.claw.findMany({
		orderBy: { createdAt: 'desc' },
		take: limit,
		select: {
			id: true,
			name: true,
			createdAt: true,
			user: { select: { name: true } },
		},
	});
	return rows.map(c => ({
		id: c.id.toString(),
		name: c.name,
		userName: c.user?.name ?? null,
		createdAt: c.createdAt,
	}));
}

// limit 在 repo 层归一化到 [1, 100]，避免下游空切片陷阱
function normalizeLimit(limit) {
	return Math.max(1, Math.min(Number(limit) || 50, 100));
}

function buildPageQuery(baseQuery, cursor, take) {
	const q = { ...baseQuery, take: take + 1 };
	if (cursor) {
		q.cursor = { id: BigInt(cursor) };
		q.skip = 1;
	}
	return q;
}

function sliceForCursor(rows, take) {
	const hasMore = rows.length > take;
	const items = hasMore ? rows.slice(0, take) : rows;
	return { items, hasMore };
}

export async function listClawsPaginated({ cursor, limit, search } = {}, db = prisma) {
	const take = normalizeLimit(limit);
	const where = search ? { name: { contains: search } } : undefined;
	const base = {
		where,
		orderBy: { id: 'desc' },
		select: {
			id: true,
			name: true,
			hostName: true,
			pluginVersion: true,
			agentModels: true,
			createdAt: true,
			lastSeenAt: true,
			user: {
				select: {
					id: true,
					name: true,
					localAuth: { select: { loginName: true } },
				},
			},
		},
	};
	const rows = await db.claw.findMany(buildPageQuery(base, cursor, take));
	const { items, hasMore } = sliceForCursor(rows, take);
	const mapped = items.map(c => ({
		id: c.id.toString(),
		name: c.name,
		hostName: c.hostName,
		pluginVersion: c.pluginVersion,
		agentModels: c.agentModels ?? null,
		userId: c.user?.id != null ? c.user.id.toString() : null,
		userName: c.user?.name ?? null,
		userLoginName: c.user?.localAuth?.loginName ?? null,
		createdAt: c.createdAt,
		lastSeenAt: c.lastSeenAt,
	}));
	return {
		items: mapped,
		nextCursor: hasMore ? mapped[mapped.length - 1].id : null,
	};
}

export async function listUsersPaginated({ cursor, limit, search } = {}, db = prisma) {
	const take = normalizeLimit(limit);
	const where = search
		? {
			OR: [
				{ name: { contains: search } },
				{ localAuth: { loginName: { contains: search } } },
			],
		}
		: undefined;
	const base = {
		where,
		orderBy: { id: 'desc' },
		select: {
			id: true,
			name: true,
			avatar: true,
			createdAt: true,
			lastLoginAt: true,
			localAuth: { select: { loginName: true } },
			_count: { select: { claws: true } },
		},
	};
	const rows = await db.user.findMany(buildPageQuery(base, cursor, take));
	const { items, hasMore } = sliceForCursor(rows, take);
	const mapped = items.map(u => ({
		id: u.id.toString(),
		name: u.name,
		loginName: u.localAuth?.loginName ?? null,
		avatar: u.avatar,
		clawCount: u._count?.claws ?? 0,
		createdAt: u.createdAt,
		lastLoginAt: u.lastLoginAt,
	}));
	return {
		items: mapped,
		nextCursor: hasMore ? mapped[mapped.length - 1].id : null,
	};
}
