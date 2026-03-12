import { expect, test } from '@playwright/test';
import { login } from './helpers.js';

/**
 * 注册流程 E2E 测试
 *
 * 前置条件：server 运行中
 */

// ================================================================
// Test 1: 密码不匹配 → 客户端验证错误
// ================================================================

test('注册：密码不匹配显示客户端错误', async ({ page }) => {
	test.setTimeout(30_000);
	await page.goto('/register');
	await expect(page.getByTestId('register-page')).toBeVisible({ timeout: 10_000 });

	await page.getByTestId('register-name').fill('testuser_mismatch');
	await page.getByTestId('register-password').fill('password123');
	await page.getByTestId('register-confirm-password').fill('different456');
	await page.getByTestId('btn-register').click();

	// 应显示客户端错误提示
	await expect(page.getByTestId('client-error')).toBeVisible({ timeout: 3000 });

	// 应停留在注册页
	expect(page.url()).toMatch(/\/register/);
});

// ================================================================
// Test 2: 空字段提交不触发请求
// ================================================================

test('注册：空字段提交不触发请求', async ({ page }) => {
	test.setTimeout(30_000);
	await page.goto('/register');
	await expect(page.getByTestId('register-page')).toBeVisible({ timeout: 10_000 });

	// 只填用户名，不填密码
	await page.getByTestId('register-name').fill('testuser_empty');
	await page.getByTestId('btn-register').click();

	// 不应出现错误提示（空字段直接 return）
	await expect(page.getByTestId('client-error')).not.toBeVisible({ timeout: 2000 });
	await expect(page.getByTestId('error')).not.toBeVisible({ timeout: 2000 });

	// 应停留在注册页
	expect(page.url()).toMatch(/\/register/);
});

// ================================================================
// Test 3: 成功注册 → 跳转到认证区域
// ================================================================

test('注册：成功注册后跳转', async ({ page }) => {
	test.setTimeout(30_000);
	const uniqueName = 'e2e_reg_' + Date.now();
	await page.goto('/register');
	await expect(page.getByTestId('register-page')).toBeVisible({ timeout: 10_000 });

	await page.getByTestId('register-name').fill(uniqueName);
	await page.getByTestId('register-password').fill('test123456');
	await page.getByTestId('register-confirm-password').fill('test123456');
	await page.getByTestId('btn-register').click();

	// 应跳转离开注册页
	await expect(page).not.toHaveURL(/\/register/, { timeout: 10_000 });
});

// ================================================================
// Test 4: 已登录用户访问注册页 → 自动跳转
// ================================================================

test('注册：已登录用户自动跳转', async ({ page }) => {
	test.setTimeout(30_000);
	await login(page);

	await page.goto('/register');

	// 应被重定向离开注册页
	await expect(page).not.toHaveURL(/\/register/, { timeout: 10_000 });
});

// ================================================================
// Test 5: 注册页跳转到登录页
// ================================================================

test('注册：点击"已有账号"跳转到登录页', async ({ page }) => {
	test.setTimeout(30_000);
	await page.goto('/register');
	await expect(page.getByTestId('register-page')).toBeVisible({ timeout: 10_000 });

	// 点击登录链接
	await page.locator('a[href="/login"]').click();

	await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
});
