import { expect, test } from '@playwright/test';
import { login, navigateToChat } from './helpers.js';

/**
 * Electron 作用域布局回归测试（纯 CSS 几何，evaluate 挂 cc-electron-custom 类模拟壳内形态）：
 * - 滚动收进 .cc-app-content 容器（标题栏下方），document 永不滚
 * - 桌面侧栏 sticky 锚到容器顶 = 标题栏下缘
 * - ChatPage 定高填满容器，无双滚动条
 * - color-scheme 跟随明暗主题（暗色滚动条根因）
 * - modal 锁滚与容器滚动不互踩
 * - 全屏往返（inline 变量 --cc-titlebar-h 0px ↔ 移除）布局退化且 scrollTop 保留
 */

const TITLEBAR_H = 38;

/** 给 html 挂 Electron 自定义标题栏作用域类（纯 CSS 形态模拟，无需真壳） */
function applyElectronScope(page) {
	return page.evaluate(() => {
		document.documentElement.classList.add('cc-electron-custom');
	});
}

/** 在 AuthedLayout 的 section 内注入超高内容，使容器产生纵向溢出 */
function injectTallContent(page, height = 3000) {
	return page.evaluate((h) => {
		const section = document.querySelector('.cc-app-content section');
		if (!section) return false;
		const div = document.createElement('div');
		div.id = 'e2e-tall-content';
		div.style.height = `${h}px`;
		section.appendChild(div);
		return true;
	}, height);
}

/** 读取容器/文档滚动几何 */
function getScrollMetrics(page) {
	return page.evaluate(() => {
		const el = document.querySelector('.cc-app-content');
		const se = document.scrollingElement;
		return {
			containerTop: el.getBoundingClientRect().top,
			containerScrollH: el.scrollHeight,
			containerClientH: el.clientHeight,
			containerScrollTop: el.scrollTop,
			docScrollTop: se.scrollTop,
			bodyOverflowY: getComputedStyle(document.body).overflowY,
		};
	});
}

test('Electron 形态：document 不滚、.cc-app-content 是滚动容器且顶缘让位标题栏 @ui', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);
	await page.goto('/user');
	await expect(page.getByTestId('menu-settings')).toBeVisible({ timeout: 10_000 });

	await applyElectronScope(page);
	expect(await injectTallContent(page)).toBe(true);

	const m = await getScrollMetrics(page);
	// 容器顶缘 = 标题栏下缘
	expect(m.containerTop).toBeCloseTo(TITLEBAR_H, 0);
	// 容器有纵向溢出（是滚动容器）
	expect(m.containerScrollH).toBeGreaterThan(m.containerClientH);
	// body 兜底不可滚
	expect(m.bodyOverflowY).toBe('hidden');

	// 容器 scrollTop 可写入生效
	const written = await page.evaluate(() => {
		const el = document.querySelector('.cc-app-content');
		el.scrollTop = 200;
		return el.scrollTop;
	});
	expect(written).toBeCloseTo(200, 0);

	// document 即使程序式滚动也纹丝不动（文档零溢出）
	const docScrollTop = await page.evaluate(() => {
		window.scrollTo(0, 300);
		return document.scrollingElement.scrollTop;
	});
	expect(docScrollTop).toBe(0);
});

test('Electron 形态：桌面侧栏 sticky 贴标题栏下缘，容器滚动后不位移 @ui', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);
	await page.goto('/user');
	await expect(page.getByTestId('menu-settings')).toBeVisible({ timeout: 10_000 });

	await applyElectronScope(page);
	expect(await injectTallContent(page)).toBe(true);

	const readSidebar = () => page.evaluate(() => {
		const aside = document.querySelector('.cc-desktop-sidebar');
		const r = aside.getBoundingClientRect();
		return { top: r.top, height: r.height, vpH: window.innerHeight };
	});

	const before = await readSidebar();
	expect(before.top).toBeCloseTo(TITLEBAR_H, 0);
	expect(before.height).toBeCloseTo(before.vpH - TITLEBAR_H, 0);

	// 写入并确认滚动生效（写不进去则后续 sticky 断言空转假绿）
	const written = await page.evaluate(() => {
		const el = document.querySelector('.cc-app-content');
		el.scrollTop = 400;
		return el.scrollTop;
	});
	expect(written).toBeCloseTo(400, 0);
	const after = await readSidebar();
	// sticky 锚容器顶：滚动后仍贴标题栏下缘
	expect(after.top).toBeCloseTo(TITLEBAR_H, 0);
});

test('Electron 形态：ChatPage 容器无溢出（无双滚动条）、消息区 main 内滚 @ui', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);
	const claw = await navigateToChat(page);
	test.skip(!claw, 'No chat session available (no claw connected)');

	await applyElectronScope(page);
	// 与 chat-layout-debug 同手法：向消息区注入大量内容
	await page.evaluate(() => {
		const main = document.querySelector('[data-testid="chat-root"] main');
		const container = main.querySelector('.mx-auto') || main;
		container.innerHTML = '';
		for (let i = 0; i < 50; i++) {
			const div = document.createElement('div');
			div.className = 'px-4 py-3';
			div.textContent = `Message ${i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt.`;
			container.appendChild(div);
		}
	});
	await expect(page.getByTestId('chat-root')).toBeVisible();

	const m = await page.evaluate(() => {
		const el = document.querySelector('.cc-app-content');
		const chatRoot = document.querySelector('[data-testid="chat-root"]');
		const main = chatRoot.querySelector('main');
		return {
			containerScrollH: el.scrollHeight,
			containerClientH: el.clientHeight,
			chatRootTop: chatRoot.getBoundingClientRect().top,
			mainScrollH: main.scrollHeight,
			mainClientH: main.clientHeight,
		};
	});
	// ChatPage 定高（h-dvh-safe electron 覆盖 = 容器高）恰好填满容器，无第二根滚动条
	expect(m.containerScrollH).toBeLessThanOrEqual(m.containerClientH + 1);
	// 消息区维持内滚现状
	expect(m.mainScrollH).toBeGreaterThan(m.mainClientH);
	// chat 根顶缘 = 标题栏下缘
	expect(m.chatRootTop).toBeCloseTo(TITLEBAR_H, 0);
});

test('color-scheme 跟随明暗主题 @ui', async ({ page }) => {
	await page.goto('/login');
	const schemes = await page.evaluate(() => {
		const html = document.documentElement;
		html.classList.add('dark');
		const dark = getComputedStyle(html).colorScheme;
		html.classList.remove('dark');
		const light = getComputedStyle(html).colorScheme;
		return { dark, light };
	});
	expect(schemes.dark).toBe('dark');
	expect(schemes.light).toBe('light');
});

test('Electron 形态：modal 打开后 wheel 遮罩不滚动 .cc-app-content @ui', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);
	await page.goto('/user');
	await expect(page.getByTestId('menu-settings')).toBeVisible({ timeout: 10_000 });

	await applyElectronScope(page);
	expect(await injectTallContent(page)).toBe(true);

	// 对照：modal 未开时同位置 wheel 必须能滚动容器（防本测试空转假绿）。
	// 位置取内容区右侧（x=1100）：避开左侧侧栏（其内部滚动器会吞 wheel）与居中的 modal 面板
	await page.mouse.move(1100, 400);
	await page.mouse.wheel(0, 500);
	await expect.poll(
		() => page.evaluate(() => document.querySelector('.cc-app-content').scrollTop),
	).toBeGreaterThan(0);
	await page.evaluate(() => {
		document.querySelector('.cc-app-content').scrollTop = 0;
	});

	// 打开设置 modal
	await page.getByTestId('menu-settings').click();
	await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });

	// 把容器滚到中部（模拟「滚到一半开 modal」），并确认写入生效
	const before = await page.evaluate(() => {
		const el = document.querySelector('.cc-app-content');
		el.scrollTop = 300;
		return el.scrollTop;
	});
	expect(before).toBeCloseTo(300, 0);

	// 坐标防护：wheel 点必须落在 modal 面板之外——落进面板则 wheel 被面板吃掉，
	// 用例失去「遮罩上滚轮」语义、静默假绿；面板变大盖到此点时应显式 fail 提示调整坐标
	const dialogBox = await page.locator('[role="dialog"]').boundingBox();
	expect(dialogBox).not.toBeNull();
	const inDialog = 1100 >= dialogBox.x && 1100 <= dialogBox.x + dialogBox.width
		&& 400 >= dialogBox.y && 400 <= dialogBox.y + dialogBox.height;
	expect(inDialog, 'wheel point (1100, 400) falls inside the dialog, adjust coordinates').toBe(false);

	// 在遮罩区域（与对照同一位置，避开居中的 modal 面板）滚轮
	await page.mouse.move(1100, 400);
	await page.mouse.wheel(0, 500);
	await page.waitForTimeout(400);

	const after = await page.evaluate(() => document.querySelector('.cc-app-content').scrollTop);
	// 容器滚动位置不被 modal 下的 wheel 带动
	expect(after).toBe(before);
});

test('浏览器形态（不挂作用域类）：document 照常滚、容器规则不泄漏 @ui', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);
	await page.goto('/user');
	await expect(page.getByTestId('menu-settings')).toBeVisible({ timeout: 10_000 });

	// 反向对照：不 applyElectronScope——锁住「Electron 作用域规则不泄漏到浏览器形态」
	expect(await injectTallContent(page)).toBe(true);

	const m = await page.evaluate(() => {
		const el = document.querySelector('.cc-app-content');
		const se = document.scrollingElement;
		se.scrollTop = 300;
		return {
			docScrollTop: se.scrollTop,
			contentOverflowY: getComputedStyle(el).overflowY,
		};
	});
	// document 是滚动者（写入生效）
	expect(m.docScrollTop).toBeGreaterThan(0);
	// .cc-app-content 仍是惰性 marker，未变成滚动容器
	expect(m.contentOverflowY).toBe('visible');
});

test('Electron 形态：全屏往返（变量 0px ↔ 移除）布局退化且容器 scrollTop 保留 @ui', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);
	await page.goto('/user');
	await expect(page.getByTestId('menu-settings')).toBeVisible({ timeout: 10_000 });

	await applyElectronScope(page);
	expect(await injectTallContent(page)).toBe(true);

	// 滚到 300 并确认写入生效（写不进去则后续「保留」断言空转假绿）
	const written = await page.evaluate(() => {
		const el = document.querySelector('.cc-app-content');
		el.scrollTop = 300;
		return el.scrollTop;
	});
	expect(written).toBeCloseTo(300, 0);

	// 进全屏：以与 App.vue 同样的 inline 写法置 --cc-titlebar-h:0px。
	// App.vue 侧机制（类常驻、watcher 只动变量）已有单测；本用例锁的是
	// 「全屏往返布局退化 + 滚动位保留」这条 CSS 链路本身。
	const inFs = await page.evaluate(() => {
		document.documentElement.style.setProperty('--cc-titlebar-h', '0px');
		const el = document.querySelector('.cc-app-content');
		return { top: el.getBoundingClientRect().top, scrollTop: el.scrollTop };
	});
	// 变量置 0 → calc 规则整体退化为基线布局：容器顶缘贴视口顶
	expect(inFs.top).toBeCloseTo(0, 0);
	// 滚动容器身份不变 → scrollTop 原地保留
	expect(inFs.scrollTop).toBeCloseTo(300, 0);

	// 退全屏：移除 inline 变量，回落作用域常量 38px
	const outFs = await page.evaluate(() => {
		document.documentElement.style.removeProperty('--cc-titlebar-h');
		const el = document.querySelector('.cc-app-content');
		return { top: el.getBoundingClientRect().top, scrollTop: el.scrollTop };
	});
	expect(outFs.top).toBeCloseTo(TITLEBAR_H, 0);
	expect(outFs.scrollTop).toBeCloseTo(300, 0);
});

test('Electron 形态（窄视口）：MobilePageHeader sticky 贴标题栏下缘、不钻条 @ui', async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await login(page);
	await page.goto('/about');
	await expect(page.getByTestId('mobile-page-header')).toBeVisible({ timeout: 10_000 });

	await applyElectronScope(page);
	expect(await injectTallContent(page)).toBe(true);

	// 滚动幅度须小于页面自身内容高：sticky 受父级（页面根）盒约束，滚过头会随父级滚走
	const written = await page.evaluate(() => {
		const el = document.querySelector('.cc-app-content');
		el.scrollTop = 200;
		return el.scrollTop;
	});
	expect(written).toBeCloseTo(200, 0);

	const headerTop = await page.evaluate(
		() => document.querySelector('[data-testid="mobile-page-header"]').getBoundingClientRect().top,
	);
	// sticky 锚到容器顶 = 标题栏下缘（38px），不钻进标题栏
	expect(headerTop).toBeCloseTo(TITLEBAR_H, 0);
});
