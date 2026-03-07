import { prisma } from '../db/prisma.js';

export async function findUserById(id) {
	return prisma.user.findUnique({
		where: { id },
	});
}

export async function findUserProfileById(id) {
	return findUserProfileByIdWithOptions(id, {
		includeSettings: true,
	});
}

export async function findUserProfileByIdWithOptions(id, options = {}) {
	const { includeSettings = false } = options;
	return prisma.user.findUnique({
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

export async function updateUserProfileById(id, input) {
	const data = {};
	if (Object.hasOwn(input, 'name')) {
		data.name = input.name;
	}
	if (Object.hasOwn(input, 'avatar')) {
		data.avatar = input.avatar;
	}

	return prisma.user.update({
		where: { id },
		data,
	});
}
