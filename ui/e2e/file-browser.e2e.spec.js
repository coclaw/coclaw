import { expect, test } from '@playwright/test';
import { login, evalStore } from './helpers.js';

/**
 * 文件浏览器 UI E2E 测试
 *
 * 前置条件：
 * - server、OpenClaw gateway、plugin 均运行中
 * - test 用户已绑定 bot 且 bot 在线
 */

// ================================================================
// Helpers
// ================================================================

/** 等待 bot 在线且 WS/RTC 连接就绪，返回 { botId, agentId } */
async function waitBotConnected(page, timeout = 30_000) {
	try {
		await expect(async () => {
			const items = await evalStore(page, 'bots', 'return store.items');
			const online = items.find((b) => b.online && b.connState === 'connected');
			expect(online).toBeTruthy();
		}).toPass({ timeout });
		const items = await evalStore(page, 'bots', 'return store.items');
		const bot = items.find((b) => b.online && b.connState === 'connected');
		return { botId: bot.id, agentId: 'main' };
	} catch {
		return null;
	}
}

/** 导航到文件管理页，等待目录列表加载完成 */
async function gotoFilesReady(page, botId, agentId) {
	await page.goto(`/files/${botId}/${agentId}`);
	// 等待面包屑 Root 按钮可见
	await expect(page.getByRole('button', { name: /Root|根目录/ })).toBeVisible({ timeout: 15_000 });
	// 等待一下让 loadDir 完成
	await page.waitForTimeout(2000);
}

/** RPC 直接清理路径 */
async function cleanupPath(page, botId, agentId, path) {
	try {
		await page.evaluate(async ({ botId, agentId, path }) => {
			const { useBotConnections } = await import('/src/services/bot-connection-manager.js');
			const { deleteFile } = await import('/src/services/file-transfer.js');
			const conn = useBotConnections().get(botId);
			if (conn) await deleteFile(conn, agentId, path, { force: true });
		}, { botId, agentId, path });
	} catch { /* ignore */ }
}

/** 通用前置：登录 → topics 页等 bot 连接就绪 */
async function setup(page, t) {
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);
	await page.goto('/topics');
	const bot = await waitBotConnected(page);
	t.skip(!bot, 'No online bot available');
	return bot;
}

/** 获取 transport mode */
async function getTransportMode(page, botId) {
	return evalStore(page, 'bots', `
		const b = store.byId['${botId}'];
		return b?.transportMode ?? null;
	`);
}

// ================================================================
// Tests
// ================================================================

test.describe('文件浏览器 @file', () => {
	test.setTimeout(60_000);

	test('目录浏览 — 打开文件管理页', async ({ page }) => {
		const bot = await setup(page, test);
		await gotoFilesReady(page, bot.botId, bot.agentId);

		// 面包屑 Root 可见
		await expect(page.getByRole('button', { name: /Root|根目录/ })).toBeVisible();
		// 桌面端标题可见（第二个 h1 是桌面端的，第一个是移动端 hidden）
		await expect(page.getByRole('heading', { name: /Agent 文件|Agent Files/ }).last()).toBeVisible();
	});

	test('创建目录 → 进入 → 返回 → 删除', async ({ page }) => {
		const bot = await setup(page, test);
		const dirName = `__e2e_dir_${Date.now()}`;

		await gotoFilesReady(page, bot.botId, bot.agentId);

		// 通过 RPC 创建目录（如果 bot 实际 offline 则 skip）
		try {
			await page.evaluate(async ({ botId, agentId, dir }) => {
				const { useBotConnections } = await import('/src/services/bot-connection-manager.js');
				const { mkdirFiles } = await import('/src/services/file-transfer.js');
				const conn = useBotConnections().get(botId);
				if (!conn) throw new Error('no conn');
				await mkdirFiles(conn, agentId, dir);
			}, { botId: bot.botId, agentId: bot.agentId, dir: dirName });
		} catch {
			test.skip('Bot RPC not available (bot may be offline)');
			return;
		}

		// 刷新列表（点击 refresh 按钮——面包屑行右侧最后一个按钮）
		const refreshBtn = page.locator('.border-default').filter({ has: page.getByRole('button', { name: /Root|根目录/ }) }).locator('button').last();
		await refreshBtn.click();
		await page.waitForTimeout(2000);

		// 目录应出现在列表中
		const dirEntry = page.locator('main p').filter({ hasText: dirName });
		await expect(dirEntry).toBeVisible({ timeout: 10_000 });

		// 点击进入目录
		await dirEntry.click();

		// 面包屑应显示目录名
		await expect(page.locator('nav').getByText(dirName)).toBeVisible({ timeout: 5000 });

		// 显示空目录提示
		await expect(page.getByText(/空目录|Empty directory/)).toBeVisible({ timeout: 5000 });

		// 点击面包屑 Root 返回
		await page.getByRole('button', { name: /Root|根目录/ }).click();
		await page.waitForTimeout(1000);

		// 目录仍在
		await expect(page.locator('main p').filter({ hasText: dirName })).toBeVisible({ timeout: 5000 });

		// 清理
		await cleanupPath(page, bot.botId, bot.agentId, dirName);

		// 刷新验证
		await refreshBtn.click();
		await expect(page.locator('main p').filter({ hasText: dirName })).not.toBeVisible({ timeout: 10_000 });
	});

	test('文件上传 → 下载 → 清理', async ({ page }) => {
		const bot = await setup(page, test);
		const mode = await getTransportMode(page, bot.botId);
		test.skip(mode !== 'rtc', 'Not in RTC mode, skipping file upload/download');

		const dirName = `__e2e_upload_${Date.now()}`;
		const fileName = 'test-upload.txt';

		await gotoFilesReady(page, bot.botId, bot.agentId);

		// RPC 创建测试目录
		try {
			await page.evaluate(async ({ botId, agentId, dir }) => {
				const { useBotConnections } = await import('/src/services/bot-connection-manager.js');
				const { mkdirFiles } = await import('/src/services/file-transfer.js');
				const conn = useBotConnections().get(botId);
				if (!conn) throw new Error('no conn');
				await mkdirFiles(conn, agentId, dir);
			}, { botId: bot.botId, agentId: bot.agentId, dir: dirName });
		} catch {
			test.skip('Bot RPC not available');
			return;
		}

		// 刷新并进入目录
		const refreshBtn = page.locator('.border-default').filter({ has: page.getByRole('button', { name: /Root|根目录/ }) }).locator('button').last();
		await refreshBtn.click();
		await page.waitForTimeout(2000);
		await page.locator('main p').filter({ hasText: dirName }).click();
		await expect(page.locator('nav').getByText(dirName)).toBeVisible({ timeout: 5000 });

		// 上传文件
		const fileInput = page.locator('input[type="file"]');
		await fileInput.setInputFiles({
			name: fileName,
			mimeType: 'text/plain',
			buffer: Buffer.from(`E2E test ${Date.now()}`, 'utf-8'),
		});

		// 等待上传完成
		await expect(page.locator('main p').filter({ hasText: fileName })).toBeVisible({ timeout: 20_000 });

		// 下载
		const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
		await page.locator('main p').filter({ hasText: fileName }).click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toBe(fileName);

		// 清理
		await cleanupPath(page, bot.botId, bot.agentId, dirName);
	});

	test('ChatPage header 有文件管理入口', async ({ page }) => {
		const bot = await setup(page, test);

		// 检查 pluginVersionOk（若为 false，openFiles 会被拦截，跳过此测试）
		const pluginOk = await evalStore(page, 'bots', `return store.byId['${bot.botId}']?.pluginVersionOk`);
		test.skip(pluginOk === false, 'Plugin version outdated, files button blocked');

		// 直接导航到 chat
		await page.goto(`/chat/${bot.botId}/${bot.agentId}`);
		// 等待桌面端 header h1 可见
		await expect(page.getByRole('heading', { level: 1 }).last()).toBeVisible({ timeout: 15_000 });

		// 找可见的 btn-files
		const filesBtns = page.getByTestId('btn-files');
		await expect(async () => {
			let visible = false;
			for (let i = 0; i < await filesBtns.count(); i++) {
				if (await filesBtns.nth(i).isVisible()) { visible = true; break; }
			}
			expect(visible).toBe(true);
		}).toPass({ timeout: 10_000 });

		// 点击
		for (let i = 0; i < await filesBtns.count(); i++) {
			if (await filesBtns.nth(i).isVisible()) {
				await filesBtns.nth(i).click();
				break;
			}
		}

		await page.waitForURL(/\/files\//, { timeout: 5000 });
		await expect(page.getByRole('button', { name: /Root|根目录/ })).toBeVisible({ timeout: 10_000 });
	});
});
