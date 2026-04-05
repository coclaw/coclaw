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
	await expect(page).not.toHaveURL(/\/login(\?|$)/, { timeout: 10_000 });
}

// --- 导航 ---

/** 从 topics 页导航到一个可用的 chat session，返回 { clawId, agentId }（无可用 session 返回 null） */
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
	const match = href?.match(/\/chat\/([^/?]+)\/([^/?]+)/);
	if (!match) return null;
	return { clawId: match[1], agentId: match[2] };
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

// --- Pinia Store 操作 ---

/**
 * 在浏览器上下文中访问 Pinia store 并执行操作
 * @param {import('@playwright/test').Page} page
 * @param {string} storeId - store ID（如 'claws', 'sessions', 'chat'）
 * @param {string} fnBody - 以 `store` 为参数的函数体字符串
 * @returns {Promise<*>}
 */
export function evalStore(page, storeId, fnBody) {
	return page.evaluate(([id, body]) => {
		const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
		if (!pinia) throw new Error('Pinia not found');
		let store = pinia._s.get(id);
		// chat store 使用工厂模式，ID 为 'chat-session:...' 或 'chat-topic:...'
		// 支持 'chat' 作为简写，自动匹配最后一个以 'chat-' 开头的 store
		if (!store && id === 'chat') {
			for (const [key, s] of pinia._s) {
				if (key.startsWith('chat-')) store = s;
			}
		}
		if (!store) throw new Error(`Store "${id}" not found`);
		const fn = new Function('store', body);
		return fn(store);
	}, [storeId, fnBody]);
}

// --- WebSocket 连接状态 ---

/**
 * 获取当前 chat 对应的 WS 连接状态
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<'connected'|'connecting'|'disconnected'|'no-connection'>}
 */
export function getWsState(page) {
	return evalStore(page, 'chat', `
		const conn = store.__getConnection?.();
		return conn ? conn.state : 'no-connection';
	`);
}

/**
 * 强制关闭当前 chat 的 WS 连接（模拟异常断连）
 * @param {import('@playwright/test').Page} page
 * @param {number} [code=4000]
 * @param {string} [reason='e2e_disconnect']
 */
export function forceCloseWs(page, code = 4000, reason = 'e2e_disconnect') {
	return evalStore(page, 'chat', `
		const conn = store.__getConnection?.();
		if (conn?.__ws) conn.__ws.close(${code}, '${reason}');
	`);
}

/**
 * 等待 WS 连接进入指定状态
 * @param {import('@playwright/test').Page} page
 * @param {string} expectedState - 'connected' | 'disconnected' | 'connecting'
 * @param {number} [timeout=15000]
 */
export async function waitForWsState(page, expectedState, timeout = 15_000) {
	await expect(async () => {
		const state = await getWsState(page);
		expect(state).toBe(expectedState);
	}).toPass({ timeout });
}
