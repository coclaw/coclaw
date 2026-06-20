import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady, evalStore, typeText } from './helpers.js';

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
		// setup(login+nav ~45s) + /compact 往返（30s 上限）≈75s，60s 偏紧 → 抬到 90s
		test.setTimeout(90_000);
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

	// 新场景 #4：/new 重置后仍能正常发消息，且先前历史从活跃会话清空（旧 session 孤儿化）。
	// 与上面"消息刷新"用例互补——那条只验 sessionId 翻新；这条跑完整链路：重置 → 发送 → 收到
	// 真回复，并断言旧 session 的消息不再出现在活跃 messages（已归档进 historySegments，非活跃流）。
	// 断言全部锚 store 信号，不依赖正文 UI 文案。
	test('/new 重置后能正常发送且历史清空', async ({ page }) => {
		// setup(~45s) + 重置往返 + 发送 + 真回复（180s 安全窗）→ 给足 240s
		test.setTimeout(240_000);
		test.skip(!sessionId, 'No chat session available');
		await waitChatReady(page);

		const readSid = () => evalStore(page, 'chat', 'return store.currentSessionId || "";');
		// 等首次 chat.history 落定，拿到重置前的 live sessionId 与旧消息 id 集合（仅保留时间戳形
		// id：wrapOcMessages 对无 timestamp 的消息回退为位置式 oc-<i>，跨 session 会碰撞，排除以免误报）
		await expect.poll(readSid, { timeout: 15_000 }).not.toBe('');
		const beforeSid = await readSid();
		const oldIds = await evalStore(page, 'chat', 'return store.messages.map(m => m.id).filter(Boolean);');
		const oldTsIds = oldIds.filter((id) => /^oc-\w+-\d{6,}$/.test(id));

		// /new：打开菜单点重置
		await page.getByTestId('btn-slash-menu').click();
		const resetItem = page.locator('.max-w-60 button').filter({ hasText: /reset|重置/i });
		await expect(resetItem).toBeVisible({ timeout: 3000 });
		await resetItem.click();

		// 命令往返结束，textarea 解锁
		await expect(page.getByTestId('chat-textarea')).toBeEnabled({ timeout: 60_000 });

		// 等 currentSessionId 翻成新的非空 id（loadMessages 在 final 后异步刷新它）
		await expect.poll(async () => {
			const sid = await readSid();
			return !!sid && sid !== beforeSid;
		}, { timeout: 30_000 }).toBe(true);
		const newSid = await readSid();

		// 历史清空在 store 层的样子：旧消息移出活跃 messages（归档进 historySegments），
		// 活跃 messages 回到 fresh 基线（理应为 0；放 5 条余量），远低于旧 session 历史（>50/50 上限）。
		const freshCount = await evalStore(page, 'chat', 'return store.messages.length;');
		console.log(`[b4] /new reset: beforeSid=${beforeSid} newSid=${newSid} oldTsIds=${oldTsIds.length} freshCount=${freshCount}`);
		expect(freshCount).toBeLessThanOrEqual(5);

		// 重置后正常发一条消息，确认新 session 可用、能拿到真回复
		const testMsg = `e2e slash-new ${Date.now()}`;
		await typeText(page.getByTestId('chat-textarea'), testMsg);
		await expect(page.getByTestId('chat-textarea')).toHaveValue(testMsg, { timeout: 3000 });
		await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
		await page.getByTestId('btn-send').click();

		// 用户消息气泡出现
		const msgItems = page.getByTestId('chat-msg-item');
		await expect(msgItems.filter({ hasText: testMsg }).first()).toBeVisible({ timeout: 30_000 });

		// 真回复完成：btn-stop 消失（真回复慢，给 180s 安全窗；不等 btn-send 出现）
		await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });

		// 等 store 重载完成：活跃会话里出现我发的 user 消息 + 至少一条 assistant 回复
		// （final 后 loadMessages 异步重载，btn-stop 消失到 store 落定可能有短暂窗口 → poll）
		await expect.poll(async () => {
			return evalStore(page, 'chat', `
				const text = (m) => { const x = m.message?.content; return typeof x === 'string' ? x : JSON.stringify(x ?? ''); };
				const hasMyUser = store.messages.some((m) => m.message?.role === 'user' && text(m).includes(${JSON.stringify(testMsg)}));
				const hasAssistant = store.messages.some((m) => m.message?.role === 'assistant');
				return hasMyUser && hasAssistant;
			`);
		}, { timeout: 30_000 }).toBe(true);

		// 历史清空 + 会话一致性的精确断言
		const result = await evalStore(page, 'chat', `
			const old = ${JSON.stringify(oldTsIds)};
			const curIds = new Set(store.messages.map((m) => m.id));
			return {
				total: store.messages.length,
				leakedOld: old.filter((id) => curIds.has(id)),
				sid: store.currentSessionId || '',
			};
		`);
		console.log(`[b4] after send: ${JSON.stringify(result)}`);
		// 历史清空：重置前 live session 的消息均不在活跃 messages（已孤儿化）
		expect(result.leakedOld).toEqual([]);
		// 会话仍是重置后那个新 session（没回跳到旧 session）
		expect(result.sid).toBe(newSid);

		// 页面仍正常
		await expect(page.getByTestId('chat-root')).toBeVisible();
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
		// 不显式设 setTimeout：beforeEach(login+nav ~25s)+waitChatReady(~20s)+离线断言 ≈55s，
		// 继承 describe 的 60_000；原 30_000 会下调到默认上限之下、在高负载下偶被截断。
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
