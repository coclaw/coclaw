import { expect, test } from '@playwright/test';
import { login } from './helpers.js';

/**
 * 关于页 E2E 测试
 *
 * 前置条件：server 运行中
 */

// ================================================================
// Test 1: 未登录 → 显示登录按钮
// ================================================================

test('关于页：未登录显示登录按钮', async ({ page }) => {
	test.setTimeout(30_000);
	await page.goto('/about');

	// logo 可见
	await expect(page.locator('main img[alt="CoClaw"]')).toBeVisible({ timeout: 10_000 });

	// 应显示登录按钮
	await expect(page.getByTestId('btn-about-login')).toBeVisible({ timeout: 5000 });

	// 不应显示退出按钮
	await expect(page.getByTestId('btn-about-logout')).not.toBeVisible({ timeout: 2000 });
});

// ================================================================
// Test 2: 未登录 → 点击登录按钮跳转
// ================================================================

test('关于页：点击登录按钮跳转到登录页', async ({ page }) => {
	test.setTimeout(30_000);
	await page.goto('/about');
	await expect(page.getByTestId('btn-about-login')).toBeVisible({ timeout: 10_000 });

	await page.getByTestId('btn-about-login').click();

	await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
});

// ================================================================
// Test 3: 已登录 → 显示退出按钮 + 用户信息折叠面板
// ================================================================

test('关于页：已登录显示退出按钮和用户信息', async ({ page }) => {
	test.setTimeout(30_000);
	await login(page);

	await page.goto('/about');

	// logo 可见
	await expect(page.locator('main img[alt="CoClaw"]')).toBeVisible({ timeout: 10_000 });

	// 应显示退出按钮
	await expect(page.getByTestId('btn-about-logout')).toBeVisible({ timeout: 5000 });

	// 不应显示登录按钮
	await expect(page.getByTestId('btn-about-login')).not.toBeVisible({ timeout: 2000 });
});

// ================================================================
// Test 4: 已登录 → 点击退出按钮 → 跳转到登录页
// ================================================================

test('关于页：点击退出按钮跳转到登录页', async ({ page }) => {
	test.setTimeout(30_000);
	await login(page);

	await page.goto('/about');
	await expect(page.getByTestId('btn-about-logout')).toBeVisible({ timeout: 10_000 });

	await page.getByTestId('btn-about-logout').click();

	await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
});

// ================================================================
// Test 5: 折叠面板展开/折叠
// ================================================================

test('关于页：折叠面板可展开收起', async ({ page }) => {
	test.setTimeout(30_000);
	await page.goto('/about');
	await expect(page.locator('main img[alt="CoClaw"]')).toBeVisible({ timeout: 10_000 });

	// 找到折叠面板的触发器按钮（有 aria-controls 且 data-state 的按钮）
	const triggers = page.locator('main button[aria-controls][data-state]');
	const triggerCount = await triggers.count();
	expect(triggerCount).toBeGreaterThanOrEqual(2);

	// 第一个触发器初始应为关闭状态
	await expect(triggers.first()).toHaveAttribute('data-state', 'closed');

	// 点击第一个触发器展开
	await triggers.first().click();
	await expect(triggers.first()).toHaveAttribute('data-state', 'open', { timeout: 3000 });

	// 再次点击折叠
	await triggers.first().click();
	await expect(triggers.first()).toHaveAttribute('data-state', 'closed', { timeout: 3000 });
});
