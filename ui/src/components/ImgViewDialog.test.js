import { mount } from '@vue/test-utils';
import { describe, expect, test, vi } from 'vitest';

// ── mock 依赖（照搬 ChatImg.test.js 已跑通的方式）──

vi.mock('../utils/dialog-history.js', () => ({
	popDialogState: vi.fn(),
}));

vi.mock('../utils/file-helper.js', () => ({
	saveBlobToFile: vi.fn(),
}));

vi.mock('../utils/platform.js', () => ({
	get isCapacitorApp() { return false; },
}));

vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => ({ success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));

import ImgViewDialog from './ImgViewDialog.vue';

// open=true 时把 body slot 渲染出来，否则 wrapper 看不到 <img>（照搬 WebAgentPickerDialog.test.js）
const UModalStub = {
	props: ['open', 'ui', 'description'],
	emits: ['update:open', 'after:leave'],
	template: '<div class="u-modal-stub"><slot name="body" /></div>',
};

const UButtonStub = {
	props: ['icon', 'variant', 'color', 'size', 'ui'],
	emits: ['click'],
	template: '<button @click="$emit(\'click\')" />',
};

function mountDialog(props = {}) {
	return mount(ImgViewDialog, {
		props: { open: true, src: 'https://example.com/a.png', ...props },
		global: {
			stubs: { UModal: UModalStub, UButton: UButtonStub },
			mocks: { $t: (k) => k },
		},
	});
}

// 封顶值：随窗口可用高度（扣掉 Electron 叠加标题栏高度）封顶，短窗口下不再触发内层滚动。
const EXPECTED_MAX_HEIGHT = 'min(85vh, calc(100vh - var(--cc-titlebar-h, 0px) - 4rem))';

describe('ImgViewDialog', () => {
	test('img 用 inline style 把高度封顶到可用区域（锁死防回归）', () => {
		const wrapper = mountDialog();
		const img = wrapper.find('img');
		expect(img.exists()).toBe(true);
		// 锁死封顶表达式：cap 值一旦被改动即触发回归
		expect(img.attributes('style')).toContain(`max-height: ${EXPECTED_MAX_HEIGHT}`);
	});

	test('img 不再用 Tailwind 的 max-h-[85vh] 类封顶', () => {
		const wrapper = mountDialog();
		const cls = wrapper.find('img').attributes('class') || '';
		expect(cls).not.toContain('max-h-[85vh]');
		// 仍保留宽度上限与 object-contain
		expect(cls).toContain('max-w-[90vw]');
		expect(cls).toContain('object-contain');
	});
});
