import openclawIcon from '../assets/claw-avatars/openclaw.svg';

export function getUserMenuItems(t, { isAdmin = false } = {}) {
	const items = [
		{ id: 'about', label: t('layout.menu.about'), icon: 'i-lucide-home' },
		{ id: 'settings', label: t('layout.menu.settings'), icon: 'i-lucide-settings', separator: true },
		{ id: 'profile', label: t('layout.menu.profile'), icon: 'i-lucide-user-round' },
	];
	if (isAdmin) {
		items.push({ id: 'admin-dashboard', label: t('user.adminDashboard'), icon: 'i-lucide-layout-dashboard', separator: true });
	}
	items.push(
		{ id: 'logout', label: t('layout.menu.logout'), icon: 'i-lucide-log-out', separator: true },
	);
	return items;
}

export function getMobileTabs(t) {
	return [
		{ value: 'chat', label: t('layout.tabs.chat'), icon: 'i-lucide-message-square', to: '/topics' },
		{ value: 'claws', label: t('layout.tabs.claws'), avatar: { src: openclawIcon }, to: '/claws' },
		{ value: 'me', label: t('layout.tabs.me'), icon: 'i-lucide-user', to: '/user' },
	];
}
