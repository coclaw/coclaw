import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../db/prisma.js';

const SCALAR_KEYS = ['theme', 'lang'];
const JSON_PATCH_KEYS = ['perfsPatch', 'uiStatePatch', 'hintCountsPatch'];

// JSON patch 字段 → 数据库列名
const JSON_COL_MAP = {
	perfsPatch: 'perfs',
	uiStatePatch: 'uiState',
	hintCountsPatch: 'hintCounts',
};

function buildJsonPatchSetSql(input) {
	const setSqlList = [];

	for (const key of JSON_PATCH_KEYS) {
		if (Object.hasOwn(input, key)) {
			const col = JSON_COL_MAP[key];
			setSqlList.push(
				Prisma.sql`${Prisma.raw(col)} = JSON_MERGE_PATCH(${Prisma.raw(col)}, CAST(${JSON.stringify(input[key])} AS JSON))`,
			);
		}
	}

	setSqlList.push(Prisma.sql`updatedAt = CURRENT_TIMESTAMP(3)`);
	return Prisma.join(setSqlList, Prisma.sql`, `);
}

function pickScalarData(input) {
	const data = {};
	for (const key of SCALAR_KEYS) {
		if (Object.hasOwn(input, key)) {
			data[key] = input[key];
		}
	}
	return data;
}

function hasJsonPatchFields(input) {
	return JSON_PATCH_KEYS.some((key) => Object.hasOwn(input, key));
}

export async function findUserSettingByUserId(userId, client = prisma) {
	return client.userSetting.findUnique({
		where: { userId },
	});
}

async function executeScalarUpdate(userId, scalarData, client = prisma) {
	try {
		await client.userSetting.update({
			where: { userId },
			data: scalarData,
		});
	} catch (err) {
		if (err.code === 'P2025') {
			throw new Error('User settings not found');
		}
		throw err;
	}
}

async function executeJsonPatchRaw(userId, input, client = prisma) {
	const setSql = buildJsonPatchSetSql(input);
	const affectedRows = await client.$executeRaw(
		Prisma.sql`UPDATE UserSetting SET ${setSql} WHERE userId = ${userId}`,
	);
	if (affectedRows !== 1) {
		throw new Error('User settings not found');
	}
}

export async function patchUserSettingByUserId(userId, input, client = prisma) {
	const scalarData = pickScalarData(input);
	const hasScalar = Object.keys(scalarData).length > 0;
	const hasJson = hasJsonPatchFields(input);

	if (hasScalar && hasJson) {
		await client.$transaction(async (tx) => {
			await executeScalarUpdate(userId, scalarData, tx);
			await executeJsonPatchRaw(userId, input, tx);
		});
	} else if (hasScalar) {
		await executeScalarUpdate(userId, scalarData, client);
	} else if (hasJson) {
		await executeJsonPatchRaw(userId, input, client);
	}

	return findUserSettingByUserId(userId, client);
}
