import { expect, test } from '@playwright/test';

/**
 * 认证 API 故障 E2E 测试
 *
 * 通过 Playwright route 拦截 login API，模拟各类服务端/网络故障，
 * 验证登录页面的错误反馈是否符合预期。
 *
 * 前置条件：server 运行中（但 login API 被拦截，不会真正到达）
 */

test.describe('认证 API 故障 @auth', () => {
	test.beforeEach(async ({ page }) => {
		test.setTimeout(30_000);
		await page.setViewportSize({ width: 1280, height: 720 });
	});

	// ================================================================
	// Test 1: 401 — 凭据错误
	// ================================================================

	test('Login 返回 401 → 显示服务端错误消息，停留在登录页', async ({ page }) => {
		await page.route('**/api/v1/auth/local/login', (route) => {
			route.fulfill({
				status: 401,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'Invalid credentials' }),
			});
		});

		await page.goto('/login');
		await page.getByTestId('login-name').fill('test');
		await page.getByTestId('login-password').fill('wrongpwd');
		await page.getByTestId('btn-login').click();

		const errorEl = page.getByTestId('error');
		await expect(errorEl).toBeVisible({ timeout: 5000 });
		await expect(errorEl).toContainText('Invalid credentials');

		// 不应离开登录页
		await expect(page).toHaveURL(/\/login/);
	});

	// ================================================================
	// Test 2: 500 — 服务端内部错误
	// ================================================================

	test('Login 返回 500 → 显示错误提示，停留在登录页', async ({ page }) => {
		await page.route('**/api/v1/auth/local/login', (route) => {
			route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'Internal Server Error' }),
			});
		});

		await page.goto('/login');
		await page.getByTestId('login-name').fill('test');
		await page.getByTestId('login-password').fill('123456');
		await page.getByTestId('btn-login').click();

		const errorEl = page.getByTestId('error');
		await expect(errorEl).toBeVisible({ timeout: 5000 });
		await expect(errorEl).toContainText(/error/i);
		await expect(page).toHaveURL(/\/login/);
	});

	// ================================================================
	// Test 3: 网络中断 — 请求无法到达
	// ================================================================

	test('Login 网络中断 → 显示网络错误，停留在登录页', async ({ page }) => {
		await page.route('**/api/v1/auth/local/login', (route) => route.abort());

		await page.goto('/login');
		await page.getByTestId('login-name').fill('test');
		await page.getByTestId('login-password').fill('123456');
		await page.getByTestId('btn-login').click();

		// 错误文本应出现（axios network error）
		const errorEl = page.getByTestId('error');
		await expect(errorEl).toBeVisible({ timeout: 5000 });

		await expect(page).toHaveURL(/\/login/);
	});
});
