import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady, evalStore } from './helpers.js';

/**
 * 斜杠命令 E2E 测试
 *
 * 前置条件：
 * - server 运行中
 * - test 用户已有至少一个 online claw（已绑定且 OpenClaw gateway 运行中）
 * - 存在 agent:main:main session
 */

test.describe('斜杠命令 @chat', () => {
	// beforeEach 的 login + navigateToChat 链（计入每个 test 的总预算）在高负载下可超 30s 默认上限；
	// 抬到 60s。个别 test 体内显式 setTimeout(更大值) 仍会覆盖本配置、不被降低。
	test.describe.configure({ timeout: 60_000 });

	let sessionId;

	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 720 });
		await login(page);
		sessionId = await navigateToChat(page);
	});

	test('斜杠命令菜单可见且可交互', async ({ page }) => {
		test.skip(!sessionId, 'No chat session available');
		await waitChatReady(page);

		// 菜单触发按钮可见
		const btn = page.getByTestId('btn-slash-menu');
		await expect(btn).toBeVisible({ timeout: 5000 });

		// 点击打开菜单
		await btn.click();

		// 菜单弹出层可见，应有两个菜单项
		const popover = page.locator('[data-testid="btn-slash-menu"] + div, [role="dialog"]').or(page.locator('.max-w-60'));
		const items = popover.locator('button');
		await expect(items.first()).toBeVisible({ timeout: 3000 });
		await expect(items).toHaveCount(2);
	});

	test('/compact 命令执行成功', async ({ page }) => {
		test.setTimeout(60_000);
		test.skip(!sessionId, 'No chat session available');
		await waitChatReady(page);

		// 打开菜单并点击压缩上下文
		await page.getByTestId('btn-slash-menu').click();
		const compactItem = page.locator('.max-w-60 button').filter({ hasText: /compact|压缩/i });
		await expect(compactItem).toBeVisible({ timeout: 3000 });

		// W8：/compact 跑在共享的 main session 上——其内容不可控（可能本就无可压缩），
		// 故不断言"摘要消息出现/消息数下降"这类依赖正文的信号（会假阴或假阳），也不追加任何
		// 额外销毁性命令。改为观测命令真实执行的生命周期：点击后 sending=true 让 STOP 出现
		// （证明命令确实下发、非"点了没反应"的空操作），随后 sending=false → textarea 解锁
		// （证明已往返服务端拿到 final）。这把"t=0 即满足"的弱断言换成真往返观测。
		await compactItem.click();

		// 进行中：命令已下发（STOP 出现）
		await expect(page.getByTestId('btn-stop')).toBeVisible({ timeout: 5000 });

		// 完成：往返结束，textarea 解锁
		await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 30_000 });

		// 页面应仍然正常
		await expect(page.getByTestId('chat-root')).toBeVisible();
	});

	test('/new 重置会话后消息刷新', async ({ page }) => {
		test.setTimeout(120_000);
		test.skip(!sessionId, 'No chat session available');
		await waitChatReady(page);

		// W8：捕获重置前的 live sessionId（来自 chat.history 辅助 RPC，需等其落定）。
		// /new 走 sessions.reset，会让 currentSessionId 翻成新 id——下方断言它真的变了，
		// 即真的开了新 session。纯观测，不追加任何额外命令。
		const readSid = () => evalStore(page, 'chat', 'return store.currentSessionId || "";');
		await expect.poll(readSid, { timeout: 15_000 }).not.toBe('');
		const beforeSid = await readSid();

		// 打开菜单并点击重置会话
		await page.getByTestId('btn-slash-menu').click();
		const resetItem = page.locator('.max-w-60 button').filter({ hasText: /reset|重置/i });
		await expect(resetItem).toBeVisible({ timeout: 3000 });
		await resetItem.click();

		// 等待命令完成
		await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 60_000 });

		// 页面应仍然正常
		await expect(page.getByTestId('chat-root')).toBeVisible();

		// W8 核心观测：currentSessionId 变成了一个新的非空 id（loadMessages 在 final 后才异步
		// 刷新它，故 textarea 解锁后仍需轮询等其落定）。证明 /new 真的重置出新 session、非空操作。
		await expect.poll(async () => {
			const sid = await readSid();
			return !!sid && sid !== beforeSid;
		}, { timeout: 30_000 }).toBe(true);
	});

	// 斜杠命令无服务端取消通道：STOP 按钮可见但禁用，避免用户误以为"点了没用"
	test('斜杠命令进行中时 STOP 按钮禁用', async ({ page }) => {
		test.setTimeout(120_000);
		test.skip(!sessionId, 'No chat session available');
		await waitChatReady(page);

		await page.getByTestId('btn-slash-menu').click();
		const compactItem = page.locator('.max-w-60 button').filter({ hasText: /compact|压缩/i });
		await expect(compactItem).toBeVisible({ timeout: 3000 });
		await compactItem.click();

		// 进行中：STOP 可见但 disabled
		const stopBtn = page.getByTestId('btn-stop');
		await expect(stopBtn).toBeVisible({ timeout: 5000 });
		await expect(stopBtn).toBeDisabled({ timeout: 3000 });

		// 等待命令完成
		await expect(stopBtn).not.toBeVisible({ timeout: 60_000 });
	});

	// claw 离线时不应禁用斜杠菜单按钮——业务层 sendSlashCommand 已用 wait-mode
	// 排队（与 sendMessage 对齐），离线点击会被 conn.waitReady() 排队等连接恢复
	test('claw 离线时斜杠菜单按钮仍可点击', async ({ page }) => {
		test.setTimeout(30_000);
		test.skip(!sessionId, 'No chat session available');
		await waitChatReady(page);

		const btn = page.getByTestId('btn-slash-menu');
		await expect(btn).toBeEnabled({ timeout: 5000 });

		// 强制所有 claw 离线
		await evalStore(page, 'claws', `
			for (const claw of store.items) {
				store.updateClawOnline(claw.id, false);
			}
		`);

		// 离线 banner 出现确认状态生效
		const offlineBanner = page.locator('[data-testid="chat-root"] .text-warning');
		await expect(offlineBanner).toBeVisible({ timeout: 5000 });

		// 关键断言：斜杠菜单按钮仍 enabled
		await expect(btn).toBeEnabled({ timeout: 3000 });

		// 恢复在线避免污染后续测试
		await evalStore(page, 'claws', `
			for (const claw of store.items) {
				store.updateClawOnline(claw.id, true);
			}
		`);
	});

	test('topic 模式下不显示斜杠命令菜单', async ({ page }) => {
		// 导航到新建 topic 路由
		await page.goto('/topics/new?agent=main&claw=1');
		// 等待页面加载
		await expect(page.getByTestId('chat-root')).toBeVisible({ timeout: 10_000 });

		// 斜杠命令按钮不应出现
		await expect(page.getByTestId('btn-slash-menu')).not.toBeVisible({ timeout: 3000 });
	});
});
