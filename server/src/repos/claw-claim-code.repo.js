import { prisma } from '../db/prisma.js';

export async function findClaimCode(code, db = prisma) {
	return db.clawClaimCode.findUnique({
		where: { code },
	});
}

export async function createClaimCode(data, db = prisma) {
	return db.clawClaimCode.create({
		data,
	});
}

export async function deleteClaimCode(code, db = prisma) {
	return db.clawClaimCode.delete({
		where: { code },
	});
}
