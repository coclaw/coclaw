import { expect, test } from '@playwright/test';
import {
	login, navigateToChat, waitChatReady,
	typeText, evalStore, waitForWsState, forceCloseWs,
} from './helpers.js';

/**
 * 网络断开/恢复 E2E 测试
 *
 * 前置条件：
 * - server 运行中
 * - test 用户已有至少一个 online bot（已绑定且 OpenClaw gateway 运行中）
 * - 存在 agent:main:main session
 *
 * 技术手段：context.setOffline(true/false) 模拟浏览器断网/恢复
 */

test.describe('网络断开与恢复', () => {
	test.beforeEach(async ({ page }) => {
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1280, height: 720 });
		await login(page);
		const sessionId = await navigateToChat(page);
		test.skip(!sessionId, 'No chat session available');
		await waitChatReady(page);
	});

	test.afterEach(async ({ context }) => {
		await context.setOffline(false);
	});

	// ================================================================
	// Test 1: 断网 → 发消息 → 错误反馈 + 输入恢复
	// ================================================================

	test('断网后发消息：显示错误 toast，输入文本恢复', async ({ page, context }) => {
		const textarea = page.getByTestId('chat-textarea');
		const testMsg = 'offline-test-' + Date.now();

		// 先输入文本
		await typeText(textarea, testMsg);

		// 强制关闭 WS + 断网阻止重连（setOffline 不会立即关闭 WS）
		await forceCloseWs(page);
		await context.setOffline(true);

		// 等待 WS 连接断开
		await waitForWsState(page, 'disconnected');

		// 点击发送
		await page.getByTestId('btn-send').click();

		// 应出现 "Bot not connected" 错误 toast
		await expect(
			page.locator('[data-slot="title"]').filter({ hasText: /not connected/i }),
		).toBeVisible({ timeout: 5000 });

		// 输入框文本应被恢复（sendMessage 失败回滚）
		await expect(textarea).toHaveValue(testMsg, { timeout: 3000 });
	});

	// ================================================================
	// Test 2: 断网 → 恢复 → WS 自动重连
	// ================================================================

	test('断网恢复后 WS 自动重连，textarea 恢复可用', async ({ page, context }) => {
		// 强制关闭 WS + 断网阻止重连
		await forceCloseWs(page);
		await context.setOffline(true);
		await waitForWsState(page, 'disconnected');

		// 恢复网络
		await context.setOffline(false);

		// WS 应自动重连（指数退避，初始 1s）
		await waitForWsState(page, 'connected', 30_000);

		// textarea 应可用
		await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 3000 });
	});

	// ================================================================
	// Test 3: 断网期间 bot 不误报 offline
	// ================================================================

	test('断网期间：bot.online 保持 true，无 offline banner', async ({ page, context }) => {
		// 确认 bot 当前在线
		const botId = await evalStore(page, 'chat', 'return store.botId');
		const botOnlineBefore = await evalStore(page, 'bots', `
			const bot = store.items?.find(b => String(b.id) === String('${botId}'));
			return bot?.online ?? false;
		`);
		expect(botOnlineBefore).toBe(true);

		// 强制关闭 WS + 断网阻止重连
		await forceCloseWs(page);
		await context.setOffline(true);
		await waitForWsState(page, 'disconnected');

		// 等待一段时间，确保 SSE 错误已触发
		await page.waitForTimeout(3000);

		// bot.online 应仍为 true（SSE 断开不改变 bot.online，只有 SSE 消息才改变）
		const botOnlineAfter = await evalStore(page, 'bots', `
			const bot = store.items?.find(b => String(b.id) === String('${botId}'));
			return bot?.online ?? false;
		`);
		expect(botOnlineAfter).toBe(true);

		// offline banner 不应出现
		const offlineBanner = page.locator('[data-testid="chat-root"] .bg-warning\\/10');
		await expect(offlineBanner).not.toBeVisible({ timeout: 2000 });

		// textarea 不应被禁用（isBotOffline 未变化）
		await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 2000 });
	});

	// ================================================================
	// Test 4: 发送中 WS 断连 → 自动重连 → 重试成功
	// ================================================================

	test('发送中 WS 断连：自动重连后重试，消息最终发出', async ({ page }) => {
		const textarea = page.getByTestId('chat-textarea');
		const testMsg = 'retry-test-' + Date.now();

		await typeText(textarea, testMsg);

		// 点击发送后立即强制关闭 WS（模拟 RPC 进行中连接中断）
		await page.getByTestId('btn-send').click();
		await forceCloseWs(page);

		// BotConnection 会自动重连（指数退避，初始 1s）
		await waitForWsState(page, 'connected', 30_000);

		// 等待发送完成（重试逻辑生效，sending 最终变为 false）
		await expect(async () => {
			const sending = await evalStore(page, 'chat', 'return store.sending');
			expect(sending).toBe(false);
		}).toPass({ timeout: 60_000 });

		// 发送成功后输入框应为空（文本未回滚）
		await expect(textarea).toHaveValue('', { timeout: 3000 });
	});
});
