import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import ChatInput from './ChatInput.vue';

vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => ({
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		error: vi.fn(),
	}),
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
		// 模拟桌面宽度
		Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });
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

	test('Enter on mobile does not trigger send', async () => {
		// 设置移动端宽度
		Object.defineProperty(window, 'innerWidth', { value: 375, writable: true });
		const pinia = createPinia();
		setActivePinia(pinia);

		const wrapper = mount(ChatInput, {
			props: { modelValue: 'hello', sending: false, disabled: false },
			global: {
				plugins: [pinia],
				stubs: {
					UTextarea: UTextareaStub,
					UButton: UButtonStub,
					UIcon: UIconStub,
					TouchSpeakOverlay: true,
				},
				mocks: { $t: (key) => key },
			},
		});

		const textarea = wrapper.find('textarea');
		if (textarea.exists()) {
			await textarea.trigger('keydown', { key: 'Enter', shiftKey: false });
			expect(wrapper.emitted('send')).toBeFalsy();
		}
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

	test('submit clears inputFiles after send', () => {
		const wrapper = createWrapper({ modelValue: 'hi' });
		wrapper.vm.inputFiles = [{ id: '1', name: 'a.txt', isImg: false, url: null }];
		wrapper.vm.onSubmit();
		expect(wrapper.vm.inputFiles).toHaveLength(0);
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

	test('file preview area hidden when inputFiles is empty', () => {
		const wrapper = createWrapper();
		// 无文件时不应有图片或文件卡片
		expect(wrapper.findAll('img')).toHaveLength(0);
	});
});
