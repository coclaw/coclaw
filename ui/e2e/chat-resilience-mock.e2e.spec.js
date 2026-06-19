import { expect, test } from '@playwright/test';
import { login, navigateToMainChat, waitChatReady, evalStore, typeText } from './helpers.js';
import { tr } from './model-config-mock.js';

/**
 * ChatPage 异常 / 边界 E2E（mock 驱动）
 *
 * 这些场景靠自然交互几乎无法稳定触发（要插件返特定错误码、要 session 正文不可用等），
 * 故在 ClawConnection 边界拦 RPC 合成响应。与 model-config-mock.js 同套路：document_start
 * 急切把 `/src/services/claw-connection.js`（与 app 同一份 Vite 缓存模块）的
 * ClawConnection.prototype.request 包一层，按规则返回合成响应，其余 RPC 原样透传真实链路。
 *
 * 安全：全部为只读 mock —— 命中的 RPC（sessions.get / coclaw.topics.create / getById /
 * chatHistory.list）被客户端拦下，从不发往插件，绝不解绑 claw、不创建真实 topic、不污染核心数据。
 */

/**
 * 安装 RPC 边界 mock。必须在任何导航（含 login 的 goto）之前调用。
 *
 * @param {import('@playwright/test').Page} page
 * @param {Array<{ method: string, when?: { paramKey: string, equals: * }, reject?: { code: string, message: string }, resolve?: object }>} rules
 *   - method：要拦截的 RPC 方法名
 *   - when：可选，仅当 params[paramKey] === equals 时命中（用于按 sessionId 精确匹配）
 *   - reject：命中则 reject 一个带 code + message 的 Error
 *   - resolve：命中则 resolve 该 payload
 *   未命中任何规则的 RPC 原样透传 orig.request
 */
function installRpcMock(page, rules) {
	return page.addInitScript((rules) => {
		const wrap = (ClawConnection) => {
			if (!ClawConnection || ClawConnection.__rcWrapped) return;
			ClawConnection.__rcWrapped = true;
			const orig = ClawConnection.prototype.request;
			ClawConnection.prototype.request = function (method, params = {}, options = {}) {
				for (const rule of rules) {
					if (rule.method !== method) continue;
					if (rule.when) {
						const v = params ? params[rule.when.paramKey] : undefined;
						if (v !== rule.when.equals) continue;
					}
					if (rule.reject) {
						const err = new Error(rule.reject.message || 'mock reject');
						err.code = rule.reject.code || 'MOCK_ERR';
						return Promise.reject(err);
					}
					if (rule.resolve !== undefined) {
						return Promise.resolve(rule.resolve);
					}
				}
				return orig.call(this, method, params, options);
			};
		};
		window.__rcWrap = wrap;
		// document_start 即急切加载并包裹（与 app 同一份模块），抢在 app 首个 RPC 之前生效
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

/** 兜底：导航后再确保一次 wrap 生效（document_start 急切安装的二次保险，幂等） */
async function ensureRpcMock(page) {
	await page.evaluate(async () => {
		if (typeof window.__rcWrap === 'function') {
			const m = await import('/src/services/claw-connection.js');
			if (m && m.ClawConnection) window.__rcWrap(m.ClawConnection);
		}
	});
}

// ================================================================
// Test 1: 未知方法（unknown method）→ 升级 OpenClaw 提示
// ================================================================

test('unknown-method RPC 错误：显示错误 + 升级 OpenClaw 提示 @chat @resilience', async ({ page }) => {
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1280, height: 720 });

	// 镜像 OpenClaw gateway 的未知方法错误形态：message = `unknown method: <method>`
	// （src/gateway/server-methods.ts errorShape INVALID_REQUEST）。ChatPage 据
	// errorText.includes('unknown method') 追加升级提示。
	await installRpcMock(page, [
		{ method: 'sessions.get', reject: { code: 'INVALID_REQUEST', message: 'unknown method: sessions.get' } },
	]);

	await login(page);
	await ensureRpcMock(page);

	const ctx = await navigateToMainChat(page);
	test.skip(!ctx, 'No chat session available');

	await expect(page.getByTestId('chat-root')).toBeVisible({ timeout: 15_000 });

	// 首次 loadMessages（非 silent）失败 → errorText 被置为注入的 message
	const errorEl = page.locator('[data-testid="chat-root"] .text-error');
	await expect(errorEl).toBeVisible({ timeout: 40_000 });
	await expect(errorEl).toContainText('unknown method');

	// 升级提示（locale 无关：用运行时 i18n 值断言）
	const hint = await tr(page, 'chat.upgradeOpenClawHint');
	await expect(page.getByText(hint)).toBeVisible({ timeout: 5000 });
});

// ================================================================
// Test 2: 新建 topic 过程中 CLAW_DISCONNECTED → 恢复（回到可用首页）
// ================================================================

test('新建 topic 时连接断开（CLAW_DISCONNECTED）：不卡空白页，回到可用态 @chat @resilience', async ({ page }) => {
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1280, height: 720 });

	// 模拟 topic 创建中途连接断开：createTopic 的 coclaw.topics.create 抛 CLAW_DISCONNECTED
	// （等价于 topics.store 在 await 期间发现 claw 被移除而抛的同码错误）。
	await installRpcMock(page, [
		{ method: 'coclaw.topics.create', reject: { code: 'CLAW_DISCONNECTED', message: 'Claw disconnected during topic creation' } },
	]);

	await login(page);
	await ensureRpcMock(page);

	// 先进 main chat 拿到 clawId（同时把 claw + 连接就绪）
	const ctx = await navigateToMainChat(page);
	test.skip(!ctx, 'No chat session available');

	// 进入"新建 topic"路由（死胡同入口，create 必失败）
	await page.goto(`/topics/new?agent=main&claw=${ctx.clawId}`);
	await expect(page.getByTestId('chat-root')).toBeVisible({ timeout: 15_000 });

	const textarea = page.getByTestId('chat-textarea');
	await expect(textarea).toBeEnabled({ timeout: 15_000 });
	await typeText(textarea, `e2e topic disconnect ${Date.now()}`);

	const sendBtn = page.getByTestId('btn-send');
	await expect(sendBtn).toBeEnabled({ timeout: 3000 });
	await sendBtn.click();

	// 恢复：createTopic 抛 CLAW_DISCONNECTED → ChatPage 重定向到 '/'（→ /home），
	// 不停留在新建 topic 死胡同、不卡空白页
	await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
	await expect(page).not.toHaveURL(/\/topics\/new/);
	const main = page.locator('main');
	await expect(main).toBeVisible({ timeout: 10_000 });
	// 页面有实质内容（非白屏崩溃）
	const bodyText = await page.locator('body').textContent();
	expect((bodyText || '').trim().length).toBeGreaterThan(0);
});

// ================================================================
// Test 3: 归档 / 孤儿 session 正文不可用（getById NOT_FOUND）→ 占位优雅渲染
// ================================================================

test('历史 session 正文不可用（getById NOT_FOUND）：渲染"内容已不可用"占位且不崩 @chat @resilience', async ({ page }) => {
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1280, height: 720 });

	const orphanId = `e2e-orphan-${Date.now()}`;
	const archivedAt = Date.now() - 3_600_000;

	// chatHistory.list 报一个孤儿 session；它的 getById 终态失败（NOT_FOUND）。
	// archivedAt 非空 → 不被 historySessionIds getter 当 live marker 剔除。
	await installRpcMock(page, [
		{ method: 'coclaw.chatHistory.list', resolve: { history: [{ sessionId: orphanId, archivedAt }] } },
		{ method: 'coclaw.sessions.getById', when: { paramKey: 'sessionId', equals: orphanId }, reject: { code: 'NOT_FOUND', message: 'session transcript not found' } },
	]);

	await login(page);
	await ensureRpcMock(page);

	const ctx = await navigateToMainChat(page);
	test.skip(!ctx, 'No chat session available');

	await waitChatReady(page);

	// 等历史列表（被 mock 的孤儿）落定，再加载该段历史 → 终态 NOT_FOUND → 入空段占位
	await expect(async () => {
		const raw = await evalStore(page, 'chat', 'return store.rawHistorySessionIds');
		expect(Array.isArray(raw) && raw.some((h) => h && h.sessionId === orphanId)).toBe(true);
	}).toPass({ timeout: 20_000 });
	// 直接驱动历史加载（避开滚动事件的时序抖动；幂等：autoFill 可能已先加载）
	await evalStore(page, 'chat', 'return store.loadNextHistorySession()');

	// 占位优雅渲染：testid=empty-session，文案为"内容已不可用"
	const placeholder = page.getByTestId('empty-session');
	await expect(placeholder).toBeVisible({ timeout: 15_000 });
	const unavailable = await tr(page, 'chat.historyUnavailable');
	await expect(placeholder).toContainText(unavailable);

	// 未崩溃：页面主体仍健康，输入可用
	await expect(page.getByTestId('chat-root')).toBeVisible();
	await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 10_000 });
});

// ================================================================
// Test 4: 系统块消息（inject / HEARTBEAT_OK / NO_REPLY）正确当系统块渲染
// ================================================================

test('系统块消息：inject / HEARTBEAT_OK / NO_REPLY 渲染为系统块、不报错 @chat @resilience', async ({ page }) => {
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1280, height: 720 });

	const ts = Date.now();
	// 扁平 OC 消息（sessions.get 出参形态，wrapOcMessages 之前）：含 3 类系统块 + 普通对话。
	// 系统块识别（utils/session-msg-group.isSystemAssistantEntry）：
	//   - provider==='openclaw' → inject；整段 'HEARTBEAT_OK' / 'NO_REPLY' → 心跳 / 静默 ack
	const mockMessages = [
		{ role: 'assistant', provider: 'openclaw', model: 'e2e-model', content: [{ type: 'text', text: `injected-note-${ts}` }], stopReason: 'endTurn', timestamp: ts - 5000 },
		{ role: 'user', content: `hello-${ts}`, timestamp: ts - 4000 },
		{ role: 'assistant', content: 'HEARTBEAT_OK', stopReason: 'endTurn', timestamp: ts - 3000 },
		{ role: 'assistant', content: 'NO_REPLY', stopReason: 'endTurn', timestamp: ts - 2000 },
		{ role: 'user', content: `world-${ts}`, timestamp: ts - 1000 },
		{ role: 'assistant', model: 'e2e-model', content: [{ type: 'text', text: `real-answer-${ts}` }], stopReason: 'endTurn', timestamp: ts },
	];

	await installRpcMock(page, [
		{ method: 'sessions.get', resolve: { messages: mockMessages } },
		// 历史列表留空，避免真实孤儿历史的 autoFill 干扰断言计数
		{ method: 'coclaw.chatHistory.list', resolve: { history: [] } },
	]);

	await login(page);
	await ensureRpcMock(page);

	const ctx = await navigateToMainChat(page);
	test.skip(!ctx, 'No chat session available');

	await waitChatReady(page);

	// 3 条系统块各成一个 systemNote
	await expect(page.getByTestId('system-note')).toHaveCount(3, { timeout: 30_000 });
	// 三类系统块各自带原始文本（inject 带模型徽章）
	await expect(page.getByTestId('system-note').filter({ hasText: `injected-note-${ts}` })).toBeVisible();
	await expect(page.getByTestId('system-note').filter({ hasText: 'HEARTBEAT_OK' })).toBeVisible();
	await expect(page.getByTestId('system-note').filter({ hasText: 'NO_REPLY' })).toBeVisible();

	// 普通对话仍正常渲染为消息项（2 条 user + 1 条 botTask）
	await expect(page.getByTestId('chat-msg-item')).toHaveCount(3, { timeout: 10_000 });

	// 未报错：页面主体健康，输入可用
	await expect(page.getByTestId('chat-root')).toBeVisible();
	await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 10_000 });
});
