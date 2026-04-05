import { execSync } from 'child_process';
import { expect, test } from '@playwright/test';
import { login, evalStore } from './helpers.js';

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

test('Claw 绑定与解绑：完整流程 @bind', async ({ page }) => {
	test.setTimeout(180_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);

	// --- 记录绑定前的 claw 列表 ---
	await page.goto('/claws');
	await expect(page.getByTestId('btn-refresh-claws')).toBeVisible({ timeout: 10_000 });
	// 等待 claws store 加载完成
	await page.waitForTimeout(1000);
	const clawIdsBefore = await evalStore(page, 'claws', 'return store.items.map(b => String(b.id))');

	// ================================================================
	// BIND
	// ================================================================

	await page.goto('/claws/add');

	// 等待绑定码出现（shell 命令区域的 pre 元素）
	const preTags = page.locator('main pre');
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
	const newClawId = newClawIds[0];
	console.log('[e2e] new claw id:', newClawId);

	// 验证新 claw 的卡片可见
	const clawCard = page.getByTestId('claw-' + newClawId);
	await expect(clawCard).toBeVisible({ timeout: 5000 });

	// ================================================================
	// UNBIND
	// ================================================================

	// 点击新 claw 卡片中的解绑按钮
	const unbindBtn = clawCard.locator('button[color="error"], button.text-error').first();
	// 如果上面选择器不准确，用最后一个 button（解绑按钮在卡片右侧）
	const btnCount = await clawCard.locator('button').count();
	const actualUnbindBtn = btnCount > 0 ? clawCard.locator('button').last() : unbindBtn;
	await actualUnbindBtn.click();

	// 等待解绑完成（claw 卡片消失或 claw 列表更新）
	await expect(async () => {
		const currentIds = await evalStore(page, 'claws', 'return store.items.map(b => String(b.id))');
		expect(currentIds).not.toContain(newClawId);
	}).toPass({ timeout: 15_000 });

	// 验证 claw 卡片不再可见
	await expect(clawCard).not.toBeVisible({ timeout: 5000 });

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

	console.log('[e2e] claw bind/unbind flow completed, environment restored');
});
