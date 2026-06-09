import { expect, test } from '@playwright/test';
import { login, evalStore } from './helpers.js';

/**
 * 桌面端内容 header 扁平化 E2E
 *
 * 锁定设计：ChatPage / FileManagerPage / ModelConfigPage 三处桌面端内容 header
 * 底色与正文一致（bg-default，而非旧的 bg-elevated），且保留底部 hairline 分隔（border-b）。
 *
 * 前置条件：
 * - server 运行中、test 用户已绑定且有 claw（用于拿到合法 clawId 进路由）
 * 注：header 由模板静态渲染、不依赖 RTC 连接，故只取一个 claw id 即可，不等 dcReady。
 */

const DESKTOP = { width: 1280, height: 720 };

/** 取一个已绑定 claw 的 id（优先在线，无则返回 null）；header 静态渲染、不依赖在线/连接，仅需合法路由参数 */
async function getClawId(page) {
	await page.goto('/topics');
	try {
		// 只需有已绑定 claw——header 静态渲染、不依赖在线/连接；
		// 若改等 online，会在 claw 离线时静默 skip，使这条扁平化回归守卫形同虚设
		await expect(async () => {
			const items = await evalStore(page, 'claws', 'return store.items');
			expect(items.length).toBeGreaterThan(0);
		}).toPass({ timeout: 15_000 });
	}
	catch {
		return null;
	}
	const items = await evalStore(page, 'claws', 'return store.items');
	// 优先在线 claw（路由更顺），无在线则任取一个已绑定的
	const claw = items.find((b) => b.online) ?? items[0];
	return claw?.id ?? null;
}

/**
 * 读取「桌面端唯一可见」内容 header 的关键样式，并与 bg-default / bg-elevated 探针比对。
 * 桌面视口下 MobilePageHeader（md:hidden）display:none，唯一可见 header 即内容 header。
 */
async function readHeaderStyle(page) {
	// 等可见 header 出现（与连接无关，模板静态渲染）
	await page.waitForFunction(() =>
		Array.from(document.querySelectorAll('header')).some((h) => getComputedStyle(h).display !== 'none'),
	{}, { timeout: 15_000 });
	return page.evaluate(() => {
		function probeBg(cls) {
			const el = document.createElement('div');
			el.className = cls;
			el.style.position = 'fixed';
			el.style.left = '-9999px';
			document.body.appendChild(el);
			const c = getComputedStyle(el).backgroundColor;
			el.remove();
			return c;
		}
		const header = Array.from(document.querySelectorAll('header'))
			.find((h) => getComputedStyle(h).display !== 'none');
		const cs = getComputedStyle(header);
		return {
			headerBg: cs.backgroundColor,
			borderBottomWidth: cs.borderBottomWidth,
			borderBottomStyle: cs.borderBottomStyle,
			defaultBg: probeBg('bg-default'),
			elevatedBg: probeBg('bg-elevated'),
		};
	});
}

function assertFlatHeader(s) {
	// 与正文同底色（bg-default），不再是抬升层（bg-elevated）
	expect(s.headerBg).toBe(s.defaultBg);
	expect(s.headerBg).not.toBe(s.elevatedBg);
	// 保留底部 hairline 分隔
	expect(parseFloat(s.borderBottomWidth)).toBeGreaterThan(0);
	expect(s.borderBottomStyle).not.toBe('none');
}

test('桌面内容 header 扁平：三处与正文同底色 + 保留 border-b @ui', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize(DESKTOP);
	await login(page);

	const clawId = await getClawId(page);
	test.skip(!clawId, 'No claw available for routing');

	// ChatPage
	await page.goto(`/chat/${clawId}/main`);
	assertFlatHeader(await readHeaderStyle(page));

	// FileManagerPage
	await page.goto(`/files/${clawId}/main`);
	assertFlatHeader(await readHeaderStyle(page));

	// ModelConfigPage
	await page.goto(`/claws/${clawId}/models`);
	assertFlatHeader(await readHeaderStyle(page));
});
