import { mount, flushPromises } from '@vue/test-utils';
import { vi } from 'vitest';

import AdminDashboardPage from './AdminDashboardPage.vue';

const mockFetchAdminDashboard = vi.fn();
const mockNotifyError = vi.fn();

vi.mock('../services/admin.api.js', () => ({
	fetchAdminDashboard: (...args) => mockFetchAdminDashboard(...args),
}));

vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => ({
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		error: mockNotifyError,
	}),
}));

vi.stubGlobal('__APP_VERSION__', '0.9.0');

const fakeDashboard = {
	users: { total: 100, todayNew: 5, todayActive: 23 },
	topActiveUsers: [
		{ id: '1', name: '张三', lastLoginAt: new Date(Date.now() - 180000).toISOString() },
		{ id: '2', name: '李四', lastLoginAt: new Date(Date.now() - 7200000).toISOString() },
	],
	latestRegisteredUsers: [
		{ id: '10', name: '王五', loginName: 'wangwu', createdAt: new Date(Date.now() - 600000).toISOString() },
		{ id: '11', name: null, loginName: 'noname_user', createdAt: new Date(Date.now() - 3600000).toISOString() },
	],
	claws: { total: 10, online: 4 },
	version: { server: '0.4.2', plugin: '0.3.1' },
};

const i18nMap = {
	'adminDashboard.title': 'Admin Dashboard',
	'adminDashboard.totalUsers': 'Total Users',
	'adminDashboard.todayNew': 'New Today',
	'adminDashboard.todayActive': 'Active Today',
	'adminDashboard.totalClaws': 'Bound Instances',
	'adminDashboard.onlineClaws': 'Online',
	'adminDashboard.serverVersion': 'Server Version',
	'adminDashboard.uiVersion': 'UI Version',
	'adminDashboard.pluginVersion': 'Plugin Version',
	'adminDashboard.topActiveUsers': 'Recently Active Users',
	'adminDashboard.latestRegisteredUsers': 'Latest Registered Users',
	'adminDashboard.noData': 'No data',
	'chat.loading': 'Loading...',
	'dashboard.justNow': 'Just now',
	'dashboard.minutesAgo': '{n}m ago',
	'dashboard.hoursAgo': '{n}h ago',
	'dashboard.daysAgo': '{n}d ago',
};

function createWrapper() {
	return mount(AdminDashboardPage, {
		global: {
			stubs: {
				MobilePageHeader: { props: ['title'], template: '<div />' },
			},
			mocks: {
				$t: (key, params) => {
					let str = i18nMap[key] ?? key;
					if (params) {
						for (const [k, v] of Object.entries(params)) {
							str = str.replace(`{${k}}`, v);
						}
					}
					return str;
				},
			},
		},
	});
}

beforeEach(() => {
	mockFetchAdminDashboard.mockReset();
	mockNotifyError.mockReset();
});

test('should show loading state initially', async () => {
	let resolve;
	mockFetchAdminDashboard.mockReturnValue(new Promise((r) => { resolve = r; }));
	const wrapper = createWrapper();
	await wrapper.vm.$nextTick();

	expect(wrapper.text()).toContain('Loading...');
	resolve(fakeDashboard);
	await flushPromises();
});

test('should render dashboard data after successful load', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('100');
	expect(wrapper.text()).toContain('5');
	expect(wrapper.text()).toContain('23');
	expect(wrapper.text()).toContain('10');
	expect(wrapper.text()).toContain('v0.4.2');
	expect(wrapper.text()).toContain('v0.9.0');
	expect(wrapper.text()).toContain('v0.3.1');
	expect(wrapper.text()).toContain('Online');
	expect(wrapper.text()).toContain('4');
	expect(wrapper.text()).toContain('张三');
	expect(wrapper.text()).toContain('李四');
});

test('should call notify.error on fetch failure and log warning', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const err = new Error('Network error');
	mockFetchAdminDashboard.mockRejectedValueOnce(err);
	createWrapper();
	await flushPromises();

	expect(mockNotifyError).toHaveBeenCalledWith('Network error');
	expect(warnSpy).toHaveBeenCalledWith('[AdminDashboardPage] loadData failed:', err);
	warnSpy.mockRestore();
});

test('should format time ago correctly', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	// 180s = 3min -> "3m ago"
	expect(wrapper.text()).toContain('3m ago');
	// 7200s = 2h -> "2h ago"
	expect(wrapper.text()).toContain('2h ago');
});

test('should show noData when topActiveUsers is empty', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce({
		...fakeDashboard,
		topActiveUsers: [],
	});
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('No data');
});

test('should fallback to loginName when name is empty', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce({
		...fakeDashboard,
		topActiveUsers: [
			{ id: '1', name: '', loginName: 'alice', lastLoginAt: new Date().toISOString() },
			{ id: '2', name: null, loginName: null, lastLoginAt: new Date().toISOString() },
		],
	});
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('alice');
	expect(wrapper.text()).toContain('2');
});

test('should render latest registered users with name fallback to loginName', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('Latest Registered Users');
	expect(wrapper.text()).toContain('王五');
	// name 为 null 时应显示 loginName
	expect(wrapper.text()).toContain('noname_user');
	// 注册时间 600s = 10min -> "10m ago"
	expect(wrapper.text()).toContain('10m ago');
});

test('should reload data on app:foreground', async () => {
	mockFetchAdminDashboard.mockResolvedValue(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	mockFetchAdminDashboard.mockClear();
	window.dispatchEvent(new CustomEvent('app:foreground'));
	await flushPromises();

	expect(mockFetchAdminDashboard).toHaveBeenCalled();
	wrapper.unmount();
});

test('should reload data on visibilitychange to visible', async () => {
	mockFetchAdminDashboard.mockResolvedValue(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	mockFetchAdminDashboard.mockClear();
	Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
	document.dispatchEvent(new Event('visibilitychange'));
	await flushPromises();

	expect(mockFetchAdminDashboard).toHaveBeenCalled();
	wrapper.unmount();
});

test('should throttle foreground resume within 2s', async () => {
	mockFetchAdminDashboard.mockResolvedValue(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	mockFetchAdminDashboard.mockClear();
	// 连续触发两次，第二次应被节流
	window.dispatchEvent(new CustomEvent('app:foreground'));
	window.dispatchEvent(new CustomEvent('app:foreground'));
	await flushPromises();

	// 节流：仅执行一次
	expect(mockFetchAdminDashboard).toHaveBeenCalledTimes(1);
	wrapper.unmount();
});

test('should remove listeners on unmount', async () => {
	mockFetchAdminDashboard.mockResolvedValue(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	wrapper.unmount();

	mockFetchAdminDashboard.mockClear();
	window.dispatchEvent(new CustomEvent('app:foreground'));
	await flushPromises();

	expect(mockFetchAdminDashboard).not.toHaveBeenCalled();
});
