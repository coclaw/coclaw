import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest';

// --- Mocks ---

const mockFetchUsers = vi.fn();
const mockFetchMoreUsers = vi.fn();
const mockResetUsers = vi.fn();
const mockNotifyError = vi.fn();

vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => ({
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		error: mockNotifyError,
	}),
}));

let fakeStore;

vi.mock('../stores/admin.store.js', () => ({
	useAdminStore: () => fakeStore,
}));

import AdminUsersPage from './AdminUsersPage.vue';

// --- UI stubs ---

const UTableStub = {
	props: ['data', 'columns', 'loading', 'empty', 'getRowId'],
	template: `
		<div class="u-table-stub" :data-loading="loading" :data-empty="empty">
			<div
				v-for="row in data"
				:key="row.id"
				class="u-table-row"
				:data-id="row.id"
			>
				<slot name="name-cell" :row="{ original: row }" />
				<slot name="loginName-cell" :row="{ original: row }" />
				<slot name="clawCount-cell" :row="{ original: row }" />
				<slot name="createdAt-cell" :row="{ original: row }" />
				<slot name="lastLoginAt-cell" :row="{ original: row }" />
			</div>
		</div>
	`,
};

const UInputStub = {
	props: ['modelValue', 'placeholder', 'icon', 'size'],
	emits: ['update:modelValue'],
	inheritAttrs: false,
	template: `<input class="u-input-stub" :value="modelValue" :placeholder="placeholder" @input="$emit('update:modelValue', $event.target.value)" />`,
};

const UButtonStub = {
	props: ['loading'],
	emits: ['click'],
	template: `<button class="u-button-stub" :disabled="loading" @click="$emit('click')"><slot /></button>`,
};

const UIconStub = {
	props: ['name'],
	template: `<span class="u-icon-stub" :data-icon="name"></span>`,
};

const i18nMap = {
	'admin.users.title': 'User Management',
	'admin.users.searchPlaceholder': 'Search by name or login',
	'admin.users.columnName': 'Name',
	'admin.users.columnLoginName': 'Login',
	'admin.users.columnClawCount': 'Instances',
	'admin.users.columnCreatedAt': 'Joined',
	'admin.users.columnLastLogin': 'Last Login',
	'admin.common.loadMore': 'Load more',
	'admin.common.noData': 'No data',
	'dashboard.justNow': 'Just now',
	'dashboard.minutesAgo': '{n}m ago',
	'dashboard.hoursAgo': '{n}h ago',
	'dashboard.daysAgo': '{n}d ago',
};

function mountPage(overrides = {}) {
	fakeStore = {
		users: {
			items: [],
			nextCursor: null,
			loading: false,
			search: '',
			error: null,
			...overrides.usersState,
		},
		fetchUsers: mockFetchUsers,
		fetchMoreUsers: mockFetchMoreUsers,
		resetUsers: mockResetUsers,
	};

	return mount(AdminUsersPage, {
		global: {
			stubs: {
				MobilePageHeader: { props: ['title'], template: '<div class="mobile-header" :data-title="title" />' },
				AdminNavTabs: { template: '<div class="admin-nav-tabs" />' },
				UTable: UTableStub,
				UInput: UInputStub,
				UButton: UButtonStub,
				UIcon: UIconStub,
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
	setActivePinia(createPinia());
	mockFetchUsers.mockReset();
	mockFetchMoreUsers.mockReset();
	mockResetUsers.mockReset();
	mockNotifyError.mockReset();
	mockFetchUsers.mockResolvedValue();
	mockFetchMoreUsers.mockResolvedValue();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('AdminUsersPage — mount', () => {
	test('mounted 调用 fetchUsers', async () => {
		mountPage();
		await flushPromises();
		expect(mockFetchUsers).toHaveBeenCalledTimes(1);
	});

	test('fetchUsers 失败时 notify.error 并 warn', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockFetchUsers.mockRejectedValueOnce(new Error('Network down'));
		mountPage();
		await flushPromises();

		expect(mockNotifyError).toHaveBeenCalledWith('Network down');
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test('fetch 错误优先取 response.data.message', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockFetchUsers.mockRejectedValueOnce({ response: { data: { message: 'forbidden' } } });
		mountPage();
		await flushPromises();
		expect(mockNotifyError).toHaveBeenCalledWith('forbidden');
	});

	test('fetch 错误无 message 时 fallback 为 Load failed', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockFetchUsers.mockRejectedValueOnce({});
		mountPage();
		await flushPromises();
		expect(mockNotifyError).toHaveBeenCalledWith('Load failed');
	});
});

describe('AdminUsersPage — 搜索', () => {
	test('输入触发 300ms 去抖后 resetUsers + fetchUsers({ search })', async () => {
		vi.useFakeTimers();
		const wrapper = mountPage();
		await flushPromises();
		mockFetchUsers.mockClear();
		mockResetUsers.mockClear();

		await wrapper.find('input.u-input-stub').setValue('alice');
		vi.advanceTimersByTime(299);
		expect(mockFetchUsers).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		await flushPromises();
		expect(mockResetUsers).toHaveBeenCalledTimes(1);
		expect(mockFetchUsers).toHaveBeenCalledWith({ search: 'alice' });
	});

	test('连续输入只在最后一次后 300ms 触发（debounce 合并）', async () => {
		vi.useFakeTimers();
		const wrapper = mountPage();
		await flushPromises();
		mockFetchUsers.mockClear();

		const input = wrapper.find('input.u-input-stub');
		await input.setValue('a');
		vi.advanceTimersByTime(200);
		await input.setValue('al');
		vi.advanceTimersByTime(200);
		await input.setValue('alice');
		vi.advanceTimersByTime(299);
		expect(mockFetchUsers).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		await flushPromises();
		expect(mockFetchUsers).toHaveBeenCalledTimes(1);
		expect(mockFetchUsers).toHaveBeenCalledWith({ search: 'alice' });
	});

	test('搜索失败 notify.error', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const wrapper = mountPage();
		await flushPromises();
		mockNotifyError.mockClear();
		mockFetchUsers.mockRejectedValueOnce(new Error('search failed'));

		await wrapper.find('input.u-input-stub').setValue('x');
		vi.advanceTimersByTime(300);
		await flushPromises();

		expect(mockNotifyError).toHaveBeenCalledWith('search failed');
	});

	test('unmount 后 pending debounce 不触发 fetch', async () => {
		vi.useFakeTimers();
		const wrapper = mountPage();
		await flushPromises();
		mockFetchUsers.mockClear();
		mockResetUsers.mockClear();

		await wrapper.find('input.u-input-stub').setValue('x');
		wrapper.unmount();
		vi.advanceTimersByTime(500);
		await flushPromises();

		expect(mockFetchUsers).not.toHaveBeenCalled();
		expect(mockResetUsers).not.toHaveBeenCalled();
	});

	test('重入时从 store.users.search 回显输入框且不重复触发 doSearch', async () => {
		vi.useFakeTimers();
		const wrapper = mountPage({ usersState: { search: 'alice' } });
		await flushPromises();
		expect(mockFetchUsers).toHaveBeenCalledTimes(1);
		expect(wrapper.find('input.u-input-stub').element.value).toBe('alice');

		vi.advanceTimersByTime(500);
		await flushPromises();
		expect(mockFetchUsers).toHaveBeenCalledTimes(1);
		expect(mockResetUsers).not.toHaveBeenCalled();
	});

	test('重入时 store.users.search 为空则保持输入框空', async () => {
		const wrapper = mountPage({ usersState: { search: '' } });
		await flushPromises();
		expect(wrapper.find('input.u-input-stub').element.value).toBe('');
	});
});

describe('AdminUsersPage — 分页', () => {
	test('存在 nextCursor 时渲染 Load more 按钮并调 fetchMoreUsers', async () => {
		const wrapper = mountPage({
			usersState: { nextCursor: 'c1', items: [{ id: '1', name: 'n', loginName: 'ln', clawCount: 1, createdAt: null, lastLoginAt: null }] },
		});
		await flushPromises();
		const btn = wrapper.find('button.u-button-stub');
		expect(btn.exists()).toBe(true);
		expect(btn.text()).toContain('Load more');

		await btn.trigger('click');
		expect(mockFetchMoreUsers).toHaveBeenCalledTimes(1);
	});

	test('nextCursor 为 null 时不渲染 Load more 按钮', async () => {
		const wrapper = mountPage({ usersState: { nextCursor: null } });
		await flushPromises();
		expect(wrapper.find('button.u-button-stub').exists()).toBe(false);
	});

	test('fetchMoreUsers 失败时 notify.error', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockFetchMoreUsers.mockRejectedValueOnce({ response: { data: { message: 'bad' } } });
		const wrapper = mountPage({ usersState: { nextCursor: 'c1' } });
		await flushPromises();

		await wrapper.find('button.u-button-stub').trigger('click');
		await flushPromises();

		expect(mockNotifyError).toHaveBeenCalledWith('bad');
	});

	test('fetchMoreUsers 失败对象无 message 时 fallback', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockFetchMoreUsers.mockRejectedValueOnce({});
		const wrapper = mountPage({ usersState: { nextCursor: 'c1' } });
		await flushPromises();

		await wrapper.find('button.u-button-stub').trigger('click');
		await flushPromises();

		expect(mockNotifyError).toHaveBeenCalledWith('Load failed');
	});
});

describe('AdminUsersPage — 渲染', () => {
	const nowIso = new Date().toISOString();

	test('error 文本在 store.users.error 存在时显示', async () => {
		const wrapper = mountPage({ usersState: { error: 'Something wrong' } });
		await flushPromises();
		expect(wrapper.text()).toContain('Something wrong');
	});

	test('空列表移动端显示 No data', async () => {
		const wrapper = mountPage();
		await flushPromises();
		expect(wrapper.text()).toContain('No data');
	});

	test('loading 状态不显示移动端 no data 提示', async () => {
		const wrapper = mountPage({ usersState: { loading: true } });
		await flushPromises();
		const mobileNoData = wrapper.findAll('p.text-dimmed').filter(p => p.text() === 'No data');
		expect(mobileNoData.length).toBe(0);
	});

	test('name fallback 链：name → loginName → —', async () => {
		const wrapper = mountPage({
			usersState: {
				items: [
					{ id: '1', name: 'Alice', loginName: 'alice', clawCount: 0, createdAt: nowIso, lastLoginAt: nowIso },
					{ id: '2', name: null, loginName: 'bob', clawCount: 0, createdAt: nowIso, lastLoginAt: nowIso },
					{ id: '3', name: null, loginName: null, clawCount: 0, createdAt: nowIso, lastLoginAt: nowIso },
				],
			},
		});
		await flushPromises();
		expect(wrapper.text()).toContain('Alice');
		expect(wrapper.text()).toContain('bob');
		// id 3 name 和 loginName 均为 null 时显示 —
		expect(wrapper.text()).toContain('—');
	});

	test('loginName null 时桌面列显示 —', async () => {
		const wrapper = mountPage({
			usersState: {
				items: [{ id: '1', name: 'a', loginName: null, clawCount: 5, createdAt: nowIso, lastLoginAt: nowIso }],
			},
		});
		await flushPromises();
		expect(wrapper.text()).toContain('—');
	});

	test('clawCount 0 时正常显示', async () => {
		const wrapper = mountPage({
			usersState: {
				items: [{ id: '1', name: 'a', loginName: 'alice', clawCount: 0, createdAt: nowIso, lastLoginAt: nowIso }],
			},
		});
		await flushPromises();
		// 移动端卡片以 "Instances: 0" 渲染
		expect(wrapper.text()).toContain('Instances: 0');
	});

	test('clawCount null 时默认显示 0', async () => {
		const wrapper = mountPage({
			usersState: {
				items: [{ id: '1', name: 'a', loginName: 'alice', clawCount: null, createdAt: nowIso, lastLoginAt: nowIso }],
			},
		});
		await flushPromises();
		expect(wrapper.text()).toContain('Instances: 0');
	});

	test('移动端卡片显示 loginName 前缀 @', async () => {
		const wrapper = mountPage({
			usersState: {
				items: [{ id: '1', name: 'Alice', loginName: 'alice', clawCount: 3, createdAt: nowIso, lastLoginAt: nowIso }],
			},
		});
		await flushPromises();
		expect(wrapper.text()).toContain('@alice');
	});

	test('移动端 loginName 为 null 时不显示 @ 前缀', async () => {
		const wrapper = mountPage({
			usersState: {
				items: [{ id: '1', name: 'Alice', loginName: null, clawCount: 3, createdAt: nowIso, lastLoginAt: nowIso }],
			},
		});
		await flushPromises();
		// 限定在移动端卡片范围内检查 @；避免未来 i18n 引入无关 @ 字符造成误报
		const article = wrapper.find('article');
		expect(article.exists()).toBe(true);
		expect(article.text()).not.toMatch(/@/);
	});
});

describe('AdminUsersPage — formatTimeAgo', () => {
	const baseUser = (createdAt, lastLoginAt = null) => ({
		id: '1', name: 'n', loginName: 'l', clawCount: 0, createdAt, lastLoginAt,
	});

	test('null → —', async () => {
		const wrapper = mountPage({ usersState: { items: [baseUser(null, null)] } });
		await flushPromises();
		expect(wrapper.text()).toContain('—');
	});

	test('invalid date → —', async () => {
		const wrapper = mountPage({ usersState: { items: [baseUser('not-a-date')] } });
		await flushPromises();
		expect(wrapper.text()).toContain('—');
	});

	test('未来时间 → —（diff < 0）', async () => {
		const future = new Date(Date.now() + 60_000).toISOString();
		const wrapper = mountPage({ usersState: { items: [baseUser(future)] } });
		await flushPromises();
		expect(wrapper.text()).toContain('—');
	});

	test('< 60s → Just now', async () => {
		const near = new Date(Date.now() - 30_000).toISOString();
		const wrapper = mountPage({ usersState: { items: [baseUser(near)] } });
		await flushPromises();
		expect(wrapper.text()).toContain('Just now');
	});

	test('3 分钟前 → 3m ago', async () => {
		const past = new Date(Date.now() - 3 * 60_000).toISOString();
		const wrapper = mountPage({ usersState: { items: [baseUser(past)] } });
		await flushPromises();
		expect(wrapper.text()).toContain('3m ago');
	});

	test('2 小时前 → 2h ago', async () => {
		const past = new Date(Date.now() - 2 * 3600_000).toISOString();
		const wrapper = mountPage({ usersState: { items: [baseUser(past)] } });
		await flushPromises();
		expect(wrapper.text()).toContain('2h ago');
	});

	test('3 天前 → 3d ago', async () => {
		const past = new Date(Date.now() - 3 * 86400_000).toISOString();
		const wrapper = mountPage({ usersState: { items: [baseUser(past)] } });
		await flushPromises();
		expect(wrapper.text()).toContain('3d ago');
	});

	test('lastLoginAt 独立渲染：非空显示时间、null 显示 —', async () => {
		const nowIso = new Date().toISOString();
		const wrapper = mountPage({
			usersState: {
				items: [
					{ id: '1', name: 'a', loginName: 'x', clawCount: 1, createdAt: nowIso, lastLoginAt: null },
				],
			},
		});
		await flushPromises();
		// createdAt 渲染为 Just now，lastLoginAt 渲染为 —；两者同时存在证明两个字段独立生效
		expect(wrapper.text()).toContain('Just now');
		expect(wrapper.text()).toContain('—');
	});
});
