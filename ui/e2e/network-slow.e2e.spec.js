import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady, typeText, evalStore } from './helpers.js';

/**
 * 慢速传输 E2E 测试
 *
 * 旧版用 CDP Network.emulateNetworkConditions 模拟"弱网"——但业务 RPC 走 loopback P2P
 * DataChannel，CDP 只能限渲染层 HTTP/WS，碰不到 DC：撤掉限速断言全等（假绿）。这里改为直接在
 * DC 的 RPC 发送通道注入确定性延迟，真实模拟慢速上行，并以"accept 被延迟"作为非平凡信号验证
 * 慢传输确实作用在发送路径上。keepalive 探针走原始 dc.send，不受包装影响、不触发 RTC 重建。
 *
 * 前置条件：同 chat-resilience（test 用户至少一个 online claw + agent:main:main session）
 */

/**
 * 在 DC 的 RPC 发送通道注入固定延迟（ms）：注入后每次 conn.rtc.send 的请求帧都被推迟 delayMs
 * 才真正发出。返回是否注入成功（DC 未就绪则 false）。
 * @param {import('@playwright/test').Page} page
 * @param {number} delayMs
 * @returns {Promise<boolean>}
 */
function injectDcSendDelay(page, delayMs) {
	return evalStore(page, 'chat', `
		const conn = store.__getConnection();
		if (!conn?.rtc?.isReady) return false;
		const orig = conn.rtc.send.bind(conn.rtc);
		conn.rtc.send = (...args) => new Promise((resolve, reject) => {
			setTimeout(() => orig(...args).then(resolve, reject), ${delayMs});
		});
		return true;
	`);
}

test.describe('慢速传输 @resilience', () => {
	test.beforeEach(async ({ page }) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1280, height: 720 });
		await login(page);
		const sessionId = await navigateToChat(page);
		test.skip(!sessionId, 'No chat session available');
		await waitChatReady(page);
	});

	// ================================================================
	// Test 1: 慢速上行 — sending 状态持续可见，accept 被传输延迟真实推迟后成功送达
	// ================================================================

	test('慢速上行：sending 持续可见、accept 被传输延迟推迟后成功送达', async ({ page }) => {
		const DELAY = 6000;
		const textarea = page.getByTestId('chat-textarea');
		const testMsg = 'slow-uplink-' + Date.now();

		const injected = await injectDcSendDelay(page, DELAY);
		expect(injected).toBe(true);

		await typeText(textarea, testMsg);
		await page.getByTestId('btn-send').click();

		// 乐观发送：btn-send 立即被 btn-stop 取代（sending 状态可见）
		await expect(page.getByTestId('btn-stop')).toBeVisible({ timeout: 5000 });

		// 注入延迟真实生效：请求帧被推迟 DELAY 才发出 → agent 在此之前收不到 → __accepted
		// 在延迟窗口内确定性地保持 false（无延迟时 loopback accept 通常 <1s）。
		// 这是"慢传输被真实反映"的非平凡信号，而非 CDP 限速那种碰不到 DC 的假绿。
		await page.waitForTimeout(3000);
		expect(await evalStore(page, 'chat', 'return store.__accepted')).toBe(false);

		// 延迟过后请求真正送达、agent accept（消息成功送达，慢但不失败）。__accepted===true 即为
		// 成功信号；不再断言 .text-error「错误 banner」——chat 错误经 toast 暴露、chat-root 内并无该
		// banner，该 class 反而会误命中红色样式的 btn-stop（发送中即假阳）。
		await expect
			.poll(() => evalStore(page, 'chat', 'return store.__accepted'), { timeout: 30_000 })
			.toBe(true);
	});

	// ================================================================
	// Test 2: 慢速上行下消息仍能端到端完成（韧性：慢但不失败）
	// ================================================================

	test('慢速上行：消息最终完成、输入框恢复可用', async ({ page }) => {
		test.setTimeout(300_000);
		const DELAY = 4000;
		const textarea = page.getByTestId('chat-textarea');
		const testMsg = 'slow-complete-' + Date.now();

		const injected = await injectDcSendDelay(page, DELAY);
		expect(injected).toBe(true);

		await typeText(textarea, testMsg);
		await page.getByTestId('btn-send').click();

		// 注入延迟期间 accept 尚未发生（证明延迟真实作用于发送路径，而非瞬时完成）
		await page.waitForTimeout(2000);
		expect(await evalStore(page, 'chat', 'return store.__accepted')).toBe(false);

		// 慢传输下消息仍最终完成（btn-stop 消失），未卡死
		await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });

		// 成功终态：__accepted 为 true（run 被 accept 并跑完），区别于 pre-accept 失败（btn-stop 也会
		// 消失但 __accepted 仍 false）；textarea 恢复可用
		expect(await evalStore(page, 'chat', 'return store.__accepted')).toBe(true);
		await expect(textarea).toBeEnabled({ timeout: 3000 });
	});
});
