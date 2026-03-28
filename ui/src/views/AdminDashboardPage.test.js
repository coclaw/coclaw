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

const mockBotsStore = { items: [], pluginInfo: {} };
const mockDashboardStore = { getDashboard: () => null };

vi.mock('../stores/bots.store.js', () => ({
	useBotsStore: () => mockBotsStore,
}));

vi.mock('../stores/dashboard.store.js', () => ({
	useDashboardStore: () => mockDashboardStore,
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
	'adminDashboard.instanceList': 'OpenClaw Instances',
	'adminDashboard.unnamed': '(Unnamed)',
	'adminDashboard.boundFor': 'Bound {days}d',
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
	mockBotsStore.items = [];
	mockBotsStore.pluginInfo = {};
	mockDashboardStore.getDashboard = () => null;
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

test('instanceList returns empty array when botsStore.items is empty', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.vm.instanceList).toEqual([]);
	expect(wrapper.text()).toContain('OpenClaw Instances');
	expect(wrapper.text()).toContain('No data');
});

test('instanceList maps pluginInfo and dashboard model correctly', async () => {
	mockBotsStore.items = [
		{ id: 1, name: 'My-Bot', online: true },
		{ id: 2, name: '', online: false },
	];
	mockBotsStore.pluginInfo = {
		'1': { version: '0.3.1', clawVersion: '0.8.0' },
	};
	mockDashboardStore.getDashboard = (id) => {
		if (id === '1') return { instance: { model: 'gpt-4o' } };
		return null;
	};

	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	const list = wrapper.vm.instanceList;
	expect(list).toHaveLength(2);

	expect(list[0]).toEqual({
		id: '1', name: 'My-Bot', online: true,
		pluginVersion: '0.3.1', clawVersion: '0.8.0', model: 'gpt-4o',
	});
	expect(list[1]).toEqual({
		id: '2', name: null, online: false,
		pluginVersion: null, clawVersion: null, model: null,
	});

	// 渲染检查
	const text = wrapper.text();
	expect(text).toContain('My-Bot');
	expect(text).toContain('(Unnamed)');
	expect(text).toContain('0.3.1');
	expect(text).toContain('0.8.0');
	expect(text).toContain('gpt-4o');
});
