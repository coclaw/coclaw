import { test, expect } from '@playwright/test';
import { login, TEST_LOGIN_NAME, TEST_PASSWORD } from './helpers.js';

const SERVER = 'http://127.0.0.1:3000';

async function loginAndGetCookies() {
	const res = await fetch(`${SERVER}/api/v1/auth/local/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ loginName: TEST_LOGIN_NAME, password: TEST_PASSWORD }),
	});
	const setCookie = res.headers.getSetCookie?.() ?? [];
	return setCookie.map((c) => c.split(';')[0]).join('; ');
}

/** 确保 test 用户至少绑定了一个在线的 bot */
async function ensureBotBound() {
	const cookies = await loginAndGetCookies();
	const res = await fetch(`${SERVER}/api/v1/bots`, { headers: { cookie: cookies } });
	const data = await res.json();
	const hasOnline = data.items?.some((b) => b.online);
	if (hasOnline) return;
	// 没有在线 bot，打印信息后让测试 graceful skip
	console.warn('No online bot found. Run: openclaw gateway call coclaw.bind --params \'{"code":"<code>","serverUrl":"http://127.0.0.1:3000"}\' to bind.');
}

/**
 * 文件传输 E2E 测试
 *
 * 前提：server、OpenClaw gateway、plugin 均运行中
 * 测试策略：通过 page.evaluate 直接调用 file-transfer service，不依赖 UI 组件
 */
test.describe('文件传输（file-transfer infrastructure）', () => {
	test.setTimeout(60_000);

	test.beforeAll(async () => {
		await ensureBotBound();
	});

	test.beforeEach(async ({ page }) => {
		await login(page);
		// 进入 topics 页以触发 bot 连接和 RTC 建连
		await page.goto('/topics');
		// 等待连接建立（WS + RTC 握手）
		await page.waitForTimeout(8000);
	});

	/** 获取第一个已连接的 botId 和 RTC 状态 */
	async function getConnectedBot(page) {
		const info = await page.evaluate(async () => {
			const { useBotConnections } = await import('/src/services/bot-connection-manager.js');
			const manager = useBotConnections();
			const all = [];
			for (const [botId, conn] of manager.__connections) {
				all.push({ botId, state: conn.state, transportMode: conn.transportMode });
			}
			const connected = all.find((c) => c.state === 'connected');
			return { all, connected: connected ?? null };
		});
		console.log('Bot connections:', JSON.stringify(info.all));
		return info.connected;
	}

	test('listFiles — 列出 agent workspace 根目录', async ({ page }) => {
		const bot = await getConnectedBot(page);
		if (!bot) { test.skip('无已连接的 bot'); return; }

		const result = await page.evaluate(async (botId) => {
			const { useBotConnections } = await import('/src/services/bot-connection-manager.js');
			const { listFiles } = await import('/src/services/file-transfer.js');
			const conn = useBotConnections().get(botId);
			return listFiles(conn, 'main', '');
		}, bot.botId);

		console.log('listFiles result:', JSON.stringify(result));
		expect(result).toHaveProperty('files');
		expect(Array.isArray(result.files)).toBe(true);
	});

	test('listFiles — 不存在的目录返回 NOT_FOUND', async ({ page }) => {
		const bot = await getConnectedBot(page);
		if (!bot) { test.skip('无已连接的 bot'); return; }

		const err = await page.evaluate(async (botId) => {
			const { useBotConnections } = await import('/src/services/bot-connection-manager.js');
			const { listFiles } = await import('/src/services/file-transfer.js');
			const conn = useBotConnections().get(botId);
			try {
				await listFiles(conn, 'main', '__nonexistent_dir_e2e__/');
				return null;
			} catch (e) {
				return { code: e.code, message: e.message };
			}
		}, bot.botId);

		expect(err).not.toBeNull();
		expect(err.code).toBe('NOT_FOUND');
	});

	test('upload → download → delete 完整流程', async ({ page }) => {
		const bot = await getConnectedBot(page);
		if (!bot) { test.skip('无已连接的 bot'); return; }
		if (bot.transportMode !== 'rtc') { test.skip('非 RTC 模式，跳过文件传输'); return; }

		const testFileName = `__e2e_test_${Date.now()}.txt`;
		const testContent = `Hello from E2E test at ${new Date().toISOString()}`;

		// 上传
		const uploadResult = await page.evaluate(async ({ botId, fileName, content }) => {
			const { useBotConnections } = await import('/src/services/bot-connection-manager.js');
			const { uploadFile } = await import('/src/services/file-transfer.js');
			const conn = useBotConnections().get(botId);

			const bytes = new TextEncoder().encode(content);
			const file = new File([bytes], fileName, { type: 'text/plain' });

			const handle = uploadFile(conn.__rtc, 'main', fileName, file);
			return handle.promise;
		}, { botId: bot.botId, fileName: testFileName, content: testContent });

		console.log('Upload result:', JSON.stringify(uploadResult));
		expect(uploadResult).toHaveProperty('bytes');

		// list 验证文件存在
		const listResult = await page.evaluate(async ({ botId, fileName }) => {
			const { useBotConnections } = await import('/src/services/bot-connection-manager.js');
			const { listFiles } = await import('/src/services/file-transfer.js');
			const conn = useBotConnections().get(botId);
			const res = await listFiles(conn, 'main', '');
			return res.files.find((f) => f.name === fileName);
		}, { botId: bot.botId, fileName: testFileName });

		expect(listResult).toBeTruthy();
		expect(listResult.type).toBe('file');

		// 下载
		const downloadResult = await page.evaluate(async ({ botId, fileName }) => {
			const { useBotConnections } = await import('/src/services/bot-connection-manager.js');
			const { downloadFile } = await import('/src/services/file-transfer.js');
			const conn = useBotConnections().get(botId);

			const handle = downloadFile(conn.__rtc, 'main', fileName);
			const result = await handle.promise;
			const text = await result.blob.text();
			return { text, bytes: result.bytes, name: result.name };
		}, { botId: bot.botId, fileName: testFileName });

		console.log('Download result:', JSON.stringify({ bytes: downloadResult.bytes, name: downloadResult.name }));
		expect(downloadResult.text).toBe(testContent);
		expect(downloadResult.name).toBe(testFileName);

		// 删除
		const deleteResult = await page.evaluate(async ({ botId, fileName }) => {
			const { useBotConnections } = await import('/src/services/bot-connection-manager.js');
			const { deleteFile } = await import('/src/services/file-transfer.js');
			const conn = useBotConnections().get(botId);
			return deleteFile(conn, 'main', fileName);
		}, { botId: bot.botId, fileName: testFileName });

		console.log('Delete result:', JSON.stringify(deleteResult));

		// 验证已删除
		const afterDelete = await page.evaluate(async ({ botId, fileName }) => {
			const { useBotConnections } = await import('/src/services/bot-connection-manager.js');
			const { listFiles } = await import('/src/services/file-transfer.js');
			const conn = useBotConnections().get(botId);
			const res = await listFiles(conn, 'main', '');
			return res.files.find((f) => f.name === fileName);
		}, { botId: bot.botId, fileName: testFileName });

		expect(afterDelete).toBeUndefined();
	});

	test('upload 路径穿越被拒', async ({ page }) => {
		const bot = await getConnectedBot(page);
		if (!bot) { test.skip('无已连接的 bot'); return; }
		if (bot.transportMode !== 'rtc') { test.skip('非 RTC 模式'); return; }

		const err = await page.evaluate(async (botId) => {
			const { useBotConnections } = await import('/src/services/bot-connection-manager.js');
			const { uploadFile } = await import('/src/services/file-transfer.js');
			const conn = useBotConnections().get(botId);

			const file = new File([new Uint8Array(10)], 'evil.txt');
			const handle = uploadFile(conn.__rtc, 'main', '../../../tmp/evil.txt', file);
			try {
				await handle.promise;
				return null;
			} catch (e) {
				return { code: e.code, message: e.message };
			}
		}, bot.botId);

		expect(err).not.toBeNull();
		expect(err.code).toBe('PATH_DENIED');
	});

	test('download 不存在的文件返回 NOT_FOUND', async ({ page }) => {
		const bot = await getConnectedBot(page);
		if (!bot) { test.skip('无已连接的 bot'); return; }
		if (bot.transportMode !== 'rtc') { test.skip('非 RTC 模式'); return; }

		const err = await page.evaluate(async (botId) => {
			const { useBotConnections } = await import('/src/services/bot-connection-manager.js');
			const { downloadFile } = await import('/src/services/file-transfer.js');
			const conn = useBotConnections().get(botId);

			const handle = downloadFile(conn.__rtc, 'main', '__does_not_exist_e2e__.txt');
			try {
				await handle.promise;
				return null;
			} catch (e) {
				return { code: e.code, message: e.message };
			}
		}, bot.botId);

		expect(err).not.toBeNull();
		expect(err.code).toBe('NOT_FOUND');
	});
});
