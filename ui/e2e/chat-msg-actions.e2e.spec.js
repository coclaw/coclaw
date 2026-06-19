import { expect, test } from '@playwright/test';
import { login, navigateToMainChat, waitChatReady } from './helpers.js';

/**
 * 聊天消息操作 E2E（复制按钮）@chat
 *
 * 覆盖 ChatMsgItem 的两条复制路径：
 *   - 用户文本消息：copyText(item.textContent) → 复制原始文本
 *   - assistant markdown 消息：copyClawResult() → 复制渲染后 .cc-markdown 的 innerText（去 md 符号）
 *
 * 注入「已完成」消息走与 chat-resilience-mock 同套路的 RPC 边界 mock：把 sessions.get
 * 合成成既有一条 user 文本、又有一条 assistant markdown 的会话正文（NO real LLM send），
 * chatHistory.list 留空避免真实孤儿历史的 autoFill 干扰计数。复用 string / block-array 两种
 * content 形态。命中的 RPC 被客户端拦下、绝不发往插件，纯只读、不污染核心数据。
 *
 * 复制按钮无 data-testid：定位靠「消息项内的按钮」+ 图标 SVG 翻转判定确认态
 * （copied → :icon 由 i-lucide-copy 切到 i-lucide-check；iconify 同前缀同 class，
 * 故以图标内联 SVG 内容变化为翻转信号）。剪贴板内容用 navigator.clipboard.readText() 直读。
 */

/**
 * 安装 RPC 边界 mock（document_start 急切包裹与 app 同一份 Vite 缓存模块）。
 * 与 chat-resilience-mock.e2e.spec.js 的 installRpcMock 同套路，此处内联以保持本 spec 自包含。
 */
function installRpcMock(page, rules) {
	return page.addInitScript((rules) => {
		const wrap = (ClawConnection) => {
			if (!ClawConnection || ClawConnection.__msgActWrapped) return;
			ClawConnection.__msgActWrapped = true;
			const orig = ClawConnection.prototype.request;
			ClawConnection.prototype.request = function (method, params = {}, options = {}) {
				for (const rule of rules) {
					if (rule.method !== method) continue;
					if (rule.resolve !== undefined) {
						return Promise.resolve(rule.resolve);
					}
				}
				return orig.call(this, method, params, options);
			};
		};
		window.__msgActWrap = wrap;
		let tries = 0;
		const tryInstall = () => {
			import('/src/services/claw-connection.js')
				.then((m) => {
					if (m && m.ClawConnection) wrap(m.ClawConnection);
					else if (tries++ < 100) setTimeout(tryInstall, 20);
				})
				.catch(() => { if (tries++ < 100) setTimeout(tryInstall, 20); });
		};
		tryInstall();
	}, rules);
}

/** 兜底：导航后再确保一次 wrap 生效（幂等） */
async function ensureRpcMock(page) {
	await page.evaluate(async () => {
		if (typeof window.__msgActWrap === 'function') {
			const m = await import('/src/services/claw-connection.js');
			if (m && m.ClawConnection) window.__msgActWrap(m.ClawConnection);
		}
	});
}

test('复制消息：用户文本 + assistant markdown 复制到剪贴板并翻转确认态 @chat', async ({ page, context }) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1280, height: 720 });

	// 复制成功（写剪贴板成功）才会翻转确认态；读剪贴板做内容断言也需 read 权限
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);

	const ts = Date.now();
	const userText = `e2e-copy-user-${ts}`;
	const mdToken = `e2e-copy-md-${ts}`;

	// 扁平 OC 消息（sessions.get 出参形态）：一条 user 文本（string content）+
	// 一条 assistant markdown（block-array content，stopReason=endTurn → 进 resultText）
	const mockMessages = [
		{ role: 'user', content: userText, timestamp: ts - 2000 },
		{ role: 'assistant', model: 'e2e-model', stopReason: 'endTurn', timestamp: ts - 1000, content: [
			{ type: 'text', text: `# Heading ${mdToken}\n\nA paragraph with **bold** and token ${mdToken}.` },
		] },
	];

	await installRpcMock(page, [
		{ method: 'sessions.get', resolve: { messages: mockMessages } },
		{ method: 'coclaw.chatHistory.list', resolve: { history: [] } },
	]);

	await login(page);
	await ensureRpcMock(page);

	const ctx = await navigateToMainChat(page);
	test.skip(!ctx, 'No chat session available');
	await waitChatReady(page);

	// 注入的两条消息各成一项（1 user + 1 botTask）
	await expect(page.getByTestId('chat-msg-item')).toHaveCount(2, { timeout: 30_000 });

	const userItem = page.getByTestId('chat-msg-item').filter({ hasText: userText });
	const botItem = page.getByTestId('chat-msg-item').filter({ hasText: mdToken });
	await expect(userItem).toBeVisible();
	await expect(botItem).toBeVisible();

	// macOS headed 下 readText 需文档聚焦
	await page.bringToFront();

	// --- 用户文本复制：唯一按钮即复制按钮 ---
	const userCopyBtn = userItem.getByRole('button').last();
	const userIcon = userCopyBtn.locator('svg');
	const userIconBefore = await userIcon.innerHTML();
	await userCopyBtn.click();
	// 确认态翻转：图标 SVG 由 copy 切到 check（内容变化），2s 内捕获
	await expect.poll(async () => await userIcon.innerHTML(), { timeout: 1800, intervals: [50, 100, 150, 200] })
		.not.toBe(userIconBefore);
	// 剪贴板内容 = 用户消息原文
	const userClip = await page.evaluate(() => navigator.clipboard.readText());
	expect(userClip).toContain(userText);

	// 等用户项图标复位（copied 2s 后归位），避免与下条断言串扰
	await expect.poll(async () => await userIcon.innerHTML(), { timeout: 4000, intervals: [200, 300, 500] })
		.toBe(userIconBefore);

	// --- assistant markdown 复制：footer 末个按钮即复制按钮（首个为思考折叠 toggle）---
	const botCopyBtn = botItem.getByRole('button').last();
	const botIcon = botCopyBtn.locator('svg');
	const botIconBefore = await botIcon.innerHTML();
	await botCopyBtn.click();
	await expect.poll(async () => await botIcon.innerHTML(), { timeout: 1800, intervals: [50, 100, 150, 200] })
		.not.toBe(botIconBefore);
	// copyClawResult 复制渲染后 .cc-markdown 的 innerText（md 符号被去掉），仍含唯一 token
	const botClip = await page.evaluate(() => navigator.clipboard.readText());
	expect(botClip).toContain(mdToken);
	// 复制的是渲染文本而非原始 markdown：不应包含标题井号
	expect(botClip).not.toContain(`# Heading`);
});
