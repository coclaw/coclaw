import { expect, test } from '@playwright/test';
import { login, evalStore } from './helpers.js';

/**
 * 文件浏览器 UI E2E 测试
 *
 * 前置条件：
 * - server、OpenClaw gateway、plugin 均运行中
 * - test 用户已绑定 claw 且 claw 在线
 * - 本地环境 WebRTC 连接几乎 100% 可建立
 */

// ================================================================
// Helpers
// ================================================================

/** 等待 claw 在线�� RTC 连接就绪 */
async function waitClawReady(page, timeout = 30_000) {
	try {
		await expect(async () => {
			const items = await evalStore(page, 'claws', 'return store.items');
			const ready = items.find((b) => b.online && b.connState === 'connected' && b.transportMode === 'rtc');
			expect(ready).toBeTruthy();
		}).toPass({ timeout });
		const items = await evalStore(page, 'claws', 'return store.items');
		const claw = items.find((b) => b.online && b.connState === 'connected' && b.transportMode === 'rtc');
		return { clawId: claw.id, agentId: 'main' };
	} catch {
		return null;
	}
}

/** 通用前置：登录 → topics 页等 claw + RTC 就绪 */
async function setup(page, t) {
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);
	// topics ���触发 claw 连接�� RTC 建连
	await page.goto('/topics');
	const claw = await waitClawReady(page);
	t.skip(!claw, 'No online claw with RTC available');
	return claw;
}

/** 导航到文件管理页并等待列表加载 */
async function gotoFiles(page, clawId, agentId) {
	await page.goto(`/files/${clawId}/${agentId}`);
	await expect(page.getByRole('button', { name: /Root|根目录/ })).toBeVisible({ timeout: 15_000 });
	await page.waitForTimeout(1500);
}

/** RPC 创建目录 */
async function rpcMkdir(page, clawId, agentId, dir) {
	await page.evaluate(async ({ clawId, agentId, dir }) => {
		const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
		const { mkdirFiles } = await import('/src/services/file-transfer.js');
		const conn = useClawConnections().get(clawId);
		await mkdirFiles(conn, agentId, dir);
	}, { clawId, agentId, dir });
}

/** RPC 清理路径 */
async function rpcCleanup(page, clawId, agentId, path) {
	try {
		await page.evaluate(async ({ clawId, agentId, path }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { deleteFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			if (conn) await deleteFile(conn, agentId, path, { force: true });
		}, { clawId, agentId, path });
	} catch { /* ignore */ }
}

/** 点击刷新按钮并等待 */
async function clickRefresh(page) {
	await page.getByTestId('btn-refresh').click();
	await page.waitForTimeout(1500);
}

// ================================================================
// Tests
// ================================================================

test.describe('文件浏览器 @file', () => {
	test.setTimeout(90_000);

	// ----------------------------------------------------------
	// 1. 页面基础
	// ----------------------------------------------------------

	test('打开文件管理页 — 显示 agent 名称和面包屑', async ({ page }) => {
		const claw = await setup(page, test);
		await gotoFiles(page, claw.clawId, claw.agentId);

		// 面包屑 Root
		await expect(page.getByRole('button', { name: /Root|根目录/ })).toBeVisible();
		// 标题应含 agent 名称 + "文件/Files"（不再是 "Agent 文件"）
		const h1 = page.getByRole('heading', { level: 1 }).last();
		await expect(h1).toBeVisible();
		const titleText = await h1.innerText();
		expect(titleText).toMatch(/文件|Files/);
		// 不应是 "Agent 文件"（应为具体 agent 名如 "小点 文件" 或 "main 文件"）
		expect(titleText).not.toMatch(/^Agent /);
	});

	// ----------------------------------------------------------
	// 2. 目录操作
	// ----------------------------------------------------------

	test('创建目录 → 进入 → ".." 返回 → 面包屑返回 → 删除', async ({ page }) => {
		const claw = await setup(page, test);
		const dirName = `__e2e_mkdir_${Date.now()}`;

		await gotoFiles(page, claw.clawId, claw.agentId);

		// RPC 创建目录
		await rpcMkdir(page, claw.clawId, claw.agentId, dirName);
		await clickRefresh(page);

		// 目录出现在列表中
		await expect(page.locator('main').getByText(dirName, { exact: true })).toBeVisible({ timeout: 10_000 });

		// 点击进入目录
		await page.locator('main').getByText(dirName, { exact: true }).click();
		await page.waitForTimeout(1500);

		// 面包屑显示目录名
		await expect(page.getByText(dirName)).toBeVisible({ timeout: 5000 });

		// ".." 返回上层项可见
		await expect(page.locator('main').getByText('..', { exact: true })).toBeVisible({ timeout: 3000 });

		// 点击 ".." 返回上层
		await page.locator('main').getByText('..', { exact: true }).click();
		await page.waitForTimeout(1500);

		// 回到根目录，面包屑不再显示 dirName（作为 segment）
		await expect(page.getByRole('button', { name: /Root|根目录/ })).toBeVisible();

		// 再次进入目录，通过面包屑 Root 返回
		await page.locator('main').getByText(dirName, { exact: true }).click();
		await page.waitForTimeout(1500);
		await page.getByRole('button', { name: /Root|根目录/ }).click();
		await page.waitForTimeout(1000);

		// 清理
		await rpcCleanup(page, claw.clawId, claw.agentId, dirName);
		await clickRefresh(page);
		await expect(page.locator('main').getByText(dirName)).not.toBeVisible({ timeout: 10_000 });
	});

	test('嵌套目录导航：创建多级目录 → 逐级进入 → 面包屑跳转', async ({ page }) => {
		const claw = await setup(page, test);
		const ts = Date.now();
		const dir1 = `__e2e_nest_${ts}`;
		const dir2 = 'sub';

		await gotoFiles(page, claw.clawId, claw.agentId);

		// RPC 创建嵌套目录
		await rpcMkdir(page, claw.clawId, claw.agentId, `${dir1}/${dir2}`);
		await clickRefresh(page);

		// 进入 dir1
		await page.locator('main').getByText(dir1, { exact: true }).click();
		await page.waitForTimeout(1500);
		await expect(page.getByText(dir1)).toBeVisible();

		// 进入 dir2（sub）
		await page.locator('main').getByText(dir2, { exact: true }).click();
		await page.waitForTimeout(1500);
		await expect(page.getByText(dir2)).toBeVisible();

		// 面包屑跳转回 dir1
		await page.getByText(dir1).click();
		await page.waitForTimeout(1500);

		// 应该看到 sub 目录在列表中
		await expect(page.locator('main').getByText(dir2, { exact: true })).toBeVisible({ timeout: 5000 });

		// 清理
		await rpcCleanup(page, claw.clawId, claw.agentId, dir1);
	});

	// ----------------------------------------------------------
	// 3. 文件上传 & 下载
	// ----------------------------------------------------------

	test('文件上传 → 列表中显示 → 下载', async ({ page }) => {
		const claw = await setup(page, test);
		const dirName = `__e2e_upload_${Date.now()}`;
		const fileName = `test_${Date.now()}.txt`;
		const content = `E2E upload test ${Date.now()}`;

		await gotoFiles(page, claw.clawId, claw.agentId);
		await rpcMkdir(page, claw.clawId, claw.agentId, dirName);
		await clickRefresh(page);

		// 进入测试目录
		await page.locator('main').getByText(dirName, { exact: true }).click();
		await page.waitForTimeout(1500);

		// 上传
		await page.locator('input[type="file"]').setInputFiles({
			name: fileName,
			mimeType: 'text/plain',
			buffer: Buffer.from(content, 'utf-8'),
		});

		// 文件出现在列表
		await expect(page.locator('main').getByText(fileName)).toBeVisible({ timeout: 20_000 });

		// 点击文件触发下载（store 调用 downloadFile → saveBlobToFile）
		await page.locator('main').getByText(fileName, { exact: true }).click();
		// 等待下载进度条出现再消失（表示下载完成）
		await page.waitForTimeout(5000);

		// 通过 RPC 直接下载验证文件内容
		const downloadedText = await page.evaluate(async ({ clawId, agentId, dirName, fileName }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { downloadFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			const handle = downloadFile(conn.__rtc, agentId, `${dirName}/${fileName}`);
			const result = await handle.promise;
			return result.blob.text();
		}, { clawId: claw.clawId, agentId: claw.agentId, dirName, fileName });
		expect(downloadedText).toBe(content);

		// 清理
		await rpcCleanup(page, claw.clawId, claw.agentId, dirName);
	});

	test('多文件上传', async ({ page }) => {
		const claw = await setup(page, test);
		const dirName = `__e2e_multi_${Date.now()}`;
		const files = [
			{ name: `file1_${Date.now()}.txt`, content: 'content-1' },
			{ name: `file2_${Date.now()}.txt`, content: 'content-2' },
		];

		await gotoFiles(page, claw.clawId, claw.agentId);
		await rpcMkdir(page, claw.clawId, claw.agentId, dirName);
		await clickRefresh(page);

		await page.locator('main').getByText(dirName, { exact: true }).click();
		await page.waitForTimeout(1500);

		// 多文件上传
		await page.locator('input[type="file"]').setInputFiles(
			files.map((f) => ({
				name: f.name,
				mimeType: 'text/plain',
				buffer: Buffer.from(f.content, 'utf-8'),
			})),
		);

		// 两个文件都出现
		for (const f of files) {
			await expect(page.locator('main').getByText(f.name)).toBeVisible({ timeout: 20_000 });
		}

		await rpcCleanup(page, claw.clawId, claw.agentId, dirName);
	});

	// ----------------------------------------------------------
	// 4. 删除操作（通过 UI）
	// ----------------------------------------------------------

	test('UI 删除文件', async ({ page }) => {
		const claw = await setup(page, test);
		const dirName = `__e2e_del_${Date.now()}`;
		const fileName = `del_${Date.now()}.txt`;

		await gotoFiles(page, claw.clawId, claw.agentId);
		await rpcMkdir(page, claw.clawId, claw.agentId, dirName);
		await clickRefresh(page);

		// 进入目录
		await page.locator('main').getByText(dirName, { exact: true }).click();
		await page.waitForTimeout(1500);

		// 上传一个文件
		await page.locator('input[type="file"]').setInputFiles({
			name: fileName,
			mimeType: 'text/plain',
			buffer: Buffer.from('to-delete', 'utf-8'),
		});

		// 等待上传完成 + 目录刷新（文件出现在真实文件列表中，带有大小信息）
		await expect(async () => {
			await page.getByTestId('btn-refresh').click();
			await page.waitForTimeout(500);
			await expect(page.locator('main').getByText(fileName)).toBeVisible();
		}).toPass({ timeout: 20_000 });

		// 点击文件行的删除按钮
		const fileText = page.locator('main').getByText(fileName, { exact: true });
		// 从文件名元素向上找到整行 div，再找删除按钮
		const fileRow = fileText.locator('xpath=ancestor::div[contains(@class, "border-b")]');
		await fileRow.locator('button').click();

		// 确认对话框
		const confirmDialog = page.locator('[role="dialog"]');
		await expect(confirmDialog).toBeVisible({ timeout: 3000 });
		await confirmDialog.locator('button').filter({ hasText: /确认|Confirm/ }).click();

		// 文件消失
		await expect(page.locator('main').getByText(fileName)).not.toBeVisible({ timeout: 10_000 });

		await rpcCleanup(page, claw.clawId, claw.agentId, dirName);
	});

	test('UI 删除非空目录（需勾选 checkbox）', async ({ page }) => {
		const claw = await setup(page, test);
		const dirName = `__e2e_rmdir_${Date.now()}`;

		await gotoFiles(page, claw.clawId, claw.agentId);

		// 创建目录并在其中放一个文件
		await rpcMkdir(page, claw.clawId, claw.agentId, dirName);
		await page.evaluate(async ({ clawId, agentId, path }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { createFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			await createFile(conn, agentId, path);
		}, { clawId: claw.clawId, agentId: claw.agentId, path: `${dirName}/placeholder.txt` });

		await clickRefresh(page);

		// 点击目录行的删除按钮
		const dirRow = page.locator('main > div').filter({ hasText: dirName }).first();
		await dirRow.locator('button').last().click();

		// 删除目录对话框 — 删除按钮应禁用
		const deleteBtn = page.locator('button').filter({ hasText: /删除|Delete/ }).last();
		await expect(deleteBtn).toBeDisabled({ timeout: 3000 });

		// 勾选复选框
		await page.locator('input[type="checkbox"]').check();
		await expect(deleteBtn).toBeEnabled({ timeout: 1000 });

		// 确认删除
		await deleteBtn.click();

		// 目录消失
		await expect(page.locator('main').getByText(dirName)).not.toBeVisible({ timeout: 10_000 });
	});

	// ----------------------------------------------------------
	// 5. 入口
	// ----------------------------------------------------------

	test('ChatPage header 有文件管理入口', async ({ page }) => {
		const claw = await setup(page, test);

		const pluginOk = await evalStore(page, 'claws', `return store.byId['${claw.clawId}']?.pluginVersionOk`);
		test.skip(pluginOk === false, 'Plugin version outdated');

		await page.goto(`/chat/${claw.clawId}/${claw.agentId}`);
		await expect(page.getByRole('heading', { level: 1 }).last()).toBeVisible({ timeout: 15_000 });

		// 桌面端可见（Playwright 默认 viewport 宽度走桌面分支）；testid 已按屏幕尺寸分离避免歧义
		const filesBtn = page.getByTestId('btn-files-desktop');
		await expect(filesBtn).toBeVisible({ timeout: 10_000 });
		await filesBtn.click();

		await page.waitForURL(/\/files\//, { timeout: 5000 });
		await expect(page.getByRole('button', { name: /Root|根目录/ })).toBeVisible({ timeout: 10_000 });
	});

	test('ManageClawsPage AgentCard 有文件管理入口', async ({ page }) => {
		const claw = await setup(page, test);

		const pluginOk = await evalStore(page, 'claws', `return store.byId['${claw.clawId}']?.pluginVersionOk`);
		test.skip(pluginOk === false, 'Plugin version outdated');

		await page.goto('/claws');
		// 等待 AgentCard 渲染
		const agentCard = page.locator('[class*="rounded-xl"]').filter({ hasText: /chat|对话/ }).first();
		await expect(agentCard).toBeVisible({ timeout: 15_000 });

		// AgentCard 中应有文件夹图标按钮
		const _folderBtn = agentCard.locator('button').filter({ has: page.locator('[class*="i-lucide-folder"]') });
		// Nuxt UI 渲染 icon 为 img，换用更通用的方式
		const btns = agentCard.locator('button');
		// AgentCard 动作区有两个按钮：chat + files
		await expect(async () => {
			const count = await btns.count();
			expect(count).toBeGreaterThanOrEqual(2);
		}).toPass({ timeout: 10_000 });

		// 点击最后一个按钮（files）
		const lastBtn = btns.last();
		await lastBtn.click();
		await page.waitForURL(/\/files\//, { timeout: 5000 });
		await expect(page.getByRole('button', { name: /Root|根目录/ })).toBeVisible({ timeout: 10_000 });
	});

	// ----------------------------------------------------------
	// 6. UI 创建目录（通过界面按钮）
	// ----------------------------------------------------------

	test('通过 UI 按钮新建目录', async ({ page }) => {
		const claw = await setup(page, test);
		const dirName = `__e2e_uimk_${Date.now()}`;

		await gotoFiles(page, claw.clawId, claw.agentId);

		await page.getByTestId('btn-mkdir').click();

		// 对话框输入
		const input = page.locator('[role="dialog"] input');
		await expect(input).toBeVisible({ timeout: 3000 });
		await input.fill(dirName);
		await page.locator('[role="dialog"] button').filter({ hasText: /确认|Confirm/ }).click();

		// 目录出现
		await expect(page.locator('main').getByText(dirName, { exact: true })).toBeVisible({ timeout: 10_000 });

		// 清理
		await rpcCleanup(page, claw.clawId, claw.agentId, dirName);
	});
});
