import { expect, test } from '@playwright/test';
import { login, TEST_LOGIN_NAME, TEST_PASSWORD } from './helpers.js';

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
		await page.getByTestId('login-password').fill('12345678');
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
		await page.getByTestId('login-password').fill('12345678');
		await page.getByTestId('btn-login').click();

		// 错误文本应出现（axios network error）
		const errorEl = page.getByTestId('error');
		await expect(errorEl).toBeVisible({ timeout: 5000 });

		await expect(page).toHaveURL(/\/login/);
	});
});

// ================================================================
// C9: session 中途过期 → 401 弹回 /login（带回跳）→ 重新登录回到原页
//
// Round-1 已覆盖「一开始就未登录」的守卫回跳；这里覆盖「登录后会话中途失效」：
// 正常登录 → 停在受保护页 → 一次受保护 REST 调用返回 401（模拟会话过期）→
// http.js 拦截器派发 auth:session-expired → AuthedLayout 完整登出 + 跳 /login?redirect=<原页> →
// 重新登录回到原页。全程用 route-mock 的 401（含 logout 端点），绝不在 server 上真登出，
// 不打扰其他用例的共享账号。
// ================================================================

test('会话中途过期：受保护请求 401 → 弹回 /login 带回跳 → 重登回到原页 @auth', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1280, height: 720 });

	// 1) 正常登录（真实），落到受保护页 /user —— 即「用户当前所在页」
	await login(page);
	await page.goto('/user');
	await expect(page).toHaveURL(/\/user(\?|$)/, { timeout: 10_000 });
	await expect(page.getByTestId('session-user')).toBeVisible({ timeout: 10_000 });

	// 2) 装一道受保护 REST 401 闸：expired 期间把所有 /api/v1/*（除登录/注册入口）打成 401。
	//    覆盖三处：触发端点、登出端点（→ 不在 server 真登出）、/api/v1/user（→ /login 不自动回跳、显登录表单）。
	let expired = false;
	await page.route('**/api/v1/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		const isAuthEntry = path === '/api/v1/auth/local/login' || path === '/api/v1/auth/local/register';
		if (expired && !isAuthEntry) {
			await route.fulfill({
				status: 401,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'Session expired (e2e)' }),
			});
			return;
		}
		await route.continue();
	});

	// 3) 触发真实的受保护 REST 调用（app 真在用的 GET /api/v1/web-agents）→ 401 → 走真实 401 处理链
	expired = true;
	await page.evaluate(() =>
		import('/src/services/web-agents.api.js').then((m) => m.listWebAgents().catch(() => {})));

	// 4) 弹回 /login 且 redirect 精确保留原页 /user
	await expect(page).toHaveURL(/\/login\?/, { timeout: 15_000 });
	expect(new URL(page.url()).searchParams.get('redirect')).toBe('/user');
	await expect(page.getByTestId('login-page')).toBeVisible({ timeout: 10_000 });

	// 5) 解除 401 闸，重新登录 → safeRedirect 回到原页 /user
	expired = false;
	await page.getByTestId('login-name').fill(TEST_LOGIN_NAME);
	await page.getByTestId('login-password').fill(TEST_PASSWORD);
	await page.getByTestId('btn-login').click();

	await expect(page).toHaveURL(/\/user(\?|$)/, { timeout: 15_000 });
	await expect(page.getByTestId('session-user')).toBeVisible({ timeout: 10_000 });
});
