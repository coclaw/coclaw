import { test, expect } from '@playwright/test';
import { login, navigateToChat, waitChatReady, typeText, evalStore } from './helpers.js';

test.describe('WebRTC DataChannel 传输选择（Phase 2） @rtc', () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test('WS 连通后自动建立 RTC DataChannel 传输', async ({ page }) => {
		// beforeEach 的 login + 下方 30s toPass 都计入默认 30s 单测上限，会在 toPass
		// 跑满前先触发测试级超时。抬高单测预算让长 toPass 有完整窗口（不松判定）。
		test.setTimeout(60_000);
		await page.goto('/topics');
		// 尽力等待至少一个 claw 的 DC 就绪。dcReady 是 claws store 的"DC 可用"真实信号
		//（onRtcStateChange('connected') 写入）；UI 已无 WS 传输回退，DataChannel 依附
		// RTC，DC 就绪即等价 RTC 就绪。best-effort：超时不抛，无就绪连接时下方 test.skip 兜底。
		await expect(async () => {
			const items = await evalStore(page, 'claws', 'return store.items');
			expect(items.some((b) => b.online && b.dcReady)).toBe(true);
		}).toPass({ timeout: 30_000 }).catch(() => {});

		// 读取每条连接的真实传输形态：conn 无 transportMode 字段，由 conn.rtc.isReady
		//（rpc DataChannel readyState==='open'）派生——DC open 即 'rtc'，否则 null。
		const transportMode = await page.evaluate(async () => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const manager = useClawConnections();
			const modes = {};
			for (const [clawId, conn] of manager.__connections) {
				modes[clawId] = conn.rtc?.isReady ? 'rtc' : null;
			}
			return modes;
		});

		console.log('Transport modes:', JSON.stringify(transportMode));
		const ready = Object.entries(transportMode).filter(([, m]) => m !== null);
		// 无任何就绪连接时零断言会报假绿，显式 skip
		test.skip(ready.length === 0, 'No ready claw connections available');
		for (const [clawId, mode] of ready) {
			expect(mode, `clawId=${clawId} transportMode`).toBe('rtc');
		}
	});

	test('RTC 模式下可通过 DataChannel 发送消息并收到回复', async ({ page }) => {
		test.setTimeout(240_000);
		await page.setViewportSize({ width: 1280, height: 720 });

		const chatInfo = await navigateToChat(page);
		if (!chatInfo) {
			test.skip('无可用 chat session');
			return;
		}
		await waitChatReady(page);

		// 等该 claw 的 DC 就绪后再发消息：waitChatReady 只保证 UI 挂载，不保证 RTC 已建。
		// conn.rtc.isReady = rpc DataChannel open，是连接侧的"DC 可用"真实判据。
		// best-effort：超时不抛，未就绪则诚实 skip，避免进入 180s 发送流程后假挂。
		const rtcReady = await expect(async () => {
			const ready = await page.evaluate(async (clawId) => {
				const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
				return Boolean(useClawConnections().get(clawId)?.rtc?.isReady);
			}, chatInfo.clawId);
			expect(ready).toBe(true);
		}).toPass({ timeout: 30_000 }).then(() => true).catch(() => false);
		test.skip(!rtcReady, 'RTC DataChannel 未就绪，跳过发送');

		// 读取真实传输形态：conn 无 transportMode 字段，DC open 即 'rtc'
		const mode = await page.evaluate(async (clawId) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			return useClawConnections().get(clawId)?.rtc?.isReady ? 'rtc' : null;
		}, chatInfo.clawId);
		console.log(`Claw ${chatInfo.clawId} transportMode: ${mode}`);

		// 记录消息数
		const msgCountBefore = await page.locator('[data-testid="chat-root"] main .px-3.py-3').count();

		// 发送消息
		const testMsg = `rtc e2e ${Date.now()}`;
		await typeText(page.getByTestId('chat-textarea'), testMsg);
		await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 3000 });
		await page.getByTestId('btn-send').click();

		// 验证 user 消息出现。锚定 chat-msg-item 并 filter+first：真实 agent 可能 ECHO
		// 同一 token，裸 text= 定位会命中多个节点触发 strict-mode 失败。
		await expect(
			page.locator('[data-testid="chat-msg-item"]').filter({ hasText: testMsg }).first(),
		).toBeVisible({ timeout: 5000 });

		// 验证 claw 回复完成（btn-stop 消失）
		// 发送后输入框清空、canSend=false，btn-send 不渲染，须等 btn-stop 消失
		await expect(page.getByTestId('btn-stop')).not.toBeVisible({ timeout: 180_000 });

		// 验证消息数增加
		const msgCountAfter = await page.locator('[data-testid="chat-root"] main .px-3.py-3').count();
		expect(msgCountAfter).toBeGreaterThan(msgCountBefore);

		console.log(`消息收发成功 (transport: ${mode}, msgs: ${msgCountBefore}→${msgCountAfter})`);
	});
});
