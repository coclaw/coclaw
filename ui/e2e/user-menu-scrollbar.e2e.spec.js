import { expect, test } from '@playwright/test';
import { login } from './helpers.js';

/**
 * 桌面侧栏用户账户菜单：分隔线不致横向溢出 回归测试 @ui
 *
 * 回归点：全局 dropdownMenu 主题把 group 横向内边距清零（px-0，让高亮铺满整行），
 * 但 Nuxt UI 默认给 separator 配的 -mx-1 失去抵消对象 → 分隔线左右各凸 4px，被菜单
 * 滚动视口（overflow-y-auto → overflow-x 被算成 auto）接住，渲染出横向滚动条。
 * 修复：dropdownMenu.slots.separator 叠 mx-0 中和默认 -mx-1（见 vite.config.js）。
 *
 * 用户账户菜单是唯一含分隔线项（layout.data.js 里 separator:true）的 UDropdownMenu。
 * jsdom 不计算 CSS 布局，无法在单测验证溢出，故在 E2E 层锁回归。纯 UI 渲染，不依赖
 * 在线 claw。
 *
 * 前置条件：server 运行中，test 用户已存在。
 */
test('桌面侧栏用户菜单：内容容器无横向溢出 @ui', async ({ page }) => {
	test.setTimeout(30_000);
	await login(page);

	// 登录后桌面侧栏（md:flex，Playwright 默认 1280 视口满足）渲染用户菜单触发器
	await expect(page.getByTestId('user-menu-trigger')).toBeVisible({ timeout: 10_000 });
	await page.getByTestId('user-menu-trigger').click();

	// 菜单打开 = 含分隔线的 logout 项可见（locale 无关 testid 锚点，不断言中文文案）
	await expect(page.getByTestId('btn-logout')).toBeVisible({ timeout: 5000 });

	// 定位该菜单的滚动视口（Nuxt UI dropdownMenu 的 overflow-y-auto viewport slot，
	// 即 root cause 中接住横条的容器）；用「包含 btn-logout」的结构锚点圈定本菜单、
	// 避开页面其它可能的弹层
	const viewport = page.locator('[data-slot="viewport"]', { has: page.getByTestId('btn-logout') });
	await expect(viewport).toBeVisible();

	// 断言无横向溢出：scrollWidth <= clientWidth（留 2px 容差抗亚像素取整）。
	// 未修复时分隔线左右各凸 4px → scrollWidth 约 clientWidth+8，必然超容差。
	const { scrollWidth, clientWidth } = await viewport.evaluate((el) => ({
		scrollWidth: el.scrollWidth,
		clientWidth: el.clientWidth,
	}));
	expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
});
