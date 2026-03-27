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
		select: { id: true, name: true, lastLoginAt: true },
	});
	return rows.map(u => ({ ...u, id: u.id.toString() }));
}

export async function countBots(db = prisma) {
	return db.bot.count();
}
