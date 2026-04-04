import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/capacitor-app.js', () => ({
	syncStatusBarStyle: vi.fn(),
}));

import { applyThemeMode, syncThemeModeFromSettings } from './theme-mode.js';
import { syncStatusBarStyle } from '../utils/capacitor-app.js';

/** 清理 meta[name="theme-color"] */
function removeThemeColorMeta() {
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.remove();
}

/** 设置 matchMedia 返回值 */
function mockMatchMedia(prefersDark) {
	window.matchMedia = vi.fn((query) => ({
		matches: query === '(prefers-color-scheme: dark)' ? prefersDark : false,
		media: query,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	}));
}

beforeEach(() => {
	// 重置 DOM 状态
	document.documentElement.classList.remove('dark');
	delete document.documentElement.dataset.theme;
	removeThemeColorMeta();
	vi.clearAllMocks();
	// 默认 matchMedia: prefers light
	mockMatchMedia(false);
});

afterEach(() => {
	removeThemeColorMeta();
});

describe('normalizeTheme（通过 applyThemeMode 间接测试）', () => {
	test('非字符串输入回退为 dark', () => {
		expect(applyThemeMode(null)).toBe('dark');
		expect(applyThemeMode(undefined)).toBe('dark');
		expect(applyThemeMode(123)).toBe('dark');
		expect(applyThemeMode({})).toBe('dark');
		expect(applyThemeMode(true)).toBe('dark');
	});

	test('空字符串回退为 dark', () => {
		expect(applyThemeMode('')).toBe('dark');
	});

	test('无效字符串回退为 dark', () => {
		expect(applyThemeMode('invalid')).toBe('dark');
		expect(applyThemeMode('blue')).toBe('dark');
		expect(applyThemeMode('Auto1')).toBe('dark');
	});

	test('有效值 dark/light/auto 正常返回', () => {
		expect(applyThemeMode('dark')).toBe('dark');
		expect(applyThemeMode('light')).toBe('light');
		expect(applyThemeMode('auto')).toBe('auto');
	});

	test('含空格和大小写混合能正确处理', () => {
		expect(applyThemeMode('  Dark ')).toBe('dark');
		expect(applyThemeMode('LIGHT')).toBe('light');
		expect(applyThemeMode(' AUTO ')).toBe('auto');
		expect(applyThemeMode('  DaRk  ')).toBe('dark');
	});
});

describe('resolveAppliedTheme（通过 applyThemeMode 间接测试）', () => {
	test('auto + prefers-color-scheme: dark 解析为 dark', () => {
		mockMatchMedia(true);
		applyThemeMode('auto');
		expect(document.documentElement.classList.contains('dark')).toBe(true);
		expect(document.documentElement.dataset.theme).toBe('dark');
	});

	test('auto + prefers-color-scheme: light 解析为 light', () => {
		mockMatchMedia(false);
		applyThemeMode('auto');
		expect(document.documentElement.classList.contains('dark')).toBe(false);
		expect(document.documentElement.dataset.theme).toBe('light');
	});

	test('dark 直接应用 dark', () => {
		applyThemeMode('dark');
		expect(document.documentElement.classList.contains('dark')).toBe(true);
		expect(document.documentElement.dataset.theme).toBe('dark');
	});

	test('light 直接应用 light', () => {
		applyThemeMode('light');
		expect(document.documentElement.classList.contains('dark')).toBe(false);
		expect(document.documentElement.dataset.theme).toBe('light');
	});

	test('auto 模式下 matchMedia 不存在时回退为 light', () => {
		// 删除 matchMedia 使 typeof window.matchMedia !== 'function'
		const original = window.matchMedia;
		delete window.matchMedia;
		applyThemeMode('auto');
		expect(document.documentElement.classList.contains('dark')).toBe(false);
		expect(document.documentElement.dataset.theme).toBe('light');
		// 恢复
		window.matchMedia = original;
	});
});

describe('applyThemeMode — 非浏览器环境', () => {
	test('isBrowser 为 false 时直接返回 theme 不操作 DOM', () => {
		// 临时移除 document 使 isBrowser() 返回 false
		const originalDoc = globalThis.document;
		// @ts-ignore
		delete globalThis.document;
		try {
			const result = applyThemeMode('light');
			expect(result).toBe('light');
			// dark 主题也应正常返回
			const result2 = applyThemeMode('dark');
			expect(result2).toBe('dark');
		} finally {
			globalThis.document = originalDoc;
		}
	});
});

describe('applyThemeMode', () => {
	test('dark 模式添加 dark class', () => {
		applyThemeMode('dark');
		expect(document.documentElement.classList.contains('dark')).toBe(true);
	});

	test('light 模式移除 dark class', () => {
		document.documentElement.classList.add('dark');
		applyThemeMode('light');
		expect(document.documentElement.classList.contains('dark')).toBe(false);
	});

	test('设置 dataset.theme', () => {
		applyThemeMode('dark');
		expect(document.documentElement.dataset.theme).toBe('dark');

		applyThemeMode('light');
		expect(document.documentElement.dataset.theme).toBe('light');
	});

	test('调用 syncStatusBarStyle', () => {
		applyThemeMode('dark');
		expect(syncStatusBarStyle).toHaveBeenCalledWith('dark');

		applyThemeMode('light');
		expect(syncStatusBarStyle).toHaveBeenCalledWith('light');
	});

	test('返回 normalize 后的 theme 值', () => {
		expect(applyThemeMode('dark')).toBe('dark');
		expect(applyThemeMode('light')).toBe('light');
		expect(applyThemeMode('auto')).toBe('auto');
		expect(applyThemeMode('invalid')).toBe('dark');
	});
});

describe('updateThemeColorMeta（通过 applyThemeMode 间接测试）', () => {
	test('meta 不存在时创建新的 theme-color meta', () => {
		expect(document.querySelector('meta[name="theme-color"]')).toBeNull();
		applyThemeMode('dark');
		const meta = document.querySelector('meta[name="theme-color"]');
		expect(meta).not.toBeNull();
		expect(meta.getAttribute('content')).toBe('#202122');
	});

	test('meta 已存在时更新 content 值', () => {
		// 先创建
		applyThemeMode('dark');
		const meta1 = document.querySelector('meta[name="theme-color"]');
		expect(meta1.getAttribute('content')).toBe('#202122');

		// 再更新
		applyThemeMode('light');
		const meta2 = document.querySelector('meta[name="theme-color"]');
		expect(meta2.getAttribute('content')).toBe('#ffffff');
		// 应是同一个元素
		expect(meta1).toBe(meta2);
	});

	test('dark 模式设置正确颜色 #202122', () => {
		applyThemeMode('dark');
		const meta = document.querySelector('meta[name="theme-color"]');
		expect(meta.getAttribute('content')).toBe('#202122');
	});

	test('light 模式设置正确颜色 #ffffff', () => {
		applyThemeMode('light');
		const meta = document.querySelector('meta[name="theme-color"]');
		expect(meta.getAttribute('content')).toBe('#ffffff');
	});
});

describe('syncThemeModeFromSettings', () => {
	test('从 settings 对象读取 theme 并应用', () => {
		const result = syncThemeModeFromSettings({ theme: 'light' });
		expect(result).toBe('light');
		expect(document.documentElement.dataset.theme).toBe('light');
	});

	test('settings 为 null 时回退为 dark', () => {
		const result = syncThemeModeFromSettings(null);
		expect(result).toBe('dark');
		expect(document.documentElement.classList.contains('dark')).toBe(true);
	});

	test('settings 为 undefined 时回退为 dark', () => {
		const result = syncThemeModeFromSettings(undefined);
		expect(result).toBe('dark');
	});

	test('settings.theme 不存在时回退为 dark', () => {
		const result = syncThemeModeFromSettings({});
		expect(result).toBe('dark');
	});

	test('settings.theme 为无效值时回退为 dark', () => {
		const result = syncThemeModeFromSettings({ theme: 'invalid' });
		expect(result).toBe('dark');
	});

	test('settings.theme 为 auto 时正常工作', () => {
		mockMatchMedia(true);
		const result = syncThemeModeFromSettings({ theme: 'auto' });
		expect(result).toBe('auto');
		expect(document.documentElement.classList.contains('dark')).toBe(true);
	});
});
