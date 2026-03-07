export function toSafeSettings(settings) {
	return {
		theme: settings.theme ?? null,
		lang: settings.lang ?? null,
		perfs: settings.perfs ?? {},
		uiState: settings.uiState ?? {},
		hintCounts: settings.hintCounts ?? {},
	};
}

export function toSafeAuth(profile, authType) {
	const auth = {
		local: profile?.localAuth?.loginName
			? {
				loginName: profile.localAuth.loginName,
			}
			: null,
	};
	for (const externalAuth of profile?.externalAuths ?? []) {
		if (!externalAuth?.oauthType || auth[externalAuth.oauthType]) {
			continue;
		}
		auth[externalAuth.oauthType] = {
			oauthName: externalAuth.oauthName ?? null,
			oauthAvatar: externalAuth.oauthAvatar ?? null,
		};
	}

	return {
		authType: authType ?? (auth.local ? 'local' : null),
		auth,
	};
}

export function toSafeProfile(profile, options = {}) {
	const { authType = null } = options;
	const safeAuth = toSafeAuth(profile, authType);
	return {
		id: profile.id.toString(),
		name: profile.name ?? null,
		avatar: profile.avatar ?? null,
		level: profile.level,
		authType: safeAuth.authType,
		auth: safeAuth.auth,
		lastLoginAt: profile.lastLoginAt instanceof Date ? profile.lastLoginAt.toISOString() : (profile.lastLoginAt ?? null),
	};
}

export function buildSessionUser(profile, options = {}) {
	if (!profile?.userSetting) {
		throw new Error('UserSetting is required');
	}
	const safeProfile = toSafeProfile(profile, options);
	return {
		id: profile.id,
		name: safeProfile.name,
		avatar: safeProfile.avatar,
		level: safeProfile.level,
		locked: profile.locked,
		authType: safeProfile.authType,
		auth: safeProfile.auth,
		settings: toSafeSettings(profile.userSetting),
		lastLoginAt: profile.lastLoginAt ?? null,
	};
}

export function toAuthResponseUser(user) {
	return {
		id: user.id.toString(),
		name: user.name,
		avatar: user.avatar,
		level: user.level,
		authType: user.authType,
		auth: user.auth,
		settings: user.settings,
		lastLoginAt: user.lastLoginAt ?? null,
	};
}
