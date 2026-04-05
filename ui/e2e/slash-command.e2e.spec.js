import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady } from './helpers.js';

/**
 * 斜杠命令 E2E 测试
 *
 * 前置条件：
 * - server 运行中
 * - test 用户已有至少一个 online claw（已绑定且 OpenClaw gateway 运行中）
 * - 存在 agent:main:main session
 */

test.describe('斜杠命令 @chat', () => {
	let sessionId;

	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 720 });
		await login(page);
		sessionId = await navigateToChat(page);
	});

	test('斜杠命令菜单可见且可交互', async ({ page }) => {
		test.skip(!sessionId, 'No chat session available');
		await waitChatReady(page);

		// 菜单触发按钮可见
		const btn = page.getByTestId('btn-slash-menu');
		await expect(btn).toBeVisible({ timeout: 5000 });

		// 点击打开菜单
		await btn.click();

		// 菜单弹出层可见，应有两个菜单项
		const popover = page.locator('[data-testid="btn-slash-menu"] + div, [role="dialog"]').or(page.locator('.max-w-60'));
		const items = popover.locator('button');
		await expect(items.first()).toBeVisible({ timeout: 3000 });
		await expect(items).toHaveCount(2);
	});

	test('/compact 命令执行成功', async ({ page }) => {
		test.setTimeout(60_000);
		test.skip(!sessionId, 'No chat session available');
		await waitChatReady(page);

		// 打开菜单并点击压缩上下文
		await page.getByTestId('btn-slash-menu').click();
		const compactItem = page.locator('.max-w-60 button').filter({ hasText: /compact|压缩/i });
		await expect(compactItem).toBeVisible({ timeout: 3000 });
		await compactItem.click();

		// 等待命令完成
		await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 30_000 });

		// 页面应仍然正常
		await expect(page.getByTestId('chat-root')).toBeVisible();
	});

	test('/new 重置会话后消息刷新', async ({ page }) => {
		test.setTimeout(120_000);
		test.skip(!sessionId, 'No chat session available');
		await waitChatReady(page);

		// 打开菜单并点击重置会话
		await page.getByTestId('btn-slash-menu').click();
		const resetItem = page.locator('.max-w-60 button').filter({ hasText: /reset|重置/i });
		await expect(resetItem).toBeVisible({ timeout: 3000 });
		await resetItem.click();

		// 等待命令完成
		await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 60_000 });

		// 页面应仍然正常
		await expect(page.getByTestId('chat-root')).toBeVisible();
	});

	test('topic 模式下不显示斜杠命令菜单', async ({ page }) => {
		// 导航到新建 topic 路由
		await page.goto('/topics/new?agent=main&claw=1');
		// 等待页面加载
		await expect(page.getByTestId('chat-root')).toBeVisible({ timeout: 10_000 });

		// 斜杠命令按钮不应出现
		await expect(page.getByTestId('btn-slash-menu')).not.toBeVisible({ timeout: 3000 });
	});
});
