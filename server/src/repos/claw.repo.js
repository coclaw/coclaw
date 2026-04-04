import { prisma } from '../db/prisma.js';

export async function findClawById(id, db = prisma) {
	return db.claw.findUnique({
		where: { id },
	});
}

export async function findLatestClawByUserId(userId, db = prisma) {
	return db.claw.findFirst({
		where: { userId },
		orderBy: {
			updatedAt: 'desc',
		},
	});
}

export async function findClawByTokenHash(tokenHash, db = prisma) {
	return db.claw.findUnique({
		where: { tokenHash },
		select: {
			id: true,
			userId: true,
		},
	});
}

export async function createClaw(data, db = prisma) {
	return db.claw.create({
		data,
	});
}

export async function updateClaw(id, data, db = prisma) {
	return db.claw.update({
		where: { id },
		data,
	});
}

export async function updateClawName(id, name, db = prisma) {
	return db.claw.update({
		where: { id },
		data: { name },
	});
}

export async function deleteClaw(id, db = prisma) {
	return db.claw.delete({
		where: { id },
	});
}

export async function listClawsByUserId(userId, db = prisma) {
	return db.claw.findMany({
		where: { userId },
		orderBy: {
			createdAt: 'desc',
		},
	});
}
