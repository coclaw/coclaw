import { mount } from '@vue/test-utils';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import TouchSpeakOverlay from './TouchSpeakOverlay.vue';

vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => ({
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock('../utils/media-helper.js', () => ({
	queryMicPerm: vi.fn().mockResolvedValue('granted'),
	getPrefAudioType: vi.fn().mockReturnValue('audio/webm'),
}));

// mock wavesurfer 动态导入
vi.mock('wavesurfer.js', () => ({
	default: {
		create: vi.fn(() => ({
			registerPlugin: vi.fn(() => ({
				startRecording: vi.fn().mockResolvedValue(undefined),
				stopRecording: vi.fn(),
				isRecording: vi.fn(() => false),
				destroy: vi.fn(),
				once: vi.fn(),
			})),
			destroy: vi.fn(),
		})),
	},
}));

vi.mock('wavesurfer.js/dist/plugins/record.esm.js', () => ({
	default: { create: vi.fn((opts) => opts) },
}));

const UIconStub = {
	props: ['name'],
	template: '<i />',
};

function createWrapper(props = {}) {
	return mount(TouchSpeakOverlay, {
		props: {
			open: true,
			initTouchId: 0,
			...props,
		},
		global: {
			stubs: {
				UIcon: UIconStub,
			},
			mocks: {
				$t: (key) => key,
			},
		},
	});
}

describe('TouchSpeakOverlay', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		globalThis.MediaRecorder = {
			isTypeSupported: vi.fn(() => true),
		};
	});

	test('renders when open is true', () => {
		const wrapper = createWrapper({ open: true });
		expect(wrapper.find('.fixed').exists()).toBe(true);
	});

	test('does not render when open is false', () => {
		const wrapper = createWrapper({ open: false });
		expect(wrapper.find('.fixed').exists()).toBe(false);
	});

	test('initial state: withinTouchZone is true', () => {
		const wrapper = createWrapper();
		expect(wrapper.vm.withinTouchZone).toBe(true);
	});

	test('initial state: touchId matches initTouchId', () => {
		const wrapper = createWrapper({ initTouchId: 5 });
		expect(wrapper.vm.touchId).toBe(5);
	});

	test('updateTouchPos calculates withinTouchZone correctly', async () => {
		const wrapper = createWrapper();
		await wrapper.vm.$nextTick();

		// 模拟 touchZone ref
		const mockEl = {
			getBoundingClientRect: () => ({
				left: 0, right: 375, top: 500, bottom: 600,
			}),
		};
		// 直接给组件内部 $refs 赋值
		Object.defineProperty(wrapper.vm.$refs, 'touchZone', { value: mockEl, configurable: true });

		// 在区域内
		wrapper.vm.updateTouchPos({ clientX: 100, clientY: 550 });
		expect(wrapper.vm.withinTouchZone).toBe(true);

		// 在区域外
		wrapper.vm.updateTouchPos({ clientX: 100, clientY: 400 });
		expect(wrapper.vm.withinTouchZone).toBe(false);
	});

	test('updateTouchPos calculates withinTouchPadding correctly', async () => {
		const wrapper = createWrapper();
		await wrapper.vm.$nextTick();

		const mockEl = {
			getBoundingClientRect: () => ({
				left: 0, right: 375, top: 500, bottom: 600,
			}),
		};
		Object.defineProperty(wrapper.vm.$refs, 'touchZone', { value: mockEl, configurable: true });

		// 在中心区域 - 非 padding
		wrapper.vm.updateTouchPos({ clientX: 100, clientY: 550 });
		expect(wrapper.vm.withinTouchPadding).toBe(false);

		// 在边缘 padding 区域（left edge, < 16px）
		wrapper.vm.updateTouchPos({ clientX: 5, clientY: 550 });
		expect(wrapper.vm.withinTouchPadding).toBe(true);

		// 在底部 padding 区域（> bottom - 16px）
		wrapper.vm.updateTouchPos({ clientX: 100, clientY: 595 });
		expect(wrapper.vm.withinTouchPadding).toBe(true);
	});

	test('findTouch returns matching touch by id', () => {
		const wrapper = createWrapper();
		const touchList = [
			{ identifier: 0, clientX: 10, clientY: 20 },
			{ identifier: 1, clientX: 30, clientY: 40 },
		];
		// TouchList 模拟为数组
		touchList.length = 2;
		expect(wrapper.vm.findTouch(touchList, 1).clientX).toBe(30);
		expect(wrapper.vm.findTouch(touchList, 5)).toBeNull();
	});

	test('emits close with null on closeAborted', () => {
		const wrapper = createWrapper();
		wrapper.vm.closeAborted();
		expect(wrapper.emitted('close')[0][0]).toBeNull();
		expect(wrapper.emitted('update:open')[0][0]).toBe(false);
	});
});
