/**
 * Topic 功能集成测试
 * 需要真实 server + OpenClaw 实例 + 已完成的插件
 */
import { test, expect } from '@playwright/test';
import { login, waitChatReady, typeText, evalStore, deleteTopicViaStore } from './helpers.js';

test.describe('Topic management @chat', () => {
	test.setTimeout(120_000);

	// Test 1 经 UI 真实创建一个 topic，落在共享 main session 里。用 describe 级变量捕获
	// 其 { clawId, topicId }，由 afterEach 保证清理（仅删本测创建的那个），避免每跑一轮泄漏一个。
	let createdTopic = null;

	test.afterEach(async ({ page }) => {
		if (!createdTopic) return;
		const { clawId, topicId } = createdTopic;
		createdTopic = null;
		await deleteTopicViaStore(page, clawId, topicId).catch(() => {});
	});

	test.beforeEach(async ({ page }) => {
		// 捕获浏览器 console 日志
		page.on('console', (msg) => {
			const text = msg.text();
			if (text.includes('[chat]') || text.includes('[topics]')) {
				console.log(`[browser] ${text}`);
			}
		});
		await login(page);
	});

	test('从 agent main session 创建新 topic 并发送消息', async ({ page }) => {
		// 本测含 login + nav + 创建 topic + 等 agent 完成（sending toPass 90s），
		// 整体 ≈140s 超出 describe 级 120s 默认上限 → 单独抬到 180s 给足预算；
		// 其余轻量用例仍沿用 describe 的 120s 较紧的护栏。
		test.setTimeout(180_000);

		// 1. 进入 topics 列表页，等待 agent 列表加载
		await page.goto('/topics');
		const agentLink = page.locator('nav a[href*="/chat/"]').first();
		// 无在线 agent 时不硬抛，按其它 spec 的模式 skip
		let hasAgent = true;
		try {
			await agentLink.waitFor({ state: 'visible', timeout: 20_000 });
		}
		catch {
			hasAgent = false;
		}
		test.skip(!hasAgent, 'No online agent available');

		// 2. 点击第一个 agent 进入 main session
		await agentLink.click();
		await page.waitForURL(/\/chat\//, { timeout: 10_000 });
		await waitChatReady(page);

		// 3. 点击"新话题"按钮（desktop header；桌面/移动端 testid 已独立）
		const newTopicBtn = page.getByTestId('btn-new-topic-desktop');
		await expect(newTopicBtn).toBeVisible({ timeout: 5000 });
		await newTopicBtn.click();

		// 4. 验证导航到 /topics/new
		await page.waitForURL(/\/topics\/new/, { timeout: 5000 });

		// 5. 验证输入框可用
		const textarea = page.getByTestId('chat-textarea');
		await expect(textarea).toBeVisible({ timeout: 10_000 });

		// 6. 输入消息并发送
		await typeText(textarea, 'Hello topic test');
		const sendBtn = page.getByTestId('btn-send');
		await sendBtn.click();

		// 7. step 6 的 send 会真实创建 topic 并把路由切到 /topics/<uuid>。
		//    用 waitForURL 等这次切换——它在 URL 一匹配的瞬间 resolve，于是能在
		//    任何可抛断言之前立刻捕获 { clawId, topicId } 给 afterEach 清理。
		//    若改用 expect().toHaveURL 断言、再在其后捕获，则 topic 创建成功后该断言
		//    一旦超时（偶发抖动），createdTopic 仍是 null → afterEach 空转 → 泄漏一个 topic。
		await page.waitForURL(/\/topics\/[0-9a-f-]{36}/, { timeout: 25_000 });
		const topicId = page.url().match(/\/topics\/([0-9a-f-]{36})/)?.[1];
		const clawId = await evalStore(page, 'chat', 'return store.clawId;');
		if (topicId && clawId) createdTopic = { clawId, topicId };

		// 7b. 捕获后再断言确实已离开 /topics/new（此刻 URL 已是 uuid，断言即时通过）
		await expect(page).not.toHaveURL(/\/topics\/new/);

		// 8. 等待 sending 状态结束（agent 完成处理）
		//    chat store 是工厂模式，真实 id 为 chat-session:/chat-topic:，须用 evalStore 的 'chat' 简写匹配
		await expect(async () => {
			const sending = await evalStore(page, 'chat', 'return store.sending;');
			expect(sending).toBe(false);
		}).toPass({ timeout: 90_000 });

		// 9. 诊断：检查 store 状态
		const storeState = await evalStore(page, 'chat', `
			return {
				sessionId: store.sessionId,
				clawId: store.clawId,
				topicMode: store.topicMode,
				topicAgentId: store.topicAgentId,
				msgCount: store.messages?.length ?? 0,
				loading: store.loading,
				errorText: store.errorText,
				sending: store.sending,
			};
		`);
		console.log('Chat store state after send:', JSON.stringify(storeState));

		// 10. 核心验证：消息区域不为空白
		const chatRoot = page.getByTestId('chat-root');
		const msgText = await chatRoot.textContent();
		console.log('Chat content:', msgText.substring(0, 200));
		expect(msgText).toContain('Hello topic test');

		console.log(`Topic test passed. URL: ${page.url()}`);
	});

	test('topic 列表页显示已创建的 topics', async ({ page }) => {
		await page.goto('/topics');

		// 等待 topic 列表加载
		const topicLinks = page.locator('nav a[href*="/topics/"]');
		let hasTopic = true;
		try {
			await topicLinks.first().waitFor({ state: 'visible', timeout: 15_000 });
		}
		catch {
			hasTopic = false;
		}
		// 无 topic 时显式 skip（旧 return 会零断言报假绿）
		test.skip(!hasTopic, 'No topics found in list (might need to create one first)');

		const count = await topicLinks.count();
		console.log(`Found ${count} topic(s) in the list`);
		expect(count).toBeGreaterThan(0);

		// 点击第一个 topic 验证能正常加载
		await topicLinks.first().click();
		await page.waitForURL(/\/topics\/[0-9a-f-]/, { timeout: 5000 });
		await waitChatReady(page);

		// 验证消息加载成功（不是空白，不是持续 loading）
		await expect(async () => {
			const loading = await evalStore(page, 'chat', 'return store.loading;');
			expect(loading).toBe(false);
		}).toPass({ timeout: 15_000 });

		const chatRoot = page.getByTestId('chat-root');
		// 验证能加载历史（某些 topic 可能没有 .jsonl，这是正常的 - 之前创建但未发送的）
		const text = await chatRoot.textContent();
		console.log('Topic content preview:', text.substring(0, 100));
		// 基本检查：不应显示 error 状态
		const errorText = await evalStore(page, 'chat', 'return store.errorText ?? "";');
		expect(errorText).toBe('');
	});

	test('sidebar active 状态：topic 路由下不高亮 agent', async ({ page }) => {
		await page.goto('/topics');

		const topicLink = page.locator('nav a[href*="/topics/"]').first();
		let hasTopic = true;
		try {
			await topicLink.waitFor({ state: 'visible', timeout: 15_000 });
		}
		catch {
			hasTopic = false;
		}
		// 无 topic 时显式 skip（旧 return 会零断言报假绿）
		test.skip(!hasTopic, 'No topics found, skipping active state test');

		await topicLink.click();
		await page.waitForURL(/\/topics\//, { timeout: 5000 });

		// 检查 agent nav（第2个 nav）中的 active 状态：topic 路由下不应高亮任何 agent。
		// 用 toPass 轮询，等 bg-accented（active）class 在路由切换后稳定落定，
		// 避免对一帧可能陈旧的 DOM 立即下结论。
		const agentNav = page.locator('nav').nth(1);
		await expect(async () => {
			const activeCount = await agentNav.locator('a.bg-accented').count();
			expect(activeCount).toBe(0);
		}).toPass({ timeout: 5000 });
	});
});
