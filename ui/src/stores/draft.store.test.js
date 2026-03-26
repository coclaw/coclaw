import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../utils/platform.js', () => ({
	isCapacitorApp: false,
	isTauriApp: false,
	isNativeShell: false,
	isDesktop: true,
}));

import { useAuthStore } from './auth.store.js';
import { useDraftStore } from './draft.store.js';

describe('draft.store', () => {
	let store;
	let storageMock;

	beforeEach(() => {
		setActivePinia(createPinia());
		store = useDraftStore();

		storageMock = {
			store: {},
			getItem: vi.fn((key) => storageMock.store[key] ?? null),
			setItem: vi.fn((key, val) => { storageMock.store[key] = val; }),
			removeItem: vi.fn((key) => { delete storageMock.store[key]; }),
			clear: vi.fn(() => { storageMock.store = {}; }),
		};
		// 浏览器环境默认使用 sessionStorage
		vi.stubGlobal('sessionStorage', storageMock);
		vi.stubGlobal('localStorage', storageMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('getDraft / setDraft / clearDraft', () => {
		test('getDraft 返回空字符串当 key 不存在时', () => {
			expect(store.getDraft('chat:1:main')).toBe('');
		});

		test('setDraft 写入后 getDraft 可读取', () => {
			store.setDraft('chat:1:main', '你好');
			expect(store.getDraft('chat:1:main')).toBe('你好');
		});

		test('setDraft 空字符串等同于清除', () => {
			store.setDraft('chat:1:main', '你好');
			store.setDraft('chat:1:main', '');
			expect(store.getDraft('chat:1:main')).toBe('');
			expect(store.drafts).not.toHaveProperty('chat:1:main');
		});

		test('setDraft 空 key 不写入', () => {
			store.setDraft('', '你好');
			expect(Object.keys(store.drafts)).toHaveLength(0);
		});

		test('clearDraft 清除指定 key', () => {
			store.setDraft('topic:abc', '草稿');
			store.clearDraft('topic:abc');
			expect(store.getDraft('topic:abc')).toBe('');
		});

		test('多个 key 互不影响', () => {
			store.setDraft('chat:1:main', 'A');
			store.setDraft('topic:t1', 'B');
			store.setDraft('new-topic:2:main', 'C');
			expect(store.getDraft('chat:1:main')).toBe('A');
			expect(store.getDraft('topic:t1')).toBe('B');
			expect(store.getDraft('new-topic:2:main')).toBe('C');
		});
	});

	describe('persist / restore（userId 隔离）', () => {
		test('未登录时使用基础 key', () => {
			store.setDraft('chat:1:main', '你好');
			store.persist();

			expect(storageMock.setItem).toHaveBeenCalledWith(
				'coclaw:drafts',
				expect.any(String),
			);
		});

		test('登录后使用 userId 隔离的 key', () => {
			const authStore = useAuthStore();
			authStore.user = { id: 'user-42' };

			store.setDraft('chat:1:main', '你好');
			store.persist();

			expect(storageMock.setItem).toHaveBeenCalledWith(
				'coclaw:drafts:user-42',
				expect.any(String),
			);
		});

		test('persist 将草稿写入存储', () => {
			store.setDraft('chat:1:main', '你好');
			store.setDraft('topic:t1', '世界');
			store.persist();

			const saved = JSON.parse(storageMock.store['coclaw:drafts']);
			expect(saved).toEqual({ 'chat:1:main': '你好', 'topic:t1': '世界' });
		});

		test('persist 无草稿时移除存储条目', () => {
			store.persist();
			expect(storageMock.removeItem).toHaveBeenCalledWith('coclaw:drafts');
		});

		test('restore 从存储恢复草稿', () => {
			storageMock.store['coclaw:drafts'] = JSON.stringify({
				'chat:1:main': '恢复的文本',
				'topic:t2': '另一条',
			});

			store.restore();
			expect(store.getDraft('chat:1:main')).toBe('恢复的文本');
			expect(store.getDraft('topic:t2')).toBe('另一条');
		});

		test('restore 跳过非字符串和空值', () => {
			storageMock.store['coclaw:drafts'] = JSON.stringify({
				'ok': '有效',
				'bad1': 123,
				'bad2': null,
				'bad3': '',
			});

			store.restore();
			expect(store.getDraft('ok')).toBe('有效');
			expect(store.drafts).not.toHaveProperty('bad1');
			expect(store.drafts).not.toHaveProperty('bad2');
			expect(store.drafts).not.toHaveProperty('bad3');
		});

		test('restore 在无数据时静默', () => {
			store.restore();
			expect(Object.keys(store.drafts)).toHaveLength(0);
		});

		test('restore 在 JSON 解析失败时静默', () => {
			storageMock.store['coclaw:drafts'] = 'not-json';
			store.restore();
			expect(Object.keys(store.drafts)).toHaveLength(0);
		});

		test('persist 在存储异常时静默', () => {
			store.setDraft('k', 'v');
			storageMock.setItem.mockImplementation(() => { throw new Error('quota'); });
			expect(() => store.persist()).not.toThrow();
		});
	});

	describe('onUserChanged', () => {
		test('清空内存态并从新 userId 的存储恢复', () => {
			store.setDraft('chat:1:main', '旧用户的草稿');

			const authStore = useAuthStore();
			authStore.user = { id: 'user-99' };

			storageMock.store['coclaw:drafts:user-99'] = JSON.stringify({
				'topic:t1': '新用户的草稿',
			});

			store.onUserChanged();

			expect(store.getDraft('chat:1:main')).toBe('');
			expect(store.getDraft('topic:t1')).toBe('新用户的草稿');
		});

		test('切换到无存储数据的用户时清空', () => {
			store.setDraft('chat:1:main', '数据');

			const authStore = useAuthStore();
			authStore.user = { id: 'user-new' };

			store.onUserChanged();

			expect(Object.keys(store.drafts)).toHaveLength(0);
		});
	});

	describe('initPersist', () => {
		test('注册 beforeunload、visibilitychange 和 app:background 事件并调用 restore', () => {
			const winSpy = vi.spyOn(window, 'addEventListener');
			const docSpy = vi.spyOn(document, 'addEventListener');
			const restoreSpy = vi.spyOn(store, 'restore');

			store.initPersist();

			expect(winSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
			expect(docSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
			expect(winSpy).toHaveBeenCalledWith('app:background', expect.any(Function));
			expect(restoreSpy).toHaveBeenCalled();
		});

		test('重复调用 initPersist 不会重复注册', () => {
			const winSpy = vi.spyOn(window, 'addEventListener');
			store.initPersist();
			store.initPersist();

			const beforeunloadCalls = winSpy.mock.calls.filter(([evt]) => evt === 'beforeunload');
			expect(beforeunloadCalls).toHaveLength(1);
		});

		test('beforeunload 触发 persist', () => {
			const winSpy = vi.spyOn(window, 'addEventListener');
			store.initPersist();

			store.setDraft('k', 'v');
			const handler = winSpy.mock.calls.find(([evt]) => evt === 'beforeunload')[1];
			handler();

			expect(storageMock.setItem).toHaveBeenCalled();
		});

		test('visibilitychange hidden 触发 persist', () => {
			const docSpy = vi.spyOn(document, 'addEventListener');
			store.initPersist();

			store.setDraft('k', 'v');
			const handler = docSpy.mock.calls.find(([evt]) => evt === 'visibilitychange')[1];

			// 模拟 hidden 状态
			Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
			handler();

			expect(storageMock.setItem).toHaveBeenCalled();

			// 恢复
			Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		});

		test('visibilitychange visible 不触发 persist', () => {
			const docSpy = vi.spyOn(document, 'addEventListener');
			store.initPersist();

			store.setDraft('k', 'v');
			const handler = docSpy.mock.calls.find(([evt]) => evt === 'visibilitychange')[1];

			Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
			handler();

			expect(storageMock.setItem).not.toHaveBeenCalled();
		});

		test('app:background 触发 persist', () => {
			const winSpy = vi.spyOn(window, 'addEventListener');
			store.initPersist();

			store.setDraft('k', 'v');
			const handler = winSpy.mock.calls.find(([evt]) => evt === 'app:background')[1];
			handler();

			expect(storageMock.setItem).toHaveBeenCalled();
		});
	});
});
