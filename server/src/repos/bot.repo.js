import { prisma } from '../db/prisma.js';

export async function findBotById(id) {
	return prisma.bot.findUnique({
		where: { id },
	});
}

export async function findLatestBotByUserId(userId) {
	return prisma.bot.findFirst({
		where: { userId },
		orderBy: {
			updatedAt: 'desc',
		},
	});
}

export async function findBotByTokenHash(tokenHash) {
	return prisma.bot.findUnique({
		where: { tokenHash },
		select: {
			id: true,
			userId: true,
		},
	});
}

export async function createBot(data) {
	return prisma.bot.create({
		data,
	});
}

export async function updateBot(id, data) {
	return prisma.bot.update({
		where: { id },
		data,
	});
}

export async function updateBotName(id, name) {
	return prisma.bot.update({
		where: { id },
		data: { name },
	});
}

export async function updateBotAlias(id, alias) {
	return prisma.bot.update({
		where: { id },
		data: { alias },
	});
}

export async function deleteBot(id) {
	return prisma.bot.delete({
		where: { id },
	});
}

export async function listBotsByUserId(userId) {
	return prisma.bot.findMany({
		where: { userId },
		orderBy: {
			createdAt: 'desc',
		},
	});
}
