export function getUserMenuItems(t) {
	return [
		{ id: 'about', label: t('layout.menu.about'), icon: 'i-lucide-home' },
		{ id: 'settings', label: t('layout.menu.settings'), icon: 'i-lucide-settings', separator: true },
		{ id: 'profile', label: t('layout.menu.profile'), icon: 'i-lucide-user-round' },
		{ id: 'logout', label: t('layout.menu.logout'), icon: 'i-lucide-log-out', separator: true },
	];
}

export function getMobileTabs(t) {
	return [
		{ value: 'chat', label: t('layout.tabs.chat'), icon: 'i-lucide-message-square', to: '/topics' },
		{ value: 'bots', label: t('layout.tabs.bots'), icon: 'i-lucide-bot', to: '/bots' },
		{ value: 'me', label: t('layout.tabs.me'), icon: 'i-lucide-user', to: '/user' },
	];
}
