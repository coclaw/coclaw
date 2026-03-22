import {
	createLocalUserByLoginName,
	findLocalAuthByLoginName,
	findLocalAuthByUserId,
	touchLocalLoginSuccess,
	updatePasswordByUserId,
} from '../repos/local-auth.repo.js';
import { genUserId } from './id.svc.js';
import { scrypt } from '../utils/scrypt-password.js';
import { buildSessionUser } from './user-view.svc.js';
import { validateLoginName } from '../validators/login-name.js';
import { validatePassword } from '../validators/password.js';

function buildAuthPayload(localAuth, overrides = {}) {
	return buildSessionUser({
		id: localAuth.user.id,
		name: localAuth.user.name,
		avatar: localAuth.user.avatar,
		level: localAuth.user.level,
		locked: localAuth.user.locked,
		lastLoginAt: localAuth.user.lastLoginAt ?? null,
		localAuth: {
			loginName: localAuth.loginName,
		},
		externalAuths: localAuth.user.externalAuths ?? [],
		userSetting: localAuth.user.userSetting,
		...overrides,
	}, {
		authType: 'local',
	});
}

function isNonEmptyString(value) {
	return typeof value === 'string' && value.trim() !== '';
}

export async function loginByLoginName(input, deps = {}) {
	const {
		scryptImpl = scrypt,
		findByLoginName = findLocalAuthByLoginName,
		touchLoginSuccess = touchLocalLoginSuccess,
	} = deps;
	const { loginName, password } = input;

	if (!isNonEmptyString(loginName) || !isNonEmptyString(password)) {
		return {
			ok: false,
			code: 'INVALID_INPUT',
			message: 'loginName and password are required',
		};
	}

	const localAuth = await findByLoginName(loginName);
	if (!localAuth || !localAuth.user || !localAuth.passwordHash) {
		return {
			ok: false,
			code: 'INVALID_CREDENTIALS',
			message: 'Invalid credentials',
		};
	}

	if (localAuth.locked || localAuth.user.locked) {
		return {
			ok: false,
			code: 'ACCOUNT_LOCKED',
			message: 'Account is locked',
		};
	}

	const isMatch = await scryptImpl.verifyPassword(password, localAuth.passwordHash);
	if (!isMatch) {
		return {
			ok: false,
			code: 'INVALID_CREDENTIALS',
			message: 'Invalid credentials',
		};
	}

	await touchLoginSuccess(localAuth.userId);

	return {
		ok: true,
		user: buildAuthPayload(localAuth, { lastLoginAt: new Date() }),
	};
}

export async function changePassword(userId, { oldPassword, newPassword }, deps = {}) {
	const {
		scryptImpl = scrypt,
		findByUserId = findLocalAuthByUserId,
		updatePassword = updatePasswordByUserId,
	} = deps;

	const pwdCheck = validatePassword(newPassword);
	if (!pwdCheck.valid) {
		return { ok: false, code: pwdCheck.code, message: pwdCheck.message };
	}

	const localAuth = await findByUserId(userId);
	if (!localAuth || !localAuth.passwordHash) {
		return {
			ok: false,
			code: 'NO_LOCAL_AUTH',
			message: 'No local auth found for this user',
		};
	}

	const isMatch = await scryptImpl.verifyPassword(oldPassword, localAuth.passwordHash);
	if (!isMatch) {
		return {
			ok: false,
			code: 'INVALID_CREDENTIALS',
			message: 'Invalid credentials',
		};
	}

	const newHash = await scryptImpl.hashPassword(newPassword);
	await updatePassword(userId, newHash);

	return { ok: true };
}

export async function createLocalAccount(input, deps = {}) {
	const {
		scryptImpl = scrypt,
		createLocalUser = createLocalUserByLoginName,
		findByLoginName = findLocalAuthByLoginName,
		touchLoginSuccess = touchLocalLoginSuccess,
		genId = genUserId,
	} = deps;
	const { loginName, password } = input;

	const pwdCheck = validatePassword(password);
	if (!pwdCheck.valid) {
		return { ok: false, code: pwdCheck.code, message: pwdCheck.message };
	}

	const nameCheck = validateLoginName(loginName);
	if (!nameCheck.valid) {
		return { ok: false, code: nameCheck.code, message: nameCheck.message };
	}

	const userId = genId();
	const passwordHash = await scryptImpl.hashPassword(password);

	try {
		await createLocalUser({
			userId,
			loginName,
			passwordHash,
		});
	} catch (err) {
		if (err?.code === 'P2002') {
			return {
				ok: false,
				code: 'LOGIN_NAME_TAKEN',
				message: 'Login name is already taken',
			};
		}
		throw err;
	}

	const localAuth = await findByLoginName(loginName);
	await touchLoginSuccess(localAuth.userId);

	return {
		ok: true,
		user: buildAuthPayload(localAuth, { lastLoginAt: new Date() }),
	};
}
