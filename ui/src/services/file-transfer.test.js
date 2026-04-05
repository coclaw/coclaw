import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
	listFiles,
	deleteFile,
	mkdirFiles,
	createFile,
	downloadFile,
	uploadFile,
	postFile,
	FileTransferError,
	CHUNK_SIZE,
	HIGH_WATER_MARK,
	MAX_UPLOAD_SIZE,
} from './file-transfer.js';

vi.mock('./remote-log.js', () => ({ remoteLog: vi.fn() }));

// --- Mock helpers ---

/** 让 waitReady 的 .then() 链执行（一个微任务 tick） */
const tick = () => new Promise((r) => queueMicrotask(r));

/** 模拟 BotConnection（仅 RPC） */
function createMockBotConn() {
	return {
		request: vi.fn().mockResolvedValue({}),
		waitReady: vi.fn().mockResolvedValue(),
		rtc: null,
	};
}

/**
 * 模拟 BotConnection + WebRtcConnection + DataChannel（用于二进制传输）
 * 返回 { botConn, lastDC() } — lastDC() 获取最近创建的 DC
 * botConn.rtc 为模拟 WebRtcConnection，botConn.waitReady 立即 resolve
 */
function createMockBotConnWithRtc() {
	const channels = [];

	const rtcConn = {
		createDataChannel(label, opts) {
			const listeners = {};
			const dc = {
				label,
				ordered: opts?.ordered,
				readyState: 'connecting',
				bufferedAmount: 0,
				bufferedAmountLowThreshold: 0,
				onopen: null,
				onmessage: null,
				onclose: null,
				onerror: null,
				sent: [],
				send(data) { dc.sent.push(data); },
				close() { dc.readyState = 'closed'; },
				addEventListener(event, cb) { (listeners[event] ??= []).push(cb); },
				removeEventListener(event, cb) {
					if (listeners[event]) listeners[event] = listeners[event].filter((c) => c !== cb);
				},
				// 测试工具方法
				__fireEvent(event) {
					for (const cb of listeners[event] ?? []) cb();
				},
				__listeners: listeners,
				// 模拟 DC open
				__open() {
					dc.readyState = 'open';
					dc.onopen?.();
				},
				// 模拟收到消息
				__receiveString(json) {
					dc.onmessage?.({ data: JSON.stringify(json) });
				},
				__receiveBinary(buf) {
					dc.onmessage?.({ data: buf });
				},
				__fireClose() {
					dc.readyState = 'closed';
					dc.onclose?.();
					// 也触发 addEventListener 注册的 close 回调
					dc.__fireEvent('close');
				},
				__fireError() {
					dc.onerror?.();
				},
			};
			channels.push(dc);
			return dc;
		},
	};

	const botConn = {
		request: vi.fn().mockResolvedValue({}),
		waitReady: vi.fn().mockResolvedValue(),
		rtc: rtcConn,
	};

	return { botConn, rtcConn, channels, lastDC: () => channels[channels.length - 1] };
}

/**
 * 从 Uint8Array 创建可 stream 的 mock File
 * jsdom 的 Blob 可能不支持 .stream()，需手动实现
 */
function createStreamableFile(bytes, name = 'test.txt') {
	const size = bytes.byteLength;
	return {
		name,
		size,
		stream() {
			let offset = 0;
			return new ReadableStream({
				pull(controller) {
					if (offset >= size) {
						controller.close();
						return;
					}
					const end = Math.min(offset + CHUNK_SIZE, size);
					controller.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset + offset, end - offset));
					offset = end;
				},
			});
		},
	};
}

/** 创建一个简单的 mock File（字符串内容） */
function createMockFile(content, name = 'test.txt') {
	const bytes = new Uint8Array(content.length);
	for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i);
	return createStreamableFile(bytes, name);
}

/** 创建指定大小的 mock File */
function createMockFileOfSize(size, name = 'big.bin') {
	return createStreamableFile(new Uint8Array(size), name);
}

/**
 * 创建 stream 返回超大 chunk 的 mock File（用于测试 sendChunks 的内部切分逻辑）
 * 每次 pull 返回 chunkSize 字节（可大于 CHUNK_SIZE）
 */
function createLargeChunkFile(totalSize, chunkSize, name = 'large-chunk.bin') {
	const bytes = new Uint8Array(totalSize);
	return {
		name,
		size: totalSize,
		stream() {
			let offset = 0;
			return new ReadableStream({
				pull(controller) {
					if (offset >= totalSize) {
						controller.close();
						return;
					}
					const end = Math.min(offset + chunkSize, totalSize);
					controller.enqueue(new Uint8Array(bytes.buffer, offset, end - offset));
					offset = end;
				},
			});
		},
	};
}

// --- RPC 操作测试 ---

describe('listFiles', () => {
	test('调用 botConn.request 并传递正确参数', async () => {
		const botConn = createMockBotConn();
		const mockResult = {
			files: [
				{ name: 'main.js', type: 'file', size: 2048, mtime: 1711234567000 },
				{ name: 'utils', type: 'dir', size: 0, mtime: 1711234000000 },
			],
		};
		botConn.request.mockResolvedValue(mockResult);

		const result = await listFiles(botConn, 'main', 'src/');

		expect(botConn.request).toHaveBeenCalledWith('coclaw.files.list', {
			agentId: 'main',
			path: 'src/',
		}, { timeout: 60_000 });
		expect(result).toEqual(mockResult);
	});

	test('RPC 失败时 reject', async () => {
		const botConn = createMockBotConn();
		const err = new Error('not found');
		err.code = 'NOT_FOUND';
		botConn.request.mockRejectedValue(err);

		await expect(listFiles(botConn, 'main', 'nope/')).rejects.toThrow('not found');
	});
});

describe('deleteFile', () => {
	test('调用 botConn.request 并传递正确参数', async () => {
		const botConn = createMockBotConn();
		botConn.request.mockResolvedValue({});

		await deleteFile(botConn, 'main', 'tmp/old.log');

		expect(botConn.request).toHaveBeenCalledWith('coclaw.files.delete', {
			agentId: 'main',
			path: 'tmp/old.log',
		}, { timeout: 60_000 });
	});

	test('传递 force 参数用于递归删除目录', async () => {
		const botConn = createMockBotConn();
		botConn.request.mockResolvedValue({});

		await deleteFile(botConn, 'main', 'old-docs', { force: true });

		expect(botConn.request).toHaveBeenCalledWith('coclaw.files.delete', {
			agentId: 'main',
			path: 'old-docs',
			force: true,
		}, { timeout: 60_000 });
	});

	test('不传 force 时不含 force 字段', async () => {
		const botConn = createMockBotConn();
		botConn.request.mockResolvedValue({});

		await deleteFile(botConn, 'main', 'file.txt');

		const params = botConn.request.mock.calls[0][1];
		expect(params).not.toHaveProperty('force');
	});
});

describe('mkdirFiles', () => {
	test('调用 botConn.request 并传递正确参数', async () => {
		const botConn = createMockBotConn();
		botConn.request.mockResolvedValue({});

		await mkdirFiles(botConn, 'main', 'data/exports');

		expect(botConn.request).toHaveBeenCalledWith('coclaw.files.mkdir', {
			agentId: 'main',
			path: 'data/exports',
		});
	});

	test('RPC 失败时 reject', async () => {
		const botConn = createMockBotConn();
		botConn.request.mockRejectedValue(new Error('path denied'));

		await expect(mkdirFiles(botConn, 'main', '../bad')).rejects.toThrow('path denied');
	});
});

describe('createFile', () => {
	test('调用 botConn.request 并传递正确参数', async () => {
		const botConn = createMockBotConn();
		botConn.request.mockResolvedValue({});

		await createFile(botConn, 'main', 'notes.txt');

		expect(botConn.request).toHaveBeenCalledWith('coclaw.files.create', {
			agentId: 'main',
			path: 'notes.txt',
		});
	});

	test('文件已存在时 reject', async () => {
		const botConn = createMockBotConn();
		const err = new Error('already exists');
		err.code = 'ALREADY_EXISTS';
		botConn.request.mockRejectedValue(err);

		await expect(createFile(botConn, 'main', 'notes.txt')).rejects.toThrow('already exists');
	});
});

// --- 下载测试 ---

describe('downloadFile', () => {
	test('完整下载流程', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'src/app.js');

		await tick();
		const dc = lastDC();
		expect(dc.label).toMatch(/^file:/);
		expect(dc.ordered).toBe(true);

		// DC open → 发送请求
		dc.__open();
		expect(dc.sent.length).toBe(1);
		const req = JSON.parse(dc.sent[0]);
		expect(req).toEqual({ method: 'GET', agentId: 'main', path: 'src/app.js' });

		// Plugin 响应头
		dc.__receiveString({ ok: true, size: 5, name: 'app.js' });

		// Plugin 发送 binary chunks
		const chunk = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
		dc.__receiveBinary(chunk);

		// Plugin 完成确认
		dc.__receiveString({ ok: true, bytes: 5 });

		const result = await handle.promise;
		expect(result.bytes).toBe(5);
		expect(result.name).toBe('app.js');
		expect(result.blob).toBeInstanceOf(Blob);
		expect(result.blob.size).toBe(5);
	});

	test('下载多个 chunk', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const progressCalls = [];
		const handle = downloadFile(botConn, 'main', 'data.bin');
		handle.onProgress = (recv, total) => progressCalls.push({ recv, total });

		await tick();
		const dc = lastDC();
		dc.__open();

		// 响应头
		dc.__receiveString({ ok: true, size: 10, name: 'data.bin' });

		// 两个 chunk
		dc.__receiveBinary(new Uint8Array(6));
		dc.__receiveBinary(new Uint8Array(4));

		// 完成
		dc.__receiveString({ ok: true, bytes: 10 });

		const result = await handle.promise;
		expect(result.bytes).toBe(10);
		expect(progressCalls).toEqual([
			{ recv: 6, total: 10 },
			{ recv: 10, total: 10 },
		]);
	});

	test('Plugin 返回错误（校验阶段）', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', '../etc/passwd');

		await tick();
		const dc = lastDC();
		dc.__open();

		dc.__receiveString({
			ok: false,
			error: { code: 'PATH_DENIED', message: 'Path traversal denied' },
		});

		await expect(handle.promise).rejects.toThrow('Path traversal denied');
		try { await handle.promise; } catch (e) {
			expect(e).toBeInstanceOf(FileTransferError);
			expect(e.code).toBe('PATH_DENIED');
		}
	});

	test('Plugin 返回错误（传输中途）', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'broken.bin');

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true, size: 100, name: 'broken.bin' });
		dc.__receiveBinary(new Uint8Array(50));
		dc.__receiveString({
			ok: false,
			error: { code: 'READ_FAILED', message: 'Disk error' },
		});

		await expect(handle.promise).rejects.toThrow('Disk error');
	});

	test('DC 意外关闭导致中断', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'file.txt');

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true, size: 100, name: 'file.txt' });
		dc.__receiveBinary(new Uint8Array(30));
		dc.__fireClose();

		await expect(handle.promise).rejects.toThrow('Download interrupted');
	});

	test('取消下载', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'big.bin');

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true, size: 1000, name: 'big.bin' });
		dc.__receiveBinary(new Uint8Array(100));

		handle.cancel();

		await expect(handle.promise).rejects.toThrow('Download cancelled');
		expect(dc.readyState).toBe('closed');
	});

	test('RTC 不可用（createDataChannel 返回 null）时失败', () => {
		const botConn = {
			waitReady: vi.fn().mockResolvedValue(),
			rtc: { createDataChannel: () => null },
		};
		const handle = downloadFile(botConn, 'main', 'file.txt');

		return expect(handle.promise).rejects.toThrow('WebRTC connection not available');
	});

	test('waitReady 超时时 reject', () => {
		const err = new Error('connect timeout');
		err.code = 'CONNECT_TIMEOUT';
		const botConn = {
			waitReady: vi.fn().mockRejectedValue(err),
			rtc: null,
		};
		const handle = downloadFile(botConn, 'main', 'file.txt');

		return expect(handle.promise).rejects.toMatchObject({ code: 'CONNECT_TIMEOUT' });
	});

	test('waitReady 完成前取消下载', async () => {
		let resolveReady;
		const botConn = {
			waitReady: vi.fn().mockImplementation(() => new Promise((r) => { resolveReady = r; })),
			rtc: null,
		};
		const handle = downloadFile(botConn, 'main', 'file.txt');

		// waitReady 尚未 resolve，cancel
		handle.cancel();

		// 触发 waitReady resolve
		resolveReady();
		await tick();

		// 应拒绝（cancelled 检查在 .then 回调开头）
		await expect(handle.promise).rejects.toThrow('Download cancelled');
	});

	test('DC error 事件', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'file.txt');

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__fireError();

		await expect(handle.promise).rejects.toThrow('DataChannel error');
	});

	test('DC open 时 send 抛出异常', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'file.txt');

		await tick();
		const dc = lastDC();
		dc.send = () => { throw new Error('send failed'); };
		dc.__open();

		await expect(handle.promise).rejects.toThrow('Failed to send download request');
	});

	test('空文件下载（size=0）— 正常完成', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'empty.txt');

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true, size: 0, name: 'empty.txt' });
		dc.__receiveString({ ok: true, bytes: 0 });

		const result = await handle.promise;
		expect(result.bytes).toBe(0);
		expect(result.name).toBe('empty.txt');
		expect(result.blob.size).toBe(0);
	});

	test('空文件下载 — close/message 竞态兜底', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'empty.txt');

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true, size: 0, name: 'empty.txt' });
		// 完成确认丢失，直接 close
		dc.__fireClose();

		const result = await handle.promise;
		expect(result.bytes).toBe(0);
		expect(result.name).toBe('empty.txt');
	});

	test('所有字节已收齐时 close 兜底 resolve', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'data.bin');

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true, size: 5, name: 'data.bin' });
		dc.__receiveBinary(new Uint8Array(5));
		// 完成确认丢失，直接 close
		dc.__fireClose();

		const result = await handle.promise;
		expect(result.bytes).toBe(5);
	});
});

// --- 上传测试 ---

describe('uploadFile', () => {
	test('完整上传流程', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('hello world', 'test.txt');
		const handle = uploadFile(botConn, 'main', 'docs/test.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();

		// 检查请求
		const req = JSON.parse(dc.sent[0]);
		expect(req).toEqual({
			method: 'PUT',
			agentId: 'main',
			path: 'docs/test.txt',
			size: file.size,
		});

		// Plugin 就绪
		dc.__receiveString({ ok: true });

		// 等待 chunk 发送完成（微任务）
		await vi.waitFor(() => {
			// 至少有 binary chunk + done 信号
			expect(dc.sent.length).toBeGreaterThanOrEqual(3);
		});

		// 最后一条应为 done 信号
		const doneMsg = JSON.parse(dc.sent[dc.sent.length - 1]);
		expect(doneMsg).toEqual({ done: true, bytes: file.size });

		// Plugin 写入结果
		dc.__receiveString({ ok: true, bytes: file.size });

		const result = await handle.promise;
		expect(result.bytes).toBe(file.size);
	});

	test('上传进度回调', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('abcdefghij', 'data.txt'); // 10 bytes
		const progressCalls = [];
		const handle = uploadFile(botConn, 'main', 'data.txt', file);
		handle.onProgress = (sent, total) => progressCalls.push({ sent, total });

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true });

		await vi.waitFor(() => {
			expect(dc.sent.length).toBeGreaterThanOrEqual(3);
		});

		dc.__receiveString({ ok: true, bytes: 10 });

		await handle.promise;
		expect(progressCalls.length).toBeGreaterThan(0);
		const last = progressCalls[progressCalls.length - 1];
		expect(last.sent).toBe(10);
		expect(last.total).toBe(10);
	});

	test('文件超过 1GB 限制', () => {
		const { botConn } = createMockBotConnWithRtc();
		// 模拟超大文件：只设 size，不实际分配内存
		const bigFile = { size: MAX_UPLOAD_SIZE + 1, stream: () => {} };
		const handle = uploadFile(botConn, 'main', 'huge.bin', bigFile);

		return expect(handle.promise).rejects.toThrow('exceeds limit');
	});

	test('Plugin 写入错误', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('data', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		await vi.waitFor(() => {
			expect(dc.sent.length).toBeGreaterThanOrEqual(3);
		});

		// Plugin 返回写入失败
		dc.__receiveString({
			ok: false,
			error: { code: 'DISK_FULL', message: 'No space left' },
		});

		await expect(handle.promise).rejects.toThrow('No space left');
	});

	test('Plugin 校验阶段错误（ready 前）', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('data', 'file.txt');
		const handle = uploadFile(botConn, 'main', '../../../etc/passwd', file);

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({
			ok: false,
			error: { code: 'PATH_DENIED', message: 'Path traversal' },
		});

		await expect(handle.promise).rejects.toThrow('Path traversal');
	});

	test('取消上传', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('some data', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();

		handle.cancel();

		await expect(handle.promise).rejects.toThrow('Upload cancelled');
		expect(dc.readyState).toBe('closed');
	});

	test('waitReady 完成前取消上传', async () => {
		let resolveReady;
		const botConn = {
			waitReady: vi.fn().mockImplementation(() => new Promise((r) => { resolveReady = r; })),
			rtc: null,
		};
		const file = createMockFile('data', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		handle.cancel();
		resolveReady();
		await tick();

		await expect(handle.promise).rejects.toThrow('Upload cancelled');
	});

	test('RTC 不可用（createDataChannel 返回 null）时失败', () => {
		const botConn = {
			waitReady: vi.fn().mockResolvedValue(),
			rtc: { createDataChannel: () => null },
		};
		const file = createMockFile('data', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		return expect(handle.promise).rejects.toThrow('WebRTC connection not available');
	});

	test('waitReady 超时时 reject', () => {
		const err = new Error('connect timeout');
		err.code = 'CONNECT_TIMEOUT';
		const botConn = {
			waitReady: vi.fn().mockRejectedValue(err),
			rtc: null,
		};
		const file = createMockFile('data', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		return expect(handle.promise).rejects.toMatchObject({ code: 'CONNECT_TIMEOUT' });
	});

	test('上传中 DC 意外关闭', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('data', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();
		// 不发 ready，直接关闭
		dc.__fireClose();

		await expect(handle.promise).rejects.toThrow('Upload interrupted');
	});

	test('DC error 事件', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('data', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__fireError();

		await expect(handle.promise).rejects.toThrow('DataChannel error');
	});

	test('DC open 时 send 抛出异常', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('data', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		await tick();
		const dc = lastDC();
		dc.send = () => { throw new Error('send failed'); };
		dc.__open();

		await expect(handle.promise).rejects.toThrow('Failed to send upload request');
	});

	test('sendChunks 异常传播到上传 promise', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		// 创建一个 stream 会抛异常的 file
		const file = {
			name: 'err.txt',
			size: 100,
			stream() {
				return new ReadableStream({
					pull() {
						throw new Error('read error');
					},
				});
			},
		};
		const handle = uploadFile(botConn, 'main', 'err.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		await expect(handle.promise).rejects.toThrow('read error');
	});

	test('上传完成后 close/message 竞态兜底', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('data', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		await vi.waitFor(() => {
			expect(dc.sent.length).toBeGreaterThanOrEqual(3);
		});

		// 模拟竞态：Plugin 发写入结果同时关闭 DC，close 先到达
		dc.__fireClose();
		// 写入结果紧随其后（在 setTimeout(0) 之前）
		dc.__receiveString({ ok: true, bytes: file.size });

		const result = await handle.promise;
		expect(result.bytes).toBe(file.size);
	});

	test('超限检测后 cancel 为 no-op', () => {
		const { botConn } = createMockBotConnWithRtc();
		const bigFile = { size: MAX_UPLOAD_SIZE + 1, stream: () => {} };
		const handle = uploadFile(botConn, 'main', 'huge.bin', bigFile);

		// cancel 应该不报错
		handle.cancel();

		return expect(handle.promise).rejects.toThrow('exceeds limit');
	});

	test('Plugin 未在限时内回复 ready 则超时', async () => {
		vi.useFakeTimers();
		try {
			const { botConn, lastDC } = createMockBotConnWithRtc();
			const file = createMockFile('data', 'file.txt');
			const handle = uploadFile(botConn, 'main', 'file.txt', file);

			// 提前捕获 promise，避免 unhandled rejection
			const resultPromise = handle.promise.catch((e) => e);

			await vi.advanceTimersByTimeAsync(0); // tick: waitReady resolve
			const dc = lastDC();
			dc.__open();
			// 不发 { ok: true } ready 信号

			// 推进 15s 触发 UPLOAD_READY_TIMEOUT
			await vi.advanceTimersByTimeAsync(15_000);

			const err = await resultPromise;
			expect(err).toBeInstanceOf(FileTransferError);
			expect(err.code).toBe('READY_TIMEOUT');
			expect(err.message).toMatch('Plugin did not respond in time');
		} finally {
			vi.useRealTimers();
		}
	});

	test('发送 done 信号时 send 抛出异常', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('hi', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		await tick();
		const dc = lastDC();

		// 拦截 send：让 chunk 发送正常，但 done 信号时抛出
		let sendCount = 0;
		const origSend = dc.send.bind(dc);
		dc.send = (data) => {
			sendCount++;
			// 第 1 次是请求 JSON，第 2 次是 binary chunk，第 3 次是 done 信号
			if (sendCount >= 3 && typeof data === 'string' && data.includes('"done"')) {
				throw new Error('send failed on done');
			}
			origSend(data);
		};

		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		await expect(handle.promise).rejects.toThrow('Failed to send done signal');
	});
});

// --- 上传 backpressure 流控测试 ---

describe('uploadFile — backpressure', () => {
	test('bufferedAmount 超过 HIGH_WATER_MARK 时暂停发送', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFileOfSize(CHUNK_SIZE * 3, 'bp.bin');
		const handle = uploadFile(botConn, 'main', 'bp.bin', file);

		await tick();
		const dc = lastDC();
		// 拦截 send：第一个 binary chunk 后设 bufferedAmount 超阈值
		let binarySendCount = 0;
		const origSend = dc.send.bind(dc);
		dc.send = (data) => {
			origSend(data);
			if (typeof data !== 'string') {
				binarySendCount++;
				if (binarySendCount === 1) {
					dc.bufferedAmount = HIGH_WATER_MARK + 1;
				}
			}
		};

		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		// 等待第一个 binary chunk 发出且被暂停
		await vi.waitFor(() => {
			expect(binarySendCount).toBeGreaterThanOrEqual(1);
		});

		const pausedBinaryCount = binarySendCount;
		await new Promise((r) => setTimeout(r, 50));
		// 应仍然只发了 1 个 binary chunk（被 backpressure 暂停）
		expect(binarySendCount).toBe(pausedBinaryCount);

		// 模拟缓冲区排空
		dc.bufferedAmount = 0;
		dc.__fireEvent('bufferedamountlow');

		// 等待全部发完：请求(1) + 3 chunks + done(1) = 5
		await vi.waitFor(() => {
			expect(dc.sent.length).toBeGreaterThanOrEqual(5);
		});

		dc.__receiveString({ ok: true, bytes: file.size });
		const result = await handle.promise;
		expect(result.bytes).toBe(file.size);
	});

	test('waitForBufferDrain 时 DC 已非 open 状态则立即 reject', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFileOfSize(CHUNK_SIZE * 3, 'bp.bin');
		const handle = uploadFile(botConn, 'main', 'bp.bin', file);

		await tick();
		const dc = lastDC();
		let binarySendCount = 0;
		const origSend = dc.send.bind(dc);
		dc.send = (data) => {
			origSend(data);
			if (typeof data !== 'string') {
				binarySendCount++;
				if (binarySendCount === 1) {
					// 触发 backpressure，同时将 DC 设为非 open 状态
					dc.bufferedAmount = HIGH_WATER_MARK + 1;
					dc.readyState = 'closing';
				}
			}
		};

		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		// waitForBufferDrain 发现 dc.readyState !== 'open'，应 reject
		await expect(handle.promise).rejects.toThrow('DataChannel closed during flow control');
	});

	test('waitForBufferDrain 期间 DC close 事件触发 reject', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFileOfSize(CHUNK_SIZE * 3, 'bp.bin');
		const handle = uploadFile(botConn, 'main', 'bp.bin', file);

		await tick();
		const dc = lastDC();
		let binarySendCount = 0;
		const origSend = dc.send.bind(dc);
		dc.send = (data) => {
			origSend(data);
			if (typeof data !== 'string') {
				binarySendCount++;
				if (binarySendCount === 1) {
					dc.bufferedAmount = HIGH_WATER_MARK + 1;
				}
			}
		};

		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		// 等待 backpressure 暂停
		await vi.waitFor(() => {
			expect(binarySendCount).toBeGreaterThanOrEqual(1);
		});

		// 在等待 buffer drain 期间触发 close 事件
		dc.__fireEvent('close');

		await expect(handle.promise).rejects.toThrow('DataChannel closed during flow control');
	});

	test('waitForBufferDrain 的 onLow 触发后 onClose 为 no-op', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFileOfSize(CHUNK_SIZE * 3, 'bp.bin');
		const handle = uploadFile(botConn, 'main', 'bp.bin', file);

		await tick();
		const dc = lastDC();
		let binarySendCount = 0;
		const origSend = dc.send.bind(dc);
		dc.send = (data) => {
			origSend(data);
			if (typeof data !== 'string') {
				binarySendCount++;
				if (binarySendCount === 1) {
					dc.bufferedAmount = HIGH_WATER_MARK + 1;
				}
			}
		};

		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		// 等待 backpressure 暂停
		await vi.waitFor(() => {
			expect(binarySendCount).toBeGreaterThanOrEqual(1);
		});

		// 先触发 bufferedamountlow（resolve），再触发 close（应被 done 守卫忽略）
		dc.bufferedAmount = 0;
		dc.__fireEvent('bufferedamountlow');
		dc.__fireEvent('close');

		// 等待全部发完
		await vi.waitFor(() => {
			const lastSent = dc.sent[dc.sent.length - 1];
			expect(typeof lastSent === 'string' && lastSent.includes('"done"')).toBe(true);
		});

		dc.__receiveString({ ok: true, bytes: file.size });
		const result = await handle.promise;
		expect(result.bytes).toBe(file.size);
	});

	test('waitForBufferDrain 期间取消后 DC close 事件 resolve', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFileOfSize(CHUNK_SIZE * 3, 'bp.bin');
		const handle = uploadFile(botConn, 'main', 'bp.bin', file);

		await tick();
		const dc = lastDC();
		let binarySendCount = 0;
		const origSend = dc.send.bind(dc);
		dc.send = (data) => {
			origSend(data);
			if (typeof data !== 'string') {
				binarySendCount++;
				if (binarySendCount === 1) {
					dc.bufferedAmount = HIGH_WATER_MARK + 1;
				}
			}
		};

		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		// 等待 backpressure 暂停
		await vi.waitFor(() => {
			expect(binarySendCount).toBeGreaterThanOrEqual(1);
		});

		// 先取消，再触发 close — isCancelled() 为 true，waitForBufferDrain 的 onClose 应 resolve
		handle.cancel();

		await expect(handle.promise).rejects.toThrow('Upload cancelled');
	});
});

// --- sendChunks 大块切分测试 ---

describe('uploadFile — large chunk splitting', () => {
	test('reader 返回超过 CHUNK_SIZE 的 chunk 时正确切分', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		// stream 每次返回 CHUNK_SIZE * 2.5 大小的块，总大小 CHUNK_SIZE * 5
		const totalSize = CHUNK_SIZE * 5;
		const file = createLargeChunkFile(totalSize, Math.floor(CHUNK_SIZE * 2.5), 'split.bin');
		const handle = uploadFile(botConn, 'main', 'split.bin', file);

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		// 等待 chunk 发送完成
		await vi.waitFor(() => {
			const lastSent = dc.sent[dc.sent.length - 1];
			if (typeof lastSent === 'string') {
				expect(JSON.parse(lastSent)).toHaveProperty('done', true);
			}
		});

		// 验证所有 binary chunk 均不超过 CHUNK_SIZE
		let totalSentBytes = 0;
		for (const data of dc.sent) {
			if (typeof data !== 'string') {
				expect(data.byteLength).toBeLessThanOrEqual(CHUNK_SIZE);
				totalSentBytes += data.byteLength;
			}
		}
		expect(totalSentBytes).toBe(totalSize);

		dc.__receiveString({ ok: true, bytes: totalSize });
		const result = await handle.promise;
		expect(result.bytes).toBe(totalSize);
	});
});

// --- POST 上传测试 ---

describe('postFile', () => {
	test('完整 POST 上传流程（含 fileName 和返回 path）', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('photo data', 'photo.jpg');
		const handle = postFile(botConn, 'main', '.coclaw/chat-files/main', 'photo.jpg', file);

		await tick();
		const dc = lastDC();
		dc.__open();

		// 检查请求——应包含 method: POST、fileName
		const req = JSON.parse(dc.sent[0]);
		expect(req).toEqual({
			method: 'POST',
			agentId: 'main',
			path: '.coclaw/chat-files/main',
			fileName: 'photo.jpg',
			size: file.size,
		});

		// Plugin 就绪
		dc.__receiveString({ ok: true });

		await vi.waitFor(() => {
			expect(dc.sent.length).toBeGreaterThanOrEqual(3);
		});

		// Plugin 写入结果（含实际路径）
		dc.__receiveString({
			ok: true,
			bytes: file.size,
			path: '.coclaw/chat-files/main/photo-a3f1.jpg',
		});

		const result = await handle.promise;
		expect(result.bytes).toBe(file.size);
		expect(result.path).toBe('.coclaw/chat-files/main/photo-a3f1.jpg');
	});

	test('文件超过 1GB 限制', () => {
		const { botConn } = createMockBotConnWithRtc();
		const bigFile = { size: MAX_UPLOAD_SIZE + 1, stream: () => {} };
		const handle = postFile(botConn, 'main', '.coclaw/files', 'huge.bin', bigFile);

		return expect(handle.promise).rejects.toThrow('exceeds limit');
	});

	test('Plugin 校验阶段错误', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('data', 'file.txt');
		const handle = postFile(botConn, 'main', '../bad', 'file.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({
			ok: false,
			error: { code: 'PATH_DENIED', message: 'Path traversal' },
		});

		await expect(handle.promise).rejects.toThrow('Path traversal');
	});

	test('取消 POST 上传', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('data', 'file.txt');
		const handle = postFile(botConn, 'main', '.coclaw/files', 'file.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();
		handle.cancel();

		await expect(handle.promise).rejects.toThrow('Upload cancelled');
		expect(dc.readyState).toBe('closed');
	});

	test('PUT 上传结果不含 path 字段', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('hello', 'test.txt');
		const handle = uploadFile(botConn, 'main', 'docs/test.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true });

		await vi.waitFor(() => {
			expect(dc.sent.length).toBeGreaterThanOrEqual(3);
		});

		dc.__receiveString({ ok: true, bytes: file.size });

		const result = await handle.promise;
		expect(result.bytes).toBe(file.size);
		expect(result.path).toBeUndefined();
	});
});

// --- 下载分支覆盖补充 ---

describe('downloadFile — 分支覆盖补充', () => {
	test('onmessage 收到无法解析的 JSON 字符串时静默忽略', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'file.txt');

		await tick();
		const dc = lastDC();
		dc.__open();

		// 发送无法解析的 JSON
		dc.onmessage?.({ data: '{broken json' });

		// 正常继续下载
		dc.__receiveString({ ok: true, size: 3, name: 'file.txt' });
		dc.__receiveBinary(new Uint8Array([1, 2, 3]));
		dc.__receiveString({ ok: true, bytes: 3 });

		const result = await handle.promise;
		expect(result.bytes).toBe(3);
	});

	test('onmessage 在 cancelled 后被忽略', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'file.txt');

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true, size: 100, name: 'file.txt' });

		// 取消后再发消息
		handle.cancel();
		// 不应抛出
		dc.onmessage?.({ data: new Uint8Array(10) });

		await expect(handle.promise).rejects.toThrow('Download cancelled');
	});

	test('onclose 在 settled 后被忽略', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'file.txt');

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true, size: 3, name: 'file.txt' });
		dc.__receiveBinary(new Uint8Array(3));
		dc.__receiveString({ ok: true, bytes: 3 });

		// 已 settled，再触发 close 不应影响
		dc.__fireClose();
		await new Promise((r) => setTimeout(r, 10));

		const result = await handle.promise;
		expect(result.bytes).toBe(3);
	});

	test('Plugin 错误缺少 error.code 和 message 时使用默认值', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'file.txt');

		await tick();
		const dc = lastDC();
		dc.__open();
		// ok: false 但无 error 字段
		dc.__receiveString({ ok: false });

		try {
			await handle.promise;
		} catch (e) {
			expect(e.code).toBe('TRANSFER_FAILED');
			expect(e.message).toBe('Download failed');
		}
	});

	test('响应头缺少 size 和 name 时使用默认值', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'file.txt');

		await tick();
		const dc = lastDC();
		dc.__open();
		// 响应头缺少 size / name
		dc.__receiveString({ ok: true });
		dc.__receiveString({ ok: true, bytes: 0 });

		const result = await handle.promise;
		expect(result.bytes).toBe(0);
		expect(result.name).toBe('');
	});

	test('totalSize 为 0 时 progressCb 不被调用', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const progressCalls = [];
		const handle = downloadFile(botConn, 'main', 'file.txt');
		handle.onProgress = (recv, total) => progressCalls.push({ recv, total });

		await tick();
		const dc = lastDC();
		dc.__open();
		// 响应头 size=0，但仍发了 binary
		dc.__receiveString({ ok: true, size: 0, name: 'file.txt' });
		dc.__receiveBinary(new Uint8Array(5));
		dc.__receiveString({ ok: true, bytes: 5 });

		await handle.promise;
		// totalSize === 0 时 progressCb 不调用
		expect(progressCalls.length).toBe(0);
	});
});

// --- 上传分支覆盖补充 ---

describe('uploadFile — 分支覆盖补充', () => {
	test('Plugin ready 超时', async () => {
		vi.useFakeTimers();
		try {
			const { botConn, lastDC } = createMockBotConnWithRtc();
			const file = createMockFile('data', 'file.txt');
			const handle = uploadFile(botConn, 'main', 'file.txt', file);

			await vi.advanceTimersByTimeAsync(0); // tick
			const dc = lastDC();
			dc.__open();
			// 不发 ready，让超时触发
			const p = handle.promise.catch((e) => e);
			await vi.advanceTimersByTimeAsync(15_001);

			const err = await p;
			expect(err).toBeInstanceOf(FileTransferError);
			expect(err.code).toBe('READY_TIMEOUT');
			expect(err.message).toBe('Plugin did not respond in time');
		} finally {
			vi.useRealTimers();
		}
	});

	test('onmessage 收到非字符串数据时忽略', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('data', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();

		// 发送 binary 消息（非 string），应被忽略
		dc.onmessage?.({ data: new Uint8Array(5) });

		// 正常继续
		dc.__receiveString({ ok: true }); // ready
		await vi.waitFor(() => {
			expect(dc.sent.length).toBeGreaterThanOrEqual(3);
		});
		dc.__receiveString({ ok: true, bytes: file.size });

		const result = await handle.promise;
		expect(result.bytes).toBe(file.size);
	});

	test('onmessage 收到无法解析的 JSON 时忽略', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('data', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();

		// 发送无法解析的 JSON
		dc.onmessage?.({ data: 'not valid json' });

		// 正常继续
		dc.__receiveString({ ok: true }); // ready
		await vi.waitFor(() => {
			expect(dc.sent.length).toBeGreaterThanOrEqual(3);
		});
		dc.__receiveString({ ok: true, bytes: file.size });

		const result = await handle.promise;
		expect(result.bytes).toBe(file.size);
	});

	test('Plugin 错误缺少 error.code 和 message 时使用默认值', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('data', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: false });

		try {
			await handle.promise;
		} catch (e) {
			expect(e.code).toBe('TRANSFER_FAILED');
			expect(e.message).toBe('Upload failed');
		}
	});

	test('发送 done 信号时 send 抛出异常', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('hi', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		await tick();
		const dc = lastDC();
		let sendCallCount = 0;
		const origSend = dc.send.bind(dc);
		dc.send = (data) => {
			sendCallCount++;
			// 第一个 send 是请求 JSON，第二个是 binary chunk，第三个是 done 信号
			if (typeof data === 'string' && sendCallCount > 1) {
				throw new Error('send failed');
			}
			origSend(data);
		};

		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		await expect(handle.promise).rejects.toThrow('Failed to send done signal');
	});

	test('onmessage 在 cancelled 后被忽略', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('data', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();

		handle.cancel();
		// cancelled 后再发消息不应影响
		dc.onmessage?.({ data: JSON.stringify({ ok: true }) });

		await expect(handle.promise).rejects.toThrow('Upload cancelled');
	});

	test('sendChunks 中 isCancelled 触发提前退出', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		// 使用较大文件确保 sendChunks 有多次循环
		const file = createMockFileOfSize(CHUNK_SIZE * 5, 'cancel-mid.bin');
		const handle = uploadFile(botConn, 'main', 'cancel-mid.bin', file);

		await tick();
		const dc = lastDC();
		let binarySendCount = 0;
		const origSend = dc.send.bind(dc);
		dc.send = (data) => {
			origSend(data);
			if (typeof data !== 'string') {
				binarySendCount++;
				// 第一个 chunk 发完后取消
				if (binarySendCount === 1) {
					handle.cancel();
				}
			}
		};

		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		await expect(handle.promise).rejects.toThrow('Upload cancelled');
	});

	test('sendChunks catch 中 cancelled/settled 检查 — 不 double settle', async () => {
		// 当 sendChunks 抛异常但外层已 settled 时，catch 分支的 cancelled||settled 检查生效
		const { botConn, lastDC } = createMockBotConnWithRtc();
		let rejectReader;
		const file = {
			name: 'err.txt',
			size: 100,
			stream() {
				return new ReadableStream({
					pull(controller) {
						// 先 enqueue 一些数据，然后通过外部触发错误
						return new Promise((_, rej) => { rejectReader = rej; });
					},
				});
			},
		};
		const handle = uploadFile(botConn, 'main', 'err.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		// 等 reader.read() 正在等待
		await new Promise((r) => setTimeout(r, 20));

		// 先 cancel（settle 为 CANCELLED），再让 reader 报错
		handle.cancel();
		rejectReader(new Error('read error'));

		await expect(handle.promise).rejects.toThrow('Upload cancelled');
	});

	test('上传写入结果不含 path 时 result 无 path 字段', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('data', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true }); // ready
		await vi.waitFor(() => {
			expect(dc.sent.length).toBeGreaterThanOrEqual(3);
		});
		// 写入结果不含 bytes 也不含 path
		dc.__receiveString({ ok: true });

		const result = await handle.promise;
		expect(result.bytes).toBe(file.size);
		expect(result).not.toHaveProperty('path');
	});
});

// --- sendChunks buf 切分逻辑补充 ---

describe('uploadFile — buf offset=0 whole buf return', () => {
	test('reader 返回恰好 2*CHUNK_SIZE 的 chunk，buf 整段返回后清空', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const totalSize = CHUNK_SIZE * 2;
		const file = createLargeChunkFile(totalSize, totalSize, 'whole-buf.bin');
		const handle = uploadFile(botConn, 'main', 'whole-buf.bin', file);

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		await vi.waitFor(() => {
			const lastSent = dc.sent[dc.sent.length - 1];
			if (typeof lastSent === 'string') {
				expect(JSON.parse(lastSent)).toHaveProperty('done', true);
			}
		});

		let totalSentBytes = 0;
		for (const data of dc.sent) {
			if (typeof data !== 'string') {
				expect(data.byteLength).toBeLessThanOrEqual(CHUNK_SIZE);
				totalSentBytes += data.byteLength;
			}
		}
		expect(totalSentBytes).toBe(totalSize);

		dc.__receiveString({ ok: true, bytes: totalSize });
		const result = await handle.promise;
		expect(result.bytes).toBe(totalSize);
	});

	test('reader 返回恰好 CHUNK_SIZE+1 的 chunk — buf 第二轮 remaining<=CHUNK_SIZE 做 slice', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const totalSize = CHUNK_SIZE + 1;
		const file = createLargeChunkFile(totalSize, totalSize, 'plus1.bin');
		const handle = uploadFile(botConn, 'main', 'plus1.bin', file);

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		await vi.waitFor(() => {
			const lastSent = dc.sent[dc.sent.length - 1];
			if (typeof lastSent === 'string') {
				expect(JSON.parse(lastSent)).toHaveProperty('done', true);
			}
		});

		// 应有 2 个 binary chunk: CHUNK_SIZE + 1
		const binaryChunks = dc.sent.filter((d) => typeof d !== 'string');
		expect(binaryChunks.length).toBe(2);
		expect(binaryChunks[0].byteLength).toBe(CHUNK_SIZE);
		expect(binaryChunks[1].byteLength).toBe(1);

		dc.__receiveString({ ok: true, bytes: totalSize });
		const result = await handle.promise;
		expect(result.bytes).toBe(totalSize);
	});
});

// --- waitForBufferDrain 分支补充 ---

describe('waitForBufferDrain — 分支覆盖补充', () => {
	test('bufferedamountlow 和 close 同时触发时只处理一次', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFileOfSize(CHUNK_SIZE * 3, 'bp.bin');
		const handle = uploadFile(botConn, 'main', 'bp.bin', file);

		await tick();
		const dc = lastDC();
		let binarySendCount = 0;
		const origSend = dc.send.bind(dc);
		dc.send = (data) => {
			origSend(data);
			if (typeof data !== 'string') {
				binarySendCount++;
				if (binarySendCount === 1) {
					dc.bufferedAmount = HIGH_WATER_MARK + 1;
				}
			}
		};

		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		await vi.waitFor(() => {
			expect(binarySendCount).toBeGreaterThanOrEqual(1);
		});

		// 同时触发 bufferedamountlow 和 close（先 low 再 close）
		dc.bufferedAmount = 0;
		dc.__fireEvent('bufferedamountlow');
		// 第二次触发 close — done 已为 true，应被忽略
		dc.__fireEvent('close');

		await vi.waitFor(() => {
			expect(dc.sent.length).toBeGreaterThanOrEqual(5);
		});

		dc.__receiveString({ ok: true, bytes: file.size });
		const result = await handle.promise;
		expect(result.bytes).toBe(file.size);
	});
});

// --- cleanup 分支补充 ---

describe('createFileDC cleanup 分支', () => {
	test('cleanup 重复调用不报错', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'file.txt');

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true, size: 3, name: 'file.txt' });
		dc.__receiveBinary(new Uint8Array(3));
		dc.__receiveString({ ok: true, bytes: 3 });

		const result = await handle.promise;
		expect(result.bytes).toBe(3);

		// 再次取消（cleanup 已执行过），不应抛出
		handle.cancel();
	});

	test('cleanup 当 DC 已 closed 时不再次 close', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'file.txt');

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({
			ok: false,
			error: { code: 'ERR', message: 'error' },
		});

		await expect(handle.promise).rejects.toThrow('error');
		// DC 已被 cleanupRef() 关闭，再次 cancel 应安全
		handle.cancel();
	});
});

// --- settle 幂等、cleanup 异常、readyTimer 竞态 ---

describe('边界分支补充', () => {
	test('cleanup 中 dc.close 抛异常时被静默吞掉', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const handle = downloadFile(botConn, 'main', 'file.txt');

		await tick();
		const dc = lastDC();
		// 让 dc.close 抛异常
		dc.close = () => { throw new Error('close boom'); };
		dc.__open();
		dc.__receiveString({
			ok: false,
			error: { code: 'ERR', message: 'err' },
		});

		// cleanup 调用 dc.close() 会抛异常，但被 catch{} 吞掉，不影响 reject
		await expect(handle.promise).rejects.toThrow('err');
	});

	test('upload settle 幂等 — double settle 时第二次被忽略', async () => {
		const { botConn, lastDC } = createMockBotConnWithRtc();
		const file = createMockFile('data', 'file.txt');
		const handle = uploadFile(botConn, 'main', 'file.txt', file);

		await tick();
		const dc = lastDC();
		dc.__open();
		dc.__receiveString({ ok: true }); // ready

		await vi.waitFor(() => {
			expect(dc.sent.length).toBeGreaterThanOrEqual(3);
		});

		// Plugin 写入结果（settle resolve）
		dc.__receiveString({ ok: true, bytes: file.size });
		const result = await handle.promise;
		expect(result.bytes).toBe(file.size);

		// 再次收到消息（settle 已为 true），应被忽略
		dc.onmessage?.({ data: JSON.stringify({ ok: false, error: { code: 'X', message: 'X' } }) });
	});

	test('readyTimer 到期时 readyReceived 已为 true — 超时回调跳过', async () => {
		vi.useFakeTimers();
		try {
			const { botConn, lastDC } = createMockBotConnWithRtc();
			const file = createMockFile('hi', 'file.txt');
			const handle = uploadFile(botConn, 'main', 'file.txt', file);

			await vi.advanceTimersByTimeAsync(0); // tick
			const dc = lastDC();
			dc.__open();

			// Plugin 立即回复 ready
			dc.__receiveString({ ok: true });

			// 推进 sendChunks 完成
			await vi.advanceTimersByTimeAsync(100);

			// 发送 done 后等 Plugin 确认
			dc.__receiveString({ ok: true, bytes: file.size });

			// 超时定时器到期，但 readyReceived 已为 true，回调直接 return
			await vi.advanceTimersByTimeAsync(15_000);

			const result = await handle.promise;
			expect(result.bytes).toBe(file.size);
		} finally {
			vi.useRealTimers();
		}
	});
});

// --- FileTransferError ---

describe('FileTransferError', () => {
	test('包含 code 和 message', () => {
		const err = new FileTransferError('NOT_FOUND', 'File not found');
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('FileTransferError');
		expect(err.code).toBe('NOT_FOUND');
		expect(err.message).toBe('File not found');
	});
});

// --- WebRtcConnection.createDataChannel 测试（补充） ---

vi.mock('./signaling-connection.js', () => ({
	useSignalingConnection: () => ({
		sendSignaling: vi.fn().mockReturnValue(true),
		ensureConnected: vi.fn().mockResolvedValue(undefined),
		on() {},
		off() {},
	}),
}));

describe('WebRtcConnection.createDataChannel', () => {
	// 直接 import 并使用已有的 mock PC
	let WebRtcConnection;
	let MockPC;

	beforeEach(async () => {
		const mod = await import('./webrtc-connection.js');
		WebRtcConnection = mod.WebRtcConnection;

		// 简化的 Mock PC
		MockPC = class {
			constructor() {
				this.onicecandidate = null;
				this.onconnectionstatechange = null;
				this.connectionState = 'new';
				this.localDescription = null;
				this.__channels = [];
			}
			createDataChannel(label, opts) {
				const dc = {
					label,
					ordered: opts?.ordered,
					readyState: 'connecting',
					bufferedAmount: 0,
					bufferedAmountLowThreshold: 0,
					onopen: null,
					onclose: null,
					onmessage: null,
					send() {},
					addEventListener() {},
					removeEventListener() {},
				};
				this.__channels.push(dc);
				return dc;
			}
			async createOffer() { return { type: 'offer', sdp: 'sdp' }; }
			async setLocalDescription() {}
			async setRemoteDescription() {}
			async addIceCandidate() {}
			async getStats() { return new Map(); }
			close() { this.connectionState = 'closed'; }
		};
	});

	test('PC 可用时创建 DataChannel', async () => {
		const botConn = {
			sendRaw: vi.fn().mockReturnValue(true),
			on() {}, off() {},
		};
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockPC });
		await rtc.connect(null);

		const dc = rtc.createDataChannel('file:abc-123', { ordered: true });
		expect(dc).not.toBeNull();
		expect(dc.label).toBe('file:abc-123');
		expect(dc.ordered).toBe(true);

		rtc.close();
	});

	test('PC 不可用时返回 null', () => {
		const botConn = {
			sendRaw: vi.fn().mockReturnValue(true),
			on() {}, off() {},
		};
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockPC });
		// 未 connect，__pc 为 null
		const dc = rtc.createDataChannel('file:test', { ordered: true });
		expect(dc).toBeNull();
	});

	test('closed 状态时返回 null', async () => {
		const botConn = {
			sendRaw: vi.fn().mockReturnValue(true),
			on() {}, off() {},
		};
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockPC });
		await rtc.connect(null);
		rtc.close();

		const dc = rtc.createDataChannel('file:test', { ordered: true });
		expect(dc).toBeNull();
	});
});
