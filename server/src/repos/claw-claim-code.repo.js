import { prisma } from '../db/prisma.js';

export async function findClaimCode(code) {
	return prisma.clawClaimCode.findUnique({
		where: { code },
	});
}

export async function createClaimCode(data) {
	return prisma.clawClaimCode.create({
		data,
	});
}

export async function deleteClaimCode(code) {
	return prisma.clawClaimCode.delete({
		where: { code },
	});
}
