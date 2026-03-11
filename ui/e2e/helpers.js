import { expect } from '@playwright/test';

// --- 常量 ---
export const TEST_LOGIN_NAME = 'test';
export const TEST_PASSWORD = '123456';

// --- 认证 ---

/** 登录并等待进入认证区域 */
export async function login(page) {
	await page.goto('/login');
	await page.getByTestId('login-name').fill(TEST_LOGIN_NAME);
	await page.getByTestId('login-password').fill(TEST_PASSWORD);
	await page.getByTestId('btn-login').click();
	await expect(page).not.toHaveURL(/\/login$/, { timeout: 10_000 });
}

// --- 导航 ---

/** 从 topics 页导航到一个可用的 chat session，返回 sessionId（无可用 session 返回 null） */
export async function navigateToChat(page) {
	await page.goto('/topics');
	const chatLink = page.locator('main a[href*="/chat/"]').first();
	try {
		await chatLink.waitFor({ state: 'visible', timeout: 10_000 });
	}
	catch {
		return null;
	}
	const href = await chatLink.getAttribute('href');
	await chatLink.click();
	await page.waitForURL(/\/chat\//, { timeout: 5000 });
	const match = href?.match(/\/chat\/([^/?]+)/);
	return match?.[1] ?? null;
}

/** 等待 chat 页面完全就绪（chat-root 可见 + textarea 可用） */
export async function waitChatReady(page) {
	await expect(page.getByTestId('chat-root')).toBeVisible({ timeout: 5000 });
	await expect(page.getByTestId('chat-textarea')).toBeVisible({ timeout: 15_000 });
}

// --- 输入 ---

/**
 * 安全地向 Nuxt UI 复合输入组件（UTextarea 等）输入文本。
 *
 * ⚠️ 禁止对 UTextarea 使用 Playwright 的 fill()。
 * fill() 通过 CDP 直接设置 value，绕过浏览器事件序列，
 * 导致 Vue v-model 响应式链断裂（详见 docs/e2e-troubleshooting.md 卡点 3）。
 *
 * @param {import('@playwright/test').Locator} locator - 目标输入组件的 locator
 * @param {string} text - 要输入的文本
 */
export async function typeText(locator, text) {
	await locator.click();
	await locator.pressSequentially(text, { delay: 20 });
}
