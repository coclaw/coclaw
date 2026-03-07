import { prisma } from '../db/prisma.js';

export async function findBindingCode(code) {
	return prisma.botBindingCode.findUnique({
		where: { code },
	});
}

export async function createBindingCode(data) {
	return prisma.botBindingCode.create({
		data,
	});
}

export async function updateBindingCode(code, data) {
	return prisma.botBindingCode.update({
		where: { code },
		data,
	});
}

export async function deleteBindingCode(code) {
	return prisma.botBindingCode.delete({
		where: { code },
	});
}
