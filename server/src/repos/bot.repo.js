import { prisma } from '../db/prisma.js';

export async function findBotById(id, db = prisma) {
	return db.bot.findUnique({
		where: { id },
	});
}

export async function findLatestBotByUserId(userId, db = prisma) {
	return db.bot.findFirst({
		where: { userId },
		orderBy: {
			updatedAt: 'desc',
		},
	});
}

export async function findBotByTokenHash(tokenHash, db = prisma) {
	return db.bot.findUnique({
		where: { tokenHash },
		select: {
			id: true,
			userId: true,
		},
	});
}

export async function createBot(data, db = prisma) {
	return db.bot.create({
		data,
	});
}

export async function updateBot(id, data, db = prisma) {
	return db.bot.update({
		where: { id },
		data,
	});
}

export async function updateBotName(id, name, db = prisma) {
	return db.bot.update({
		where: { id },
		data: { name },
	});
}

export async function deleteBot(id, db = prisma) {
	return db.bot.delete({
		where: { id },
	});
}

export async function listBotsByUserId(userId, db = prisma) {
	return db.bot.findMany({
		where: { userId },
		orderBy: {
			createdAt: 'desc',
		},
	});
}
