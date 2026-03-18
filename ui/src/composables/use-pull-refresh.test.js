import { describe, test, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import { usePullRefresh, usePullRefreshSuppress } from './use-pull-refresh.js';

/**
 * 在 el 上触发 touchstart → touchmove → touchend
 * jsdom 不完整支持 TouchEvent，手动 patch touches
 */
function simulatePull(el, startY, endY) {
	const start = new Event('touchstart', { bubbles: true });
	start.touches = [{ clientY: startY }];
	el.dispatchEvent(start);

	const move = new Event('touchmove', { bubbles: true });
	move.touches = [{ clientY: endY }];
	el.dispatchEvent(move);

	el.dispatchEvent(new Event('touchend', { bubbles: true }));
}

/** 仅 touchstart + touchmove（不松手） */
function simulatePullHold(el, startY, endY) {
	const start = new Event('touchstart', { bubbles: true });
	start.touches = [{ clientY: startY }];
	el.dispatchEvent(start);

	const move = new Event('touchmove', { bubbles: true });
	move.touches = [{ clientY: endY }];
	el.dispatchEvent(move);
}

function createWrapper(onRefresh) {
	return mount(defineComponent({
		setup() {
			const containerRef = ref(null);
			const result = usePullRefresh(containerRef, { onRefresh });
			return { containerRef, ...result };
		},
		template: '<div ref="containerRef" style="overflow-y:auto"><span>content</span></div>',
	}));
}

describe('usePullRefresh', () => {
	test('短距离下拉不触发刷新', () => {
		const onRefresh = vi.fn();
		const wrapper = createWrapper(onRefresh);

		// 下拉 30px（视觉约 13.5px，远未到阈值 60px）
		simulatePull(wrapper.element, 100, 130);
		expect(onRefresh).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	test('超过阈值的下拉触发刷新', () => {
		const onRefresh = vi.fn();
		const wrapper = createWrapper(onRefresh);

		// 下拉 200px（视觉约 90px，超过 60px 阈值）
		simulatePull(wrapper.element, 100, 300);
		expect(onRefresh).toHaveBeenCalledOnce();
		wrapper.unmount();
	});

	test('向上滑动不触发', () => {
		const onRefresh = vi.fn();
		const wrapper = createWrapper(onRefresh);

		simulatePull(wrapper.element, 200, 100);
		expect(onRefresh).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	test('下拉过程中状态正确反映', () => {
		const wrapper = createWrapper(vi.fn());

		simulatePullHold(wrapper.element, 100, 250);
		expect(wrapper.vm.pulling).toBe(true);
		expect(wrapper.vm.pastThreshold).toBe(true);
		expect(wrapper.vm.pullDistance).toBeGreaterThan(0);

		wrapper.element.dispatchEvent(new Event('touchend', { bubbles: true }));
		wrapper.unmount();
	});

	test('未过阈值松手后 pullDistance 归零', async () => {
		const wrapper = createWrapper(vi.fn());

		simulatePull(wrapper.element, 100, 120);
		expect(wrapper.vm.pullDistance).toBe(0);

		// pulling 在 setTimeout(200ms) 后归 false
		await vi.waitFor(() => {
			expect(wrapper.vm.pulling).toBe(false);
		}, { timeout: 500 });
		wrapper.unmount();
	});

	test('组件卸载后不再响应触摸事件', () => {
		const onRefresh = vi.fn();
		const wrapper = createWrapper(onRefresh);
		const el = wrapper.element;

		wrapper.unmount();

		simulatePull(el, 100, 300);
		expect(onRefresh).not.toHaveBeenCalled();
	});

	test('suppress 激活时下拉不触发刷新', () => {
		const onRefresh = vi.fn();
		const wrapper = createWrapper(onRefresh);
		const { suppress, unsuppress } = usePullRefreshSuppress();

		suppress();
		simulatePull(wrapper.element, 100, 300);
		expect(onRefresh).not.toHaveBeenCalled();

		// 解除后恢复
		unsuppress();
		simulatePull(wrapper.element, 100, 300);
		expect(onRefresh).toHaveBeenCalledOnce();

		wrapper.unmount();
	});
});
