import { expect, test } from '@playwright/test';
import { login } from './helpers.js';

/**
 * Web Agent 功能 E2E
 *
 * 校验：
 * 1. MainList 底部"添加 Web Agent"入口可点击 → 弹出 picker dialog
 * 2. Dialog 内 5 项预置按 sort 顺序排列（DeepSeek/豆包/千问/Kimi/元宝）
 * 3. 点击某项 → window.open 被 stub 捕获、dialog 关闭、最近使用项出现在混排 agent 列表里
 * 4. 重新打开 dialog → 顺序仍按 sort（不被点击行为影响）
 *
 * 前置：
 * - server 在跑（启动时 syncPresets 已写入 DB）
 * - test 用户已存在（globalSetup 处理）
 */

const PRESET_SLUGS_IN_SORT_ORDER = ['deepseek', 'doubao', 'qwen', 'kimi', 'yuanbao'];

async function stubWindowOpen(page) {
	// 在每个 navigation 之前注入：替换 window.open 为收集器，避免真实新开标签页
	await page.addInitScript(() => {
		window.__openedUrls = [];
		window.open = (url) => {
			window.__openedUrls.push(String(url));
			return null;
		};
	});
}

async function getOpenedUrls(page) {
	return page.evaluate(() => window.__openedUrls || []);
}

/**
 * 桌面默认视口（>md）下 MainList 同时挂在 <aside class="md:flex">（DesktopSidebar）和 <main>（TopicsPage），
 * 两份 DOM 都带相同 data-testid，page.getByTestId 会撞 strict-mode 报错。
 * 用 <main> 作 scope 一致定位 MainList 内的项。Picker dialog / menu 走 UModal/UPopover teleport 到 body，
 * 保持 page 级查询。详见 ui/TODO.md "Web Agent E2E 在桌面视口下 strict-mode 重复定位"。
 */
function mainScope(page) {
	return page.getByRole('main');
}

test('Web Agent：底部"添加 Web Agent"入口打开 picker dialog 并按 sort 顺序展示 5 项 @ui', async ({ page }) => {
	test.setTimeout(45_000);
	await stubWindowOpen(page);
	await login(page);
	await page.goto('/topics');

	// 底部入口可见可点
	const entry = mainScope(page).getByTestId('bottom-action-add-web-agent');
	await expect(entry).toBeVisible({ timeout: 10_000 });
	await entry.click();

	// dialog 出现
	await expect(page.getByTestId('web-agent-picker-dialog')).toBeVisible({ timeout: 5_000 });

	// 5 项预置全部出现
	for (const slug of PRESET_SLUGS_IN_SORT_ORDER) {
		await expect(page.getByTestId(`web-agent-item-${slug}`)).toBeVisible();
	}

	// 顺序断言：按 DOM 顺序枚举 testid 应等于预期
	const orderedTestIds = await page.evaluate(() => {
		// 排除 panel 内子元素 web-agent-item-vendor —— 那是行内 vendor 标签的 testid，不算列表项本身
		const nodes = document.querySelectorAll('[data-testid^="web-agent-item-"]:not([data-testid="web-agent-item-vendor"])');
		return Array.from(nodes).map((n) => n.getAttribute('data-testid'));
	});
	expect(orderedTestIds).toEqual(PRESET_SLUGS_IN_SORT_ORDER.map((s) => `web-agent-item-${s}`));
});

test('Web Agent：点击某项 → window.open 被调用 + dialog 关闭 + 最近分组出现该项 @ui', async ({ page }) => {
	test.setTimeout(45_000);
	await stubWindowOpen(page);
	await login(page);
	await page.goto('/topics');

	await mainScope(page).getByTestId('bottom-action-add-web-agent').click();
	await expect(page.getByTestId('web-agent-picker-dialog')).toBeVisible({ timeout: 5_000 });

	// 点 DeepSeek
	await page.getByTestId('web-agent-item-deepseek').click();

	// dialog 关闭
	await expect(page.getByTestId('web-agent-picker-dialog')).not.toBeVisible({ timeout: 5_000 });

	// window.open 被 stub 捕获
	const opened = await getOpenedUrls(page);
	expect(opened.length).toBeGreaterThan(0);
	expect(opened[opened.length - 1]).toContain('chat.deepseek.com');

	// 混排 agent 列表中出现 DeepSeek 且 web-agent-recent-* 中位列第一（最新点击 → top）
	// 此断言对历史数据残留鲁棒：即使 test 用户从前次跑残留有其它 click 记录，
	// 本次新点击会让 DeepSeek 的 lastClickedAt 严格大于历史值，必排在最前
	await expect(mainScope(page).getByTestId('web-agent-recent-deepseek')).toBeVisible({ timeout: 10_000 });
	const orderedRecentIds = await page.evaluate(() => {
		const main = document.querySelector('main');
		if (!main) return [];
		return Array.from(main.querySelectorAll('[data-testid^="web-agent-recent-"]'))
			.map((n) => n.getAttribute('data-testid'));
	});
	expect(orderedRecentIds[0]).toBe('web-agent-recent-deepseek');
});

test('Web Agent：从混排列表直接点跳转（不经 dialog 路径）@ui', async ({ page }) => {
	// 主用例外的另一条主路径——重复使用同一个 Web Agent 时用户在混排列表上直点，
	// dialog 方式下 Panel 的 onSelect 跑了一遍，混排列表项的 onClickRecentWebAgent
	// 是另一段独立代码，必须各自校验
	test.setTimeout(60_000);
	await stubWindowOpen(page);
	await login(page);
	await page.goto('/topics');

	// 先从 dialog 点过 Qwen，让混排列表里出现它
	await mainScope(page).getByTestId('bottom-action-add-web-agent').click();
	await expect(page.getByTestId('web-agent-picker-dialog')).toBeVisible({ timeout: 5_000 });
	await page.getByTestId('web-agent-item-qwen').click();
	await expect(page.getByTestId('web-agent-picker-dialog')).not.toBeVisible({ timeout: 5_000 });
	await expect(mainScope(page).getByTestId('web-agent-recent-qwen')).toBeVisible({ timeout: 10_000 });

	// 清掉前面 dialog 路径捕获的 URL，便于之后只看混排列表路径的产物
	const beforeCount = await page.evaluate(() => window.__openedUrls.length);

	// 直接点混排列表里的 Qwen（scope 到 main，避开 sidebar 重复 DOM）
	await mainScope(page).getByTestId('web-agent-recent-qwen').click();

	const opened = await getOpenedUrls(page);
	expect(opened.length).toBe(beforeCount + 1);
	expect(opened[opened.length - 1]).toContain('qianwen.com');

	// 不应该弹出 dialog（混排列表直点不走 picker）
	await expect(page.getByTestId('web-agent-picker-dialog')).not.toBeVisible();
});

test('Web Agent：先后点不同条目 → 混排列表按最新点击在前 @ui', async ({ page }) => {
	// 钉死设计契约："按 lastClickedAt DESC"——回归会让用户最常用的项被埋到下面
	test.setTimeout(60_000);
	await stubWindowOpen(page);
	await login(page);
	await page.goto('/topics');

	// 第一次点 Yuanbao
	await mainScope(page).getByTestId('bottom-action-add-web-agent').click();
	await expect(page.getByTestId('web-agent-picker-dialog')).toBeVisible();
	await page.getByTestId('web-agent-item-yuanbao').click();
	await expect(page.getByTestId('web-agent-picker-dialog')).not.toBeVisible({ timeout: 5_000 });
	await expect(mainScope(page).getByTestId('web-agent-recent-yuanbao')).toBeVisible({ timeout: 10_000 });

	// 等至少 1ms，避免相邻点击的 lastClickedAt 撞到同一毫秒
	await page.waitForTimeout(20);

	// 第二次点 Doubao
	await mainScope(page).getByTestId('bottom-action-add-web-agent').click();
	await expect(page.getByTestId('web-agent-picker-dialog')).toBeVisible();
	await page.getByTestId('web-agent-item-doubao').click();
	await expect(page.getByTestId('web-agent-picker-dialog')).not.toBeVisible({ timeout: 5_000 });

	// 混排列表中 web 项 [Doubao, Yuanbao]——最新的在前；可能还有更老的历史项排在后面，OK
	const orderedRecentIds = await page.evaluate(() => {
		const main = document.querySelector('main');
		if (!main) return [];
		return Array.from(main.querySelectorAll('[data-testid^="web-agent-recent-"]'))
			.map((n) => n.getAttribute('data-testid'));
	});
	const idxDoubao = orderedRecentIds.indexOf('web-agent-recent-doubao');
	const idxYuanbao = orderedRecentIds.indexOf('web-agent-recent-yuanbao');
	expect(idxDoubao).toBeGreaterThanOrEqual(0);
	expect(idxYuanbao).toBeGreaterThanOrEqual(0);
	expect(idxDoubao).toBeLessThan(idxYuanbao);
});

test('Web Agent：5 个预置点击后跳的 URL 各自正确 @ui', async ({ page }) => {
	// 仅 DeepSeek 的 URL 当前被钉，其它 4 个的映射出现拼写/复制粘贴错都会逃过现有断言
	test.setTimeout(90_000);
	await stubWindowOpen(page);
	await login(page);
	await page.goto('/topics');

	const expectedDomains = {
		deepseek: 'chat.deepseek.com',
		doubao: 'doubao.com',
		qwen: 'qianwen.com',
		kimi: 'kimi.com',
		yuanbao: 'yuanbao.tencent.com',
	};

	for (const [slug, domain] of Object.entries(expectedDomains)) {
		await mainScope(page).getByTestId('bottom-action-add-web-agent').click();
		await expect(page.getByTestId('web-agent-picker-dialog')).toBeVisible({ timeout: 5_000 });
		await page.getByTestId(`web-agent-item-${slug}`).click();
		await expect(page.getByTestId('web-agent-picker-dialog')).not.toBeVisible({ timeout: 5_000 });

		const opened = await getOpenedUrls(page);
		const last = opened[opened.length - 1] ?? '';
		expect(last, `slug=${slug} should hit ${domain}`).toContain(domain);
	}
});

test('Web Agent：从混排列表点尾部三点 → 移除 → 该项立刻消失；再次点击 picker 中同项 → 又出现 @ui', async ({ page }) => {
	// 钉死设计契约：hide 立即从混排列表消失（无确认对话框、无 toast）；
	// 再次点击 picker 中同项触发 server 端"再点取消隐藏"，混排列表重新出现该项
	test.setTimeout(60_000);
	await stubWindowOpen(page);
	await login(page);
	await page.goto('/topics');

	// 1. 先让 Kimi 进入混排列表
	await mainScope(page).getByTestId('bottom-action-add-web-agent').click();
	await expect(page.getByTestId('web-agent-picker-dialog')).toBeVisible({ timeout: 5_000 });
	await page.getByTestId('web-agent-item-kimi').click();
	await expect(page.getByTestId('web-agent-picker-dialog')).not.toBeVisible({ timeout: 5_000 });
	const kimiRecent = mainScope(page).getByTestId('web-agent-recent-kimi');
	await expect(kimiRecent).toBeVisible({ timeout: 10_000 });

	// 2. 找到该 recent 行的尾部三点按钮（用相对定位绕过 webAgentId 不可知；scope 到 main 避开 sidebar 重复）
	const kimiRow = mainScope(page).locator('div:has(> [data-testid="web-agent-recent-kimi"])');
	const kebab = kimiRow.locator('[data-testid^="web-agent-actions-trigger-"]');
	await expect(kebab).toHaveCount(1);
	// 触屏 hover 显隐：直接 click，CSS opacity-0 不影响事件分发
	await kebab.click();

	// 3. 菜单"移除"项出现并点击
	const removeBtn = page.locator('[data-testid^="web-agent-actions-remove-"]');
	await expect(removeBtn).toBeVisible({ timeout: 5_000 });
	await removeBtn.click();

	// 4. Kimi 立刻从混排列表消失
	await expect(mainScope(page).getByTestId('web-agent-recent-kimi')).not.toBeVisible({ timeout: 5_000 });

	// 5. 重新打开 picker 点 Kimi → 服务端 "再点取消隐藏" → 混排列表又出现
	await mainScope(page).getByTestId('bottom-action-add-web-agent').click();
	await expect(page.getByTestId('web-agent-picker-dialog')).toBeVisible({ timeout: 5_000 });
	await page.getByTestId('web-agent-item-kimi').click();
	await expect(page.getByTestId('web-agent-picker-dialog')).not.toBeVisible({ timeout: 5_000 });
	await expect(mainScope(page).getByTestId('web-agent-recent-kimi')).toBeVisible({ timeout: 10_000 });
});

test('Web Agent：重新打开 picker dialog 后顺序仍按 sort（不被点击行为影响）@ui', async ({ page }) => {
	test.setTimeout(45_000);
	await stubWindowOpen(page);
	await login(page);
	await page.goto('/topics');

	// 第一次：点 Kimi
	await mainScope(page).getByTestId('bottom-action-add-web-agent').click();
	await expect(page.getByTestId('web-agent-picker-dialog')).toBeVisible();
	await page.getByTestId('web-agent-item-kimi').click();
	await expect(page.getByTestId('web-agent-picker-dialog')).not.toBeVisible({ timeout: 5_000 });

	// 第二次打开
	await mainScope(page).getByTestId('bottom-action-add-web-agent').click();
	await expect(page.getByTestId('web-agent-picker-dialog')).toBeVisible();

	const orderedTestIds = await page.evaluate(() => {
		// 排除 panel 内子元素 web-agent-item-vendor —— 那是行内 vendor 标签的 testid，不算列表项本身
		const nodes = document.querySelectorAll('[data-testid^="web-agent-item-"]:not([data-testid="web-agent-item-vendor"])');
		return Array.from(nodes).map((n) => n.getAttribute('data-testid'));
	});
	expect(orderedTestIds).toEqual(PRESET_SLUGS_IN_SORT_ORDER.map((s) => `web-agent-item-${s}`));
});
