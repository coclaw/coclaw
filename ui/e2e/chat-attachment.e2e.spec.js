import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady, typeText, evalStore } from './helpers.js';

/**
 * 多模态附件发送 E2E 测试
 *
 * 前置条件：
 * - server、OpenClaw gateway、plugin 均运行中
 * - test 用户已绑定 online claw（RTC 模式可用）
 * - 验证核心流程：附件通过 POST 上传到 workspace，附件信息块嵌入 user message
 *
 * 不测试：auth / bind（已有专用测试）
 */

/** 等待 RTC 就绪，返回 claw 连接信息 */
async function waitRtcReady(page, timeout = 30_000) {
	let info = null;
	await expect(async () => {
		info = await page.evaluate(async () => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const manager = useClawConnections();
			for (const [clawId, conn] of manager.__connections) {
				// conn 无 state/transportMode 字段：DC open（conn.rtc.isReady=
				// rpc DataChannel readyState==='open'）即 RTC 就绪，RTC 是唯一传输
				if (conn.rtc?.isReady) {
					return { clawId, transportMode: 'rtc' };
				}
			}
			return null;
		});
		expect(info).not.toBeNull();
	}).toPass({ timeout });
	return info;
}

// ================================================================
// Test 1: 带文本附件发送 — 消息包含附件信息块
// ================================================================

test('附件发送：文本+文件通过 POST 上传，消息包含附件信息块 @chat @file', async ({ page }) => {
	test.setTimeout(240_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionInfo = await navigateToChat(page);
	test.skip(!sessionInfo, 'No chat session available');

	await waitChatReady(page);

	// 等待 RTC 就绪
	const rtcInfo = await waitRtcReady(page).catch(() => null);
	test.skip(!rtcInfo, 'RTC not available, cannot test POST upload');

	// 输入文本
	const msgText = `e2e_attachment_${Date.now()}`;
	await typeText(page.getByTestId('chat-textarea'), msgText);

	// 注入一个测试文件
	const fileInput = page.getByTestId('file-input');
	await fileInput.setInputFiles({
		name: 'e2e-test-doc.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('E2E attachment test content'),
	});

	// 文件预览应出现
	await expect(page.locator('footer .group')).toHaveCount(1, { timeout: 5000 });

	// 发送
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
	await page.getByTestId('btn-send').click();

	// 用户消息应出现
	// 作用域限定到消息列表并取首个：agent 常回显 token，裸 text= 会同时命中用户气泡与回显 → strict-mode 报错
	await expect(
		page.locator('[data-testid="chat-msg-item"]').filter({ hasText: msgText }).first(),
	).toBeVisible({ timeout: 10_000 });

	// 附件卡片应出现在用户消息区（非图片文件显示为 ChatFile 卡片，带稳定 testid）
	await expect(async () => {
		const cards = page.locator('[data-testid="chat-root"] main .items-end [data-testid="msg-attachment-card"]');
		const count = await cards.count();
		expect(count).toBeGreaterThanOrEqual(1);
	}).toPass({ timeout: 10_000 });

	// claw 回复完成（stop 按钮消失 = sending 结束）
	await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });

	// 验证：本次 run 发送的那条 user 消息里包含附件信息块。
	// content 可能是 string 或 block 数组（OpenClaw sessions.get 返回 block 格式）。
	// 关键：必须用唯一 msgText 把扫描锁定到“本次”消息，否则共享累积 session 里任意历史附件
	// 消息都能命中 'coclaw-attachments' → 即便本次上传没嵌入附件块也假绿（中心断言被掏空）。
	const hasBlock = await evalStore(page, 'chat', `
		const msgs = store.messages || [];
		for (const m of msgs) {
			if (m.message?.role !== 'user') continue;
			const c = m.message.content;
			const texts = typeof c === 'string' ? [c]
				: Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text || '')
				: [];
			// 只认本次 run 发送的消息（含唯一 msgText）；找到即在该条上判定，不外溢到历史消息
			if (!texts.some(t => t.includes('${msgText}'))) continue;
			return texts.some(t => t.includes('coclaw-attachments'));
		}
		return false;
	`);
	expect(hasBlock).toBe(true);
});

// ================================================================
// Test 2: 纯文件发送（无文本）
// ================================================================

test('附件发送：仅文件无文本 @chat @file', async ({ page }) => {
	test.setTimeout(240_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionInfo = await navigateToChat(page);
	test.skip(!sessionInfo, 'No chat session available');

	await waitChatReady(page);

	const rtcInfo = await waitRtcReady(page).catch(() => null);
	test.skip(!rtcInfo, 'RTC not available');

	// 仅注入文件，不输入文本
	const fileInput = page.getByTestId('file-input');
	await fileInput.setInputFiles({
		name: 'e2e-only-file.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('Only file, no text'),
	});

	// 发送按钮应启用（有文件即可发送）
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
	await page.getByTestId('btn-send').click();

	// 附件卡片应出现
	await expect(async () => {
		const cards = page.locator('[data-testid="chat-root"] main .items-end [data-testid="msg-attachment-card"]');
		const count = await cards.count();
		expect(count).toBeGreaterThanOrEqual(1);
	}).toPass({ timeout: 10_000 });

	// claw 回复完成（stop 按钮消失 = sending 结束）
	await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });
});

// ================================================================
// Test 3: 图片附件 — inline 预览 + 附件信息块
// ================================================================

test('附件发送：图片文件在消息中显示预览 @chat @file', async ({ page }) => {
	test.setTimeout(240_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionInfo = await navigateToChat(page);
	test.skip(!sessionInfo, 'No chat session available');

	await waitChatReady(page);

	const rtcInfo = await waitRtcReady(page).catch(() => null);
	test.skip(!rtcInfo, 'RTC not available');

	const msgText = `e2e_img_${Date.now()}`;
	await typeText(page.getByTestId('chat-textarea'), msgText);

	// 注入 1x1 PNG
	const pngBuffer = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
		'base64',
	);
	const fileInput = page.getByTestId('file-input');
	await fileInput.setInputFiles({
		name: 'e2e-test-image.png',
		mimeType: 'image/png',
		buffer: pngBuffer,
	});

	// 发送
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
	await page.getByTestId('btn-send').click();

	// 用户消息应出现
	// 作用域限定到消息列表并取首个：agent 常回显 token，裸 text= 会同时命中用户气泡与回显 → strict-mode 报错
	await expect(
		page.locator('[data-testid="chat-msg-item"]').filter({ hasText: msgText }).first(),
	).toBeVisible({ timeout: 10_000 });

	// 图片附件应以预览卡片出现在用户消息区。
	// 数附件卡片 data-testid，不依赖真实像素渲染（ChatImg 三态根节点都带 chat-img）。
	await expect(async () => {
		const cards = page.locator('[data-testid="chat-root"] main .items-end [data-testid="chat-img"]');
		const count = await cards.count();
		expect(count).toBeGreaterThanOrEqual(1);
	}).toPass({ timeout: 10_000 });

	// claw 回复完成（stop 按钮消失 = sending 结束）
	await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });
});

// ================================================================
// Test 4: 上传进度 UI 展示
// ================================================================

test('附件发送：上传期间显示进度 UI @chat @file', async ({ page }) => {
	// 与其它真实发送用例对齐：180s 回复等待 + 上传 + 登录/导航需大于 120s，避免 per-test cap 先于等待触发
	test.setTimeout(240_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionInfo = await navigateToChat(page);
	test.skip(!sessionInfo, 'No chat session available');

	await waitChatReady(page);

	const rtcInfo = await waitRtcReady(page).catch(() => null);
	test.skip(!rtcInfo, 'RTC not available');

	// 注入足够大的文件，让 DC 上传跨越多个分片/流控窗口（16KB chunk + 64KB 水位 + 100ms 进度节流），
	// 使“上传中”进度环存在的时间窗远大于 Playwright 轮询间隔 → 可稳定捕获，不靠瞬态
	const largeBuffer = Buffer.alloc(16 * 1024 * 1024, 'E2E test data ');
	const fileInput = page.getByTestId('file-input');
	await fileInput.setInputFiles({
		name: 'e2e-large-file.bin',
		mimeType: 'application/octet-stream',
		buffer: largeBuffer,
	});

	await typeText(page.getByTestId('chat-textarea'), `e2e_progress_${Date.now()}`);

	// 发送
	await page.getByTestId('btn-send').click();

	// 真实进度断言：附件预览覆层渲染 ProgressRing（role=progressbar，仅 fileUploadState[id].status
	// ==='uploading' 时存在）。这是“正在上传”的确定性 UI 信号，区别于“正在发送”（btn-stop 对任何发送都为真）；
	// 若进度条被移除/损坏，本断言变红，而不是像只看 btn-stop 那样假绿。进度环在 footer 内，定位到 footer 以避免误配。
	await expect(page.locator('footer').getByRole('progressbar')).toBeVisible({ timeout: 30_000 });

	// 上传完成后 claw 回复，stop 按钮消失
	await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });
});

// ================================================================
// Test 5: 多文件附件发送
// ================================================================

test('附件发送：多个文件同时发送 @chat @file', async ({ page }) => {
	test.setTimeout(240_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionInfo = await navigateToChat(page);
	test.skip(!sessionInfo, 'No chat session available');

	await waitChatReady(page);

	const rtcInfo = await waitRtcReady(page).catch(() => null);
	test.skip(!rtcInfo, 'RTC not available');

	const msgText = `e2e_multi_${Date.now()}`;
	await typeText(page.getByTestId('chat-textarea'), msgText);

	// 注入两个文件
	const fileInput = page.getByTestId('file-input');
	await fileInput.setInputFiles([
		{
			name: 'e2e-file-a.txt',
			mimeType: 'text/plain',
			buffer: Buffer.from('File A content'),
		},
		{
			name: 'e2e-file-b.txt',
			mimeType: 'text/plain',
			buffer: Buffer.from('File B content'),
		},
	]);

	// 两个文件预览出现
	await expect(page.locator('footer .group')).toHaveCount(2, { timeout: 5000 });

	// 发送
	await page.getByTestId('btn-send').click();

	// 用户消息出现
	// 作用域限定到消息列表并取首个：agent 常回显 token，裸 text= 会同时命中用户气泡与回显 → strict-mode 报错
	await expect(
		page.locator('[data-testid="chat-msg-item"]').filter({ hasText: msgText }).first(),
	).toBeVisible({ timeout: 10_000 });

	// 两个附件卡片出现
	await expect(async () => {
		const cards = page.locator('[data-testid="chat-root"] main .items-end [data-testid="msg-attachment-card"]');
		const count = await cards.count();
		expect(count).toBeGreaterThanOrEqual(2);
	}).toPass({ timeout: 10_000 });

	// claw 回复完成（stop 按钮消失 = sending 结束）
	await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });
});

// ================================================================
// Test 6: 附件文件实际存在于 workspace
// ================================================================

test('附件发送：上传的文件实际存在于 agent workspace @chat @file', async ({ page }) => {
	test.setTimeout(240_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionInfo = await navigateToChat(page);
	test.skip(!sessionInfo, 'No chat session available');

	await waitChatReady(page);

	const rtcInfo = await waitRtcReady(page).catch(() => null);
	test.skip(!rtcInfo, 'RTC not available');

	const ts = Date.now();
	const uniqueContent = `workspace_verify_${ts}`;
	// 用时间戳作为文件名一部分，确保跨 run 唯一
	const fileName = `e2e-verify-${ts}.txt`;
	await typeText(page.getByTestId('chat-textarea'), uniqueContent);

	const fileInput = page.getByTestId('file-input');
	await fileInput.setInputFiles({
		name: fileName,
		mimeType: 'text/plain',
		buffer: Buffer.from(uniqueContent),
	});

	await page.getByTestId('btn-send').click();

	// 等待 claw 回复完成
	await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });

	// 从 store 中提取附件路径：用文件名中的时间戳精确匹配，避免匹配到历史消息
	let attachmentPath = null;
	const tsStr = String(ts);
	await expect(async () => {
		attachmentPath = await evalStore(page, 'chat', `
			for (const m of (store.messages || [])) {
				if (m.message?.role !== 'user') continue;
				const c = m.message.content;
				const texts = typeof c === 'string' ? [c]
					: Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text)
					: [];
				for (const t of texts) {
					if (!t.includes('${tsStr}')) continue;
					const match = t.match(/\\| (\\.coclaw\\/[^\\s|]+) \\|/);
					if (match) return match[1];
				}
			}
			return null;
		`);
		expect(attachmentPath).not.toBeNull();
	}).toPass({ timeout: 15_000 });

	test.skip(!attachmentPath, 'Could not find attachment path in messages');
	console.log('Attachment path:', attachmentPath);

	// 通过 file-transfer service 验证文件实际存在
	const downloaded = await page.evaluate(async ({ clawId, filePath }) => {
		const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
		const { downloadFile } = await import('/src/services/file-transfer.js');
		const conn = useClawConnections().get(clawId);
		const handle = downloadFile(conn, 'main', filePath);
		const result = await handle.promise;
		return await result.blob.text();
	}, { clawId: rtcInfo.clawId, filePath: attachmentPath });

	expect(downloaded).toBe(uniqueContent);
});

// ================================================================
// Test 7: 聊天里拖入文件触发上传蒙层
// ================================================================

test('拖入文件显示上传蒙层 @chat @file', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionInfo = await navigateToChat(page);
	test.skip(!sessionInfo, 'No chat session available');

	await waitChatReady(page);
	// 蒙层为纯本地状态，不依赖 RTC；仅需 chat-root + 非 sending（inputLocked=false）

	// 构造带文件的 DataTransfer（items.add(File) 使 types 含 'Files'），向 chat-root 派发 dragover
	const dataTransfer = await page.evaluateHandle(() => {
		const dt = new DataTransfer();
		dt.items.add(new File(['drag payload'], 'drag-e2e.txt', { type: 'text/plain' }));
		return dt;
	});
	await page.dispatchEvent('[data-testid="chat-root"]', 'dragover', { dataTransfer });

	// 上传蒙层出现（dropHint 文案，双语）
	await expect(page.getByText(/松开以上传文件|Drop files to upload/)).toBeVisible({ timeout: 5000 });

	// 拖离（relatedTarget=null → 关闭蒙层），保持收尾干净
	await page.dispatchEvent('[data-testid="chat-root"]', 'dragleave', { relatedTarget: null });
	await expect(page.getByText(/松开以上传文件|Drop files to upload/)).not.toBeVisible({ timeout: 5000 });
});

// ================================================================
// Test 8: 点击聊天图片附件 → 打开图片预览对话框
// ================================================================

test('点击图片附件打开预览对话框 @chat @file', async ({ page }) => {
	test.setTimeout(240_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionInfo = await navigateToChat(page);
	test.skip(!sessionInfo, 'No chat session available');

	await waitChatReady(page);
	const rtcInfo = await waitRtcReady(page).catch(() => null);
	test.skip(!rtcInfo, 'RTC not available');

	const msgText = `e2e_imgpreview_${Date.now()}`;
	await typeText(page.getByTestId('chat-textarea'), msgText);

	// 注入 1x1 PNG 并发送
	const pngBuffer = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
		'base64',
	);
	await page.getByTestId('file-input').setInputFiles({
		name: `e2e-preview-${Date.now()}.png`,
		mimeType: 'image/png',
		buffer: pngBuffer,
	});
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
	await page.getByTestId('btn-send').click();

	// 我的消息出现（确保已发送）
	// 作用域限定到消息列表并取首个：agent 常回显 token，裸 text= 会同时命中用户气泡与回显 → strict-mode 报错
	await expect(
		page.locator('[data-testid="chat-msg-item"]').filter({ hasText: msgText }).first(),
	).toBeVisible({ timeout: 10_000 });

	// 用户侧附件缩略图加载完成（imgLoaded → cursor-pointer），点击最新一张。
	// 缩略图右上角有下载按钮覆盖层，点中心会被其拦截 → 点左下角区域（避开右上按钮）触发 viewImg。
	const thumb = page.locator('[data-testid="chat-root"] main .items-end img.cursor-pointer').last();
	await expect(thumb).toBeVisible({ timeout: 15_000 });
	await thumb.click({ position: { x: 4, y: 34 } });

	// 图片预览对话框打开（含全图 img）
	const dialog = page.locator('[role="dialog"]');
	await expect(dialog).toBeVisible({ timeout: 10_000 });
	await expect(dialog.locator('img')).toBeVisible();

	// 关闭对话框
	await page.keyboard.press('Escape');
	await expect(dialog).not.toBeVisible({ timeout: 5000 });

	// 让本次 agent run 收尾，避免悬挂
	await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });
});
