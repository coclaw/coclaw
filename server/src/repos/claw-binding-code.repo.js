import { prisma } from '../db/prisma.js';

export async function findBindingCode(code, db = prisma) {
	return db.clawBindingCode.findUnique({
		where: { code },
	});
}

export async function createBindingCode(data, db = prisma) {
	return db.clawBindingCode.create({
		data,
	});
}

export async function updateBindingCode(code, data, db = prisma) {
	return db.clawBindingCode.update({
		where: { code },
		data,
	});
}

export async function deleteBindingCode(code, db = prisma) {
	return db.clawBindingCode.delete({
		where: { code },
	});
}
