import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const popDialogStateMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/dialog-history.js', () => ({
	popDialogState: popDialogStateMock,
}));

// Panel 子组件 stub，避免它的 mounted 触发真实 loadAll
vi.mock('./WebAgentPickerPanel.vue', () => ({
	default: {
		name: 'WebAgentPickerPanel',
		emits: ['selected'],
		template: '<div class="panel-stub" />',
	},
}));

// 用一个可写的 screen 对象替换 env store，便于切换 ltMd
const envState = vi.hoisted(() => ({ screen: { ltMd: false } }));
vi.mock('../../stores/env.store.js', () => ({
	useEnvStore: () => envState,
}));

import WebAgentPickerDialog from './WebAgentPickerDialog.vue';

const UModalStub = {
	props: ['open', 'fullscreen', 'ui', 'title', 'description'],
	emits: ['update:open', 'after:leave'],
	template: `<div
		class="u-modal-stub"
		:data-fullscreen="String(fullscreen)"
		:data-ui-body="ui?.body ?? ''"
		:data-ui-header="ui?.header ?? ''"
		:data-title="title"
		:data-description="description"
	>
		<slot name="body" />
	</div>`,
};

function mountDialog({ ltMd = false, open = false } = {}) {
	envState.screen.ltMd = ltMd;
	setActivePinia(createPinia());
	return mount(WebAgentPickerDialog, {
		props: { open },
		global: {
			stubs: { UModal: UModalStub },
			mocks: { $t: (k) => k },
		},
	});
}

describe('WebAgentPickerDialog', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('ltMd=true 时 fullscreen=true，body 上紧 pt-3、下留 pb-4 并双断点同步带 safe-area-inset-bottom 兜底', () => {
		const wrapper = mountDialog({ ltMd: true });
		const modal = wrapper.find('.u-modal-stub');
		expect(modal.attributes('data-fullscreen')).toBe('true');
		const body = modal.attributes('data-ui-body');
		expect(body).toContain('pt-3');
		expect(body).toContain('sm:pt-3');
		// pb 地板值 1rem (= pb-4)，含 home indicator 设备时撑到 safe-area；必须双断点写以避开 sm:p-6 的覆盖
		expect(body).toContain('pb-[max(1rem,var(--safe-area-inset-bottom))]');
		expect(body).toContain('sm:pb-[max(1rem,var(--safe-area-inset-bottom))]');
		expect(modal.attributes('data-ui-header')).toContain('var(--safe-area-inset-top)');
	});

	test('桌面端 (ltMd=false) fullscreen=false，body 上紧 pt-3、下留 pb-4，不再带 safe-area', () => {
		const wrapper = mountDialog({ ltMd: false });
		const modal = wrapper.find('.u-modal-stub');
		expect(modal.attributes('data-fullscreen')).toBe('false');
		const body = modal.attributes('data-ui-body');
		expect(body).toContain('pt-3');
		expect(body).toContain('sm:pt-3');
		expect(body).toContain('pb-4');
		expect(body).toContain('sm:pb-4');
		expect(body).not.toContain('safe-area-inset');
		expect(modal.attributes('data-ui-header')).toBe('');
	});

	test('open 从 true → false 时调用 popDialogState', async () => {
		const wrapper = mountDialog({ open: true });
		expect(popDialogStateMock).not.toHaveBeenCalled();

		await wrapper.setProps({ open: false });
		expect(popDialogStateMock).toHaveBeenCalledTimes(1);
	});

	test('open false → true 不触发 popDialogState', async () => {
		const wrapper = mountDialog({ open: false });
		await wrapper.setProps({ open: true });
		expect(popDialogStateMock).not.toHaveBeenCalled();
	});

	test('Panel 触发 selected 事件时关闭 dialog (emit update:open=false)', async () => {
		const wrapper = mountDialog({ open: true });
		const panel = wrapper.findComponent({ name: 'WebAgentPickerPanel' });
		panel.vm.$emit('selected');
		await wrapper.vm.$nextTick();
		const events = wrapper.emitted('update:open');
		expect(events).toBeTruthy();
		expect(events[events.length - 1]).toEqual([false]);
	});

	test('Dialog 透传 title 与 description=" "（Nuxt UI 必填位避免无障碍警告）', () => {
		const wrapper = mountDialog({ open: true });
		const modal = wrapper.find('.u-modal-stub');
		expect(modal.attributes('data-title')).toBe('webAgents.title');
		expect(modal.attributes('data-description')).toBe(' ');
	});

	test('UModal 触发 after:leave 时 Dialog 透传给外部（用于动画/焦点收尾）', async () => {
		const wrapper = mountDialog({ open: true });
		const modal = wrapper.findComponent(UModalStub);
		modal.vm.$emit('after:leave');
		await wrapper.vm.$nextTick();
		expect(wrapper.emitted('after:leave')).toBeTruthy();
		expect(wrapper.emitted('after:leave')).toHaveLength(1);
	});

	test('UModal 触发 update:open 时透传到外部', async () => {
		const wrapper = mountDialog({ open: true });
		const modal = wrapper.findComponent(UModalStub);
		modal.vm.$emit('update:open', false);
		await wrapper.vm.$nextTick();
		expect(wrapper.emitted('update:open')).toBeTruthy();
		expect(wrapper.emitted('update:open')[0]).toEqual([false]);
	});
});
