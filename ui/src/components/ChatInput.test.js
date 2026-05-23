import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { reactive } from 'vue';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import ChatInput from './ChatInput.vue';

/**
 * 构造 mock chatStore：提供 reactive inputFiles + 5 个方法，模拟真实 chat.store actions。
 * addFiles 把传入的 file 包装对象 push 进 inputFiles，让模板能基于 inputFiles 渲染附件预览。
 */
function createMockChatStore() {
	const store = reactive({
		inputFiles: [],
		addFiles: vi.fn((files) => {
			for (const f of files) store.inputFiles.push(f);
		}),
		removeInputFile: vi.fn((idx) => {
			const removed = store.inputFiles.splice(idx, 1);
			if (removed[0]?.url) URL.revokeObjectURL(removed[0].url);
		}),
		removeFileById: vi.fn((id) => {
			const idx = store.inputFiles.findIndex((f) => f.id === id);
			if (idx === -1) return;
			const [removed] = store.inputFiles.splice(idx, 1);
			if (removed?.url) URL.revokeObjectURL(removed.url);
		}),
		clearInputFiles: vi.fn(() => {
			for (const f of store.inputFiles) {
				if (f.url) URL.revokeObjectURL(f.url);
			}
			store.inputFiles.length = 0;
		}),
		restoreFiles: vi.fn((files) => {
			for (const f of files) {
				const restored = { ...f };
				if (f.isImg && f.file) restored.url = URL.createObjectURL(f.file);
				store.inputFiles.push(restored);
			}
		}),
	});
	return store;
}

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
	props: ['icon', 'variant', 'color', 'size', 'disabled', 'loading', 'ui'],
	emits: ['click'],
	template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
};

const UIconStub = {
	props: ['name'],
	template: '<i />',
};

// 与 FileUploadItem/FileListItem 测试保持同一风格：用 data-value 暴露进度便于断言
const ProgressRingStub = {
	props: ['value', 'size'],
	template: '<div class="cc-progress-ring-stub" :data-value="value" />',
};

function createWrapper(props = {}) {
	// 用 'in' 判定是否显式传入 chatStore（含 null）：?? 会让显式 null 也被替换为 mock，
	// 让"chatStore=null 不崩"测试假阳性
	const chatStore = 'chatStore' in props ? props.chatStore : createMockChatStore();
	return mount(ChatInput, {
		props: {
			modelValue: '',
			sending: false,
			disabled: false,
			...props,
			chatStore,
		},
		global: {
			plugins: [createPinia()],
			stubs: {
				UTextarea: UTextareaStub,
				UButton: UButtonStub,
				UIcon: UIconStub,
				ProgressRing: ProgressRingStub,
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
		const chatStore = createMockChatStore();
		chatStore.inputFiles.push({ id: '1', name: 'test.txt', isImg: false });
		const wrapper = createWrapper({ modelValue: '', chatStore });
		expect(wrapper.vm.canSend).toBe(true);
	});

	test('canSend returns false when chatStore is null and no text', () => {
		const wrapper = createWrapper({ modelValue: '', chatStore: null });
		expect(wrapper.vm.canSend).toBe(false);
		// 仍可基于文本发送
	});

	test('canSend returns true when chatStore is null but text is non-empty', () => {
		const wrapper = createWrapper({ modelValue: 'hi', chatStore: null });
		expect(wrapper.vm.canSend).toBe(true);
	});

	test('middle wrapper uses flex to avoid inline-flex phantom line-box', () => {
		// 防回归：中间输入区父容器若退化为普通块级 div，UTextarea root 的 inline-flex
		// 会让浏览器按行盒规则给它留基线下方 leading（约 5px），导致 disabled 状态下
		// 输入框比左右 40px 按钮高一截，items-end 底端对齐后顶端错位。
		const wrapper = createWrapper({ modelValue: '' });
		const middle = wrapper.find('form > div.flex-1');
		expect(middle.exists()).toBe(true);
		expect(middle.classes()).toContain('flex');
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

	test('cancelling=false: stop button uses square icon + chat.stopSending title (default)', () => {
		const wrapper = createWrapper({ sending: true });
		const stopBtnStub = wrapper.findAllComponents(UButtonStub)
			.find((b) => b.attributes('title') === 'chat.stopSending');
		expect(stopBtnStub).toBeTruthy();
		expect(stopBtnStub.props('icon')).toBe('i-lucide-square');
		expect(stopBtnStub.props('ui')).toBeUndefined();
	});

	test('cancelling=true: stop button swaps to spinner + chat.cancelling title', () => {
		const wrapper = createWrapper({ sending: true, cancelling: true, cancelDisabled: true });
		const stopBtnStub = wrapper.findAllComponents(UButtonStub)
			.find((b) => b.attributes('title') === 'chat.cancelling');
		expect(stopBtnStub).toBeTruthy();
		expect(stopBtnStub.props('icon')).toBe('i-lucide-loader-circle');
		expect(stopBtnStub.props('ui')).toEqual({ leadingIcon: 'animate-spin' });
		// 仍然禁用，防止重复触发
		expect(stopBtnStub.props('disabled')).toBe(true);
	});

	test('submit 后 inputFiles 保留（由上传过程逐个移除）', () => {
		const chatStore = createMockChatStore();
		chatStore.inputFiles.push({ id: '1', name: 'a.txt', isImg: false, url: null });
		const wrapper = createWrapper({ modelValue: 'hi', chatStore });
		wrapper.vm.onSubmit();
		expect(chatStore.inputFiles).toHaveLength(1);
	});

	test('does not send when text is empty and no files', () => {
		const wrapper = createWrapper({ modelValue: '' });
		wrapper.vm.onSubmit();
		expect(wrapper.emitted('send')).toBeFalsy();
	});

	// --- Phase 2: 文件上传 ---
	test('file preview area renders when inputFiles is not empty', async () => {
		const chatStore = createMockChatStore();
		const wrapper = createWrapper({ chatStore });
		expect(wrapper.findAll('img')).toHaveLength(0);

		chatStore.inputFiles.push(
			{ id: 'a', isImg: true, url: 'blob:img', name: 'photo.png', label: '1.2 KB' },
			{ id: 'b', isImg: false, url: null, name: 'doc.pdf', label: '3.4 MB' },
		);
		await wrapper.vm.$nextTick();

		// 图片缩略图
		expect(wrapper.findAll('img')).toHaveLength(1);
		expect(wrapper.find('img').attributes('src')).toBe('blob:img');
		// 非图片文件名
		expect(wrapper.text()).toContain('doc.pdf');
	});

	test('removeInputFile 委托到 chatStore 并 revoke 对应 ObjectURL', async () => {
		const origRevoke = URL.revokeObjectURL;
		URL.revokeObjectURL = vi.fn();
		const chatStore = createMockChatStore();
		chatStore.inputFiles.push(
			{ id: 'a', isImg: true, url: 'blob:a', name: 'a.png' },
			{ id: 'b', isImg: false, url: null, name: 'b.txt' },
		);
		const wrapper = createWrapper({ chatStore });

		wrapper.vm.removeInputFile(0);
		expect(chatStore.removeInputFile).toHaveBeenCalledWith(0);
		expect(chatStore.inputFiles).toHaveLength(1);
		expect(chatStore.inputFiles[0].id).toBe('b');
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:a');
		URL.revokeObjectURL = origRevoke;
	});

	test('removeInputFile 在 chatStore 为 null 时不抛错', () => {
		const wrapper = createWrapper({ chatStore: null });
		expect(() => wrapper.vm.removeInputFile(0)).not.toThrow();
	});

	test('file preview area hidden when inputFiles is empty', () => {
		const wrapper = createWrapper();
		// 无文件时不应有图片或文件卡片
		expect(wrapper.findAll('img')).toHaveLength(0);
	});

	// --- addFiles / 粘贴 / 拖拽入口 ---
	test('addFiles 调用 chatStore.addFiles 并经 formatFileBlob 包装', () => {
		const chatStore = createMockChatStore();
		const wrapper = createWrapper({ chatStore });
		const file1 = new File(['a'], 'a.txt', { type: 'text/plain' });
		const file2 = new File(['b'], 'b.png', { type: 'image/png' });
		wrapper.vm.addFiles([file1, file2]);
		expect(chatStore.addFiles).toHaveBeenCalledOnce();
		expect(chatStore.inputFiles).toHaveLength(2);
		expect(chatStore.inputFiles[0].name).toBe('a.txt');
		expect(chatStore.inputFiles[1].name).toBe('b.png');
	});

	test('addFiles 在 chatStore 为 null 时静默 no-op', () => {
		const wrapper = createWrapper({ chatStore: null });
		const file = new File(['x'], 'x.txt', { type: 'text/plain' });
		expect(() => wrapper.vm.addFiles([file])).not.toThrow();
	});

	test('addFiles ignores empty or null input', () => {
		const chatStore = createMockChatStore();
		const wrapper = createWrapper({ chatStore });
		wrapper.vm.addFiles([]);
		expect(chatStore.inputFiles).toHaveLength(0);
		wrapper.vm.addFiles(null);
		expect(chatStore.inputFiles).toHaveLength(0);
		expect(chatStore.addFiles).not.toHaveBeenCalled();
	});

	test('__onPaste extracts files from clipboardData and prevents default', () => {
		const chatStore = createMockChatStore();
		const wrapper = createWrapper({ chatStore });
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
		expect(chatStore.inputFiles).toHaveLength(1);
		expect(chatStore.inputFiles[0].name).toBe('clip.png');
	});

	test('__onPaste does not prevent default when clipboard has no files', () => {
		const chatStore = createMockChatStore();
		const wrapper = createWrapper({ chatStore });
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
		expect(chatStore.inputFiles).toHaveLength(0);
	});

	test('__onPaste handles empty clipboardData gracefully', () => {
		const chatStore = createMockChatStore();
		const wrapper = createWrapper({ chatStore });
		const evt = {
			preventDefault: vi.fn(),
			clipboardData: { items: [] },
		};
		wrapper.vm.__onPaste(evt);
		expect(evt.preventDefault).not.toHaveBeenCalled();
		expect(chatStore.inputFiles).toHaveLength(0);
	});

	test('__onPaste handles null clipboardData gracefully', () => {
		const chatStore = createMockChatStore();
		const wrapper = createWrapper({ chatStore });
		const evt = { preventDefault: vi.fn(), clipboardData: null };
		wrapper.vm.__onPaste(evt);
		expect(evt.preventDefault).not.toHaveBeenCalled();
		expect(chatStore.inputFiles).toHaveLength(0);
	});

	test('__onPaste with mixed text+file items only extracts files', () => {
		const chatStore = createMockChatStore();
		const wrapper = createWrapper({ chatStore });
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
		expect(chatStore.inputFiles).toHaveLength(1);
		expect(chatStore.inputFiles[0].name).toBe('pic.png');
	});

	test('addFiles rejects files exceeding MAX_UPLOAD_SIZE', () => {
		const chatStore = createMockChatStore();
		const wrapper = createWrapper({ chatStore });
		// MAX_UPLOAD_SIZE mocked to 1 MB
		const big = new File([new ArrayBuffer(1024 * 1024 + 1)], 'big.bin', { type: 'application/octet-stream' });
		const small = new File(['ok'], 'small.txt', { type: 'text/plain' });
		wrapper.vm.addFiles([big, small]);
		expect(chatStore.inputFiles).toHaveLength(1);
		expect(chatStore.inputFiles[0].name).toBe('small.txt');
		expect(mockNotify.error).toHaveBeenCalled();
	});

	test('onFilesSelected delegates to addFiles', () => {
		const chatStore = createMockChatStore();
		const wrapper = createWrapper({ chatStore });
		const file = new File(['x'], 'sel.txt', { type: 'text/plain' });
		const evt = { target: { files: [file], value: 'C:\\fake\\sel.txt' } };
		wrapper.vm.onFilesSelected(evt);
		expect(chatStore.inputFiles).toHaveLength(1);
		expect(chatStore.inputFiles[0].name).toBe('sel.txt');
		expect(evt.target.value).toBe('');
	});

	test('procRecordedVoice 通过 chatStore.addFiles 写入 voice 附件', () => {
		const chatStore = createMockChatStore();
		const wrapper = createWrapper({ chatStore });
		const blob = new Blob(['voice'], { type: 'audio/webm' });
		wrapper.vm.procRecordedVoice(blob, 3000);
		expect(chatStore.addFiles).toHaveBeenCalledOnce();
		expect(chatStore.inputFiles).toHaveLength(1);
		expect(chatStore.inputFiles[0].isVoice).toBe(true);
		expect(chatStore.inputFiles[0].durationMs).toBe(3000);
		expect(wrapper.vm.recorderStatus).toBe('IDLE');
	});

	test('procRecordedVoice 在 chatStore 为 null 时静默 no-op（不抛、不通知）', () => {
		const wrapper = createWrapper({ chatStore: null });
		const blob = new Blob(['voice'], { type: 'audio/webm' });
		expect(() => wrapper.vm.procRecordedVoice(blob, 3000)).not.toThrow();
		// 状态仍复位、不触发 notify
		expect(wrapper.vm.recorderStatus).toBe('IDLE');
		expect(mockNotify.error).not.toHaveBeenCalled();
	});

	test('beforeUnmount 不调 chatStore.clearInputFiles（附件归 store 所有）', () => {
		const chatStore = createMockChatStore();
		chatStore.inputFiles.push({ id: 'a', name: 'a.txt', url: null });
		const wrapper = createWrapper({ chatStore });
		wrapper.unmount();
		expect(chatStore.clearInputFiles).not.toHaveBeenCalled();
		// 附件仍然保留在 store 中
		expect(chatStore.inputFiles).toHaveLength(1);
	});

	test('同一 chatStore 切走再切回（unmount + 重 mount）后附件仍可见', async () => {
		const chatStore = createMockChatStore();
		chatStore.inputFiles.push(
			{ id: 'a', isImg: true, url: 'blob:a', name: 'a.png', label: '1 KB' },
			{ id: 'b', isImg: false, url: null, name: 'b.txt', ext: 'txt', label: '1 KB' },
		);
		const w1 = createWrapper({ chatStore });
		await w1.vm.$nextTick();
		expect(w1.findAll('img')).toHaveLength(1);
		expect(w1.text()).toContain('b.txt');
		w1.unmount();
		// store 持续存活，inputFiles 没被清
		expect(chatStore.inputFiles).toHaveLength(2);
		// 用同一 store 再 mount —— 模拟用户切到 /topics 又切回
		const w2 = createWrapper({ chatStore });
		await w2.vm.$nextTick();
		expect(w2.vm.inputFiles).toHaveLength(2);
		expect(w2.findAll('img')).toHaveLength(1);
		expect(w2.text()).toContain('b.txt');
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

	test('__fileProgress 在键存在但缺 progress 字段时返回 0', () => {
		// 防回归：上游 state 形态曾出现"刚 register 还没收到进度回调"窗口（仅有 status）
		// `?? 0` 兜底必须挡住这种缺字段情况
		const wrapper = createWrapper({
			fileUploadState: { f1: { status: 'uploading' } },
		});
		expect(wrapper.vm.__fileProgress('f1')).toBe(0);
	});

	test('上传中的文件卡片显示进度覆层且隐藏移除按钮', async () => {
		const chatStore = createMockChatStore();
		chatStore.inputFiles.push({ id: 'a', isImg: false, name: 'a.txt', url: null, ext: 'txt', label: '1 KB' });
		const wrapper = createWrapper({
			chatStore,
			fileUploadState: { a: { status: 'uploading', progress: 0.6 } },
		});
		await wrapper.vm.$nextTick();
		// 进度覆层：使用 ProgressRingStub 暴露的 data-value 精确断言
		const ring = wrapper.find('.cc-progress-ring-stub');
		expect(ring.exists()).toBe(true);
		expect(ring.attributes('data-value')).toBe('0.6');
		// 移除按钮不渲染（v-if="!__fileStatus(f.id)"）
		const removeBtn = wrapper.findAll('button').filter((b) => b.text().includes('i-lucide-x'));
		expect(removeBtn).toHaveLength(0);
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

	test('触屏语音模式：accepted 后（sending=true, disabled=false）onTouchSpeakStart 仍可触发', () => {
		mockEnv = { ...defaultEnv, isNative: true };
		const wrapper = createWrapper({ sending: true, disabled: false });
		wrapper.vm.inputMode = 'voice';
		wrapper.vm.onTouchSpeakStart({ changedTouches: [{ identifier: 1 }] });
		expect(wrapper.vm.touchSpeakOpen).toBe(true);
	});

	test('触屏语音模式：pre-accepted (disabled=true) 时 onTouchSpeakStart 拒绝', () => {
		mockEnv = { ...defaultEnv, isNative: true };
		const wrapper = createWrapper({ sending: true, disabled: true });
		wrapper.vm.inputMode = 'voice';
		wrapper.vm.onTouchSpeakStart({ changedTouches: [{ identifier: 1 }] });
		expect(wrapper.vm.touchSpeakOpen).toBe(false);
	});

	// 桌面麦克风按钮 gating：需与 textarea / btn-attach 等其它输入控件同步受 disabled 控制
	test('桌面麦克风：disabled=false 时按钮启用', () => {
		mockEnv = { ...defaultEnv };
		const wrapper = createWrapper({ disabled: false });
		const micBtn = wrapper.findAllComponents(UButtonStub).find(
			(c) => c.props('icon') === 'i-lucide-mic',
		);
		expect(micBtn).toBeTruthy();
		expect(micBtn.props('disabled')).toBe(false);
	});

	test('桌面麦克风：disabled=true 时按钮禁用', () => {
		mockEnv = { ...defaultEnv };
		const wrapper = createWrapper({ disabled: true });
		const micBtn = wrapper.findAllComponents(UButtonStub).find(
			(c) => c.props('icon') === 'i-lucide-mic',
		);
		expect(micBtn).toBeTruthy();
		expect(micBtn.props('disabled')).toBe(true);
	});

	test('桌面麦克风：disabled=true 时 onStartDesktopRecording 不启动录音', async () => {
		mockEnv = { ...defaultEnv };
		const wrapper = createWrapper({ disabled: true });
		await wrapper.vm.onStartDesktopRecording();
		// 状态应保持 IDLE，不创建 recorder
		expect(wrapper.vm.recorderStatus).toBe('IDLE');
		expect(wrapper.vm.voiceRecorder).toBeNull();
	});
});
