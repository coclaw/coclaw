import { prisma } from '../db/prisma.js';

export async function findBindingCode(code, db = prisma) {
	return db.botBindingCode.findUnique({
		where: { code },
	});
}

export async function createBindingCode(data, db = prisma) {
	return db.botBindingCode.create({
		data,
	});
}

export async function updateBindingCode(code, data, db = prisma) {
	return db.botBindingCode.update({
		where: { code },
		data,
	});
}

export async function deleteBindingCode(code, db = prisma) {
	return db.botBindingCode.delete({
		where: { code },
	});
}
