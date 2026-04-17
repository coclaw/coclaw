import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest';

// --- Mocks ---

const mockFetchClaws = vi.fn();
const mockFetchMoreClaws = vi.fn();
const mockResetClaws = vi.fn();
const mockNotifyError = vi.fn();

// 页面本身不再直接订阅 SSE（由 AdminLayout 管理 store.startStream / stopStream），
// 但 mock 保留以便断言"页面不会主动建连"
const mockConnectAdminStream = vi.fn(() => ({ close: vi.fn() }));
vi.mock('../services/admin-stream.js', () => ({
	connectAdminStream: (...args) => mockConnectAdminStream(...args),
}));

vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => ({
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		error: mockNotifyError,
	}),
}));

// 默认 fake store（每个 test 可改）
let fakeStore;

// 替换 useAdminStore，避免依赖真实 pinia store 逻辑干扰。
// 工厂返回的闭包在每次 useAdminStore() 被调用时读取最新的 fakeStore
vi.mock('../stores/admin.store.js', () => ({
	useAdminStore: () => fakeStore,
}));

import AdminClawsPage from './AdminClawsPage.vue';

// --- UTable / UI 组件 stubs ---

const UTableStub = {
	props: ['data', 'columns', 'loading', 'empty', 'getRowId', 'getRowCanExpand'],
	template: `
		<div class="u-table-stub" :data-loading="loading" :data-empty="empty">
			<div
				v-for="row in data"
				:key="row.id"
				class="u-table-row"
				:data-id="row.id"
			>
				<slot
					name="name-cell"
					:row="{ original: row, getIsExpanded: () => true, toggleExpanded: toggleExpanded }"
				/>
				<slot
					name="online-cell"
					:row="{ original: row }"
				/>
				<slot
					name="user-cell"
					:row="{ original: row }"
				/>
				<slot
					name="pluginVersion-cell"
					:row="{ original: row }"
				/>
				<slot
					name="createdAt-cell"
					:row="{ original: row }"
				/>
				<slot
					name="expanded"
					:row="{ original: row }"
				/>
			</div>
		</div>
	`,
	methods: {
		toggleExpanded() { /* no-op in stub */ },
	},
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
	'admin.claws.title': 'Instance Management',
	'admin.claws.searchPlaceholder': 'Search by name',
	'admin.claws.columnName': 'Instance',
	'admin.claws.columnStatus': 'Status',
	'admin.claws.columnUser': 'User',
	'admin.claws.columnVersion': 'Plugin',
	'admin.claws.columnCreatedAt': 'Bound At',
	'admin.claws.expandAgentName': 'Agent',
	'admin.claws.expandModel': 'Current Model',
	'admin.claws.noAgentModels': 'Information not yet available',
	'admin.claws.emptyAgents': 'No agents',
	'admin.common.loadMore': 'Load more',
	'admin.common.noData': 'No data',
	'admin.common.online': 'Online',
	'admin.common.offline': 'Offline',
	'dashboard.justNow': 'Just now',
	'dashboard.minutesAgo': '{n}m ago',
	'dashboard.hoursAgo': '{n}h ago',
	'dashboard.daysAgo': '{n}d ago',
};

function mountPage(overrides = {}) {
	// 默认 store state
	fakeStore = {
		claws: {
			items: [],
			nextCursor: null,
			loading: false,
			search: '',
			error: null,
			...overrides.clawsState,
		},
		fetchClaws: mockFetchClaws,
		fetchMoreClaws: mockFetchMoreClaws,
		resetClaws: mockResetClaws,
	};

	return mount(AdminClawsPage, {
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
	mockFetchClaws.mockReset();
	mockFetchMoreClaws.mockReset();
	mockResetClaws.mockReset();
	mockNotifyError.mockReset();
	mockConnectAdminStream.mockClear();
	mockFetchClaws.mockResolvedValue();
	mockFetchMoreClaws.mockResolvedValue();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('AdminClawsPage — mount', () => {
	test('mounted 调用 fetchClaws，但不直接订阅 SSE', async () => {
		const wrapper = mountPage();
		await flushPromises();

		expect(mockFetchClaws).toHaveBeenCalledTimes(1);
		// 页面本身不再主动建连（由 AdminLayout 统一管理）
		expect(mockConnectAdminStream).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	test('fetchClaws 失败时 notify.error 并 warn', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockFetchClaws.mockRejectedValueOnce(new Error('Network down'));
		mountPage();
		await flushPromises();

		expect(mockNotifyError).toHaveBeenCalledWith('Network down');
		expect(warnSpy).toHaveBeenCalled();
		expect(mockConnectAdminStream).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test('fetch 错误优先取 response.data.message', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockFetchClaws.mockRejectedValueOnce({ response: { data: { message: 'forbidden' } } });
		mountPage();
		await flushPromises();
		expect(mockNotifyError).toHaveBeenCalledWith('forbidden');
	});

	test('fetch 错误无 message 时 fallback 为 Load failed', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockFetchClaws.mockRejectedValueOnce({});
		mountPage();
		await flushPromises();
		expect(mockNotifyError).toHaveBeenCalledWith('Load failed');
	});
});

describe('AdminClawsPage — 搜索', () => {
	test('输入触发 300ms 去抖后 resetClaws + fetchClaws({ search })', async () => {
		vi.useFakeTimers();
		const wrapper = mountPage();
		await flushPromises();
		mockFetchClaws.mockClear();
		mockResetClaws.mockClear();

		await wrapper.find('input.u-input-stub').setValue('alice');
		// 299ms 内不触发
		vi.advanceTimersByTime(299);
		expect(mockFetchClaws).not.toHaveBeenCalled();
		// 到 300ms
		vi.advanceTimersByTime(1);
		await flushPromises();
		expect(mockResetClaws).toHaveBeenCalledTimes(1);
		expect(mockFetchClaws).toHaveBeenCalledWith({ search: 'alice' });
	});

	test('连续输入只在最后一次后 300ms 触发（debounce 合并）', async () => {
		vi.useFakeTimers();
		const wrapper = mountPage();
		await flushPromises();
		mockFetchClaws.mockClear();

		const input = wrapper.find('input.u-input-stub');
		await input.setValue('a');
		vi.advanceTimersByTime(200);
		await input.setValue('al');
		vi.advanceTimersByTime(200);
		await input.setValue('alice');
		vi.advanceTimersByTime(299);
		expect(mockFetchClaws).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		await flushPromises();
		expect(mockFetchClaws).toHaveBeenCalledTimes(1);
		expect(mockFetchClaws).toHaveBeenCalledWith({ search: 'alice' });
	});

	test('搜索失败 notify.error', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const wrapper = mountPage();
		await flushPromises(); // 让 mounted 的 fetchClaws resolve 完成
		mockNotifyError.mockClear();
		mockFetchClaws.mockRejectedValueOnce(new Error('search failed'));

		await wrapper.find('input.u-input-stub').setValue('x');
		vi.advanceTimersByTime(300);
		await flushPromises();

		expect(mockNotifyError).toHaveBeenCalledWith('search failed');
	});

	test('unmount 后 pending debounce 不触发 fetch', async () => {
		vi.useFakeTimers();
		const wrapper = mountPage();
		await flushPromises();
		mockFetchClaws.mockClear();
		mockResetClaws.mockClear();

		await wrapper.find('input.u-input-stub').setValue('x');
		wrapper.unmount();
		vi.advanceTimersByTime(500);
		await flushPromises();

		expect(mockFetchClaws).not.toHaveBeenCalled();
		expect(mockResetClaws).not.toHaveBeenCalled();
	});

	test('重入时从 store.claws.search 回显输入框且不重复触发 doSearch', async () => {
		vi.useFakeTimers();
		const wrapper = mountPage({ clawsState: { search: 'alice' } });
		await flushPromises();
		// mounted 调用一次 fetchClaws，watcher 排队的 debounce timer 被清除
		expect(mockFetchClaws).toHaveBeenCalledTimes(1);
		// 输入框回显 store 中的 search
		expect(wrapper.find('input.u-input-stub').element.value).toBe('alice');

		// 等超过 300ms，doSearch 不应被再次触发
		vi.advanceTimersByTime(500);
		await flushPromises();
		expect(mockFetchClaws).toHaveBeenCalledTimes(1);
		expect(mockResetClaws).not.toHaveBeenCalled();
	});

	test('重入时 store.claws.search 为空则保持输入框空', async () => {
		const wrapper = mountPage({ clawsState: { search: '' } });
		await flushPromises();
		expect(wrapper.find('input.u-input-stub').element.value).toBe('');
	});
});

describe('AdminClawsPage — 分页', () => {
	test('存在 nextCursor 时渲染 Load more 按钮并调 fetchMoreClaws', async () => {
		const wrapper = mountPage({
			clawsState: { nextCursor: 'c1', items: [{ id: '1', online: false, agentModels: null, createdAt: null }] },
		});
		await flushPromises();
		const btn = wrapper.find('button.u-button-stub');
		expect(btn.exists()).toBe(true);
		expect(btn.text()).toContain('Load more');

		await btn.trigger('click');
		expect(mockFetchMoreClaws).toHaveBeenCalledTimes(1);
	});

	test('nextCursor 为 null 时不渲染 Load more 按钮', async () => {
		mockFetchClaws.mockResolvedValue();
		const wrapper = mountPage({ clawsState: { nextCursor: null } });
		await flushPromises();
		expect(wrapper.find('button.u-button-stub').exists()).toBe(false);
	});

	test('fetchMoreClaws 失败时 notify.error', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockFetchMoreClaws.mockRejectedValueOnce({ response: { data: { message: 'bad' } } });
		const wrapper = mountPage({ clawsState: { nextCursor: 'c1' } });
		await flushPromises();

		await wrapper.find('button.u-button-stub').trigger('click');
		await flushPromises();

		expect(mockNotifyError).toHaveBeenCalledWith('bad');
	});

	test('fetchMoreClaws 失败对象无 message 时 fallback', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockFetchMoreClaws.mockRejectedValueOnce({});
		const wrapper = mountPage({ clawsState: { nextCursor: 'c1' } });
		await flushPromises();

		await wrapper.find('button.u-button-stub').trigger('click');
		await flushPromises();

		expect(mockNotifyError).toHaveBeenCalledWith('Load failed');
	});
});

describe('AdminClawsPage — 渲染', () => {
	const nowIso = new Date().toISOString();

	test('error 文本在 store.claws.error 存在时显示', async () => {
		const wrapper = mountPage({ clawsState: { error: 'Something wrong' } });
		await flushPromises();
		expect(wrapper.text()).toContain('Something wrong');
	});

	test('空列表移动端显示 No data', async () => {
		const wrapper = mountPage();
		await flushPromises();
		expect(wrapper.text()).toContain('No data');
	});

	test('loading 状态不显示移动端 no data 提示', async () => {
		const wrapper = mountPage({ clawsState: { loading: true } });
		await flushPromises();
		// loading=true 时 mobile 空态提示不显示
		// 桌面 UTable stub 的 empty 属性仍会传但不应渲染 noData 文案
		const mobileNoData = wrapper.findAll('p.text-dimmed').filter(p => p.text() === 'No data');
		expect(mobileNoData.length).toBe(0);
	});

	test('agentModels === null 时显示 noAgentModels', async () => {
		const wrapper = mountPage({
			clawsState: {
				items: [{ id: '1', name: 'n', online: true, agentModels: null, createdAt: nowIso }],
			},
		});
		await flushPromises();
		expect(wrapper.text()).toContain('Information not yet available');
	});

	test('agentModels === [] 时显示 emptyAgents', async () => {
		const wrapper = mountPage({
			clawsState: {
				items: [{ id: '1', name: 'n', online: true, agentModels: [], createdAt: nowIso }],
			},
		});
		await flushPromises();
		expect(wrapper.text()).toContain('No agents');
	});

	test('agentModels 有内容时展开行渲染每个 agent × model', async () => {
		// 填充全字段，避免 pluginVersion/user 空值产生的 "—" 干扰 model null 的断言
		const wrapper = mountPage({
			clawsState: {
				items: [{
					id: '1',
					name: 'Claw-1',
					userName: 'Alice',
					userLoginName: 'alice',
					pluginVersion: '1.2.3',
					online: true,
					agentModels: [
						{ id: 'main', name: 'Main Agent', model: 'claude-opus-4' },
						{ id: 'p', name: null, model: null },
					],
					createdAt: new Date(Date.now() - 30_000).toISOString(),
				}],
			},
		});
		await flushPromises();
		expect(wrapper.text()).toContain('Main Agent');
		expect(wrapper.text()).toContain('claude-opus-4');
		// name 为 null 回退到 id
		expect(wrapper.text()).toContain('p');
		// 此行已排除 pluginVersion/user 的 "—"，因此 "—" 唯一来源于 model null 的 fallback
		expect(wrapper.text()).toContain('—');
	});

	test('name 为空字符串时回退显示 hostName', async () => {
		const wrapper = mountPage({
			clawsState: {
				items: [
					{ id: '1', name: '', hostName: 'ubuntu', online: true, agentModels: null, createdAt: nowIso },
				],
			},
		});
		await flushPromises();
		expect(wrapper.text()).toContain('ubuntu');
	});

	test('online=true 渲染 Online，false 渲染 Offline', async () => {
		const wrapper = mountPage({
			clawsState: {
				items: [
					{ id: '1', name: 'a', online: true, agentModels: null, createdAt: nowIso },
					{ id: '2', name: 'b', online: false, agentModels: null, createdAt: nowIso },
				],
			},
		});
		await flushPromises();
		expect(wrapper.text()).toContain('Online');
		expect(wrapper.text()).toContain('Offline');
	});

	test('user 列 fallback 链：userName → userLoginName → —', async () => {
		const wrapper = mountPage({
			clawsState: {
				items: [
					{ id: '1', name: 'a', online: true, userName: 'Alice', userLoginName: 'alice', agentModels: null, createdAt: nowIso },
					{ id: '2', name: 'b', online: true, userName: null, userLoginName: 'bob', agentModels: null, createdAt: nowIso },
					{ id: '3', name: 'c', online: true, userName: null, userLoginName: null, agentModels: null, createdAt: nowIso },
				],
			},
		});
		await flushPromises();
		expect(wrapper.text()).toContain('Alice');
		expect(wrapper.text()).toContain('bob');
	});

	test('pluginVersion null 时显示 —', async () => {
		const wrapper = mountPage({
			clawsState: {
				items: [{ id: '1', name: 'a', online: true, pluginVersion: null, agentModels: null, createdAt: nowIso }],
			},
		});
		await flushPromises();
		expect(wrapper.text()).toContain('—');
	});
});

describe('AdminClawsPage — formatTimeAgo', () => {
	test('null → —', async () => {
		const wrapper = mountPage({
			clawsState: { items: [{ id: '1', name: 'n', online: true, agentModels: null, createdAt: null }] },
		});
		await flushPromises();
		expect(wrapper.text()).toContain('—');
	});

	test('invalid date → —', async () => {
		const wrapper = mountPage({
			clawsState: { items: [{ id: '1', name: 'n', online: true, agentModels: null, createdAt: 'not-a-date' }] },
		});
		await flushPromises();
		expect(wrapper.text()).toContain('—');
	});

	test('未来时间 → —（diff < 0）', async () => {
		const future = new Date(Date.now() + 60_000).toISOString();
		const wrapper = mountPage({
			clawsState: { items: [{ id: '1', name: 'n', online: true, agentModels: null, createdAt: future }] },
		});
		await flushPromises();
		expect(wrapper.text()).toContain('—');
	});

	test('< 60s → Just now', async () => {
		const near = new Date(Date.now() - 30_000).toISOString();
		const wrapper = mountPage({
			clawsState: { items: [{ id: '1', name: 'n', online: true, agentModels: null, createdAt: near }] },
		});
		await flushPromises();
		expect(wrapper.text()).toContain('Just now');
	});

	test('3 分钟前 → 3m ago', async () => {
		const past = new Date(Date.now() - 3 * 60_000).toISOString();
		const wrapper = mountPage({
			clawsState: { items: [{ id: '1', name: 'n', online: true, agentModels: null, createdAt: past }] },
		});
		await flushPromises();
		expect(wrapper.text()).toContain('3m ago');
	});

	test('2 小时前 → 2h ago', async () => {
		const past = new Date(Date.now() - 2 * 3600_000).toISOString();
		const wrapper = mountPage({
			clawsState: { items: [{ id: '1', name: 'n', online: true, agentModels: null, createdAt: past }] },
		});
		await flushPromises();
		expect(wrapper.text()).toContain('2h ago');
	});

	test('3 天前 → 3d ago', async () => {
		const past = new Date(Date.now() - 3 * 86400_000).toISOString();
		const wrapper = mountPage({
			clawsState: { items: [{ id: '1', name: 'n', online: true, agentModels: null, createdAt: past }] },
		});
		await flushPromises();
		expect(wrapper.text()).toContain('3d ago');
	});
});

describe('AdminClawsPage — 移动端展开交互', () => {
	test('点击移动卡片切换 mobileExpanded 状态', async () => {
		const wrapper = mountPage({
			clawsState: {
				items: [{
					id: '1',
					name: 'A',
					online: true,
					agentModels: [{ id: 'main', name: 'Main', model: 'opus' }],
					createdAt: null,
				}],
			},
		});
		await flushPromises();

		// 初始未展开
		expect(wrapper.vm.mobileExpanded['1']).toBeFalsy();

		const articleButton = wrapper.find('article button');
		await articleButton.trigger('click');
		await flushPromises();
		expect(wrapper.vm.mobileExpanded['1']).toBe(true);

		await articleButton.trigger('click');
		await flushPromises();
		expect(wrapper.vm.mobileExpanded['1']).toBe(false);
	});
});
