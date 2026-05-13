import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import { sleep } from './async-utils.js';

describe('sleep', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('无 signal（普通 sleep）', () => {
		test('到点 resolve', async () => {
			let done = false;
			const p = sleep(100).then(() => { done = true; });
			await vi.advanceTimersByTimeAsync(99);
			expect(done).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(done).toBe(true);
			await p;
		});

		test('timeout=0 也能正常 resolve', async () => {
			const p = sleep(0);
			await vi.advanceTimersByTimeAsync(0);
			await expect(p).resolves.toBeUndefined();
		});
	});

	describe('signal 已 aborted（同步拒绝）', () => {
		test('reject 通用 Error', async () => {
			const ctrl = new AbortController();
			ctrl.abort();
			await expect(sleep(100, ctrl.signal)).rejects.toThrow(/aborted/);
		});

		test('挂 listener 之前先同步查 aborted，无窗口竞态', async () => {
			const ctrl = new AbortController();
			ctrl.abort();
			let listenerAdded = false;
			const proxy = new Proxy(ctrl.signal, {
				get(target, prop) {
					if (prop === 'addEventListener') {
						return (...args) => { listenerAdded = true; return target.addEventListener(...args); };
					}
					return Reflect.get(target, prop);
				},
			});
			await expect(sleep(100, proxy)).rejects.toThrow();
			expect(listenerAdded).toBe(false);
		});
	});

	describe('signal 途中 abort', () => {
		test('reject 并清掉 timer，到点也不再 resolve', async () => {
			const ctrl = new AbortController();
			const p = sleep(100, ctrl.signal);
			let rejected = false;
			p.catch(() => { rejected = true; });
			await vi.advanceTimersByTimeAsync(50);
			ctrl.abort();
			await vi.advanceTimersByTimeAsync(0);
			expect(rejected).toBe(true);
			// 即使走完原本的 timeout，也不会再触发 resolve（promise 已 settled）
			await vi.advanceTimersByTimeAsync(100);
		});

		test('正常到点 resolve 后再 abort 同一 signal 不影响（已 settled）', async () => {
			const ctrl = new AbortController();
			const p = sleep(50, ctrl.signal);
			await vi.advanceTimersByTimeAsync(50);
			await expect(p).resolves.toBeUndefined();
			ctrl.abort(); // 没事
		});

		test('resolve 路径会 removeEventListener（不泄漏到后续同 signal 的 abort）', async () => {
			const ctrl = new AbortController();
			const addSpy = vi.spyOn(ctrl.signal, 'addEventListener');
			const removeSpy = vi.spyOn(ctrl.signal, 'removeEventListener');
			const p = sleep(50, ctrl.signal);
			await vi.advanceTimersByTimeAsync(50);
			await p;
			// 到点 resolve 后 listener 被摘下
			expect(addSpy).toHaveBeenCalledTimes(1);
			expect(removeSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('reason 透传', () => {
		test('reason 是 Error 实例 → 直接 reject 它', async () => {
			const ctrl = new AbortController();
			const reason = new Error('user-cancel');
			const p = sleep(100, ctrl.signal);
			ctrl.abort(reason);
			await expect(p).rejects.toBe(reason);
		});

		test('reason 是字符串 → 包成 Error 携带文案', async () => {
			const ctrl = new AbortController();
			const p = sleep(100, ctrl.signal);
			ctrl.abort('timeout');
			await expect(p).rejects.toThrow(/aborted: timeout/);
		});

		test('signal.aborted 但无 reason（老浏览器路径）→ 通用 Error', async () => {
			// 模拟没有 reason 字段的 signal（baseline Safari 15.0)
			const fakeSignal = {
				aborted: true,
				reason: undefined,
				addEventListener: () => {},
				removeEventListener: () => {},
			};
			await expect(sleep(100, fakeSignal)).rejects.toThrow(/^aborted$/);
		});
	});
});
