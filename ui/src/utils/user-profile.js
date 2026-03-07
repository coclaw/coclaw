function findFirstExternalOauthName(auth) {
	if (!auth || typeof auth !== 'object') {
		return '';
	}

	for (const [key, value] of Object.entries(auth)) {
		if (key === 'local') {
			continue;
		}
		if (value?.oauthName) {
			return value.oauthName;
		}
	}
	return '';
}

export function getUserLoginName(user) {
	if (!user || typeof user !== 'object') {
		return '';
	}
	return user?.auth?.local?.loginName ?? findFirstExternalOauthName(user?.auth) ?? '';
}

export function getUserDisplayName(user) {
	if (!user || typeof user !== 'object') {
		return '';
	}
	return user?.name || getUserLoginName(user) || 'Unknown User';
}

export function getUserAuthTypeLabel(user, t = null) {
	if (user?.authType === 'local') {
		return t ? t('profile.authTypeLocal') : '本地账号';
	}
	if (user?.authType) {
		return t ? t('profile.authTypeThirdParty', { type: user.authType }) : `第三方(${user.authType})`;
	}
	return t ? t('profile.authTypeUnknown') : '未知';
}
