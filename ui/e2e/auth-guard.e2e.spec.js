import { expect, test } from '@playwright/test';
import { login, TEST_LOGIN_NAME, TEST_PASSWORD } from './helpers.js';

/**
 * 路由守卫 / 重定向 E2E 测试（@auth）
 *
 * 覆盖 navigation/claim/register 之外的增量：
 * - 未登录访问受保护页携带回跳参数, 登录后回跳原页
 * - open-redirect 防护（站外 / 协议相对 redirect 被拒, 回落默认页）
 * - 非 admin 用户访问 /admin/* 被守卫弹回
 * - 已登录用户访问 /login 自动离开（register 已有同类覆盖, login 缺）
 *
 * 前置：server 运行中、test 用户存在且为非 admin。均不依赖在线 claw。
 */

const BASE_ORIGIN = 'http://127.0.0.1:4173';

// ================================================================
// 未登录访问受保护页 → /login 带 redirect 参数 → 登录后回跳
// ================================================================

test('路由守卫：未登录访问受保护页带回跳参数, 登录后回到原页 @auth', async ({ page }) => {
	test.setTimeout(45_000);

	await page.goto('/claws');

	// 守卫重定向到 /login, 且 redirect 参数精确等于原目标
	await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
	const redirect = new URL(page.url()).searchParams.get('redirect');
	expect(redirect).toBe('/claws');

	// 登录
	await page.getByTestId('login-name').fill(TEST_LOGIN_NAME);
	await page.getByTestId('login-password').fill(TEST_PASSWORD);
	await page.getByTestId('btn-login').click();

	// 回跳到原目标页（而非默认页）
	await expect(page).toHaveURL(/\/claws(\?|$)/, { timeout: 10_000 });
	await expect(page.getByTestId('btn-refresh-claws')).toBeVisible({ timeout: 10_000 });
});

// ================================================================
// open-redirect 防护：危险 redirect 被拒, 回落站内默认页
// ================================================================

test('路由守卫：危险 redirect 被拒不跳站外, 回落默认页 @auth', async ({ page }) => {
	test.setTimeout(45_000);

	// 1) 协议相对 //evil.com 经登录流程：safeRedirect 判定无效 → 回落默认页
	await page.goto('/login?redirect=' + encodeURIComponent('//evil.com'));
	await expect(page.getByTestId('login-page')).toBeVisible({ timeout: 10_000 });
	await page.getByTestId('login-name').fill(TEST_LOGIN_NAME);
	await page.getByTestId('login-password').fill(TEST_PASSWORD);
	await page.getByTestId('btn-login').click();

	await expect(page).not.toHaveURL(/\/login(\?|$)/, { timeout: 10_000 });
	// 必须仍在本站源, 未被带去 evil.com
	expect(new URL(page.url()).origin).toBe(BASE_ORIGIN);
	await expect(page.getByTestId('session-user')).toBeVisible({ timeout: 10_000 });

	// 2) 绝对外站 https://evil.com 经已登录 mounted 路径：同样被拒
	await page.goto('/login?redirect=' + encodeURIComponent('https://evil.com'));
	await expect(page).not.toHaveURL(/\/login(\?|$)/, { timeout: 10_000 });
	expect(new URL(page.url()).origin).toBe(BASE_ORIGIN);
});

// ================================================================
// 非 admin 用户访问 /admin/* → 被守卫弹回（防无授权 EventSource 死循环）
// ================================================================

test('路由守卫：非 admin 访问 /admin/* 被弹回 @auth', async ({ page }) => {
	test.setTimeout(45_000);
	await login(page);

	// 先确认测试账号确实非 admin（admin 的 level 为 -100）
	const level = await page.evaluate(() => {
		const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
		return pinia?._s?.get('auth')?.user?.level ?? null;
	});
	expect(level).not.toBeNull();
	expect(level).not.toBe(-100);

	await page.goto('/admin/dashboard');

	// 守卫把非 admin 弹回 /home（再由 HomePage 转走）, 关键是绝不停留在 /admin
	await expect(page).not.toHaveURL(/\/admin/, { timeout: 10_000 });
	await expect(page.locator('main')).toBeVisible({ timeout: 5000 });
});

// ================================================================
// 已登录用户访问 /login → 自动离开（register 已有同类覆盖, login 此前缺）
// ================================================================

test('路由守卫：已登录访问登录页自动跳转离开 @auth', async ({ page }) => {
	test.setTimeout(30_000);
	await login(page);

	await page.goto('/login');

	await expect(page).not.toHaveURL(/\/login(\?|$)/, { timeout: 10_000 });
	await expect(page.getByTestId('session-user')).toBeVisible({ timeout: 10_000 });
});
