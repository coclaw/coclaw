import { expect, test } from '@playwright/test';
import { login } from './helpers.js';

/**
 * /home 路由解析 + catch-all E2E。
 *
 * /home 是过渡页（HomePage.vue）：
 * - 移动端（screen.ltMd）→ 直接 replace('/topics')
 * - 桌面端：等 claws 快照就绪后分派——无 claw → /claws/add；有 claw 但全离线 → /claws；
 *   有在线 claw → 跳该 claw 默认 agent 的 chat；5s 内未就绪 → fallback 跳 /claws
 *
 * 三态由 mock 数据驱动：claws 列表经 SSE（/api/v1/claws/status-stream，EventSource）灌入
 * clawsStore。这里在网络边界拦截该 SSE 注入受控快照——客户端从此只见 mock 的 claw 世界，
 * 真实 claw 的服务端状态/绑定完全不受影响（仅拦截本测试 context 对 SSE 的视图，绝不触碰
 * bindings.json，绝不解绑真实 claw）。每个 test 独立 context → 起始态干净。
 *
 * 标签：导航/解析，按 e2e-test skill 标签表归 @ui。
 */

const DESKTOP = { width: 1280, height: 720 };
const MOBILE = { width: 390, height: 844 };

/**
 * 拦截 claw 状态 SSE 并注入一份受控快照。必须在 login（首次受保护页导航触发 AuthedLayout
 * 启动 SSE）之前调用。
 * @param {import('@playwright/test').Page} page
 * @param {object[]} items - claw.snapshot 的 items（[] = 无 claw；[{online:false}] = 全离线；
 *   [{online:true}] = 有在线 claw）
 */
async function mockClawSnapshot(page, items) {
	await page.route('**/api/v1/claws/status-stream', async (route) => {
		// EventSource 默认 message 事件：仅 data: 行 + 空行即派发 onmessage；event 类型藏在 JSON 的 event 字段
		const body = `data: ${JSON.stringify({ event: 'claw.snapshot', items })}\n\n`;
		await route.fulfill({
			status: 200,
			headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
			body,
		});
	});
}

/**
 * 拦截 SSE 但永不回数据——模拟"claw 数据迟迟不到"。clawsStore.fetched 仅由 applySnapshot 翻 true，
 * 无快照 → 永不翻 → HomePage 的 5s 定时器走 fallback。
 * @param {import('@playwright/test').Page} page
 */
async function stallClawSnapshot(page) {
	await page.route('**/api/v1/claws/status-stream', () => {
		// 不 fulfill/continue：请求挂起、永不送达快照（context 关闭时由 Playwright 清理）
	});
}

// ================================================================
// 桌面解析 · 分支一：无 claw → /claws/add
// ================================================================
test('Home 解析（桌面）：无 claw → 跳添加 Claw 页 @ui', async ({ page }) => {
	test.setTimeout(45_000);
	await page.setViewportSize(DESKTOP);
	await mockClawSnapshot(page, []);
	await login(page);

	await page.goto('/home');
	await page.waitForURL(/\/claws\/add$/, { timeout: 15_000 });
	await expect(page).toHaveURL(/\/claws\/add$/);
});

// ================================================================
// 桌面解析 · 分支二：有 claw 但全部离线 → /claws
// ================================================================
test('Home 解析（桌面）：有 claw 但全部离线 → 跳 Claws 管理页 @ui', async ({ page }) => {
	test.setTimeout(45_000);
	await page.setViewportSize(DESKTOP);
	const mockId = `e2e-home-offline-${Date.now()}`;
	await mockClawSnapshot(page, [{ id: mockId, name: 'E2E Offline Mock', online: false }]);
	await login(page);

	await page.goto('/home');
	// 全离线 → /claws（注意区别于 /claws/add）
	await page.waitForURL(/\/claws$/, { timeout: 15_000 });
	await expect(page).toHaveURL(/\/claws$/);
});

// ================================================================
// 桌面解析 · 分支三：有在线 claw → 跳该 claw 默认 agent 的 chat
// ================================================================
test('Home 解析（桌面）：有在线 claw → 跳其默认 agent 的 chat @ui', async ({ page }) => {
	test.setTimeout(45_000);
	await page.setViewportSize(DESKTOP);
	const mockId = `e2e-home-online-${Date.now()}`;
	// 在线 mock claw：DC 永不就绪 → loadAgents 命中 getReadyConn null 守卫即时返回（不抛、不卡），
	// defaultId 落 'main' → 跳 /chat/<mockId>/main。仅触发一次对不存在 claw 的信令尝试（服务端拒绝，
	// 与真实 claw / 绑定零关联），不依赖真实 RTC 时序，因而确定性强。
	await mockClawSnapshot(page, [{ id: mockId, name: 'E2E Online Mock', online: true }]);
	await login(page);

	await page.goto('/home');
	await page.waitForURL(new RegExp(`/chat/${mockId}/main$`), { timeout: 15_000 });
	await expect(page).toHaveURL(new RegExp(`/chat/${mockId}/main$`));
});

// ================================================================
// 移动端解析：/home → /topics
// ================================================================
test('Home 解析（移动端）：/home 直接跳 /topics @ui', async ({ page }) => {
	test.setTimeout(30_000);
	await page.setViewportSize(MOBILE);
	await login(page); // 移动端 defaultRoute=/topics，登录后即落 /topics

	// 显式回 /home 验证移动端解析：HomePage 检测 ltMd → replace('/topics')
	await page.goto('/home');
	await page.waitForURL(/\/topics$/, { timeout: 10_000 });
	await expect(page).toHaveURL(/\/topics$/);
});

// ================================================================
// 解析超时：claws 数据迟迟不到 → 5s fallback 跳 /claws，不卡 loading
// ================================================================
test('Home 解析：claws 数据超时 → fallback 跳 /claws 不卡 loading @ui', async ({ page }) => {
	test.setTimeout(45_000);
	await stallClawSnapshot(page);
	// 先在移动视口登录落 /topics，避免桌面登录即落 /home 提前起一个解析实例干扰计时
	await page.setViewportSize(MOBILE);
	await login(page);
	await page.setViewportSize(DESKTOP); // 切桌面：HomePage 走桌面解析分支（screen 响应 resize）

	const t0 = Date.now();
	await page.goto('/home');
	// loading spinner 应出现（过渡页），随后超时 fallback
	await expect(page.locator('.animate-spin')).toBeVisible({ timeout: 5000 });
	await page.waitForURL(/\/claws$/, { timeout: 15_000 });
	await expect(page).toHaveURL(/\/claws$/);

	// 唯一解析路径是 5s 定时器（fetched 永不翻 true）→ 必经 ~5s 才落地，证明走的是 fallback 而非即时分派
	const elapsed = Date.now() - t0;
	expect(elapsed, `fallback should fire via the ~5s timer, elapsed=${elapsed}ms`).toBeGreaterThanOrEqual(4000);
});

// ================================================================
// 路由 catch-all：未知路径 → 经 /home 解析跳转
// ================================================================
test('路由 catch-all：未知路径经 /home 解析后跳转 @ui', async ({ page }) => {
	test.setTimeout(45_000);
	await page.setViewportSize(DESKTOP);
	await mockClawSnapshot(page, []); // 无 claw → /home 解析终点 /claws/add（确定性落点）
	await login(page);

	const bogus = `/no-such-route-${Date.now()}`;
	await page.goto(bogus);
	// catch-all redirect 到 /home → 桌面解析（无 claw）→ /claws/add
	await page.waitForURL(/\/claws\/add$/, { timeout: 15_000 });
	await expect(page).toHaveURL(/\/claws\/add$/);
	// 确认已离开未知路径（catch-all 生效，未停留）
	expect(page.url()).not.toContain('no-such-route');
});
