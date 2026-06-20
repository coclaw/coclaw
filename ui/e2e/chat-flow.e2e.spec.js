import { expect, test } from '@playwright/test';
import { login, navigateToChat, navigateToMainChat, waitChatReady, waitChatInputStable, typeText, evalStore } from './helpers.js';

/**
 * 聊天核心流程 E2E 测试
 *
 * 前置条件：
 * - server 运行中
 * - test 用户已有至少一个 online claw（已绑定且 OpenClaw gateway 运行中）
 * - 存在 agent:main:main session
 */

// ================================================================
// Test 1: 基础聊天流程
// ================================================================

test('基础聊天：发送消息并收到 claw 回复 @chat', async ({ page }) => {
	test.setTimeout(240_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionId = await navigateToChat(page);
	test.skip(!sessionId, 'No chat session available (no claw online)');

	await waitChatReady(page);

	// 记录当前消息数量（用稳定的 chat-msg-item testid，避免依赖 Tailwind 类）
	const msgItems = page.locator('[data-testid="chat-msg-item"]');
	const msgCountBefore = await msgItems.count();

	// 输入并发送消息（先等首屏加载/历史风暴落定，避免受控 textarea 丢字符）
	await waitChatInputStable(page);
	const testMsg = `e2e test ${Date.now()}`;
	await typeText(page.getByTestId('chat-textarea'), testMsg);
	// 确认整串已落入 textarea（v-model 同步完成）再发送，避免尾字符竞态
	await expect(page.getByTestId('chat-textarea')).toHaveValue(testMsg, { timeout: 3000 });
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
	await page.getByTestId('btn-send').click();

	// 验证：user 消息出现。乐观消息 pending 态仅显示"发送中"，accepted 后才渲染正文，
	// 故锁定到消息项并用唯一时间戳精确匹配（避开历史/UI 提示串），放宽超时等 accepted。
	// .first() 取用户气泡：真实 agent 偶尔在回复正文里回显含时间戳的原文，会同时命中
	// 用户气泡 + agent 回复两处，不加 .first() 触发 strict-mode 违例脆断。
	const sentMsg = msgItems.filter({ hasText: testMsg }).first();
	await expect(sentMsg).toBeVisible({ timeout: 30_000 });

	// 验证：claw 回复完成（streaming 结束后 sending 状态结束、btn-stop 消失）
	// 发送后输入框被清空、canSend=false，btn-send 不渲染，必须等 btn-stop 消失判定完成
	// claw 回复时间视模型和 prompt 复杂度而定，给足 3 分钟
	await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });

	// 验证消息数增加
	const msgCountAfter = await msgItems.count();
	expect(msgCountAfter).toBeGreaterThan(msgCountBefore);
});

// ================================================================
// Test 2: Session 切换
// ================================================================

test('Session 切换：不同 session 显示各自的消息 @chat', async ({ page }) => {
	// 本用例依赖多处 45s 等待（topics 链接渲染 + waitChatReady + waitChatInputStable），
	// 单测 30s 上限会先于这些内部预算触发、令其全部失效（round-1 把 nth(1) 抬到 45s 的
	// 修复在 30s 上限下是死代码）。叠加给 session A 发一条真实标记消息（验 per-session
	// 渲染），故抬到 150s 留足冷启动余量；只等用户气泡落地，不等完整回复。
	test.setTimeout(150_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);
	await page.goto('/topics');

	// 需要至少 2 个 chat link（agent 或 session）
	const chatLink = page.locator('main a[href*="/chat/"]').first();
	try {
		await chatLink.waitFor({ state: 'visible', timeout: 10_000 });
	}
	catch {
		test.skip(true, 'No chat sessions available (claw offline?)');
	}
	const links = page.locator('main a[href*="/chat/"]');
	// 两个 agent（main + tester）→ 两个 chat 链接，由 globalSetup 的 ensureNamedAgents 夹具保证。
	// 预算放宽到 45s：满负载（整套 189 用例、1 worker、背靠背）下 topics 第 2 个 agent 链接
	// 渲染慢于默认窗口，10s 偶被突破致 flaky；只抬时间预算，不放松数量判定本身。
	await expect.poll(async () => links.count(), { timeout: 45_000 }).toBeGreaterThanOrEqual(2);

	// 消息项定位器（用稳定 testid，避免依赖 Tailwind 类）
	const msgItems = page.locator('[data-testid="chat-msg-item"]');

	// 进入第 1 个 session A（取 href 前显式等链接可见，满负载下吸收渲染抖动）
	await expect(links.nth(0)).toBeVisible({ timeout: 45_000 });
	const href1 = await links.nth(0).getAttribute('href');
	await links.nth(0).click();
	await page.waitForURL(/\/chat\//, { timeout: 5000 });
	await waitChatReady(page);
	const url1 = page.url();

	// 在 session A 发一条唯一标记消息，作为"每个 session 渲染自己消息"的探针。
	// 为何用真实发送而非注入乐观消息：注入的 _local 消息无法跨"离开 A → 回到 A"的往返存活
	// （重入 A 触发静默 loadMessages，被服务端快照覆盖，标记消失）；真实发送会被服务端持久化，
	// 回到 A 时由 sessions.get 拉回稳定渲染。此处只等用户气泡落地、不等完整 agent 回复（回复
	// 在后台进行），把 LLM 等待成本压到最低，同时换得确定的 per-session 渲染验证：
	// B 的视图绑定 B 自己的 store，绝不应渲染 A 的标记。
	await waitChatInputStable(page);
	const tag = `e2e session-switch ${Date.now()}`;
	await typeText(page.getByTestId('chat-textarea'), tag);
	await expect(page.getByTestId('chat-textarea')).toHaveValue(tag, { timeout: 3000 });
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
	await page.getByTestId('btn-send').click();
	// 标记消息在 A 中渲染（accepted 后渲染正文；.first() 防 agent 回显时 strict-mode 脆断）
	await expect(msgItems.filter({ hasText: tag }).first()).toBeVisible({ timeout: 30_000 });

	// 返回 topics 页
	await page.goto('/topics');
	await page.locator('main a[href*="/chat/"]').first().waitFor({ state: 'visible', timeout: 45_000 });

	// 进入第 2 个 session B（取 href 前显式等第 2 个链接可见——满负载下重渲染后第 2 个
	// agent 链接慢于默认 30s 隐式窗口，是本用例 flaky 的根因；放宽到 45s 吸收抖动）
	await expect(links.nth(1)).toBeVisible({ timeout: 45_000 });
	const href2 = await links.nth(1).getAttribute('href');
	// 两个链接指向不同 agent 的 session
	expect(href1).not.toEqual(href2);
	await links.nth(1).click();
	await page.waitForURL(/\/chat\//, { timeout: 5000 });
	await waitChatReady(page);
	const url2 = page.url();

	// URL 应不同
	expect(url1).not.toEqual(url2);

	// 核心断言：session B 不应显示 session A 的消息（content-bleed / stale-on-switch 守卫）。
	// chatMessages 是按路由派生 chatStore 的 computed；若切换时未正确重绑到 B 的 store，
	// A 的标记消息会泄漏到 B 的 DOM——此处直接捕获该回归。B 的服务端历史绝无可能含 A 的
	// 唯一时间戳标记，故 toHaveCount(0) 仅在渲染绑定正确时成立。
	await expect(msgItems.filter({ hasText: tag })).toHaveCount(0, { timeout: 8000 });

	// 再切回第 1 个 session A
	await page.goto('/topics');
	await page.locator('main a[href*="/chat/"]').first().waitFor({ state: 'visible', timeout: 45_000 });
	await expect(links.nth(0)).toBeVisible({ timeout: 45_000 });
	await links.nth(0).click();
	await page.waitForURL(/\/chat\//, { timeout: 5000 });
	await waitChatReady(page);

	// URL 应与第一次相同
	expect(page.url()).toEqual(url1);

	// session A 应再次渲染它自己的标记消息（已服务端持久化，重入 A 时 sessions.get 拉回）——
	// 正向对照，证明上面 B 的"缺失"是真·内容隔离，而非标记本身不可检测
	await expect(msgItems.filter({ hasText: tag }).first()).toBeVisible({ timeout: 15_000 });
});

// ================================================================
// Test 3: 新建话题（new-topic 入口）
// ================================================================

test('新建话题：从 main session 点击进入新建 topic @chat', async ({ page }) => {
	// login + navigateToMainChat + waitChatReady（调用两次：进入 main + 点新建后）
	// 最坏情况累计 ~70–80s，超过单测 30s 上限。原 60s 仍偏紧（两次 waitChatReady
	// 满负载下各占预算）→ 抬到 90s 给登录/导航/两段就绪链留足余量。
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);

	// "新建话题"按钮仅在 main agent（或 topic 路由）显示，故确定性落在 main session
	const session = await navigateToMainChat(page);
	test.skip(!session, 'No chat session available');

	await waitChatReady(page);

	// 移动视口下用 btn-new-topic-mobile（旧的 btn-new-chat 已不存在）
	const newTopicBtn = page.getByTestId('btn-new-topic-mobile');
	await expect(newTopicBtn).toBeVisible({ timeout: 5000 });

	const urlBefore = page.url();
	await newTopicBtn.click();

	// 跳转到新建 topic 路由（/topics/new），URL 应改变
	await expect(page).toHaveURL(/\/topics\/new(\?|$)/, { timeout: 10_000 });
	expect(page.url()).not.toEqual(urlBefore);
	await waitChatReady(page);

	// 新建 topic 模式下消息列表为空（用稳定的 chat-msg-item testid，避免依赖 Tailwind 类）
	await expect(page.getByTestId('chat-msg-item')).toHaveCount(0);
});

// ================================================================
// Test 4: 发送后立即离开再返回
// ================================================================

test('发送后离开再返回：页面状态正常 @chat', async ({ page }) => {
	// waitChatInputStable(~45s) + btn-stop 消失等待(60s) 在冷首发时可超过 90s；抬到 150s。
	test.setTimeout(150_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionId = await navigateToChat(page);
	test.skip(!sessionId, 'No chat session available');

	await waitChatReady(page);
	const chatUrl = page.url();

	// 发送一条唯一标记消息（先等首屏加载/历史风暴落定，避免受控 textarea 丢字符）
	await waitChatInputStable(page);
	const navMsg = `e2e nav test ${Date.now()}`;
	const msgItems = page.locator('[data-testid="chat-msg-item"]');
	await typeText(page.getByTestId('chat-textarea'), navMsg);
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
	await page.getByTestId('btn-send').click();

	// 导航前确定性等待：用户气泡渲染正文（accepted 后才渲染，pending 态仅显示"发送中"）
	// = 发送已被服务端接受/持久化。原先用固定 1s sleep（且在 goto 之后）不保证发送已落地，
	// 偶发"离开→返回"时消息尚未持久化致末尾断言(navMsg 气泡存活)RED。换成等气泡可见后再离开。
	// .first() 防 agent 偶尔在回复正文里回显原文导致 strict-mode 脆断。
	await expect(msgItems.filter({ hasText: navMsg }).first()).toBeVisible({ timeout: 30_000 });

	// 立即导航离开（不等 claw 回复）
	await page.goto('/topics');

	// 返回原 chat 页
	await page.goto(chatUrl);
	await waitChatReady(page);

	// 验证页面状态正常：
	// 1. chat-root 可见
	await expect(page.getByTestId('chat-root')).toBeVisible();
	// 2. 不处于 sending 状态（btn-stop 消失），等待可能的 streaming 完成
	//    返回后输入框为空、canSend=false，btn-send 不渲染，故以 btn-stop 消失判定
	await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 60_000 });
	// 3. textarea 可用
	await expect(page.getByTestId('chat-textarea')).toBeEnabled();
	// 4. 发出的消息跨"离开 → 返回"导航存活：run 结束后用户消息已服务端持久化，返回时
	//    silent reload 应把它拉回并渲染。仅断言脚手架可见会漏掉"导航后消息丢失"的回归，
	//    故显式核验唯一标记气泡仍在消息列表中（.first() 防 agent 回显时 strict-mode 脆断）。
	await expect(msgItems.filter({ hasText: navMsg }).first()).toBeVisible({ timeout: 15_000 });
});

// ================================================================
// Test 5: 多轮真实对话（同 session 连续两轮）
// ================================================================

test('多轮真实对话：两轮 user+assistant 气泡按序且滚动保持底部 @chat', async ({ page }) => {
	// 两轮真实回复（各给 180s 安全窗）+ 登录/导航/就绪链，累计可观，给足 240s。
	test.setTimeout(240_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const session = await navigateToChat(page);
	test.skip(!session, 'No chat session available (no claw online)');

	await waitChatReady(page);

	const msgItems = page.locator('[data-testid="chat-msg-item"]');
	await waitChatInputStable(page);

	// 第 1 轮
	const msg1 = `e2e multiturn-1 ${Date.now()}`;
	await typeText(page.getByTestId('chat-textarea'), msg1);
	await expect(page.getByTestId('chat-textarea')).toHaveValue(msg1, { timeout: 3000 });
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
	await page.getByTestId('btn-send').click();
	// 用户气泡 accepted 后渲染正文（.first() 防 agent 回显原文时 strict-mode 脆断）
	await expect(msgItems.filter({ hasText: msg1 }).first()).toBeVisible({ timeout: 30_000 });
	// 第 1 条真回复完成：btn-stop 消失（真回复慢，给 180s 安全窗；不等 btn-send 出现）
	await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });

	// 第 2 轮（同 session，输入框回稳后再打字）
	await waitChatInputStable(page);
	const msg2 = `e2e multiturn-2 ${Date.now()}`;
	await typeText(page.getByTestId('chat-textarea'), msg2);
	await expect(page.getByTestId('chat-textarea')).toHaveValue(msg2, { timeout: 3000 });
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
	await page.getByTestId('btn-send').click();
	await expect(msgItems.filter({ hasText: msg2 }).first()).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });

	// —— 实时断言（不重载）：两轮用户气泡按序 + 滚动保持底部 ——
	// 两条 user 气泡都在（用户消息 accepted 即可靠渲染，不受回复落库时机影响）
	const userMsg1 = msgItems.filter({ hasText: msg1 }).first();
	const userMsg2 = msgItems.filter({ hasText: msg2 }).first();
	await expect(userMsg1).toBeVisible();
	await expect(userMsg2).toBeVisible();

	// 顺序：第 1 轮用户气泡在第 2 轮之上（按 DOM 纵坐标，滚出视口仍有 box）
	const box1 = await userMsg1.boundingBox();
	const box2 = await userMsg2.boundingBox();
	expect(box1).not.toBeNull();
	expect(box2).not.toBeNull();
	expect(box1.y).toBeLessThan(box2.y);

	// 滚动保持底部：新消息落地后视图应在底部，「回到底部」指示按钮不出现（farFromBottom=false）。
	// 必须在重载前断言——重载会把滚动重置到底部，事后断言无意义。
	await expect(page.getByTestId('btn-back-to-bottom')).not.toBeVisible();

	// —— 两条 assistant 回复的存在性走"重载后查 store" ——
	// 为何不在实时态数 assistant 气泡：run 结束时先 loadMessages 再 dropRun 释放 streamingMsgs，
	// 若该次 load 抢在服务端落库回复之前完成，回复会瞬时从视图消失且无补拉（实测偶发），实时计数
	// 不可靠。回复确会持久化到服务端（session 跨 run 持续增长可证），整页重载能确定性拉回。
	// 同时回避分页：主 session 残留可能超过单页 50 条，绝对计数会被 slice(-50) 截断，故用
	// "从 msg1 起 user===2 且 assistant>=2" 的相对判定（msg1 及其后恒在最近一页窗口内）。
	await page.reload();
	await waitChatReady(page);
	await waitChatInputStable(page);
	await expect(msgItems.filter({ hasText: msg1 }).first()).toBeVisible({ timeout: 8000 });
	const turnsProbe = `
		const txt = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text || '').join('') : '';
		const msg1 = ${JSON.stringify(msg1)};
		const i = store.messages.findIndex((m) => m.message?.role === 'user' && txt(m.message?.content).includes(msg1));
		if (i < 0) return 'no-msg1';
		const after = store.messages.slice(i);
		const users = after.filter((m) => m.message?.role === 'user').length;
		const assistants = after.filter((m) => m.message?.role === 'assistant').length;
		return (users === 2 && assistants >= 2) ? 'ok' : ('users=' + users + ' assistants=' + assistants);
	`;
	await expect.poll(async () => evalStore(page, 'chat', turnsProbe), { timeout: 20_000 }).toBe('ok');
});

// ================================================================
// Test 6: 回复落回正确会话（防双气泡 / 孤儿回复回归）
// ================================================================

test('回复落回正确会话：A 发送回复留在 A 不泄漏到 B @chat', async ({ page }) => {
	// 真回复 + A↔B 多次往返导航，给足 240s。
	test.setTimeout(240_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);
	await page.goto('/topics');

	const firstLink = page.locator('main a[href*="/chat/"]').first();
	try {
		await firstLink.waitFor({ state: 'visible', timeout: 10_000 });
	}
	catch {
		test.skip(true, 'No chat sessions available (claw offline?)');
	}

	const links = page.locator('main a[href*="/chat/"]');
	// 需要两个不同 agent 的 chat 链接（由 globalSetup 的 ensureNamedAgents 夹具保证）。
	// 满负载下第 2 个链接渲染慢，预算放宽到 45s 吸收抖动（同本文件 Test 2 的口径）。
	await expect.poll(async () => links.count(), { timeout: 45_000 }).toBeGreaterThanOrEqual(2);

	await expect(links.nth(0)).toBeVisible({ timeout: 45_000 });
	await expect(links.nth(1)).toBeVisible({ timeout: 45_000 });
	const hrefA = await links.nth(0).getAttribute('href');
	const hrefB = await links.nth(1).getAttribute('href');
	expect(hrefA).not.toEqual(hrefB);

	const msgItems = page.locator('[data-testid="chat-msg-item"]');

	// 先进 B 记录干净基线（在 A 发送之前）——作为"回复未泄漏到 B"的对照。
	// 用 toHaveCount 锁基线是确定性 oracle：B 是另一 agent 的 session，本用例期间无独立活动，
	// 故回复若错误地多塞气泡到 B，计数会偏离基线被立即捕获。
	await page.goto(hrefB);
	await waitChatReady(page);
	await waitChatInputStable(page);
	const urlB = page.url();
	const bCountBefore = await msgItems.count();

	// 进 A
	await page.goto(hrefA);
	await waitChatReady(page);
	await waitChatInputStable(page);
	const urlA = page.url();
	expect(urlA).not.toEqual(urlB);

	// 在 A 发送唯一标记消息（触发真实 agent 回复），并在 A 等回复完成。
	// 为何"留在 A 等回复完成"而非"在飞时切走"：page.goto 是整页重载、会摧毁发起 run 的
	// 页面上下文——重载后的新 A 上下文不再追踪旧 run（btn-stop 不复现），无法确定性观察。
	// 回复落回 A 的最终判定放在下方"回到 A"那段：整页重载会确定性地从服务端拉回已持久化的
	// 回复，回避"留在页面时回复入 store 的时机赛跑"（run 结束后仅一次 silent reload，
	// 若抢在服务端落库前完成则该轮不再补拉，DOM 计数偶发只 +1）。
	const prompt = `e2e session-route ${Date.now()}`;
	await typeText(page.getByTestId('chat-textarea'), prompt);
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
	await page.getByTestId('btn-send').click();
	// 用户气泡 accepted 后渲染正文（.first() 防 agent 回显原文时 strict-mode 脆断）
	await expect(msgItems.filter({ hasText: prompt }).first()).toBeVisible({ timeout: 30_000 });
	// 等真回复完成：btn-stop 消失（真回复慢给 180s 安全窗；run 结束即服务端落库回复）
	await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });

	// 切到 B
	await page.goto(urlB);
	await waitChatReady(page);
	await waitChatInputStable(page);
	// 核心断言①：A 的用户消息绝不泄漏到 B（内容隔离）
	await expect(msgItems.filter({ hasText: prompt })).toHaveCount(0, { timeout: 8000 });
	// 核心断言②：A 的回复也不在 B 凭空多出气泡（防孤儿回复）——B 计数维持基线。
	// B 是另一 agent 的 session、本用例期间无独立活动，整页重载只是按 slice(-50) 拉回同一份
	// 持久化历史，故计数对分页免疫、恒等于基线。
	await expect(msgItems).toHaveCount(bCountBefore, { timeout: 8000 });
	// B 不应处于 sending（A 的 run 绝不能在 B 显示为在飞）
	await expect(page.getByTestId('btn-stop')).not.toBeVisible();

	// 回到 A：整页重载触发 loadMessages 重对账——回复应原样还在，且不重复。
	await page.goto(urlA);
	await waitChatReady(page);
	await waitChatInputStable(page);
	// 核心断言③：用户消息仍可见（重载后从服务端拉回渲染）
	await expect(msgItems.filter({ hasText: prompt }).first()).toBeVisible({ timeout: 8000 });
	// 核心断言④：恰有一条该 prompt 的 user 消息（无重复），且其后有 assistant 回复（回复落回 A 且存活）。
	// 走 store 判定而非 DOM 计数：主 session 残留可能超过单页 50 条，整页重载后 DOM 总数受
	// slice(-50) 分页影响；而"我的 user 消息及其回复"恒在最近一页窗口内，store 判定与分页无关，
	// 也不受 agent 偶尔回显原文（那是 assistant 角色、不计入 user 过滤）干扰。
	const replyProbe = `
		const txt = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text || '').join('') : '';
		const prompt = ${JSON.stringify(prompt)};
		const users = store.messages.filter((m) => m.message?.role === 'user' && txt(m.message?.content).includes(prompt));
		if (users.length !== 1) return 'user-count:' + users.length;
		const i = store.messages.indexOf(users[0]);
		return store.messages.slice(i + 1).some((m) => m.message?.role === 'assistant') ? 'ok' : 'no-reply';
	`;
	await expect.poll(async () => evalStore(page, 'chat', replyProbe), { timeout: 10_000 }).toBe('ok');
	// 核心断言⑤：无残留流式气泡（防双气泡：chat.history 失败遗留的 streamingMsgs 会经 allMessages
	// 合并显示，使渲染列表比已持久化的 messages 多出条目）。差值为 0 = 无孤儿流式残留。
	await expect.poll(
		async () => evalStore(page, 'chat', 'return store.allMessages.length - store.messages.length'),
		{ timeout: 8000 },
	).toBe(0);

	// 再切回 B：回复事后也不应回灌到 B
	await page.goto(urlB);
	await waitChatReady(page);
	await waitChatInputStable(page);
	await expect(msgItems.filter({ hasText: prompt })).toHaveCount(0, { timeout: 8000 });
	await expect(msgItems).toHaveCount(bCountBefore, { timeout: 8000 });
});
