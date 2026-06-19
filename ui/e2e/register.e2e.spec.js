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

test('注册：密码不匹配显示客户端错误 @auth', async ({ page }) => {
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
// Test 2: loginName 太短 → 客户端校验错误
// ================================================================

test('注册：loginName 太短显示长度错误 @auth', async ({ page }) => {
	test.setTimeout(30_000);
	await page.goto('/register');
	await expect(page.getByTestId('register-page')).toBeVisible({ timeout: 10_000 });

	await page.getByTestId('register-name').fill('ab');
	await page.getByTestId('register-password').fill('password123');
	await page.getByTestId('register-confirm-password').fill('password123');
	await page.getByTestId('btn-register').click();

	const errEl = page.getByTestId('client-error');
	await expect(errEl).toBeVisible({ timeout: 3000 });
	await expect(errEl).toContainText('3');
	expect(page.url()).toMatch(/\/register/);
});

// ================================================================
// Test 3: loginName 格式不合法 → 客户端校验错误
// ================================================================

test('注册：loginName 格式不合法显示格式错误 @auth', async ({ page }) => {
	test.setTimeout(30_000);
	await page.goto('/register');
	await expect(page.getByTestId('register-page')).toBeVisible({ timeout: 10_000 });

	await page.getByTestId('register-name').fill('_badname');
	await page.getByTestId('register-password').fill('password123');
	await page.getByTestId('register-confirm-password').fill('password123');
	await page.getByTestId('btn-register').click();

	await expect(page.getByTestId('client-error')).toBeVisible({ timeout: 3000 });
	expect(page.url()).toMatch(/\/register/);
});

// ================================================================
// Test 4: loginName 为保留名 → 客户端校验错误
// ================================================================

test('注册：loginName 为保留名显示保留错误 @auth', async ({ page }) => {
	test.setTimeout(30_000);
	await page.goto('/register');
	await expect(page.getByTestId('register-page')).toBeVisible({ timeout: 10_000 });

	await page.getByTestId('register-name').fill('admin');
	await page.getByTestId('register-password').fill('password123');
	await page.getByTestId('register-confirm-password').fill('password123');
	await page.getByTestId('btn-register').click();

	const errEl = page.getByTestId('client-error');
	await expect(errEl).toBeVisible({ timeout: 3000 });
	expect(page.url()).toMatch(/\/register/);
});

// ================================================================
// Test 5: 空字段提交不触发请求
// ================================================================

test('注册：空字段提交不触发请求 @auth', async ({ page }) => {
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
// Test 6: 成功注册 → 跳转到认证区域
//
// 注：本用例会在共享 server 上真实创建一个本地账号，且 server 未提供账号删除 API
// （auth/user/admin 路由均无 delete），无从清理。用 Date.now() 保证账号名唯一、永不碰撞，
// 接受「每次运行泄漏一个孤儿账号」这一既知小瑕疵——详见 ui/TODO.md（账号表增长再回头处理）。
// ================================================================

test('注册：成功注册后跳转 @auth', async ({ page }) => {
	test.setTimeout(30_000);
	// Date.now() 保证唯一，避免与历史 run / 其他用例碰撞（无法删除，只能不碰撞）
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
// Test 7: 已登录用户访问注册页 → 自动跳转
// ================================================================

test('注册：已登录用户自动跳转 @auth', async ({ page }) => {
	test.setTimeout(30_000);
	await login(page);

	await page.goto('/register');

	// 应被重定向离开注册页
	await expect(page).not.toHaveURL(/\/register/, { timeout: 10_000 });
});

// ================================================================
// Test 8: 注册页跳转到登录页
// ================================================================

test('注册：点击"已有账号"跳转到登录页 @auth', async ({ page }) => {
	test.setTimeout(30_000);
	await page.goto('/register');
	await expect(page.getByTestId('register-page')).toBeVisible({ timeout: 10_000 });

	// 点击登录链接
	await page.locator('a[href="/login"]').click();

	await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
});
