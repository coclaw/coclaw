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

const fakeDashboard = {
	users: { total: 100, todayNew: 5, todayActive: 23 },
	topActiveUsers: [
		{ id: '1', name: '张三', lastLoginAt: new Date(Date.now() - 180000).toISOString() },
		{ id: '2', name: '李四', lastLoginAt: new Date(Date.now() - 7200000).toISOString() },
	],
	bots: { total: 10 },
	version: { server: '0.4.2' },
};

const i18nMap = {
	'adminDashboard.title': 'Admin Dashboard',
	'adminDashboard.totalUsers': 'Total Users',
	'adminDashboard.todayNew': 'New Today',
	'adminDashboard.todayActive': 'Active Today',
	'adminDashboard.totalBots': 'Registered Claws',
	'adminDashboard.serverVersion': 'Server Version',
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

test('should render dashboard data after successful load', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('100');
	expect(wrapper.text()).toContain('5');
	expect(wrapper.text()).toContain('23');
	expect(wrapper.text()).toContain('10');
	expect(wrapper.text()).toContain('v0.4.2');
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
