import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// ── mock 依赖 ──

const mockFetchCoclawFile = vi.fn();
vi.mock('../services/coclaw-file.js', () => ({
	isCoclawUrl: (url) => typeof url === 'string' && url.startsWith('coclaw-file://'),
	fetchCoclawFile: (...args) => mockFetchCoclawFile(...args),
	parseCoclawUrl: (url) => {
		if (!url || !url.startsWith('coclaw-file://')) return null;
		const rest = url.slice('coclaw-file://'.length);
		const slashIdx = rest.indexOf('/');
		if (slashIdx < 0) return null;
		const authority = rest.slice(0, slashIdx);
		const colonIdx = authority.indexOf(':');
		if (colonIdx < 0) return null;
		return { clawId: authority.slice(0, colonIdx), agentId: authority.slice(colonIdx + 1), path: rest.slice(slashIdx + 1) };
	},
}));

const mockSaveBlobToFile = vi.fn().mockResolvedValue(undefined);
vi.mock('../utils/file-helper.js', () => ({
	formatFileSize: (n) => `${n} B`,
	saveBlobToFile: (...args) => mockSaveBlobToFile(...args),
}));

const mockNotifyError = vi.fn();
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => ({ success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: mockNotifyError }),
}));

vi.mock('../utils/platform.js', () => ({ isCapacitorApp: false }));

import ChatFile from './ChatFile.vue';

// ── helper ──

function makeBlob(content = 'file-data', type = 'application/octet-stream') {
	return new Blob([content], { type });
}

const UButtonStub = {
	props: ['icon', 'variant', 'color', 'size', 'loading', 'title'],
	emits: ['click'],
	template: '<button @click="$emit(\'click\')"><slot /></button>',
};
const UIconStub = { props: ['name'], template: '<i />' };

function createWrapper(props = {}) {
	return mount(ChatFile, {
		props: {
			name: 'report.pdf',
			src: 'coclaw-file://1:main/output/report.pdf',
			...props,
		},
		global: {
			stubs: { UButton: UButtonStub, UIcon: UIconStub },
			mocks: { $t: (key) => key },
		},
	});
}

// ── mock fetch ──

const originalFetch = globalThis.fetch;
let mockFetchFn;

describe('ChatFile', () => {
	beforeEach(() => {
		mockFetchCoclawFile.mockResolvedValue(makeBlob());
		mockSaveBlobToFile.mockResolvedValue(undefined);
		mockNotifyError.mockClear();
		mockFetchFn = vi.fn().mockResolvedValue({ blob: () => Promise.resolve(makeBlob()) });
		globalThis.fetch = mockFetchFn;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		globalThis.fetch = originalFetch;
	});

	// ── 渲染 ──

	describe('渲染', () => {
		test('显示文件名和扩展名', () => {
			const wrapper = createWrapper({ name: 'data.xlsx' });
			expect(wrapper.text()).toContain('data');
			expect(wrapper.text()).toContain('.xlsx');
		});

		test('无扩展名时只显示文件名', () => {
			const wrapper = createWrapper({ name: 'README' });
			expect(wrapper.text()).toContain('README');
		});

		test('无 name 时显示 i18n key', () => {
			const wrapper = createWrapper({ name: '' });
			expect(wrapper.text()).toContain('chat.fileUnknown');
		});

		test('数字 size 格式化显示', () => {
			const wrapper = createWrapper({ size: 1024 });
			expect(wrapper.text()).toContain('1024 B');
		});

		test('字符串 size 原样显示', () => {
			const wrapper = createWrapper({ size: '2.5 MB' });
			expect(wrapper.text()).toContain('2.5 MB');
		});

		test('无 src 时不渲染下载按钮', () => {
			const wrapper = createWrapper({ src: null });
			expect(wrapper.findComponent(UButtonStub).exists()).toBe(false);
		});

		test('有 src 时渲染下载按钮', () => {
			const wrapper = createWrapper();
			expect(wrapper.findComponent(UButtonStub).exists()).toBe(true);
		});
	});

	// ── 下载：coclaw-file URL ──

	describe('下载 - coclaw-file URL', () => {
		test('下载成功后调用 saveBlobToFile', async () => {
			const blob = makeBlob('pdf-data');
			mockFetchCoclawFile.mockResolvedValue(blob);
			const wrapper = createWrapper();

			await wrapper.vm.onDownload();
			await flushPromises();

			expect(mockFetchCoclawFile).toHaveBeenCalledWith('coclaw-file://1:main/output/report.pdf');
			expect(mockSaveBlobToFile).toHaveBeenCalledWith(blob, 'report.pdf');
			expect(wrapper.vm.downloading).toBe(false);
		});

		test('下载失败时 notify 包含文件路径', async () => {
			mockFetchCoclawFile.mockRejectedValue(new Error('not found'));
			const wrapper = createWrapper();

			await wrapper.vm.onDownload();
			await flushPromises();

			expect(mockNotifyError).toHaveBeenCalledOnce();
			const msg = mockNotifyError.mock.calls[0][0];
			expect(msg).toContain('chat.fileDownloadFailed');
			expect(msg).toContain('output/report.pdf');
			expect(wrapper.vm.downloading).toBe(false);
		});

		test('下载失败时路径含子目录能完整显示', async () => {
			mockFetchCoclawFile.mockRejectedValue(new Error('fail'));
			const wrapper = createWrapper({
				src: 'coclaw-file://bot42:main/deep/nested/dir/file.csv',
				name: 'file.csv',
			});

			await wrapper.vm.onDownload();
			await flushPromises();

			const msg = mockNotifyError.mock.calls[0][0];
			expect(msg).toContain('deep/nested/dir/file.csv');
		});

		test('saveBlobToFile 失败时 notify 包含路径', async () => {
			mockFetchCoclawFile.mockResolvedValue(makeBlob());
			mockSaveBlobToFile.mockRejectedValue(new Error('save failed'));
			const wrapper = createWrapper();

			await wrapper.vm.onDownload();
			await flushPromises();

			expect(mockNotifyError).toHaveBeenCalledOnce();
			expect(mockNotifyError.mock.calls[0][0]).toContain('output/report.pdf');
		});
	});

	// ── 下载：blob URL ──

	describe('下载 - blob URL', () => {
		test('blob URL 下载成功', async () => {
			const blob = makeBlob('blob-data');
			mockFetchFn.mockResolvedValue({ blob: () => Promise.resolve(blob) });
			const wrapper = createWrapper({ src: 'blob:http://localhost/abc123' });

			await wrapper.vm.onDownload();
			await flushPromises();

			expect(mockFetchFn).toHaveBeenCalledWith('blob:http://localhost/abc123');
			expect(mockSaveBlobToFile).toHaveBeenCalledWith(blob, 'report.pdf');
		});

		test('blob URL 下载失败时 notify 显示原始 URL', async () => {
			mockFetchFn.mockRejectedValue(new Error('revoked'));
			const wrapper = createWrapper({ src: 'blob:http://localhost/dead' });

			await wrapper.vm.onDownload();
			await flushPromises();

			expect(mockNotifyError).toHaveBeenCalledOnce();
			const msg = mockNotifyError.mock.calls[0][0];
			// blob URL 无法 parse 为 coclaw URL，fallback 显示原始 src
			expect(msg).toContain('blob:http://localhost/dead');
		});
	});

	// ── 防重复点击 ──

	describe('防重复点击', () => {
		test('downloading 期间再次调用 onDownload 是 no-op', async () => {
			let resolveDownload;
			mockFetchCoclawFile.mockReturnValue(new Promise((r) => { resolveDownload = r; }));
			const wrapper = createWrapper();

			// 发起第一次下载
			const p1 = wrapper.vm.onDownload();
			expect(wrapper.vm.downloading).toBe(true);

			// 第二次调用
			wrapper.vm.onDownload();
			// fetchCoclawFile 应只被调用一次
			expect(mockFetchCoclawFile).toHaveBeenCalledTimes(1);

			resolveDownload(makeBlob());
			await p1;
			await flushPromises();
			expect(wrapper.vm.downloading).toBe(false);
		});

		test('src 为 null 时 onDownload 直接返回', async () => {
			const wrapper = createWrapper({ src: null });
			await wrapper.vm.onDownload();
			expect(mockFetchCoclawFile).not.toHaveBeenCalled();
			expect(mockFetchFn).not.toHaveBeenCalled();
		});
	});

	// ── displayName fallback ──

	describe('displayName', () => {
		test('有 name 时用 name', () => {
			const wrapper = createWrapper({ name: 'my-report.pdf' });
			expect(wrapper.vm.displayName).toBe('my-report.pdf');
		});

		test('无 name 时 fallback 为 i18n key', () => {
			const wrapper = createWrapper({ name: '' });
			expect(wrapper.vm.displayName).toBe('chat.fileUnknown');
		});
	});
});
