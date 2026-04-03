import { prisma } from '../db/prisma.js';

export async function findUserById(id, db = prisma) {
	return db.user.findUnique({
		where: { id },
	});
}

export async function findUserProfileById(id, db = prisma) {
	return findUserProfileByIdWithOptions(id, {
		includeSettings: true,
	}, db);
}

export async function findUserProfileByIdWithOptions(id, options = {}, db = prisma) {
	const { includeSettings = false } = options;
	return db.user.findUnique({
		where: { id },
		include: {
			localAuth: {
				select: {
					loginName: true,
				},
			},
			externalAuths: {
				select: {
					oauthType: true,
					oauthName: true,
					oauthAvatar: true,
				},
			},
			userSetting: includeSettings,
		},
	});
}

export async function updateUserProfileById(id, input, db = prisma) {
	const data = {};
	if (Object.hasOwn(input, 'name')) {
		data.name = input.name;
	}
	if (Object.hasOwn(input, 'avatar')) {
		data.avatar = input.avatar;
	}

	return db.user.update({
		where: { id },
		data,
	});
}
