import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady, typeText } from './helpers.js';

/**
 * ChatInput 交互 E2E 测试
 *
 * 前置条件：
 * - server 运行中
 * - test 用户已有至少一个 online bot
 * - 存在可用 session
 */

// ================================================================
// Test 1: 文件附件 → 预览 → 移除
// ================================================================

test('ChatInput：文件附件预览与移除 @chat', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionId = await navigateToChat(page);
	test.skip(!sessionId, 'No chat session available');

	await waitChatReady(page);

	// 通过隐藏 file input 注入测试文件
	const fileInput = page.getByTestId('file-input');

	// 创建一个文本文件
	await fileInput.setInputFiles({
		name: 'test-doc.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('E2E test file content'),
	});

	// 文件预览应出现（非图片文件显示文件卡片）
	const filePreview = page.locator('footer .group').first();
	await expect(filePreview).toBeVisible({ timeout: 5000 });

	// 移除按钮应存在
	const removeBtn = filePreview.locator('button');
	await expect(removeBtn).toBeVisible();

	// 点击移除
	await removeBtn.click();

	// 文件预览应消失
	await expect(filePreview).not.toBeVisible({ timeout: 3000 });
});

// ================================================================
// Test 2: 图片附件 → 缩略图预览
// ================================================================

test('ChatInput：图片附件显示缩略图 @chat', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionId = await navigateToChat(page);
	test.skip(!sessionId, 'No chat session available');

	await waitChatReady(page);

	const fileInput = page.getByTestId('file-input');

	// 注入一个 PNG 图片（1x1 像素透明 PNG）
	const pngBuffer = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
		'base64',
	);
	await fileInput.setInputFiles({
		name: 'test-image.png',
		mimeType: 'image/png',
		buffer: pngBuffer,
	});

	// 图片缩略图应出现
	const thumbnail = page.locator('footer img[alt="test-image.png"]');
	await expect(thumbnail).toBeVisible({ timeout: 5000 });

	// 移除
	const removeBtn = page.locator('footer .group button').first();
	await removeBtn.click();
	await expect(thumbnail).not.toBeVisible({ timeout: 3000 });
});

// ================================================================
// Test 3: 多文件附件
// ================================================================

test('ChatInput：支持多文件附件 @chat', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionId = await navigateToChat(page);
	test.skip(!sessionId, 'No chat session available');

	await waitChatReady(page);

	const fileInput = page.getByTestId('file-input');

	// 注入两个文件
	await fileInput.setInputFiles([
		{
			name: 'file1.txt',
			mimeType: 'text/plain',
			buffer: Buffer.from('File 1'),
		},
		{
			name: 'file2.txt',
			mimeType: 'text/plain',
			buffer: Buffer.from('File 2'),
		},
	]);

	// 应出现两个文件预览
	const previews = page.locator('footer .group');
	await expect(previews).toHaveCount(2, { timeout: 5000 });

	// 移除第一个
	await previews.first().locator('button').click();
	await expect(page.locator('footer .group')).toHaveCount(1, { timeout: 3000 });

	// 移除第二个
	await page.locator('footer .group').first().locator('button').click();
	await expect(page.locator('footer .group')).toHaveCount(0, { timeout: 3000 });
});

// ================================================================
// Test 4: 桌面端 Enter 发送消息
// ================================================================

test('ChatInput：桌面端 Enter 键发送消息 @chat', async ({ page }) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionId = await navigateToChat(page);
	test.skip(!sessionId, 'No chat session available');

	await waitChatReady(page);

	const textarea = page.getByTestId('chat-textarea');
	const msgText = 'E2E_ENTER_' + Date.now();

	await typeText(textarea, msgText);

	// 按 Enter 发送
	await textarea.press('Enter');

	// 发送按钮应消失（进入 sending 状态）或消息出现在列表中
	await expect(async () => {
		const pageText = await page.locator('main').innerText();
		expect(pageText).toContain(msgText);
	}).toPass({ timeout: 10_000 });
});

// ================================================================
// Test 5: 桌面端 Shift+Enter 不发送，插入换行
// ================================================================

test('ChatInput：桌面端 Shift+Enter 不发送 @chat', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionId = await navigateToChat(page);
	test.skip(!sessionId, 'No chat session available');

	await waitChatReady(page);

	const textarea = page.getByTestId('chat-textarea');
	const msgText = 'line1';

	await typeText(textarea, msgText);

	// 按 Shift+Enter（应插入换行，不发送）
	await textarea.press('Shift+Enter');
	await textarea.pressSequentially('line2', { delay: 20 });

	// 发送按钮应仍然可见（未发送）
	await expect(page.getByTestId('btn-send')).toBeVisible({ timeout: 3000 });

	// textarea 应包含两行内容
	const value = await textarea.inputValue();
	expect(value).toContain('line1');
	expect(value).toContain('line2');
});

// ================================================================
// Test 6: 空输入时发送按钮禁用
// ================================================================

test('ChatInput：空输入时发送按钮禁用 @chat', async ({ page }) => {
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	const sessionId = await navigateToChat(page);
	test.skip(!sessionId, 'No chat session available');

	await waitChatReady(page);

	// 发送按钮应禁用
	await expect(page.getByTestId('btn-send')).toBeDisabled({ timeout: 5000 });

	// 输入文本后发送按钮应启用
	const textarea = page.getByTestId('chat-textarea');
	await typeText(textarea, 'hello');
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
});
