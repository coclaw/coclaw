import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import ChatInput from './ChatInput.vue';

const mockNotify = {
	success: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	error: vi.fn(),
};
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => mockNotify,
}));

vi.mock('../services/file-transfer.js', () => ({
	MAX_UPLOAD_SIZE: 1024 * 1024, // 1 MB for testing
}));

// 默认 env store 值（桌面浏览器）
const defaultEnv = {
	isNative: false,
	isAndroid: false,
	isIos: false,
	isTouch: false,
	canHover: true,
	screen: { geMd: false, ltMd: true },
};
let mockEnv = { ...defaultEnv };

vi.mock('../stores/env.store.js', () => ({
	useEnvStore: () => mockEnv,
}));

// stub UTextarea / UButton / UIcon
const UTextareaStub = {
	props: ['modelValue', 'placeholder', 'disabled', 'autoresize', 'rows', 'maxrows', 'size'],
	emits: ['update:modelValue', 'keydown'],
	template: '<textarea :value="modelValue" @keydown="$emit(\'keydown\', $event)" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};

const UButtonStub = {
	props: ['icon', 'variant', 'color', 'size', 'disabled', 'loading'],
	emits: ['click'],
	template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
};

const UIconStub = {
	props: ['name'],
	template: '<i />',
};

function createWrapper(props = {}) {
	return mount(ChatInput, {
		props: {
			modelValue: '',
			sending: false,
			disabled: false,
			...props,
		},
		global: {
			plugins: [createPinia()],
			stubs: {
				UTextarea: UTextareaStub,
				UButton: UButtonStub,
				UIcon: UIconStub,
				TouchSpeakOverlay: true,
			},
			mocks: {
				$t: (key) => key,
			},
		},
	});
}

describe('ChatInput', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.clearAllMocks();
		mockEnv = { ...defaultEnv };
		// 模拟桌面宽度
		Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });
		// jsdom 不提供 URL.createObjectURL/revokeObjectURL
		if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => 'blob:mock');
		if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();
	});

	test('canSend returns false when text is empty and no files', () => {
		const wrapper = createWrapper({ modelValue: '' });
		expect(wrapper.vm.canSend).toBe(false);
	});

	test('canSend returns false when text is whitespace only', () => {
		const wrapper = createWrapper({ modelValue: '   ' });
		expect(wrapper.vm.canSend).toBe(false);
	});

	test('canSend returns true when text has content', () => {
		const wrapper = createWrapper({ modelValue: 'hello' });
		expect(wrapper.vm.canSend).toBe(true);
	});

	test('canSend returns true when inputFiles has items', () => {
		const wrapper = createWrapper({ modelValue: '' });
		wrapper.vm.inputFiles = [{ id: '1', name: 'test.txt', isImg: false }];
		expect(wrapper.vm.canSend).toBe(true);
	});

	test('Enter on desktop triggers send', async () => {
		const wrapper = createWrapper({ modelValue: 'hello' });
		const textarea = wrapper.find('textarea');
		await textarea.trigger('keydown', { key: 'Enter', shiftKey: false, isComposing: false });
		expect(wrapper.emitted('send')).toBeTruthy();
		expect(wrapper.emitted('send')[0][0]).toEqual({
			text: 'hello',
			files: [],
		});
	});

	test('Shift+Enter on desktop does not trigger send', async () => {
		const wrapper = createWrapper({ modelValue: 'hello' });
		const textarea = wrapper.find('textarea');
		await textarea.trigger('keydown', { key: 'Enter', shiftKey: true });
		expect(wrapper.emitted('send')).toBeFalsy();
	});

	test('Enter on Capacitor native app does not trigger send (isTouchDevice=true)', async () => {
		mockEnv = { ...defaultEnv, isNative: true };
		const wrapper = createWrapper({ modelValue: 'hello' });
		expect(wrapper.vm.isTouchDevice).toBe(true);
		const textarea = wrapper.find('textarea');
		await textarea.trigger('keydown', { key: 'Enter', shiftKey: false });
		expect(wrapper.emitted('send')).toBeFalsy();
	});

	test('Enter on mobile browser does not trigger send (isAndroid=true)', async () => {
		mockEnv = { ...defaultEnv, isAndroid: true };
		const wrapper = createWrapper({ modelValue: 'hello' });
		expect(wrapper.vm.isTouchDevice).toBe(true);
		const textarea = wrapper.find('textarea');
		await textarea.trigger('keydown', { key: 'Enter', shiftKey: false });
		expect(wrapper.emitted('send')).toBeFalsy();
	});

	test('Enter on iOS browser does not trigger send (isIos=true)', async () => {
		mockEnv = { ...defaultEnv, isIos: true };
		const wrapper = createWrapper({ modelValue: 'hello' });
		expect(wrapper.vm.isTouchDevice).toBe(true);
		const textarea = wrapper.find('textarea');
		await textarea.trigger('keydown', { key: 'Enter', shiftKey: false });
		expect(wrapper.emitted('send')).toBeFalsy();
	});

	test('Enter on desktop browser triggers send', async () => {
		mockEnv = { ...defaultEnv, isNative: false, isAndroid: false, isIos: false, isTouch: false };
		const wrapper = createWrapper({ modelValue: 'hello' });
		expect(wrapper.vm.isTouchDevice).toBe(false);
		const textarea = wrapper.find('textarea');
		await textarea.trigger('keydown', { key: 'Enter', shiftKey: false, isComposing: false });
		expect(wrapper.emitted('send')).toBeTruthy();
	});

	test('Enter on touch laptop triggers send (isTouch=true, canHover=true)', async () => {
		mockEnv = { ...defaultEnv, isNative: false, isAndroid: false, isIos: false, isTouch: true, canHover: true };
		const wrapper = createWrapper({ modelValue: 'hello' });
		// 触控笔记本：有 hover 能力，走桌面分支
		expect(wrapper.vm.isTouchDevice).toBe(false);
		const textarea = wrapper.find('textarea');
		await textarea.trigger('keydown', { key: 'Enter', shiftKey: false, isComposing: false });
		expect(wrapper.emitted('send')).toBeTruthy();
	});

	test('触屏笔记本（isTouch=true, canHover=false）Enter 仍发送（桌面系统有物理键盘）', async () => {
		mockEnv = { ...defaultEnv, isNative: false, isAndroid: false, isIos: false, isTouch: true, canHover: false };
		const wrapper = createWrapper({ modelValue: 'hello' });
		// 非 native、非 Android/iOS → 桌面系统 → isTouchDevice=false
		expect(wrapper.vm.isTouchDevice).toBe(false);
		const textarea = wrapper.find('textarea');
		await textarea.trigger('keydown', { key: 'Enter', shiftKey: false, isComposing: false });
		expect(wrapper.emitted('send')).toBeTruthy();
	});

	test('sending=true shows stop button', () => {
		const wrapper = createWrapper({ sending: true, modelValue: 'hello' });
		const buttons = wrapper.findAll('button');
		const stopBtn = buttons.find((b) => b.attributes('title') === 'chat.stopSending');
		expect(stopBtn).toBeTruthy();
	});

	test('sending=false shows send button when has input', () => {
		const wrapper = createWrapper({ sending: false, modelValue: 'hello' });
		const buttons = wrapper.findAll('button');
		const sendBtn = buttons.find((b) => b.attributes('type') === 'submit');
		expect(sendBtn).toBeTruthy();
	});

	test('send button hidden when no input and not sending', () => {
		const wrapper = createWrapper({ sending: false, modelValue: '' });
		const buttons = wrapper.findAll('button');
		const sendBtn = buttons.find((b) => b.attributes('type') === 'submit');
		expect(sendBtn).toBeFalsy();
	});

	test('clicking stop button emits cancel', async () => {
		const wrapper = createWrapper({ sending: true });
		const buttons = wrapper.findAll('button');
		const stopBtn = buttons.find((b) => b.attributes('title') === 'chat.stopSending');
		if (stopBtn) {
			await stopBtn.trigger('click');
			expect(wrapper.emitted('cancel')).toBeTruthy();
		}
	});

	test('cancelDisabled=true disables the stop button', () => {
		const wrapper = createWrapper({ sending: true, cancelDisabled: true });
		const stopBtnStub = wrapper.findAllComponents(UButtonStub)
			.find((b) => b.attributes('title') === 'chat.stopSending');
		expect(stopBtnStub).toBeTruthy();
		expect(stopBtnStub.props('disabled')).toBe(true);
	});

	test('cancelDisabled=false keeps stop button enabled', () => {
		const wrapper = createWrapper({ sending: true, cancelDisabled: false });
		const stopBtnStub = wrapper.findAllComponents(UButtonStub)
			.find((b) => b.attributes('title') === 'chat.stopSending');
		expect(stopBtnStub).toBeTruthy();
		expect(stopBtnStub.props('disabled')).toBe(false);
	});

	test('submit 后 inputFiles 保留（由上传过程逐个移除）', () => {
		const wrapper = createWrapper({ modelValue: 'hi' });
		wrapper.vm.inputFiles = [{ id: '1', name: 'a.txt', isImg: false, url: null }];
		wrapper.vm.onSubmit();
		expect(wrapper.vm.inputFiles).toHaveLength(1);
	});

	test('does not send when text is empty and no files', () => {
		const wrapper = createWrapper({ modelValue: '' });
		wrapper.vm.onSubmit();
		expect(wrapper.emitted('send')).toBeFalsy();
	});

	// --- Phase 2: 文件上传 ---
	test('file preview area renders when inputFiles is not empty', async () => {
		const wrapper = createWrapper();
		expect(wrapper.findAll('img')).toHaveLength(0);

		await wrapper.setData({
			inputFiles: [
				{ id: 'a', isImg: true, url: 'blob:img', name: 'photo.png', label: '1.2 KB' },
				{ id: 'b', isImg: false, url: null, name: 'doc.pdf', label: '3.4 MB' },
			],
		});

		// 图片缩略图
		expect(wrapper.findAll('img')).toHaveLength(1);
		expect(wrapper.find('img').attributes('src')).toBe('blob:img');
		// 非图片文件名
		expect(wrapper.text()).toContain('doc.pdf');
	});

	test('removeInputFile removes the correct file', async () => {
		const origRevoke = URL.revokeObjectURL;
		URL.revokeObjectURL = vi.fn();
		const wrapper = createWrapper();
		await wrapper.setData({
			inputFiles: [
				{ id: 'a', isImg: true, url: 'blob:a', name: 'a.png' },
				{ id: 'b', isImg: false, url: null, name: 'b.txt' },
			],
		});

		wrapper.vm.removeInputFile(0);
		expect(wrapper.vm.inputFiles).toHaveLength(1);
		expect(wrapper.vm.inputFiles[0].id).toBe('b');
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a');
		URL.revokeObjectURL = origRevoke;
	});

	test('removeFileById 按 id 移除正确的文件', async () => {
		const origRevoke = URL.revokeObjectURL;
		URL.revokeObjectURL = vi.fn();
		const wrapper = createWrapper();
		await wrapper.setData({
			inputFiles: [
				{ id: 'a', isImg: true, url: 'blob:a', name: 'a.png' },
				{ id: 'b', isImg: false, url: null, name: 'b.txt' },
			],
		});

		wrapper.vm.removeFileById('a');
		expect(wrapper.vm.inputFiles).toHaveLength(1);
		expect(wrapper.vm.inputFiles[0].id).toBe('b');
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a');
		URL.revokeObjectURL = origRevoke;
	});

	test('removeFileById 传入不存在的 id 时不报错', () => {
		const wrapper = createWrapper();
		wrapper.vm.inputFiles = [{ id: 'x', name: 'x.txt', url: null }];
		wrapper.vm.removeFileById('nonexistent');
		expect(wrapper.vm.inputFiles).toHaveLength(1);
	});

	test('file preview area hidden when inputFiles is empty', () => {
		const wrapper = createWrapper();
		// 无文件时不应有图片或文件卡片
		expect(wrapper.findAll('img')).toHaveLength(0);
	});

	// --- addFiles / 粘贴 / 拖拽入口 ---
	test('addFiles adds files to inputFiles via formatFileBlob', () => {
		const wrapper = createWrapper();
		const file1 = new File(['a'], 'a.txt', { type: 'text/plain' });
		const file2 = new File(['b'], 'b.png', { type: 'image/png' });
		wrapper.vm.addFiles([file1, file2]);
		expect(wrapper.vm.inputFiles).toHaveLength(2);
		expect(wrapper.vm.inputFiles[0].name).toBe('a.txt');
		expect(wrapper.vm.inputFiles[1].name).toBe('b.png');
	});

	test('addFiles ignores empty or null input', () => {
		const wrapper = createWrapper();
		wrapper.vm.addFiles([]);
		expect(wrapper.vm.inputFiles).toHaveLength(0);
		wrapper.vm.addFiles(null);
		expect(wrapper.vm.inputFiles).toHaveLength(0);
	});

	test('__onPaste extracts files from clipboardData and prevents default', () => {
		const wrapper = createWrapper();
		const file = new File(['x'], 'clip.png', { type: 'image/png' });
		const evt = {
			preventDefault: vi.fn(),
			clipboardData: {
				items: [
					{ kind: 'file', getAsFile: () => file },
				],
			},
		};
		wrapper.vm.__onPaste(evt);
		expect(evt.preventDefault).toHaveBeenCalled();
		expect(wrapper.vm.inputFiles).toHaveLength(1);
		expect(wrapper.vm.inputFiles[0].name).toBe('clip.png');
	});

	test('__onPaste does not prevent default when clipboard has no files', () => {
		const wrapper = createWrapper();
		const evt = {
			preventDefault: vi.fn(),
			clipboardData: {
				items: [
					{ kind: 'string', getAsFile: () => null },
				],
			},
		};
		wrapper.vm.__onPaste(evt);
		expect(evt.preventDefault).not.toHaveBeenCalled();
		expect(wrapper.vm.inputFiles).toHaveLength(0);
	});

	test('__onPaste handles empty clipboardData gracefully', () => {
		const wrapper = createWrapper();
		const evt = {
			preventDefault: vi.fn(),
			clipboardData: { items: [] },
		};
		wrapper.vm.__onPaste(evt);
		expect(evt.preventDefault).not.toHaveBeenCalled();
		expect(wrapper.vm.inputFiles).toHaveLength(0);
	});

	test('__onPaste handles null clipboardData gracefully', () => {
		const wrapper = createWrapper();
		const evt = { preventDefault: vi.fn(), clipboardData: null };
		wrapper.vm.__onPaste(evt);
		expect(evt.preventDefault).not.toHaveBeenCalled();
		expect(wrapper.vm.inputFiles).toHaveLength(0);
	});

	test('__onPaste with mixed text+file items only extracts files', () => {
		const wrapper = createWrapper();
		const file = new File(['img'], 'pic.png', { type: 'image/png' });
		const evt = {
			preventDefault: vi.fn(),
			clipboardData: {
				items: [
					{ kind: 'string', getAsFile: () => null },
					{ kind: 'file', getAsFile: () => file },
				],
			},
		};
		wrapper.vm.__onPaste(evt);
		expect(evt.preventDefault).toHaveBeenCalled();
		expect(wrapper.vm.inputFiles).toHaveLength(1);
		expect(wrapper.vm.inputFiles[0].name).toBe('pic.png');
	});

	test('addFiles rejects files exceeding MAX_UPLOAD_SIZE', () => {
		const wrapper = createWrapper();
		// MAX_UPLOAD_SIZE mocked to 1 MB
		const big = new File([new ArrayBuffer(1024 * 1024 + 1)], 'big.bin', { type: 'application/octet-stream' });
		const small = new File(['ok'], 'small.txt', { type: 'text/plain' });
		wrapper.vm.addFiles([big, small]);
		expect(wrapper.vm.inputFiles).toHaveLength(1);
		expect(wrapper.vm.inputFiles[0].name).toBe('small.txt');
		expect(mockNotify.error).toHaveBeenCalled();
	});

	test('onFilesSelected delegates to addFiles', () => {
		const wrapper = createWrapper();
		const file = new File(['x'], 'sel.txt', { type: 'text/plain' });
		const evt = { target: { files: [file], value: 'C:\\fake\\sel.txt' } };
		wrapper.vm.onFilesSelected(evt);
		expect(wrapper.vm.inputFiles).toHaveLength(1);
		expect(wrapper.vm.inputFiles[0].name).toBe('sel.txt');
		expect(evt.target.value).toBe('');
	});

	// --- fileUploadState 相关 ---
	test('__fileStatus 返回对应文件的上传状态', () => {
		const wrapper = createWrapper({
			fileUploadState: { f1: { status: 'uploading', progress: 0.5 } },
		});
		expect(wrapper.vm.__fileStatus('f1')).toBe('uploading');
		expect(wrapper.vm.__fileStatus('unknown')).toBeNull();
	});

	test('__fileProgress 返回 0~1 的小数', () => {
		const wrapper = createWrapper({
			fileUploadState: { f1: { status: 'uploading', progress: 0.734 } },
		});
		expect(wrapper.vm.__fileProgress('f1')).toBe(0.734);
		expect(wrapper.vm.__fileProgress('unknown')).toBe(0);
	});

	test('上传中的文件卡片显示进度覆层且隐藏移除按钮', async () => {
		const wrapper = createWrapper({
			fileUploadState: { a: { status: 'uploading', progress: 0.6 } },
		});
		await wrapper.setData({
			inputFiles: [{ id: 'a', isImg: false, name: 'a.txt', url: null, ext: 'txt', label: '1 KB' }],
		});
		// 进度覆层
		expect(wrapper.text()).toContain('60%');
		// 移除按钮不渲染（v-if="!__fileStatus(f.id)"）
		const removeBtn = wrapper.findAll('button').filter((b) => b.text().includes('i-lucide-x'));
		expect(removeBtn).toHaveLength(0);
	});

	test('restoreFiles 保留 remotePath 字段', () => {
		const wrapper = createWrapper();
		const blob = new Blob(['data']);
		wrapper.vm.restoreFiles([
			{ id: 'f1', name: 'a.txt', isImg: false, file: blob, remotePath: '/remote/a.txt' },
		]);
		expect(wrapper.vm.inputFiles).toHaveLength(1);
		expect(wrapper.vm.inputFiles[0].remotePath).toBe('/remote/a.txt');
	});

	test('clearInputFiles 释放所有 blob URL 并清空数组', () => {
		const origRevoke = URL.revokeObjectURL;
		URL.revokeObjectURL = vi.fn();
		const wrapper = createWrapper();
		wrapper.vm.inputFiles = [
			{ id: 'a', url: 'blob:a' },
			{ id: 'b', url: 'blob:b' },
		];
		wrapper.vm.clearInputFiles();
		expect(wrapper.vm.inputFiles).toHaveLength(0);
		expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
		URL.revokeObjectURL = origRevoke;
	});

	test('sending 时添加文件按钮仍可用（accepted 后允许准备下次消息附件）', () => {
		const wrapper = createWrapper({ sending: true, disabled: false });
		const attachBtn = wrapper.findAllComponents(UButtonStub).find(
			(c) => c.props('icon') === 'i-lucide-plus',
		);
		expect(attachBtn).toBeTruthy();
		expect(attachBtn.props('disabled')).toBe(false);
	});

	test('disabled=true（pre-accepted）时添加文件按钮 disabled', () => {
		const wrapper = createWrapper({ sending: true, disabled: true });
		const attachBtn = wrapper.findAllComponents(UButtonStub).find(
			(c) => c.props('icon') === 'i-lucide-plus',
		);
		expect(attachBtn).toBeTruthy();
		expect(attachBtn.props('disabled')).toBe(true);
	});
});
