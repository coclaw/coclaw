import { test, expect } from '@playwright/test';
import { login, evalStore } from './helpers.js';

/**
 * 添加 Claw 引导页 + Claw 重命名 E2E 覆盖（@bind）
 *
 * 安全约束（与 claw-bind-unbind.e2e.spec.js 互补，不重复其绑定/解绑路径）：
 * - 本文件**绝不改动网关的绑定槽**：AddClawPage 仅向 server「生成绑定码」（不绑任何 claw），
 *   过期/拉码失败两条用例用 page.route 拦截拉码请求、不打真服务端。
 * - 重命名走 Modify-Revert：改完必须改回原名（finally 兜底）。重命名只改 plugin 侧展示名，
 *   不触碰 server 绑定关系。
 *
 * 覆盖增量（claim 的拉码/认领、bind-unbind 的真实绑定/解绑已有，这里不再覆盖）：
 *   1. AddClawPage 展示「对话」「终端」两种接入引导
 *   2. 复制对话/终端命令 → 显示「已复制」反馈（只断反馈 UI，不读系统剪贴板）
 *   3. 拉码失败 → 错误态 + 重试入口，点重试重新发起
 *   4. 绑定码过期 → 过期态 + 「重新开始」重新拉码
 *   5. 管理页重命名某 claw → 名称更新（改回原名）
 */

/**
 * 取应用当前 locale 下某个 i18n key 的渲染值，让断言与具体语言解耦（测试账号可能持久化 lang=zh-CN）。
 *
 * 先等 session user 落地：locale 在 applyUserPreferences(user) 里经 setLocale 应用，发生在
 * login 后的会话拉取之后；过早读 i18n 会拿到 bootstrap 默认 locale（en），与界面实际渲染（zh-CN）不符。
 */
async function tr(page, key) {
	await expect(async () => {
		const ready = await page.evaluate(() => {
			const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
			return Boolean(pinia?._s?.get('auth')?.user);
		});
		expect(ready).toBe(true);
	}).toPass({ timeout: 10_000 });
	return page.evaluate(async (k) => {
		const m = await import('/src/i18n/index.js');
		return m.i18n.global.t(k);
	}, key);
}

// 仅匹配「生成绑定码」的 POST /api/v1/claws/binding-codes（末尾无 /:code），
// 不误伤 cancelBindingCode 的 DELETE /api/v1/claws/binding-codes/<code>。
const BINDING_CODES_RE = /\/api\/v1\/claws\/binding-codes(\?.*)?$/;

test.describe('添加 Claw 引导与重命名 @bind', () => {
	test('AddClawPage 展示对话与终端两种接入引导', async ({ page }) => {
		await login(page);
		await page.goto('/claws/add');

		// 两个引导区块各有一段命令 pre（方式一对话 / 方式二终端）
		const pres = page.locator('main pre');
		await expect(pres).toHaveCount(2, { timeout: 15_000 });

		// 两个入口标题都在（用 tr 读当前 locale 实际文案，locale 无关）
		const chatTitle = await tr(page, 'claws.chatMethodTitle');
		const shellTitle = await tr(page, 'claws.shellMethodTitle');
		await expect(page.getByText(chatTitle, { exact: true })).toBeVisible();
		await expect(page.getByText(shellTitle, { exact: true })).toBeVisible();

		// 两段命令都带上同一个绑定码（终端命令含固定的 `bind <code>`，从中提取后核对对话块也含它）
		const shellText = await pres.nth(1).textContent();
		const codeMatch = shellText.match(/bind\s+(\d+)/);
		expect(codeMatch).toBeTruthy();
		const code = codeMatch[1];
		await expect(pres.nth(0)).toContainText(code);
	});

	test('复制对话/终端命令显示已复制反馈', async ({ page }) => {
		// 授予剪贴板权限：复制成功才会切到「已复制」反馈（写失败会走 notify.error 分支）
		await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
		await login(page);
		await page.goto('/claws/add');

		const pres = page.locator('main pre');
		await expect(pres).toHaveCount(2, { timeout: 15_000 });

		const copyLabel = await tr(page, 'claws.copy');
		const copiedLabel = await tr(page, 'claws.commandCopied');

		// 每个命令块结构：bg-elevated 容器 = pre 的父节点，内含「复制」按钮与「已复制」反馈
		for (const idx of [0, 1]) {
			const container = pres.nth(idx).locator('xpath=..');
			await container.getByRole('button', { name: copyLabel, exact: true }).click();
			// 只断反馈 UI 出现，不读系统剪贴板内容
			await expect(container.getByText(copiedLabel, { exact: true })).toBeVisible({ timeout: 5000 });
		}
	});

	test('拉码失败显示错误与重试，点重试重新发起', async ({ page }) => {
		await login(page);

		// 首次拉码注入 500、第二次（重试）放行成功
		let createCalls = 0;
		await page.route(BINDING_CODES_RE, async (route) => {
			if (route.request().method() !== 'POST') {
				await route.continue();
				return;
			}
			createCalls++;
			if (createCalls === 1) {
				await route.fulfill({
					status: 500,
					contentType: 'application/json',
					body: JSON.stringify({ message: 'e2e injected failure' }),
				});
			}
			else {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ code: '87654321', expiresAt: new Date(Date.now() + 300_000).toISOString(), waitToken: 'e2e' }),
				});
			}
		});

		await page.goto('/claws/add');

		// 错误态：重试按钮可见、引导尚未渲染
		const retryLabel = await tr(page, 'claws.retry');
		const retryBtn = page.getByRole('button', { name: retryLabel, exact: true });
		await expect(retryBtn).toBeVisible({ timeout: 15_000 });
		await expect(page.locator('main pre')).toHaveCount(0);

		// 点重试 → 重新发起拉码（第二次成功）→ 引导出现，证明重试确实重新请求
		await retryBtn.click();
		await expect(page.locator('main pre')).toHaveCount(2, { timeout: 15_000 });
		expect(createCalls).toBe(2);
	});

	test('绑定码过期后可重新开始', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 720 });
		await login(page);

		// 首次返回「已过期」的 expiresAt（倒计时首 tick 即判过期），第二次返回有效码
		let createCalls = 0;
		await page.route(BINDING_CODES_RE, async (route) => {
			if (route.request().method() !== 'POST') {
				await route.continue();
				return;
			}
			createCalls++;
			const expiresAt = createCalls === 1
				? new Date(Date.now() - 1000).toISOString()
				: new Date(Date.now() + 300_000).toISOString();
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ code: createCalls === 1 ? '12345678' : '24681357', expiresAt, waitToken: 'e2e' }),
			});
		});

		await page.goto('/claws/add');

		// 过期态：「重新开始」按钮可见（桌面宽度下只有顶部那枚可见），引导不渲染
		const restartLabel = await tr(page, 'claws.restart');
		const restartBtn = page.getByRole('button', { name: restartLabel, exact: true }).filter({ visible: true });
		await expect(restartBtn).toBeVisible({ timeout: 15_000 });
		await expect(page.locator('main pre')).toHaveCount(0);

		// 点重新开始 → 重新拉码（第二次有效）→ 引导出现
		await restartBtn.click();
		await expect(page.locator('main pre')).toHaveCount(2, { timeout: 15_000 });
		expect(createCalls).toBe(2);
	});

	test('管理页重命名 claw 后名称更新并改回原名', async ({ page }) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1280, height: 720 });
		await login(page);

		await page.goto('/claws');
		await expect(page.getByTestId('btn-refresh-claws')).toBeVisible({ timeout: 10_000 });

		// 重命名走 DC RPC（coclaw.info.patch），需要一个 online 且 DC 就绪的 claw
		await expect(async () => {
			const items = await evalStore(page, 'claws', 'return store.items.map(c => ({ online: c.online, dcReady: c.dcReady }))');
			expect(items.some((c) => c.online && c.dcReady)).toBe(true);
		}).toPass({ timeout: 60_000 });

		// 取目标 claw + 原始名（rawName=plugin 侧已设的 name；displayed=卡片实际展示名）
		const target = await evalStore(page, 'claws', `
			const c = store.items.find(x => x.online && x.dcReady);
			if (!c) return null;
			const pi = c.pluginInfo || {};
			const displayed = pi.name || pi.hostName || c.name || 'OpenClaw';
			return { id: String(c.id), rawName: pi.name || '', displayed };
		`);
		expect(target).toBeTruthy();

		const card = page.getByTestId('claw-' + target.id);
		const nameHeading = card.locator('h2').first();
		const confirmLabel = await tr(page, 'common.confirm');
		const newName = `e2e-rename-${Date.now()}`;

		// 经三点菜单 → 重命名项 → 弹窗输入 → 确认；成功后弹窗关闭
		async function doRename(name) {
			await page.getByTestId(`claw-menu-${target.id}`).click();
			const renameItem = page.getByTestId(`claw-menu-rename-${target.id}`);
			await expect(renameItem).toBeVisible({ timeout: 5000 });
			await renameItem.click();
			const input = page.locator('[role="dialog"] input');
			await expect(input).toBeVisible({ timeout: 5000 });
			await input.fill(name);
			await page.locator('[role="dialog"]').getByRole('button', { name: confirmLabel, exact: true }).click();
			await expect(page.locator('[role="dialog"]')).toBeHidden({ timeout: 10_000 });
		}

		let renamed = false;
		try {
			await doRename(newName);
			renamed = true;
			await expect(nameHeading).toHaveText(newName, { timeout: 10_000 });
		}
		finally {
			// Modify-Revert：无论中途断言成败，只要改过名就必须改回原名
			if (renamed) {
				const revertName = target.rawName || target.displayed;
				await doRename(revertName);
				await expect(nameHeading).toHaveText(target.displayed, { timeout: 10_000 });
			}
		}
	});
});
