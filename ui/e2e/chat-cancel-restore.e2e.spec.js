import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady, typeText, evalStore } from './helpers.js';

/**
 * 发送取消后恢复输入 E2E 测试
 *
 * 验证：在 OpenClaw accepted 事件到达之前点击停止，
 * 用户的文本和附件应回显到输入框。
 *
 * 前置条件：
 * - server 运行中
 * - test 用户已有至少一个 online bot
 * - 存在可用 session
 */

// ================================================================
// Test 1: 文本在 accepted 前取消后恢复
// ================================================================

test('取消发送（accepted 前）：文本恢复到输入框 @chat', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);

	const sessionId = await navigateToChat(page);
	test.skip(!sessionId, 'No chat session available');

	await waitChatReady(page);

	// 输入文本
	const textarea = page.getByTestId('chat-textarea');
	const testMsg = `restore-test-${Date.now()}`;
	await typeText(textarea, testMsg);
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });

	// 拦截 sendMessage：替换为永不 settle 的 promise（模拟 accepted 未到达）
	await evalStore(page, 'chat', `
		const origSend = store.sendMessage.bind(store);
		store.__origSendMessage = origSend;
		store.sendMessage = function(text, files) {
			// 保持 sending 标志和乐观消息，但让 promise 永不 resolve
			store.sending = true;
			store.__accepted = false;
			store.__cancelReject = null;

			// 创建 cancel promise
			const cancelPromise = new Promise((_, reject) => {
				store.__cancelReject = reject;
			});

			// 追加乐观 user 消息（模拟真实 sendMessage 行为）
			store.messages = [...store.messages, {
				type: 'message',
				id: '__local_user_' + Date.now(),
				_local: true,
				message: { role: 'user', content: text, timestamp: Date.now() },
			}];
			store.messages = [...store.messages, {
				type: 'message',
				id: '__local_bot_' + Date.now(),
				_local: true,
				_streaming: true,
				_startTime: Date.now(),
				message: { role: 'assistant', content: '', stopReason: null },
			}];

			// 返回一个可被 cancel 的 promise
			return cancelPromise.catch(err => {
				if (err?.code === 'USER_CANCELLED') {
					return { accepted: false };
				}
				throw err;
			}).finally(() => {
				store.__cancelReject = null;
			});
		};
	`);

	// 点击发送
	await page.getByTestId('btn-send').click();

	// 等待进入 sending 状态（停止按钮出现）
	const stopBtn = page.getByTestId('btn-stop');
	await expect(stopBtn).toBeVisible({ timeout: 5000 });

	// 输入框应已清空
	await expect(textarea).toHaveValue('');

	// 点击停止
	await stopBtn.click();

	// 验证：文本恢复到输入框
	await expect(textarea).toHaveValue(testMsg, { timeout: 5000 });

	// 验证：发送按钮恢复（不再是 sending 状态）
	await expect(page.getByTestId('btn-send')).toBeVisible({ timeout: 3000 });

	// 恢复原始 sendMessage
	await evalStore(page, 'chat', `
		if (store.__origSendMessage) {
			store.sendMessage = store.__origSendMessage;
			delete store.__origSendMessage;
		}
	`);
});

// ================================================================
// Test 2: 文本 + 图片在 accepted 前取消后恢复
// ================================================================

test('取消发送（accepted 前）：文本和图片都恢复 @chat', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);

	const sessionId = await navigateToChat(page);
	test.skip(!sessionId, 'No chat session available');

	await waitChatReady(page);

	// 输入文本
	const textarea = page.getByTestId('chat-textarea');
	const testMsg = `img-restore-${Date.now()}`;
	await typeText(textarea, testMsg);

	// 附加图片
	const fileInput = page.getByTestId('file-input');
	const pngBuffer = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
		'base64',
	);
	await fileInput.setInputFiles({
		name: 'test-cancel.png',
		mimeType: 'image/png',
		buffer: pngBuffer,
	});

	// 确认图片预览出现
	const imgPreview = page.locator('footer img[alt="test-cancel.png"]');
	await expect(imgPreview).toBeVisible({ timeout: 5000 });

	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });

	// 拦截 sendMessage（同 Test 1）
	await evalStore(page, 'chat', `
		const origSend = store.sendMessage.bind(store);
		store.__origSendMessage = origSend;
		store.sendMessage = function(text, files) {
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
				message: { role: 'user', content: text, timestamp: Date.now() },
			}];
			store.messages = [...store.messages, {
				type: 'message',
				id: '__local_bot_' + Date.now(),
				_local: true,
				_streaming: true,
				_startTime: Date.now(),
				message: { role: 'assistant', content: '', stopReason: null },
			}];

			return cancelPromise.catch(err => {
				if (err?.code === 'USER_CANCELLED') {
					return { accepted: false };
				}
				throw err;
			}).finally(() => {
				store.__cancelReject = null;
			});
		};
	`);

	// 点击发送
	await page.getByTestId('btn-send').click();

	// 等待 sending 状态
	const stopBtn = page.getByTestId('btn-stop');
	await expect(stopBtn).toBeVisible({ timeout: 5000 });

	// 点击停止
	await stopBtn.click();

	// 验证：文本恢复
	await expect(textarea).toHaveValue(testMsg, { timeout: 5000 });

	// 验证：图片预览恢复
	const restoredImg = page.locator('footer img[alt="test-cancel.png"]');
	await expect(restoredImg).toBeVisible({ timeout: 5000 });

	// 验证：发送按钮恢复
	await expect(page.getByTestId('btn-send')).toBeVisible({ timeout: 3000 });

	// 恢复原始 sendMessage
	await evalStore(page, 'chat', `
		if (store.__origSendMessage) {
			store.sendMessage = store.__origSendMessage;
			delete store.__origSendMessage;
		}
	`);
});
