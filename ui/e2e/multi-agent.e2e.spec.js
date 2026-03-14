import { expect, test } from '@playwright/test';
import { evalStore, login, waitChatReady } from './helpers.js';

/**
 * 多 Agent 支持 E2E 测试
 *
 * 前置条件：
 * - server 运行中，OpenClaw gateway 运行中
 * - test 用户已绑定 bot 且 bot 在线
 * - OpenClaw 配置了至少 2 个 agent（main + tester）
 *
 * 当 bot 离线时（如被 bot-bind-unbind 测试影响），所有测试自动 skip。
 */

// ================================================================
// Helpers
// ================================================================

/**
 * 等待 agents store 加载完毕（至少 2 个 agent）
 * @returns {Promise<boolean>} 成功返回 true，超时返回 false
 */
async function waitAgentsLoaded(page, timeout = 15_000) {
	try {
		await expect(async () => {
			const byBot = await evalStore(page, 'agents', 'return store.byBot');
			const keys = Object.keys(byBot);
			expect(keys.length).toBeGreaterThan(0);
			const entry = byBot[keys[0]];
			expect(entry.fetched).toBe(true);
			expect(entry.agents.length).toBeGreaterThanOrEqual(2);
		}).toPass({ timeout });
		return true;
	}
	catch {
		return false;
	}
}

/** 等待 sessions store 加载完毕且有数据 */
async function waitSessionsLoaded(page, timeout = 15_000) {
	await expect(async () => {
		const items = await evalStore(page, 'sessions', 'return store.items');
		expect(items.length).toBeGreaterThan(0);
	}).toPass({ timeout });
}

/** 等待 tester agent 链接在 DOM 中可见 */
async function waitTesterAgentLink(page, timeout = 10_000) {
	const link = page.locator('main nav').first().locator('a[href*="/chat/"]').filter({ hasText: '压测锤' });
	await link.waitFor({ state: 'visible', timeout });
	return link;
}

/** 通用前置：登录 + 导航 + 等待 agents（失败时 skip） */
async function setupWithAgents(page, test, route = '/topics') {
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);
	await page.goto(route);
	const loaded = await waitAgentsLoaded(page);
	test.skip(!loaded, 'Bot offline or agents not available (< 2 agents)');
}

// ================================================================
// Test 1: Topics 页 Agent 列表展示
// ================================================================

test('Topics 页：Agent 列表展示多个 agent', async ({ page }) => {
	test.setTimeout(30_000);
	await setupWithAgents(page, test);

	// agent 列表区域应有至少 2 个 agent + "添加 Claw" 入口
	const agentLinks = page.locator('main nav').first().locator('[role="listitem"]');
	await expect(agentLinks).toHaveCount(3, { timeout: 10_000 });

	// 验证 agent 名称可见
	await expect(page.locator('main').getByText('小点')).toBeVisible({ timeout: 5000 });
	await expect(page.locator('main').getByText('压测锤')).toBeVisible({ timeout: 5000 });
});

// ================================================================
// Test 2: Agent emoji/avatar 渲染
// ================================================================

test('Topics 页：Agent emoji 正确渲染', async ({ page }) => {
	test.setTimeout(30_000);
	await setupWithAgents(page, test);

	// tester agent 应显示 🔨 emoji
	await expect(page.locator('main').getByText('🔨')).toBeVisible({ timeout: 5000 });
});

// ================================================================
// Test 3: 点击 Agent 导航到对应 session
// ================================================================

test('Topics 页：点击 Agent 进入对应 chat session', async ({ page }) => {
	test.setTimeout(30_000);
	await setupWithAgents(page, test);

	// 点击第一个 agent（默认 agent）进入 chat
	const firstAgentLink = page.locator('main nav').first().locator('a[href*="/chat/"]').first();
	await expect(firstAgentLink).toBeVisible({ timeout: 5000 });
	await firstAgentLink.click();
	await expect(page).toHaveURL(/\/chat\//, { timeout: 5000 });
	await waitChatReady(page);
});

// ================================================================
// Test 4: 非 main agent 的 session 可正常加载
// ================================================================

test('非 main agent (tester) 的 session 可正常加载消息', async ({ page }) => {
	test.setTimeout(30_000);
	await setupWithAgents(page, test);

	let testerLink;
	try {
		testerLink = await waitTesterAgentLink(page);
	}
	catch {
		test.skip(true, 'Tester agent link not visible');
		return;
	}

	await testerLink.click();
	await expect(page).toHaveURL(/\/chat\//, { timeout: 5000 });
	await waitChatReady(page);

	// chat 页面应正常加载（无错误提示）
	const errorText = await page.locator('[data-testid="chat-root"]').locator('.text-error').isVisible().catch(() => false);
	expect(errorText).toBe(false);
});

// ================================================================
// Test 5: ManageBots 页展示 Agent 列表
// ================================================================

test('ManageBots 页：Claw 卡片内显示 Agent 列表', async ({ page }) => {
	test.setTimeout(30_000);
	await setupWithAgents(page, test, '/bots');
	await expect(page.getByTestId('btn-refresh-bots')).toBeVisible({ timeout: 10_000 });
	await waitSessionsLoaded(page);

	// Claw 卡片内 agent 区域应有 agent 名称
	await expect(page.locator('main').getByText('压测锤')).toBeVisible({ timeout: 5000 });

	// 每个 agent 应有"对话"按钮
	const chatButtons = page.locator('main').getByText('对话');
	await expect(chatButtons).toHaveCount(2, { timeout: 5000 });
});

// ================================================================
// Test 6: ManageBots 页 Agent "对话"按钮导航
// ================================================================

test('ManageBots 页：点击 Agent 对话按钮进入 chat', async ({ page }) => {
	test.setTimeout(30_000);
	await setupWithAgents(page, test, '/bots');
	await expect(page.getByTestId('btn-refresh-bots')).toBeVisible({ timeout: 10_000 });
	await waitSessionsLoaded(page);

	// 点击第一个"对话"按钮
	const chatBtn = page.locator('main').getByText('对话').first();
	await expect(chatBtn).toBeEnabled({ timeout: 5000 });
	await chatBtn.click();

	await expect(page).toHaveURL(/\/chat\//, { timeout: 10_000 });
	await waitChatReady(page);
});

// ================================================================
// Test 7: Session 列表中 agent emoji 展示
// ================================================================

test('Topics 页：Session 列表中显示对应 agent 的 emoji', async ({ page }) => {
	test.setTimeout(30_000);
	await setupWithAgents(page, test);

	// 等待 session 列表加载
	await expect(page.locator('main a[href*="/topics/"]').first()).toBeVisible({ timeout: 10_000 });

	// tester agent 的 session 应显示 🔨 emoji
	const testerSession = page.locator('main a[href*="/topics/"]').filter({ hasText: '🔨' });
	const hasEmoji = await testerSession.count();
	expect(hasEmoji).toBeGreaterThanOrEqual(1);
});

// ================================================================
// Test 8: 新建聊天按钮在非 main agent 的 main session 上也可用
// ================================================================

test('非 main agent 的 main session 也显示新建聊天按钮', async ({ page }) => {
	test.setTimeout(30_000);
	await setupWithAgents(page, test);

	let testerLink;
	try {
		testerLink = await waitTesterAgentLink(page);
	}
	catch {
		test.skip(true, 'Tester agent link not visible');
		return;
	}

	await testerLink.click();
	await expect(page).toHaveURL(/\/chat\//, { timeout: 5000 });
	await waitChatReady(page);

	// isMainSession 对 agent:tester:main 也应为 true → 新建聊天按钮可见
	// 桌面视口下：mobile header 的按钮 md:hidden，桌面 header 的按钮 hidden md:flex → 取 last
	const newChatBtn = page.getByTestId('btn-new-chat').last();
	await expect(newChatBtn).toBeVisible({ timeout: 5000 });
});

// ================================================================
// Test 9: HomePage 智能跳转到默认 agent
// ================================================================

test('HomePage：桌面端自动跳转到默认 agent 的 main session', async ({ page }) => {
	test.setTimeout(30_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	// 先验证 bot 在线
	await page.goto('/topics');
	const loaded = await waitAgentsLoaded(page);
	test.skip(!loaded, 'Bot offline or agents not available');

	await page.goto('/home');

	// 应跳转到 chat 页面（默认 agent 的 main session）
	await expect(page).toHaveURL(/\/chat\//, { timeout: 15_000 });
	await waitChatReady(page);

	// 验证是 main agent 的 session
	const sessionKey = await evalStore(page, 'chat', 'return store.currentSessionKey');
	expect(sessionKey).toMatch(/^agent:main:main$/);
});
