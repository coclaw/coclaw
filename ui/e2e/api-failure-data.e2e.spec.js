import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady } from './helpers.js';

/**
 * 数据加载 API 故障 E2E 测试
 *
 * 通过 Playwright route 拦截特定 API，模拟部分服务不可用时前端的降级行为。
 *
 * 前置条件：
 * - server 运行中
 * - test 用户已有至少一个 online bot
 */

// ================================================================
// 1. Bot 列表 API 故障
// ================================================================

test.describe('Bot 列表 API 故障 @resilience', () => {
	test('GET /api/v1/bots 返回 500 → 页面不崩溃，降级为空列表', async ({ page }) => {
		test.setTimeout(30_000);
		await page.setViewportSize({ width: 1280, height: 720 });

		// 先正常登录（确保 session 有效）
		await login(page);

		// 拦截 bot 列表 API
		await page.route('**/api/v1/bots', (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					status: 500,
					contentType: 'application/json',
					body: JSON.stringify({ message: 'Internal Server Error' }),
				});
			}
			route.continue();
		});

		// 导航到 topics 页（触发 botsStore.loadBots 重新加载）
		await page.goto('/topics');

		// 页面应正常渲染，不白屏
		await expect(page.locator('main')).toBeVisible({ timeout: 10_000 });

		// 不应出现未处理的 JS 错误导致的空白页面
		const bodyText = await page.locator('body').textContent();
		expect(bodyText?.length).toBeGreaterThan(0);
	});
});

// ================================================================
// 2. SSE 状态流故障
// ================================================================

test.describe('SSE 状态流故障 @resilience', () => {
	test('SSE 连接被拒 → 应用仍可正常加载和导航', async ({ page }) => {
		test.setTimeout(45_000);
		await page.setViewportSize({ width: 1280, height: 720 });

		// 在登录前拦截 SSE（EventSource 的初始 HTTP 请求）
		await page.route('**/api/v1/bots/status-stream', (route) => route.abort());

		await login(page);

		// 应用应正常加载（SSE 失败静默降级）
		await expect(page.locator('main')).toBeVisible({ timeout: 10_000 });

		// 可以导航到其他页面（验证整体路由不受影响）
		await page.goto('/user');
		await expect(page.locator('main')).toBeVisible({ timeout: 10_000 });
	});
});

// ================================================================
// 3. WebSocket 连接故障
// ================================================================

test.describe('WebSocket 连接故障 @resilience', () => {
	test('WS 升级被拒 → chat 页显示连接错误状态', async ({ page }) => {
		test.setTimeout(60_000);
		await page.setViewportSize({ width: 1280, height: 720 });

		// 正常登录，正常进入 chat（WS 已连接）
		await login(page);
		const sessionId = await navigateToChat(page);
		test.skip(!sessionId, 'No chat session available');
		await waitChatReady(page);

		// 记录 chat URL
		const chatUrl = page.url();

		// 拦截 WS 升级请求（阻止后续所有 WS 连接）
		await page.route('**/api/v1/bots/stream**', (route) => route.abort());

		// 刷新页面 → WS 尝试重连但被拦截
		await page.reload();

		// chat-root 应渲染（页面本身正常加载）
		await expect(page.getByTestId('chat-root')).toBeVisible({ timeout: 10_000 });

		// 应显示连接错误或 loading 状态（WS 无法建立 → 消息加载失败）
		// errorText = 'Bot not connected' 或 loading 持续
		await expect(async () => {
			const hasError = await page.locator('[data-testid="chat-root"] .text-error').isVisible();
			const hasLoading = await page.locator('[data-testid="chat-root"] .text-muted').isVisible();
			expect(hasError || hasLoading).toBe(true);
		}).toPass({ timeout: 15_000 });

		// textarea 在连接错误时仍可能显示（取决于 isBotOffline 状态）
		// 但发送应不可能（WS 断开）
		await expect(page).toHaveURL(chatUrl);
	});
});
