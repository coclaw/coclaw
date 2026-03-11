import { expect, test } from '@playwright/test';

/**
 * ChatPage 布局回归测试
 * 验证 header 粘顶、footer 固底、main 内部滚动。
 * 此测试防止 ChatPage 根元素误加 flex-1 导致布局崩溃。
 */

/**
 * 登录并导航到 ChatPage。
 * @returns {boolean} true=成功进入 chat 页，false=无可用 session（应跳过测试）
 */
async function loginAndNavigateToChat(page) {
	await page.goto('/login');
	await page.getByTestId('login-name').fill('test');
	await page.getByTestId('login-password').fill('123456');
	await page.getByTestId('btn-login').click();
	await page.waitForTimeout(2000);

	// 若登录后已进入 chat 页（有 bot 且有 session），直接返回
	if (/\/chat\//.test(page.url())) return true;

	// 尝试从 topics 页面找到可用 session 链接
	await page.goto('/topics');
	// v0.2: sessions 通过 WS 异步加载，需等待链接出现
	await page.locator('main a[href*="/chat/"]').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
	const chatLink = page.locator('main a[href*="/chat/"]').first();
	if (await chatLink.count()) {
		await chatLink.click();
		await page.waitForTimeout(1000);
		return true;
	}
	return false;
}

function injectMessages(page, count = 50) {
	return page.evaluate((n) => {
		const main = document.querySelector('main');
		if (!main) return;
		const container = main.querySelector('.mx-auto') || main;
		container.innerHTML = '';
		for (let i = 0; i < n; i++) {
			const div = document.createElement('div');
			div.className = 'px-4 py-3';
			div.textContent = `Message ${i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt.`;
			container.appendChild(div);
		}
	}, count);
}

function getLayoutMetrics(page) {
	return page.evaluate(() => {
		const chatRoot = document.querySelector('[data-testid="chat-root"]');
		const main = chatRoot?.querySelector('main');
		const footer = chatRoot?.querySelector('footer');
		const headers = Array.from(chatRoot?.querySelectorAll('header') ?? []);
		const visibleHeader = headers.find((h) => getComputedStyle(h).display !== 'none');

		function box(el) {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { top: r.top, bottom: r.bottom, height: r.height };
		}

		return {
			vpH: window.innerHeight,
			bodyScrollable: document.body.scrollHeight > document.body.clientHeight + 1,
			chatRoot: box(chatRoot),
			main: main ? { ...box(main), scrollH: main.scrollHeight, clientH: main.clientHeight } : null,
			footer: box(footer),
			header: box(visibleHeader),
		};
	});
}

test('Desktop: ChatPage layout with many messages', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	const ok = await loginAndNavigateToChat(page);
	test.skip(!ok, 'No chat session available (no bot connected)');

	await injectMessages(page, 50);
	await page.waitForTimeout(300);

	const m = await getLayoutMetrics(page);

	// body 不可滚动
	expect(m.bodyScrollable).toBe(false);
	// chatRoot 不超过视口
	expect(m.chatRoot.height).toBeLessThanOrEqual(m.vpH + 1);
	// footer 底边紧贴视口底部
	expect(m.footer.bottom).toBeCloseTo(m.vpH, 0);
	// header 在视口顶部
	expect(m.header.top).toBeLessThanOrEqual(1);
	// main 内部可滚动
	expect(m.main.scrollH).toBeGreaterThan(m.main.clientH);
});

test('Mobile: ChatPage layout with many messages', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const ok = await loginAndNavigateToChat(page);
	test.skip(!ok, 'No chat session available (no bot connected)');

	await injectMessages(page, 50);
	await page.waitForTimeout(300);

	const m = await getLayoutMetrics(page);

	expect(m.bodyScrollable).toBe(false);
	expect(m.chatRoot.height).toBeLessThanOrEqual(m.vpH + 1);
	expect(m.footer.bottom).toBeCloseTo(m.vpH, 0);
	expect(m.header.top).toBeLessThanOrEqual(1);
	expect(m.main.scrollH).toBeGreaterThan(m.main.clientH);
});
