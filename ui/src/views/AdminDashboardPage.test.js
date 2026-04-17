import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, test, expect, vi } from 'vitest';

const mockFetchAdminDashboard = vi.fn();
const mockNotifyError = vi.fn();

vi.mock('../services/admin.api.js', () => ({
	fetchAdminDashboard: (...args) => mockFetchAdminDashboard(...args),
	fetchAdminClaws: vi.fn(),
	fetchAdminUsers: vi.fn(),
}));

// 页面不再直接订阅 SSE（由 AdminLayout 管），stub 掉传输层以防误建连
vi.mock('../services/admin-stream.js', () => ({
	connectAdminStream: vi.fn(() => ({ close: vi.fn() })),
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

import AdminDashboardPage from './AdminDashboardPage.vue';
import { useAdminStore } from '../stores/admin.store.js';

const fakeDashboard = {
	users: { total: 100, todayNew: 5, todayActive: 23 },
	claws: { total: 10, todayNew: 2 },
	topActiveUsers: [
		{ id: '1', name: '张三', lastLoginAt: new Date(Date.now() - 180_000).toISOString() },
		{ id: '2', name: '李四', lastLoginAt: new Date(Date.now() - 7_200_000).toISOString() },
	],
	latestRegisteredUsers: [
		{ id: '10', name: '王五', loginName: 'wangwu', createdAt: new Date(Date.now() - 600_000).toISOString() },
		{ id: '11', name: null, loginName: 'noname_user', createdAt: new Date(Date.now() - 3_600_000).toISOString() },
	],
	latestBoundClaws: [
		{ id: 'c1', name: 'My Claw', userName: 'alice', createdAt: new Date(Date.now() - 60_000 * 2).toISOString() },
		{ id: 'c2', name: '', userName: null, createdAt: new Date(Date.now() - 3600_000).toISOString() },
	],
	version: { server: '0.4.2', plugin: '0.3.1' },
};

const i18nMap = {
	'admin.dashboard.title': 'Admin Dashboard',
	'admin.dashboard.totalClaws': 'Bound Instances',
	'admin.dashboard.onlineClaws': 'Online',
	'admin.dashboard.todayNewClaws': 'New Instances Today',
	'admin.dashboard.totalUsers': 'Total Users',
	'admin.dashboard.todayNewUsers': 'New Today',
	'admin.dashboard.todayActiveUsers': 'Active Today',
	'admin.dashboard.serverVersion': 'Server Version',
	'admin.dashboard.uiVersion': 'UI Version',
	'admin.dashboard.pluginVersion': 'Plugin Version',
	'admin.dashboard.sectionLatestClaws': 'Recently Bound Instances',
	'admin.dashboard.sectionTopActiveUsers': 'Recently Active Users',
	'admin.dashboard.sectionLatestRegisteredUsers': 'Latest Registered Users',
	'admin.common.noData': 'No data',
	'admin.common.viewAll': 'View all',
	'admin.common.online': 'Online',
	'admin.common.offline': 'Offline',
	'admin.nav.dashboard': 'Dashboard',
	'admin.nav.claws': 'Instances',
	'admin.nav.users': 'Users',
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
				AdminNavTabs: { template: '<div class="admin-nav" />' },
				RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
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
				$route: { path: '/admin/dashboard' },
			},
		},
	});
}

beforeEach(() => {
	setActivePinia(createPinia());
	mockFetchAdminDashboard.mockReset();
	mockNotifyError.mockReset();
});

afterEach(() => {
	// 隔离：visibilityState 在某些测试里被 defineProperty 覆盖，复原避免污染后续 test
	Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

test('loading 态显示 chat.loading 文案', async () => {
	let resolve;
	mockFetchAdminDashboard.mockReturnValue(new Promise((r) => { resolve = r; }));
	const wrapper = createWrapper();
	await wrapper.vm.$nextTick();
	expect(wrapper.text()).toContain('Loading...');
	resolve(fakeDashboard);
	await flushPromises();
});

// 把在线数大卡片定位到 DOM 元素（避免 text() 匹配被其他数字误中）
function onlineClawCard(wrapper) {
	// 第二张实例卡（总/在线/今日新增）
	return wrapper.findAll('.grid.grid-cols-3.gap-3 .text-2xl')[1];
}

test('渲染三卡片（总/在线/今日新增）+ 用户次级 + 版本', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();

	// 标记 snapshot 已到达，使在线数卡片切换出占位符
	const store = useAdminStore();
	store.onlineClawIds = new Set(['x1', 'x2', 'x3', 'x4']);
	store.hasOnlineSnapshot = true;
	await wrapper.vm.$nextTick();

	// 在线数卡片展示的值必须精确等于 Set.size
	expect(onlineClawCard(wrapper).text()).toBe('4');
	// 其余数字
	expect(wrapper.text()).toContain('10');
	expect(wrapper.text()).toContain('2');
	// 用户卡片数值
	expect(wrapper.text()).toContain('100');
	expect(wrapper.text()).toContain('5');
	expect(wrapper.text()).toContain('23');
	// 版本
	expect(wrapper.text()).toContain('v0.4.2');
	expect(wrapper.text()).toContain('v0.9.0');
	expect(wrapper.text()).toContain('v0.3.1');
	// 摘要列表条目
	expect(wrapper.text()).toContain('My Claw');
	expect(wrapper.text()).toContain('张三');
	expect(wrapper.text()).toContain('王五');
});

test('在线数大卡片响应 store.onlineClawIds 变化（SSE 事实源）', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();
	const store = useAdminStore();
	store.hasOnlineSnapshot = true;

	store.onlineClawIds = new Set(['a', 'b']);
	await wrapper.vm.$nextTick();
	expect(onlineClawCard(wrapper).text()).toBe('2');

	store.onlineClawIds = new Set(['a']);
	await wrapper.vm.$nextTick();
	expect(onlineClawCard(wrapper).text()).toBe('1');

	store.onlineClawIds = new Set();
	await wrapper.vm.$nextTick();
	expect(onlineClawCard(wrapper).text()).toBe('0');
});

test('SSE snapshot 未到达时在线数卡片显示占位符 —', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();
	const store = useAdminStore();
	// snapshot 未置位 → 即便 Set 有值也不暴露（避免首屏闪 0）
	store.onlineClawIds = new Set(['a', 'b', 'c']);
	expect(store.hasOnlineSnapshot).toBe(false);
	await wrapper.vm.$nextTick();
	expect(onlineClawCard(wrapper).text()).toBe('—');
});

test('Top 10 绿点由 isClawOnline 驱动', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();
	const store = useAdminStore();
	store.onlineClawIds = new Set(['c1']);
	await wrapper.vm.$nextTick();

	// c1 在线：span 带 bg-green-500；c2 离线：span 带 bg-neutral-400
	const dots = wrapper.findAll('li span.inline-block.h-2.w-2');
	expect(dots.length).toBeGreaterThanOrEqual(2);
	expect(dots[0].classes()).toContain('bg-green-500');
	expect(dots[1].classes()).toContain('bg-neutral-400');
});

test('pluginVersion 为 null 时显示占位 —', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce({
		...fakeDashboard,
		version: { server: '0.4.2', plugin: null },
	});
	const wrapper = createWrapper();
	await flushPromises();
	expect(wrapper.text()).toContain('v—');
});

test('latestBoundClaws 空数组时显示 noData', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce({ ...fakeDashboard, latestBoundClaws: [] });
	const wrapper = createWrapper();
	await flushPromises();
	expect(wrapper.text()).toContain('No data');
});

test('topActiveUsers 空数组时显示 noData', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce({ ...fakeDashboard, topActiveUsers: [] });
	const wrapper = createWrapper();
	await flushPromises();
	expect(wrapper.text()).toContain('No data');
});

test('latestRegisteredUsers 空数组时显示 noData', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce({ ...fakeDashboard, latestRegisteredUsers: [] });
	const wrapper = createWrapper();
	await flushPromises();
	expect(wrapper.text()).toContain('No data');
});

test('摘要列表带"查看全部"链接', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();
	const links = wrapper.findAll('a[href^="/admin/"]');
	const hrefs = links.map(l => l.attributes('href'));
	expect(hrefs).toContain('/admin/claws');
	expect(hrefs).toContain('/admin/users');
});

test('formatTimeAgo 分钟/小时分支', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();
	expect(wrapper.text()).toContain('3m ago'); // 180s
	expect(wrapper.text()).toContain('2h ago'); // 7200s
});

test('name 为空时 fallback 为 loginName/id', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce({
		...fakeDashboard,
		topActiveUsers: [
			{ id: 'u9', name: '', loginName: 'alice', lastLoginAt: new Date().toISOString() },
			{ id: 'u10', name: null, loginName: null, lastLoginAt: new Date().toISOString() },
		],
	});
	const wrapper = createWrapper();
	await flushPromises();
	expect(wrapper.text()).toContain('alice');
	expect(wrapper.text()).toContain('u10');
});

test('claw name 为空时 fallback 为 id', async () => {
	mockFetchAdminDashboard.mockResolvedValueOnce(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();
	// latestBoundClaws[1].name = '' → 显示 id c2
	expect(wrapper.text()).toContain('c2');
});

test('fetch 失败时 notify.error 并 warn', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const err = new Error('Network error');
	mockFetchAdminDashboard.mockRejectedValueOnce(err);
	createWrapper();
	await flushPromises();

	expect(mockNotifyError).toHaveBeenCalledWith('Network error');
	expect(warnSpy).toHaveBeenCalledWith('[AdminDashboardPage] loadData failed:', err);
	warnSpy.mockRestore();
});

test('notify.error 优先使用 response.data.message', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	mockFetchAdminDashboard.mockRejectedValueOnce({ response: { data: { message: 'server busy' } } });
	createWrapper();
	await flushPromises();
	expect(mockNotifyError).toHaveBeenCalledWith('server busy');
});

test('notify.error 无 message 时 fallback 为 Load failed', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	mockFetchAdminDashboard.mockRejectedValueOnce({});
	createWrapper();
	await flushPromises();
	expect(mockNotifyError).toHaveBeenCalledWith('Load failed');
});

test('app:foreground 触发重新加载', async () => {
	mockFetchAdminDashboard.mockResolvedValue(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();
	mockFetchAdminDashboard.mockClear();
	window.dispatchEvent(new CustomEvent('app:foreground'));
	await flushPromises();
	expect(mockFetchAdminDashboard).toHaveBeenCalled();
	wrapper.unmount();
});

test('visibilitychange visible 触发重新加载', async () => {
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

test('foreground 2s 内节流只执行一次', async () => {
	mockFetchAdminDashboard.mockResolvedValue(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();
	mockFetchAdminDashboard.mockClear();
	window.dispatchEvent(new CustomEvent('app:foreground'));
	window.dispatchEvent(new CustomEvent('app:foreground'));
	await flushPromises();
	expect(mockFetchAdminDashboard).toHaveBeenCalledTimes(1);
	wrapper.unmount();
});

test('unmount 后移除事件监听', async () => {
	mockFetchAdminDashboard.mockResolvedValue(fakeDashboard);
	const wrapper = createWrapper();
	await flushPromises();
	wrapper.unmount();
	mockFetchAdminDashboard.mockClear();
	window.dispatchEvent(new CustomEvent('app:foreground'));
	await flushPromises();
	expect(mockFetchAdminDashboard).not.toHaveBeenCalled();
});
