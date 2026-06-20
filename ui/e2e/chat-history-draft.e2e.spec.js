import { expect, test } from '@playwright/test';
import { login, navigateToMainChat, waitChatReady, waitChatInputStable, typeText, evalStore } from './helpers.js';

/**
 * Chat 增量覆盖：历史分页 / 草稿保留 / 清空对话危险流程
 *
 * 前置条件：
 * - server + OpenClaw gateway 运行中
 * - test 用户已绑定 claw 且在线（含 main + tester 两个 agent，由 globalSetup 夹具保证）
 *
 * 这些用例落在 main session（用累计历史做只读滚动、按会话保留草稿），不修改/删除任何
 * 已有会话数据；清空对话用例只验已实现的危险确认门控（实际清空接口未开放、点确认仅提示），
 * 全程不触碰真实数据。
 */

// ================================================================
// Test 1: 历史分页 —— 向上滚动加载更早消息，到顶显示"没有更多"
// ================================================================

test('历史分页：向上滚动加载更早消息并到顶显示无更多 @chat', async ({ page }) => {
	test.setTimeout(300_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	// 确定性落在 main session（累计历史最多，且 navigateToMainChat 不依赖活跃度排序）
	const session = await navigateToMainChat(page);
	test.skip(!session, 'No chat session available (no claw online)');

	await waitChatReady(page);
	// 等首屏消息加载 + 历史列表 RPC 落定，确保 hasMoreMessages 等状态已就绪
	await waitChatInputStable(page);

	// 可分页 = 当前 session 内还有更早消息（hasMoreMessages）或存在更早的归档 session
	//（historySessionIds）。两者皆无才真没历史可翻 → 干净 skip。注意：分页计数要看 DOM 渲染的
	// 消息项，store.messages 只含当前 session、加载归档 session 后并不增长。
	const canPaginate = await evalStore(page, 'chat',
		'return !!store.hasMoreMessages || (store.historySessionIds?.length ?? 0) > 0');
	test.skip(!canPaginate, 'main session has no earlier history to paginate');

	const msgItems = page.locator('[data-testid="chat-msg-item"]');
	const initialCount = await msgItems.count();
	expect(initialCount).toBeGreaterThan(0);

	// 初始处于底部时，顶部应渲染"上翻加载更早"提示（hasMoreHistory 为真的可见信号）
	const scrollUpHint = page.getByText(/Scroll up for earlier messages|上翻加载更早记录/);
	await expect(scrollUpHint).toBeVisible({ timeout: 5000 });

	// chat-root 内唯一的滚动容器（<main ref="scrollContainer">），@scroll 绑定 onScroll
	const scroller = page.locator('[data-testid="chat-root"] main');
	const noMoreHint = page.getByText(/No earlier messages|没有更多聊天记录了/);

	// ① 先验"加载更早"：滚到顶触发 __loadMoreHistory → loadOlderMessages，消息数应增长
	await expect(async () => {
		await scroller.evaluate((el) => { el.scrollTop = 0; });
		await new Promise((r) => setTimeout(r, 400));
		const cur = await msgItems.count();
		expect(cur).toBeGreaterThan(initialCount);
	}).toPass({ timeout: 60_000, intervals: [600, 1000, 1500] });

	// ② 再验"到顶无更多"：持续上翻直至历史耗尽（当前 session 内 + 更早归档 session 全部加载完），
	//    showNoMoreHint 仅在 historyExhausted && userScrolledUp 时为真，故必须真实滚动驱动
	await expect(async () => {
		await scroller.evaluate((el) => { el.scrollTop = 0; });
		await new Promise((r) => setTimeout(r, 400));
		await expect(noMoreHint).toBeVisible({ timeout: 1500 });
	}).toPass({ timeout: 240_000, intervals: [800, 1200, 2000] });

	// 到顶后消息数应不少于初始（已加载更早消息）
	const finalCount = await msgItems.count();
	expect(finalCount).toBeGreaterThan(initialCount);
});

// ================================================================
// Test 2: 草稿保留 —— 会话 A 输入未发送草稿，切到 B 再切回 A 仍在
// ================================================================

test('草稿保留：切换会话后未发送草稿仍保留 @chat', async ({ page }) => {
	test.setTimeout(180_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const session = await navigateToMainChat(page);
	test.skip(!session, 'No chat session available (no claw online)');
	const { clawId } = session;

	await waitChatReady(page);
	await waitChatInputStable(page);

	// 桌面侧栏内 main / tester 两个 agent 的会话链接（按 href 末段定位，locale 无关）
	const testerLink = page.locator(`aside a[href$="/${clawId}/tester"]`);
	const mainLink = page.locator(`aside a[href$="/${clawId}/main"]`);
	// tester 由 globalSetup 夹具保证；万一缺失则干净 skip（无第二会话可切换）
	const hasTester = await testerLink.isVisible().catch(() => false);
	test.skip(!hasTester, 'No tester agent session to switch to');

	// 在会话 A（main）输入未发送草稿
	const draftA = `draft-main-${Date.now()}`;
	const textarea = page.getByTestId('chat-textarea');
	await typeText(textarea, draftA);
	await expect(textarea).toHaveValue(draftA, { timeout: 3000 });

	// 切到会话 B（tester，in-app 路由，不整页刷新）—— 草稿按会话隔离，B 应为空
	await testerLink.click();
	await page.waitForURL(new RegExp(`/chat/[^/]+/tester$`), { timeout: 5000 });
	await waitChatReady(page);
	await expect(page.getByTestId('chat-textarea')).toHaveValue('', { timeout: 5000 });

	// 切回会话 A（main）—— 之前的草稿应仍在
	await mainLink.click();
	await page.waitForURL(new RegExp(`/chat/[^/]+/main$`), { timeout: 5000 });
	await waitChatReady(page);
	await expect(page.getByTestId('chat-textarea')).toHaveValue(draftA, { timeout: 5000 });

	// 清掉草稿，避免污染本 context 后续（虽 context 用完即弃，仍保持干净）
	await evalStore(page, 'draft', 'store.drafts = {};');
});

// ================================================================
// Test 3: 清空对话危险确认流程（清空接口未开放，仅验门控，无任何数据被清）
// ================================================================
//
// 现状：UI 只有「清空所有对话」全局入口（设置面板内），其确认按钮被「我已确认」复选框门控；
// 点确认仅弹"接口暂未开放"提示、不清任何数据（onConfirmClearChats 为占位实现）。不存在按
// topic 的清空入口，故无法断言"已清空"——这里改验已实现的危险确认门控本身，且天然安全。

test('清空对话：危险确认勾选门控且接口未开放 @chat @ui', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	// 从侧栏用户菜单打开设置弹窗
	await page.getByTestId('user-menu-trigger').click();
	await page.getByRole('button', { name: /^(Settings|设置)$/ }).click();

	// 设置弹窗内点「清空」打开危险确认弹窗
	const settingsDialog = page.getByRole('dialog').filter({ hasText: /Clear all chats|清空所有对话/ });
	await expect(settingsDialog).toBeVisible({ timeout: 5000 });
	await settingsDialog.getByRole('button', { name: /^(Clear|清空)$/ }).click();

	// 危险确认弹窗：确认按钮在未勾选前禁用
	const dangerDialog = page.getByRole('dialog').filter({ hasText: /Danger Zone|危险提示/ });
	await expect(dangerDialog).toBeVisible({ timeout: 5000 });
	const confirmBtn = dangerDialog.getByRole('button', { name: /^(Confirm|确认)$/ });
	await expect(confirmBtn).toBeDisabled();

	// 勾选「我已确认」后确认按钮启用
	await dangerDialog.getByRole('checkbox').check();
	await expect(confirmBtn).toBeEnabled();

	// 点确认：当前仅提示"接口暂未开放"并关闭弹窗，不清任何数据
	await confirmBtn.click();
	// 提示文案在 toast 的 live-region 与标题里各出现一次，取首个即可（避免 strict mode 命中两处）
	await expect(page.getByText(/Clear chats API is not available yet|清空对话接口暂未开放/).first()).toBeVisible({ timeout: 5000 });
	await expect(dangerDialog).toBeHidden({ timeout: 5000 });
});
