import { mount, flushPromises } from '@vue/test-utils';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia } from 'pinia';

// --- mock 子组件 ---
vi.mock('../components/MobilePageHeader.vue', () => ({
	default: { name: 'MobilePageHeader', props: ['title'], template: '<div><slot name="actions" /></div>' },
}));
vi.mock('../components/files/FileBreadcrumb.vue', () => ({
	default: { name: 'FileBreadcrumb', props: ['path'], template: '<div />' },
}));
vi.mock('../components/files/FileListItem.vue', () => ({
	default: { name: 'FileListItem', props: ['entry', 'downloadTask'], template: '<div class="file-list-item" />' },
}));
vi.mock('../components/files/FileUploadItem.vue', () => ({
	default: { name: 'FileUploadItem', props: ['task'], template: '<div class="file-upload-item" />' },
}));

// --- mock 服务 ---
const mockNotifyError = vi.fn();
const mockNotifyWarning = vi.fn();
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => ({ error: mockNotifyError, success: vi.fn(), warning: mockNotifyWarning, info: vi.fn() }),
}));

const mockClawConnGet = vi.fn();
vi.mock('../services/claw-connection-manager.js', () => ({
	useClawConnections: () => ({
		get: mockClawConnGet,
		connect: vi.fn(),
		disconnect: vi.fn(),
		syncConnections: vi.fn(),
		disconnectAll: vi.fn(),
	}),
}));

const mockListFiles = vi.fn().mockResolvedValue({ files: [] });
const mockDeleteFile = vi.fn().mockResolvedValue();
const mockMkdirFiles = vi.fn().mockResolvedValue();
vi.mock('../services/file-transfer.js', () => ({
	listFiles: (...args) => mockListFiles(...args),
	deleteFile: (...args) => mockDeleteFile(...args),
	mkdirFiles: (...args) => mockMkdirFiles(...args),
	uploadFile: vi.fn(),
	downloadFile: vi.fn(),
	MAX_UPLOAD_SIZE: 1024 * 1024 * 1024,
}));

vi.mock('../stores/agents.store.js', () => ({
	useAgentsStore: () => ({
		getAgentDisplay: () => ({ name: 'Agent' }),
	}),
}));

vi.mock('../stores/claws.store.js', () => ({
	useClawsStore: () => ({
		byId: { claw1: { dcReady: true }, claw2: {} },
	}),
}));

import FileManagerPage from './FileManagerPage.vue';
import { useFilesStore } from '../stores/files.store.js';

const routeParams = { clawId: 'claw1', agentId: 'main' };
const mockRoute = { params: routeParams };

function mountPage(opts = {}) {
	return mount(FileManagerPage, {
		global: {
			plugins: [createPinia()],
			mocks: {
				$route: opts.route ?? mockRoute,
				$t: (key, params) => {
					if (params?.name) return `${key}:${params.name}`;
					return key;
				},
			},
			stubs: {
				// disabled 声明为 Boolean，复现真实 UButton 的 Vue prop 强转行为
				UButton: { props: { disabled: Boolean }, template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' },
				UModal: { template: '<div v-if="$attrs.open"><slot name="body" /><slot name="footer" /></div>', inheritAttrs: true },
				UCheckbox: { template: '<input type="checkbox" />' },
				URadioGroup: { props: ['modelValue', 'items'], template: '<div class="radio-group" />' },
				UIcon: { template: '<span />' },
				UInput: { template: '<input />' },
			},
		},
		...opts,
	});
}

describe('FileManagerPage', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		mockListFiles.mockResolvedValue({ files: [] });
		mockClawConnGet.mockReturnValue({ fake: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ===================================================================
	// 删除文件确认按钮 disabled 修复
	// ===================================================================
	describe('删除文件确认按钮 disabled 修复', () => {
		/** 获取删除文件对话框中的确认按钮（最后一个 button） */
		function findDeleteFileConfirmBtn(wrapper) {
			const buttons = wrapper.findAll('button');
			return buttons.filter((b) => b.text() === 'common.confirm').at(0);
		}

		test('非受保护文件 — 确认按钮应可点击', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({
				deleteFileOpen: true,
				deleteFileName: 'readme.txt',
				deleteFileChecked: false,
				currentDir: '',
			});
			await wrapper.vm.$nextTick();

			expect(wrapper.vm.deleteFileProtectedDesc).toBe('');
			const btn = findDeleteFileConfirmBtn(wrapper);
			expect(btn.exists()).toBe(true);
			expect(btn.element.disabled).toBe(false);
		});

		test('受保护文件未勾选 — 确认按钮应禁用', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({
				deleteFileOpen: true,
				deleteFileName: 'MEMORY.md',
				deleteFileChecked: false,
				currentDir: '',
			});
			await wrapper.vm.$nextTick();

			expect(wrapper.vm.deleteFileProtectedDesc).toBeTruthy();
			const btn = findDeleteFileConfirmBtn(wrapper);
			expect(btn.element.disabled).toBe(true);
		});

		test('受保护文件已勾选 — 确认按钮应可点击', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({
				deleteFileOpen: true,
				deleteFileName: 'MEMORY.md',
				deleteFileChecked: true,
				currentDir: '',
			});
			await wrapper.vm.$nextTick();

			const btn = findDeleteFileConfirmBtn(wrapper);
			expect(btn.element.disabled).toBe(false);
		});

		test('子目录中的文件 — 不视为受保护', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({
				deleteFileOpen: true,
				deleteFileName: 'MEMORY.md',
				deleteFileChecked: false,
				currentDir: 'subdir',
			});

			expect(wrapper.vm.deleteFileProtectedDesc).toBe('');
		});

		test('所有受保护文件名均被识别', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const protectedNames = ['MEMORY.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md'];
			for (const name of protectedNames) {
				await wrapper.setData({ deleteFileName: name, currentDir: '' });
				expect(wrapper.vm.deleteFileProtectedDesc).toBeTruthy();
			}
		});

		test('受保护目录 .coclaw 被识别', async () => {
			const wrapper = mountPage();
			await flushPromises();
			await wrapper.setData({ deleteDirName: '.coclaw', currentDir: '' });
			expect(wrapper.vm.deleteDirProtectedDesc).toBeTruthy();
		});
	});

	// ===================================================================
	// 上传文件大小限制
	// ===================================================================
	describe('上传文件大小限制', () => {
		test('超过 1GB 的文件被过滤并 notify', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const enqueueSpy = vi.spyOn(store, 'enqueueUploads');

			const bigFile = { name: 'huge.zip', size: 1024 * 1024 * 1024 + 1 };
			const normalFile = { name: 'small.txt', size: 100 };

			wrapper.vm.__handleUploadFiles([bigFile, normalFile]);

			expect(mockNotifyError).toHaveBeenCalledTimes(1);
			expect(mockNotifyError).toHaveBeenCalledWith('files.fileTooLarge:huge.zip');

			expect(enqueueSpy).toHaveBeenCalledTimes(1);
			expect(enqueueSpy.mock.calls[0][3]).toEqual([normalFile]);
		});

		test('所有文件均超限时不入队', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const enqueueSpy = vi.spyOn(store, 'enqueueUploads');

			wrapper.vm.__handleUploadFiles([
				{ name: 'a.zip', size: 2e9 },
				{ name: 'b.zip', size: 3e9 },
			]);

			expect(mockNotifyError).toHaveBeenCalledTimes(2);
			expect(enqueueSpy).not.toHaveBeenCalled();
		});

		test('恰好 1GB 的文件不被过滤', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const enqueueSpy = vi.spyOn(store, 'enqueueUploads');

			wrapper.vm.__handleUploadFiles([{ name: 'exact.bin', size: 1024 * 1024 * 1024 }]);

			expect(mockNotifyError).not.toHaveBeenCalled();
			expect(enqueueSpy).toHaveBeenCalledTimes(1);
		});
	});

	// ===================================================================
	// 上传完成增量刷新
	// ===================================================================
	describe('上传完成增量刷新', () => {
		test('上传任务数减少时立即调用 loadDir', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const loadDirSpy = vi.spyOn(wrapper.vm, 'loadDir');
			let callCount = 0;

			vi.spyOn(wrapper.vm, '__activeUploadCount').mockImplementation(() => {
				callCount++;
				if (callCount <= 1) return 3;
				if (callCount === 2) return 2;
				return 0;
			});

			wrapper.vm.__watchUploadsForRefresh();

			vi.advanceTimersByTime(500);
			await flushPromises();
			expect(loadDirSpy).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(500);
			await flushPromises();
			expect(loadDirSpy).toHaveBeenCalledTimes(2);

			vi.advanceTimersByTime(1000);
			await flushPromises();
			expect(loadDirSpy).toHaveBeenCalledTimes(2);
		});

		test('上传任务数未变时不刷新', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const loadDirSpy = vi.spyOn(wrapper.vm, 'loadDir');
			vi.spyOn(wrapper.vm, '__activeUploadCount').mockReturnValue(2);

			wrapper.vm.__watchUploadsForRefresh();

			vi.advanceTimersByTime(500);
			await flushPromises();
			expect(loadDirSpy).not.toHaveBeenCalled();
		});

		test('已有轮询在跑时不重复启动', async () => {
			const wrapper = mountPage();
			await flushPromises();
			vi.spyOn(wrapper.vm, '__activeUploadCount').mockReturnValue(1);

			wrapper.vm.__watchUploadsForRefresh();
			wrapper.vm.__watchUploadsForRefresh(); // 重复调用

			// 500ms 后只应 check 一次（一个定时器）
			vi.advanceTimersByTime(500);
			await flushPromises();
			// 不报错即可
		});

		test('组件卸载后停止轮询', async () => {
			const wrapper = mountPage();
			await flushPromises();
			vi.spyOn(wrapper.vm, '__activeUploadCount').mockReturnValue(2);
			wrapper.vm.__watchUploadsForRefresh();

			wrapper.unmount();

			vi.advanceTimersByTime(500);
			await flushPromises();
			// 不报错即可——__unmounted guard 阻止继续
		});
	});

	// ===================================================================
	// sortedEntries 计算属性
	// ===================================================================
	describe('sortedEntries', () => {
		test('目录排前、文件排后、同类按名称排序', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({
				entries: [
					{ name: 'zebra.txt', type: 'file' },
					{ name: 'alpha', type: 'dir' },
					{ name: 'apple.js', type: 'file' },
					{ name: 'beta', type: 'dir' },
				],
			});

			const names = wrapper.vm.sortedEntries.map((e) => e.name);
			expect(names).toEqual(['alpha', 'beta', 'apple.js', 'zebra.txt']);
		});

		test('覆盖上传期间隐藏与上传任务同名的旧条目', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			// 模拟一个正在上传的任务
			store.tasks.set('u1', {
				id: 'u1', type: 'upload', clawId: 'claw1', agentId: 'main', dir: '',
				fileName: 'report.pdf', status: 'running', progress: 0.3,
				size: 1000, error: null, file: null, transferHandle: null, createdAt: Date.now(),
			});

			await wrapper.setData({
				entries: [
					{ name: 'report.pdf', type: 'file', size: 500 },
					{ name: 'readme.md', type: 'file', size: 200 },
				],
			});

			const names = wrapper.vm.sortedEntries.map((e) => e.name);
			expect(names).toEqual(['readme.md']); // report.pdf 被过滤
		});

		test('上传完成后旧条目恢复显示', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			store.tasks.set('u1', {
				id: 'u1', type: 'upload', clawId: 'claw1', agentId: 'main', dir: '',
				fileName: 'report.pdf', status: 'done', progress: 1,
				size: 1000, error: null, file: null, transferHandle: null, createdAt: Date.now(),
			});

			await wrapper.setData({
				entries: [
					{ name: 'report.pdf', type: 'file', size: 1000 },
					{ name: 'readme.md', type: 'file', size: 200 },
				],
			});

			// done 状态不在 uploadTasks（getActiveTasks 过滤了 done），不应被隐藏
			const names = wrapper.vm.sortedEntries.map((e) => e.name);
			expect(names).toEqual(['readme.md', 'report.pdf']);
		});

		test('目录不会被同名上传任务过滤', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			store.tasks.set('u1', {
				id: 'u1', type: 'upload', clawId: 'claw1', agentId: 'main', dir: '',
				fileName: 'docs', status: 'running', progress: 0.5,
				size: 100, error: null, file: null, transferHandle: null, createdAt: Date.now(),
			});

			await wrapper.setData({
				entries: [
					{ name: 'docs', type: 'dir' },
					{ name: 'docs', type: 'file', size: 100 },
				],
			});

			// 目录应保留，同名文件被过滤
			const sorted = wrapper.vm.sortedEntries;
			expect(sorted).toHaveLength(1);
			expect(sorted[0].type).toBe('dir');
			expect(sorted[0].name).toBe('docs');
		});

		test('不同目录的上传任务不影响当前目录条目', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			store.tasks.set('u1', {
				id: 'u1', type: 'upload', clawId: 'claw1', agentId: 'main', dir: 'other-dir',
				fileName: 'report.pdf', status: 'running', progress: 0.5,
				size: 1000, error: null, file: null, transferHandle: null, createdAt: Date.now(),
			});

			await wrapper.setData({
				currentDir: '',
				entries: [
					{ name: 'report.pdf', type: 'file', size: 500 },
				],
			});

			// 上传任务在 other-dir，当前在根目录，不应过滤
			const names = wrapper.vm.sortedEntries.map((e) => e.name);
			expect(names).toEqual(['report.pdf']);
		});

		test('无上传任务时不做过滤', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({
				entries: [
					{ name: 'a.txt', type: 'file' },
					{ name: 'b.txt', type: 'file' },
				],
			});

			expect(wrapper.vm.sortedEntries).toHaveLength(2);
		});

		test('空 entries 返回空数组', async () => {
			const wrapper = mountPage();
			await flushPromises();
			expect(wrapper.vm.sortedEntries).toEqual([]);
		});
	});

	// ===================================================================
	// 重名处理对话框
	// ===================================================================
	describe('重名处理对话框', () => {
		async function setupDuplicateDialog(wrapper, existingEntries, uploadFiles) {
			await wrapper.setData({ entries: existingEntries });
			wrapper.vm.__handleUploadFiles(uploadFiles);
			await wrapper.vm.$nextTick();
		}

		test('无重名文件时直接入队不弹对话框', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const enqueueSpy = vi.spyOn(store, 'enqueueUploads');

			await setupDuplicateDialog(wrapper,
				[{ name: 'existing.txt', type: 'file' }],
				[{ name: 'new.txt', size: 100 }],
			);

			expect(wrapper.vm.duplicateOpen).toBe(false);
			expect(enqueueSpy).toHaveBeenCalledTimes(1);
		});

		test('有重名文件时弹出对话框', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await setupDuplicateDialog(wrapper,
				[{ name: 'readme.md', type: 'file' }],
				[{ name: 'readme.md', size: 200 }],
			);

			expect(wrapper.vm.duplicateOpen).toBe(true);
			expect(wrapper.vm.duplicateItems).toHaveLength(1);
			expect(wrapper.vm.duplicateItems[0].name).toBe('readme.md');
			expect(wrapper.vm.duplicateItems[0].action).toBe('skip'); // 默认 skip
		});

		test('混合场景：部分重名部分新文件', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await setupDuplicateDialog(wrapper,
				[{ name: 'old.txt', type: 'file' }],
				[
					{ name: 'old.txt', size: 100 },
					{ name: 'new.txt', size: 200 },
				],
			);

			expect(wrapper.vm.duplicateOpen).toBe(true);
			expect(wrapper.vm.duplicateItems).toHaveLength(1);
			// __pendingFiles 应包含 new.txt
			expect(wrapper.vm.__pendingFiles).toHaveLength(1);
			expect(wrapper.vm.__pendingFiles[0].name).toBe('new.txt');
		});

		test('确认覆盖时入队（覆盖 + 非重名文件）', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const enqueueSpy = vi.spyOn(store, 'enqueueUploads');

			const oldFile = { name: 'old.txt', size: 100 };
			const newFile = { name: 'new.txt', size: 200 };

			await setupDuplicateDialog(wrapper,
				[{ name: 'old.txt', type: 'file' }],
				[oldFile, newFile],
			);

			// 设置覆盖
			wrapper.vm.duplicateItems[0].action = 'overwrite';
			wrapper.vm.onConfirmDuplicates();

			expect(wrapper.vm.duplicateOpen).toBe(false);
			expect(enqueueSpy).toHaveBeenCalledTimes(1);
			// 应包含 newFile（非重名）和 oldFile（覆盖）
			expect(enqueueSpy.mock.calls[0][3]).toHaveLength(2);
		});

		test('全部跳过时不入队', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const enqueueSpy = vi.spyOn(store, 'enqueueUploads');

			await setupDuplicateDialog(wrapper,
				[{ name: 'a.txt', type: 'file' }, { name: 'b.txt', type: 'file' }],
				[{ name: 'a.txt', size: 10 }, { name: 'b.txt', size: 20 }],
			);

			// 默认都是 skip
			wrapper.vm.onConfirmDuplicates();

			expect(wrapper.vm.duplicateOpen).toBe(false);
			expect(enqueueSpy).not.toHaveBeenCalled();
		});

		test('setAllDuplicateAction 覆盖全部', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await setupDuplicateDialog(wrapper,
				[{ name: 'a.txt', type: 'file' }, { name: 'b.txt', type: 'file' }],
				[{ name: 'a.txt', size: 10 }, { name: 'b.txt', size: 20 }],
			);

			wrapper.vm.setAllDuplicateAction('overwrite');
			expect(wrapper.vm.duplicateItems.every((d) => d.action === 'overwrite')).toBe(true);
		});

		test('setAllDuplicateAction 跳过全部', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await setupDuplicateDialog(wrapper,
				[{ name: 'x.txt', type: 'file' }, { name: 'y.txt', type: 'file' }],
				[{ name: 'x.txt', size: 10 }, { name: 'y.txt', size: 20 }],
			);

			// 先设为 overwrite
			wrapper.vm.setAllDuplicateAction('overwrite');
			// 再改回 skip
			wrapper.vm.setAllDuplicateAction('skip');
			expect(wrapper.vm.duplicateItems.every((d) => d.action === 'skip')).toBe(true);
		});

		test('取消对话框不入队', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const enqueueSpy = vi.spyOn(store, 'enqueueUploads');

			await setupDuplicateDialog(wrapper,
				[{ name: 'a.txt', type: 'file' }],
				[{ name: 'a.txt', size: 10 }],
			);

			// 取消
			wrapper.vm.duplicateOpen = false;

			expect(enqueueSpy).not.toHaveBeenCalled();
		});

		test('取消后再次上传不受 stale __pendingFiles 影响', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const enqueueSpy = vi.spyOn(store, 'enqueueUploads');

			// 第一次：上传重名文件，取消
			await setupDuplicateDialog(wrapper,
				[{ name: 'a.txt', type: 'file' }],
				[{ name: 'a.txt', size: 10 }, { name: 'stale.txt', size: 50 }],
			);
			wrapper.vm.duplicateOpen = false;

			// 第二次：上传不同的重名文件
			const file2 = { name: 'a.txt', size: 99 };
			const newFile = { name: 'fresh.txt', size: 77 };
			wrapper.vm.__handleUploadFiles([file2, newFile]);

			// __pendingFiles 应是 fresh.txt，不是上次的 stale.txt
			expect(wrapper.vm.__pendingFiles).toHaveLength(1);
			expect(wrapper.vm.__pendingFiles[0].name).toBe('fresh.txt');

			// 确认覆盖
			wrapper.vm.duplicateItems[0].action = 'overwrite';
			wrapper.vm.onConfirmDuplicates();

			expect(enqueueSpy).toHaveBeenCalledTimes(1);
			const uploaded = enqueueSpy.mock.calls[0][3];
			expect(uploaded.map((f) => f.name).sort()).toEqual(['a.txt', 'fresh.txt']);
		});

		test('duplicateActionItems 包含正确的选项', async () => {
			const wrapper = mountPage();
			await flushPromises();
			expect(wrapper.vm.duplicateActionItems).toEqual([
				{ label: 'files.overwrite', value: 'overwrite' },
				{ label: 'files.skip', value: 'skip' },
			]);
		});

		test('覆盖文件正在下载时放弃整次上传并 warning', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const enqueueSpy = vi.spyOn(store, 'enqueueUploads');

			// 模拟有正在下载的 old.txt
			store.tasks.set('dl-1', {
				id: 'dl-1', type: 'download', clawId: 'claw1', agentId: 'main',
				dir: '', fileName: 'old.txt', status: 'running', progress: 0.5,
				size: 1000, error: null, file: null, transferHandle: null, createdAt: Date.now(),
			});

			await setupDuplicateDialog(wrapper,
				[{ name: 'old.txt', type: 'file' }],
				[{ name: 'old.txt', size: 200 }, { name: 'new.txt', size: 300 }],
			);

			wrapper.vm.duplicateItems[0].action = 'overwrite';
			wrapper.vm.onConfirmDuplicates();

			expect(wrapper.vm.duplicateOpen).toBe(false);
			expect(mockNotifyWarning).toHaveBeenCalledWith('files.uploadConflictDownloading');
			expect(enqueueSpy).not.toHaveBeenCalled();
		});

		test('覆盖文件有 pending 下载时同样放弃上传', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const enqueueSpy = vi.spyOn(store, 'enqueueUploads');

			store.tasks.set('dl-2', {
				id: 'dl-2', type: 'download', clawId: 'claw1', agentId: 'main',
				dir: '', fileName: 'a.txt', status: 'pending', progress: 0,
				size: 500, error: null, file: null, transferHandle: null, createdAt: Date.now(),
			});

			await setupDuplicateDialog(wrapper,
				[{ name: 'a.txt', type: 'file' }],
				[{ name: 'a.txt', size: 10 }],
			);

			wrapper.vm.duplicateItems[0].action = 'overwrite';
			wrapper.vm.onConfirmDuplicates();

			expect(mockNotifyWarning).toHaveBeenCalled();
			expect(enqueueSpy).not.toHaveBeenCalled();
		});

		test('下载已完成（done）时不阻止覆盖上传', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const enqueueSpy = vi.spyOn(store, 'enqueueUploads');

			// done 不在 getActiveTasks 结果中
			store.tasks.set('dl-3', {
				id: 'dl-3', type: 'download', clawId: 'claw1', agentId: 'main',
				dir: '', fileName: 'old.txt', status: 'done', progress: 1,
				size: 1000, error: null, file: null, transferHandle: null, createdAt: Date.now(),
			});

			await setupDuplicateDialog(wrapper,
				[{ name: 'old.txt', type: 'file' }],
				[{ name: 'old.txt', size: 200 }],
			);

			wrapper.vm.duplicateItems[0].action = 'overwrite';
			wrapper.vm.onConfirmDuplicates();

			expect(mockNotifyWarning).not.toHaveBeenCalled();
			expect(enqueueSpy).toHaveBeenCalledTimes(1);
		});

		test('下载已失败（failed）时不阻止覆盖上传', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const enqueueSpy = vi.spyOn(store, 'enqueueUploads');

			// failed 在 getActiveTasks 中但被二次过滤排除
			store.tasks.set('dl-3f', {
				id: 'dl-3f', type: 'download', clawId: 'claw1', agentId: 'main',
				dir: '', fileName: 'old.txt', status: 'failed', progress: 0.3,
				size: 1000, error: 'network', file: null, transferHandle: null, createdAt: Date.now(),
			});

			await setupDuplicateDialog(wrapper,
				[{ name: 'old.txt', type: 'file' }],
				[{ name: 'old.txt', size: 200 }],
			);

			wrapper.vm.duplicateItems[0].action = 'overwrite';
			wrapper.vm.onConfirmDuplicates();

			expect(mockNotifyWarning).not.toHaveBeenCalled();
			expect(enqueueSpy).toHaveBeenCalledTimes(1);
		});

		test('多个覆盖文件中部分与下载冲突时放弃整次上传', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const enqueueSpy = vi.spyOn(store, 'enqueueUploads');

			// 仅 a.txt 有活跃下载，b.txt 无下载
			store.tasks.set('dl-5', {
				id: 'dl-5', type: 'download', clawId: 'claw1', agentId: 'main',
				dir: '', fileName: 'a.txt', status: 'running', progress: 0.5,
				size: 500, error: null, file: null, transferHandle: null, createdAt: Date.now(),
			});

			await setupDuplicateDialog(wrapper,
				[{ name: 'a.txt', type: 'file' }, { name: 'b.txt', type: 'file' }],
				[{ name: 'a.txt', size: 10 }, { name: 'b.txt', size: 20 }],
			);

			// 两个都选覆盖
			wrapper.vm.duplicateItems[0].action = 'overwrite';
			wrapper.vm.duplicateItems[1].action = 'overwrite';
			wrapper.vm.onConfirmDuplicates();

			// 部分冲突 → some() 命中 → 放弃整次上传
			expect(mockNotifyWarning).toHaveBeenCalledWith('files.uploadConflictDownloading');
			expect(enqueueSpy).not.toHaveBeenCalled();
		});

		test('全部跳过时不检测下载冲突', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const enqueueSpy = vi.spyOn(store, 'enqueueUploads');

			store.tasks.set('dl-4', {
				id: 'dl-4', type: 'download', clawId: 'claw1', agentId: 'main',
				dir: '', fileName: 'a.txt', status: 'running', progress: 0.3,
				size: 500, error: null, file: null, transferHandle: null, createdAt: Date.now(),
			});

			await setupDuplicateDialog(wrapper,
				[{ name: 'a.txt', type: 'file' }],
				[{ name: 'a.txt', size: 10 }, { name: 'clean.txt', size: 20 }],
			);

			// 默认 skip，不覆盖
			wrapper.vm.onConfirmDuplicates();

			// 不应触发 warning（跳过了冲突文件），但 clean.txt 应正常入队
			expect(mockNotifyWarning).not.toHaveBeenCalled();
			expect(enqueueSpy).toHaveBeenCalledTimes(1);
			expect(enqueueSpy.mock.calls[0][3]).toHaveLength(1);
			expect(enqueueSpy.mock.calls[0][3][0].name).toBe('clean.txt');
		});
	});

	// ===================================================================
	// 目录导航
	// ===================================================================
	describe('目录导航', () => {
		test('navigateTo 设置 currentDir 并刷新', async () => {
			const wrapper = mountPage();
			await flushPromises();
			mockListFiles.mockClear();

			wrapper.vm.navigateTo('src/utils');

			expect(wrapper.vm.currentDir).toBe('src/utils');
			expect(mockListFiles).toHaveBeenCalled();
		});

		test('goParent 从子目录返回上级', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({ currentDir: 'a/b/c' });
			mockListFiles.mockClear();

			wrapper.vm.goParent();
			expect(wrapper.vm.currentDir).toBe('a/b');
		});

		test('goParent 从一级目录返回根目录', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({ currentDir: 'docs' });
			wrapper.vm.goParent();
			expect(wrapper.vm.currentDir).toBe('');
		});

		test('onOpenDir 从根目录进入子目录', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({ currentDir: '' });
			wrapper.vm.onOpenDir('src');
			expect(wrapper.vm.currentDir).toBe('src');
		});

		test('onOpenDir 从子目录进入深层目录', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({ currentDir: 'src' });
			wrapper.vm.onOpenDir('utils');
			expect(wrapper.vm.currentDir).toBe('src/utils');
		});

		test('导航中断进行中的 loadDir 并发起新请求', async () => {
			let resolveFirst;
			mockListFiles.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));

			const wrapper = mountPage();
			await wrapper.vm.$nextTick();
			// 初始 loadDir 在飞行中 (loading=true)
			expect(wrapper.vm.loading).toBe(true);

			// 用户导航到子目录——应中断旧请求
			const subFiles = [{ name: 'sub.txt', type: 'file' }];
			mockListFiles.mockResolvedValueOnce({ files: subFiles });
			wrapper.vm.onOpenDir('src');
			await flushPromises();

			expect(wrapper.vm.currentDir).toBe('src');
			expect(wrapper.vm.entries).toEqual(subFiles);

			// 旧请求迟到的结果不应覆盖
			resolveFirst({ files: [{ name: 'root-stale.txt', type: 'file' }] });
			await flushPromises();
			expect(wrapper.vm.entries).toEqual(subFiles);

			// 缓存应为新目录数据，不应被旧数据污染
			const store = useFilesStore();
			const cached = store.getCachedDir('claw1', 'main');
			expect(cached.currentDir).toBe('src');
			expect(cached.entries).toEqual(subFiles);
		});

		test('导航成功后再导航失败时保留前一目录的 entries', async () => {
			const fooFiles = [{ name: 'foo.txt', type: 'file' }];
			mockListFiles.mockResolvedValueOnce({ files: [] }); // initial mount
			const wrapper = mountPage();
			await flushPromises();

			// 导航到 foo 成功
			mockListFiles.mockResolvedValueOnce({ files: fooFiles });
			wrapper.vm.navigateTo('foo');
			await flushPromises();
			expect(wrapper.vm.entries).toEqual(fooFiles);

			// 导航到 bar 失败
			mockListFiles.mockRejectedValueOnce(new Error('fail'));
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			wrapper.vm.navigateTo('bar');
			await flushPromises();

			// entries 保留的是 foo 的数据（entries.length > 0，不走缓存兜底）
			expect(wrapper.vm.currentDir).toBe('bar');
			expect(wrapper.vm.entries).toEqual(fooFiles);
			warnSpy.mockRestore();
		});

		test('goParent 中断进行中的 loadDir', async () => {
			let resolveFirst;
			mockListFiles.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));

			const wrapper = mountPage();
			await wrapper.vm.$nextTick();

			mockListFiles.mockResolvedValueOnce({ files: [] });
			await wrapper.setData({ currentDir: 'a/b' });
			wrapper.vm.goParent();
			await flushPromises();

			expect(wrapper.vm.currentDir).toBe('a');

			// 旧请求不应影响结果
			resolveFirst({ files: [{ name: 'stale.txt', type: 'file' }] });
			await flushPromises();
			expect(wrapper.vm.entries).toEqual([]);
		});
	});

	// ===================================================================
	// loadDir
	// ===================================================================
	describe('loadDir', () => {
		test('成功加载目录条目', async () => {
			const files = [
				{ name: 'a.txt', type: 'file', size: 100 },
				{ name: 'docs', type: 'dir' },
			];
			mockListFiles.mockResolvedValue({ files });

			const wrapper = mountPage();
			await flushPromises();

			expect(wrapper.vm.entries).toEqual(files);
			expect(wrapper.vm.loading).toBe(false);
		});

		test('加载失败时保留已有 entries 并 notify', async () => {
			mockListFiles.mockRejectedValue(new Error('RPC failed'));
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const wrapper = mountPage();
			await flushPromises();

			// 首次加载失败且无缓存时 entries 仍为空
			expect(wrapper.vm.entries).toEqual([]);
			expect(mockNotifyError).toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		test('加载失败时保留已有 entries 不清空', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const existingEntries = [{ name: 'keep.txt', type: 'file' }];
			await wrapper.setData({ entries: existingEntries, loading: false });
			mockListFiles.mockRejectedValueOnce(new Error('net error'));
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			await wrapper.vm.loadDir();
			await flushPromises();

			// entries 应保留，不被清空
			expect(wrapper.vm.entries).toEqual(existingEntries);
			warnSpy.mockRestore();
		});

		test('加载失败且无 entries 时从缓存兜底', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const cachedEntries = [{ name: 'fallback.txt', type: 'file' }];
			store.setDirCache('claw1', 'main', '', cachedEntries);

			await wrapper.setData({ entries: [], currentDir: '', loading: false });
			mockListFiles.mockRejectedValueOnce(new Error('network'));
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			await wrapper.vm.loadDir();
			await flushPromises();

			expect(wrapper.vm.entries).toEqual(cachedEntries);
			warnSpy.mockRestore();
		});

		test('加载成功时写入 store 缓存', async () => {
			const files = [{ name: 'cached.txt', type: 'file' }];
			mockListFiles.mockResolvedValue({ files });

			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const cached = store.getCachedDir('claw1', 'main');
			expect(cached).toEqual({ currentDir: '', entries: files });
		});

		test('silent 模式不设 loading', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({ entries: [{ name: 'x.txt' }], loading: false });
			let resolveList;
			mockListFiles.mockReturnValueOnce(new Promise((r) => { resolveList = r; }));

			const promise = wrapper.vm.loadDir({ silent: true });
			await wrapper.vm.$nextTick();

			expect(wrapper.vm.loading).toBe(false); // silent 不设 loading
			resolveList({ files: [] });
			await promise;
		});

		test('silent 模式失败不弹 notify', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({ entries: [{ name: 'x.txt' }], loading: false });
			mockListFiles.mockRejectedValueOnce(new Error('silent fail'));
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			mockNotifyError.mockClear();

			await wrapper.vm.loadDir({ silent: true });
			await flushPromises();

			expect(mockNotifyError).not.toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		test('加载失败且有 entries 时不从缓存兜底（保留现有数据）', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			store.setDirCache('claw1', 'main', '', [{ name: 'stale-cache.txt', type: 'file' }]);

			const existingEntries = [{ name: 'keep-me.txt', type: 'file' }];
			await wrapper.setData({ entries: existingEntries, loading: false });
			mockListFiles.mockRejectedValueOnce(new Error('fail'));
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			await wrapper.vm.loadDir();
			await flushPromises();

			// 应保留 existing entries，不被缓存数据覆盖
			expect(wrapper.vm.entries).toEqual(existingEntries);
			warnSpy.mockRestore();
		});

		test('加载失败且无 entries 但缓存目录不匹配时不兜底', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			store.setDirCache('claw1', 'main', 'other-dir', [{ name: 'wrong.txt', type: 'file' }]);

			await wrapper.setData({ entries: [], currentDir: 'src', loading: false });
			mockListFiles.mockRejectedValueOnce(new Error('fail'));
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			await wrapper.vm.loadDir();
			await flushPromises();

			expect(wrapper.vm.entries).toEqual([]);
			warnSpy.mockRestore();
		});

		test('子目录加载成功时缓存包含正确的 currentDir', async () => {
			const subFiles = [{ name: 'util.js', type: 'file' }];
			mockListFiles.mockResolvedValueOnce({ files: [] }); // mount
			const wrapper = mountPage();
			await flushPromises();

			mockListFiles.mockResolvedValueOnce({ files: subFiles });
			wrapper.vm.navigateTo('src/utils');
			await flushPromises();

			const store = useFilesStore();
			const cached = store.getCachedDir('claw1', 'main');
			expect(cached).toEqual({ currentDir: 'src/utils', entries: subFiles });
		});

		test('过期请求的 finally 不重置 loading', async () => {
			let resolveFirst;
			mockListFiles.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));

			const wrapper = mountPage();
			await wrapper.vm.$nextTick();
			expect(wrapper.vm.loading).toBe(true);

			// 导航中断第一次请求，启动第二次
			let resolveSecond;
			mockListFiles.mockReturnValueOnce(new Promise((r) => { resolveSecond = r; }));
			wrapper.vm.onOpenDir('sub');

			// 第一次请求完成（stale）
			resolveFirst({ files: [{ name: 'stale.txt', type: 'file' }] });
			await flushPromises();

			// loading 应仍为 true（第二次请求仍在飞）
			expect(wrapper.vm.loading).toBe(true);

			resolveSecond({ files: [{ name: 'fresh.txt', type: 'file' }] });
			await flushPromises();
			expect(wrapper.vm.loading).toBe(false);
		});

		test('过期请求失败时 finally 不重置 loading 且不 notify', async () => {
			let rejectFirst;
			mockListFiles.mockReturnValueOnce(new Promise((_, rej) => { rejectFirst = rej; }));

			const wrapper = mountPage();
			await wrapper.vm.$nextTick();

			let resolveSecond;
			mockListFiles.mockReturnValueOnce(new Promise((r) => { resolveSecond = r; }));
			wrapper.vm.onOpenDir('sub');
			mockNotifyError.mockClear();

			// 第一次请求失败（stale）
			rejectFirst(new Error('stale error'));
			await flushPromises();

			// loading 应仍为 true，且不 notify
			expect(wrapper.vm.loading).toBe(true);
			expect(mockNotifyError).not.toHaveBeenCalled();

			resolveSecond({ files: [] });
			await flushPromises();
			expect(wrapper.vm.loading).toBe(false);
		});

		test('silent loadDir 进行中时非 silent loadDir 可以并发且 gen guard 保护', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({ entries: [{ name: 'x.txt' }], loading: false });

			let resolveSilent;
			mockListFiles.mockReturnValueOnce(new Promise((r) => { resolveSilent = r; }));
			const silentPromise = wrapper.vm.loadDir({ silent: true });
			await wrapper.vm.$nextTick();

			// 同时发起非 silent 调用
			const freshFiles = [{ name: 'fresh.txt', type: 'file' }];
			mockListFiles.mockResolvedValueOnce({ files: freshFiles });
			await wrapper.vm.loadDir();
			await flushPromises();

			expect(wrapper.vm.entries).toEqual(freshFiles);

			// silent 请求迟到——gen guard 应丢弃
			resolveSilent({ files: [{ name: 'stale-silent.txt', type: 'file' }] });
			await silentPromise;
			await flushPromises();

			expect(wrapper.vm.entries).toEqual(freshFiles);
		});

		test('result.files 为 undefined 时 entries 为空数组', async () => {
			mockListFiles.mockResolvedValue({});
			const wrapper = mountPage();
			await flushPromises();

			expect(wrapper.vm.entries).toEqual([]);
		});

		test('loading 时重复调用 loadDir 是幂等的', async () => {
			let resolveList;
			mockListFiles.mockReturnValue(new Promise((r) => { resolveList = r; }));

			const wrapper = mountPage();
			// loading 已在 true 状态
			await wrapper.vm.$nextTick();
			expect(wrapper.vm.loading).toBe(true);

			// 重复调用，应直接返回
			wrapper.vm.loadDir();
			// 仍只有一次调用
			expect(mockListFiles).toHaveBeenCalledTimes(1);

			resolveList({ files: [] });
			await flushPromises();
		});

		test('过期请求被丢弃（generation guard）', async () => {
			let resolveFirst;
			mockListFiles
				.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }))
				.mockResolvedValueOnce({ files: [{ name: 'fresh.txt', type: 'file' }] });

			const wrapper = mountPage();
			await wrapper.vm.$nextTick();

			// 第一次请求还在飞
			// 触发第二次加载（模拟切换目录）
			wrapper.vm.loading = false; // 手动重置，模拟 gen guard
			wrapper.vm.loadDir();
			await flushPromises();

			// 第二次完成
			expect(wrapper.vm.entries).toEqual([{ name: 'fresh.txt', type: 'file' }]);

			// 第一次迟到的结果
			resolveFirst({ files: [{ name: 'stale.txt', type: 'file' }] });
			await flushPromises();

			// 应仍为 fresh，stale 被 gen guard 丢弃
			expect(wrapper.vm.entries[0].name).toBe('fresh.txt');
		});

		test('无连接时 loadDir 静默返回', async () => {
			mockClawConnGet.mockReturnValue(undefined);

			mountPage();
			await flushPromises();

			expect(mockListFiles).not.toHaveBeenCalled();
		});

		test('根目录发送 "." 作为路径参数', async () => {
			mockClawConnGet.mockReturnValue({ fake: true });
			mountPage();
			await flushPromises();

			expect(mockListFiles).toHaveBeenCalledWith({ fake: true }, 'main', '.');
		});

		test('子目录发送目录路径', async () => {
			const wrapper = mountPage();
			await flushPromises();
			mockListFiles.mockClear();

			await wrapper.setData({ currentDir: 'src/utils' });
			wrapper.vm.loading = false;
			wrapper.vm.loadDir();
			await flushPromises();

			expect(mockListFiles).toHaveBeenCalledWith(expect.anything(), 'main', 'src/utils');
		});
	});

	// ===================================================================
	// 新建目录
	// ===================================================================
	describe('新建目录', () => {
		test('onMkdir 打开对话框并清空输入', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({ mkdirName: 'leftover' });
			wrapper.vm.onMkdir();

			expect(wrapper.vm.mkdirOpen).toBe(true);
			expect(wrapper.vm.mkdirName).toBe('');
		});

		test('确认新建成功后关闭对话框并刷新', async () => {
			const wrapper = mountPage();
			await flushPromises();
			mockListFiles.mockClear();

			await wrapper.setData({ mkdirOpen: true, mkdirName: 'newdir', currentDir: 'src' });
			await wrapper.vm.onConfirmMkdir();

			expect(mockMkdirFiles).toHaveBeenCalledWith(expect.anything(), 'main', 'src/newdir');
			expect(wrapper.vm.mkdirOpen).toBe(false);
			expect(wrapper.vm.mkdirLoading).toBe(false);
		});

		test('根目录下新建目录路径不含前缀', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({ mkdirOpen: true, mkdirName: 'root-dir', currentDir: '' });
			await wrapper.vm.onConfirmMkdir();

			expect(mockMkdirFiles).toHaveBeenCalledWith(expect.anything(), 'main', 'root-dir');
		});

		test('新建失败 notify 错误', async () => {
			mockMkdirFiles.mockRejectedValueOnce(new Error('fail'));
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({ mkdirOpen: true, mkdirName: 'bad' });
			await wrapper.vm.onConfirmMkdir();

			expect(mockNotifyError).toHaveBeenCalled();
			expect(wrapper.vm.mkdirLoading).toBe(false);
			warnSpy.mockRestore();
		});

		test('空名称、. 、.. 、含斜杠的名称被拒绝', async () => {
			const wrapper = mountPage();
			await flushPromises();

			for (const name of ['', '  ', '.', '..', 'a/b', 'c\\d']) {
				await wrapper.setData({ mkdirName: name });
				await wrapper.vm.onConfirmMkdir();
			}

			expect(mockMkdirFiles).not.toHaveBeenCalled();
		});

		test('mkdirLoading 时重复调用是幂等的', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({ mkdirOpen: true, mkdirName: 'test', mkdirLoading: true });
			await wrapper.vm.onConfirmMkdir();

			expect(mockMkdirFiles).not.toHaveBeenCalled();
		});
	});

	// ===================================================================
	// 删除文件/目录
	// ===================================================================
	describe('删除操作', () => {
		test('onDelete 文件 → 设置 deleteFileName 和路径', async () => {
			const wrapper = mountPage();
			await flushPromises();
			await wrapper.setData({ currentDir: 'src' });

			wrapper.vm.onDelete({ name: 'test.js', type: 'file' });

			expect(wrapper.vm.deleteFileOpen).toBe(true);
			expect(wrapper.vm.deleteFileName).toBe('test.js');
			expect(wrapper.vm.__deleteFilePath).toBe('src/test.js');
		});

		test('onDelete 目录 → 设置 deleteDirName 和路径', async () => {
			const wrapper = mountPage();
			await flushPromises();
			await wrapper.setData({ currentDir: '' });

			wrapper.vm.onDelete({ name: 'docs', type: 'dir' });

			expect(wrapper.vm.deleteDirOpen).toBe(true);
			expect(wrapper.vm.deleteDirName).toBe('docs');
			expect(wrapper.vm.__deleteDirPath).toBe('docs');
		});

		test('根目录下删除文件路径不含前缀', async () => {
			const wrapper = mountPage();
			await flushPromises();
			await wrapper.setData({ currentDir: '' });

			wrapper.vm.onDelete({ name: 'root.txt', type: 'file' });
			expect(wrapper.vm.__deleteFilePath).toBe('root.txt');
		});

		test('确认删除文件成功后关闭对话框并刷新', async () => {
			const wrapper = mountPage();
			await flushPromises();
			mockListFiles.mockClear();

			wrapper.vm.__deleteFilePath = 'test.txt';
			await wrapper.setData({ deleteFileOpen: true });
			await wrapper.vm.onConfirmDeleteFile();

			expect(mockDeleteFile).toHaveBeenCalledWith(expect.anything(), 'main', 'test.txt');
			expect(wrapper.vm.deleteFileOpen).toBe(false);
			expect(wrapper.vm.deleting).toBe(false);
		});

		test('确认删除目录使用 force 选项', async () => {
			const wrapper = mountPage();
			await flushPromises();

			wrapper.vm.__deleteDirPath = 'docs';
			await wrapper.setData({ deleteDirOpen: true });
			await wrapper.vm.onConfirmDeleteDir();

			expect(mockDeleteFile).toHaveBeenCalledWith(expect.anything(), 'main', 'docs', { force: true });
		});

		test('删除失败 notify 错误', async () => {
			mockDeleteFile.mockRejectedValueOnce(new Error('permission denied'));
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const wrapper = mountPage();
			await flushPromises();

			wrapper.vm.__deleteFilePath = 'locked.txt';
			await wrapper.setData({ deleteFileOpen: true });
			await wrapper.vm.onConfirmDeleteFile();

			expect(mockNotifyError).toHaveBeenCalled();
			expect(wrapper.vm.deleting).toBe(false);
			warnSpy.mockRestore();
		});

		test('无连接时删除静默返回', async () => {
			mockClawConnGet.mockReturnValue(undefined);

			const wrapper = mountPage();
			await flushPromises();

			wrapper.vm.__deleteFilePath = 'a.txt';
			await wrapper.vm.onConfirmDeleteFile();

			expect(mockDeleteFile).not.toHaveBeenCalled();
		});
	});

	// ===================================================================
	// 下载
	// ===================================================================
	describe('下载', () => {
		test('onDownload 调用 store.enqueueDownload', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const spy = vi.spyOn(store, 'enqueueDownload');

			await wrapper.setData({ currentDir: 'docs' });
			wrapper.vm.onDownload({ name: 'readme.md', size: 1024 });

			expect(spy).toHaveBeenCalledWith('claw1', 'main', 'docs', 'readme.md', 1024);
		});

		test('getDownloadTask 对目录返回 null', () => {
			const wrapper = mountPage();
			const result = wrapper.vm.getDownloadTask({ name: 'docs', type: 'dir' });
			expect(result).toBeNull();
		});

		test('getDownloadTask 匹配文件名', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			store.tasks.set('d1', {
				id: 'd1', type: 'download', clawId: 'claw1', agentId: 'main', dir: '',
				fileName: 'data.csv', status: 'running', progress: 0.5,
				size: 500, error: null, file: null, transferHandle: null, createdAt: Date.now(),
			});

			const task = wrapper.vm.getDownloadTask({ name: 'data.csv', type: 'file' });
			expect(task).toBeTruthy();
			expect(task.id).toBe('d1');
		});

		test('getDownloadTask 无匹配时返回 null', () => {
			const wrapper = mountPage();
			const result = wrapper.vm.getDownloadTask({ name: 'no-match.txt', type: 'file' });
			expect(result).toBeNull();
		});
	});

	// ===================================================================
	// 上传/下载 取消和重试代理到 store
	// ===================================================================
	describe('取消/重试代理', () => {
		test('onCancelUpload 调用 store.cancelTask', async () => {
			const wrapper = mountPage();
			await flushPromises();
			const store = useFilesStore();
			const spy = vi.spyOn(store, 'cancelTask');

			wrapper.vm.onCancelUpload('task-1');
			expect(spy).toHaveBeenCalledWith('task-1');
		});

		test('onRetryUpload 调用 store.retryTask', async () => {
			const wrapper = mountPage();
			await flushPromises();
			const store = useFilesStore();
			const spy = vi.spyOn(store, 'retryTask');

			wrapper.vm.onRetryUpload('task-2');
			expect(spy).toHaveBeenCalledWith('task-2');
		});

		test('onCancelDownload 调用 store.cancelTask', async () => {
			const wrapper = mountPage();
			await flushPromises();
			const store = useFilesStore();
			const spy = vi.spyOn(store, 'cancelTask');

			wrapper.vm.onCancelDownload('task-3');
			expect(spy).toHaveBeenCalledWith('task-3');
		});

		test('onRetryDownload 调用 store.retryTask', async () => {
			const wrapper = mountPage();
			await flushPromises();
			const store = useFilesStore();
			const spy = vi.spyOn(store, 'retryTask');

			wrapper.vm.onRetryDownload('task-4');
			expect(spy).toHaveBeenCalledWith('task-4');
		});
	});

	// ===================================================================
	// 拖拽事件
	// ===================================================================
	describe('拖拽事件', () => {
		test('dragover 设置 dragging = true', async () => {
			const wrapper = mountPage();
			await flushPromises();

			wrapper.vm.__onDragOver({ preventDefault: () => {} });
			expect(wrapper.vm.dragging).toBe(true);
		});

		test('drop 处理文件并重置 dragging', async () => {
			const wrapper = mountPage();
			await flushPromises();
			const spy = vi.spyOn(wrapper.vm, '__handleUploadFiles');

			const files = [{ name: 'dropped.txt', size: 50 }];
			wrapper.vm.__onDrop({
				preventDefault: () => {},
				dataTransfer: { files },
			});

			expect(wrapper.vm.dragging).toBe(false);
			expect(spy).toHaveBeenCalledWith(files);
		});

		test('drop 无文件时不调用 handleUploadFiles', async () => {
			const wrapper = mountPage();
			await flushPromises();
			const spy = vi.spyOn(wrapper.vm, '__handleUploadFiles');

			wrapper.vm.__onDrop({
				preventDefault: () => {},
				dataTransfer: { files: [] },
			});

			expect(spy).not.toHaveBeenCalled();
		});

		test('dragleave 离开根元素时重置 dragging', async () => {
			const wrapper = mountPage();
			await flushPromises();
			await wrapper.setData({ dragging: true });

			// relatedTarget 不在 $el 内
			wrapper.vm.__onDragLeave({ relatedTarget: document.body });
			expect(wrapper.vm.dragging).toBe(false);
		});

		test('dragleave 子元素间切换不重置 dragging', async () => {
			const wrapper = mountPage();
			await flushPromises();
			await wrapper.setData({ dragging: true });

			// relatedTarget 在 $el 内
			wrapper.vm.__onDragLeave({ relatedTarget: wrapper.vm.$el.firstChild });
			expect(wrapper.vm.dragging).toBe(true);
		});
	});

	// ===================================================================
	// resetAndLoad
	// ===================================================================
	describe('resetAndLoad', () => {
		test('重置状态并重新加载', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({ currentDir: 'deep/path', entries: [{ name: 'x' }] });
			mockListFiles.mockClear();

			wrapper.vm.resetAndLoad();
			expect(wrapper.vm.currentDir).toBe('');
			expect(wrapper.vm.entries).toEqual([]);
			expect(mockListFiles).toHaveBeenCalled();
		});

		test('有根目录缓存时从缓存恢复', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const cachedEntries = [{ name: 'cached-root.txt', type: 'file' }];
			store.setDirCache('claw1', 'main', '', cachedEntries);

			await wrapper.setData({ currentDir: 'deep/path', entries: [{ name: 'x' }] });
			mockListFiles.mockClear();

			wrapper.vm.resetAndLoad();
			expect(wrapper.vm.currentDir).toBe('');
			// 应从缓存恢复，而非空数组
			expect(wrapper.vm.entries).toEqual(cachedEntries);
		});

		test('缓存目录不是根目录时不恢复', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			store.setDirCache('claw1', 'main', 'src', [{ name: 'sub.txt', type: 'file' }]);

			await wrapper.setData({ currentDir: 'deep/path', entries: [{ name: 'x' }] });

			wrapper.vm.resetAndLoad();
			expect(wrapper.vm.entries).toEqual([]);
		});

		test('进行中的请求被 loadGen 中断', async () => {
			let resolveFirst;
			mockListFiles.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));

			const wrapper = mountPage();
			await wrapper.vm.$nextTick();
			// 第一个请求在飞行中
			expect(wrapper.vm.loading).toBe(true);

			// resetAndLoad 应强制中断并发起新请求
			mockListFiles.mockResolvedValueOnce({ files: [{ name: 'fresh.txt', type: 'file' }] });
			wrapper.vm.resetAndLoad();
			await flushPromises();

			expect(wrapper.vm.entries).toEqual([{ name: 'fresh.txt', type: 'file' }]);

			// 第一个请求迟到的结果不应覆盖
			resolveFirst({ files: [{ name: 'stale.txt', type: 'file' }] });
			await flushPromises();
			expect(wrapper.vm.entries[0].name).toBe('fresh.txt');
		});
	});

	// ===================================================================
	// connReady watcher 缓存行为
	// ===================================================================
	describe('connReady watcher 缓存行为', () => {
		/** 手动触发 connReady watcher handler */
		function triggerConnReady(wrapper, ready = true) {
			wrapper.vm.$options.watch.connReady.handler.call(wrapper.vm, ready);
		}

		test('有匹配缓存时先恢复再 loadDir', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const cachedEntries = [{ name: 'pre-cached.txt', type: 'file' }];
			store.setDirCache('claw1', 'main', '', cachedEntries);

			// 模拟断开后场景：entries 为空
			await wrapper.setData({ entries: [], currentDir: '', loading: false });

			let resolveList;
			mockListFiles.mockReturnValueOnce(new Promise((r) => { resolveList = r; }));

			triggerConnReady(wrapper);
			await wrapper.vm.$nextTick();

			// loadDir 返回前，entries 应已从缓存恢复
			expect(wrapper.vm.entries).toEqual(cachedEntries);
			expect(wrapper.vm.loading).toBe(true); // 非 silent

			resolveList({ files: [{ name: 'fresh.txt', type: 'file' }] });
			await flushPromises();
			expect(wrapper.vm.entries[0].name).toBe('fresh.txt');
		});

		test('缓存目录不匹配时不恢复', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			store.setDirCache('claw1', 'main', 'src', [{ name: 'wrong-dir.txt', type: 'file' }]);

			await wrapper.setData({ entries: [], currentDir: '', loading: false });
			mockListFiles.mockResolvedValueOnce({ files: [] });

			triggerConnReady(wrapper);
			await wrapper.vm.$nextTick();

			// 缓存目录不匹配，不应恢复
			expect(wrapper.vm.entries).toEqual([]);
		});

		test('已有 entries 时走 silent 路径', async () => {
			const wrapper = mountPage();
			await flushPromises();

			await wrapper.setData({ entries: [{ name: 'existing.txt', type: 'file' }], loading: false });
			mockListFiles.mockClear();

			triggerConnReady(wrapper);
			await wrapper.vm.$nextTick();

			// 应发起请求但不设 loading（silent 模式）
			expect(wrapper.vm.loading).toBe(false);
			expect(mockListFiles).toHaveBeenCalled();
		});

		test('ready=false 时不调用 loadDir', async () => {
			const wrapper = mountPage();
			await flushPromises();
			mockListFiles.mockClear();

			triggerConnReady(wrapper, false);

			expect(mockListFiles).not.toHaveBeenCalled();
		});

		test('断连但有缓存 entries 时仍展示列表而非连接提示', async () => {
			// 使用 claw2（dcReady 为 falsy）模拟断连
			const wrapper = mountPage({
				route: { params: { clawId: 'claw2', agentId: 'main' } },
			});
			await flushPromises();

			// 手动注入缓存 entries 模拟"断连前已有数据"
			await wrapper.setData({
				entries: [{ name: 'cached.txt', type: 'file' }],
			});

			// 应展示文件列表项，不应显示"连接中"提示
			expect(wrapper.findAll('.file-list-item')).toHaveLength(1);
			expect(wrapper.text()).not.toContain('files.connecting');
		});

		test('断连且无 entries 时显示连接提示', async () => {
			const wrapper = mountPage({
				route: { params: { clawId: 'claw2', agentId: 'main' } },
			});
			await flushPromises();

			expect(wrapper.text()).toContain('files.connecting');
		});
	});

	// ===================================================================
	// 生命周期
	// ===================================================================
	describe('生命周期', () => {
		test('beforeUnmount 清理定时器和完成任务', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const clearSpy = vi.spyOn(store, 'clearFinished');

			wrapper.unmount();
			expect(clearSpy).toHaveBeenCalledWith('claw1', 'main');
		});
	});

	// ===================================================================
	// duplicateModalUi 配置
	// ===================================================================
	test('duplicateModalUi 使用 max-w-lg', async () => {
		const wrapper = mountPage();
		await flushPromises();

		expect(wrapper.vm.duplicateModalUi.content).toContain('max-w-lg');
		// 继承了 promptModalUi 的 body/footer
		expect(wrapper.vm.duplicateModalUi.body).toBeTruthy();
		expect(wrapper.vm.duplicateModalUi.footer).toBeTruthy();
	});
});
