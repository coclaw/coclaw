import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useDraftStore } from './draft.store.js';

describe('draft.store', () => {
	let store;
	let sessionStorageMock;

	beforeEach(() => {
		setActivePinia(createPinia());
		store = useDraftStore();

		sessionStorageMock = {
			store: {},
			getItem: vi.fn((key) => sessionStorageMock.store[key] ?? null),
			setItem: vi.fn((key, val) => { sessionStorageMock.store[key] = val; }),
			removeItem: vi.fn((key) => { delete sessionStorageMock.store[key]; }),
			clear: vi.fn(() => { sessionStorageMock.store = {}; }),
		};
		vi.stubGlobal('sessionStorage', sessionStorageMock);
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

	describe('persist / restore', () => {
		test('persist 将草稿写入 sessionStorage', () => {
			store.setDraft('chat:1:main', '你好');
			store.setDraft('topic:t1', '世界');
			store.persist();

			expect(sessionStorageMock.setItem).toHaveBeenCalledWith(
				'coclaw:drafts',
				expect.any(String),
			);
			const saved = JSON.parse(sessionStorageMock.store['coclaw:drafts']);
			expect(saved).toEqual({ 'chat:1:main': '你好', 'topic:t1': '世界' });
		});

		test('persist 无草稿时移除 sessionStorage 条目', () => {
			store.persist();
			expect(sessionStorageMock.removeItem).toHaveBeenCalledWith('coclaw:drafts');
		});

		test('restore 从 sessionStorage 恢复草稿', () => {
			sessionStorageMock.store['coclaw:drafts'] = JSON.stringify({
				'chat:1:main': '恢复的文本',
				'topic:t2': '另一条',
			});

			store.restore();
			expect(store.getDraft('chat:1:main')).toBe('恢复的文本');
			expect(store.getDraft('topic:t2')).toBe('另一条');
		});

		test('restore 跳过非字符串和空值', () => {
			sessionStorageMock.store['coclaw:drafts'] = JSON.stringify({
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
			sessionStorageMock.store['coclaw:drafts'] = 'not-json';
			store.restore();
			expect(Object.keys(store.drafts)).toHaveLength(0);
		});

		test('persist 在 sessionStorage 异常时静默', () => {
			store.setDraft('k', 'v');
			sessionStorageMock.setItem.mockImplementation(() => { throw new Error('quota'); });
			expect(() => store.persist()).not.toThrow();
		});
	});

	describe('initPersist', () => {
		test('注册 beforeunload 和 visibilitychange 事件并调用 restore', () => {
			const winSpy = vi.spyOn(window, 'addEventListener');
			const docSpy = vi.spyOn(document, 'addEventListener');
			const restoreSpy = vi.spyOn(store, 'restore');

			store.initPersist();

			expect(winSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
			expect(docSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
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

			expect(sessionStorageMock.setItem).toHaveBeenCalled();
		});

		test('visibilitychange hidden 触发 persist', () => {
			const docSpy = vi.spyOn(document, 'addEventListener');
			store.initPersist();

			store.setDraft('k', 'v');
			const handler = docSpy.mock.calls.find(([evt]) => evt === 'visibilitychange')[1];

			// 模拟 hidden 状态
			Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
			handler();

			expect(sessionStorageMock.setItem).toHaveBeenCalled();

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

			expect(sessionStorageMock.setItem).not.toHaveBeenCalled();
		});
	});
});
