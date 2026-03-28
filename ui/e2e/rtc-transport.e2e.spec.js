import { test, expect } from '@playwright/test';
import { login, navigateToChat, waitChatReady, typeText } from './helpers.js';

test.describe('WebRTC DataChannel 传输选择（Phase 2） @rtc', () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test('WS 连通后自动选择 RTC 或 WS 传输模式', async ({ page }) => {
		await page.goto('/topics');
		await page.waitForTimeout(3000);

		const transportMode = await page.evaluate(async () => {
			const { useBotConnections } = await import('/src/services/bot-connection-manager.js');
			const manager = useBotConnections();
			const modes = {};
			for (const [botId, conn] of manager.__connections) {
				modes[botId] = conn.transportMode;
			}
			return modes;
		});

		console.log('Transport modes:', JSON.stringify(transportMode));
		for (const [botId, mode] of Object.entries(transportMode)) {
			expect(mode, `botId=${botId} transportMode should not be null`).not.toBeNull();
			expect(['rtc', 'ws']).toContain(mode);
		}
	});

	test('RTC 模式下可通过 DataChannel 发送消息并收到回复', async ({ page }) => {
		test.setTimeout(240_000);
		await page.setViewportSize({ width: 1280, height: 720 });

		const chatInfo = await navigateToChat(page);
		if (!chatInfo) {
			test.skip('无可用 chat session');
			return;
		}
		await waitChatReady(page);

		// 检查 transportMode
		const mode = await page.evaluate(async (botId) => {
			const { useBotConnections } = await import('/src/services/bot-connection-manager.js');
			const conn = useBotConnections().get(botId);
			return conn?.transportMode;
		}, chatInfo.botId);
		console.log(`Bot ${chatInfo.botId} transportMode: ${mode}`);

		// 记录消息数
		const msgCountBefore = await page.locator('[data-testid="chat-root"] main .px-3.py-3').count();

		// 发送消息
		const testMsg = `rtc e2e ${Date.now()}`;
		await typeText(page.getByTestId('chat-textarea'), testMsg);
		await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
		await page.getByTestId('btn-send').click();

		// 验证 user 消息出现
		await expect(page.locator(`text=${testMsg}`)).toBeVisible({ timeout: 5000 });

		// 验证 bot 回复完成（btn-send 重新出现）
		await expect(page.getByTestId('btn-send')).toBeVisible({ timeout: 180_000 });

		// 验证消息数增加
		const msgCountAfter = await page.locator('[data-testid="chat-root"] main .px-3.py-3').count();
		expect(msgCountAfter).toBeGreaterThan(msgCountBefore);

		console.log(`消息收发成功 (transport: ${mode}, msgs: ${msgCountBefore}→${msgCountAfter})`);
	});
});
