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
