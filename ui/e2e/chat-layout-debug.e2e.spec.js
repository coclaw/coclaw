import { expect, test } from '@playwright/test';
import { login, navigateToChat } from './helpers.js';

/**
 * ChatPage 布局回归测试
 * 验证 header 粘顶、footer 固底、main 内部滚动。
 * 此测试防止 ChatPage 根元素误加 flex-1 导致布局崩溃。
 */

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

test('Desktop: ChatPage layout with many messages @ui', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);
	const claw = await navigateToChat(page);
	test.skip(!claw, 'No chat session available (no claw connected)');

	await injectMessages(page, 50);
	// 等待 chat-root 可见，确保注入消息后 DOM 稳定
	await expect(page.getByTestId('chat-root')).toBeVisible();

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

test('Mobile: ChatPage layout with many messages @ui', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);
	const claw = await navigateToChat(page);
	test.skip(!claw, 'No chat session available (no claw connected)');

	await injectMessages(page, 50);
	// 等待 chat-root 可见，确保注入消息后 DOM 稳定
	await expect(page.getByTestId('chat-root')).toBeVisible();

	const m = await getLayoutMetrics(page);

	expect(m.bodyScrollable).toBe(false);
	expect(m.chatRoot.height).toBeLessThanOrEqual(m.vpH + 1);
	expect(m.footer.bottom).toBeCloseTo(m.vpH, 0);
	expect(m.header.top).toBeLessThanOrEqual(1);
	expect(m.main.scrollH).toBeGreaterThan(m.main.clientH);
});
