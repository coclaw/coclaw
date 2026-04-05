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

/** 确保 test 用户至少绑定了一个在线的 claw */
async function ensureClawBound() {
	const cookies = await loginAndGetCookies();
	const res = await fetch(`${SERVER}/api/v1/claws`, { headers: { cookie: cookies } });
	const data = await res.json();
	const hasOnline = data.items?.some((b) => b.online);
	if (hasOnline) return;
	// 没有在线 claw，打印信息后让测试 graceful skip
	console.warn('No online claw found. Run: openclaw gateway call coclaw.bind --params \'{"code":"<code>","serverUrl":"http://127.0.0.1:3000"}\' to bind.');
}

/**
 * 文件传输 E2E 测试
 *
 * 前提：server、OpenClaw gateway、plugin 均运行中
 * 测试策略：通过 page.evaluate 直接调用 file-transfer service，不依赖 UI 组件
 */
test.describe('文件传输（file-transfer infrastructure） @file', () => {
	test.setTimeout(60_000);

	test.beforeAll(async () => {
		await ensureClawBound();
	});

	test.beforeEach(async ({ page }) => {
		await login(page);
		// 进入 topics 页以触发 claw 连接和 RTC 建连
		await page.goto('/topics');
		// 等待连接建立（WS + RTC 握手）
		await page.waitForTimeout(8000);
	});

	/** 获取第一个已连接的 clawId 和 RTC 状态 */
	async function getConnectedClaw(page) {
		const info = await page.evaluate(async () => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const manager = useClawConnections();
			const all = [];
			for (const [clawId, conn] of manager.__connections) {
				all.push({ clawId, state: conn.state, transportMode: conn.transportMode });
			}
			const connected = all.find((c) => c.state === 'connected');
			return { all, connected: connected ?? null };
		});
		console.log('Claw connections:', JSON.stringify(info.all));
		return info.connected;
	}

	test('listFiles — 列出 agent workspace 根目录', async ({ page }) => {
		const claw = await getConnectedClaw(page);
		if (!claw) { test.skip('无已连接的 claw'); return; }

		const result = await page.evaluate(async (clawId) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { listFiles } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			return listFiles(conn, 'main', '');
		}, claw.clawId);

		console.log('listFiles result:', JSON.stringify(result));
		expect(result).toHaveProperty('files');
		expect(Array.isArray(result.files)).toBe(true);
	});

	test('listFiles — 不存在的目录返回 NOT_FOUND', async ({ page }) => {
		const claw = await getConnectedClaw(page);
		if (!claw) { test.skip('无已连接的 claw'); return; }

		const err = await page.evaluate(async (clawId) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { listFiles } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			try {
				await listFiles(conn, 'main', '__nonexistent_dir_e2e__/');
				return null;
			} catch (e) {
				return { code: e.code, message: e.message };
			}
		}, claw.clawId);

		expect(err).not.toBeNull();
		expect(err.code).toBe('NOT_FOUND');
	});

	test('upload → download → delete 完整流程', async ({ page }) => {
		const claw = await getConnectedClaw(page);
		if (!claw) { test.skip('无已连接的 claw'); return; }
		if (claw.transportMode !== 'rtc') { test.skip('非 RTC 模式，跳过文件传输'); return; }

		const testFileName = `__e2e_test_${Date.now()}.txt`;
		const testContent = `Hello from E2E test at ${new Date().toISOString()}`;

		// 上传
		const uploadResult = await page.evaluate(async ({ clawId, fileName, content }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { uploadFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);

			const bytes = new TextEncoder().encode(content);
			const file = new File([bytes], fileName, { type: 'text/plain' });

			const handle = uploadFile(conn.__rtc, 'main', fileName, file);
			return handle.promise;
		}, { clawId: claw.clawId, fileName: testFileName, content: testContent });

		console.log('Upload result:', JSON.stringify(uploadResult));
		expect(uploadResult).toHaveProperty('bytes');

		// list 验证文件存在
		const listResult = await page.evaluate(async ({ clawId, fileName }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { listFiles } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			const res = await listFiles(conn, 'main', '');
			return res.files.find((f) => f.name === fileName);
		}, { clawId: claw.clawId, fileName: testFileName });

		expect(listResult).toBeTruthy();
		expect(listResult.type).toBe('file');

		// 下载
		const downloadResult = await page.evaluate(async ({ clawId, fileName }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { downloadFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);

			const handle = downloadFile(conn.__rtc, 'main', fileName);
			const result = await handle.promise;
			const text = await result.blob.text();
			return { text, bytes: result.bytes, name: result.name };
		}, { clawId: claw.clawId, fileName: testFileName });

		console.log('Download result:', JSON.stringify({ bytes: downloadResult.bytes, name: downloadResult.name }));
		expect(downloadResult.text).toBe(testContent);
		expect(downloadResult.name).toBe(testFileName);

		// 删除
		const deleteResult = await page.evaluate(async ({ clawId, fileName }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { deleteFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			return deleteFile(conn, 'main', fileName);
		}, { clawId: claw.clawId, fileName: testFileName });

		console.log('Delete result:', JSON.stringify(deleteResult));

		// 验证已删除
		const afterDelete = await page.evaluate(async ({ clawId, fileName }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { listFiles } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			const res = await listFiles(conn, 'main', '');
			return res.files.find((f) => f.name === fileName);
		}, { clawId: claw.clawId, fileName: testFileName });

		expect(afterDelete).toBeUndefined();
	});

	test('mkdir → create → delete 完整流程', async ({ page }) => {
		const claw = await getConnectedClaw(page);
		if (!claw) { test.skip('无已连接的 claw'); return; }

		const testDir = `__e2e_mkdir_${Date.now()}`;
		const testFile = `${testDir}/test.txt`;

		// mkdir
		const mkdirResult = await page.evaluate(async ({ clawId, dir }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { mkdirFiles } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			return mkdirFiles(conn, 'main', dir);
		}, { clawId: claw.clawId, dir: testDir });

		console.log('mkdir result:', JSON.stringify(mkdirResult));

		// list 验证目录存在
		const listResult = await page.evaluate(async ({ clawId, dir }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { listFiles } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			const res = await listFiles(conn, 'main', '');
			return res.files.find((f) => f.name === dir);
		}, { clawId: claw.clawId, dir: testDir });

		expect(listResult).toBeTruthy();
		expect(listResult.type).toBe('dir');

		// create 空文件
		const createResult = await page.evaluate(async ({ clawId, filePath }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { createFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			return createFile(conn, 'main', filePath);
		}, { clawId: claw.clawId, filePath: testFile });

		console.log('create result:', JSON.stringify(createResult));

		// list 验证空文件存在
		const fileInDir = await page.evaluate(async ({ clawId, dir }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { listFiles } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			const res = await listFiles(conn, 'main', dir);
			return res.files.find((f) => f.name === 'test.txt');
		}, { clawId: claw.clawId, dir: testDir });

		expect(fileInDir).toBeTruthy();
		expect(fileInDir.type).toBe('file');
		expect(fileInDir.size).toBe(0);

		// create 已存在的文件应报错
		const dupErr = await page.evaluate(async ({ clawId, filePath }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { createFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			try {
				await createFile(conn, 'main', filePath);
				return null;
			} catch (e) {
				return { code: e.code, message: e.message };
			}
		}, { clawId: claw.clawId, filePath: testFile });

		expect(dupErr).not.toBeNull();
		expect(dupErr.code).toBe('ALREADY_EXISTS');

		// 清理：删除文件再删除目录
		await page.evaluate(async ({ clawId, filePath, dir }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { deleteFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			await deleteFile(conn, 'main', filePath);
			await deleteFile(conn, 'main', dir);
		}, { clawId: claw.clawId, filePath: testFile, dir: testDir });
	});

	test('postFile — POST 上传到集合目录', async ({ page }) => {
		const claw = await getConnectedClaw(page);
		if (!claw) { test.skip('无已连接的 claw'); return; }
		if (claw.transportMode !== 'rtc') { test.skip('非 RTC 模式，跳过文件传输'); return; }

		const collectionDir = `.coclaw/e2e-test-${Date.now()}`;
		const originalName = 'hello.txt';
		const content = `POST test at ${new Date().toISOString()}`;

		const postResult = await page.evaluate(async ({ clawId, dir, fileName, content }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { postFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);

			const bytes = new TextEncoder().encode(content);
			const file = new File([bytes], fileName, { type: 'text/plain' });

			const handle = postFile(conn.__rtc, 'main', dir, fileName, file);
			return handle.promise;
		}, { clawId: claw.clawId, dir: collectionDir, fileName: originalName, content });

		console.log('POST result:', JSON.stringify(postResult));
		expect(postResult).toHaveProperty('bytes');
		expect(postResult).toHaveProperty('path');
		// 返回路径应在集合目录下，且包含原始文件名的 stem
		expect(postResult.path).toContain(collectionDir);
		expect(postResult.path).toContain('hello');

		// 下载验证内容
		const downloadResult = await page.evaluate(async ({ clawId, filePath }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { downloadFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);

			const handle = downloadFile(conn.__rtc, 'main', filePath);
			const result = await handle.promise;
			return await result.blob.text();
		}, { clawId: claw.clawId, filePath: postResult.path });

		expect(downloadResult).toBe(content);

		// 清理
		await page.evaluate(async ({ clawId, filePath, dir }) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { deleteFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);
			await deleteFile(conn, 'main', filePath);
			await deleteFile(conn, 'main', dir);
		}, { clawId: claw.clawId, filePath: postResult.path, dir: collectionDir });
	});

	test('upload 路径穿越被拒', async ({ page }) => {
		const claw = await getConnectedClaw(page);
		if (!claw) { test.skip('无已连接的 claw'); return; }
		if (claw.transportMode !== 'rtc') { test.skip('非 RTC 模式'); return; }

		const err = await page.evaluate(async (clawId) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { uploadFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);

			const file = new File([new Uint8Array(10)], 'evil.txt');
			const handle = uploadFile(conn.__rtc, 'main', '../../../tmp/evil.txt', file);
			try {
				await handle.promise;
				return null;
			} catch (e) {
				return { code: e.code, message: e.message };
			}
		}, claw.clawId);

		expect(err).not.toBeNull();
		expect(err.code).toBe('PATH_DENIED');
	});

	test('download 不存在的文件返回 NOT_FOUND', async ({ page }) => {
		const claw = await getConnectedClaw(page);
		if (!claw) { test.skip('无已连接的 claw'); return; }
		if (claw.transportMode !== 'rtc') { test.skip('非 RTC 模式'); return; }

		const err = await page.evaluate(async (clawId) => {
			const { useClawConnections } = await import('/src/services/claw-connection-manager.js');
			const { downloadFile } = await import('/src/services/file-transfer.js');
			const conn = useClawConnections().get(clawId);

			const handle = downloadFile(conn.__rtc, 'main', '__does_not_exist_e2e__.txt');
			try {
				await handle.promise;
				return null;
			} catch (e) {
				return { code: e.code, message: e.message };
			}
		}, claw.clawId);

		expect(err).not.toBeNull();
		expect(err.code).toBe('NOT_FOUND');
	});
});
