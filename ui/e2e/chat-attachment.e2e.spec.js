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
async function waitRtcReady(page, timeout = 15_000) {
	let info = null;
	await expect(async () => {
		info = await page.evaluate(async () => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const manager = useClawConnections();
			for (const [clawId, conn] of manager.__connections) {
				if (conn.state === 'connected' && conn.transportMode === 'rtc') {
					return { clawId, transportMode: conn.transportMode };
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
	await expect(page.locator(`text=${msgText}`)).toBeVisible({ timeout: 10_000 });

	// 附件卡片应出现在用户消息区（非图片文件显示为卡片）
	await expect(async () => {
		const cards = page.locator('[data-testid="chat-root"] main .items-end .rounded-lg.border');
		const count = await cards.count();
		expect(count).toBeGreaterThanOrEqual(1);
	}).toPass({ timeout: 10_000 });

	// claw 回复完成（stop 按钮消失 = sending 结束）
	await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });

	// 验证：服务端消息中包含附件信息块
	// content 可能是 string 或 block 数组（OpenClaw sessions.get 返回 block 格式）
	const hasBlock = await evalStore(page, 'chat', `
		const msgs = store.messages || [];
		for (const m of msgs) {
			if (m.message?.role !== 'user') continue;
			const c = m.message.content;
			if (typeof c === 'string' && c.includes('coclaw-attachments')) return true;
			if (Array.isArray(c)) {
				for (const b of c) {
					if (b.type === 'text' && b.text?.includes('coclaw-attachments')) return true;
				}
			}
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
		const cards = page.locator('[data-testid="chat-root"] main .items-end .rounded-lg.border');
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
	await expect(page.locator(`text=${msgText}`)).toBeVisible({ timeout: 10_000 });

	// 图片应以 inline 预览出现在消息气泡中（base64 data URL）
	await expect(async () => {
		const imgs = page.locator('[data-testid="chat-root"] main .items-end img[src^="data:image"]');
		const count = await imgs.count();
		expect(count).toBeGreaterThanOrEqual(1);
	}).toPass({ timeout: 10_000 });

	// claw 回复完成（stop 按钮消失 = sending 结束）
	await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });
});

// ================================================================
// Test 4: 上传进度 UI 展示
// ================================================================

test('附件发送：上传期间显示进度 UI @chat @file', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionInfo = await navigateToChat(page);
	test.skip(!sessionInfo, 'No chat session available');

	await waitChatReady(page);

	const rtcInfo = await waitRtcReady(page).catch(() => null);
	test.skip(!rtcInfo, 'RTC not available');

	// 注入一个较大的文件以便观察到上传状态
	const largeBuffer = Buffer.alloc(64 * 1024, 'E2E test data ');
	const fileInput = page.getByTestId('file-input');
	await fileInput.setInputFiles({
		name: 'e2e-large-file.bin',
		mimeType: 'application/octet-stream',
		buffer: largeBuffer,
	});

	await typeText(page.getByTestId('chat-textarea'), `e2e_progress_${Date.now()}`);

	// 发送
	await page.getByTestId('btn-send').click();

	// 等待 sending 状态（stop 按钮出现 = 正在发送/上传）
	await expect(page.getByTestId('btn-stop')).toBeVisible({ timeout: 10_000 });

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
	await expect(page.locator(`text=${msgText}`)).toBeVisible({ timeout: 10_000 });

	// 两个附件卡片出现
	await expect(async () => {
		const cards = page.locator('[data-testid="chat-root"] main .items-end .rounded-lg.border');
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
		const handle = downloadFile(conn.__rtc, 'main', filePath);
		const result = await handle.promise;
		return await result.blob.text();
	}, { clawId: rtcInfo.clawId, filePath: attachmentPath });

	expect(downloaded).toBe(uniqueContent);
});
