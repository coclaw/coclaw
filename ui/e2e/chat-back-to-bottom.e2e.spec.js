import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady } from './helpers.js';

/**
 * 「回到底部」悬浮按钮 e2e（issue #245）
 * - 距底 > 1 屏 → 按钮显示
 * - 点击 → 滚回底部，按钮消失
 * - 距底 < 1 屏 → 按钮不显示
 */

/** 在 main 滚动容器内注入大量内容，让 scrollHeight 远大于 clientHeight（> 2 屏） */
function injectLongContent(page) {
	return page.evaluate(() => {
		const main = document.querySelector('[data-testid="chat-root"] main');
		if (!main) return null;
		const container = main.querySelector('.mx-auto') || main;
		container.innerHTML = '';
		for (let i = 0; i < 200; i++) {
			const div = document.createElement('div');
			div.style.padding = '12px 16px';
			div.style.minHeight = '40px';
			div.textContent = `injected msg ${i}: ${'long content '.repeat(8)}`;
			container.appendChild(div);
		}
		return { scrollH: main.scrollHeight, clientH: main.clientHeight };
	});
}

/** 强制 main scrollTop 到指定位置，触发 scroll 事件让 onScroll 跑一遍 */
function setMainScrollTop(page, top) {
	return page.evaluate((y) => {
		const main = document.querySelector('[data-testid="chat-root"] main');
		if (!main) return;
		main.scrollTop = y;
		main.dispatchEvent(new Event('scroll'));
	}, top);
}

test('回到底部按钮：距底 > 1 屏显示，点击后滚回底部并隐藏 @ui', async ({ page }) => {
	test.setTimeout(60_000); // login + navigateToChat + waitChatReady 链在高负载下可超 30s 默认上限
	await login(page);
	const info = await navigateToChat(page);
	test.skip(!info, 'No chat session available');
	await waitChatReady(page);

	const dims = await injectLongContent(page);
	test.skip(!dims || dims.scrollH < dims.clientH * 2, 'Cannot inject enough content for >1 screen scroll');

	const btn = page.getByTestId('btn-back-to-bottom');

	// 先滚到底部，按钮应不可见
	await setMainScrollTop(page, dims.scrollH);
	await expect(btn).not.toBeVisible();

	// 滚到顶部（距底远 > 1 屏）→ 按钮显示
	await setMainScrollTop(page, 0);
	await expect(btn).toBeVisible({ timeout: 2000 });

	// 点击 → 滚回底部、按钮消失
	await btn.click();
	await expect(btn).not.toBeVisible({ timeout: 2000 });

	// 实测距底应接近 0（<60 = userScrolledUp 同步阈值）
	const distFromBottom = await page.evaluate(() => {
		const main = document.querySelector('[data-testid="chat-root"] main');
		return main ? main.scrollHeight - main.scrollTop - main.clientHeight : null;
	});
	expect(distFromBottom).not.toBeNull();
	expect(distFromBottom).toBeLessThan(60);
});

// iOS<16 WebKit 惯性期吞程序化 scrollTo 的修复路径：force 滚动改为 rAF 逐帧重试循环。
// Chromium 无法复现真实惯性吞没，用猴补 scrollTo（首次调用起 500ms 内丢弃）模拟"被吞窗口"，
// 真浏览器端到端验证循环重试收敛到底 + flag 回置（按钮保持隐藏）。
test('回到底部按钮：scrollTo 被吞 500ms 仍收敛到底（force 重试循环） @ui', async ({ page }) => {
	test.setTimeout(60_000); // login + navigateToChat + waitChatReady 链在高负载下可超 30s 默认上限
	await login(page);
	const info = await navigateToChat(page);
	test.skip(!info, 'No chat session available');
	await waitChatReady(page);

	const dims = await injectLongContent(page);
	test.skip(!dims || dims.scrollH < dims.clientH * 2, 'Cannot inject enough content for >1 screen scroll');

	const btn = page.getByTestId('btn-back-to-bottom');

	// 滚到顶部（距底远 > 1 屏）→ 按钮显示
	await setMainScrollTop(page, 0);
	await expect(btn).toBeVisible({ timeout: 2000 });

	// 猴补实例方法覆盖原型方法：从第一次调用起 500ms 内丢弃 scrollTo，之后放行原生实现
	await page.evaluate(() => {
		const main = document.querySelector('[data-testid="chat-root"] main');
		const native = main.scrollTo.bind(main);
		let dropUntil = 0;
		main.scrollTo = (...args) => {
			if (!dropUntil) dropUntil = Date.now() + 500;
			if (Date.now() < dropUntil) return; // 模拟惯性期被合成线程丢弃
			native(...args);
		};
	});

	await btn.click();

	// 循环应在放行后数帧内收敛：2s 内距底 ≤1px
	await expect
		.poll(() => page.evaluate(() => {
			const main = document.querySelector('[data-testid="chat-root"] main');
			return main ? main.scrollHeight - main.scrollTop - main.clientHeight : null;
		}), { timeout: 2000 })
		.toBeLessThanOrEqual(1);

	// flag 已按真实落点回置：按钮保持隐藏
	await expect(btn).not.toBeVisible();
});

test('回到底部按钮：距底 < 1 屏时不显示 @ui', async ({ page }) => {
	test.setTimeout(60_000); // login + navigateToChat + waitChatReady 链在高负载下可超 30s 默认上限
	await login(page);
	const info = await navigateToChat(page);
	test.skip(!info, 'No chat session available');
	await waitChatReady(page);

	const dims = await injectLongContent(page);
	test.skip(!dims || dims.scrollH < dims.clientH * 2, 'Cannot inject enough content');

	const btn = page.getByTestId('btn-back-to-bottom');

	// 距底 = 0.5 屏（< 1 屏阈值）→ 按钮不应显示
	const halfScreenFromBottom = dims.scrollH - dims.clientH - Math.floor(dims.clientH * 0.5);
	await setMainScrollTop(page, halfScreenFromBottom);
	await expect(btn).not.toBeVisible();
});
