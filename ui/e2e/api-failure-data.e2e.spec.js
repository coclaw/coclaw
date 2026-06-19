import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady } from './helpers.js';

/**
 * 数据加载 API 故障 E2E 测试
 *
 * 通过 Playwright route 拦截特定 API，模拟部分服务不可用时前端的降级行为。
 *
 * 前置条件：
 * - server 运行中
 * - test 用户已有至少一个 online claw
 */

// ================================================================
// 1. Claw 列表 API 故障
// ================================================================

test.describe('Claw 列表 API 故障 @resilience', () => {
	test('claw 数据源(SSE status-stream)故障 → 页面不崩溃，降级为空列表', async ({ page }) => {
		test.setTimeout(30_000);
		await page.setViewportSize({ width: 1280, height: 720 });

		// 真正喂养 claw 列表的是 SSE /api/v1/claws/status-stream（→ applySnapshot），
		// 而非 REST GET /api/v1/claws（listClaws 在生产代码无任何调用方，是死端点）。
		// 因此必须拦截 status-stream 才能真实触发"数据源故障 → 空列表"降级；拦死 REST 只会假绿。
		// 须在 login 前安装：SSE 在 AuthedLayout 监听到 user.id 即 start，晚装会漏掉首次连接、claw 照常出网。
		let statusStreamHit = false;
		await page.route('**/api/v1/claws/status-stream', (route) => {
			statusStreamHit = true;
			return route.abort();
		});

		await login(page);
		await page.goto('/topics');

		// MainList 渲染成功、未崩溃：底部"添加 Claw"入口在 main 实例下恒渲染，是 locale 无关的稳定锚点。
		await expect(page.getByTestId('bottom-action-add-claw')).toBeVisible({ timeout: 10_000 });

		// 降级为空列表：claw 数据源被拦截 → byId 为空 → 不渲染任何 agent 会话入口（a[href*="/chat/"]）。
		// 若降级处理坏掉、claw 漏进列表，这里会 > 0 而失败。
		await expect(async () => {
			const agentLinks = await page.locator('main a[href*="/chat/"]').count();
			expect(agentLinks, 'degraded claw list should render zero agent entries').toBe(0);
		}).toPass({ timeout: 5000 });

		// 证明拦截真实命中——否则上面的空列表可能只是 SSE 恰好没数据的假绿。
		expect(statusStreamHit, 'status-stream route should have been intercepted').toBe(true);
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
		await page.route('**/api/v1/claws/status-stream', (route) => route.abort());

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

		// 拦截信令 WS（真实端点 /api/v1/rtc/signal），关闭每次连接尝试。
		// 注意：page.route 不拦截 WebSocket（这正是 Playwright 单设 routeWebSocket
		// 的原因），故此处必须用 routeWebSocket，否则拦截落空、WS 正常连、假绿。
		// ws.close() 后 SignalingConnection 会重连，但每次重连同样被拦截关闭 →
		// 信令通道持续不可用 → RTC/DataChannel 无法建立。
		await page.routeWebSocket('**/api/v1/rtc/signal*', (ws) => ws.close());

		// 刷新页面 → WS 尝试重连但被拦截
		await page.reload();

		// chat-root 应渲染（页面本身正常加载）
		await expect(page.getByTestId('chat-root')).toBeVisible({ timeout: 10_000 });

		// 信令持续不可用 → DataChannel 永远建不起来 → 数据通道失败。
		// claw 仍 online（SSE 未被拦截），dcReady 恒 false → chat-root 稳定显示
		// 连接状态 banner（.text-muted）或错误文案（.text-error），不再靠瞬时 loading 假绿。
		await expect(async () => {
			const hasError = await page.locator('[data-testid="chat-root"] .text-error').isVisible();
			const hasLoading = await page.locator('[data-testid="chat-root"] .text-muted').isVisible();
			expect(hasError || hasLoading).toBe(true);
		}).toPass({ timeout: 15_000 });

		// textarea 在连接错误时仍可能显示（取决于 isClawOffline 状态）
		// 但发送应不可能（WS 断开）
		await expect(page).toHaveURL(chatUrl);
	});
});
