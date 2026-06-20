import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady, waitChatInputStable, typeText, evalStore } from './helpers.js';

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

// ================================================================
// Test 3: post-accept 在飞取消（真实 agent，不 mock）：
//   发送 → 等 run 真 accepted/streaming → 点 STOP → 进入"取消中" →
//   等真实终态 → 断言 STOP 消失、状态清洁、partial 气泡妥善处理、btn-send 复用
// ================================================================
//
// 与 Test 1/2（pre-accept，mock sendMessage 模拟 RPC 永不 resolve）互补：
// 本用例不 mock，发真消息、等服务端 accept 后在 streaming 窗口点 STOP，
// 走 cancelSend 的 accepted 分支（settleWithTransition + abort RPC 协调），
// 验证真实取消路径下 UI 不挂、流式/乐观气泡不残留、输入区可再次发送。

test('post-accept 取消（streaming 在飞）：STOP 协调、状态清洁、btn-send 复用 @chat', async ({ page }) => {
	// 链路：login+nav(~45s) + accept 窗口 + 取消协调到真实终态（含 180s 兜底）
	test.setTimeout(240_000);
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);

	const session = await navigateToChat(page);
	test.skip(!session, 'No chat session available');

	await waitChatReady(page);
	// 真实发送：等首屏重渲染风暴结束，避免受控 textarea 丢字符
	await waitChatInputStable(page);

	const textarea = page.getByTestId('chat-textarea');
	const mark = `postaccept-cancel-${Date.now()}`;
	await typeText(textarea, mark);
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 5000 });

	// 真实发送（不 mock）
	await page.getByTestId('btn-send').click();

	const stopBtn = page.getByTestId('btn-stop');
	await expect(stopBtn).toBeVisible({ timeout: 10_000 });
	// 发送后输入框清空
	await expect(textarea).toHaveValue('');

	// 等 run 真正 accepted（accept 早翻，约 1–2s），此刻仍在 streaming
	await expect.poll(
		() => evalStore(page, 'chat', 'return store.__accepted === true;'),
		{ timeout: 30_000, intervals: [200, 300, 500, 800] },
	).toBe(true);

	// streaming 在飞时点 STOP（真取消，走 accepted 分支协调）
	await expect(stopBtn).toBeVisible({ timeout: 3000 });
	await stopBtn.click();

	// 进入"取消中"：STOP 仍在但禁用（isCancelling=true → cancelDisabled），证明走 accepted 协调分支
	await expect(stopBtn).toBeDisabled({ timeout: 5000 });
	const cancellingNow = await evalStore(page, 'chat', 'return store.isCancelling === true;');
	expect(cancellingNow).toBe(true);

	// 等真实终态：run 结束 → loadMessages → dropRun → isSending=false → STOP 消失
	// （判完成用 STOP 消失，不用 btn-send 出现——输入框已清空时 btn-send 不渲染）
	await expect(stopBtn).toBeHidden({ timeout: 180_000 });

	// 终态快照：状态清洁 + partial 气泡处理结果（content 可能是 string 或 block 数组）
	const summary = await evalStore(page, 'chat', `
		const mark = ${JSON.stringify(mark)};
		const msgs = store.allMessages;
		const textOf = (m) => {
			const c = m && m.message && m.message.content;
			if (typeof c === 'string') return c;
			if (Array.isArray(c)) return c.filter(b => b && b.type === 'text').map(b => b.text).join('');
			return '';
		};
		let userIdx = -1;
		for (let i = 0; i < msgs.length; i++) {
			if (msgs[i] && msgs[i].message && msgs[i].message.role === 'user' && textOf(msgs[i]).includes(mark)) userIdx = i;
		}
		let assistantAfter = null;
		if (userIdx >= 0) {
			for (let i = userIdx + 1; i < msgs.length; i++) {
				if (msgs[i] && msgs[i].message && msgs[i].message.role === 'assistant') {
					assistantAfter = {
						present: true,
						contentLen: textOf(msgs[i]).length,
						streaming: !!msgs[i]._streaming,
						pending: !!msgs[i]._pending,
					};
					break;
				}
			}
		}
		return {
			sending: store.sending,
			isSending: store.isSending,
			isCancelling: store.isCancelling,
			accepted: store.__accepted,
			userFound: userIdx >= 0,
			anyStreamingStuck: msgs.some(m => m._streaming),
			anyPendingStuck: msgs.some(m => m._pending),
			assistantAfter,
		};
	`);

	// 留痕供人工核对实际行为（partial 气泡是否留存）
	console.log('[e2e][post-accept-cancel] summary=', JSON.stringify(summary));

	// 断言：用户消息已发出并留存
	expect(summary.userFound).toBe(true);
	// 断言：终态清洁——不挂、无残留的流式/乐观气泡（无论 partial 气泡留存与否，都不应卡在中途态）
	expect(summary.sending).toBe(false);
	expect(summary.isSending).toBe(false);
	expect(summary.isCancelling).toBe(false);
	expect(summary.anyStreamingStuck).toBe(false);
	expect(summary.anyPendingStuck).toBe(false);

	// 断言：btn-send 复用——重新输入即可再次发送
	await typeText(textarea, 'x');
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 5000 });
	// 清掉草稿，不真正发送，避免多余 run
	await textarea.press('ControlOrMeta+a');
	await textarea.press('Delete');
});
