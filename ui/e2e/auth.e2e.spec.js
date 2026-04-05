import { expect, test } from '@playwright/test';

test('local account auth flow should work with new layout @auth', async ({ page }) => {
	await page.goto('/login');

	await expect(page.getByTestId('login-page')).toBeVisible();

	await page.getByTestId('login-name').fill('test');
	await page.getByTestId('login-password').fill('123456');
	await page.getByTestId('btn-login').click();

	// 登录后根据 claw 状态重定向到不同页面；只需验证已离开登录页且进入认证区域
	await expect(page).not.toHaveURL(/\/login$/);
	await expect(page.getByTestId('session-user')).toBeVisible();

	await page.getByTestId('user-menu-trigger').click();
	await page.getByTestId('btn-logout').click();

	// 登出后跳转到 /about
	await expect(page).toHaveURL(/\/about$/);

	// 验证已登出：访问认证页面应被拦截到 /login
	await page.goto('/home');
	await expect(page).toHaveURL(/\/login(\?|$)/);
	await expect(page.getByTestId('login-page')).toBeVisible();
});
