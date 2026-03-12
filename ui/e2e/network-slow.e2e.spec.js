import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady, typeText } from './helpers.js';

/**
 * 弱网环境 E2E 测试
 *
 * 通过 CDP Network.emulateNetworkConditions 模拟慢速网络，
 * 验证前端在弱网下的交互状态和容错能力。
 *
 * 前置条件：同 chat-resilience
 *
 * 预设参考（与 Chrome DevTools 一致）：
 * - Slow 3G: latency 2000ms, 400 Kbps 上下行
 * - Slow 4G: latency 170ms, 4 Mbps 下行 / 3 Mbps 上行
 */

// CDP 网络节流预设（throughput 单位：bytes/s）
const SLOW_3G = {
	offline: false,
	latency: 2000,
	downloadThroughput: 51200,   // 400 Kbps
	uploadThroughput: 51200,     // 400 Kbps
};

const SLOW_4G = {
	offline: false,
	latency: 170,
	downloadThroughput: 524288,  // 4 Mbps
	uploadThroughput: 393216,    // 3 Mbps
};

const NO_THROTTLE = {
	offline: false,
	latency: 0,
	downloadThroughput: -1,
	uploadThroughput: -1,
};

test.describe('弱网环境', () => {
	/** @type {import('playwright-core').CDPSession | null} */
	let cdp = null;

	test.beforeEach(async ({ page }) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1280, height: 720 });
		await login(page);
		const sessionId = await navigateToChat(page);
		test.skip(!sessionId, 'No chat session available');
		await waitChatReady(page);
	});

	test.afterEach(async () => {
		if (cdp) {
			await cdp.send('Network.emulateNetworkConditions', NO_THROTTLE).catch(() => {});
			await cdp.detach().catch(() => {});
			cdp = null;
		}
	});

	// ================================================================
	// Test 1: Slow 3G — sending 状态明显可观察
	// ================================================================

	test('Slow 3G：发送消息时 sending 状态持续可见', async ({ page }) => {
		cdp = await page.context().newCDPSession(page);
		await cdp.send('Network.emulateNetworkConditions', SLOW_3G);

		const textarea = page.getByTestId('chat-textarea');
		const sendBtn = page.getByTestId('btn-send');
		const testMsg = 'slow3g-test-' + Date.now();

		await typeText(textarea, testMsg);
		await sendBtn.click();

		// 高延迟下 sending 状态应持续足够长，send 按钮消失（被 stop 按钮替换）
		await expect(sendBtn).not.toBeVisible({ timeout: 5000 });

		// 最终 sending 结束（消息完成或超时），send 按钮恢复
		// 超时设为 90s：Slow 3G 下 WS RPC 往返需 ~4s，agent 响应可能更久
		await expect(sendBtn).toBeVisible({ timeout: 90_000 });

		// 无错误 banner
		await expect(
			page.locator('[data-testid="chat-root"] .text-error'),
		).not.toBeVisible({ timeout: 3000 });
	});

	// ================================================================
	// Test 2: Slow 4G — 消息正常完成
	// ================================================================

	test('Slow 4G：发送消息可正常完成', async ({ page }) => {
		cdp = await page.context().newCDPSession(page);
		await cdp.send('Network.emulateNetworkConditions', SLOW_4G);

		const textarea = page.getByTestId('chat-textarea');
		const sendBtn = page.getByTestId('btn-send');
		const testMsg = 'slow4g-test-' + Date.now();

		await typeText(textarea, testMsg);
		await sendBtn.click();

		// Slow 4G 延迟低（170ms），应在合理时间内完成
		await expect(sendBtn).toBeVisible({ timeout: 60_000 });

		// textarea 恢复可用
		await expect(textarea).toBeEnabled({ timeout: 3000 });

		// 无错误 banner
		await expect(
			page.locator('[data-testid="chat-root"] .text-error'),
		).not.toBeVisible({ timeout: 3000 });
	});
});
