// @vitest-environment node
import { test, expect, describe, vi, beforeEach } from 'vitest';

// 捕获 store 注册的 hooks（vi.hoisted 确保在 vi.mock 提升后仍可访问）
const { capture } = vi.hoisted(() => ({ capture: { hooks: null } }));
vi.mock('./claws.store.js', () => ({
	__registerNotifyHooks: (hooks) => { capture.hooks = hooks; },
}));

// mock i18n —— 用 vi.fn 既能控制返回值又能断言调用参数
const mockI18nT = vi.hoisted(() => vi.fn((key, params) => `${key}|${JSON.stringify(params ?? {})}`));
vi.mock('../i18n/index.js', () => ({
	i18n: {
		global: { t: mockI18nT },
	},
}));

import { wireNotifyHooks, getSharedNotifier } from './notify-hook-bridge.js';

// 模块刚 load、还未 wire 时的 shared 初值快照（顺序无关断言）
const sharedAtImport = getSharedNotifier();

beforeEach(() => {
	capture.hooks = null;
	mockI18nT.mockClear();
});

function makeNotifier() {
	return {
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		error: vi.fn(),
	};
}

describe('notify-hook-bridge', () => {
	test('模块刚加载时 getSharedNotifier 返回 null（未 wire 时初值）', () => {
		expect(sharedAtImport).toBeNull();
	});

	test('wireNotifyHooks 注册 notify hook 转发到 notifier.warning', () => {
		const notifier = makeNotifier();
		wireNotifyHooks(notifier);

		expect(capture.hooks).toBeDefined();
		expect(typeof capture.hooks.notify).toBe('function');

		capture.hooks.notify({ title: 'hello' });
		expect(notifier.warning).toHaveBeenCalledWith({ title: 'hello' });
	});

	test('wireNotifyHooks 注册 t hook 转发到 i18n.global.t（带 params）', () => {
		wireNotifyHooks(makeNotifier());

		expect(typeof capture.hooks.t).toBe('function');
		const out = capture.hooks.t('notify.rtcUnrecoverable', { clawName: 'A', n: 2 });
		expect(out).toBe('notify.rtcUnrecoverable|{"clawName":"A","n":2}');
	});

	test('t hook 不传 params 时仍以 (key, undefined) 调用 i18n.global.t', () => {
		wireNotifyHooks(makeNotifier());
		capture.hooks.t('notify.rtcUnrecoverable');
		expect(mockI18nT).toHaveBeenCalledWith('notify.rtcUnrecoverable', undefined);
	});

	test('getSharedNotifier 返回最近一次 wire 的 notifier 实例', () => {
		const a = makeNotifier();
		wireNotifyHooks(a);
		expect(getSharedNotifier()).toBe(a);

		const b = makeNotifier();
		wireNotifyHooks(b);
		expect(getSharedNotifier()).toBe(b);
	});

	test('多次 wireNotifyHooks 仍只注最新一份 hook，notify 转发到最新 notifier', () => {
		const a = makeNotifier();
		wireNotifyHooks(a);
		const b = makeNotifier();
		wireNotifyHooks(b);

		capture.hooks.notify({ title: 'fresh' });
		expect(b.warning).toHaveBeenCalledWith({ title: 'fresh' });
		expect(a.warning).not.toHaveBeenCalled();
	});
});
