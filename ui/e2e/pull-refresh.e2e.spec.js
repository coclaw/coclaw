import { expect, test } from '@playwright/test';

/**
 * 下拉刷新 E2E 测试
 * 使用 CDP Input.dispatchTouchEvent 模拟真实触屏手势。
 * 验证方式：设置 sessionStorage 标记，下拉后检测页面 reload（标记保留但 window 状态重置）。
 */

const MOBILE_VP = { width: 390, height: 844 };

async function login(page) {
	await page.goto('/login');
	await page.getByTestId('login-name').fill('test');
	await page.getByTestId('login-password').fill('123456');
	await page.getByTestId('btn-login').click();
	await page.waitForTimeout(2000);
}

/**
 * 通过 CDP 模拟触屏下拉手势
 * @param {import('@playwright/test').Page} page
 * @param {number} startX
 * @param {number} startY
 * @param {number} distance - 向下拖拽距离（px）
 */
async function cdpPullDown(page, startX, startY, distance) {
	const client = await page.context().newCDPSession(page);
	await client.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [{ x: startX, y: startY }],
	});
	await page.waitForTimeout(30);

	const steps = 10;
	for (let i = 1; i <= steps; i++) {
		await client.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [{ x: startX, y: startY + distance * i / steps }],
		});
		await page.waitForTimeout(20);
	}

	await client.send('Input.dispatchTouchEvent', {
		type: 'touchEnd',
		touchPoints: [],
	});
	await client.detach();
}

/**
 * 在页面设置标记，下拉后通过检测标记存在 + 新 window 状态来确认 reload
 */
async function setReloadMarker(page) {
	await page.evaluate(() => {
		sessionStorage.setItem('__ptr_marker', Date.now().toString());
		window.__ptr_pre = true;
	});
}

async function verifyReloadHappened(page) {
	return page.evaluate(() => {
		// sessionStorage 跨 reload 保留，但 window 变量不保留
		const markerExists = !!sessionStorage.getItem('__ptr_marker');
		const windowFresh = !window.__ptr_pre;
		sessionStorage.removeItem('__ptr_marker');
		return markerExists && windowFresh;
	});
}

// --- 各页面测试 ---

test.describe('下拉刷新 @ui', () => {
	test.use({ hasTouch: true });

	test.beforeEach(async ({ page }) => {
		await page.setViewportSize(MOBILE_VP);
	});

	test('TopicsPage: 下拉超过阈值触发页面刷新', async ({ page }) => {
		await login(page);
		await page.goto('/topics');
		await page.waitForTimeout(1000);
		await setReloadMarker(page);

		const [, loadEvent] = await Promise.all([
			cdpPullDown(page, 200, 200, 250),
			page.waitForEvent('load', { timeout: 5000 }),
		]);

		expect(loadEvent).toBeTruthy();
		const reloaded = await verifyReloadHappened(page);
		expect(reloaded).toBe(true);
	});

	test('TopicsPage: 短距离下拉不触发刷新', async ({ page }) => {
		await login(page);
		await page.goto('/topics');
		await page.waitForTimeout(1000);
		await setReloadMarker(page);

		await cdpPullDown(page, 200, 200, 20);
		await page.waitForTimeout(500);

		// 页面不应 reload：window 标记仍在
		const stillAlive = await page.evaluate(() => window.__ptr_pre === true);
		expect(stillAlive).toBe(true);
	});

	test('UserPage: 下拉触发刷新', async ({ page }) => {
		await login(page);
		await page.goto('/user');
		await page.waitForTimeout(1000);
		await setReloadMarker(page);

		const [, loadEvent] = await Promise.all([
			cdpPullDown(page, 200, 200, 250),
			page.waitForEvent('load', { timeout: 5000 }),
		]);

		expect(loadEvent).toBeTruthy();
		const reloaded = await verifyReloadHappened(page);
		expect(reloaded).toBe(true);
	});

	test('ManageClawsPage: 下拉触发刷新', async ({ page }) => {
		await login(page);
		await page.goto('/claws');
		await page.waitForTimeout(1000);
		await setReloadMarker(page);

		const [, loadEvent] = await Promise.all([
			cdpPullDown(page, 200, 200, 250),
			page.waitForEvent('load', { timeout: 5000 }),
		]);

		expect(loadEvent).toBeTruthy();
		const reloaded = await verifyReloadHappened(page);
		expect(reloaded).toBe(true);
	});

	test('AboutPage: 下拉触发刷新', async ({ page }) => {
		await login(page);
		await page.goto('/about');
		await page.waitForTimeout(1000);
		await setReloadMarker(page);

		const [, loadEvent] = await Promise.all([
			cdpPullDown(page, 200, 200, 250),
			page.waitForEvent('load', { timeout: 5000 }),
		]);

		expect(loadEvent).toBeTruthy();
		const reloaded = await verifyReloadHappened(page);
		expect(reloaded).toBe(true);
	});

	test('ChatPage: 滚动到顶部后下拉触发刷新', async ({ page }) => {
		await login(page);
		await page.waitForTimeout(1000);
		if (!/\/chat\//.test(page.url())) {
			await page.goto('/topics');
			// v0.2: sessions 通过 WS 异步加载，需等待链接出现
			await page.locator('main a[href*="/chat/"]').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
			const chatLink = page.locator('main a[href*="/chat/"]').first();
			if (!(await chatLink.count())) {
				test.skip(true, 'No chat session available');
				return;
			}
			await chatLink.click();
			await page.waitForTimeout(1000);
		}

		// 确保 main 滚到顶部
		await page.evaluate(() => {
			const main = document.querySelector('[data-testid="chat-root"] main');
			if (main) main.scrollTop = 0;
		});
		await page.waitForTimeout(200);
		await setReloadMarker(page);

		const [, loadEvent] = await Promise.all([
			cdpPullDown(page, 200, 200, 250),
			page.waitForEvent('load', { timeout: 5000 }),
		]);

		expect(loadEvent).toBeTruthy();
		const reloaded = await verifyReloadHappened(page);
		expect(reloaded).toBe(true);
	});
});
