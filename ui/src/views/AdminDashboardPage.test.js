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
		{ id: '1', name: '张三', loginName: 'zhangsan', lastLoginAt: new Date(Date.now() - 180000).toISOString(), botCount: 3, onlineBotCount: 2 },
		{ id: '2', name: '李四', loginName: 'lisi', lastLoginAt: new Date(Date.now() - 7200000).toISOString(), botCount: 1, onlineBotCount: 0 },
	],
	bots: {
		total: 10,
		todayNew: 2,
		online: 4,
		list: [
			{ id: '100', name: 'Bot-A', isOnline: true, lastSeenAt: new Date(Date.now() - 60000).toISOString(), createdAt: new Date(Date.now() - 86400000 * 5).toISOString(), userId: '1', userName: '张三', userLoginName: 'zhangsan' },
			{ id: '101', name: null, isOnline: false, lastSeenAt: new Date(Date.now() - 3600000).toISOString(), createdAt: new Date(Date.now() - 86400000 * 30).toISOString(), userId: '2', userName: '李四', userLoginName: 'lisi' },
		],
	},
	version: { server: '0.4.2', plugin: '0.3.1' },
};

const i18nMap = {
	'adminDashboard.title': 'Admin Dashboard',
	'adminDashboard.totalBots': 'Total Instances',
	'adminDashboard.todayNewBots': 'New Today',
	'adminDashboard.onlineBots': 'Online Instances',
	'adminDashboard.instanceList': 'Instances',
	'adminDashboard.instanceName': 'Name',
	'adminDashboard.instanceOwner': 'Owner',
	'adminDashboard.lastSeen': 'Last Seen',
	'adminDashboard.bindDuration': 'Bound For',
	'adminDashboard.userList': 'Users',
	'adminDashboard.instanceCount': 'Instances',
	'adminDashboard.lastLogin': 'Last Login',
	'adminDashboard.totalUsers': 'Total Users',
	'adminDashboard.todayNew': 'New Today',
	'adminDashboard.todayActive': 'Active Today',
	'adminDashboard.serverVersion': 'Server Version',
	'adminDashboard.uiVersion': 'UI Version',
	'adminDashboard.pluginVersion': 'Plugin Version',
	'adminDashboard.topActiveUsers': 'Recently Active Users',
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

test('should render bot metric cards after successful load', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('10');
	expect(wrapper.text()).toContain('Total Instances');
	expect(wrapper.text()).toContain('2');
	expect(wrapper.text()).toContain('4');
	expect(wrapper.text()).toContain('Online Instances');
});

test('should render instance list with online status', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('Instances');
	expect(wrapper.text()).toContain('Bot-A');
	expect(wrapper.text()).toContain('张三');
	// 在线实例有绿色指示点
	const greenDots = wrapper.findAll('.bg-green-500');
	expect(greenDots.length).toBeGreaterThanOrEqual(1);
	const grayDots = wrapper.findAll('.bg-gray-400');
	expect(grayDots.length).toBeGreaterThanOrEqual(1);
});

test('should sort bots: online first, then by lastSeenAt desc', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	const listItems = wrapper.findAll('ul')[0].findAll('li');
	// Bot-A (online) 应排在前面
	expect(listItems[0].text()).toContain('Bot-A');
});

test('should render user list with instance counts', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('Users');
	expect(wrapper.text()).toContain('张三');
	expect(wrapper.text()).toContain('2/3');
	expect(wrapper.text()).toContain('0/1');
	// 3m ago / 2h ago
	expect(wrapper.text()).toContain('3m ago');
	expect(wrapper.text()).toContain('2h ago');
});

test('should render version info', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('v0.4.2');
	expect(wrapper.text()).toContain('v0.9.0');
	expect(wrapper.text()).toContain('v0.3.1');
});

test('should show dash when plugin version is null', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce({
		...fakeDashboard,
		version: { server: '0.4.2', plugin: null },
	});
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.text()).not.toContain('vnull');
	expect(wrapper.text()).toContain('—');
});

test('should call notify.error on fetch failure', async () => {
	mockFetchAdminDashboard.mockRejectedValueOnce(new Error('Network error'));
	createWrapper();
	await flushPromises();

	expect(mockNotifyError).toHaveBeenCalledWith('Network error');
});

test('should show noData when bots list is empty', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce({
		...fakeDashboard,
		bots: { ...fakeDashboard.bots, list: [] },
		topActiveUsers: [],
	});
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('No data');
});

test('should fallback to loginName when user name is empty', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce({
		...fakeDashboard,
		topActiveUsers: [
			{ id: '1', name: '', loginName: 'alice', lastLoginAt: new Date().toISOString(), botCount: 0, onlineBotCount: 0 },
			{ id: '2', name: null, loginName: null, lastLoginAt: new Date().toISOString(), botCount: 0, onlineBotCount: 0 },
		],
	});
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('alice');
	expect(wrapper.text()).toContain('2');
});

test('should format bind duration correctly', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	// Bot-A: 5 days old -> "5d"
	expect(wrapper.text()).toContain('5d');
	// Bot with 30 days -> "30d"
	expect(wrapper.text()).toContain('30d');
});
