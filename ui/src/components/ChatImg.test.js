import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// ── mock 依赖 ──

const mockPushDialogState = vi.fn();
const mockPopDialogState = vi.fn();
vi.mock('../utils/dialog-history.js', () => ({
	pushDialogState: (...args) => mockPushDialogState(...args),
	popDialogState: (...args) => mockPopDialogState(...args),
}));

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

const mockCompressImage = vi.fn();
vi.mock('../utils/image-helper.js', () => ({
	compressImage: (...args) => mockCompressImage(...args),
}));

const mockSaveBlobToFile = vi.fn();
const mockSaveUrlAsFile = vi.fn();
vi.mock('../utils/file-helper.js', () => ({
	saveBlobToFile: (...args) => mockSaveBlobToFile(...args),
	saveUrlAsFile: (...args) => mockSaveUrlAsFile(...args),
}));

let mockIsCapacitorApp = false;
vi.mock('../utils/platform.js', () => ({
	get isCapacitorApp() { return mockIsCapacitorApp; },
}));

const mockNotifyError = vi.fn();
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => ({ success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: mockNotifyError }),
}));

import ChatImg from './ChatImg.vue';

// ── stub / helper ──

const ImgViewDialogStub = {
	name: 'ImgViewDialog',
	props: ['open', 'src', 'filename'],
	emits: ['update:open', 'after:leave'],
	template: '<div class="dialog-stub" />',
};

const UIconStub = {
	props: ['name'],
	template: '<i />',
};

/** 创建小型 PNG blob 用于测试 */
function makeBlob(content = 'img', type = 'image/png') {
	return new Blob([content], { type });
}

/** 创建代表压缩后缩略图的 blob */
function makeThumbBlob() {
	return new Blob(['thumb'], { type: 'image/jpeg' });
}

/** 模拟 compressImage 返回压缩结果 */
function mockCompressed(thumbBlob) {
	mockCompressImage.mockResolvedValue({
		blob: thumbBlob || makeThumbBlob(),
		width: 200,
		height: 150,
		skipped: false,
	});
}

/** 模拟 compressImage 返回原图（小图/无需压缩） */
function mockNotCompressed(_blob) {
	mockCompressImage.mockImplementation((b) => Promise.resolve({
		blob: b,
		width: 100,
		height: 80,
		skipped: false,
	}));
}

/** 模拟 compressImage 返回跳过（GIF 等） */
function mockSkipped() {
	mockCompressImage.mockImplementation((b) => Promise.resolve({
		blob: b,
		width: 0,
		height: 0,
		skipped: true,
	}));
}

// mock fetch 用于 data URI / blob URL → Blob 转换
const originalFetch = globalThis.fetch;
let mockFetchFn;

function createWrapper(props = {}) {
	return mount(ChatImg, {
		props: {
			src: 'data:image/png;base64,abc',
			...props,
		},
		global: {
			stubs: {
				ImgViewDialog: ImgViewDialogStub,
				UIcon: UIconStub,
			},
			mocks: {
				$t: (key) => key,
			},
		},
	});
}

// mock URL.createObjectURL / revokeObjectURL（jsdom 不提供）
const createdUrls = [];
const revokedUrls = [];
let blobUrlCounter = 0;

if (!URL.createObjectURL) URL.createObjectURL = () => '';
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};

describe('ChatImg', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		blobUrlCounter = 0;
		createdUrls.length = 0;
		revokedUrls.length = 0;

		vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
			const url = `blob:http://test/${++blobUrlCounter}`;
			createdUrls.push(url);
			return url;
		});
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
			revokedUrls.push(url);
		});

		// 默认 fetch mock：data URI / blob URL → blob
		const defaultBlob = makeBlob();
		mockFetchFn = vi.fn().mockResolvedValue({ blob: () => Promise.resolve(defaultBlob) });
		globalThis.fetch = mockFetchFn;

		// 默认 compressImage：压缩成功
		mockCompressed();

		// 默认 fetchCoclawFile
		mockFetchCoclawFile.mockResolvedValue(makeBlob());

		mockPushDialogState.mockClear();
		mockPopDialogState.mockClear();
		mockNotifyError.mockClear();
		mockSaveBlobToFile.mockClear();
		mockSaveUrlAsFile.mockClear();
		mockIsCapacitorApp = false;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		globalThis.fetch = originalFetch;
	});

	// ── __resolve：data URI ──

	describe('resolve - data URI', () => {
		test('压缩成功时显示缩略图 blob URL', async () => {
			const wrapper = createWrapper({ src: 'data:image/png;base64,abc' });
			await flushPromises();

			expect(mockFetchFn).toHaveBeenCalledWith('data:image/png;base64,abc');
			expect(mockCompressImage).toHaveBeenCalled();
			expect(wrapper.vm.resolvedSrc).toBe('blob:http://test/1');
			expect(wrapper.vm.__isThumb).toBe(true);
			// data URI 不缓存 __fullBlob
			expect(wrapper.vm.__fullBlob).toBeNull();
		});

		test('小图无需压缩时直接用 src', async () => {
			mockNotCompressed();
			const wrapper = createWrapper({ src: 'data:image/png;base64,small' });
			await flushPromises();

			expect(wrapper.vm.resolvedSrc).toBe('data:image/png;base64,small');
			expect(wrapper.vm.__isThumb).toBe(false);
			// 不应创建 blob URL
			expect(createdUrls).toHaveLength(0);
		});

		test('skipped 类型直接用 src', async () => {
			mockSkipped();
			const wrapper = createWrapper({ src: 'data:image/gif;base64,gif' });
			await flushPromises();

			expect(wrapper.vm.resolvedSrc).toBe('data:image/gif;base64,gif');
			expect(wrapper.vm.__isThumb).toBe(false);
		});

		test('fetch 失败时 fallback 为直接显示 src，不 notify', async () => {
			mockFetchFn.mockRejectedValue(new Error('fetch error'));
			const wrapper = createWrapper({ src: 'data:image/png;base64,bad' });
			await flushPromises();

			expect(wrapper.vm.resolvedSrc).toBe('data:image/png;base64,bad');
			expect(wrapper.vm.error).toBe(false);
			expect(wrapper.vm.loading).toBe(false);
			expect(mockNotifyError).not.toHaveBeenCalled();
		});

		test('compressImage 失败时 fallback 为直接显示 src，不 notify', async () => {
			mockCompressImage.mockRejectedValue(new Error('decode failed'));
			const wrapper = createWrapper({ src: 'data:image/png;base64,corrupt' });
			await flushPromises();

			expect(wrapper.vm.resolvedSrc).toBe('data:image/png;base64,corrupt');
			expect(wrapper.vm.error).toBe(false);
			expect(mockNotifyError).not.toHaveBeenCalled();
		});
	});

	// ── __resolve：blob URL ──

	describe('resolve - blob URL', () => {
		test('压缩成功时显示缩略图并缓存原图', async () => {
			const origBlob = makeBlob();
			mockFetchFn.mockResolvedValue({ blob: () => Promise.resolve(origBlob) });
			mockCompressed();

			const wrapper = createWrapper({ src: 'blob:http://origin/1' });
			await flushPromises();

			expect(wrapper.vm.resolvedSrc).toBe('blob:http://test/1');
			expect(wrapper.vm.__isThumb).toBe(true);
			expect(wrapper.vm.__fullBlob).toBe(origBlob);
		});

		test('小图无需压缩时直接用 src', async () => {
			mockNotCompressed();
			const wrapper = createWrapper({ src: 'blob:http://origin/2' });
			await flushPromises();

			expect(wrapper.vm.resolvedSrc).toBe('blob:http://origin/2');
			expect(wrapper.vm.__isThumb).toBe(false);
			expect(createdUrls).toHaveLength(0);
		});

		test('fetch 失败时 fallback 为直接显示 src，不 notify', async () => {
			mockFetchFn.mockRejectedValue(new Error('revoked'));
			const wrapper = createWrapper({ src: 'blob:http://origin/dead' });
			await flushPromises();

			expect(wrapper.vm.resolvedSrc).toBe('blob:http://origin/dead');
			expect(wrapper.vm.error).toBe(false);
			expect(mockNotifyError).not.toHaveBeenCalled();
		});
	});

	// ── __resolve：coclaw-file URL ──

	describe('resolve - coclaw-file URL', () => {
		test('下载并压缩成功', async () => {
			const origBlob = makeBlob();
			mockFetchCoclawFile.mockResolvedValue(origBlob);
			mockCompressed();

			const wrapper = createWrapper({ src: 'coclaw-file://1:main/img.png' });
			await flushPromises();

			expect(mockFetchCoclawFile).toHaveBeenCalledWith('coclaw-file://1:main/img.png');
			expect(wrapper.vm.resolvedSrc).toBe('blob:http://test/1');
			expect(wrapper.vm.__isThumb).toBe(true);
			expect(wrapper.vm.__fullBlob).toBe(origBlob);
		});

		test('小图无需压缩时用 blob URL 显示', async () => {
			const origBlob = makeBlob();
			mockFetchCoclawFile.mockResolvedValue(origBlob);
			mockNotCompressed();

			const wrapper = createWrapper({ src: 'coclaw-file://1:main/small.png' });
			await flushPromises();

			// 应为原图创建 blob URL
			expect(wrapper.vm.resolvedSrc).toBe('blob:http://test/1');
			expect(wrapper.vm.__isThumb).toBe(false);
		});

		test('下载失败时显示错误状态并 notify 路径', async () => {
			mockFetchCoclawFile.mockRejectedValue(new Error('network'));
			const wrapper = createWrapper({ src: 'coclaw-file://1:main/fail.png' });
			await flushPromises();

			expect(wrapper.vm.error).toBe(true);
			expect(wrapper.vm.resolvedSrc).toBeNull();
			expect(wrapper.vm.loading).toBe(false);
			expect(mockNotifyError).toHaveBeenCalledOnce();
			expect(mockNotifyError.mock.calls[0][0]).toContain('fail.png');
		});

		test('compressImage 失败时显示错误状态并 notify 路径', async () => {
			mockFetchCoclawFile.mockResolvedValue(makeBlob());
			mockCompressImage.mockRejectedValue(new Error('decode'));
			const wrapper = createWrapper({ src: 'coclaw-file://1:main/corrupt.png' });
			await flushPromises();

			expect(wrapper.vm.error).toBe(true);
			expect(mockNotifyError).toHaveBeenCalledOnce();
			expect(mockNotifyError.mock.calls[0][0]).toContain('corrupt.png');
		});

		test('notify 消息包含 i18n key 和完整相对路径', async () => {
			mockFetchCoclawFile.mockRejectedValue(new Error('gone'));
			const wrapper = createWrapper({ src: 'coclaw-file://bot5:main/workspace/output/chart.png' });
			await flushPromises();

			expect(wrapper.vm.error).toBe(true);
			const msg = mockNotifyError.mock.calls[0][0];
			expect(msg).toContain('chat.imgLoadFailed');
			expect(msg).toContain('workspace/output/chart.png');
		});
	});

	// ── __resolve：https 等 ──

	describe('resolve - other URL types', () => {
		test('https URL 直接显示，不压缩', async () => {
			const wrapper = createWrapper({ src: 'https://example.com/img.png' });
			await flushPromises();

			expect(wrapper.vm.resolvedSrc).toBe('https://example.com/img.png');
			expect(mockFetchFn).not.toHaveBeenCalled();
			expect(mockCompressImage).not.toHaveBeenCalled();
		});

		test('空 src 时 resolvedSrc 为 null', async () => {
			const wrapper = createWrapper({ src: '' });
			await flushPromises();

			// src 是 required 但测试空字符串的处理
			expect(wrapper.vm.resolvedSrc).toBeNull();
		});
	});

	// ── src 变化时的清理 ──

	describe('src 变化与清理', () => {
		test('src 变化时 revoke 旧缩略图 blob URL', async () => {
			const wrapper = createWrapper({ src: 'data:image/png;base64,aaa' });
			await flushPromises();
			const oldUrl = wrapper.vm.resolvedSrc;
			expect(oldUrl).toBe('blob:http://test/1');

			await wrapper.setProps({ src: 'data:image/png;base64,bbb' });
			await flushPromises();

			expect(revokedUrls).toContain(oldUrl);
		});

		test('src 变化时清除 __fullBlob 和 timer', async () => {
			const origBlob = makeBlob();
			mockFetchCoclawFile.mockResolvedValue(origBlob);
			mockCompressed();

			const wrapper = createWrapper({ src: 'coclaw-file://1:main/a.png' });
			await flushPromises();
			expect(wrapper.vm.__fullBlob).toBe(origBlob);
			expect(wrapper.vm.__fullBlobTimer).toBeTruthy();

			await wrapper.setProps({ src: 'data:image/png;base64,new' });
			await flushPromises();

			expect(wrapper.vm.__fullBlob).toBeNull();
		});

		test('async 完成时 src 已变化则丢弃结果', async () => {
			// 慢速 fetch
			let resolveFirst;
			mockFetchCoclawFile.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));

			const wrapper = createWrapper({ src: 'coclaw-file://1:main/slow.png' });
			expect(wrapper.vm.loading).toBe(true);

			// src 变化
			mockNotCompressed();
			await wrapper.setProps({ src: 'data:image/png;base64,fast' });
			await flushPromises();

			// 第一个请求完成但 src 已变
			resolveFirst(makeBlob());
			await flushPromises();

			// resolvedSrc 应为第二个的结果
			expect(wrapper.vm.resolvedSrc).toBe('data:image/png;base64,fast');
		});

		test('coclaw-file 下载失败但 src 已变化时不 notify', async () => {
			let rejectFirst;
			mockFetchCoclawFile.mockReturnValueOnce(new Promise((_r, rej) => { rejectFirst = rej; }));

			const wrapper = createWrapper({ src: 'coclaw-file://1:main/will-fail.png' });

			// src 变化
			mockNotCompressed();
			await wrapper.setProps({ src: 'data:image/png;base64,new' });
			await flushPromises();

			// 第一个请求失败但 src 已变
			rejectFirst(new Error('too late'));
			await flushPromises();

			expect(mockNotifyError).not.toHaveBeenCalled();
			expect(wrapper.vm.error).toBe(false);
		});

		test('coclaw-file 下载失败但已 unmount 时不 notify', async () => {
			let rejectFetch;
			mockFetchCoclawFile.mockReturnValueOnce(new Promise((_r, rej) => { rejectFetch = rej; }));

			const wrapper = createWrapper({ src: 'coclaw-file://1:main/orphan.png' });
			wrapper.unmount();

			rejectFetch(new Error('too late'));
			await flushPromises();

			expect(mockNotifyError).not.toHaveBeenCalled();
		});
	});

	// ── 全图缓存 TTL ──

	describe('原图 Blob 缓存 TTL', () => {
		test('300s 后清除 __fullBlob', async () => {
			const origBlob = makeBlob();
			mockFetchCoclawFile.mockResolvedValue(origBlob);
			mockCompressed();

			const wrapper = createWrapper({ src: 'coclaw-file://1:main/big.png' });
			await flushPromises();
			expect(wrapper.vm.__fullBlob).toBe(origBlob);

			vi.advanceTimersByTime(299_999);
			expect(wrapper.vm.__fullBlob).toBe(origBlob);

			vi.advanceTimersByTime(1);
			expect(wrapper.vm.__fullBlob).toBeNull();
		});

		test('data URI 来源不启动 timer', async () => {
			mockCompressed();
			const wrapper = createWrapper({ src: 'data:image/png;base64,big' });
			await flushPromises();

			expect(wrapper.vm.__isThumb).toBe(true);
			expect(wrapper.vm.__fullBlobTimer).toBeUndefined();
		});
	});

	// ── viewImg：全图查看 ──

	describe('viewImg', () => {
		test('未压缩时 fullSrc = resolvedSrc', async () => {
			mockNotCompressed();
			const wrapper = createWrapper({ src: 'data:image/png;base64,small' });
			await flushPromises();
			wrapper.vm.imgLoaded = true;

			wrapper.vm.viewImg();
			expect(wrapper.vm.fullSrc).toBe('data:image/png;base64,small');
			expect(wrapper.vm.dialogOpen).toBe(true);
			expect(mockPushDialogState).toHaveBeenCalled();
		});

		test('有缓存 __fullBlob 时创建 blob URL 打开', async () => {
			const origBlob = makeBlob();
			mockFetchCoclawFile.mockResolvedValue(origBlob);
			mockCompressed();

			const wrapper = createWrapper({ src: 'coclaw-file://1:main/x.png' });
			await flushPromises();
			wrapper.vm.imgLoaded = true;

			wrapper.vm.viewImg();
			expect(wrapper.vm.fullSrc).toMatch(/^blob:/);
			expect(wrapper.vm.fullSrc).not.toBe(wrapper.vm.resolvedSrc);
			expect(wrapper.vm.dialogOpen).toBe(true);
		});

		test('data URI 压缩后无缓存时用 src 本身打开', async () => {
			mockCompressed();
			const wrapper = createWrapper({ src: 'data:image/png;base64,big' });
			await flushPromises();
			wrapper.vm.imgLoaded = true;

			// __fullBlob 未缓存（data URI 来源不缓存）
			expect(wrapper.vm.__fullBlob).toBeNull();
			wrapper.vm.viewImg();
			expect(wrapper.vm.fullSrc).toBe('data:image/png;base64,big');
		});

		test('缓存过期后 coclaw-file 重新下载', async () => {
			const origBlob = makeBlob('orig');
			mockFetchCoclawFile.mockResolvedValue(origBlob);
			mockCompressed();

			const wrapper = createWrapper({ src: 'coclaw-file://1:main/y.png' });
			await flushPromises();
			wrapper.vm.imgLoaded = true;

			// 让 TTL 过期
			vi.advanceTimersByTime(300_000);
			expect(wrapper.vm.__fullBlob).toBeNull();

			// 重新下载
			const newBlob = makeBlob('refetch');
			mockFetchCoclawFile.mockResolvedValue(newBlob);

			await wrapper.vm.viewImg();
			await flushPromises();

			expect(wrapper.vm.__fullBlob).toBe(newBlob);
			expect(wrapper.vm.fullSrc).toMatch(/^blob:/);
			expect(wrapper.vm.dialogOpen).toBe(true);
		});

		test('重新下载失败时 fallback 用缩略图打开', async () => {
			const origBlob = makeBlob();
			mockFetchCoclawFile.mockResolvedValue(origBlob);
			mockCompressed();

			const wrapper = createWrapper({ src: 'coclaw-file://1:main/z.png' });
			await flushPromises();
			wrapper.vm.imgLoaded = true;
			const thumbUrl = wrapper.vm.resolvedSrc;

			// TTL 过期
			vi.advanceTimersByTime(300_000);

			// 重新下载失败
			mockFetchCoclawFile.mockRejectedValue(new Error('offline'));

			await wrapper.vm.viewImg();
			await flushPromises();

			// fallback 到缩略图
			expect(wrapper.vm.fullSrc).toBe(thumbUrl);
			expect(wrapper.vm.dialogOpen).toBe(true);
		});

		test('imgLoaded=false 时不响应点击', async () => {
			const wrapper = createWrapper({ src: 'data:image/png;base64,abc' });
			await flushPromises();
			// imgLoaded 默认 false

			wrapper.vm.viewImg();
			expect(wrapper.vm.dialogOpen).toBe(false);
		});

		test('dialogOpen 时不响应重复点击', async () => {
			mockNotCompressed();
			const wrapper = createWrapper({ src: 'data:image/png;base64,abc' });
			await flushPromises();
			wrapper.vm.imgLoaded = true;

			wrapper.vm.viewImg();
			expect(wrapper.vm.dialogOpen).toBe(true);

			// 第二次点击
			const oldFullSrc = wrapper.vm.fullSrc;
			wrapper.vm.viewImg();
			expect(wrapper.vm.fullSrc).toBe(oldFullSrc);
			// pushDialogState 应只调用一次
			expect(mockPushDialogState).toHaveBeenCalledTimes(1);
		});

		test('fullLoading 时不响应点击', async () => {
			const wrapper = createWrapper({ src: 'data:image/png;base64,abc' });
			await flushPromises();
			wrapper.vm.imgLoaded = true;
			wrapper.vm.fullLoading = true;

			wrapper.vm.viewImg();
			expect(wrapper.vm.dialogOpen).toBe(false);
		});

		test('缓存过期后 blob URL 来源重新 fetch', async () => {
			const origBlob = makeBlob('orig');
			mockFetchFn.mockResolvedValue({ blob: () => Promise.resolve(origBlob) });
			mockCompressed();

			const wrapper = createWrapper({ src: 'blob:http://origin/refetch' });
			await flushPromises();
			wrapper.vm.imgLoaded = true;

			// TTL 过期
			vi.advanceTimersByTime(300_000);
			expect(wrapper.vm.__fullBlob).toBeNull();

			// 重新 fetch blob URL
			const newBlob = makeBlob('new');
			mockFetchFn.mockResolvedValue({ blob: () => Promise.resolve(newBlob) });

			await wrapper.vm.viewImg();
			await flushPromises();

			expect(wrapper.vm.__fullBlob).toBe(newBlob);
			expect(wrapper.vm.fullSrc).toMatch(/^blob:/);
			expect(wrapper.vm.dialogOpen).toBe(true);
		});

		test('缓存过期后 blob URL 重新下载，viewImg 中 __unmounted 则丢弃', async () => {
			const origBlob = makeBlob();
			mockFetchCoclawFile.mockResolvedValue(origBlob);
			mockCompressed();

			const wrapper = createWrapper({ src: 'coclaw-file://1:main/u.png' });
			await flushPromises();
			wrapper.vm.imgLoaded = true;

			// TTL 过期
			vi.advanceTimersByTime(300_000);

			// 慢速重新下载
			let resolveRefetch;
			mockFetchCoclawFile.mockReturnValueOnce(new Promise((r) => { resolveRefetch = r; }));

			const promise = wrapper.vm.viewImg();
			expect(wrapper.vm.fullLoading).toBe(true);

			// 组件卸载
			wrapper.unmount();

			resolveRefetch(makeBlob('late'));
			await promise;
			await flushPromises();

			// 不应创建新 blob URL（已卸载）
			expect(wrapper.vm.dialogOpen).toBe(false);
		});
	});

	// ── dialog 关闭 ──

	describe('dialog 关闭与清理', () => {
		test('__onDialogLeave revoke fullSrc 并重启 timer', async () => {
			const origBlob = makeBlob();
			mockFetchCoclawFile.mockResolvedValue(origBlob);
			mockCompressed();

			const wrapper = createWrapper({ src: 'coclaw-file://1:main/dl.png' });
			await flushPromises();
			wrapper.vm.imgLoaded = true;

			wrapper.vm.viewImg();
			const fullUrl = wrapper.vm.fullSrc;
			expect(fullUrl).toMatch(/^blob:/);

			// 模拟 dialog 关闭
			wrapper.vm.__onDialogLeave();

			expect(revokedUrls).toContain(fullUrl);
			expect(wrapper.vm.fullSrc).toBeNull();
			// timer 应重启
			expect(wrapper.vm.__fullBlobTimer).toBeTruthy();

			// 300s 后 __fullBlob 清除
			vi.advanceTimersByTime(300_000);
			expect(wrapper.vm.__fullBlob).toBeNull();
		});

		test('__onDialogLeave 不 revoke 外部传入的 URL', async () => {
			mockNotCompressed();
			const wrapper = createWrapper({ src: 'data:image/png;base64,small' });
			await flushPromises();
			wrapper.vm.imgLoaded = true;

			wrapper.vm.viewImg();
			// fullSrc === resolvedSrc === this.src (data URI)，不应 revoke
			wrapper.vm.__onDialogLeave();

			expect(revokedUrls).toHaveLength(0);
		});
	});

	// ── beforeUnmount ──

	describe('beforeUnmount 清理', () => {
		test('卸载时 revoke 所有自建 blob URL', async () => {
			mockCompressed();
			const wrapper = createWrapper({ src: 'data:image/png;base64,big' });
			await flushPromises();
			const thumbUrl = wrapper.vm.resolvedSrc;

			wrapper.unmount();

			expect(revokedUrls).toContain(thumbUrl);
		});

		test('卸载时清除 __fullBlob 和 timer', async () => {
			const origBlob = makeBlob();
			mockFetchCoclawFile.mockResolvedValue(origBlob);
			mockCompressed();

			const wrapper = createWrapper({ src: 'coclaw-file://1:main/unmount.png' });
			await flushPromises();

			wrapper.unmount();

			expect(wrapper.vm.__fullBlob).toBeNull();
		});

		test('dialog 打开时卸载会 popDialogState', async () => {
			mockNotCompressed();
			const wrapper = createWrapper({ src: 'data:image/png;base64,abc' });
			await flushPromises();
			wrapper.vm.imgLoaded = true;

			wrapper.vm.viewImg();
			expect(wrapper.vm.dialogOpen).toBe(true);

			wrapper.unmount();

			expect(mockPopDialogState).toHaveBeenCalled();
		});

		test('dialog 未打开时卸载不调用 popDialogState', async () => {
			const wrapper = createWrapper({ src: 'data:image/png;base64,abc' });
			await flushPromises();

			wrapper.unmount();

			expect(mockPopDialogState).not.toHaveBeenCalled();
		});
	});

	// ── blob URL 泄漏检查 ──

	describe('blob URL 泄漏审计', () => {
		test('完整生命周期：创建→查看→关闭→卸载无泄漏', async () => {
			const origBlob = makeBlob();
			mockFetchCoclawFile.mockResolvedValue(origBlob);
			mockCompressed();

			const wrapper = createWrapper({ src: 'coclaw-file://1:main/lifecycle.png' });
			await flushPromises();

			// 1 个缩略图 blob URL
			expect(createdUrls).toHaveLength(1);

			// 打开全图
			wrapper.vm.imgLoaded = true;
			wrapper.vm.viewImg();
			// 1 缩略图 + 1 全图
			expect(createdUrls).toHaveLength(2);

			// 关闭 dialog
			wrapper.vm.__onDialogLeave();
			// 全图 blob URL 被 revoke
			expect(revokedUrls).toHaveLength(1);

			// 卸载
			wrapper.unmount();
			// 缩略图 blob URL 也被 revoke
			expect(revokedUrls).toHaveLength(2);

			// 所有创建的都被 revoke
			for (const url of createdUrls) {
				expect(revokedUrls).toContain(url);
			}
		});

		test('src 变化多次无泄漏', async () => {
			mockCompressed();
			const wrapper = createWrapper({ src: 'data:image/png;base64,v1' });
			await flushPromises();

			await wrapper.setProps({ src: 'data:image/png;base64,v2' });
			await flushPromises();

			await wrapper.setProps({ src: 'data:image/png;base64,v3' });
			await flushPromises();

			// 3 次压缩 → 3 个缩略图 blob URL 创建
			expect(createdUrls).toHaveLength(3);
			// 前 2 个应已 revoke
			expect(revokedUrls).toHaveLength(2);
			expect(revokedUrls).toContain(createdUrls[0]);
			expect(revokedUrls).toContain(createdUrls[1]);

			wrapper.unmount();
			// 第 3 个也 revoke
			expect(revokedUrls).toHaveLength(3);
		});

		test('coclaw-file 小图创建的 blob URL 卸载时正确 revoke', async () => {
			mockFetchCoclawFile.mockResolvedValue(makeBlob());
			mockNotCompressed();

			const wrapper = createWrapper({ src: 'coclaw-file://1:main/tiny.png' });
			await flushPromises();

			// 小图也为 coclaw-file 创建了 blob URL
			expect(createdUrls).toHaveLength(1);

			wrapper.unmount();
			expect(revokedUrls).toContain(createdUrls[0]);
		});
	});

	// ── 模板渲染 ──

	describe('模板渲染', () => {
		test('加载中显示 spinner', async () => {
			let resolveFile;
			mockFetchCoclawFile.mockReturnValue(new Promise((r) => { resolveFile = r; }));

			const wrapper = createWrapper({ src: 'coclaw-file://1:main/loading.png' });
			await flushPromises();

			expect(wrapper.vm.loading).toBe(true);
			expect(wrapper.find('.min-h-\\[52px\\].min-w-\\[128px\\]').exists()).toBe(true);
			expect(wrapper.find('.animate-spin').exists()).toBe(true);

			resolveFile(makeBlob());
			await flushPromises();
			expect(wrapper.vm.loading).toBe(false);
		});

		test('错误时显示图片错误图标', async () => {
			mockFetchCoclawFile.mockRejectedValue(new Error('fail'));
			const wrapper = createWrapper({ src: 'coclaw-file://1:main/err.png' });
			await flushPromises();

			expect(wrapper.vm.error).toBe(true);
			// 错误占位符应存在
			expect(wrapper.find('.min-h-\\[52px\\].min-w-\\[128px\\]').exists()).toBe(true);
		});

		test('图片加载成功后渲染 img 标签', async () => {
			mockNotCompressed();
			const wrapper = createWrapper({ src: 'data:image/png;base64,ok' });
			await flushPromises();

			const img = wrapper.find('img');
			expect(img.exists()).toBe(true);
			expect(img.attributes('src')).toBe('data:image/png;base64,ok');
		});

		test('fullLoading 时显示遮罩', async () => {
			mockCompressed();
			const wrapper = createWrapper({ src: 'data:image/png;base64,abc' });
			await flushPromises();

			expect(wrapper.find('.bg-black\\/30').exists()).toBe(false);

			wrapper.vm.fullLoading = true;
			await wrapper.vm.$nextTick();

			expect(wrapper.find('.bg-black\\/30').exists()).toBe(true);
		});

		test('ImgViewDialog 在 fullSrc 或 dialogOpen 为 true 时渲染', async () => {
			mockNotCompressed();
			const wrapper = createWrapper({ src: 'data:image/png;base64,abc' });
			await flushPromises();

			// 初始无 dialog
			expect(wrapper.findComponent(ImgViewDialogStub).exists()).toBe(false);

			// 打开
			wrapper.vm.imgLoaded = true;
			wrapper.vm.viewImg();
			await wrapper.vm.$nextTick();
			expect(wrapper.findComponent(ImgViewDialogStub).exists()).toBe(true);
		});
	});

	// ── __download ──

	describe('download', () => {
		test('外部 URL + Web 端：走 saveUrlAsFile', async () => {
			const wrapper = createWrapper({ src: 'https://example.com/photo.png', filename: 'photo.png' });
			await flushPromises();

			await wrapper.vm.__download();

			expect(mockSaveUrlAsFile).toHaveBeenCalledWith('https://example.com/photo.png', 'photo.png');
			expect(mockSaveBlobToFile).not.toHaveBeenCalled();
			expect(wrapper.vm.downloading).toBe(false);
		});

		test('外部 URL + Native 端：走 fetch + saveBlobToFile', async () => {
			mockIsCapacitorApp = true;
			const blob = makeBlob();
			mockFetchFn.mockResolvedValue({ blob: () => Promise.resolve(blob) });
			const wrapper = createWrapper({ src: 'https://example.com/photo.png', filename: 'photo.png' });
			await flushPromises();
			// Native 需重新读取 isNative（data 中在 created 时已读取）
			wrapper.vm.isNative = true;

			mockSaveBlobToFile.mockResolvedValue();
			await wrapper.vm.__download();
			await flushPromises();

			expect(mockSaveUrlAsFile).not.toHaveBeenCalled();
			expect(mockSaveBlobToFile).toHaveBeenCalledOnce();
		});

		test('data URI 缩略图：获取原图 blob 并 saveBlobToFile', async () => {
			mockCompressed();
			const origBlob = makeBlob('original');
			mockFetchFn.mockResolvedValue({ blob: () => Promise.resolve(origBlob) });
			const wrapper = createWrapper({ src: 'data:image/png;base64,abc', filename: 'img.png' });
			await flushPromises();

			expect(wrapper.vm.__isThumb).toBe(true);

			mockSaveBlobToFile.mockResolvedValue();
			await wrapper.vm.__download();
			await flushPromises();

			// data URI thumb 走 fetch(this.src) 路径
			expect(mockSaveBlobToFile).toHaveBeenCalledWith(origBlob, 'img.png');
		});

		test('coclaw-file 缩略图有缓存：直接用缓存 blob', async () => {
			const origBlob = makeBlob('original');
			mockFetchCoclawFile.mockResolvedValue(origBlob);
			mockCompressed();
			const wrapper = createWrapper({ src: 'coclaw-file://c1:a1/test.png', filename: 'test.png' });
			await flushPromises();

			expect(wrapper.vm.__isThumb).toBe(true);
			expect(wrapper.vm.__fullBlob).toBe(origBlob);

			mockSaveBlobToFile.mockResolvedValue();
			await wrapper.vm.__download();
			await flushPromises();

			// 应直接使用缓存，不再请求
			expect(mockFetchCoclawFile).toHaveBeenCalledTimes(1); // 只有 resolve 时的一次
			expect(mockSaveBlobToFile).toHaveBeenCalledWith(origBlob, 'test.png');
		});

		test('coclaw-file 缩略图缓存过期：重新获取', async () => {
			const origBlob = makeBlob('original');
			const refetchBlob = makeBlob('refetched');
			mockFetchCoclawFile.mockResolvedValue(origBlob);
			mockCompressed();
			const wrapper = createWrapper({ src: 'coclaw-file://c1:a1/test.png', filename: 'test.png' });
			await flushPromises();

			// 过期缓存
			vi.advanceTimersByTime(300_001);
			expect(wrapper.vm.__fullBlob).toBeNull();

			mockFetchCoclawFile.mockResolvedValue(refetchBlob);
			mockSaveBlobToFile.mockResolvedValue();
			await wrapper.vm.__download();
			await flushPromises();

			expect(mockFetchCoclawFile).toHaveBeenCalledTimes(2);
			expect(mockSaveBlobToFile).toHaveBeenCalledWith(refetchBlob, 'test.png');
			// 重新缓存
			expect(wrapper.vm.__fullBlob).toBe(refetchBlob);
		});

		test('重复点击被阻止', async () => {
			const wrapper = createWrapper({ src: 'https://example.com/x.png', filename: 'x.png' });
			await flushPromises();

			wrapper.vm.downloading = true;
			await wrapper.vm.__download();

			expect(mockSaveUrlAsFile).not.toHaveBeenCalled();
			expect(mockSaveBlobToFile).not.toHaveBeenCalled();
		});

		test('下载失败时 notify error', async () => {
			mockCompressed();
			mockFetchFn.mockRejectedValue(new Error('network error'));
			const wrapper = createWrapper({ src: 'data:image/png;base64,abc', filename: 'img.png' });
			await flushPromises();

			// 重置 fetch mock 使 __getFullBlob 也失败
			mockFetchFn.mockRejectedValue(new Error('fail'));
			await wrapper.vm.__download();
			await flushPromises();

			expect(mockNotifyError).toHaveBeenCalledWith('files.downloadFailed');
		});

		test('src 变更时中止下载', async () => {
			mockCompressed();
			const wrapper = createWrapper({ src: 'data:image/png;base64,first', filename: 'first.png' });
			await flushPromises();
			expect(wrapper.vm.__isThumb).toBe(true);

			// 替换 fetch mock 为可控的 promise
			const origBlob = makeBlob('original');
			const fetchResolvers = [];
			mockFetchFn.mockImplementation(() => {
				let resolve;
				const p = new Promise((r) => { resolve = r; });
				fetchResolvers.push(resolve);
				return p;
			});

			// 触发 download（等待 fetch）
			const downloadPromise = wrapper.vm.__download();
			await Promise.resolve();

			// 中途切换 src
			await wrapper.setProps({ src: 'data:image/png;base64,second' });

			// resolve download 的 fetch（第一个调用）
			fetchResolvers[0]({ blob: () => Promise.resolve(origBlob) });
			await downloadPromise;

			// saveBlobToFile 不应被调用（src 已变）
			expect(mockSaveBlobToFile).not.toHaveBeenCalled();
		});

		test('组件卸载后不 notify', async () => {
			mockCompressed();
			mockFetchFn.mockRejectedValue(new Error('fail'));
			const wrapper = createWrapper({ src: 'data:image/png;base64,abc', filename: 'img.png' });
			await flushPromises();

			mockFetchFn.mockRejectedValue(new Error('fail'));
			const downloadPromise = wrapper.vm.__download();
			wrapper.unmount();
			await downloadPromise;
			await flushPromises();

			expect(mockNotifyError).not.toHaveBeenCalled();
		});
	});
});
