import { expect } from '@playwright/test';

// --- 常量 ---
export const TEST_LOGIN_NAME = 'test';
export const TEST_PASSWORD = '12345678';

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

/**
 * 确定性导航到 main agent 的 chat session（而非按活跃度排序的首个 agent）。
 *
 * 引入 tester 夹具后 /topics 的 agent 列表有多个链接，navigateToChat 点的是活跃度
 * 最高的那个、不一定是 main。需要"新建话题"按钮的用例必须落在 main——该按钮仅在
 * main agent 或 topic 路由显示（见 ChatPage.showNewTopicBtn）。
 *
 * 做法：从首个 chat 链接读出 clawId（所有 agent 共用同一 claw），再直接 goto
 * /chat/<clawId>/main。
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ clawId: string, agentId: string }|null>} 无可用 claw 返回 null
 */
export async function navigateToMainChat(page) {
	await page.goto('/topics');
	const chatLink = page.locator('main a[href*="/chat/"]').first();
	try {
		await chatLink.waitFor({ state: 'visible', timeout: 10_000 });
	}
	catch {
		return null;
	}
	const href = await chatLink.getAttribute('href');
	const clawId = href?.match(/\/chat\/([^/]+)\//)?.[1];
	if (!clawId) return null;
	await page.goto(`/chat/${clawId}/main`);
	await page.waitForURL(/\/chat\/[^/]+\/main$/, { timeout: 5000 });
	return { clawId, agentId: 'main' };
}

/** 等待 chat 页面完全就绪（chat-root 可见 + textarea 可用） */
export async function waitChatReady(page) {
	await expect(page.getByTestId('chat-root')).toBeVisible({ timeout: 5000 });
	await expect(page.getByTestId('chat-textarea')).toBeVisible({ timeout: 15_000 });
}

/**
 * 等待 chat 输入区进入稳定态后再输入，规避受控 textarea 在加载风暴中丢字符。
 *
 * 根因：chat-textarea 是受控组件——其值由 draftStore 经 ChatPage 的 modelValue 透传，
 * 每次按键 input 事件先 emit 更新 draftStore、Vue 再异步回填 DOM。冷启动首屏（首次进入
 * 某 chat 且网关尚冷）会在「textarea 刚解锁」的瞬间集中触发重渲染：拉历史列表的 RPC、
 * autoFill 补历史、scrollToBottom、ResizeObserver。这段持续重渲染期间 pressSequentially
 * 的按键与受控回填竞争，已落键的字符会被一拍之前的 modelValue 覆盖丢掉（chat-flow 首测
 * 命中最重；chat-input 的输入用例排在文件用例之后、网关已预热、加载窗口短而幸免）。
 *
 * 对策：打字前等首屏消息加载完成 + 历史列表 RPC 落定 + 无任何在飞加载，重渲染风暴结束后
 * 再输入，typeText 的读回补打即可稳定收敛。条件需连续两次成立以躲开 autoFill 的 nextTick
 * 起跑窗口（list RPC 刚回、historyLoading 尚未翻起的瞬间）。
 *
 * @param {import('@playwright/test').Page} page
 */
export async function waitChatInputStable(page) {
	const textarea = page.getByTestId('chat-textarea');
	await expect(textarea).toBeVisible({ timeout: 15_000 });
	// 解锁 = isLoadingChat 为 false = 首屏消息已加载（也意味着 DC 当时已就绪）
	await expect(textarea).toBeEnabled({ timeout: 30_000 });

	const probe = () => page.evaluate(() => {
		const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
		if (!pinia) return false;
		let store = null;
		for (const [key, s] of pinia._s) {
			if (key.startsWith('chat-')) store = s;
		}
		if (!store) return false;
		if (!store.__messagesLoaded) return false;
		if (store.messagesLoading || store.historyLoading) return false;
		// 在飞的 load / silent-load / 历史列表 RPC 任一未结束都不算稳定
		if (store.__loadPromise || store.__silentLoadPromise || store.__historyListPromise) return false;
		// 非 topic 模式：历史列表 RPC 必须已返回（rawHistorySessionIds 不再是初始 null）
		if (!store.topicMode && store.rawHistorySessionIds == null) return false;
		return true;
	});

	await expect(async () => {
		const first = await probe();
		if (!first) { expect(first).toBe(true); return; }
		// 连续确认：跨过 autoFill 在 nextTick 起跑前的空窗
		await new Promise((r) => setTimeout(r, 150));
		const second = await probe();
		expect(second).toBe(true);
	}).toPass({ timeout: 30_000, intervals: [100, 200, 300, 500] });
}

// --- 输入 ---

/**
 * 安全地向 Nuxt UI 复合输入组件（UTextarea 等）输入文本。
 *
 * ⚠️ 禁止对 UTextarea 使用 Playwright 的 fill()。
 * fill() 通过 CDP 直接设置 value，绕过浏览器事件序列，
 * 导致 Vue v-model 响应式链断裂（详见 docs/e2e-troubleshooting.md 卡点 3）。
 *
 * 截断免疫：WSL2 高负载下逐字输入会丢尾字符（如期望 "...431" 实得 "...248"），
 * 导致 toHaveValue 失败、消息发出后内容不全。这里输入后读回校验：
 * 当前值是目标的严格前缀就只补打缺失尾部；发散则键盘全选删除后整体重打
 * （仍走键盘事件，不用 fill()，避免断 v-model）。重试上限后仍不匹配才抛错。
 *
 * 语义保持「在光标处追加」：目标值 = 原有内容 + text，空输入框即等于 text。
 *
 * @param {import('@playwright/test').Locator} locator - 目标输入组件的 locator
 * @param {string} text - 要输入的文本
 */
export async function typeText(locator, text) {
	await locator.click();
	const before = await locator.inputValue();
	const target = before + text;
	await locator.pressSequentially(text, { delay: 20 });

	const MAX_RETRY = 3;
	for (let i = 0; i < MAX_RETRY; i++) {
		const cur = await locator.inputValue();
		if (cur === target) return;
		if (cur.length < target.length && target.startsWith(cur)) {
			// 严格前缀：只补打缺失的尾部
			await locator.pressSequentially(target.slice(cur.length), { delay: 20 });
		}
		else {
			// 发散：键盘全选删除后整体重打（ControlOrMeta 兼容 mac/非 mac）
			await locator.press('ControlOrMeta+a');
			await locator.press('Delete');
			await locator.pressSequentially(target, { delay: 20 });
		}
	}

	const final = await locator.inputValue();
	if (final !== target) {
		throw new Error(`typeText failed to settle value after ${MAX_RETRY} retries. expected=${JSON.stringify(target)} actual=${JSON.stringify(final)}`);
	}
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

// --- Topic 夹具（Create-Test-Delete） ---

/**
 * 经 topics store 直接创建一个测试 topic（真实 coclaw.topics.create RPC）。
 *
 * 供 topic 管理类用例做 Create-Test-Delete 夹具：相比走「新建 topic 路由 + 发消息」，
 * 这条不触发 agent 真实回复，省 LLM 运行又确定性。必须先进入桌面 chat 页（侧栏 MainList
 * 已实例化 topics store 并就绪一个连接）。
 * @param {import('@playwright/test').Page} page
 * @param {string} clawId
 * @param {string} [agentId='main']
 * @returns {Promise<string>} 新建 topic 的 topicId
 */
export function createTopicViaStore(page, clawId, agentId = 'main') {
	return page.evaluate(async ({ clawId, agentId }) => {
		const { useTopicsStore } = await import('/src/stores/topics.store.js');
		const { getReadyConn } = await import('/src/stores/get-ready-conn.js');
		const store = useTopicsStore();
		// 等就绪连接：连续多测下信令偶发瞬断重连，此刻 createTopic 的 useClawConnections().get
		// 可能短暂取不到连接（"Claw not connected"）。等连接恢复（≤15s）再建，避免该瞬态致脆断。
		const deadline = Date.now() + 15_000;
		while (!getReadyConn(clawId) && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 300));
		}
		return store.createTopic(clawId, agentId);
	}, { clawId, agentId });
}

/**
 * 经 topics store 删除 topic（清理夹具）。失败返回 false（吞掉异常），
 * 调用方据返回值决定是否记 TODO，避免清理失败连累用例主体。
 * @param {import('@playwright/test').Page} page
 * @param {string} clawId
 * @param {string} topicId
 * @returns {Promise<boolean>}
 */
export function deleteTopicViaStore(page, clawId, topicId) {
	return page.evaluate(async ({ clawId, topicId }) => {
		try {
			const { useTopicsStore } = await import('/src/stores/topics.store.js');
			const store = useTopicsStore();
			await store.deleteTopic(clawId, topicId);
			return true;
		}
		catch {
			return false;
		}
	}, { clawId, topicId });
}

// --- 信令 WebSocket 连接状态 ---
//
// 信令 WS 已从 ClawConnection 迁移到 per-tab 单例 SignalingConnection
// （src/services/signaling-connection.js）。这里通过 dynamic import 拿到与
// app 同一份模块的单例（Vite dev server 按 URL 缓存 ESM，同 URL 即同实例），
// 与 file-browser/rtc-transport 等 spec 拿 service 单例的方式一致。

/**
 * 获取信令 WS 连接状态
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<'connected'|'connecting'|'disconnected'|'no-connection'>}
 */
export function getWsState(page) {
	return page.evaluate(async () => {
		const { useSignalingConnection } = await import('/src/services/signaling-connection.js');
		const sig = useSignalingConnection();
		return sig?.state ?? 'no-connection';
	});
}

/**
 * 强制关闭信令 WS 连接（模拟异常断连，SignalingConnection 会自动重连）
 * @param {import('@playwright/test').Page} page
 * @param {number} [code=4000]
 * @param {string} [reason='e2e_disconnect']
 */
export function forceCloseWs(page, code = 4000, reason = 'e2e_disconnect') {
	return page.evaluate(async ({ code, reason }) => {
		const { useSignalingConnection } = await import('/src/services/signaling-connection.js');
		const sig = useSignalingConnection();
		if (sig?.__ws) sig.__ws.close(code, reason);
	}, { code, reason });
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
