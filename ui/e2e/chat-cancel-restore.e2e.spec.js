import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady, typeText, evalStore } from './helpers.js';

/**
 * pre-accept 窗口点取消的行为验证
 *
 * 语义：agent 请求已发出但尚未收到 accepted 时点 STOP，不立刻清 UI，
 * 而是挂起取消意图 + 让 STOP 按钮转"取消中"禁用态，等 accepted 到达后转交真取消流程。
 *
 * 这些用例通过替换 sendMessage 模拟"RPC 永不 resolve"的飞行态，精准验证 pre-accept
 * 分支里 cancelSend 的 UI 表现；真正的 accepted→abort 链路由单元测试（chat.store.test.js
 * 的 cancelSend 套件）覆盖。
 */

// ================================================================
// Test 1: pre-accept RPC 在飞时取消：气泡保留 + STOP 转"取消中"
// ================================================================

test('pre-accept 取消（RPC 飞行）：气泡保留、STOP 按钮转取消中 @chat', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);

	const sessionId = await navigateToChat(page);
	test.skip(!sessionId, 'No chat session available');

	await waitChatReady(page);

	const textarea = page.getByTestId('chat-textarea');
	const testMsg = `intent-test-${Date.now()}`;
	await typeText(textarea, testMsg);
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });

	// 替换 sendMessage：模拟"已发 RPC、等 accepted"状态——
	// 保留 sending + 追加乐观气泡 + 建立 __cancelReject，但永不 accepted
	await evalStore(page, 'chat', `
		const origSend = store.sendMessage.bind(store);
		store.__origSendMessage = origSend;
		store.sendMessage = function(text /*, files*/) {
			store.sending = true;
			store.__accepted = false;
			store.__cancelReject = null;

			const cancelPromise = new Promise((_, reject) => {
				store.__cancelReject = reject;
			});

			store.messages = [...store.messages, {
				type: 'message',
				id: '__local_user_' + Date.now(),
				_local: true,
				_pending: true,
				message: { role: 'user', content: text, timestamp: Date.now() },
			}];
			store.messages = [...store.messages, {
				type: 'message',
				id: '__local_claw_' + Date.now(),
				_local: true,
				_pending: true,
				_streaming: true,
				_startTime: Date.now(),
				message: { role: 'assistant', content: '', stopReason: null },
			}];

			return cancelPromise.catch(err => {
				if (err?.code === 'USER_CANCELLED') return { accepted: false };
				throw err;
			}).finally(() => { store.__cancelReject = null; });
		};
	`);

	// 发送
	await page.getByTestId('btn-send').click();

	const stopBtn = page.getByTestId('btn-stop');
	await expect(stopBtn).toBeVisible({ timeout: 5000 });
	// 发送后输入框应清空
	await expect(textarea).toHaveValue('');

	// 点 STOP
	await stopBtn.click();

	// 断言：STOP 按钮仍在、转成"取消中"禁用态（图标切到 loader-circle，disabled=true）
	await expect(stopBtn).toBeVisible({ timeout: 3000 });
	await expect(stopBtn).toBeDisabled({ timeout: 3000 });

	// 断言：乐观气泡仍在（内部 __pendingCancelIntent=true，isCancelling=true）
	const intent = await evalStore(page, 'chat', 'return store.__pendingCancelIntent;');
	expect(intent).toBe(true);
	const isCancelling = await evalStore(page, 'chat', 'return store.isCancelling;');
	expect(isCancelling).toBe(true);

	// 断言：输入框保持清空，不恢复草稿——消息已视为已发出，用户需等取消协调完成
	await expect(textarea).toHaveValue('');

	// 收尾：触发 cleanup 放行挂起的 promise + 恢复 sendMessage
	await evalStore(page, 'chat', `
		store.cleanup();
		if (store.__origSendMessage) {
			store.sendMessage = store.__origSendMessage;
			delete store.__origSendMessage;
		}
	`);
});

// ================================================================
// Test 2: pre-accept 挂意图后 cleanup（如页面离开）：意图清除
// ================================================================

test('pre-accept 取消后 cleanup：__pendingCancelIntent 清除 @chat', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);

	const sessionId = await navigateToChat(page);
	test.skip(!sessionId, 'No chat session available');

	await waitChatReady(page);

	const textarea = page.getByTestId('chat-textarea');
	await typeText(textarea, `cleanup-test-${Date.now()}`);
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });

	await evalStore(page, 'chat', `
		const origSend = store.sendMessage.bind(store);
		store.__origSendMessage = origSend;
		store.sendMessage = function(text) {
			store.sending = true;
			store.__accepted = false;
			const cancelPromise = new Promise((_, reject) => { store.__cancelReject = reject; });
			store.messages = [...store.messages, {
				type: 'message', id: '__local_user_' + Date.now(),
				_local: true, _pending: true,
				message: { role: 'user', content: text, timestamp: Date.now() },
			}];
			return cancelPromise.catch(err => {
				if (err?.code === 'USER_CANCELLED') return { accepted: false };
				throw err;
			}).finally(() => { store.__cancelReject = null; });
		};
	`);

	await page.getByTestId('btn-send').click();
	await expect(page.getByTestId('btn-stop')).toBeVisible({ timeout: 5000 });

	await page.getByTestId('btn-stop').click();

	const intentBefore = await evalStore(page, 'chat', 'return store.__pendingCancelIntent;');
	expect(intentBefore).toBe(true);

	// 模拟页面离开
	await evalStore(page, 'chat', 'store.cleanup();');

	const intentAfter = await evalStore(page, 'chat', 'return store.__pendingCancelIntent;');
	expect(intentAfter).toBe(false);

	await evalStore(page, 'chat', `
		if (store.__origSendMessage) {
			store.sendMessage = store.__origSendMessage;
			delete store.__origSendMessage;
		}
	`);
});
