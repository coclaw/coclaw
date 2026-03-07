import { prisma } from '../db/prisma.js';

export async function findLocalAuthByLoginName(loginName) {
	return prisma.localAuth.findUnique({
		where: { loginName },
		include: {
			user: {
				include: {
					externalAuths: {
						select: {
							oauthType: true,
							oauthName: true,
							oauthAvatar: true,
						},
					},
					userSetting: true,
				},
			},
		},
	});
}

export async function touchLocalLoginSuccess(userId) {
	const now = new Date();
	await prisma.$transaction([
		prisma.user.update({
			where: { id: userId },
			data: { lastLoginAt: now },
		}),
		prisma.localAuth.update({
			where: { userId },
			data: { lastLoginAt: now },
		}),
	]);
}

export async function findLocalAuthByUserId(userId, db = prisma) {
	return db.localAuth.findUnique({
		where: { userId },
	});
}

export async function updatePasswordByUserId(userId, passwordHash, db = prisma) {
	try {
		return await db.localAuth.update({
			where: { userId },
			data: {
				passwordHash,
				passwordUpdatedAt: new Date(),
			},
		});
	}
	catch (err) {
		if (err.code === 'P2025') {
			throw new Error('Local auth not found');
		}
		throw err;
	}
}

export async function createLocalUserByLoginName({ userId, loginName, passwordHash }) {
	return prisma.user.create({
		data: {
			id: userId,
			userSetting: {
				create: {},
			},
			localAuth: {
				create: {
					loginName,
					passwordHash,
					passwordUpdatedAt: new Date(),
				},
			},
		},
		include: {
			localAuth: true,
		},
	});
}
