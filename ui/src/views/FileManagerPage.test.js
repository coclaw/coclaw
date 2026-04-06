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
	default: { name: 'FileListItem', props: ['entry', 'downloadTask'], template: '<div />' },
}));
vi.mock('../components/files/FileUploadItem.vue', () => ({
	default: { name: 'FileUploadItem', props: ['task'], template: '<div />' },
}));

// --- mock 服务 ---
const mockNotifyError = vi.fn();
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => ({ error: mockNotifyError, success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

vi.mock('../services/claw-connection-manager.js', () => ({
	useClawConnections: () => ({
		get: vi.fn(),
		connect: vi.fn(),
		disconnect: vi.fn(),
		syncConnections: vi.fn(),
		disconnectAll: vi.fn(),
	}),
}));

const mockListFiles = vi.fn().mockResolvedValue([]);
vi.mock('../services/file-transfer.js', () => ({
	listFiles: (...args) => mockListFiles(...args),
	deleteFile: vi.fn().mockResolvedValue(),
	mkdirFiles: vi.fn().mockResolvedValue(),
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
		byId: { claw1: { dcReady: true } },
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
				$route: mockRoute,
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
		mockListFiles.mockResolvedValue([]);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ===================================================================
	// Bug fix: 删除普通文件时确认按钮不可点击
	// UButton stub 声明了 disabled: Boolean，复现 Vue prop 强转（'' → true）
	// ===================================================================
	describe('删除文件确认按钮 disabled 修复', () => {
		/** 获取删除文件对话框中的确认按钮（最后一个 button） */
		function findDeleteFileConfirmBtn(wrapper) {
			const buttons = wrapper.findAll('button');
			// 删除文件对话框是最后渲染的可见 modal，确认按钮是其 footer 中最后一个 button
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
	});

	// ===================================================================
	// Bug fix: 上传超限文件应 notify 而非创建任务
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

			// 超限文件应触发 notify
			expect(mockNotifyError).toHaveBeenCalledTimes(1);
			expect(mockNotifyError).toHaveBeenCalledWith('files.fileTooLarge:huge.zip');

			// 只有正常文件入队
			expect(enqueueSpy).toHaveBeenCalledTimes(1);
			expect(enqueueSpy.mock.calls[0][3]).toEqual([normalFile]);
		});

		test('所有文件均超限时不入队', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const enqueueSpy = vi.spyOn(store, 'enqueueUploads');

			const big1 = { name: 'a.zip', size: 2e9 };
			const big2 = { name: 'b.zip', size: 3e9 };

			wrapper.vm.__handleUploadFiles([big1, big2]);

			expect(mockNotifyError).toHaveBeenCalledTimes(2);
			expect(enqueueSpy).not.toHaveBeenCalled();
		});

		test('恰好 1GB 的文件不被过滤', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const store = useFilesStore();
			const enqueueSpy = vi.spyOn(store, 'enqueueUploads');

			const exactFile = { name: 'exact.bin', size: 1024 * 1024 * 1024 };

			wrapper.vm.__handleUploadFiles([exactFile]);

			expect(mockNotifyError).not.toHaveBeenCalled();
			expect(enqueueSpy).toHaveBeenCalledTimes(1);
		});
	});

	// ===================================================================
	// Bug fix: 批量上传时每完成一个就刷新目录
	// ===================================================================
	describe('上传完成增量刷新', () => {
		test('上传任务数减少时立即调用 loadDir', async () => {
			const wrapper = mountPage();
			await flushPromises();

			const loadDirSpy = vi.spyOn(wrapper.vm, 'loadDir');
			let callCount = 0;

			// 模拟 __activeUploadCount 递减
			vi.spyOn(wrapper.vm, '__activeUploadCount').mockImplementation(() => {
				callCount++;
				// 第 1 次调用（初始）: 3，第 2 次（第一轮 check）: 2，第 3 次: 0
				if (callCount <= 1) return 3;
				if (callCount === 2) return 2;
				return 0;
			});

			wrapper.vm.__watchUploadsForRefresh();

			// 第一轮 check: 3→2，应刷新
			vi.advanceTimersByTime(500);
			await flushPromises();
			expect(loadDirSpy).toHaveBeenCalledTimes(1);

			// 第二轮 check: 2→0，应再刷新，且停止轮询
			vi.advanceTimersByTime(500);
			await flushPromises();
			expect(loadDirSpy).toHaveBeenCalledTimes(2);

			// 不再有定时器
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
			// 数量未变，不应刷新
			expect(loadDirSpy).not.toHaveBeenCalled();
		});
	});
});
