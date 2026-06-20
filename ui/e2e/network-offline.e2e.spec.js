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
 * - test 用户已有至少一个 online claw（已绑定且 OpenClaw gateway 运行中）
 * - 存在 agent:main:main session
 *
 * 技术手段：context.setOffline(true/false) 模拟浏览器断网/恢复
 */

/** 取应用当前语言下某个 i18n key 的渲染值，让断言与具体 locale 解耦（测试账号可能持久化 lang=zh-CN） */
async function tr(page, key) {
	return page.evaluate(async (k) => {
		const m = await import('/src/i18n/index.js');
		return m.i18n.global.t(k);
	}, key);
}

/** 转义正则元字符（i18n 文案含 . 。 等字符，拼 alternation 前先转义） */
function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe('网络断开与恢复 @resilience', () => {
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
	// Test 1: 断网 → 发消息 → 韧性等待（不快速失败、不回滚、保留气泡）
	// ================================================================
	//
	// 为何不验证"立即弹错误 toast"：业务 RPC 走 RTC DataChannel，与信令 WS 是两条
	// 独立通路（communication-model 第二章）。仅 forceCloseWs（断信令 WS）+ setOffline，
	// 已建立的 DataChannel 不会立刻关闭——ICE 有 ~3min 恢复预算、SCTP 跨 ICE restart 存活
	// （communication-model §5.5）。所以消息被乐观投递后挂起等响应/重连：
	//   - agent RPC 的连接等待默认 210s（DEFAULT_CONNECT_TIMEOUT_MS）
	//   - pre-acceptance 看门狗 180s，到点才以"响应超时"形式反馈
	//   - 断连后还会自动重试一次，retry 仍走 210s 连接等待
	// 即"断网立即报连接错误"并非产品真实行为：产品是韧性等待，最快 ~180s 才有超时反馈。
	// 因此本用例验证韧性语义（消息被保留、不快速失败），而非快速失败的错误 toast。
	//
	// 【为何还要 stall DC——setOffline 模拟断网并不严密】
	// context.setOffline(true) 只切断浏览器的 HTTP/WS，切不断环回（loopback）上的 P2P
	// DataChannel——claw 与 UI 同机时 RTC 走 host candidate，setOffline 拦不到。实测：仅
	// forceCloseWs + setOffline 后，agent 请求照样经仍 open 的 DC 投递、被在线 agent 正常
	// accept 并应答，run 正常完成 → sending 在 ~10-15s 内回落 false。这并非"快速失败"，而是
	// 一次真实成功发送；但它与本用例"韧性等待、消息保持在途"的前提相悖，且完成时刻随机落在
	// 断言窗口前后 → 此前 load-sensitive flake 的根因（机器负载只是拉长了 click→断言的墙钟
	// 窗口，让本就临界的完成时刻更易落入窗口内）。
	// 因此这里额外把 DC 的 RPC 发送通道 stall 掉，airtight 模拟"发得出、收不回"的真实断网：
	// 请求永挂在连接/响应等待中，sending 确定性地持续 true。keepalive 探针走原始 dc.send
	// （非此 send() 包装），不受影响，不会触发 RTC 重建 churn。

	test('断网后发消息：进入韧性等待，不快速失败、不回滚、保留气泡', async ({ page, context }) => {
		const textarea = page.getByTestId('chat-textarea');
		const testMsg = 'offline-test-' + Date.now();

		// 先输入文本
		await typeText(textarea, testMsg);

		// 强制关闭信令 WS + 断网阻止重连（setOffline 不会立即关闭 WS）
		await forceCloseWs(page);
		await context.setOffline(true);

		// 等待信令 WS 断开
		await waitForWsState(page, 'disconnected');

		// 把当前 claw 的 DC RPC 发送通道 stall 掉：让 agent 请求发出后永不返回（airtight 断网）。
		// 不关 DC、不改状态机——避免 close 触发 RTC 重建 churn 把乐观气泡刷掉；仅令"收不回响应"。
		const stalled = await evalStore(page, 'chat', `
			const conn = store.__getConnection();
			if (!conn?.rtc?.isReady) return false;
			conn.rtc.send = () => new Promise(() => {}); // 永挂：发出后无响应
			return true;
		`);
		expect(stalled).toBe(true);

		// 点击发送
		await page.getByTestId('btn-send').click();

		// 1) sending 持续为 true：消息已被乐观投递并在途/排队，未被快速拒绝
		await expect.poll(
			() => evalStore(page, 'chat', 'return store.sending'),
			{ timeout: 8000 },
		).toBe(true);

		// 2) 再留一段窗口，确认期间确实没有触发任何"快速失败"路径。
		// DC 已 stall（收不回响应）→ sending 确定性地持续 true，不再依赖"agent 恰好没应答完"的时序。
		await page.waitForTimeout(5000);
		const stillSending = await evalStore(page, 'chat', 'return store.sending');
		expect(stillSending).toBe(true);

		// 3) 窗口内不应出现任何连接/超时类错误 toast（210s/180s 远超此处窗口）
		const connErrTexts = await Promise.all([
			tr(page, 'chat.errWsClosed'),
			tr(page, 'chat.errRtcSendFailed'),
			tr(page, 'chat.errRpcTimeout'),
			tr(page, 'chat.errPreAcceptTimeout'),
		]);
		const connErrRe = new RegExp(connErrTexts.map(escapeRe).join('|'));
		await expect(
			page.locator('[data-slot="title"]').filter({ hasText: connErrRe }),
		).toHaveCount(0);

		// 4) 输入框保持为空：消息进入在途，草稿未回滚（与"快速失败回滚"相反）
		await expect(textarea).toHaveValue('');

		// 5) 消息被保留为"发送中"在途态：未回滚、未丢弃，且确实进入等待而非快速完成/失败。
		// 真实断网（DC 已 stall，永不 accepted）下乐观气泡始终 _pending → ChatMsgItem 展示
		// "发送中…"在途指示器而非正文（正文仅在 accepted 后渲染）。这里以 store 断言核验韧性等待
		// 的完整契约——确定性、且不依赖 ChatPage 的滚动就绪可见性门（__scrollReady 未就绪时整面板
		// visibility:hidden，使任何 DOM 可见性断言在负载下脆断；正文此时本就不渲染，须查 store）：
		//   - found：乐观用户消息仍在（_local + 内容未变）→ 未回滚 / 丢弃
		//   - pending：仍为 _pending → UI 呈现为"发送中"在途态而非快速失败被清掉
		//   - accepted=false：airtight 断网下确实在等待，而非经仍 open 的环回 DC 被 agent 正常完成
		const state = await evalStore(page, 'chat', `
			const m = (store.messages || []).find(
				x => x._local && x.message?.role === 'user' && x.message?.content === '${testMsg}'
			);
			return { found: !!m, pending: !!m?._pending, accepted: store.__accepted };
		`);
		expect(state).toEqual({ found: true, pending: true, accepted: false });
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
	// Test 3: 断网期间 claw 不误报 offline
	// ================================================================

	test('断网期间：claw.online 保持 true，无 offline banner', async ({ page, context }) => {
		// 确认 claw 当前在线
		const clawId = await evalStore(page, 'chat', 'return store.clawId');
		const clawOnlineBefore = await evalStore(page, 'claws', `
			const claw = store.items?.find(b => String(b.id) === String('${clawId}'));
			return claw?.online ?? false;
		`);
		expect(clawOnlineBefore).toBe(true);

		// 强制关闭 WS + 断网阻止重连
		await forceCloseWs(page);
		await context.setOffline(true);
		await waitForWsState(page, 'disconnected');

		// 等待一段时间，确保 SSE 错误已触发
		await page.waitForTimeout(3000);

		// claw.online 应仍为 true（SSE 断开不改变 claw.online，只有 SSE 消息才改变）
		const clawOnlineAfter = await evalStore(page, 'claws', `
			const claw = store.items?.find(b => String(b.id) === String('${clawId}'));
			return claw?.online ?? false;
		`);
		expect(clawOnlineAfter).toBe(true);

		// offline banner 不应出现
		const offlineBanner = page.locator('[data-testid="chat-root"] .bg-warning\\/10');
		await expect(offlineBanner).not.toBeVisible({ timeout: 2000 });

		// textarea 不应被禁用（isClawOffline 未变化）
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

		// ClawConnection 会自动重连（指数退避，初始 1s）
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
