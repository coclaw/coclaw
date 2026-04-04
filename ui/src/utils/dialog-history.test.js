import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

describe('dialog-history', () => {
	let mod;
	let pushStateSpy;
	let backSpy;

	beforeEach(async () => {
		vi.resetModules();
		pushStateSpy = vi.spyOn(history, 'pushState').mockImplementation(() => {});
		backSpy = vi.spyOn(history, 'back').mockImplementation(() => {});
		mod = await import('./dialog-history.js');
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('pushDialogState 后 hasOpenDialog 返回 true', () => {
		mod.pushDialogState(vi.fn());
		expect(mod.hasOpenDialog()).toBe(true);
		expect(pushStateSpy).toHaveBeenCalledOnce();
	});

	test('popDialogState 后 hasOpenDialog 返回 false 并调用 history.back', () => {
		mod.pushDialogState(vi.fn());
		mod.popDialogState();
		expect(mod.hasOpenDialog()).toBe(false);
		expect(backSpy).toHaveBeenCalledOnce();
	});

	test('重复调用 pushDialogState 不会重复 pushState', () => {
		const cb = vi.fn();
		mod.pushDialogState(cb);
		mod.pushDialogState(cb);
		expect(pushStateSpy).toHaveBeenCalledOnce();
	});

	test('closeCurrentDialog 调用回调并重置状态', () => {
		const cb = vi.fn();
		mod.pushDialogState(cb);
		mod.closeCurrentDialog();
		expect(cb).toHaveBeenCalledOnce();
		expect(mod.hasOpenDialog()).toBe(false);
	});

	test('closeCurrentDialog 无打开对话框时不做任何事', () => {
		const cb = vi.fn();
		mod.closeCurrentDialog();
		expect(cb).not.toHaveBeenCalled();
		expect(mod.hasOpenDialog()).toBe(false);
	});

	test('popDialogState 无打开对话框时不做任何事', () => {
		mod.popDialogState();
		expect(backSpy).not.toHaveBeenCalled();
		expect(mod.hasOpenDialog()).toBe(false);
	});

	test('popstate 事件触发关闭回调', () => {
		const cb = vi.fn();
		mod.pushDialogState(cb);
		// 模拟浏览器返回触发 popstate
		window.dispatchEvent(new PopStateEvent('popstate'));
		expect(cb).toHaveBeenCalledOnce();
		expect(mod.hasOpenDialog()).toBe(false);
	});
});
