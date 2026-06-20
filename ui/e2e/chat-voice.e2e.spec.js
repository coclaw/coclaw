import { expect, test } from '@playwright/test';
import { login, navigateToChat, waitChatReady } from './helpers.js';

/**
 * 桌面端语音录制发送 E2E 测试
 *
 * 前置条件：
 * - server、OpenClaw gateway、plugin 均运行中
 * - test 用户已绑定 online claw（RTC 模式可用，语音文件经 DC 上传）
 * - 浏览器以 --use-fake-device-for-media-stream + --use-fake-ui-for-media-stream 启动
 *   （见 playwright.config.js）：getUserMedia 自动放行并提供假音频设备
 *
 * 核心流程（确定性、不依赖 agent 回复）：点麦克风 → 录音波形出现 → 停止 →
 * footer 出现语音 chip → 发送 → 用户消息区出现音频附件（ChatAudio）→
 * 上传的 voice_*.webm 真实落地 agent workspace。
 *
 * 为何不等 agent 回复消失（btn-stop）：语音消息要先转录再回复，真实回复时延极不稳定
 * （实测 30s~190s+），等回复会让用例 flaky 且若回复超时还会在抓到上传路径前就失败而泄漏文件。
 * 本用例的价值在"录制+上传"，agent 回复链路已由 chat-attachment 覆盖，故此处用 workspace
 * 落地校验替代回复等待，确定性收敛。
 *
 * 不测试：auth / bind（已有专用测试）；移动端语音（按住说话）
 */

/** 等待 RTC 就绪，返回 claw 连接信息（与 chat-attachment 同款） */
async function waitRtcReady(page, timeout = 30_000) {
	let info = null;
	await expect(async () => {
		info = await page.evaluate(async () => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const manager = useClawConnections();
			for (const [clawId, conn] of manager.__connections) {
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

/** 取当前 chat store 的附件目录（chat 模式 chatFilesDir / topic 模式 topicFilesDir） */
function getChatFilesDir(page) {
	return page.evaluate(async () => {
		const { chatFilesDir, topicFilesDir } = await import('/src/utils/file-helper.js');
		const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
		if (!pinia) return null;
		let store = null;
		for (const [key, s] of pinia._s) {
			if (key.startsWith('chat-')) store = s;
		}
		if (!store) return null;
		return store.topicMode ? topicFilesDir(store.sessionId) : chatFilesDir(store.chatSessionKey);
	});
}

/** 列出指定目录下的 voice_*.webm 文件名（目录不存在返回空数组） */
function listVoiceFiles(page, clawId, agentId, dir) {
	return page.evaluate(async ({ clawId, agentId, dir }) => {
		const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
		const { listFiles } = await import('/src/services/file-transfer.js');
		const conn = useClawConnections().get(clawId);
		if (!conn) return [];
		try {
			const res = await listFiles(conn, agentId, dir);
			return (res.files || []).map((f) => f.name).filter((n) => /^voice_.*\.webm$/.test(n));
		} catch {
			return []; // 目录尚不存在（首次上传前）
		}
	}, { clawId, agentId, dir });
}

/**
 * 已注册的待清理路径——afterEach 保证删除上传的 voice 文件，避免泄漏到共享 workspace。
 * 语音文件名形如 voice_<ts>[-<服务端去重后缀>].webm，跨 run 唯一。
 */
const cleanupTargets = [];
function trackCleanup(clawId, agentId, path) {
	cleanupTargets.push({ clawId, agentId, path });
}

test.afterEach(async ({ page }) => {
	for (const t of cleanupTargets.splice(0)) {
		try {
			await page.evaluate(async ({ clawId, agentId, path }) => {
				const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
				const { deleteFile } = await import('/src/services/file-transfer.js');
				const conn = useClawConnections().get(clawId);
				if (conn) await deleteFile(conn, agentId, path, { force: true });
			}, t);
		} catch { /* 删已不存在的路径返回 404，吞掉 */ }
	}
});

// 用户消息区的音频附件 = ChatAudio 根元素。ChatAudio 无 testid，且 .webm 经 isVoiceByExt
// 始终渲染为 ChatAudio（非 ChatFile/msg-attachment-card）；其根带 rounded-xl + border-accented
// + text-muted（ChatFile 根无 text-muted），可与文件卡区分，且 locale 无关。
const USER_AUDIO_CARD = '[data-testid="chat-root"] main .items-end .rounded-xl.border-accented.text-muted';

// ================================================================
// Test 1: 录制语音 → 发送 → 用户消息区出现音频附件 → 上传文件落地
// ================================================================

test('语音录制：录制→发送→音频附件入消息→文件上传落地 @chat @file', async ({ page, context }) => {
	// 链路：登录+导航(~45s) + 等 RTC + 录制 + 上传校验；不等 agent 回复故无需 240s
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);
	await context.grantPermissions(['microphone']);

	const sessionInfo = await navigateToChat(page);
	test.skip(!sessionInfo, 'No chat session available');

	await waitChatReady(page);

	// 上传走 DC，需 RTC 就绪
	const rtcInfo = await waitRtcReady(page).catch(() => null);
	test.skip(!rtcInfo, 'RTC not available, cannot test voice upload');

	// 录制前基线：附件目录 + 已有 voice 文件（区分历史/其它 run 文件）
	const dir = await getChatFilesDir(page);
	expect(dir).toBeTruthy();
	const beforeVoice = await listVoiceFiles(page, rtcInfo.clawId, sessionInfo.agentId, dir);
	const audioBefore = await page.locator(USER_AUDIO_CARD).count();

	// 点麦克风开始录音
	const micBtn = page.getByTestId('btn-mic-desktop');
	await expect(micBtn).toBeEnabled({ timeout: 20_000 });
	await micBtn.click();

	// 录音行/波形容器出现
	await expect(page.getByTestId('voice-recording')).toBeVisible({ timeout: 10_000 });

	// 攒几帧音频（假设备会持续产出假音频数据）
	await page.waitForTimeout(800);

	// 停止录音 → 生成语音文件
	await page.getByTestId('btn-voice-stop').click();

	// footer 出现语音 chip（即将发送的附件预览）
	await expect(page.getByTestId('voice-attachment-card')).toBeVisible({ timeout: 10_000 });

	// 有附件即可发送
	await expect(page.getByTestId('btn-send')).toBeEnabled({ timeout: 5000 });
	await page.getByTestId('btn-send').click();

	// 用户消息区出现新的音频附件卡（ChatAudio）
	await expect(async () => {
		const count = await page.locator(USER_AUDIO_CARD).count();
		expect(count).toBeGreaterThan(audioBefore);
	}).toPass({ timeout: 20_000 });

	// 校验上传：workspace 出现一个新的 voice_*.webm（确定性，不依赖 agent 回复）
	let newName = null;
	await expect(async () => {
		const cur = await listVoiceFiles(page, rtcInfo.clawId, sessionInfo.agentId, dir);
		newName = cur.find((n) => !beforeVoice.includes(n)) || null;
		expect(newName).not.toBeNull();
	}).toPass({ timeout: 20_000 });

	// 注册清理（afterEach 删除上传文件，无泄漏）。落地文件名为
	// voice_<ts>[-<服务端去重后缀>].webm（postFile 防碰撞会追加 -xxxx）。
	const voicePath = `${dir}/${newName}`;
	trackCleanup(rtcInfo.clawId, sessionInfo.agentId, voicePath);
	expect(newName).toMatch(/^voice_\d+(-[0-9a-f]+)?\.webm$/);

	// 尽力终止在飞的 agent run（不等终态——真回复慢且不稳），减少跨用例残留。
	await page.getByTestId('btn-stop').click().catch(() => { /* 已结束/不可见则忽略 */ });
});

// ================================================================
// Test 2: 取消录音 — 不产生附件，麦克风按钮复现
// ================================================================

test('语音录制：取消录音不产生附件 @chat', async ({ page, context }) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1280, height: 720 });
	await login(page);
	await context.grantPermissions(['microphone']);

	const sessionInfo = await navigateToChat(page);
	test.skip(!sessionInfo, 'No chat session available');

	await waitChatReady(page);
	// 取消不上传，不依赖 RTC；mic 按钮仅受 loading/sending 控制

	const micBtn = page.getByTestId('btn-mic-desktop');
	await expect(micBtn).toBeEnabled({ timeout: 20_000 });
	await micBtn.click();

	// 录音行出现
	await expect(page.getByTestId('voice-recording')).toBeVisible({ timeout: 10_000 });
	await page.waitForTimeout(500);

	// 取消录音
	await page.getByTestId('btn-voice-cancel').click();

	// 录音行消失、麦克风按钮复现、无语音 chip
	await expect(page.getByTestId('voice-recording')).not.toBeVisible({ timeout: 10_000 });
	await expect(micBtn).toBeVisible({ timeout: 5000 });
	await expect(page.getByTestId('voice-attachment-card')).toHaveCount(0);
});
