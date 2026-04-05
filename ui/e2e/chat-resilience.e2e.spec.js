import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady, evalStore } from './helpers.js';

/**
 * ChatPage 容错与恢复 E2E 测试
 *
 * 前置条件：
 * - server 运行中
 * - test 用户已有至少一个 online claw（已绑定且 OpenClaw gateway 运行中）
 * - 存在 agent:main:main session
 */

// ================================================================
// Test 1: ChatPage 刷新后正常恢复
// ================================================================

test('ChatPage 刷新：页面恢复正常，无错误提示 @resilience', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionId = await navigateToChat(page);
	test.skip(!sessionId, 'No chat session available');

	await waitChatReady(page);

	// 记录当前 URL
	const chatUrl = page.url();

	// 刷新页面
	await page.reload();

	// 应停留在同一 URL
	await expect(page).toHaveURL(chatUrl, { timeout: 15_000 });

	// chat-root 可见
	await expect(page.getByTestId('chat-root')).toBeVisible({ timeout: 10_000 });

	// 不应出现错误文本（'Claw not connected'、'not connected' 等）
	const errorEl = page.locator('[data-testid="chat-root"] .text-error');
	await expect(errorEl).not.toBeVisible({ timeout: 15_000 });

	// textarea 应可用（说明数据加载完成、连接就绪）
	await expect(page.getByTestId('chat-textarea')).toBeVisible({ timeout: 15_000 });
});

// ================================================================
// Test 2: 不存在的 session → 跳转
// ================================================================

test('不存在的 session：重定向到首页 @resilience', async ({ page }) => {
	test.setTimeout(30_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	// 先确保有 claw（否则跳转原因不同）
	await page.goto('/topics');
	const chatLink = page.locator('main a[href*="/chat/"]').first();
	try {
		await chatLink.waitFor({ state: 'visible', timeout: 10_000 });
	}
	catch {
		test.skip(true, 'No chat sessions available');
	}

	// 导航到一个不存在的 session
	await page.goto('/chat/nonexistent-claw-' + Date.now() + '/main');

	// 应被重定向离开 chat 页面（到 /home 或其后续调度目标）
	await expect(async () => {
		const url = page.url();
		expect(url).not.toContain('/chat/nonexistent-claw');
	}).toPass({ timeout: 15_000 });

	// 不应停留在错误状态
	await expect(page.locator('.text-error')).not.toBeVisible({ timeout: 3000 });
});

// ================================================================
// Test 3: Claw 离线 → 显示离线 banner + 输入禁用
// ================================================================

test('Claw 离线：显示离线提示且输入禁用 @resilience', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionId = await navigateToChat(page);
	test.skip(!sessionId, 'No chat session available');

	await waitChatReady(page);

	// 通过 Pinia store 将所有 claw 设为离线（模拟 SSE claw.status 推送）
	await evalStore(page, 'claws', `
		for (const claw of store.items) {
			store.updateClawOnline(claw.id, false);
		}
	`);

	// 离线 banner 应出现
	const offlineBanner = page.locator('[data-testid="chat-root"] .text-warning');
	await expect(offlineBanner).toBeVisible({ timeout: 5000 });

	// textarea 应被禁用
	await expect(page.getByTestId('chat-textarea')).toBeDisabled({ timeout: 3000 });

	// --- 恢复 ---
	// 将 claw 重新设为在线
	await evalStore(page, 'claws', `
		for (const claw of store.items) {
			store.updateClawOnline(claw.id, true);
		}
	`);

	// 离线 banner 应消失
	await expect(offlineBanner).not.toBeVisible({ timeout: 5000 });

	// textarea 应重新可用
	await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 5000 });
});
