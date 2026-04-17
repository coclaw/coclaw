/**
 * Topic 功能集成测试
 * 需要真实 server + OpenClaw 实例 + 已完成的插件
 */
import { test, expect } from '@playwright/test';
import { login, waitChatReady, typeText } from './helpers.js';

test.describe('Topic management @chat', () => {
	test.setTimeout(120_000);

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
		// 1. 进入 topics 列表页，等待 agent 列表加载
		await page.goto('/topics');
		const agentLink = page.locator('nav a[href*="/chat/"]').first();
		await agentLink.waitFor({ state: 'visible', timeout: 20_000 });

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

		// 7. 验证路由从 /topics/new 切换为 /topics/<uuid>
		await expect(page).not.toHaveURL(/\/topics\/new/, { timeout: 20_000 });
		await expect(page).toHaveURL(/\/topics\/[0-9a-f-]{36}/, { timeout: 5000 });

		// 8. 等待 sending 状态结束（agent 完成处理）
		await expect(async () => {
			const sending = await page.evaluate(() => {
				const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
				return pinia?._s?.get('chat')?.sending;
			});
			expect(sending).toBe(false);
		}).toPass({ timeout: 90_000 });

		// 9. 诊断：检查 store 状态
		const storeState = await page.evaluate(() => {
			const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
			const chat = pinia?._s?.get('chat');
			return {
				sessionId: chat?.sessionId,
				clawId: chat?.clawId,
				topicMode: chat?.topicMode,
				topicAgentId: chat?.topicAgentId,
				msgCount: chat?.messages?.length ?? 0,
				loading: chat?.loading,
				errorText: chat?.errorText,
				sending: chat?.sending,
			};
		});
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
		try {
			await topicLinks.first().waitFor({ state: 'visible', timeout: 15_000 });
		}
		catch {
			console.log('No topics found in list (might need to create one first)');
			return;
		}

		const count = await topicLinks.count();
		console.log(`Found ${count} topic(s) in the list`);
		expect(count).toBeGreaterThan(0);

		// 点击第一个 topic 验证能正常加载
		await topicLinks.first().click();
		await page.waitForURL(/\/topics\/[0-9a-f-]/, { timeout: 5000 });
		await waitChatReady(page);

		// 验证消息加载成功（不是空白，不是持续 loading）
		await expect(async () => {
			const loading = await page.evaluate(() => {
				const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
				return pinia?._s?.get('chat')?.loading;
			});
			expect(loading).toBe(false);
		}).toPass({ timeout: 15_000 });

		const chatRoot = page.getByTestId('chat-root');
		// 验证能加载历史（某些 topic 可能没有 .jsonl，这是正常的 - 之前创建但未发送的）
		const text = await chatRoot.textContent();
		console.log('Topic content preview:', text.substring(0, 100));
		// 基本检查：不应显示 error 状态
		const errorText = await page.evaluate(() => {
			const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
			return pinia?._s?.get('chat')?.errorText ?? '';
		});
		expect(errorText).toBe('');
	});

	test('sidebar active 状态：topic 路由下不高亮 agent', async ({ page }) => {
		await page.goto('/topics');

		const topicLink = page.locator('nav a[href*="/topics/"]').first();
		try {
			await topicLink.waitFor({ state: 'visible', timeout: 15_000 });
		}
		catch {
			console.log('No topics found, skipping active state test');
			return;
		}

		await topicLink.click();
		await page.waitForURL(/\/topics\//, { timeout: 5000 });

		// 等待页面稳定
		await page.waitForTimeout(1000);

		// 检查 agent nav（第2个 nav）中的 active 状态
		// agent link 使用 class 'bg-accented' 表示高亮
		const agentNav = page.locator('nav').nth(1);
		const activeAgents = agentNav.locator('a.bg-accented');
		const activeCount = await activeAgents.count();
		expect(activeCount).toBe(0);
	});
});
