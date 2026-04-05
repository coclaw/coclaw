import { expect, test } from '@playwright/test';
import { login } from './helpers.js';

/**
 * 页面导航 E2E 测试
 *
 * 前置条件：
 * - server 运行中
 * - test 用户已存在
 */

// ================================================================
// Test 1: Topics 页面渲染
// ================================================================

test('Topics 页：页面正常渲染 @ui', async ({ page }) => {
	test.setTimeout(30_000);
	await login(page);

	await page.goto('/topics');

	// main 区域可见
	await expect(page.locator('main')).toBeVisible({ timeout: 10_000 });

	// 页面不为空白（有文本内容或列表项）
	const mainText = await page.locator('main').innerText();
	expect(mainText.trim().length).toBeGreaterThan(0);
});

// ================================================================
// Test 2: Topics 页面 → 点击 session 进入 chat
// ================================================================

test('Topics 页：点击 session 进入聊天页 @ui', async ({ page }) => {
	test.setTimeout(30_000);
	await login(page);

	await page.goto('/topics');
	const chatLink = page.locator('main a[href*="/chat/"]').first();

	try {
		await chatLink.waitFor({ state: 'visible', timeout: 10_000 });
	}
	catch {
		test.skip(true, 'No chat sessions available');
	}

	await chatLink.click();
	await expect(page).toHaveURL(/\/chat\//, { timeout: 5000 });
	await expect(page.getByTestId('chat-root')).toBeVisible({ timeout: 10_000 });
});

// ================================================================
// Test 3: ManageClaws 页面渲染
// ================================================================

test('ManageClaws 页：页面正常渲染 @ui', async ({ page }) => {
	test.setTimeout(30_000);
	await login(page);

	await page.goto('/claws');

	// 刷新按钮和添加按钮可见
	await expect(page.getByTestId('btn-refresh-claws')).toBeVisible({ timeout: 10_000 });
	await expect(page.getByTestId('btn-add-claw')).toBeVisible();
});

// ================================================================
// Test 4: ManageClaws → 导航到 AddClaw 页面
// ================================================================

test('ManageClaws 页：点击添加 Claw 跳转 @ui', async ({ page }) => {
	test.setTimeout(30_000);
	await login(page);

	await page.goto('/claws');
	await expect(page.getByTestId('btn-add-claw')).toBeVisible({ timeout: 10_000 });

	await page.getByTestId('btn-add-claw').click();

	await expect(page).toHaveURL(/\/claws\/add/, { timeout: 5000 });
});

// ================================================================
// Test 5: ManageClaws → 刷新按钮可点击
// ================================================================

test('ManageClaws 页：刷新按钮可点击 @ui', async ({ page }) => {
	test.setTimeout(30_000);
	await login(page);

	await page.goto('/claws');
	await expect(page.getByTestId('btn-refresh-claws')).toBeVisible({ timeout: 10_000 });

	// 点击刷新按钮，应无报错
	await page.getByTestId('btn-refresh-claws').click();

	// 按钮应保持可见（loading 后恢复）
	await expect(page.getByTestId('btn-refresh-claws')).toBeVisible({ timeout: 10_000 });
});

// ================================================================
// Test 6: HomePage 智能跳转
// ================================================================

test('HomePage：自动跳转到合适的页面 @ui', async ({ page }) => {
	test.setTimeout(30_000);
	await login(page);

	await page.goto('/home');

	// HomePage 是过渡页，应自动跳转到其它页面
	await expect(async () => {
		const url = page.url();
		// 应不再停留在 /home
		expect(url).not.toMatch(/\/home$/);
	}).toPass({ timeout: 15_000 });

	// 跳转后的页面应正常渲染
	await expect(page.locator('main')).toBeVisible({ timeout: 5000 });
});

// ================================================================
// Test 7: 未登录访问受保护页面 → 跳转到登录
// ================================================================

test('路由守卫：未登录访问受保护页面跳转到登录 @ui', async ({ page }) => {
	test.setTimeout(30_000);

	await page.goto('/topics');

	// 应被重定向到登录页
	await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
});

// ================================================================
// Test 8: 底部导航栏（移动端）
// ================================================================

test('移动端：底部导航栏可切换页面 @ui', async ({ page }) => {
	test.setTimeout(30_000);
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);

	await page.goto('/topics');
	await expect(page.locator('main')).toBeVisible({ timeout: 10_000 });

	// 底部导航栏（fixed bottom-0 区域内的 tab）
	const bottomBar = page.locator('.fixed.bottom-0');
	const tabs = bottomBar.locator('[role="tab"]');
	try {
		await tabs.first().waitFor({ state: 'visible', timeout: 5000 });
	}
	catch {
		test.skip(true, 'Bottom navigation not visible');
	}

	// 应有 3 个 tab
	await expect(tabs).toHaveCount(3);

	// 切换到 claws 页（第 2 个 tab）
	await tabs.nth(1).click();
	await expect(page).toHaveURL(/\/claws/, { timeout: 5000 });

	// 切换到 user 页（第 3 个 tab）
	await tabs.nth(2).click();
	await expect(page).toHaveURL(/\/user/, { timeout: 5000 });

	// 切换回 topics 页（第 1 个 tab）
	await tabs.nth(0).click();
	await expect(page).toHaveURL(/\/topics/, { timeout: 5000 });
});
