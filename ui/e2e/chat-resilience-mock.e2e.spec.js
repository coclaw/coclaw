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

/**
 * 安装"accepted 后失败"的 agent run mock：合成两阶段 agent RPC——
 * 先调 onAccepted（status:'accepted'）让 __accepted 翻 true，再以业务级失败终态
 * （ok=true + status:'error' + error:<msg>）resolve。链路：__onRpcDone → __endRun(runId,'failed')
 * → runAgent resolve { accepted:true, endReason:'failed', errorMessage } → sendMessage 透出 →
 * ChatPage.__notifyRunFailed → notify.error(chat.errRunFailed)。其余 RPC（sessions.get /
 * chatHistory.list 等）原样透传真实链路。与 installRpcMock 同套路（document_start 急切包裹同一份
 * Vite 缓存模块）。
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} errMsg - 业务失败的原始错误文案（进 toast description）
 */
function installAgentFailMock(page, errMsg) {
	return page.addInitScript((errMsg) => {
		const wrap = (CC) => {
			if (!CC || CC.__agentFailWrapped) return;
			CC.__agentFailWrapped = true;
			const orig = CC.prototype.request;
			CC.prototype.request = function (method, params = {}, options = {}) {
				if (method === 'agent') {
					const runId = (params && params.idempotencyKey) || `e2e-run-${Date.now()}`;
					// 阶段 1：accepted（同步调，抢在终态 resolve 的 .then 之前，确保 registeredRunId 已落）
					if (options && typeof options.onAccepted === 'function') {
						options.onAccepted({ runId, status: 'accepted' });
					}
					// 阶段 2：业务级失败终态（ok=true + status:'error'），略延迟模拟两阶段间隔
					return new Promise((resolve) => {
						setTimeout(() => resolve({ runId, status: 'error', error: errMsg }), 40);
					});
				}
				return orig.call(this, method, params, options);
			};
		};
		window.__agentFailWrap = wrap;
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
	}, errMsg);
}

/** 兜底：导航后再确保一次 agent-fail wrap 生效（幂等） */
async function ensureAgentFailMock(page) {
	await page.evaluate(async () => {
		if (typeof window.__agentFailWrap === 'function') {
			const m = await import('/src/services/claw-connection.js');
			if (m && m.ClawConnection) window.__agentFailWrap(m.ClawConnection);
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

// ================================================================
// Test 5: run accepted 后失败（业务级 status='error'）→ 错误 toast + 发送态恢复
// 覆盖"模型不可用静默失败"这一历史 bug 类：accepted 后失败既不能吞错、也不能卡死发送态。
// ================================================================

test('run accepted 后失败：弹错误 toast 且发送态恢复（不吞错、不卡死） @chat @resilience', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1280, height: 720 });

	// agent RPC 两阶段：accepted → 业务级失败（status='error'）。走真实失败路径而非伪造 toast。
	await installAgentFailMock(page, 'model unavailable: e2e simulated failure');

	await login(page);
	await ensureAgentFailMock(page);

	const ctx = await navigateToMainChat(page);
	test.skip(!ctx, 'No chat session available');
	await waitChatReady(page);
	// 等首屏消息加载完成（textarea 解锁），DC 已就绪，可发送
	await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 30_000 });

	const msg = `run-failed e2e ${Date.now()}`;
	await typeText(page.getByTestId('chat-textarea'), msg);
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
	await page.getByTestId('btn-send').click();

	// (1) 错误 toast 出现（复用 RTC 超时用例的断言机制：exact 避开 aria-live 朗读区）。
	// 标题为 chat.errRunFailed（locale 无关，用运行时 i18n 值断言）。
	await expect(page.getByText(await tr(page, 'chat.errRunFailed'), { exact: true })).toBeVisible({ timeout: 10_000 });

	// (2) 发送态恢复：不卡在"发送中"——stop 按钮消失，输入框重新可用。
	await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 10_000 });
	await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 8000 });
});

// ================================================================
// Test 6: assistant steps（思考过程）展开/折叠渲染
// 注入含 thinking + toolCall + toolResult 三类已实现 step kind 的 botTask，
// 断言折叠行切换后 step 行的出现/消失。toolCall 仅渲染名称 pill（args/配对未实现，不断言）。
// ================================================================

test('assistant steps：thinking / toolCall / toolResult 展开折叠渲染 @chat', async ({ page }) => {
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1280, height: 720 });

	const ts = Date.now();
	// 扁平 OC 消息（sessions.get 出参形态）：user + 一段 botTask（中间 assistant 思考/工具调用 →
	// toolResult → 最终 assistant 文本）。三条 assistant/toolResult 间无 user，归入同一 botTask。
	const mockMessages = [
		{ role: 'user', content: `c3-ask-${ts}`, timestamp: ts - 5000 },
		// 中间 assistant：thinking + tool_use（stopReason=toolUse → 不进 resultText，归入 steps）
		{ role: 'assistant', model: 'e2e-model', stopReason: 'toolUse', timestamp: ts - 4000, content: [
			{ type: 'thinking', thinking: `THINK-${ts}` },
			{ type: 'tool_use', id: 'tu1', name: `readFile-${ts}`, input: { path: '/tmp/x' } },
		] },
		// toolResult：成为 toolResult step
		{ role: 'toolResult', toolCallId: 'tu1', timestamp: ts - 3000, content: [{ type: 'text', text: `RESULT-${ts}` }] },
		// 最终 assistant：text → resultText（结束本 botTask）
		{ role: 'assistant', model: 'e2e-model', stopReason: 'endTurn', timestamp: ts - 2000, content: [{ type: 'text', text: `FINAL-${ts}` }] },
	];

	await installRpcMock(page, [
		{ method: 'sessions.get', resolve: { messages: mockMessages } },
		// 历史列表留空，避免真实孤儿历史的 autoFill 干扰断言
		{ method: 'coclaw.chatHistory.list', resolve: { history: [] } },
	]);

	await login(page);
	await ensureRpcMock(page);

	const ctx = await navigateToMainChat(page);
	test.skip(!ctx, 'No chat session available');
	await waitChatReady(page);

	// 1 条 user + 1 条 botTask
	await expect(page.getByTestId('chat-msg-item')).toHaveCount(2, { timeout: 30_000 });

	// botTask 项：用最终结果 FINAL-<ts>（唯一注入数据）锁定，避开 i18n 文案脆断
	const botItem = page.getByTestId('chat-msg-item').filter({ hasText: `FINAL-${ts}` });
	await expect(botItem).toBeVisible();

	// 折叠态（默认）：step 行未渲染（stepsExpanded=false → v-if 整块不存在）
	await expect(page.getByText(`THINK-${ts}`)).toHaveCount(0);
	await expect(page.getByText(`RESULT-${ts}`)).toHaveCount(0);

	// 折叠行按钮（botTask header 首个 button，无 testid → 取首个 role=button）
	const toggle = botItem.getByRole('button').first();
	await toggle.click();

	// 展开态：三类已实现 step 行各自渲染（断言注入的唯一文本，不断言 toolCall 的 args/配对）
	await expect(botItem.getByText(`THINK-${ts}`)).toBeVisible();
	await expect(botItem.getByText(`readFile-${ts}`)).toBeVisible(); // toolCall 名称 pill（chat.toolCallLabel）
	await expect(botItem.getByText(`RESULT-${ts}`)).toBeVisible();

	// 再次点击折叠：step 行消失
	await toggle.click();
	await expect(page.getByText(`THINK-${ts}`)).toHaveCount(0);
	await expect(page.getByText(`RESULT-${ts}`)).toHaveCount(0);
});
