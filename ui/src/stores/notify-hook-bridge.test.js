import { test, expect, describe, vi } from 'vitest';

// 捕获注册的 hooks（vi.hoisted 确保在 vi.mock 提升后仍可访问）
const { capture } = vi.hoisted(() => {
	const capture = { hooks: {} };
	return { capture };
});
vi.mock('./claws.store.js', () => ({
	__registerNotifyHooks: (hooks) => { capture.hooks = hooks; },
}));

// mock useNotify —— 捕获 .warning 调用 + 累计 useNotify 调用次数（用于 lazy 契约断言）
const mockWarning = vi.fn();
// 模块级累加计数，beforeEach 不会清零，便于断言"import 期间没 eager 调"
const { useNotifyCounter } = vi.hoisted(() => ({ useNotifyCounter: { count: 0 } }));
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => {
		useNotifyCounter.count++;
		return {
			success: vi.fn(),
			info: vi.fn(),
			warning: (...args) => mockWarning(...args),
			error: vi.fn(),
		};
	},
}));

// mock i18n —— 拼成 key+params 便于断言
vi.mock('../i18n/index.js', () => ({
	i18n: {
		global: {
			t: (key, params) => `${key}|${JSON.stringify(params ?? {})}`,
		},
	},
}));

// 导入触发自注册
import './notify-hook-bridge.js';
// 抓取 import 完成时 useNotify 的累计调用次数（应为 0：bridge 只注册闭包，不 eager 调用）
const useNotifyCallsAtImport = useNotifyCounter.count;

describe('notify-hook-bridge', () => {
	test('导入时调用 __registerNotifyHooks 注册 notify + t', () => {
		expect(capture.hooks).toBeDefined();
		expect(typeof capture.hooks.notify).toBe('function');
		expect(typeof capture.hooks.t).toBe('function');
	});

	// lazy 契约：bridge 模块 import 时不能 eager 调用 useNotify（否则会触发 Vue inject 警告）
	// 真实调用必须延迟到 hook 被触发那一刻
	test('useNotify 在 import 时不被 eager 调用，仅 hook fire 时调一次', () => {
		expect(useNotifyCallsAtImport).toBe(0);
		const before = useNotifyCounter.count;
		capture.hooks.notify({ title: 'lazy-test' });
		expect(useNotifyCounter.count).toBe(before + 1);
	});

	test('notify hook 转发到 useNotify().warning', () => {
		mockWarning.mockClear();
		capture.hooks.notify({ title: 'hello' });
		expect(mockWarning).toHaveBeenCalledWith({ title: 'hello' });
	});

	test('t hook 转发到 i18n.global.t（带 params）', () => {
		const out = capture.hooks.t('notify.rtcUnrecoverable', { clawName: 'A', n: 2 });
		expect(out).toBe('notify.rtcUnrecoverable|{"clawName":"A","n":2}');
	});

	test('t hook 不传 params 时仍能调用', () => {
		const out = capture.hooks.t('notify.rtcUnrecoverable');
		expect(out).toContain('notify.rtcUnrecoverable');
	});
});
