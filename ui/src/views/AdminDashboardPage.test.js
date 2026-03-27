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
		{ id: '1', name: '张三', lastLoginAt: new Date(Date.now() - 180000).toISOString(), lastLogoutAt: new Date(Date.now() - 120000).toISOString(), onlineDurationSec: 45 },
		{ id: '2', name: '李四', lastLoginAt: new Date(Date.now() - 7200000).toISOString(), lastLogoutAt: null, onlineDurationSec: null },
	],
	latestRegisteredUsers: [
		{ id: '10', name: '王五', loginName: 'wangwu', createdAt: new Date(Date.now() - 600000).toISOString() },
		{ id: '11', name: null, loginName: 'noname_user', createdAt: new Date(Date.now() - 3600000).toISOString() },
	],
	bots: { total: 10, online: 4 },
	version: { server: '0.4.2', plugin: '0.3.1' },
};

const i18nMap = {
	'adminDashboard.title': 'Admin Dashboard',
	'adminDashboard.totalUsers': 'Total Users',
	'adminDashboard.todayNew': 'New Today',
	'adminDashboard.todayActive': 'Active Today',
	'adminDashboard.totalBots': 'Bound Instances',
	'adminDashboard.onlineBots': 'Online',
	'adminDashboard.serverVersion': 'Server Version',
	'adminDashboard.uiVersion': 'UI Version',
	'adminDashboard.pluginVersion': 'Plugin Version',
	'adminDashboard.topActiveUsers': 'Recently Active Users',
	'adminDashboard.latestRegisteredUsers': 'Latest Registered Users',
	'adminDashboard.noData': 'No data',
	'adminDashboard.logoutAt': 'Logout',
	'adminDashboard.onlineActive': 'Active ({duration})',
	'adminDashboard.durationSec': 's',
	'adminDashboard.durationMin': 'm',
	'adminDashboard.durationHour': 'h',
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

test('should call notify.error on fetch failure', async () => {
	mockFetchAdminDashboard.mockRejectedValueOnce(new Error('Network error'));
	createWrapper();
	await flushPromises();

	expect(mockNotifyError).toHaveBeenCalledWith('Network error');
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

test('should render logout time and online duration for active users', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	// 第一个用户有 lastLogoutAt 和 onlineDurationSec=45 -> "45s"
	expect(wrapper.text()).toContain('Logout');
	expect(wrapper.text()).toContain('45s');
	// 第二个用户 lastLogoutAt=null -> "—"
	expect(wrapper.text()).toContain('—');
});

test('should show onlineActive when lastLogoutAt < lastLoginAt', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce({
		...fakeDashboard,
		topActiveUsers: [
			{
				id: '1',
				name: '赵六',
				lastLoginAt: new Date(Date.now() - 60000).toISOString(),
				lastLogoutAt: new Date(Date.now() - 120000).toISOString(),
				onlineDurationSec: 300,
			},
		],
	});
	const wrapper = createWrapper();
	await flushPromises();

	// lastLogoutAt < lastLoginAt -> 显示 "Active (1m)"
	expect(wrapper.text()).toContain('Active (1m)');
	expect(wrapper.text()).toContain('赵六');
});
