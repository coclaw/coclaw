import { expect, test } from '@playwright/test';
import { evalStore, login, typeText, waitChatReady } from './helpers.js';

/**
 * 多 Agent 支持 E2E 测试
 *
 * 前置条件：
 * - server 运行中，OpenClaw gateway 运行中
 * - test 用户已绑定 claw 且 claw 在线
 * - OpenClaw 配置了至少 2 个 agent（main + tester）
 *
 * 当 claw 离线时（如被 claw-bind-unbind 测试影响），所有测试自动 skip。
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
			const byClaw = await evalStore(page, 'agents', 'return store.byClaw');
			const keys = Object.keys(byClaw);
			expect(keys.length).toBeGreaterThan(0);
			const entry = byClaw[keys[0]];
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

/**
 * 定位 agent 列表（main 区第一个 nav）中指定 agentId 的链接。
 * 按 href 末段的 agent id 定位（chat 路由为 /chat/<clawId>/<agentId>），
 * 与显示名/locale 无关——避免依赖可翻译文案。
 * @param {import('@playwright/test').Page} page
 * @param {string} agentId - 'main' | 'tester' 等
 */
function agentLink(page, agentId) {
	return page.locator('main nav').first().locator(`a[href$="/${agentId}"]`);
}

/** 等待 tester agent 链接可见（按 href id 定位，不依赖显示名/文案） */
async function waitTesterAgentLink(page, timeout = 10_000) {
	const link = agentLink(page, 'tester');
	await link.waitFor({ state: 'visible', timeout });
	return link;
}

/**
 * 断言 agent 列表同时含 main 与 tester（按 href id，locale/文案无关）。
 * 这两个 agent 由 globalSetup 的 ensureNamedAgents 夹具保证存在，故为硬断言而非 skip。
 * @param {import('@playwright/test').Page} page
 */
async function expectMainAndTester(page) {
	await expect(agentLink(page, 'main')).toBeVisible({ timeout: 5000 });
	await expect(agentLink(page, 'tester')).toBeVisible({ timeout: 5000 });
}

/** 通用前置：登录 + 导航 + 等待 agents（失败时 skip） */
async function setupWithAgents(page, test, route = '/topics') {
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);
	await page.goto(route);
	const loaded = await waitAgentsLoaded(page);
	test.skip(!loaded, 'Claw offline or agents not available (< 2 agents)');
}

// ================================================================
// Test 1: Topics 页 Agent 列表展示
// ================================================================

test('Topics 页：Agent 列表展示多个 agent @chat', async ({ page }) => {
	test.setTimeout(30_000);
	await setupWithAgents(page, test);

	// agent 列表区域应至少有 2 个 agent（真实环境 agent 数量不定，断言下限即可）
	const agentLinks = page.locator('main nav').first().locator('[role="listitem"]');
	await expect.poll(async () => agentLinks.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

	// 按 href 中的 agent id 断言 main 与 tester 均在列（locale/文案无关）
	await expectMainAndTester(page);
});

// ================================================================
// Test 2: Agent emoji/avatar 渲染
// ================================================================

test('Topics 页：Agent emoji 正确渲染 @chat', async ({ page }) => {
	test.setTimeout(30_000);
	await setupWithAgents(page, test);

	// tester agent 行（按 href id 定位）应渲染其身份 emoji 🔨。
	// emoji 不可翻译 → locale 无关断言的唯一例外（“难度除外”）。tester 无 avatar，故 emoji span 必显示。
	const testerLink = agentLink(page, 'tester');
	await expect(testerLink).toBeVisible({ timeout: 5000 });
	await expect(testerLink).toContainText('🔨');
});

// ================================================================
// Test 3: 点击 Agent 导航到对应 session
// ================================================================

test('Topics 页：点击 Agent 进入对应 chat session @chat', async ({ page }) => {
	test.setTimeout(30_000);
	await setupWithAgents(page, test);

	// 点击 main agent（按 href id 定位）进入其 chat session
	const mainLink = agentLink(page, 'main');
	await expect(mainLink).toBeVisible({ timeout: 5000 });
	await mainLink.click();
	await expect(page).toHaveURL(/\/chat\/[^/]+\/main$/, { timeout: 5000 });
	await waitChatReady(page);
});

// ================================================================
// Test 4: 非 main agent 的 session 可正常加载
// ================================================================

test('非 main agent (tester) 的 session 可正常加载消息 @chat', async ({ page }) => {
	test.setTimeout(30_000);
	await setupWithAgents(page, test);

	// 按 href id 定位 tester agent 链接并进入其 session
	const testerLink = await waitTesterAgentLink(page);
	await testerLink.click();
	await expect(page).toHaveURL(/\/chat\/[^/]+\/tester$/, { timeout: 5000 });
	await waitChatReady(page);

	// chat 页面应正常加载（无错误提示）。.text-error 是类名（非文案），locale 无关。
	const errorVisible = await page.locator('[data-testid="chat-root"]').locator('.text-error').isVisible().catch(() => false);
	expect(errorVisible).toBe(false);
});

// ================================================================
// Test 5: ManageClaws 页展示 Agent 列表
// ================================================================

test('ManageClaws 页：Claw 卡片内显示 Agent 列表 @chat', async ({ page }) => {
	test.setTimeout(30_000);
	await setupWithAgents(page, test, '/claws');
	await expect(page.getByTestId('btn-refresh-claws')).toBeVisible({ timeout: 10_000 });
	await waitSessionsLoaded(page);

	// tester 的 agent 卡片应存在（按 agent id 定位 testid，locale/文案无关）
	await expect(page.getByTestId('agent-card-tester')).toBeVisible({ timeout: 5000 });

	// 在线 agent 各有"对话"按钮（btn-chat，locale 无关）；main + tester 至少 2 个
	const chatButtons = page.locator('main').getByTestId('btn-chat');
	await expect.poll(async () => chatButtons.count(), { timeout: 5000 }).toBeGreaterThanOrEqual(2);
});

// ================================================================
// Test 6: ManageClaws 页 Agent "对话"按钮导航
// ================================================================

test('ManageClaws 页：点击 Agent 对话按钮进入 chat @chat', async ({ page }) => {
	test.setTimeout(30_000);
	await setupWithAgents(page, test, '/claws');
	await expect(page.getByTestId('btn-refresh-claws')).toBeVisible({ timeout: 10_000 });
	await waitSessionsLoaded(page);

	// 点击第一个"对话"按钮（btn-chat，locale 无关）
	const chatBtn = page.locator('main').getByTestId('btn-chat').first();
	await expect(chatBtn).toBeEnabled({ timeout: 5000 });
	await chatBtn.click();

	await expect(page).toHaveURL(/\/chat\//, { timeout: 10_000 });
	await waitChatReady(page);
});

// ================================================================
// Test 7: Session 列表中 agent emoji 展示
// ================================================================

test('Topics 页：Session 列表中显示对应 agent 的 emoji @chat', async ({ page }) => {
	test.setTimeout(120_000);
	await setupWithAgents(page, test);

	// 取已绑定 claw 的 id（main 与 tester 链接共用同一 clawId）
	const mainLink = agentLink(page, 'main');
	await expect(mainLink).toBeVisible({ timeout: 5000 });
	const href = await mainLink.getAttribute('href');
	const clawId = href?.match(/\/chat\/([^/]+)\//)?.[1];
	expect(clawId).toBeTruthy();

	// best-effort：经浏览器为 tester 新建一个 topic。topic 在 createTopic 解析时即入 store，
	// 其在列表项中的 emoji 取自 agent 身份（与 agent 列表 emoji 是不同代码路径）。
	// - tester 非 main agent，其 session 页不显示"新建话题"按钮（产品门控，见 MA-8），故直接进
	//   new-topic 路由（?agent=tester）发起，而非走按钮；
	// - 与线上 MiniMax agent 交互若慢/抖动则干净 skip（见 TODO），不阻塞其余用例。
	let topicId = null;
	try {
		await page.goto(`/topics/new?agent=tester&claw=${clawId}`);
		const textarea = page.getByTestId('chat-textarea');
		await expect(textarea).toBeEnabled({ timeout: 15_000 });
		await typeText(textarea, `e2e tester topic ${Date.now()}`);
		await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 5000 });
		await page.getByTestId('btn-send').click();
		// createTopic 解析后路由由 /topics/new 切到 /topics/<topicId>（不等 agent 回复）
		await page.waitForURL((url) => /\/topics\/[^/]+$/.test(url.pathname) && url.pathname !== '/topics/new', { timeout: 30_000 });
		topicId = new URL(page.url()).pathname.split('/').pop();
	}
	catch {
		// 据 topicId 干净 skip
	}
	test.skip(!topicId, 'Could not create a tester topic against the live agent (best-effort fixture); see TODO');

	// 侧栏（aside，桌面常驻）的 session/topic 列表中，新建的 tester topic 项应显示 🔨
	//（emoji 不可翻译 → locale 无关例外）。
	// 不做整页刷新：coclaw.topics.list 固定按 agentId:'main' 拉取，刷新后 tester topic 不回列
	//（产品限制，见 TODO）；乐观入 store 的 topic 项足以验证"列表项按 agent 身份渲染 emoji"。
	const testerTopic = page.locator(`aside a[href$="/topics/${topicId}"]`);
	await expect(testerTopic).toContainText('🔨', { timeout: 10_000 });
});

// ================================================================
// Test 8: 新建聊天按钮在非 main agent 的 main session 上也可用
// ================================================================

// 暂挂（产品决策待定，非环境问题）：非 main agent 的 main session 不显示"新建话题"按钮。
// ChatPage.vue 的 showNewTopicBtn 仅在 topic 路由或 currentAgentId==='main' 时为真，这是产品
// 有意的门控——provision tester 也无法满足该前置。是否允许从非 main agent 直接新建 topic 待产品
// 定夺（详见 ui/TODO.md，2026-06-10）。届时放开门控后再以 btn-new-topic-* 断言去 skip。
test.skip('非 main agent 的 main session 也显示新建聊天按钮 @chat', async () => {});

// ================================================================
// Test 9: HomePage 智能跳转到默认 agent
// ================================================================

test('HomePage：桌面端自动跳转到默认 agent 的 main session @chat', async ({ page }) => {
	test.setTimeout(30_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	// 先验证 claw 在线
	await page.goto('/topics');
	const loaded = await waitAgentsLoaded(page);
	test.skip(!loaded, 'Claw offline or agents not available');

	await page.goto('/home');

	// 应跳转到 chat 页面（默认 agent 的 main session）
	await expect(page).toHaveURL(/\/chat\//, { timeout: 15_000 });
	await waitChatReady(page);

	// 验证是 main agent 的 session
	const sessionKey = await evalStore(page, 'chat', 'return store.currentSessionKey');
	expect(sessionKey).toMatch(/^agent:main:main$/);
});
