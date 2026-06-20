import { expect, test } from '@playwright/test';

test('local account auth flow should work with new layout @auth', async ({ page }) => {
	test.setTimeout(45_000); // 登录→重定向链在高负载下可超 30s 默认上限
	await page.goto('/login');

	await expect(page.getByTestId('login-page')).toBeVisible();

	await page.getByTestId('login-name').fill('test');
	await page.getByTestId('login-password').fill('12345678');
	await page.getByTestId('btn-login').click();

	// 登录后根据 claw 状态重定向到不同页面；只需验证已离开登录页且进入认证区域
	// 重定向依赖 claws-snapshot 解析，给足超时避免默认 5s 下偶发脆断
	await expect(page).not.toHaveURL(/\/login(\?|$)/, { timeout: 10_000 });
	await expect(page.getByTestId('session-user')).toBeVisible({ timeout: 10_000 });

	await expect(page.getByTestId('user-menu-trigger')).toBeVisible({ timeout: 5000 });
	await page.getByTestId('user-menu-trigger').click();
	await page.getByTestId('btn-logout').click();

	// 登出后跳转到 /about
	await expect(page).toHaveURL(/\/about$/, { timeout: 10_000 });

	// 验证已登出：访问认证页面应被拦截到 /login
	await page.goto('/home');
	await expect(page).toHaveURL(/\/login(\?|$)/, { timeout: 10_000 });
	await expect(page.getByTestId('login-page')).toBeVisible();
});
