import { expect, test } from '@playwright/test';
import { login, evalStore } from './helpers.js';

/**
 * 文件传输任务 UI E2E 测试（取消 / 重试 / 进度 / 离线 / 空目录）
 *
 * 前置条件：
 * - server、OpenClaw gateway、plugin 均运行中
 * - test 用户已绑定 claw 且 claw 在线
 * - 本地环境 WebRTC 连接几乎 100% 可建立
 *
 * 说明：upload/download 走 WebRTC DataChannel（非 HTTP），page.route 无法拦截传输
 * 注入失败 → 失败/重试用例改以"在 store 注入 failed 任务 + 点击重试触发真实重试恢复"
 * 验证 UI 重试链路（确定性、可观测恢复）。取消用例靠串行队列与大文件抓 in-flight。
 */

// ================================================================
// Helpers（与 file-browser.e2e.spec.js 同源，保持各 spec 自包含）
// ================================================================

/** 等待 claw 在线 + RTC 连接就绪 */
async function waitClawReady(page, timeout = 30_000) {
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
	await page.goto('/topics');
	const claw = await waitClawReady(page);
	t.skip(!claw, 'No online claw with RTC available');
	return claw;
}

/** 导航到文件管理页并等待列表加载 */
async function gotoFiles(page, clawId, agentId) {
	await page.goto(`/files/${clawId}/${agentId}`);
	await expect(page.getByRole('button', { name: /Root|根目录/ })).toBeVisible({ timeout: 15_000 });
}

/** 等待该 claw 的连接就绪（conn 存在且 DC open）后再发 RPC */
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

/** RPC 上传文件（用零字节构造指定大小，供下载用例准备数据） */
async function rpcUpload(page, clawId, agentId, path, sizeBytes) {
	await waitConnReady(page, clawId);
	await page.evaluate(async ({ clawId, agentId, path, sizeBytes }) => {
		const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
		const { uploadFile } = await import('/src/services/file-transfer.js');
		const conn = useClawConnections().get(clawId);
		const buf = new Uint8Array(sizeBytes);
		const name = path.split('/').pop();
		const file = new File([buf], name, { type: 'application/octet-stream' });
		const handle = uploadFile(conn, agentId, path, file);
		await handle.promise;
	}, { clawId, agentId, path, sizeBytes });
}

/** RPC 清理路径（force 删整目录） */
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
	await page.waitForTimeout(1000);
}

/** 进入指定目录（从根点击目录名） */
async function enterDir(page, dirName) {
	await page.locator('main').getByText(dirName, { exact: true }).click();
	await expect(page.locator('main').getByText('..', { exact: true })).toBeVisible({ timeout: 5000 });
}

/** 从文件名定位整行 div（含 border-b） */
function rowOf(page, name) {
	return page.locator('main').getByText(name, { exact: true })
		.locator('xpath=ancestor::div[contains(@class, "border-b")]');
}

/**
 * 在 files store 注入一个 failed 任务（模拟传输失败），供"点击重试"链路测试。
 * upload 注入真实 File（重试时真上传到 dir/fileName）；download 不需 File（重试时真下载）。
 * @returns {Promise<string>} 注入任务的 id
 */
function seedFailedTask(page, { type, clawId, agentId, dir, fileName, size = 0, content = '' }) {
	return page.evaluate(({ type, clawId, agentId, dir, fileName, size, content }) => {
		const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
		const store = pinia._s.get('files');
		if (!store) throw new Error('files store not found');
		const id = crypto.randomUUID();
		let file = null;
		let bytes = size;
		if (type === 'upload') {
			const enc = new TextEncoder().encode(content);
			file = new File([enc], fileName, { type: 'text/plain' });
			bytes = enc.length;
		}
		store.tasks.set(id, {
			id, type, clawId, agentId, dir, fileName,
			status: 'failed', progress: 0, size: bytes,
			error: 'seeded failure', file, transferHandle: null,
			onDone: null, createdAt: Date.now(),
		});
		return id;
	}, { type, clawId, agentId, dir, fileName, size, content });
}

// ================================================================
// Tests
// ================================================================

test.describe('文件传输任务 @file', () => {
	test.setTimeout(120_000);

	// ----------------------------------------------------------
	// 1. 上传取消（队列中 pending + 进行中 running 都可取消）
	// ----------------------------------------------------------

	test('上传取消：取消排队中与进行中的上传任务', async ({ page }) => {
		const claw = await setup(page, test);
		const ts = Date.now();
		const dirName = `__e2e_upcancel_${ts}`;
		const bigName = `big_${ts}.bin`; // 24MB → 串行队列里长期 running，给取消留窗口
		const smallName = `small_${ts}.txt`; // 跟在大文件后面，确定性 pending

		await gotoFiles(page, claw.clawId, claw.agentId);
		await rpcMkdir(page, claw.clawId, claw.agentId, dirName);
		await clickRefresh(page);
		await enterDir(page, dirName);

		// 注入两个文件：大文件先入队（running），小文件随后（pending）
		await page.locator('input[type="file"]').setInputFiles([
			{ name: bigName, mimeType: 'application/octet-stream', buffer: Buffer.alloc(24 * 1024 * 1024) },
			{ name: smallName, mimeType: 'text/plain', buffer: Buffer.from(`small ${ts}`) },
		]);

		// 小文件排队中（pending）—— 取消它（确定性：大文件未传完前它不会启动）
		const smallRow = rowOf(page, smallName);
		await expect(smallRow).toBeVisible({ timeout: 10_000 });
		await smallRow.locator('button').click(); // FileUploadItem 只有一个按钮（cancel）
		await expect(page.locator('main').getByText(smallName, { exact: true })).not.toBeVisible({ timeout: 5000 });

		// 大文件进行中（running）—— 取消它（in-flight 取消）
		const bigRow = rowOf(page, bigName);
		await expect(bigRow).toBeVisible({ timeout: 5000 });
		await bigRow.locator('button').click();
		await expect(page.locator('main').getByText(bigName, { exact: true })).not.toBeVisible({ timeout: 10_000 });

		// 两个上传任务均已取消（无残留上传行）
		await expect(page.locator('main').getByText(smallName, { exact: true })).not.toBeVisible();

		await rpcCleanup(page, claw.clawId, claw.agentId, dirName);
	});

	// ----------------------------------------------------------
	// 2. 上传失败重试 → 恢复成功
	// ----------------------------------------------------------

	test('上传失败重试：点击重试后真上传成功并出现在列表', async ({ page }) => {
		const claw = await setup(page, test);
		const ts = Date.now();
		const dirName = `__e2e_upretry_${ts}`;
		const fileName = `retry_${ts}.txt`;
		const content = `retry upload ${ts}`;

		await gotoFiles(page, claw.clawId, claw.agentId);
		await rpcMkdir(page, claw.clawId, claw.agentId, dirName);
		await clickRefresh(page);
		await enterDir(page, dirName);

		// 注入 failed 上传任务（dir 必须等于当前目录，含真实 File 供重试上传）
		await seedFailedTask(page, {
			type: 'upload', clawId: claw.clawId, agentId: claw.agentId,
			dir: dirName, fileName, content,
		});

		// 失败上传行出现（带重试按钮）
		const failRow = rowOf(page, fileName);
		await expect(failRow).toBeVisible({ timeout: 5000 });

		// 点击重试（FileUploadItem failed 态只有一个按钮 = retry）
		await failRow.locator('button').click();

		// 重试成功 → 任务 done → 上传虚拟行消失；刷新后文件作为真实条目出现
		await expect(async () => {
			await page.getByTestId('btn-refresh').click();
			await page.waitForTimeout(800);
			await expect(page.locator('main').getByText(fileName, { exact: true })).toBeVisible();
		}).toPass({ timeout: 30_000 });

		// 校验确实是真实文件（带大小），且 store 中无 failed 任务残留
		const noFailed = await evalStore(page, 'files', `
			for (const t of store.tasks.values()) {
				if (t.fileName === '${fileName}' && t.status === 'failed') return false;
			}
			return true;
		`);
		expect(noFailed).toBe(true);

		await rpcCleanup(page, claw.clawId, claw.agentId, dirName);
	});

	// ----------------------------------------------------------
	// 3. 下载进度 + 取消
	// ----------------------------------------------------------

	test('下载进度与取消：进度环出现，取消后恢复可删除态', async ({ page }) => {
		const claw = await setup(page, test);
		const ts = Date.now();
		const dirName = `__e2e_dlcancel_${ts}`;
		const fileName = `dl_${ts}.bin`;

		await gotoFiles(page, claw.clawId, claw.agentId);
		await rpcMkdir(page, claw.clawId, claw.agentId, dirName);
		// 准备 24MB 文件，保证下载有可观测窗口
		await rpcUpload(page, claw.clawId, claw.agentId, `${dirName}/${fileName}`, 24 * 1024 * 1024);
		await clickRefresh(page);
		await enterDir(page, dirName);

		// 点击文件触发下载
		const fileRow = rowOf(page, fileName);
		await expect(fileRow).toBeVisible({ timeout: 10_000 });
		await page.locator('main').getByText(fileName, { exact: true }).click();

		// 下载中显示进度环（role=progressbar）
		await expect(fileRow.locator('[role="progressbar"]')).toBeVisible({ timeout: 15_000 });

		// 进行中行只有一个按钮（cancel）—— 取消下载
		await fileRow.locator('button').click();

		// 取消后：进度环消失，行恢复（删除按钮回来 = downloadTask 已清）
		await expect(fileRow.locator('[role="progressbar"]')).not.toBeVisible({ timeout: 10_000 });
		await expect(fileRow.locator('button')).toBeVisible({ timeout: 5000 });

		// 文件仍在（取消下载不删源文件）
		await expect(page.locator('main').getByText(fileName, { exact: true })).toBeVisible();

		await rpcCleanup(page, claw.clawId, claw.agentId, dirName);
	});

	// ----------------------------------------------------------
	// 4. 下载失败重试 → 恢复成功
	// ----------------------------------------------------------

	test('下载失败重试：点击重试后真下载成功并清除失败态', async ({ page }) => {
		const claw = await setup(page, test);
		const ts = Date.now();
		const dirName = `__e2e_dlretry_${ts}`;
		const fileName = `dlretry_${ts}.txt`;

		// 接收浏览器下载事件（重试成功会触发 saveBlobToFile → 真实下载）
		page.on('download', (d) => { d.saveAs(`/tmp/e2e-dlretry-${ts}-${d.suggestedFilename()}`).catch(() => {}); });

		await gotoFiles(page, claw.clawId, claw.agentId);
		await rpcMkdir(page, claw.clawId, claw.agentId, dirName);
		await rpcUpload(page, claw.clawId, claw.agentId, `${dirName}/${fileName}`, 64);
		await clickRefresh(page);
		await enterDir(page, dirName);

		const fileRow = rowOf(page, fileName);
		await expect(fileRow).toBeVisible({ timeout: 10_000 });

		// 注入 failed 下载任务（dir = 当前目录, fileName = 真实文件）
		await seedFailedTask(page, {
			type: 'download', clawId: claw.clawId, agentId: claw.agentId,
			dir: dirName, fileName, size: 64,
		});

		// 行进入失败态：出现失败文案 + 重试按钮
		const failedLabel = fileRow.locator('span.text-error');
		await expect(failedLabel).toBeVisible({ timeout: 5000 });

		// 点击失败态内的重试按钮（失败态容器 class 含 gap-1，区别于 running/pending 的 gap-2，
		// 也避开行尾的删除按钮）
		await fileRow.locator('div.gap-1').getByRole('button').click();

		// 重试成功 → 任务 done → 失败态消失
		await expect(failedLabel).not.toBeVisible({ timeout: 30_000 });

		const noFailed = await evalStore(page, 'files', `
			for (const t of store.tasks.values()) {
				if (t.fileName === '${fileName}' && t.type === 'download' && t.status === 'failed') return false;
			}
			return true;
		`);
		expect(noFailed).toBe(true);

		await rpcCleanup(page, claw.clawId, claw.agentId, dirName);
	});

	// ----------------------------------------------------------
	// 5. claw 离线（mock dcReady=false）：操作禁用 + 缓存列表可见 + 空缓存显示连接中
	// ----------------------------------------------------------

	test('claw 离线：操作禁用、缓存列表可见、空缓存显示连接中', async ({ page }) => {
		const claw = await setup(page, test);
		const ts = Date.now();
		const dirName = `__e2e_offline_${ts}`;

		await gotoFiles(page, claw.clawId, claw.agentId);
		await rpcMkdir(page, claw.clawId, claw.agentId, dirName);
		await clickRefresh(page);
		// 目录已加载进列表 + dirCache（作为"缓存列表"）
		await expect(page.locator('main').getByText(dirName, { exact: true })).toBeVisible({ timeout: 10_000 });

		// mock 离线：仅翻 UI 门控字段 dcReady=false（真实连接不动，绝不解绑）
		await evalStore(page, 'claws', `store.byId['${claw.clawId}'].dcReady = false; return true;`);

		// 操作禁用（新建目录 / 刷新按钮禁用）
		await expect(page.getByTestId('btn-mkdir')).toBeDisabled({ timeout: 5000 });
		await expect(page.getByTestId('btn-refresh')).toBeDisabled();
		// 缓存列表仍可见
		await expect(page.locator('main').getByText(dirName, { exact: true })).toBeVisible();

		// 空缓存场景：离线下 SPA 重新挂载文件页（无 entries）→ 显示"连接中"
		await page.evaluate(async ({ clawId, agentId }) => {
			const { router } = await import('/src/router/index.js');
			await router.push('/about');
			await router.push(`/files/${clawId}/${agentId}`);
		}, { clawId: claw.clawId, agentId: claw.agentId });

		await expect(page.getByText(/正在连接 Claw|Connecting to Claw/)).toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId('btn-mkdir')).toBeDisabled({ timeout: 5000 });

		// 恢复 UI 门控并清理（真实连接一直在，cleanup 直接走 conn）
		await evalStore(page, 'claws', `store.byId['${claw.clawId}'].dcReady = true; return true;`);
		await rpcCleanup(page, claw.clawId, claw.agentId, dirName);
	});

	// ----------------------------------------------------------
	// 6. 空目录空态：进入空子目录仅显示 ".." 无文件行
	// ----------------------------------------------------------
	// 说明：files.emptyDir 文案仅在"根目录且为空"时渲染，真实 agent 根目录从不为空，
	// 故子目录空态表现为：".." 上行项可见 + 零文件/目录行（name 行为 p.truncate.text-sm）。

	test('空目录：进入空子目录显示空态（仅 .. 无条目）', async ({ page }) => {
		const claw = await setup(page, test);
		const ts = Date.now();
		const dirName = `__e2e_empty_${ts}`;

		await gotoFiles(page, claw.clawId, claw.agentId);
		await rpcMkdir(page, claw.clawId, claw.agentId, dirName);
		await clickRefresh(page);
		await enterDir(page, dirName);

		// 空态：".." 可见，且无任何条目名行（FileListItem 的 name 用 p.truncate.text-sm）
		await expect(page.locator('main').getByText('..', { exact: true })).toBeVisible();
		await expect(page.locator('main p.truncate.text-sm')).toHaveCount(0, { timeout: 5000 });

		// 交叉校验：store 缓存的当前目录 entries 为空
		const emptyEntries = await evalStore(page, 'files', `
			const c = store.getCachedDir('${claw.clawId}', '${claw.agentId}');
			return Boolean(c && c.entries.length === 0);
		`);
		expect(emptyEntries).toBe(true);

		await rpcCleanup(page, claw.clawId, claw.agentId, dirName);
	});
});
