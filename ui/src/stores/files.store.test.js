import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// mock file-transfer
vi.mock('../services/file-transfer.js', () => ({
	uploadFile: vi.fn(),
	downloadFile: vi.fn(),
}));

// mock bot-connection-manager
vi.mock('../services/claw-connection-manager.js', () => ({
	useClawConnections: vi.fn(),
}));

// mock saveBlobToFile
const saveBlobToFileMock = vi.hoisted(() => vi.fn().mockResolvedValue());
vi.mock('../utils/file-helper.js', () => ({
	saveBlobToFile: saveBlobToFileMock,
}));

// mock remote-log（用于断言 task 失败的高级别日志）
const remoteLogMock = vi.hoisted(() => vi.fn());
vi.mock('../services/remote-log.js', () => ({
	remoteLog: remoteLogMock,
}));

import { useFilesStore, __createTask } from './files.store.js';
import { uploadFile, downloadFile } from '../services/file-transfer.js';
import { useClawConnections } from '../services/claw-connection-manager.js';

function mockBotConn() {
	const clawConn = { rtc: {}, waitReady: vi.fn().mockResolvedValue() };
	useClawConnections.mockReturnValue({
		get: (id) => (id === 'bot1' ? clawConn : undefined),
	});
	return clawConn;
}

function createMockFile(name, size = 100) {
	return { name, size };
}

describe('files.store', () => {
	let store;

	beforeEach(() => {
		setActivePinia(createPinia());
		store = useFilesStore();
		vi.clearAllMocks();
		saveBlobToFileMock.mockResolvedValue();
	});

	describe('__createTask', () => {
		test('生成合理的 task 对象', () => {
			const task = __createTask({ type: 'upload', fileName: 'test.txt' });
			expect(task.id).toBeTruthy();
			expect(task.type).toBe('upload');
			expect(task.fileName).toBe('test.txt');
			expect(task.status).toBe('pending');
			expect(task.progress).toBe(0);
			expect(task.createdAt).toBeGreaterThan(0);
		});
	});

	describe('enqueueUploads', () => {
		test('创建 pending 任务并触发上传', async () => {
			const clawConn = mockBotConn();
			let resolveUpload;
			uploadFile.mockReturnValue({
				promise: new Promise((r) => { resolveUpload = r; }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			const files = [createMockFile('a.txt', 50), createMockFile('b.txt', 80)];
			store.enqueueUploads('bot1', 'main', 'src', files);

			const tasks = store.getAgentTasks('bot1', 'main');
			expect(tasks).toHaveLength(2);
			expect(tasks[0].fileName).toBe('a.txt');
			expect(tasks[1].fileName).toBe('b.txt');

			// 串行：第一个应为 running，第二个为 pending
			// 等待 microtask 让 __runUploadQueue 执行
			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main');
				expect(t[0].status).toBe('running');
			});
			expect(tasks[1].status).toBe('pending');

			expect(uploadFile).toHaveBeenCalledTimes(1);
			expect(uploadFile).toHaveBeenCalledWith(clawConn, 'main', 'src/a.txt', files[0]);

			// 完成第一个
			resolveUpload({ bytes: 50 });
			await vi.waitFor(() => {
				expect(tasks[0].status).toBe('done');
			});

			// 第二个开始执行
			await vi.waitFor(() => {
				expect(uploadFile).toHaveBeenCalledTimes(2);
			});
		});

		test('根目录上传路径不含前缀斜杠', async () => {
			mockBotConn();
			uploadFile.mockReturnValue({
				promise: Promise.resolve({ bytes: 10 }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueUploads('bot1', 'main', '', [createMockFile('root.txt', 10)]);

			await vi.waitFor(() => {
				expect(uploadFile).toHaveBeenCalledWith(expect.anything(), 'main', 'root.txt', expect.anything());
			});
		});
	});

	describe('enqueueDownload', () => {
		test('立即开始下载', async () => {
			mockBotConn();
			const blob = new Blob(['data']);
			blob.name = 'test.bin';
			downloadFile.mockReturnValue({
				promise: Promise.resolve({ blob, bytes: 4, name: 'test.bin' }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueDownload('bot1', 'main', 'docs', 'readme.md', 1024);

			await vi.waitFor(() => {
				const tasks = store.getAgentTasks('bot1', 'main');
				expect(tasks[0].status).toBe('done');
			});

			expect(saveBlobToFileMock).toHaveBeenCalledWith(blob, 'test.bin');
		});

		test('saveBlobToFile 执行期间 task.status 仍为 running', async () => {
			mockBotConn();
			const blob = new Blob(['data']);
			downloadFile.mockReturnValue({
				promise: Promise.resolve({ blob, bytes: 4, name: 'check.bin' }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});
			saveBlobToFileMock.mockImplementation(async () => {
				// saveBlobToFile 执行期间，status 应仍为 running，尚未设为 done
				const t = store.getAgentTasks('bot1', 'main')[0];
				expect(t.status).toBe('running');
			});

			store.enqueueDownload('bot1', 'main', '', 'check.bin', 100);

			await vi.waitFor(() => {
				expect(store.getAgentTasks('bot1', 'main')[0].status).toBe('done');
			});
		});

		test('saveBlobToFile 失败时 task 标记为 failed', async () => {
			mockBotConn();
			const blob = new Blob(['data']);
			downloadFile.mockReturnValue({
				promise: Promise.resolve({ blob, bytes: 4, name: 'err.bin' }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});
			saveBlobToFileMock.mockRejectedValue(new Error('Native share failed'));

			store.enqueueDownload('bot1', 'main', '', 'err.bin', 100);

			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main')[0];
				expect(t.status).toBe('failed');
				expect(t.error).toBe('Native share failed');
			});
		});

		test('bot 连接不存在时下载直接标记为 failed', async () => {
			useClawConnections.mockReturnValue({
				get: () => undefined,
			});

			store.enqueueDownload('bot1', 'main', 'docs', 'no-conn.md', 100);

			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main')[0];
				expect(t.status).toBe('failed');
				expect(t.error).toContain('Claw connection');
			});
		});

		test('下载进度 total=0 时 progress 设为 0', async () => {
			mockBotConn();
			let capturedOnProgress;
			downloadFile.mockReturnValue({
				promise: new Promise(() => {}), // 永不 resolve
				cancel: vi.fn(),
				set onProgress(cb) { capturedOnProgress = cb; },
			});

			store.enqueueDownload('bot1', 'main', 'docs', 'progress.bin', 500);

			await vi.waitFor(() => {
				expect(store.getAgentTasks('bot1', 'main')[0].status).toBe('running');
			});

			// total=0 时 progress 应为 0
			capturedOnProgress(100, 0);
			expect(store.getAgentTasks('bot1', 'main')[0].progress).toBe(0);
			// total>0 时正常计算
			capturedOnProgress(50, 200);
			expect(store.getAgentTasks('bot1', 'main')[0].progress).toBe(0.25);
		});

		test('下载失败标记为 failed', async () => {
			mockBotConn();
			downloadFile.mockReturnValue({
				promise: Promise.reject(new Error('DC error')),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueDownload('bot1', 'main', '', 'bad.bin', 100);

			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main')[0];
				expect(t.status).toBe('failed');
				expect(t.error).toBe('DC error');
			});
		});

		test('取消运行中的下载', async () => {
			mockBotConn();
			const cancelFn = vi.fn();
			downloadFile.mockReturnValue({
				promise: new Promise(() => {}),
				cancel: cancelFn,
				set onProgress(_cb) {},
			});

			store.enqueueDownload('bot1', 'main', '', 'slow.bin', 9999);

			await vi.waitFor(() => {
				expect(store.getAgentTasks('bot1', 'main')[0].status).toBe('running');
			});

			const task = store.getAgentTasks('bot1', 'main')[0];
			store.cancelTask(task.id);
			expect(cancelFn).toHaveBeenCalled();
			expect(task.status).toBe('cancelled');
		});

		test('同一文件不重复入队', () => {
			mockBotConn();
			downloadFile.mockReturnValue({
				promise: new Promise(() => {}),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueDownload('bot1', 'main', 'docs', 'same.bin', 100);
			store.enqueueDownload('bot1', 'main', 'docs', 'same.bin', 100);

			const tasks = store.getAgentTasks('bot1', 'main')
				.filter((t) => t.type === 'download');
			expect(tasks).toHaveLength(1);
			expect(downloadFile).toHaveBeenCalledTimes(1);
		});

		test('多文件下载串行：同一 (claw, agent) 同时只有一个 running download', async () => {
			mockBotConn();
			let resolveCurrentPromise;
			downloadFile.mockImplementation(() => ({
				promise: new Promise((res) => { resolveCurrentPromise = res; }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			}));

			store.enqueueDownload('bot1', 'main', '', 'a.bin', 100);
			store.enqueueDownload('bot1', 'main', '', 'b.bin', 200);
			store.enqueueDownload('bot1', 'main', '', 'c.bin', 300);

			// 等首个 task 进入 running
			await vi.waitFor(() => {
				const running = store.getAgentTasks('bot1', 'main').filter((t) => t.status === 'running');
				expect(running).toHaveLength(1);
			});

			// 关键：只有 1 个 running，其余还是 pending
			let tasks = store.getAgentTasks('bot1', 'main');
			expect(tasks.filter((t) => t.status === 'running')).toHaveLength(1);
			expect(tasks.filter((t) => t.status === 'pending')).toHaveLength(2);
			expect(downloadFile).toHaveBeenCalledTimes(1);

			// 完成第一个 → 第二个开始
			const blob = new Blob(['x']);
			resolveCurrentPromise({ blob, bytes: 1, name: 'a.bin' });
			await vi.waitFor(() => {
				expect(store.getAgentTasks('bot1', 'main').filter((t) => t.status === 'done')).toHaveLength(1);
			});
			tasks = store.getAgentTasks('bot1', 'main');
			expect(tasks.filter((t) => t.status === 'running')).toHaveLength(1);
			expect(tasks.filter((t) => t.status === 'pending')).toHaveLength(1);
			expect(downloadFile).toHaveBeenCalledTimes(2);

			// 完成第二个 → 第三个开始
			resolveCurrentPromise({ blob, bytes: 1, name: 'b.bin' });
			await vi.waitFor(() => {
				expect(store.getAgentTasks('bot1', 'main').filter((t) => t.status === 'done')).toHaveLength(2);
			});
			expect(downloadFile).toHaveBeenCalledTimes(3);

			// 收尾，避免 unhandled rejection
			resolveCurrentPromise({ blob, bytes: 1, name: 'c.bin' });
			await vi.waitFor(() => {
				expect(store.getAgentTasks('bot1', 'main').filter((t) => t.status === 'done')).toHaveLength(3);
			});
		});

		test('不同 (claw 或 agent) 的下载相互独立串行', async () => {
			const clawConnA = { rtc: {}, waitReady: vi.fn().mockResolvedValue() };
			const clawConnB = { rtc: {}, waitReady: vi.fn().mockResolvedValue() };
			useClawConnections.mockReturnValue({
				get: (id) => (id === 'bot1' ? clawConnA : id === 'bot2' ? clawConnB : undefined),
			});
			downloadFile.mockReturnValue({
				promise: new Promise(() => {}), // 永不 resolve
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueDownload('bot1', 'main', '', 'a.bin', 100);
			store.enqueueDownload('bot2', 'main', '', 'b.bin', 100);

			await vi.waitFor(() => {
				const a = store.getAgentTasks('bot1', 'main')[0];
				const b = store.getAgentTasks('bot2', 'main')[0];
				expect(a.status).toBe('running');
				expect(b.status).toBe('running');
			});

			// 两个都同时 running（分属不同 claw，不互斥）
			expect(downloadFile).toHaveBeenCalledTimes(2);
		});
	});

	describe('cancelTask', () => {
		test('取消 running 任务调用 handle.cancel', () => {
			mockBotConn();
			const cancelFn = vi.fn();
			uploadFile.mockReturnValue({
				promise: new Promise(() => {}), // never resolves
				cancel: cancelFn,
				set onProgress(_cb) {},
			});

			store.enqueueUploads('bot1', 'main', '', [createMockFile('big.zip', 999)]);

			// 等待 task 进入 running
			return vi.waitFor(() => {
				const tasks = store.getAgentTasks('bot1', 'main');
				expect(tasks[0].status).toBe('running');
			}).then(() => {
				const task = store.getAgentTasks('bot1', 'main')[0];
				store.cancelTask(task.id);
				expect(cancelFn).toHaveBeenCalled();
				expect(task.status).toBe('cancelled');
			});
		});

		test('取消 pending 任务', () => {
			mockBotConn();
			uploadFile.mockReturnValue({
				promise: new Promise(() => {}),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueUploads('bot1', 'main', '', [
				createMockFile('1.txt'),
				createMockFile('2.txt'),
			]);

			const tasks = store.getAgentTasks('bot1', 'main');
			const pending = tasks.find((t) => t.status === 'pending');
			expect(pending).toBeDefined();
			store.cancelTask(pending.id);
			expect(pending.status).toBe('cancelled');
		});

		test('不可取消已完成的任务', async () => {
			mockBotConn();
			uploadFile.mockReturnValue({
				promise: Promise.resolve({ bytes: 10 }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueUploads('bot1', 'main', '', [createMockFile('done.txt', 10)]);

			await vi.waitFor(() => {
				expect(store.getAgentTasks('bot1', 'main')[0].status).toBe('done');
			});

			const task = store.getAgentTasks('bot1', 'main')[0];
			store.cancelTask(task.id);
			expect(task.status).toBe('done'); // 状态不变
		});
	});

	describe('retryTask', () => {
		test('重试失败的上传任务', async () => {
			mockBotConn();
			let callCount = 0;
			uploadFile.mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					return {
						promise: Promise.reject(new Error('net error')),
						cancel: vi.fn(),
						set onProgress(_cb) {},
					};
				}
				return {
					promise: Promise.resolve({ bytes: 10 }),
					cancel: vi.fn(),
					set onProgress(_cb) {},
				};
			});

			store.enqueueUploads('bot1', 'main', '', [createMockFile('retry.txt', 10)]);

			// 等待失败
			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main')[0];
				expect(t.status).toBe('failed');
			});

			const task = store.getAgentTasks('bot1', 'main')[0];
			store.retryTask(task.id);

			// 等待重试成功
			await vi.waitFor(() => {
				expect(task.status).toBe('done');
			});
			expect(uploadFile).toHaveBeenCalledTimes(2);
		});

		test('重试失败的下载任务', async () => {
			mockBotConn();
			let callCount = 0;
			downloadFile.mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					return {
						promise: Promise.reject(new Error('interrupted')),
						cancel: vi.fn(),
						set onProgress(_cb) {},
					};
				}
				const blob = new Blob(['ok']);
				blob.name = 'retry.bin';
				return {
					promise: Promise.resolve({ blob, bytes: 2, name: 'retry.bin' }),
					cancel: vi.fn(),
					set onProgress(_cb) {},
				};
			});

			store.enqueueDownload('bot1', 'main', '', 'retry.bin', 100);

			await vi.waitFor(() => {
				expect(store.getAgentTasks('bot1', 'main')[0].status).toBe('failed');
			});

			store.retryTask(store.getAgentTasks('bot1', 'main')[0].id);

			await vi.waitFor(() => {
				expect(store.getAgentTasks('bot1', 'main')[0].status).toBe('done');
			});
			expect(downloadFile).toHaveBeenCalledTimes(2);
		});
	});

	describe('progress', () => {
		test('上传进度回调更新 task.progress', async () => {
			mockBotConn();
			let progressCb = null;
			let resolveUpload;
			uploadFile.mockReturnValue({
				promise: new Promise((r) => { resolveUpload = r; }),
				cancel: vi.fn(),
				set onProgress(cb) { progressCb = cb; },
			});

			store.enqueueUploads('bot1', 'main', '', [createMockFile('prog.txt', 100)]);

			await vi.waitFor(() => {
				expect(store.getAgentTasks('bot1', 'main')[0].status).toBe('running');
			});

			expect(progressCb).toBeTypeOf('function');
			progressCb(50, 100);
			expect(store.getAgentTasks('bot1', 'main')[0].progress).toBe(0.5);

			progressCb(100, 100);
			expect(store.getAgentTasks('bot1', 'main')[0].progress).toBe(1);

			resolveUpload({ bytes: 100 });
		});
	});

	describe('getActiveTasks', () => {
		test('仅返回指定目录下的 pending/running/failed 任务', () => {
			mockBotConn();
			uploadFile.mockReturnValue({
				promise: new Promise(() => {}),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueUploads('bot1', 'main', 'src', [createMockFile('a.txt')]);
			store.enqueueUploads('bot1', 'main', 'docs', [createMockFile('b.txt')]);

			const srcTasks = store.getActiveTasks('bot1', 'main', 'src');
			const docsTasks = store.getActiveTasks('bot1', 'main', 'docs');

			expect(srcTasks).toHaveLength(1);
			expect(srcTasks[0].fileName).toBe('a.txt');
			expect(docsTasks).toHaveLength(1);
			expect(docsTasks[0].fileName).toBe('b.txt');
		});

		test('包含 failed 任务，排除 done/cancelled 任务', async () => {
			mockBotConn();
			let callCount = 0;
			uploadFile.mockImplementation(() => {
				callCount++;
				return {
					promise: callCount === 1
						? Promise.reject(new Error('fail'))
						: Promise.resolve({ bytes: 10 }),
					cancel: vi.fn(),
					set onProgress(_cb) {},
				};
			});

			store.enqueueUploads('bot1', 'main', 'src', [
				createMockFile('fail.txt', 10),
				createMockFile('ok.txt', 10),
			]);

			// 等待两个任务都结束
			await vi.waitFor(() => {
				const tasks = store.getAgentTasks('bot1', 'main');
				expect(tasks.every((t) => t.status === 'failed' || t.status === 'done')).toBe(true);
			});

			const active = store.getActiveTasks('bot1', 'main', 'src');
			// failed 应出现，done 不应出现
			expect(active).toHaveLength(1);
			expect(active[0].status).toBe('failed');
		});
	});

	describe('clearFinished', () => {
		test('清除已完成/失败/取消的任务', async () => {
			mockBotConn();
			uploadFile.mockReturnValue({
				promise: Promise.resolve({ bytes: 10 }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueUploads('bot1', 'main', '', [createMockFile('done.txt', 10)]);

			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main')[0];
				expect(t.status).toBe('done');
			});

			expect(store.tasks.size).toBe(1);
			store.clearFinished('bot1', 'main');
			expect(store.tasks.size).toBe(0);
		});
	});

	describe('RTC 连接不可用', () => {
		test('无 RTC 连接时任务标记为 failed', async () => {
			useClawConnections.mockReturnValue({
				get: () => undefined,
			});

			store.enqueueUploads('bot1', 'main', '', [createMockFile('no-conn.txt')]);

			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main')[0];
				expect(t.status).toBe('failed');
				expect(t.error).toContain('Claw connection');
			});
		});
	});

	describe('download 边界分支', () => {
		test('下载异常 code=CANCELLED 时静默返回不标记 failed', async () => {
			mockBotConn();
			const cancelErr = new Error('cancelled');
			cancelErr.code = 'CANCELLED';
			downloadFile.mockReturnValue({
				promise: Promise.reject(cancelErr),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueDownload('bot1', 'main', '', 'cancel-err.bin', 100);

			// 等任务处理完
			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main')[0];
				// CANCELLED 分支 return 后 finally 清理 transferHandle
				// status 应保持 running（因为 CANCELLED 分支不改状态）
				expect(t.status).toBe('running');
				expect(t.transferHandle).toBeNull();
			});
		});

		test('下载完成后 result.name 为空时用 task.fileName 作为文件名', async () => {
			mockBotConn();
			const blob = new Blob(['data']);
			downloadFile.mockReturnValue({
				promise: Promise.resolve({ blob, bytes: 4, name: '' }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueDownload('bot1', 'main', 'docs', 'fallback-name.md', 1024);

			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main')[0];
				expect(t.status).toBe('done');
			});

			// result.name 为空字符串，应回退到 task.fileName
			expect(saveBlobToFileMock).toHaveBeenCalledWith(blob, 'fallback-name.md');
		});

		test('下载失败无 message 时使用默认错误文本', async () => {
			mockBotConn();
			downloadFile.mockReturnValue({
				promise: Promise.reject({}),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueDownload('bot1', 'main', '', 'no-msg.bin', 100);

			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main')[0];
				expect(t.status).toBe('failed');
				expect(t.error).toBe('Download failed');
			});
		});
	});

	describe('upload 边界分支', () => {
		test('上传异常 code=CANCELLED 时静默返回不标记 failed', async () => {
			mockBotConn();
			const cancelErr = new Error('cancelled');
			cancelErr.code = 'CANCELLED';
			uploadFile.mockReturnValue({
				promise: Promise.reject(cancelErr),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueUploads('bot1', 'main', '', [createMockFile('cancel-upload.txt', 10)]);

			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main')[0];
				// CANCELLED 分支 return 后 finally 清理 transferHandle
				expect(t.transferHandle).toBeNull();
			});
			// status 应保持 running（CANCELLED 分支不改状态）
			const t = store.getAgentTasks('bot1', 'main')[0];
			expect(t.status).toBe('running');
		});

		test('上传进度 total=0 时 progress 设为 0', async () => {
			mockBotConn();
			let progressCb = null;
			uploadFile.mockReturnValue({
				promise: new Promise(() => {}), // 永不 resolve
				cancel: vi.fn(),
				set onProgress(cb) { progressCb = cb; },
			});

			store.enqueueUploads('bot1', 'main', '', [createMockFile('zero-total.txt', 10)]);

			await vi.waitFor(() => {
				expect(store.getAgentTasks('bot1', 'main')[0].status).toBe('running');
			});

			progressCb(100, 0);
			expect(store.getAgentTasks('bot1', 'main')[0].progress).toBe(0);
		});

		test('上传失败无 message 时使用默认错误文本', async () => {
			mockBotConn();
			uploadFile.mockReturnValue({
				promise: Promise.reject({}),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueUploads('bot1', 'main', '', [createMockFile('no-msg.txt', 10)]);

			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main')[0];
				expect(t.status).toBe('failed');
				expect(t.error).toBe('Upload failed');
			});
		});
	});

	describe('handle 赋值前取消的竞态', () => {
		test('上传 handle 赋值后检测到已取消 → 补偿 cancel', async () => {
			mockBotConn();
			const cancelFn = vi.fn();
			// 在 uploadFile 返回 handle 的同步时机，模拟 task 已被取消
			uploadFile.mockImplementation(() => {
				// 此时 handle 还未赋值到 task.transferHandle
				// 但我们需要在 handle 赋值后、检查前让 task.status = 'cancelled'
				// 通过 getter 拦截实现
				const tasks = store.getAgentTasks('bot1', 'main');
				const t = tasks.find((t) => t.fileName === 'race-up.txt');
				if (t) t.status = 'cancelled';
				return {
					promise: new Promise(() => {}),
					cancel: cancelFn,
					set onProgress(_cb) {},
				};
			});

			store.enqueueUploads('bot1', 'main', '', [createMockFile('race-up.txt', 10)]);

			await vi.waitFor(() => {
				// 补偿 cancel 应被调用
				expect(cancelFn).toHaveBeenCalled();
			});
		});

		test('下载 handle 赋值后检测到已取消 → 补偿 cancel', async () => {
			mockBotConn();
			const cancelFn = vi.fn();
			downloadFile.mockImplementation(() => {
				const tasks = store.getAgentTasks('bot1', 'main');
				const t = tasks.find((t) => t.fileName === 'race-dl.bin');
				if (t) t.status = 'cancelled';
				return {
					promise: new Promise(() => {}),
					cancel: cancelFn,
					set onProgress(_cb) {},
				};
			});

			store.enqueueDownload('bot1', 'main', '', 'race-dl.bin', 100);

			await vi.waitFor(() => {
				expect(cancelFn).toHaveBeenCalled();
			});
		});
	});

	describe('retryTask 边界', () => {
		test('retryTask 非 failed 任务时为 no-op', () => {
			mockBotConn();
			uploadFile.mockReturnValue({
				promise: new Promise(() => {}),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueUploads('bot1', 'main', '', [createMockFile('ok.txt', 10)]);

			const task = store.getAgentTasks('bot1', 'main')[0];
			// task 是 pending 或 running，retryTask 应为 no-op
			store.retryTask(task.id);
			// 不应额外调用 uploadFile
			expect(uploadFile).toHaveBeenCalledTimes(1);
		});

		test('retryTask 不存在的 taskId 时为 no-op', () => {
			store.retryTask('nonexistent-id');
			// 不应抛出
		});
	});

	describe('clearFinished 边界', () => {
		test('clearFinished 包含 cancelled 和 failed 任务', async () => {
			mockBotConn();
			let callCount = 0;
			uploadFile.mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					return {
						promise: Promise.reject(new Error('fail')),
						cancel: vi.fn(),
						set onProgress(_cb) {},
					};
				}
				return {
					promise: new Promise(() => {}),
					cancel: vi.fn(),
					set onProgress(_cb) {},
				};
			});

			store.enqueueUploads('bot1', 'main', '', [
				createMockFile('fail.txt', 10),
				createMockFile('pending.txt', 10),
			]);

			// 等第一个失败
			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main').find((t) => t.fileName === 'fail.txt');
				expect(t.status).toBe('failed');
			});

			// 取消第二个
			const pending = store.getAgentTasks('bot1', 'main').find((t) => t.fileName === 'pending.txt');
			store.cancelTask(pending.id);

			// clearFinished 应清除 failed + cancelled
			store.clearFinished('bot1', 'main');
			expect(store.getAgentTasks('bot1', 'main')).toHaveLength(0);
		});
	});

	// =====================================================================
	// busy getter
	// =====================================================================

	// =====================================================================
	// dirCache
	// =====================================================================

	describe('dirCache', () => {
		test('setDirCache 存储后可通过 getCachedDir 取回', () => {
			const entries = [{ name: 'a.txt', type: 'file' }];
			store.setDirCache('bot1', 'main', 'src', entries);

			const cached = store.getCachedDir('bot1', 'main');
			expect(cached).toEqual({ currentDir: 'src', entries });
		});

		test('getCachedDir 无缓存时返回 undefined', () => {
			expect(store.getCachedDir('bot1', 'main')).toBeUndefined();
		});

		test('setDirCache 覆盖同一 agent 的旧缓存', () => {
			store.setDirCache('bot1', 'main', 'src', [{ name: 'old.txt', type: 'file' }]);
			store.setDirCache('bot1', 'main', 'docs', [{ name: 'new.txt', type: 'file' }]);

			const cached = store.getCachedDir('bot1', 'main');
			expect(cached.currentDir).toBe('docs');
			expect(cached.entries[0].name).toBe('new.txt');
		});

		test('根目录 (currentDir="") 可正确存取', () => {
			const entries = [{ name: 'root.txt', type: 'file' }];
			store.setDirCache('bot1', 'main', '', entries);

			const cached = store.getCachedDir('bot1', 'main');
			expect(cached.currentDir).toBe('');
			expect(cached.entries).toEqual(entries);
			// 验证与组件中 cached?.currentDir === '' 一致的判断
			expect(cached?.currentDir === '').toBe(true);
		});

		test('空 entries 可正确存取', () => {
			store.setDirCache('bot1', 'main', 'empty-dir', []);

			const cached = store.getCachedDir('bot1', 'main');
			expect(cached.currentDir).toBe('empty-dir');
			expect(cached.entries).toEqual([]);
		});

		test('clearDirCacheByClaw 仅清除目标 claw 的缓存', () => {
			store.setDirCache('bot1', 'main', '', [{ name: '1.txt', type: 'file' }]);
			store.setDirCache('bot1', 'alt', 'src', [{ name: '2.txt', type: 'file' }]);
			store.setDirCache('bot2', 'main', '', [{ name: '3.txt', type: 'file' }]);

			store.clearDirCacheByClaw('bot1');

			expect(store.getCachedDir('bot1', 'main')).toBeUndefined();
			expect(store.getCachedDir('bot1', 'alt')).toBeUndefined();
			expect(store.getCachedDir('bot2', 'main')).toBeDefined();
		});

		test('clearDirCacheByClaw 不误删 clawId 为前缀子串的其他 claw', () => {
			store.setDirCache('bot1', 'main', '', []);
			store.setDirCache('bot10', 'main', '', []);

			store.clearDirCacheByClaw('bot1');

			expect(store.getCachedDir('bot1', 'main')).toBeUndefined();
			expect(store.getCachedDir('bot10', 'main')).toBeDefined();
		});

		test('clearDirCacheByClaw 无匹配时不报错', () => {
			expect(() => store.clearDirCacheByClaw('nonexistent')).not.toThrow();
		});
	});

	describe('busy', () => {
		test('无任��时为 false', () => {
			expect(store.busy).toBe(false);
		});

		test('有 pending 任务时为 true', () => {
			store.tasks.set('t1', __createTask({ status: 'pending' }));
			expect(store.busy).toBe(true);
		});

		test('有 running 任务时为 true', () => {
			store.tasks.set('t1', __createTask({ status: 'running' }));
			expect(store.busy).toBe(true);
		});

		test('仅有 done/failed/cancelled 任务时为 false', () => {
			store.tasks.set('t1', __createTask({ status: 'done' }));
			store.tasks.set('t2', __createTask({ status: 'failed' }));
			store.tasks.set('t3', __createTask({ status: 'cancelled' }));
			expect(store.busy).toBe(false);
		});
	});

	describe('logTaskFailure - 高级别失败日志', () => {
		let consoleErrorSpy;
		beforeEach(() => {
			consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		});

		test('上传失败时调用 remoteLog + console.error', async () => {
			mockBotConn();
			uploadFile.mockReturnValue({
				promise: Promise.reject(Object.assign(new Error('boom'), { code: 'DC_ERROR' })),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueUploads('bot1', 'main', 'docs', [createMockFile('a.txt', 100)]);
			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main')[0];
				expect(t.status).toBe('failed');
			});

			expect(remoteLogMock).toHaveBeenCalledTimes(1);
			expect(remoteLogMock.mock.calls[0][0]).toMatch(/task\.upload\.failed/);
			expect(remoteLogMock.mock.calls[0][0]).toMatch(/code=DC_ERROR/);
			expect(remoteLogMock.mock.calls[0][0]).toMatch(/err=boom/);
			expect(remoteLogMock.mock.calls[0][0]).toMatch(/path=docs\/a\.txt/);
			expect(consoleErrorSpy).toHaveBeenCalled();
		});

		test('下载传输阶段失败：code 标记为 DOWNLOAD_FAILED 或保留原 code', async () => {
			mockBotConn();
			downloadFile.mockReturnValue({
				promise: Promise.reject(Object.assign(new Error('transfer broken'), { code: 'TRANSFER_INTERRUPTED' })),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueDownload('bot1', 'main', '', 'big.bin', 100);
			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main')[0];
				expect(t.status).toBe('failed');
			});

			expect(remoteLogMock).toHaveBeenCalledTimes(1);
			expect(remoteLogMock.mock.calls[0][0]).toMatch(/task\.download\.failed/);
			expect(remoteLogMock.mock.calls[0][0]).toMatch(/code=TRANSFER_INTERRUPTED/);
		});

		test('下载保存阶段失败：code 标注为 SAVE_FAILED', async () => {
			mockBotConn();
			const blob = new Blob(['data']);
			downloadFile.mockReturnValue({
				promise: Promise.resolve({ blob, bytes: 4, name: 'doc.bin' }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});
			saveBlobToFileMock.mockRejectedValue(new Error('Native share failed'));

			store.enqueueDownload('bot1', 'main', '', 'doc.bin', 100);
			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main')[0];
				expect(t.status).toBe('failed');
			});

			expect(remoteLogMock).toHaveBeenCalledTimes(1);
			expect(remoteLogMock.mock.calls[0][0]).toMatch(/task\.download\.failed/);
			expect(remoteLogMock.mock.calls[0][0]).toMatch(/code=SAVE_FAILED/);
			expect(remoteLogMock.mock.calls[0][0]).toMatch(/err=Native share failed/);
		});

		test('claw 不可用时上传/下载分别上报 CLAW_NOT_AVAILABLE', async () => {
			useClawConnections.mockReturnValue({ get: () => undefined });

			store.enqueueUploads('bot1', 'main', '', [createMockFile('a.txt', 50)]);
			store.enqueueDownload('bot1', 'main', '', 'b.txt', 50);

			await vi.waitFor(() => {
				const tasks = store.getAgentTasks('bot1', 'main');
				expect(tasks.every((t) => t.status === 'failed')).toBe(true);
			});

			expect(remoteLogMock).toHaveBeenCalledTimes(2);
			const logs = remoteLogMock.mock.calls.map((c) => c[0]);
			expect(logs.some((l) => /task\.upload\.failed/.test(l) && /code=CLAW_NOT_AVAILABLE/.test(l))).toBe(true);
			expect(logs.some((l) => /task\.download\.failed/.test(l) && /code=CLAW_NOT_AVAILABLE/.test(l))).toBe(true);
		});

		test('CANCELLED 错误不应触发 logTaskFailure', async () => {
			mockBotConn();
			uploadFile.mockReturnValue({
				promise: Promise.reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			store.enqueueUploads('bot1', 'main', '', [createMockFile('c.txt', 50)]);
			// 等待一段时间，让 promise 完成（CANCELLED 早 return，状态保持 running 或被外部置 cancelled）
			await new Promise((r) => setTimeout(r, 50));

			expect(remoteLogMock).not.toHaveBeenCalled();
		});
	});
});
