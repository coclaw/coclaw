import { expect, test } from '@playwright/test';
import { login, evalStore, waitChatReady, typeText } from './helpers.js';

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
	// dcReady 是 claws store 的"DC 可用"真实字段（onRtcStateChange('connected') 写入）；
	// UI 已无 WS 传输，DC 就绪即 RTC 就绪。不存在 connState / transportMode 字段。
	try {
		await expect(async () => {
			const items = await evalStore(page, 'claws', 'return store.items');
			const ready = items.find((b) => b.online && b.dcReady);
			expect(ready).toBeTruthy();
		}).toPass({ timeout });
		const items = await evalStore(page, 'claws', 'return store.items');
		const claw = items.find((b) => b.online && b.dcReady);
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
	// 面包屑 Root 可见即列表区域已就绪
	await expect(page.getByRole('button', { name: /Root|根目录/ })).toBeVisible({ timeout: 15_000 });
}

/**
 * 等待该 claw 的连接就绪（conn 存在且 DC open）后再发 RPC。
 * 页面跳转到 /files 是整页导航，连接管理器会重建——Root 面包屑可见早于连接就绪，
 * 此时 get(clawId) 可能瞬时为 undefined / rtc 未 open，裸发 mkdirFiles 会 reading 'request' on undefined。
 * conn.rtc?.isReady 是 DC open 的真实信号（与各 spec 既有判活一致）。
 */
async function waitConnReady(page, clawId, timeout = 15_000) {
	await expect(async () => {
		const ready = await page.evaluate(async (clawId) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const conn = useClawConnections().get(clawId);
			return Boolean(conn?.rtc?.isReady);
		}, clawId);
		expect(ready).toBe(true);
	}).toPass({ timeout });
}

/** RPC 创建目录 */
async function rpcMkdir(page, clawId, agentId, dir) {
	await waitConnReady(page, clawId);
	await page.evaluate(async ({ clawId, agentId, dir }) => {
		const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
		const { mkdirFiles } = await import('/src/services/file-transfer.js');
		const conn = useClawConnections().get(clawId);
		await mkdirFiles(conn, agentId, dir);
	}, { clawId, agentId, dir });
}

/**
 * 轮询 listFiles RPC，直到目录中出现全部目标文件名（即已落盘）。
 * 上传只断言乐观列表可见即返回，但此时 DC 传输可能仍在途；afterEach 的递归删除会与之竞态：
 * 删除移走目录后，仍在途的上传在写入前会 `mkdir -p` 重建父目录并把文件写回（plugin
 * receiveUpload），残留 __e2e_* 目录。等两份文件都落盘（plugin 端 tmp→rename 完成、readdir
 * 可见即写入已提交）再结束用例，使 afterEach 的删除成为唯一的最终写入者。
 */
async function waitFilesCommitted(page, clawId, agentId, dir, names, timeout = 20_000) {
	await waitConnReady(page, clawId);
	await expect(async () => {
		const got = await page.evaluate(async ({ clawId, agentId, dir }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { listFiles } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			const res = await listFiles(conn, agentId, dir);
			return res.files.map((f) => f.name);
		}, { clawId, agentId, dir });
		for (const n of names) expect(got).toContain(n);
	}).toPass({ timeout });
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

/**
 * 已注册的待清理路径——afterEach 保证删除，即使用例 body 中途抛错也不泄漏 __e2e_* 到共享 workspace。
 * 只删本用例创建的唯一路径；删已不存在的路径返回 404，rpcCleanup 内部已吞掉。
 */
const cleanupTargets = [];
function trackCleanup(claw, path) {
	cleanupTargets.push({ clawId: claw.clawId, agentId: claw.agentId, path });
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

	// 兜底清理：用例无论成功或中途抛错，afterEach 都删掉本用例注册的 __e2e_* 路径
	test.afterEach(async ({ page }) => {
		for (const t of cleanupTargets.splice(0)) await rpcCleanup(page, t.clawId, t.agentId, t.path);
	});

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
		// 不应是 "Agent 文件"（应为具体 agent 名如 "小点 · 文件" 或 "main · 文件"）
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
		trackCleanup(claw, dirName);
		await clickRefresh(page);

		// 目录出现在列表中
		await expect(page.locator('main').getByText(dirName, { exact: true })).toBeVisible({ timeout: 10_000 });

		// 点击进入目录
		await page.locator('main').getByText(dirName, { exact: true }).click();

		// 面包屑显示目录名
		await expect(page.getByText(dirName)).toBeVisible({ timeout: 5000 });

		// ".." 返回上层项可见
		await expect(page.locator('main').getByText('..', { exact: true })).toBeVisible({ timeout: 3000 });

		// 点击 ".." 返回上层
		await page.locator('main').getByText('..', { exact: true }).click();
		// ".." 消失表示已回到根目录
		await expect(page.locator('main').getByText('..', { exact: true })).not.toBeVisible({ timeout: 5000 });

		// 回到根目录，面包屑不再显示 dirName（作为 segment）
		await expect(page.getByRole('button', { name: /Root|根目录/ })).toBeVisible();

		// 再次进入目录，通过面包屑 Root 返回
		await page.locator('main').getByText(dirName, { exact: true }).click();
		await expect(page.locator('main').getByText('..', { exact: true })).toBeVisible({ timeout: 5000 });
		await page.getByRole('button', { name: /Root|根目录/ }).click();
		// ".." 消失表示已回根目录
		await expect(page.locator('main').getByText('..', { exact: true })).not.toBeVisible({ timeout: 5000 });

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
		trackCleanup(claw, dir1);
		await clickRefresh(page);

		// 进入 dir1
		await page.locator('main').getByText(dir1, { exact: true }).click();
		await expect(page.getByText(dir1)).toBeVisible({ timeout: 5000 });

		// 进入 dir2（sub）
		await page.locator('main').getByText(dir2, { exact: true }).click();
		await expect(page.getByText(dir2)).toBeVisible({ timeout: 5000 });

		// 面包屑跳转回 dir1
		await page.getByText(dir1).click();

		// 应该看到 sub 目录在列表中
		await expect(page.locator('main').getByText(dir2, { exact: true })).toBeVisible({ timeout: 5000 });
		// 清理由 afterEach 保证（trackCleanup 已注册 dir1）
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
		trackCleanup(claw, dirName);
		await clickRefresh(page);

		// 进入测试目录
		await page.locator('main').getByText(dirName, { exact: true }).click();
		await expect(page.locator('main').getByText('..', { exact: true })).toBeVisible({ timeout: 5000 });

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
		// 等待下载完成：ProgressRing（role=progressbar）消失或从未出现
		await expect(page.locator('[role="progressbar"]')).not.toBeVisible({ timeout: 15_000 });

		// 通过 RPC 直接下载验证文件内容
		const downloadedText = await page.evaluate(async ({ clawId, agentId, dirName, fileName }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { downloadFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			const handle = downloadFile(conn, agentId, `${dirName}/${fileName}`);
			const result = await handle.promise;
			return result.blob.text();
		}, { clawId: claw.clawId, agentId: claw.agentId, dirName, fileName });
		expect(downloadedText).toBe(content);
		// 清理由 afterEach 保证（trackCleanup 已注册 dirName）
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
		trackCleanup(claw, dirName);
		await clickRefresh(page);

		await page.locator('main').getByText(dirName, { exact: true }).click();
		await expect(page.locator('main').getByText('..', { exact: true })).toBeVisible({ timeout: 5000 });

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
		// 等两份文件真正落盘后再结束用例：上方断言仅证乐观列表可见，此刻上传可能仍在途。
		// 若用例此时结束，afterEach 的递归删除会与在途上传竞态——上传写入前会 mkdir -p 重建
		// 被删目录并写回 file2，残留 __e2e_multi_<ts>/file2_*.txt。落盘后 afterEach 才是唯一最终写入者。
		await waitFilesCommitted(page, claw.clawId, claw.agentId, dirName, files.map((f) => f.name));
		// 清理由 afterEach 保证（trackCleanup 已注册 dirName）
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
		trackCleanup(claw, dirName);
		await clickRefresh(page);

		// 进入目录
		await page.locator('main').getByText(dirName, { exact: true }).click();
		await expect(page.locator('main').getByText('..', { exact: true })).toBeVisible({ timeout: 5000 });

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
		// 清理由 afterEach 保证（trackCleanup 已注册 dirName）
	});

	test('UI 删除非空目录（需勾选 checkbox）', async ({ page }) => {
		const claw = await setup(page, test);
		const dirName = `__e2e_rmdir_${Date.now()}`;

		await gotoFiles(page, claw.clawId, claw.agentId);

		// 创建目录并在其中放一个文件
		await rpcMkdir(page, claw.clawId, claw.agentId, dirName);
		trackCleanup(claw, dirName);
		await page.evaluate(async ({ clawId, agentId, path }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { createFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			await createFile(conn, agentId, path);
		}, { clawId: claw.clawId, agentId: claw.agentId, path: `${dirName}/placeholder.txt` });

		await clickRefresh(page);

		// 定位目录行：从名称文本向上找到 border-b 行（与"UI 删除文件"用例同一稳健模式），
		// 点击该行的删除按钮。旧写法 main>div 只匹配单个列表容器，.last() 会点到末尾文件行 →
		// 打开的是文件删除框（确认按钮为"确认"），故 /删除|Delete/ 找不到。
		const dirText = page.locator('main').getByText(dirName, { exact: true });
		await expect(dirText).toBeVisible({ timeout: 10_000 });
		const dirRow = dirText.locator('xpath=ancestor::div[contains(@class, "border-b")]');
		await dirRow.locator('button').click();

		// 删除目录对话框
		const dialog = page.locator('[role="dialog"]');
		await expect(dialog).toBeVisible({ timeout: 3000 });

		// 删除按钮（文案 files.delete = "删除"）初始禁用，需勾选 checkbox
		const deleteBtn = dialog.getByRole('button').filter({ hasText: /删除|Delete/ }).last();
		await expect(deleteBtn).toBeDisabled({ timeout: 3000 });

		// 勾选复选框：Nuxt UI(reka) 渲染为 button[role=checkbox]，无 name 时不渲染原生 input
		await dialog.getByRole('checkbox').click();
		await expect(deleteBtn).toBeEnabled({ timeout: 1000 });

		// 确认删除
		await deleteBtn.click();

		// 目录消失
		await expect(page.locator('main').getByText(dirName)).not.toBeVisible({ timeout: 10_000 });
		// 兜底清理由 afterEach 保证（trackCleanup 已注册 dirName；UI 删除已生效时为 404 no-op）
	});

	// ----------------------------------------------------------
	// 5. 入口
	// ----------------------------------------------------------

	test('ChatPage header 有文件管理入口', async ({ page }) => {
		const claw = await setup(page, test);

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
		await setup(page, test);

		await page.goto('/claws');
		// 等待 AgentCard 渲染：用稳定的 data-testid（AgentCard 根 class 是 rounded-lg，
		// rounded-xl 是外层 claw 卡片且不含"对话"文本，旧选择器永远匹配不到）
		const agentCard = page.locator('[data-testid^="agent-card-"]').first();
		await expect(agentCard).toBeVisible({ timeout: 15_000 });

		// 点击文件管理入口（btn-files）
		const filesBtn = agentCard.getByTestId('btn-files');
		await expect(filesBtn).toBeVisible({ timeout: 10_000 });
		await filesBtn.click();

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
		// 注册清理（确认提交后即注册，UI 创建落地后由 afterEach 兜底删除）
		trackCleanup(claw, dirName);

		// 目录出现
		await expect(page.locator('main').getByText(dirName, { exact: true })).toBeVisible({ timeout: 10_000 });
	});

	// ----------------------------------------------------------
	// 7. chat ↔ 文件管理器往返：让 agent 写文件，再回文件管理器验证
	// ----------------------------------------------------------

	test('文件往返：agent 写文件 → 文件管理器可见且可下载 @file @chat', async ({ page }) => {
		// 登录+导航(~45s) + 真实回复(≤180s) + 文件轮询(≤90s)，给足总预算
		test.setTimeout(300_000);
		const claw = await setup(page, test);

		const ts = Date.now();
		const fileName = `e2e-roundtrip-${ts}.txt`;
		const content = 'roundtrip-ok';

		// 1) 进入该 agent 的对话页（与文件管理器同一 claw/agent，保证往返同源）
		await page.goto(`/chat/${claw.clawId}/${claw.agentId}`);
		await waitChatReady(page);
		// 发送走 DC，确保连接就绪后再发
		await waitConnReady(page, claw.clawId);

		// 2) 明确指令让 agent 写一个唯一文件名、固定内容的文件（指令写死避免歧义）
		const prompt = 'Create a text file in your current working directory. '
			+ `The file name must be exactly \`${fileName}\` and its content must be exactly \`${content}\` `
			+ '(no extra text, no markdown). Use a relative path. Reply DONE when finished.';
		await typeText(page.getByTestId('chat-textarea'), prompt);
		await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 5000 });
		await page.getByTestId('btn-send').click();
		// 即刻注册清理：即便后续断言失败，afterEach 也会递归 force 删除（不存在则 404 no-op）
		trackCleanup(claw, fileName);

		// 用户消息已落地 = 确实发出（防 btn-stop 从未出现致 not.toBeVisible 假绿）
		await expect(
			page.locator('[data-testid="chat-msg-item"]').filter({ hasText: fileName }).first(),
		).toBeVisible({ timeout: 15_000 });

		// 3) 等回复完成：btn-stop 消失（红线判定，agent 真实回复慢）
		await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });

		// 4) 打开该 agent 的文件管理器，轮询刷新直到文件出现（agent 非确定性，给足 90s）
		await gotoFiles(page, claw.clawId, claw.agentId);
		await waitConnReady(page, claw.clawId);
		const fileRow = page.locator('main').getByText(fileName, { exact: true });
		await expect(async () => {
			await page.getByTestId('btn-refresh').click();
			await page.waitForTimeout(1000);
			await expect(fileRow).toBeVisible();
		}).toPass({ timeout: 90_000 });

		// 5) 可下载：点击文件行触发 UI 下载（文件行即下载控件），等进度环消失
		await fileRow.click();
		await expect(page.locator('[role="progressbar"]')).not.toBeVisible({ timeout: 15_000 });

		// 6) 经 file-transfer service 直接下载校验内容（DC 传输，非 HTTP，page.route 拦不到）
		const downloadedText = await page.evaluate(async ({ clawId, agentId, fileName }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { downloadFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			const handle = downloadFile(conn, agentId, fileName);
			const result = await handle.promise;
			return result.blob.text();
		}, { clawId: claw.clawId, agentId: claw.agentId, fileName });
		// agent 可能尾随换行，用 contains 容错（content 是文件内容、非 UI 文案，断言安全）
		expect(downloadedText).toContain(content);
		// 清理由 afterEach 保证（trackCleanup 已注册 fileName）
	});
});
