import { describe, test, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// mock file-transfer
vi.mock('../services/file-transfer.js', () => ({
	uploadFile: vi.fn(),
	downloadFile: vi.fn(),
}));

// mock bot-connection-manager
vi.mock('../services/bot-connection-manager.js', () => ({
	useBotConnections: vi.fn(),
}));

import { useFilesStore, __createTask } from './files.store.js';
import { uploadFile, downloadFile } from '../services/file-transfer.js';
import { useBotConnections } from '../services/bot-connection-manager.js';

function mockBotConn() {
	const botConn = { rtc: {}, waitReady: vi.fn().mockResolvedValue() };
	useBotConnections.mockReturnValue({
		get: (id) => (id === 'bot1' ? botConn : undefined),
	});
	return botConn;
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
			const botConn = mockBotConn();
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
			expect(uploadFile).toHaveBeenCalledWith(botConn, 'main', 'src/a.txt', files[0]);

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
		function mockBrowserDownload() {
			const mockA = { href: '', download: '', click: vi.fn() };
			const origCreateElement = document.createElement.bind(document);
			vi.spyOn(document, 'createElement').mockImplementation((tag) =>
				tag === 'a' ? mockA : origCreateElement(tag),
			);
			vi.spyOn(document.body, 'appendChild').mockImplementation(() => {});
			vi.spyOn(document.body, 'removeChild').mockImplementation(() => {});
			URL.createObjectURL = vi.fn(() => 'blob:mock');
			URL.revokeObjectURL = vi.fn();
			return mockA;
		}

		test('立即开始下载', async () => {
			mockBotConn();
			const blob = new Blob(['data']);
			blob.name = 'test.bin';
			downloadFile.mockReturnValue({
				promise: Promise.resolve({ blob, bytes: 4, name: 'test.bin' }),
				cancel: vi.fn(),
				set onProgress(_cb) {},
			});

			const mockA = mockBrowserDownload();
			store.enqueueDownload('bot1', 'main', 'docs', 'readme.md', 1024);

			await vi.waitFor(() => {
				const tasks = store.getAgentTasks('bot1', 'main');
				expect(tasks[0].status).toBe('done');
			});

			expect(mockA.click).toHaveBeenCalled();
			expect(mockA.download).toBe('test.bin');
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

			// mock browser download
			const origCreate = document.createElement.bind(document);
			vi.spyOn(document, 'createElement').mockImplementation((tag) =>
				tag === 'a' ? { href: '', download: '', click: vi.fn() } : origCreate(tag),
			);
			vi.spyOn(document.body, 'appendChild').mockImplementation(() => {});
			vi.spyOn(document.body, 'removeChild').mockImplementation(() => {});
			URL.createObjectURL = vi.fn(() => 'blob:mock');
			URL.revokeObjectURL = vi.fn();

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
			useBotConnections.mockReturnValue({
				get: () => undefined,
			});

			store.enqueueUploads('bot1', 'main', '', [createMockFile('no-conn.txt')]);

			await vi.waitFor(() => {
				const t = store.getAgentTasks('bot1', 'main')[0];
				expect(t.status).toBe('failed');
				expect(t.error).toContain('Bot connection');
			});
		});
	});
});
