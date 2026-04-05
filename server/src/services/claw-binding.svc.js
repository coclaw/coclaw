import crypto from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';

import {
	createClaw,
	deleteClaw,
	findClawById,
	findClawByTokenHash,
} from '../repos/claw.repo.js';
import {
	createBindingCode,
	deleteBindingCode,
	findBindingCode,
	updateBindingCode,
} from '../repos/claw-binding-code.repo.js';
import {
	createClaimCode as createClaimCodeRecord,
	deleteClaimCode as deleteClaimCodeRecord,
	findClaimCode as findClaimCodeRecord,
} from '../repos/claw-claim-code.repo.js';
import { genClawId } from './id.svc.js';

const BINDING_CODE_EXPIRE_MS =
	(Number(process.env.BINDING_CODE_EXPIRE_MINUTES) || 30) * 60 * 1000;

function isNonEmptyString(value) {
	return typeof value === 'string' && value.trim() !== '';
}

function genBindingCode() {
	return String(Math.floor(Math.random() * 100000000)).padStart(8, '0');
}

function genAccessToken() {
	return createId();
}

function getTokenHash(token) {
	return crypto
		.createHash('sha256')
		.update(token, 'utf8')
		.digest();
}

export async function createBindingCodeForUser(input, deps = {}) {
	const {
		createCode = createBindingCode,
		findCode = findBindingCode,
		updateCode = updateBindingCode,
		now = () => new Date(),
	} = deps;
	const { userId } = input;

	if (typeof userId !== 'bigint') {
		throw new Error('userId is required');
	}

	for (let i = 0; i < 3; i += 1) {
		const code = genBindingCode();
		const current = now();
		const expiresAt = new Date(current.getTime() + BINDING_CODE_EXPIRE_MS);

		try {
			await createCode({
				code,
				userId,
				expiresAt,
			});
			return {
				ok: true,
				code,
				expiresAt,
			};
		}
		catch (err) {
			if (err?.code !== 'P2002') {
				throw err;
			}

			const existed = await findCode(code);
			if (!existed) {
				continue;
			}

			if (existed.expiresAt.getTime() > current.getTime()) {
				continue;
			}

			await updateCode(code, {
				userId,
				expiresAt,
				createdAt: current,
			});
			return {
				ok: true,
				code,
				expiresAt,
			};
		}
	}

	return {
		ok: false,
		code: 'BINDING_CODE_EXHAUSTED',
		message: 'Failed to generate binding code',
	};
}

export async function bindClaw(input, deps = {}) {
	const {
		findCode = findBindingCode,
		deleteCode = deleteBindingCode,
		createClawImpl = createClaw,
		genId = genClawId,
		now = () => new Date(),
	} = deps;
	const { code, name } = input;

	if (!isNonEmptyString(code)) {
		return {
			ok: false,
			code: 'INVALID_INPUT',
			message: 'code is required',
		};
	}

	const bindingCode = await findCode(code.trim());
	if (!bindingCode) {
		return {
			ok: false,
			code: 'BINDING_CODE_INVALID',
			message: 'Binding code is invalid',
		};
	}

	if (bindingCode.expiresAt.getTime() <= now().getTime()) {
		await deleteCode(bindingCode.code).catch(() => {});
		return {
			ok: false,
			code: 'BINDING_CODE_EXPIRED',
			message: 'Binding code is expired',
		};
	}

	const token = genAccessToken();
	const tokenHash = getTokenHash(token);
	const clawName = isNonEmptyString(name) ? name.trim() : null;

	const created = await createClawImpl({
		id: genId(),
		userId: bindingCode.userId,
		name: clawName,
		tokenHash,
	});
	await deleteCode(bindingCode.code).catch(() => {});

	return {
		ok: true,
		botId: created.id,
		userId: bindingCode.userId,
		botName: clawName,
		token,
		rebound: false,
		bindingCode: bindingCode.code,
	};
}

export async function unbindClawByUser(input, deps = {}) {
	const {
		findById = findClawById,
		deleteClawImpl = deleteClaw,
	} = deps;
	const { userId, botId } = input;

	if (typeof userId !== 'bigint' || typeof botId !== 'bigint') {
		return {
			ok: false,
			code: 'INVALID_INPUT',
			message: 'userId and botId are required',
		};
	}

	const targetClaw = await findById(botId);
	if (!targetClaw || targetClaw.userId !== userId) {
		return {
			ok: false,
			code: 'BOT_NOT_FOUND',
			message: 'Bot not found',
		};
	}
	await deleteClawImpl(targetClaw.id);

	return {
		ok: true,
		botId: targetClaw.id,
	};
}

export async function createClaimCode(deps = {}) {
	const {
		createCode = createClaimCodeRecord,
		findCode = findClaimCodeRecord,
		deleteCode = deleteClaimCodeRecord,
		now = () => new Date(),
	} = deps;

	for (let i = 0; i < 3; i += 1) {
		const code = genBindingCode();
		const current = now();
		const expiresAt = new Date(current.getTime() + BINDING_CODE_EXPIRE_MS);

		try {
			await createCode({ code, expiresAt });
			return { ok: true, code, expiresAt };
		}
		catch (err) {
			if (err?.code !== 'P2002') {
				throw err;
			}
			// 码冲突：检查已存在记录
			const existed = await findCode(code);
			if (!existed) {
				continue;
			}
			// 未过期的有效码，跳过
			if (existed.expiresAt.getTime() > current.getTime()) {
				continue;
			}
			// 过期记录：删除后重试
			await deleteCode(code).catch(() => {});
			continue;
		}
	}

	return {
		ok: false,
		code: 'CLAIM_CODE_EXHAUSTED',
		message: 'Failed to generate claim code',
	};
}

export async function claimClaw(input, deps = {}) {
	const {
		findCode = findClaimCodeRecord,
		deleteCode = deleteClaimCodeRecord,
		createClawImpl = createClaw,
		genId = genClawId,
		now = () => new Date(),
	} = deps;
	const { code, userId } = input;

	if (!code || typeof code !== 'string') {
		return {
			ok: false,
			code: 'INVALID_INPUT',
			message: 'code is required',
		};
	}

	if (typeof userId !== 'bigint') {
		return {
			ok: false,
			code: 'INVALID_INPUT',
			message: 'userId is required',
		};
	}

	const claimCode = await findCode(code.trim());
	if (!claimCode) {
		return {
			ok: false,
			code: 'CLAIM_CODE_INVALID',
			message: 'Claim code is invalid',
		};
	}

	if (claimCode.expiresAt.getTime() <= now().getTime()) {
		await deleteCode(claimCode.code).catch(() => {});
		return {
			ok: false,
			code: 'CLAIM_CODE_EXPIRED',
			message: 'Claim code has expired',
		};
	}

	const token = genAccessToken();
	const tokenHash = getTokenHash(token);

	const created = await createClawImpl({
		id: genId(),
		userId,
		name: null,
		tokenHash,
	});
	await deleteCode(claimCode.code).catch(() => {});

	return {
		ok: true,
		botId: created.id,
		botName: null,
		token,
	};
}

export async function unbindClawByToken(input, deps = {}) {
	const {
		findByTokenHash = findClawByTokenHash,
		deleteClawImpl = deleteClaw,
	} = deps;
	const { token } = input;

	if (!isNonEmptyString(token)) {
		return {
			ok: false,
			code: 'INVALID_INPUT',
			message: 'token is required',
		};
	}

	const tokenHash = getTokenHash(token);
	const targetClaw = await findByTokenHash(tokenHash);

	if (!targetClaw) {
		return {
			ok: false,
			code: 'UNAUTHORIZED',
			message: 'Invalid token',
		};
	}
	await deleteClawImpl(targetClaw.id);

	return {
		ok: true,
		botId: targetClaw.id,
		userId: targetClaw.userId,
	};
}
