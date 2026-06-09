import { expect, test } from '@playwright/test';
import { login, navigateToChat, navigateToMainChat, waitChatReady, waitChatInputStable, typeText } from './helpers.js';

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
	// 故锁定到消息项并用唯一时间戳精确匹配（避开历史/UI 提示串），放宽超时等 accepted
	const sentMsg = msgItems.filter({ hasText: testMsg });
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
	// 两个 agent（main + tester）→ 两个 chat 链接，由 globalSetup 的 ensureNamedAgents 夹具保证
	await expect.poll(async () => links.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

	// 进入第 1 个 session
	const href1 = await links.nth(0).getAttribute('href');
	await links.nth(0).click();
	await page.waitForURL(/\/chat\//, { timeout: 5000 });
	await waitChatReady(page);
	const url1 = page.url();

	// 返回 topics 页
	await page.goto('/topics');
	await page.locator('main a[href*="/chat/"]').first().waitFor({ state: 'visible', timeout: 10_000 });

	// 进入第 2 个 session
	const href2 = await links.nth(1).getAttribute('href');
	// 两个链接指向不同 agent 的 session
	expect(href1).not.toEqual(href2);
	await links.nth(1).click();
	await page.waitForURL(/\/chat\//, { timeout: 5000 });
	await waitChatReady(page);
	const url2 = page.url();

	// URL 应不同
	expect(url1).not.toEqual(url2);

	// 再切回第 1 个 session
	await page.goto('/topics');
	await page.locator('main a[href*="/chat/"]').first().waitFor({ state: 'visible', timeout: 10_000 });
	await links.nth(0).click();
	await page.waitForURL(/\/chat\//, { timeout: 5000 });
	await waitChatReady(page);

	// URL 应与第一次相同
	expect(page.url()).toEqual(url1);
});

// ================================================================
// Test 3: 新建话题（new-topic 入口）
// ================================================================

test('新建话题：从 main session 点击进入新建 topic @chat', async ({ page }) => {
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
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionId = await navigateToChat(page);
	test.skip(!sessionId, 'No chat session available');

	await waitChatReady(page);
	const chatUrl = page.url();

	// 发送一条消息（先等首屏加载/历史风暴落定，避免受控 textarea 丢字符）
	await waitChatInputStable(page);
	await typeText(page.getByTestId('chat-textarea'), `e2e nav test ${Date.now()}`);
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
	await page.getByTestId('btn-send').click();

	// 立即导航离开（不等 claw 回复）
	await page.goto('/topics');
	await page.waitForTimeout(1000);

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
});
