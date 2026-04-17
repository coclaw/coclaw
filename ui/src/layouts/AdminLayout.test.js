import { mount } from '@vue/test-utils';
import { beforeEach, test, expect, vi } from 'vitest';

const mockStartStream = vi.fn();
const mockStopStream = vi.fn();

vi.mock('../stores/admin.store.js', () => ({
	useAdminStore: () => ({
		startStream: mockStartStream,
		stopStream: mockStopStream,
	}),
}));

import AdminLayout from './AdminLayout.vue';

function mountLayout() {
	return mount(AdminLayout, {
		global: {
			stubs: {
				RouterView: { template: '<div class="router-view-stub" />' },
			},
		},
	});
}

beforeEach(() => {
	mockStartStream.mockReset();
	mockStopStream.mockReset();
});

test('mounted 调 store.startStream', () => {
	mountLayout();
	expect(mockStartStream).toHaveBeenCalledTimes(1);
	expect(mockStopStream).not.toHaveBeenCalled();
});

test('unmount 调 store.stopStream', () => {
	const wrapper = mountLayout();
	wrapper.unmount();
	expect(mockStopStream).toHaveBeenCalledTimes(1);
});

test('模板只渲染 router-view', () => {
	const wrapper = mountLayout();
	expect(wrapper.find('.router-view-stub').exists()).toBe(true);
});
