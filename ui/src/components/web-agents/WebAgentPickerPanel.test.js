import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const openExternalUrlMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../utils/external-url.js', () => ({
	openExternalUrl: openExternalUrlMock,
}));

const apiMock = vi.hoisted(() => ({
	listWebAgents: vi.fn().mockResolvedValue([]),
	recordWebAgentClick: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/web-agents.api.js', () => apiMock);

import WebAgentPickerPanel from './WebAgentPickerPanel.vue';
import { useWebAgentsStore } from '../../stores/web-agents.store.js';

const UIconStub = {
	props: ['name'],
	template: '<i :data-icon="name" />',
};
const UButtonStub = {
	template: '<button class="u-button-stub" @click="$emit(\'click\')"><slot /></button>',
	emits: ['click'],
};

function createWrapper(options = {}) {
	const pinia = createPinia();
	setActivePinia(pinia);
	return mount(WebAgentPickerPanel, {
		global: {
			plugins: [pinia],
			stubs: { UIcon: UIconStub, UButton: UButtonStub },
			mocks: { $t: (k) => k, $te: () => false },
		},
		...options,
	});
}

describe('WebAgentPickerPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('loading 且 items 为空时显示 loading 占位', async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		// 让 mounted() 的 loadAll 永久 pending，确保 loading 维持
		store.loadAll = vi.fn(() => new Promise(() => {}));
		store.loading = true;
		store.items = [];

		const wrapper = mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				mocks: { $t: (k) => k, $te: () => false },
			},
		});

		expect(wrapper.find('[data-testid="web-agent-picker-loading"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="web-agent-picker-empty"]').exists()).toBe(false);
	});

	test('error != null 时显示重试按钮，点击重新加载', async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		store.loadAll = vi.fn().mockResolvedValue();
		store.loading = false;
		store.error = new Error('boom');
		store.items = [];

		const wrapper = mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				mocks: { $t: (k) => k, $te: () => false },
			},
		});

		expect(wrapper.find('[data-testid="web-agent-picker-error"]').exists()).toBe(true);
		// mounted 调一次，retry 再调一次
		await wrapper.find('.u-button-stub').trigger('click');
		expect(store.loadAll).toHaveBeenCalledTimes(2);
	});

	test('空态：无 loading / error 且 list 为空时显示 empty', async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		store.loadAll = vi.fn().mockResolvedValue();
		store.loading = false;
		store.items = [];

		const wrapper = mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				mocks: { $t: (k) => k, $te: () => false },
			},
		});

		expect(wrapper.find('[data-testid="web-agent-picker-empty"]').exists()).toBe(true);
	});

	test('列表渲染按 pickerList 顺序，点击触发 recordClick + openExternalUrl + selected 事件', async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		store.loadAll = vi.fn().mockResolvedValue();
		store.recordClick = vi.fn();
		store.loading = false;
		store.items = [
			{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', sort: 1, lastClickedAt: null },
			{ id: 2, slug: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/', sort: 2, lastClickedAt: null },
		];

		const wrapper = mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				mocks: { $t: (k) => k, $te: () => false },
			},
		});

		const items = wrapper.findAll('[data-testid^="web-agent-item-"]');
		expect(items).toHaveLength(2);
		expect(items[0].attributes('data-testid')).toBe('web-agent-item-deepseek');

		await items[1].trigger('click');
		expect(store.recordClick).toHaveBeenCalledWith(2);
		expect(openExternalUrlMock).toHaveBeenCalledWith('https://www.doubao.com/chat/');
		expect(wrapper.emitted('selected')).toHaveLength(1);
		expect(wrapper.emitted('selected')[0][0]).toEqual(store.items[1]);
	});

	test('mounted 时调用 store.loadAll', async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		const spy = vi.spyOn(store, 'loadAll').mockResolvedValue();

		mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				mocks: { $t: (k) => k, $te: () => false },
			},
		});

		expect(spy).toHaveBeenCalledTimes(1);
	});

	test('iconFor: 无 slug 或未注册 slug 时返回 null（fallback 到 UIcon）', () => {
		const wrapper = createWrapper();
		expect(wrapper.vm.iconFor(null)).toBeNull();
		expect(wrapper.vm.iconFor('unknown-not-in-glob')).toBeNull();
	});

	test('error 但 items 非空时仍渲染列表（不被错误占位替换）', async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		store.loadAll = vi.fn().mockResolvedValue();
		store.loading = false;
		store.error = new Error('reload failed');
		store.items = [
			{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u', sort: 1, lastClickedAt: null },
		];

		const wrapper = mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				mocks: { $t: (k) => k, $te: () => false },
			},
		});

		expect(wrapper.find('[data-testid="web-agent-picker-error"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="web-agent-item-deepseek"]').exists()).toBe(true);
	});

	test('openExternalUrl 失败时被 catch，不产生 unhandled rejection，selected 仍 emit', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		openExternalUrlMock.mockRejectedValueOnce(new Error('open failed'));

		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		store.loadAll = vi.fn().mockResolvedValue();
		store.recordClick = vi.fn();
		store.loading = false;
		store.items = [
			{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'https://x.test/', sort: 1, lastClickedAt: null },
		];

		const wrapper = mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				mocks: { $t: (k) => k, $te: () => false },
			},
		});

		await wrapper.find('[data-testid="web-agent-item-deepseek"]').trigger('click');
		// 等微任务消化 fire-and-forget 的 catch
		await new Promise((r) => setTimeout(r, 0));

		expect(wrapper.emitted('selected')).toHaveLength(1);
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test('双击同一个 item：仅触发一次 recordClick / openExternalUrl / selected', async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		store.loadAll = vi.fn().mockResolvedValue();
		store.recordClick = vi.fn();
		store.loading = false;
		store.items = [
			{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'https://x.test/', sort: 1, lastClickedAt: null },
		];

		const wrapper = mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				mocks: { $t: (k) => k, $te: () => false },
			},
		});

		const btn = wrapper.find('[data-testid="web-agent-item-deepseek"]');
		await btn.trigger('click');
		await btn.trigger('click');

		expect(store.recordClick).toHaveBeenCalledTimes(1);
		expect(openExternalUrlMock).toHaveBeenCalledTimes(1);
		expect(wrapper.emitted('selected')).toHaveLength(1);
	});

	test('防抖窗口结束后允许再次选择（重新打开 dialog 后用户能正常点击）', async () => {
		vi.useFakeTimers();
		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		store.loadAll = vi.fn().mockResolvedValue();
		store.recordClick = vi.fn();
		store.loading = false;
		store.items = [
			{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u', sort: 1, lastClickedAt: null },
		];

		const wrapper = mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				mocks: { $t: (k) => k, $te: () => false },
			},
		});

		const btn = wrapper.find('[data-testid="web-agent-item-deepseek"]');
		await btn.trigger('click');
		expect(store.recordClick).toHaveBeenCalledTimes(1);

		// 推进过防抖窗口
		vi.advanceTimersByTime(400);
		await wrapper.vm.$nextTick();

		await btn.trigger('click');
		expect(store.recordClick).toHaveBeenCalledTimes(2);
	});

	test('items 非空时背景刷新（loading=true）不显示 loading 占位且列表仍可见可点', async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		store.loadAll = vi.fn().mockResolvedValue();
		store.recordClick = vi.fn();
		store.loading = true;
		store.items = [
			{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u', sort: 1, lastClickedAt: '2026-05-01T00:00:00Z' },
		];

		const wrapper = mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				mocks: { $t: (k) => k, $te: () => false },
			},
		});

		expect(wrapper.find('[data-testid="web-agent-picker-loading"]').exists()).toBe(false);
		const item = wrapper.find('[data-testid="web-agent-item-deepseek"]');
		expect(item.exists()).toBe(true);
		await item.trigger('click');
		expect(store.recordClick).toHaveBeenCalledWith(1);
	});

	test('retry 时 loading 必盖过陈旧 error（loading=true && error≠null && items=[]）', async () => {
		// 用户场景：第一次 loadAll 失败，点 retry 进入 loading；UI 必须立即切到 loading，
		// 否则用户会以为 retry 没生效（错误占位还停留）
		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		store.loadAll = vi.fn(() => new Promise(() => {})); // 永久 pending 模拟 retry in-flight
		store.loading = true;
		store.error = new Error('previous-failure');
		store.items = [];

		const wrapper = mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				mocks: { $t: (k) => k, $te: () => false },
			},
		});

		expect(wrapper.find('[data-testid="web-agent-picker-loading"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="web-agent-picker-error"]').exists()).toBe(false);
	});

	test('item 右侧两端对齐显示 i18n 厂商名（slug 命中 webAgents.vendors.<slug>）', async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		store.loadAll = vi.fn().mockResolvedValue();
		store.loading = false;
		store.items = [
			{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u', sort: 1, lastClickedAt: null },
		];

		const vendorTable = { 'webAgents.vendors.deepseek': '深度求索' };
		const wrapper = mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				mocks: {
					$t: (k) => vendorTable[k] ?? k,
					$te: (k) => k in vendorTable,
				},
			},
		});

		const vendor = wrapper.find('[data-testid="web-agent-item-vendor"]');
		expect(vendor.exists()).toBe(true);
		expect(vendor.text()).toBe('深度求索');
	});

	test('item 厂商名：slug 未在 vendors map 命中时不渲染（避免回退成键名）', async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		store.loadAll = vi.fn().mockResolvedValue();
		store.loading = false;
		store.items = [
			{ id: 9, slug: 'unknown-brand', name: 'X', url: 'u', sort: 9, lastClickedAt: null },
		];

		const wrapper = mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				mocks: { $t: (k) => k, $te: () => false },
			},
		});

		expect(wrapper.find('[data-testid="web-agent-item-vendor"]').exists()).toBe(false);
	});

	test('item 厂商名极端长名时也参与截断（truncate + min-w-0，无 shrink-0）', async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		store.loadAll = vi.fn().mockResolvedValue();
		store.loading = false;
		store.items = [
			{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u', sort: 1, lastClickedAt: null },
		];

		const vendorTable = { 'webAgents.vendors.deepseek': 'A Very Long Vendor Name That Should Truncate' };
		const wrapper = mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				mocks: {
					$t: (k) => vendorTable[k] ?? k,
					$te: (k) => k in vendorTable,
				},
			},
		});

		const vendor = wrapper.find('[data-testid="web-agent-item-vendor"]');
		expect(vendor.exists()).toBe(true);
		const cls = vendor.classes();
		expect(cls).toContain('truncate');
		expect(cls).toContain('min-w-0');
		expect(cls).not.toContain('shrink-0');
	});

	test('item 厂商名：自建项 slug=null 不渲染厂商', async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		store.loadAll = vi.fn().mockResolvedValue();
		store.loading = false;
		store.items = [
			{ id: 42, slug: null, name: 'My Site', url: 'u', sort: null, lastClickedAt: null },
		];

		const wrapper = mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				// 即使 $te 一律返回 true，slug=null 也不应触发 vendor 查询
				mocks: { $t: () => '不该出现', $te: () => true },
			},
		});

		expect(wrapper.find('[data-testid="web-agent-item-vendor"]').exists()).toBe(false);
	});

	test('item 容器用 -mx-3 抵消 dialog body 横向 padding，让 icon 与 title 纵向对齐', async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		store.loadAll = vi.fn().mockResolvedValue();
		store.loading = false;
		store.items = [
			{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u', sort: 1, lastClickedAt: null },
		];

		const wrapper = mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				mocks: { $t: (k) => k, $te: () => false },
			},
		});

		const item = wrapper.find('[data-testid="web-agent-item-deepseek"]');
		// 视觉对齐契约：负 margin 必须存在；同时保留 cursor-pointer 让 hover 出现手型
		expect(item.classes()).toContain('-mx-3');
		expect(item.classes()).toContain('cursor-pointer');
	});

	test('item 图标和 fallback UIcon 均为装饰性，不会被屏幕阅读器重复读出', () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const store = useWebAgentsStore();
		store.loadAll = vi.fn().mockResolvedValue();
		store.loading = false;
		store.items = [
			{ id: 1, slug: 'deepseek', name: 'DeepSeek', url: 'u', sort: 1, lastClickedAt: null },
		];

		const wrapper = mount(WebAgentPickerPanel, {
			global: {
				plugins: [pinia],
				stubs: { UIcon: UIconStub, UButton: UButtonStub },
				mocks: { $t: (k) => k, $te: () => false },
			},
		});

		const item = wrapper.find('[data-testid="web-agent-item-deepseek"]');
		// 图标对屏幕阅读器隐藏（可能是 img 或 fallback UIcon，二者必居其一）
		const decorative = item.find('[aria-hidden="true"]');
		expect(decorative.exists()).toBe(true);
	});
});
