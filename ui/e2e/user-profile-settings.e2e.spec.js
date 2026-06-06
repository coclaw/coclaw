import { expect, test } from '@playwright/test';
import { login } from './helpers.js';

/**
 * 用户信息与设置 E2E 测试
 *
 * 前置条件：
 * - server 运行中
 * - test 用户已存在（本地认证）
 */

// ================================================================
// Test 1: 用户页面渲染
// ================================================================

test('用户页：显示用户信息和菜单 @ui', async ({ page }) => {
	test.setTimeout(30_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	await page.goto('/user');

	// 菜单按钮应可见
	await expect(page.getByTestId('menu-about')).toBeVisible({ timeout: 10_000 });
	await expect(page.getByTestId('menu-settings')).toBeVisible();
	await expect(page.getByTestId('menu-profile')).toBeVisible();
	await expect(page.getByTestId('menu-logout')).toBeVisible();
});

// ================================================================
// Test 2: 从用户页打开关于页
// ================================================================

test('用户页：点击关于菜单跳转到关于页 @ui', async ({ page }) => {
	test.setTimeout(30_000);
	await login(page);

	await page.goto('/user');
	await expect(page.getByTestId('menu-about')).toBeVisible({ timeout: 10_000 });

	await page.getByTestId('menu-about').click();

	await expect(page).toHaveURL(/\/about/, { timeout: 5000 });
});

// ================================================================
// Test 3: 从用户页退出登录
// ================================================================

test('用户页：点击退出菜单退出登录 @ui', async ({ page }) => {
	test.setTimeout(30_000);
	await login(page);

	await page.goto('/user');
	await expect(page.getByTestId('menu-logout')).toBeVisible({ timeout: 10_000 });

	await page.getByTestId('menu-logout').click();

	await expect(page).toHaveURL(/\/about/, { timeout: 10_000 });
});

// ================================================================
// Test 4: 打开个人信息对话框
// ================================================================

test('用户页：打开个人信息对话框 @ui', async ({ page }) => {
	test.setTimeout(30_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	await page.goto('/user');
	await expect(page.getByTestId('menu-profile')).toBeVisible({ timeout: 10_000 });

	await page.getByTestId('menu-profile').click();

	// 对话框应出现（UModal 渲染 role="dialog"）
	const dialog = page.locator('[role="dialog"]');
	await expect(dialog).toBeVisible({ timeout: 5000 });

	// 对话框内应有用户信息行（昵称、登录方式等）
	await expect(dialog.locator('text=/test/')).toBeVisible({ timeout: 3000 });
});

// ================================================================
// Test 5: 个人信息对话框 → 修改昵称（Modify-Revert）
// ================================================================

test('用户页：修改昵称后恢复 @ui', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	await page.goto('/user');
	await expect(page.getByTestId('menu-profile')).toBeVisible({ timeout: 10_000 });
	await page.getByTestId('menu-profile').click();

	const dialog = page.locator('[role="dialog"]');
	await expect(dialog).toBeVisible({ timeout: 5000 });

	// 记录原始昵称
	const originalName = await page.evaluate(() => {
		const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
		const authStore = pinia?._s.get('auth');
		return authStore?.user?.name || authStore?.user?.loginName || 'test';
	});

	// 点击编辑按钮（铅笔图标）
	const editBtn = dialog.getByTestId('btn-edit-name');
	await editBtn.click();

	// 编辑对话框应出现（嵌套 UModal）
	const editModal = page.locator('[role="dialog"]').last();
	await expect(editModal).toBeVisible({ timeout: 5000 });

	// 清空并输入新昵称
	const nameInput = editModal.locator('input');
	await nameInput.fill('E2E_TEMP_NAME');

	// 点击保存（组件已加 data-testid="btn-save"，避免 .last() 顺序定位歧义）
	const saveBtn = page.getByTestId('btn-save');
	await saveBtn.click();

	// 用 try/finally 保证恢复昵称在任何失败路径下都会执行
	try {
		// 等待编辑 modal 关闭：保存成功后 btn-save 随 modal 卸载而消失。
		// 不用 editModal(=.last()) 判可见——modal 关闭后 .last() 会落到外层 profile dialog 造成误判。
		await expect(page.getByTestId('btn-save')).not.toBeVisible({ timeout: 10_000 });
	} finally {
		// 恢复原始昵称（无论断言成功与否都执行，避免 E2E_TEMP_NAME 永久遗留）
		await page.goto('/user');
		await expect(page.getByTestId('menu-profile')).toBeVisible({ timeout: 10_000 });
		await page.getByTestId('menu-profile').click();

		const dialog2 = page.locator('[role="dialog"]');
		await expect(dialog2).toBeVisible({ timeout: 5000 });

		const editBtn2 = dialog2.getByTestId('btn-edit-name');
		await editBtn2.click();

		const editModal2 = page.locator('[role="dialog"]').last();
		await expect(editModal2).toBeVisible({ timeout: 5000 });

		const nameInput2 = editModal2.locator('input');
		await nameInput2.fill(originalName);

		const saveBtn2 = page.getByTestId('btn-save');
		await saveBtn2.click();
		// 等待恢复保存完成（同上，用 btn-save 消失判定，避免 .last() 误判外层 dialog）
		await expect(page.getByTestId('btn-save')).not.toBeVisible({ timeout: 10_000 });
	}
});

// ================================================================
// Test 6: 打开设置对话框
// ================================================================

test('用户页：打开设置对话框 @ui', async ({ page }) => {
	test.setTimeout(30_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	await page.goto('/user');
	await expect(page.getByTestId('menu-settings')).toBeVisible({ timeout: 10_000 });

	await page.getByTestId('menu-settings').click();

	// 设置对话框应出现
	const dialog = page.locator('[role="dialog"]');
	await expect(dialog).toBeVisible({ timeout: 5000 });

	// 应包含主题和语言设置区域
	await expect(dialog.getByTestId('setting-theme')).toBeVisible({ timeout: 3000 });
	await expect(dialog.getByTestId('setting-lang')).toBeVisible({ timeout: 3000 });
});

// ================================================================
// Test 7: 设置 → 切换主题
// ================================================================

test('用户页：切换主题生效 @ui', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	await page.goto('/user');
	await expect(page.getByTestId('menu-settings')).toBeVisible({ timeout: 10_000 });
	await page.getByTestId('menu-settings').click();

	const dialog = page.locator('[role="dialog"]');
	await expect(dialog).toBeVisible({ timeout: 5000 });

	// 记录当前主题
	const initialTheme = await page.evaluate(() => document.documentElement.classList.contains('dark') ? 'dark' : 'light');

	// 切换到相反主题
	const targetTheme = initialTheme === 'dark' ? 'light' : 'dark';

	// 点击主题选择器触发器
	const themeContainer = dialog.getByTestId('setting-theme');
	const themeButton = themeContainer.locator('button').first();
	await themeButton.click();

	// 选择目标主题选项
	const option = page.locator('[role="option"]').filter({
		has: page.locator(`text=/${targetTheme === 'dark' ? 'Dark|深色' : 'Light|浅色'}/i`),
	});
	await option.click();

	// 验证 HTML 根元素 class 变化
	await expect(async () => {
		const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
		expect(isDark).toBe(targetTheme === 'dark');
	}).toPass({ timeout: 5000 });

	// 恢复原始主题
	await themeButton.click();
	const restoreOption = page.locator('[role="option"]').filter({
		has: page.locator(`text=/${initialTheme === 'dark' ? 'Dark|深色' : 'Light|浅色'}/i`),
	});
	await restoreOption.click();

	await expect(async () => {
		const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
		expect(isDark).toBe(initialTheme === 'dark');
	}).toPass({ timeout: 5000 });
});

// ================================================================
// Test 8: 改密弹窗 → 回车提交（验证隐藏 submit 按钮让原生回车触发提交）
//
// 改密表单有 3 个输入框且提交按钮在 form 外（UModal #footer），按 HTML 规范
// 这种情况下回车默认不提交——靠 form 内一个隐藏 submit 按钮才让回车生效。
// 本用例锁死该行为：故意填两次不一致的新密码，回车后应弹出“不一致”警告 toast，
// 证明回车确实触发了提交校验（走 mismatch 早返回，绝不会真改密码，账号安全）。
// ================================================================

test('设置：改密弹窗回车触发提交（不一致警告，不改密码） @ui', async ({ page }) => {
	test.setTimeout(30_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	await page.goto('/user');
	await expect(page.getByTestId('menu-settings')).toBeVisible({ timeout: 10_000 });
	await page.getByTestId('menu-settings').click();

	const dialog = page.locator('[role="dialog"]');
	await expect(dialog).toBeVisible({ timeout: 5000 });

	// 打开改密弹窗
	await page.getByTestId('btn-change-password').click();
	await expect(page.getByTestId('pwd-current')).toBeVisible({ timeout: 5000 });

	// 故意填不一致的新密码（current 随便填非空，避免落到 needPassword 分支）
	await page.getByTestId('pwd-current').fill('whatever-not-real');
	await page.getByTestId('pwd-new').fill('e2e-new-aaaa');
	await page.getByTestId('pwd-confirm').fill('e2e-new-bbbb');

	// 在输入框内按回车 → 隐藏 submit 让 form 提交 → onSubmitPasswordChange 校验
	await page.getByTestId('pwd-confirm').press('Enter');

	// 回车确实触发了提交：弹出“两次新密码不一致”警告 toast（en / zh 兼容）
	await expect(
		page.locator('[data-slot="title"]').filter({ hasText: /do not match|不一致/i }),
	).toBeVisible({ timeout: 5000 });
});
