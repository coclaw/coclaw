import { Router } from 'express';
import { findUserProfileByIdWithOptions, updateUserProfileById } from '../repos/user.repo.js';
import { findUserSettingByUserId, patchUserSettingByUserId } from '../repos/user-setting.repo.js';
import { changePassword } from '../services/local-auth.svc.js';
import { toSafeProfile, toSafeSettings } from '../services/user-view.svc.js';

export const userRouter = Router();

function requireSession(req, res) {
	if (req.isAuthenticated?.() && req.user) {
		return true;
	}

	res.status(401).json({
		code: 'UNAUTHORIZED',
		message: 'Unauthorized',
	});
	return false;
}

function isPlainObject(value) {
	return value && typeof value === 'object' && !Array.isArray(value);
}

function parseIncludeSettings(raw) {
	if (typeof raw !== 'string') {
		return false;
	}
	const value = raw.trim().toLowerCase();
	return value === '1' || value === 'true';
}

function validateUserPatchPayload(payload) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return {
			ok: false,
			message: 'Request body must be an object',
		};
	}

	const hasKnownField = Object.hasOwn(payload, 'name') || Object.hasOwn(payload, 'avatar');
	if (!hasKnownField) {
		return {
			ok: false,
			message: 'At least one patch field is required',
		};
	}

	if (Object.hasOwn(payload, 'name') && payload.name !== null && typeof payload.name !== 'string') {
		return {
			ok: false,
			message: 'name must be a string or null',
		};
	}
	if (Object.hasOwn(payload, 'avatar') && payload.avatar !== null && typeof payload.avatar !== 'string') {
		return {
			ok: false,
			message: 'avatar must be a string or null',
		};
	}

	return { ok: true };
}

const ALLOWED_THEME_VALUES = new Set(['auto', 'dark', 'light']);

function validateSettingsPatchPayload(payload) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return {
			ok: false,
			message: 'Request body must be an object',
		};
	}

	const hasKnownField = Object.hasOwn(payload, 'theme')
		|| Object.hasOwn(payload, 'lang')
		|| Object.hasOwn(payload, 'perfsPatch')
		|| Object.hasOwn(payload, 'uiStatePatch')
		|| Object.hasOwn(payload, 'hintCountsPatch');
	if (!hasKnownField) {
		return {
			ok: false,
			message: 'At least one patch field is required',
		};
	}

	if (Object.hasOwn(payload, 'theme') && payload.theme !== null && typeof payload.theme !== 'string') {
		return {
			ok: false,
			message: 'theme must be a string or null',
		};
	}
	if (Object.hasOwn(payload, 'theme') && payload.theme !== null && !ALLOWED_THEME_VALUES.has(payload.theme)) {
		return {
			ok: false,
			message: 'theme must be one of auto, dark, light or null',
		};
	}
	if (Object.hasOwn(payload, 'lang') && payload.lang !== null && typeof payload.lang !== 'string') {
		return {
			ok: false,
			message: 'lang must be a string or null',
		};
	}
	if (Object.hasOwn(payload, 'perfsPatch') && !isPlainObject(payload.perfsPatch)) {
		return {
			ok: false,
			message: 'perfsPatch must be an object',
		};
	}
	if (Object.hasOwn(payload, 'uiStatePatch') && !isPlainObject(payload.uiStatePatch)) {
		return {
			ok: false,
			message: 'uiStatePatch must be an object',
		};
	}
	if (Object.hasOwn(payload, 'hintCountsPatch') && !isPlainObject(payload.hintCountsPatch)) {
		return {
			ok: false,
			message: 'hintCountsPatch must be an object',
		};
	}

	return { ok: true };
}

export async function getCurrentUserHandler(req, res, next, deps = {}) {
	const {
		findUserProfile = findUserProfileByIdWithOptions,
	} = deps;
	if (!requireSession(req, res)) {
		return;
	}

	const includeSettings = parseIncludeSettings(req.query?.includeSettings);
	try {
		const profile = await findUserProfile(req.user.id, {
			includeSettings,
		});
		if (!profile) {
			res.status(401).json({
				code: 'UNAUTHORIZED',
				message: 'Unauthorized',
			});
			return;
		}

		const response = {
			profile: toSafeProfile(profile),
		};
		if (includeSettings) {
			response.settings = toSafeSettings(profile.userSetting);
		}

		res.status(200).json(response);
	}
	catch (err) {
		next(err);
	}
}

export async function patchCurrentUserHandler(req, res, next, deps = {}) {
	const {
		updateUserProfile = updateUserProfileById,
		findUserProfile = findUserProfileByIdWithOptions,
	} = deps;
	if (!requireSession(req, res)) {
		return;
	}

	const validation = validateUserPatchPayload(req.body);
	if (!validation.ok) {
		res.status(400).json({
			code: 'INVALID_INPUT',
			message: validation.message,
		});
		return;
	}

	try {
		await updateUserProfile(req.user.id, req.body);
		const profile = await findUserProfile(req.user.id, {
			includeSettings: false,
		});
		if (!profile) {
			throw new Error('User not found');
		}

		res.status(200).json({
			profile: toSafeProfile(profile),
		});
	}
	catch (err) {
		next(err);
	}
}

export async function getCurrentUserSettingsHandler(req, res, next, deps = {}) {
	const {
		findUserSetting = findUserSettingByUserId,
	} = deps;
	if (!requireSession(req, res)) {
		return;
	}

	try {
		const setting = await findUserSetting(req.user.id);
		if (!setting) {
			throw new Error('User settings not found');
		}

		res.status(200).json({
			settings: toSafeSettings(setting),
		});
	}
	catch (err) {
		next(err);
	}
}

export async function patchCurrentUserSettingsHandler(req, res, next, deps = {}) {
	const {
		patchUserSetting = patchUserSettingByUserId,
	} = deps;
	if (!requireSession(req, res)) {
		return;
	}

	const validation = validateSettingsPatchPayload(req.body);
	if (!validation.ok) {
		res.status(400).json({
			code: 'INVALID_INPUT',
			message: validation.message,
		});
		return;
	}

	try {
		const setting = await patchUserSetting(req.user.id, req.body);
		res.status(200).json({
			settings: toSafeSettings(setting),
		});
	}
	catch (err) {
		next(err);
	}
}

function validateChangePasswordPayload(payload) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return {
			ok: false,
			message: 'Request body must be an object',
		};
	}

	if (typeof payload.oldPassword !== 'string' || payload.oldPassword.trim() === '') {
		return {
			ok: false,
			message: 'oldPassword is required',
		};
	}
	if (typeof payload.newPassword !== 'string' || payload.newPassword.trim() === '') {
		return {
			ok: false,
			message: 'newPassword is required',
		};
	}

	return { ok: true };
}

export async function changePasswordHandler(req, res, next, deps = {}) {
	const {
		changePwd = changePassword,
	} = deps;
	if (!requireSession(req, res)) {
		return;
	}

	const validation = validateChangePasswordPayload(req.body);
	if (!validation.ok) {
		res.status(400).json({
			code: 'INVALID_INPUT',
			message: validation.message,
		});
		return;
	}

	try {
		const result = await changePwd(req.user.id, {
			oldPassword: req.body.oldPassword,
			newPassword: req.body.newPassword,
		});

		if (!result.ok) {
			const statusCode = result.code === 'INVALID_CREDENTIALS' ? 401 : 400;
			res.status(statusCode).json({
				code: result.code,
				message: result.message,
			});
			return;
		}

		res.status(200).json({
			message: 'Password changed',
		});
	}
	catch (err) {
		next(err);
	}
}

userRouter.get('/', getCurrentUserHandler);
userRouter.patch('/', patchCurrentUserHandler);
userRouter.get('/settings', getCurrentUserSettingsHandler);
userRouter.patch('/settings', patchCurrentUserSettingsHandler);
userRouter.put('/password', changePasswordHandler);
