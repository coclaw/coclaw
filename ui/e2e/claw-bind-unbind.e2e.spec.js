import { execSync } from 'child_process';
import { expect, test } from '@playwright/test';
import { login, evalStore } from './helpers.js';
import { loginAndGetCookies, listClawIds, deleteClaw, readBaseline, addKeeper } from './claw-cleanup.js';

/**
 * Claw 绑定与解绑 E2E 测试
 *
 * 前置条件：
 * - server 运行中
 * - 本机 OpenClaw 实例运行中（openclaw gateway 已启动）
 * - openclaw-coclaw 插件已安装（通常已通过 `--link` 方式安装，无需重复安装）
 *
 * ⚠️ 绑定时不按界面提示在 OpenClaw 侧安装插件，仅执行 `openclaw coclaw bind <code>`。
 *    测试环境中插件已通过 `openclaw plugins install --link` 提前安装。
 *
 * 测试路径：
 * - UI 生成绑定码 → 本机 CLI 执行 bind → UI 检测成功 → 验证 claw 出现
 * - UI 执行解绑 → 验证 claw 移除
 *
 * 未测试路径：
 * - 通过 IM 对话发送绑定指令（当前无条件）
 */

/** 取应用当前语言下某个 i18n key 的渲染值，让断言与具体 locale 解耦（测试账号可能持久化 lang=zh-CN） */
async function tr(page, key) {
	return page.evaluate(async (k) => {
		const m = await import('/src/i18n/index.js');
		return m.i18n.global.t(k);
	}, key);
}

test('Claw 绑定与解绑：完整流程 @bind', async ({ page }) => {
	test.setTimeout(180_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	// 服务端清理用 cookie（独立于浏览器会话，同为 test 账号；供 flake 时补删本测试新建的 claw）
	const cookies = await loginAndGetCookies();

	// --- 记录绑定前的 claw 列表 ---
	await page.goto('/claws');
	await expect(page.getByTestId('btn-refresh-claws')).toBeVisible({ timeout: 10_000 });
	// 等待 claws store 加载完成
	await page.waitForTimeout(1000);
	const clawIdsBefore = await evalStore(page, 'claws', 'return store.items.map(b => String(b.id))');

	// shell 命令区域的 pre 元素（BIND 与 REBIND 共用，声明在 try 外）
	const preTags = page.locator('main pre');
	// 本测试新建的 claw id；中途 flake 时用于 finally 补删
	let newClawId = null;

	try {
		// ================================================================
		// BIND
		// ================================================================

		await page.goto('/claws/add');

		// 等待绑定码出现
		await expect(preTags.last()).toBeVisible({ timeout: 15_000 });

		// 从 shell 命令文本中提取绑定码
		const shellText = await preTags.last().textContent();
		const codeMatch = shellText.match(/bind\s+(\d+)/);
		expect(codeMatch).toBeTruthy();
		const bindingCode = codeMatch[1];
		console.log('[e2e] extracted binding code:', bindingCode);

		// 在本机执行 openclaw coclaw bind（插件已预装，不需要安装步骤）
		try {
			const output = execSync(
				`openclaw coclaw bind ${bindingCode} --server http://127.0.0.1:3000`,
				{ timeout: 30_000, encoding: 'utf-8', stdio: 'pipe' },
			);
			console.log('[e2e] openclaw bind output:', output.trim());
		}
		catch (err) {
			console.error('[e2e] openclaw bind failed:', err.stderr || err.message);
			throw new Error('openclaw coclaw bind failed: ' + (err.stderr || err.message));
		}

		// 等待 UI 检测到绑定成功 → 自动跳转到 /claws
		await expect(page).toHaveURL(/\/claws(?:\/)?$/, { timeout: 60_000 });

		// 等待页面加载完成
		await expect(page.getByTestId('btn-refresh-claws')).toBeVisible({ timeout: 10_000 });

		// 验证新 claw 出现在列表中
		await page.waitForTimeout(1000);
		const clawIdsAfter = await evalStore(page, 'claws', 'return store.items.map(b => String(b.id))');
		const newClawIds = clawIdsAfter.filter((id) => !clawIdsBefore.includes(id));
		expect(newClawIds.length).toBeGreaterThanOrEqual(1);
		newClawId = newClawIds[0];
		console.log('[e2e] new claw id:', newClawId);

		// 验证新 claw 的卡片可见
		const clawCard = page.getByTestId('claw-' + newClawId);
		await expect(clawCard).toBeVisible({ timeout: 5000 });

		// ================================================================
		// UNBIND（通过 Remove 确认 modal）
		// ================================================================

		// 1) 打开三点菜单 → 点"移除"菜单项 → 打开确认 modal（Remove 已收进菜单，popover 内容 teleport 到 body）
		await clawCard.getByTestId(`claw-menu-${newClawId}`).click();
		const removeItem = page.getByTestId(`claw-menu-remove-${newClawId}`);
		await expect(removeItem).toBeVisible({ timeout: 5_000 });
		await removeItem.click();

		// 2) modal 出现（标题取自 i18n，locale 无关——zh-CN 下是"移除 Claw"非"Remove Claw"），点 Confirm
		const removeTitle = await tr(page, 'claws.removeConfirmTitle');
		const confirmLabel = await tr(page, 'common.confirm');
		const removeModalTitle = page.getByText(removeTitle, { exact: true });
		await expect(removeModalTitle).toBeVisible({ timeout: 5_000 });
		const confirmBtn = page.getByRole('button', { name: confirmLabel });
		await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
		await confirmBtn.click();

		// 3) modal 同步关闭（修复点：之前出错时 modal 会卡住）
		await expect(removeModalTitle).not.toBeVisible({ timeout: 5_000 });

		// 4) claw 列表中不再包含该 id
		await expect(async () => {
			const currentIds = await evalStore(page, 'claws', 'return store.items.map(b => String(b.id))');
			expect(currentIds).not.toContain(newClawId);
		}).toPass({ timeout: 15_000 });

		// 5) 验证 claw 卡片不再可见
		await expect(clawCard).not.toBeVisible({ timeout: 5_000 });
	}
	finally {
		// 中途 flake（未走到 UNBIND）时，本测试新建的 claw 可能残留 → 服务端补删（幂等，已删返 404 也吞）。
		if (newClawId) {
			await deleteClaw(cookies, newClawId);
		}
	}

	// ================================================================
	// REBIND（恢复环境，避免后续测试因无 claw 而失败）
	// ================================================================

	await page.goto('/claws/add');
	await expect(preTags.last()).toBeVisible({ timeout: 15_000 });

	const rebindShellText = await preTags.last().textContent();
	const rebindMatch = rebindShellText.match(/bind\s+(\d+)/);
	expect(rebindMatch).toBeTruthy();
	const rebindCode = rebindMatch[1];
	console.log('[e2e] rebinding with code:', rebindCode);

	try {
		execSync(
			`openclaw coclaw bind ${rebindCode} --server http://127.0.0.1:3000`,
			{ timeout: 30_000, encoding: 'utf-8', stdio: 'pipe' },
		);
	}
	catch (err) {
		console.warn('[e2e] rebind failed (non-critical):', err.stderr || err.message);
	}

	// 等待重新绑定成功
	await expect(page).toHaveURL(/\/claws(?:\/)?$/, { timeout: 60_000 });
	await expect(page.getByTestId('btn-refresh-claws')).toBeVisible({ timeout: 10_000 });

	// 记录 keeper：rebind 后存活的非基线 claw 即本机新的本地绑定（gateway 现绑到它），
	// teardown 须保留，不能当孤儿误删。基线未抓取时 readBaseline().ids 为空，会把当前全部记为
	// keeper（无害：此情形 teardown 本就跳过清理）。
	const survivors = await listClawIds(cookies);
	const baseIds = readBaseline().ids;
	for (const id of survivors) {
		if (!baseIds.has(id)) {
			addKeeper(id);
		}
	}

	console.log('[e2e] claw bind/unbind flow completed, environment restored');
});

/**
 * 解绑 404 self-heal：当 server 返回 404（CLAW_NOT_FOUND）时，UI 应：
 *   - modal 同步关闭（不卡住）
 *   - 本地 claw 卡片仍消失（不需要刷新）
 *
 * 修复前的 bug：modal 保持打开，claw 卡片不消失，必须刷新浏览器才能恢复同步。
 *
 * 全程 mock、零真实副作用——绝不触碰真实在线 claw（它是其它 @chat/@rtc 用例的依赖）：
 *   - 屏蔽 claw 状态 SSE（/api/v1/claws/status-stream）：真实 claw 根本不进本页 store，
 *     既不动它，也避免 applySnapshot 把注入的假 claw 反复剔除（snapshot 会 evict 不在
 *     server 列表里的 claw）。
 *   - 经 setClaws 测试脚手架注入一个假的"已绑 claw"（offline，绕过生命周期副作用、不建 RTC）。
 *   - mock /api/v1/claws/unbind-by-user 仅对该假 claw 返 404。
 * 断言本地自愈剔除 + modal 同步关闭。整条不发任何真实解绑请求、对真实绑定零影响。
 */
test('Claw 解绑：server 返回 404 时仍本地剔除并关闭 modal @bind', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1280, height: 720 });

	// 屏蔽 claw 状态 SSE：必须在 login 前挂（AuthedLayout 登录后才开 EventSource）。
	// abort 后 EventSource 进 onerror 重试循环（被持续 abort），永不下发 claw.snapshot。
	await page.route('**/api/v1/claws/status-stream', (route) => route.abort());

	await login(page);
	await page.goto('/claws');
	await expect(page.getByTestId('btn-refresh-claws')).toBeVisible({ timeout: 10_000 });

	// 注入假的已绑 claw（offline，避免触发 RTC 连接）。fetched=true 让页面进入"已加载"态。
	const fakeId = `e2e-fake-404-${Date.now()}`;
	await evalStore(page, 'claws', `
		store.fetched = true;
		store.setClaws([{ id: ${JSON.stringify(fakeId)}, name: 'E2E Fake 404 Self-Heal', online: false }]);
		return true;
	`);

	const fakeCard = page.getByTestId('claw-' + fakeId);
	await expect(fakeCard).toBeVisible({ timeout: 5_000 });

	// mock server 返 404 CLAW_NOT_FOUND（仅解绑端点）
	await page.route('**/api/v1/claws/unbind-by-user', async (route) => {
		await route.fulfill({
			status: 404,
			contentType: 'application/json',
			body: JSON.stringify({ code: 'CLAW_NOT_FOUND', message: 'claw not found' }),
		});
	});

	// 打开三点菜单 → 点"移除"菜单项 → modal 出现（popover/modal 内容 teleport 到 body）
	await fakeCard.getByTestId(`claw-menu-${fakeId}`).click();
	await page.getByTestId(`claw-menu-remove-${fakeId}`).click();
	// 用 tr() 取当前 locale 下的真实文案，避免硬编码英文（测试账号持久化 lang=zh-CN）
	const removeTitle = await tr(page, 'claws.removeConfirmTitle');
	const confirmLabel = await tr(page, 'common.confirm');
	const removeModalTitle = page.getByText(removeTitle, { exact: true });
	await expect(removeModalTitle).toBeVisible({ timeout: 5_000 });

	// 点 Confirm → mock 返 404
	await page.getByRole('button', { name: confirmLabel }).click();

	// 修复点 A：modal 同步关闭（即便 server 返错）
	await expect(removeModalTitle).not.toBeVisible({ timeout: 3_000 });

	// 修复点 B：404 self-heal 路径 — 本地仍剔除该假 claw（SSE 已屏蔽，不会被 snapshot 加回）
	await expect(fakeCard).not.toBeVisible({ timeout: 5_000 });
	await expect(async () => {
		const ids = await evalStore(page, 'claws', 'return store.items.map(b => String(b.id))');
		expect(ids).not.toContain(fakeId);
	}).toPass({ timeout: 5_000 });

	await page.unroute('**/api/v1/claws/unbind-by-user');
	console.log('[e2e] claw 404 self-heal verified via injected fake claw; no real binding touched');
});
