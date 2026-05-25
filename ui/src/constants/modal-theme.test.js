import { describe, test, expect } from 'vitest';
import { MODAL_THEME } from './modal-theme.js';

describe('MODAL_THEME — 全局 modal 主题覆盖形态', () => {
	const { slots, variants } = MODAL_THEME;

	test('header：紧凑 min-h-13 + py-1，关闭叉左右分布，横向两级 px-4/sm:px-5（非默认 min-h-16）', () => {
		expect(slots.header).toContain('min-h-13');
		expect(slots.header).not.toContain('min-h-16');
		expect(slots.header).toContain('justify-between');
		expect(slots.header).toContain('py-1');
		expect(slots.header).toContain('px-4');
		expect(slots.header).toContain('sm:px-5');
	});

	test('body：保留 flex-1，横向 px-4/sm:px-5，纵向 pt-4/sm:pt-5 + pb-5 sm:pb-5', () => {
		// flex-1 必须保留——合并是拼接，漏写会让内置 p-4/sm:p-6 残留生效
		expect(slots.body).toContain('flex-1');
		expect(slots.body).toContain('px-4');
		expect(slots.body).toContain('sm:px-5');
		expect(slots.body).toContain('pt-4');
		expect(slots.body).toContain('sm:pt-5');
		expect(slots.body).toContain('pb-5');
		// sm:pb-5 不可删：专为压住内置残留的 sm:p-6(24px)，否则桌面端 body 底边回弹到 24px
		expect(slots.body).toContain('sm:pb-5');
	});

	test('footer：横向对齐 + py-2，保留 flex 布局', () => {
		expect(slots.footer).toContain('px-4');
		expect(slots.footer).toContain('sm:px-5');
		expect(slots.footer).toContain('py-2');
		expect(slots.footer).toContain('items-center');
	});

	test('close：行内静态、用 cc-icon-btn-lg', () => {
		expect(slots.close).toContain('static');
		expect(slots.close).toContain('cc-icon-btn-lg');
	});

	test('红线：variants.fullscreen.true 绝不能带 content 键（否则 defu 会顶掉内置 inset-0、全屏画错）', () => {
		expect(variants.fullscreen.true).toBeDefined();
		expect(Object.keys(variants.fullscreen.true)).not.toContain('content');
	});

	test('安全区只在 fullscreen 时垫：header 收顶部，footer 收底部', () => {
		expect(variants.fullscreen.true.header).toContain('var(--safe-area-inset-top)');
		expect(variants.fullscreen.true.footer).toContain('var(--safe-area-inset-bottom)');
	});

	test('body 底部安全区用 :last-child 守卫——仅当 body 是最底元素（无 footer）时才垫', () => {
		expect(variants.fullscreen.true.body).toContain(':last-child');
		expect(variants.fullscreen.true.body).toContain('var(--safe-area-inset-bottom)');
	});
});
