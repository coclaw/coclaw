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
			bots: { select: { id: true } },
		},
	});
	return rows.map(u => ({
		id: u.id.toString(),
		name: u.name,
		loginName: u.localAuth?.loginName ?? null,
		lastLoginAt: u.lastLoginAt,
		botCount: u.bots.length,
		onlineBotIds: u.bots.map(b => b.id.toString()),
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

export async function countBots(db = prisma) {
	return db.bot.count();
}

export async function countBotsCreatedSince(date, db = prisma) {
	return db.bot.count({ where: { createdAt: { gte: date } } });
}

export async function listBots(limit = 50, db = prisma) {
	const rows = await db.bot.findMany({
		orderBy: { lastSeenAt: 'desc' },
		take: limit,
		select: {
			id: true,
			name: true,
			lastSeenAt: true,
			createdAt: true,
			user: { select: { id: true, name: true, localAuth: { select: { loginName: true } } } },
		},
	});
	return rows.map(b => ({
		id: b.id.toString(),
		name: b.name,
		lastSeenAt: b.lastSeenAt,
		createdAt: b.createdAt,
		userId: b.user.id.toString(),
		userName: b.user.name,
		userLoginName: b.user.localAuth?.loginName ?? null,
	}));
}
