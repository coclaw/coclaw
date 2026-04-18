import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';

// 共享 mock 句柄：mount 之前被填充，测试里读写
const hoisted = vi.hoisted(() => ({
	authStore: null, // 由 vi.mock 内 reactive 构造填充
	sigConn: null,
	sseInstances: [], // 每次 setup 调用 useClawStatusSse 追加一个
}));

vi.mock('../stores/auth.store.js', async () => {
	const { reactive } = await vi.importActual('vue');
	hoisted.authStore = reactive({
		user: null,
		refreshSession: vi.fn(() => Promise.resolve()),
		logout: vi.fn(() => Promise.resolve()),
	});
	return { useAuthStore: () => hoisted.authStore };
});

vi.mock('../stores/claws.store.js', () => ({
	useClawsStore: () => ({}),
}));

vi.mock('../services/signaling-connection.js', () => {
	hoisted.sigConn = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		state: 'disconnected',
	};
	return { useSignalingConnection: () => hoisted.sigConn };
});

vi.mock('../composables/use-claw-status-sse.js', () => ({
	useClawStatusSse: vi.fn(() => {
		const api = {
			connected: { value: false },
			start: vi.fn(),
			stop: vi.fn(),
		};
		hoisted.sseInstances.push(api);
		return api;
	}),
}));

vi.mock('../services/remote-log.js', () => ({
	useRemoteLog: vi.fn(),
	remoteLog: vi.fn(),
}));

vi.mock('../composables/use-pull-refresh.js', async () => {
	const { ref } = await vi.importActual('vue');
	return {
		usePullRefresh: () => ({
			pulling: ref(false),
			pullDistance: ref(0),
			pastThreshold: ref(false),
		}),
	};
});

vi.mock('../utils/platform.js', () => ({
	isCapacitorApp: false,
	isNativeShell: false,
}));

// 组件本体替换为 stub，避免 vitest 加载其依赖（Nuxt UI 的 #imports 在测试环境不可解析）
vi.mock('../components/DesktopSidebar.vue', () => ({
	default: { name: 'DesktopSidebar', template: '<div class="sidebar-stub" />' },
}));
vi.mock('../components/MobileBottomTabs.vue', () => ({
	default: { name: 'MobileBottomTabs', template: '<div class="tabs-stub" />' },
}));

import AuthedLayout from './AuthedLayout.vue';
import { useClawStatusSse } from '../composables/use-claw-status-sse.js';

let activeWrappers = [];

function mountLayout() {
	const wrapper = mount(AuthedLayout, {
		global: {
			stubs: {
				DesktopSidebar: { template: '<div class="sidebar-stub" />' },
				MobileBottomTabs: { template: '<div class="tabs-stub" />' },
				RouterView: { template: '<div class="router-view-stub" />' },
				UIcon: { template: '<i />' },
			},
			mocks: {
				$route: { path: '/', meta: {} },
				$router: { replace: vi.fn(() => Promise.resolve()) },
			},
		},
	});
	activeWrappers.push(wrapper);
	return wrapper;
}

/** 取最近一次 useClawStatusSse() 返回的句柄 */
function currentSse() {
	return hoisted.sseInstances[hoisted.sseInstances.length - 1];
}

beforeEach(() => {
	hoisted.authStore.user = null;
	hoisted.sigConn.connect.mockReset();
	hoisted.sigConn.disconnect.mockReset();
	hoisted.sseInstances = [];
	vi.mocked(useClawStatusSse).mockClear();
});

afterEach(() => {
	// 兜底 unmount：防止残留 watch 监听同一 reactive user 造成跨 test 污染
	for (const w of activeWrappers) {
		try { w.unmount(); } catch { /* already unmounted in test body */ }
	}
	activeWrappers = [];
});

describe('AuthedLayout 按登录态启停连接', () => {
	test('user=null 挂载：不调 sig.connect / sse.start', async () => {
		const wrapper = mountLayout();
		await flushPromises();
		const sse = currentSse();
		expect(hoisted.sigConn.connect).not.toHaveBeenCalled();
		expect(sse.start).not.toHaveBeenCalled();
		// 且 sse 以 autoStart:false 被创建
		expect(useClawStatusSse).toHaveBeenCalledWith(expect.any(Object), { autoStart: false });
		wrapper.unmount();
	});

	test('user=已登录用户 挂载：调 sig.connect + sse.start 各一次', async () => {
		hoisted.authStore.user = { id: 'u1' };
		const wrapper = mountLayout();
		await flushPromises();
		const sse = currentSse();
		expect(hoisted.sigConn.connect).toHaveBeenCalledTimes(1);
		expect(sse.start).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	test('挂载后 user 从 null → 有效：触发 connect + start', async () => {
		const wrapper = mountLayout();
		await flushPromises();
		const sse = currentSse();
		// 挂载瞬间 immediate 回调看到 user=null → 走 else 分支，disconnect/stop 各调一次（幂等）
		expect(hoisted.sigConn.connect).not.toHaveBeenCalled();
		expect(sse.start).not.toHaveBeenCalled();
		hoisted.sigConn.disconnect.mockClear();
		sse.stop.mockClear();

		hoisted.authStore.user = { id: 'u1' };
		await nextTick();

		expect(hoisted.sigConn.connect).toHaveBeenCalledTimes(1);
		expect(sse.start).toHaveBeenCalledTimes(1);
		expect(hoisted.sigConn.disconnect).not.toHaveBeenCalled();
		expect(sse.stop).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	test('挂载后 user 从有效 → null：触发 disconnect + stop', async () => {
		hoisted.authStore.user = { id: 'u1' };
		const wrapper = mountLayout();
		await flushPromises();
		const sse = currentSse();
		hoisted.sigConn.connect.mockClear();
		sse.start.mockClear();

		hoisted.authStore.user = null;
		await nextTick();

		expect(hoisted.sigConn.disconnect).toHaveBeenCalledTimes(1);
		expect(sse.stop).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	test('user 从 A → B（不同 id）：先停再启', async () => {
		hoisted.authStore.user = { id: 'u1' };
		const wrapper = mountLayout();
		await flushPromises();
		const sse = currentSse();
		hoisted.sigConn.connect.mockClear();
		sse.start.mockClear();

		hoisted.authStore.user = { id: 'u2' };
		await nextTick();

		// watch source 是 user?.id ?? null，从 'u1' → 'u2' 触发：
		// 新值为 truthy，走 connect/start 分支一次
		expect(hoisted.sigConn.connect).toHaveBeenCalledTimes(1);
		expect(sse.start).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	test('user 对象引用变化但 id 不变：不重复触发', async () => {
		hoisted.authStore.user = { id: 'u1', name: 'a' };
		const wrapper = mountLayout();
		await flushPromises();
		const sse = currentSse();
		hoisted.sigConn.connect.mockClear();
		sse.start.mockClear();

		// 模拟 refreshSession 刷新 user 对象（同 id 新引用）
		hoisted.authStore.user = { id: 'u1', name: 'a-updated' };
		await nextTick();

		expect(hoisted.sigConn.connect).not.toHaveBeenCalled();
		expect(sse.start).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	test('组件 unmount 后 user 变化不再触发启停', async () => {
		hoisted.authStore.user = { id: 'u1' };
		const wrapper = mountLayout();
		await flushPromises();
		const sse = currentSse();
		wrapper.unmount();
		hoisted.sigConn.connect.mockClear();
		hoisted.sigConn.disconnect.mockClear();
		sse.start.mockClear();
		sse.stop.mockClear();

		hoisted.authStore.user = null;
		await nextTick();

		expect(hoisted.sigConn.connect).not.toHaveBeenCalled();
		expect(hoisted.sigConn.disconnect).not.toHaveBeenCalled();
		expect(sse.start).not.toHaveBeenCalled();
	});
});
