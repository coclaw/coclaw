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
		// cc-scrollbar-thin：Electron 作用域细滚动条 marker，web/Capacitor 下惰性
		expect(slots.body).toContain('cc-scrollbar-thin');
	});

	test('footer：横向对齐 + py-2，保留 flex 布局', () => {
		expect(slots.footer).toContain('px-4');
		expect(slots.footer).toContain('sm:px-5');
		expect(slots.footer).toContain('py-2');
		expect(slots.footer).toContain('items-center');
	});

	test('title：跳柔为 text-default 且带 important（! 锁定，压住内置并存的 text-highlighted）', () => {
		// tailwind-merge 不认 Nuxt UI 语义色同组，append 的 text-default 与内置 text-highlighted 会并存，
		// 必须靠 important 决胜——漏掉 ! 则 CSS 顺序决定、标题可能回弹纯白
		expect(slots.title).toContain('text-default');
		expect(slots.title).toContain('!');
	});

	test('close：行内静态、用 cc-icon-btn-lg', () => {
		expect(slots.close).toContain('static');
		expect(slots.close).toContain('cc-icon-btn-lg');
	});

	test('content：base slot 叠 quasar 多层投影 + 暗色柔和白光晕/淡描边（脱离背景）', () => {
		expect(slots.content).toContain('shadow-[');
		expect(slots.content).toContain('dark:shadow-[');
		expect(slots.content).toContain('dark:ring-white/10');
		// cc-modal-content：Electron 标题栏避让的惰性 marker（main.css 作用域规则的命中锚点）
		expect(slots.content).toContain('cc-modal-content');
	});

	test('overlay：不覆盖，保持 nuxt 内置 /75（之前的加深偏暗，光晕已足够脱离背景）', () => {
		expect(slots.overlay).toBeUndefined();
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
