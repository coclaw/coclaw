import { mount } from '@vue/test-utils';
import { describe, test, expect } from 'vitest';

import ProgressRing from './ProgressRing.vue';

function mountRing(props = {}) {
	return mount(ProgressRing, { props });
}

describe('ProgressRing', () => {
	// =================================================================
	// 几何参数(对齐 Quasar q-circular-progress)
	// =================================================================
	describe('几何参数', () => {
		test('默认 thickness 0.15 → viewBox ≈ 108.108, strokeWidth ≈ 8.108', () => {
			const w = mountRing({ value: 0.5 });
			const svg = w.find('svg');
			const vb = svg.element.getAttribute('viewBox');
			// 100 / (1 - 0.075) = 108.108108...
			expect(vb).toMatch(/^0 0 108\.10/);
			const strokeWidth = parseFloat(svg.find('circle').attributes('stroke-width'));
			// 0.075 * 108.108 ≈ 8.108
			expect(strokeWidth).toBeCloseTo(8.108, 2);
		});

		test('自定义 thickness=0.2 → viewBox ≈ 111.111, strokeWidth ≈ 11.111', () => {
			const w = mountRing({ value: 0.5, thickness: 0.2 });
			const svg = w.find('svg');
			expect(svg.element.getAttribute('viewBox')).toMatch(/^0 0 111\.1/);
			const sw = parseFloat(svg.find('circle').attributes('stroke-width'));
			expect(sw).toBeCloseTo(11.111, 2);
		});

		test('两个 circle 的 cx/cy 等于 viewBox 中心', () => {
			const w = mountRing({ value: 0.5 });
			const circles = w.findAll('circle');
			expect(circles).toHaveLength(2);
			const center = parseFloat(circles[0].attributes('cx'));
			const expected = 100 / (1 - 0.075) / 2;
			expect(center).toBeCloseTo(expected, 3);
			expect(parseFloat(circles[0].attributes('cy'))).toBeCloseTo(expected, 3);
			expect(parseFloat(circles[1].attributes('cx'))).toBeCloseTo(expected, 3);
		});

		test('radius 固定为 50', () => {
			const w = mountRing({ value: 0.5 });
			const circles = w.findAll('circle');
			expect(circles[0].attributes('r')).toBe('50');
			expect(circles[1].attributes('r')).toBe('50');
		});
	});

	// =================================================================
	// 进度数值与 dashOffset
	// =================================================================
	describe('进度', () => {
		const CIRC = 2 * Math.PI * 50; // 314.159...

		test('value=0 → dashOffset = 圆周长(完全未走)', () => {
			const w = mountRing({ value: 0 });
			const arc = w.findAll('circle')[1];
			expect(parseFloat(arc.attributes('stroke-dashoffset'))).toBeCloseTo(CIRC, 3);
		});

		test('value=1 → dashOffset = 0(已走完)', () => {
			const w = mountRing({ value: 1 });
			const arc = w.findAll('circle')[1];
			expect(parseFloat(arc.attributes('stroke-dashoffset'))).toBeCloseTo(0, 3);
		});

		test('value=0.5 → dashOffset = 圆周长一半', () => {
			const w = mountRing({ value: 0.5 });
			const arc = w.findAll('circle')[1];
			expect(parseFloat(arc.attributes('stroke-dashoffset'))).toBeCloseTo(CIRC * 0.5, 3);
		});

		test('value 越界 → clamp 到 [0,1]', () => {
			const w1 = mountRing({ value: -0.5 });
			expect(parseFloat(w1.findAll('circle')[1].attributes('stroke-dashoffset'))).toBeCloseTo(CIRC, 3);
			const w2 = mountRing({ value: 1.5 });
			expect(parseFloat(w2.findAll('circle')[1].attributes('stroke-dashoffset'))).toBeCloseTo(0, 3);
		});

		test('百分比四舍五入显示', () => {
			expect(mountRing({ value: 0.756 }).text()).toContain('76%');
			expect(mountRing({ value: 0.001 }).text()).toContain('0%');
			expect(mountRing({ value: 0.999 }).text()).toContain('100%');
		});
	});

	// =================================================================
	// 不确定态(indeterminate)
	// =================================================================
	describe('不确定态', () => {
		test('value=null → svg 有 animate-spin', () => {
			const w = mountRing({ value: null });
			expect(w.find('svg').classes()).toContain('animate-spin');
		});

		test('value 不传 → 同样为不确定态', () => {
			const w = mountRing();
			expect(w.find('svg').classes()).toContain('animate-spin');
			expect(w.text()).toBe(''); // 不显示百分比
		});

		test('value=NaN → 不确定态', () => {
			const w = mountRing({ value: Number.NaN });
			expect(w.find('svg').classes()).toContain('animate-spin');
		});

		test('不确定态 dashArray 是 "弧 间隔" 而非整圈', () => {
			const w = mountRing({ value: null });
			const arc = w.findAll('circle')[1];
			const da = arc.attributes('stroke-dasharray');
			expect(da).toMatch(/\s/); // 包含空格 → "a b" 形式
		});

		test('确定态有 transition class,不确定态无', () => {
			expect(mountRing({ value: 0.5 }).findAll('circle')[1].classes())
				.toContain('transition-[stroke-dashoffset]');
			expect(mountRing({ value: null }).findAll('circle')[1].classes())
				.not.toContain('transition-[stroke-dashoffset]');
		});

		test('不确定态不渲染百分比 span', () => {
			const w = mountRing({ value: null, showValue: true });
			expect(w.find('span').exists()).toBe(false);
		});
	});

	// =================================================================
	// showValue 开关
	// =================================================================
	describe('showValue', () => {
		test('showValue=true(默认)显示百分比', () => {
			expect(mountRing({ value: 0.5 }).find('span').exists()).toBe(true);
		});

		test('showValue=false 不显示百分比', () => {
			expect(mountRing({ value: 0.5, showValue: false }).find('span').exists()).toBe(false);
		});
	});

	// =================================================================
	// color 与 size
	// =================================================================
	describe('样式', () => {
		test('color=primary(默认) → stroke-primary + text-primary', () => {
			const w = mountRing({ value: 0.5 });
			expect(w.findAll('circle')[1].classes()).toContain('stroke-primary');
			expect(w.find('span').classes()).toContain('text-primary');
		});

		test('color=success → stroke-success + text-success', () => {
			const w = mountRing({ value: 0.5, color: 'success' });
			expect(w.findAll('circle')[1].classes()).toContain('stroke-success');
			expect(w.find('span').classes()).toContain('text-success');
		});

		test('轨道 circle 始终用 stroke-muted', () => {
			expect(mountRing({ value: 0.5 }).findAll('circle')[0].classes()).toContain('stroke-muted');
			expect(mountRing({ value: 0.5, color: 'error' }).findAll('circle')[0].classes()).toContain('stroke-muted');
		});

		test('size 通过 root 元素 inline style 应用', () => {
			const w = mountRing({ value: 0.5, size: 64 });
			const style = w.find('[role="progressbar"]').attributes('style');
			expect(style).toContain('width: 64px');
			expect(style).toContain('height: 64px');
		});

		test('百分比字号约为 size 的 30%(下限 10px)', () => {
			expect(mountRing({ value: 0.5, size: 100 }).find('span').attributes('style'))
				.toContain('font-size: 30px');
			// size 30 → 9 → 下限 10
			expect(mountRing({ value: 0.5, size: 30 }).find('span').attributes('style'))
				.toContain('font-size: 10px');
		});
	});

	// =================================================================
	// 无障碍
	// =================================================================
	describe('无障碍', () => {
		test('确定态:role/aria-* 完整', () => {
			const w = mountRing({ value: 0.42 });
			const root = w.find('[role="progressbar"]');
			expect(root.attributes('aria-valuenow')).toBe('42');
			expect(root.attributes('aria-valuemin')).toBe('0');
			expect(root.attributes('aria-valuemax')).toBe('100');
		});

		test('不确定态:省略 aria-valuenow/min/max', () => {
			const w = mountRing({ value: null });
			const root = w.find('[role="progressbar"]');
			expect(root.attributes('aria-valuenow')).toBeUndefined();
			expect(root.attributes('aria-valuemin')).toBeUndefined();
			expect(root.attributes('aria-valuemax')).toBeUndefined();
		});

		test('aria-label 默认 "Progress",可重载', () => {
			expect(mountRing({ value: 0.5 }).find('[role="progressbar"]').attributes('aria-label'))
				.toBe('Progress');
			expect(mountRing({ value: 0.5, ariaLabel: '上传中' }).find('[role="progressbar"]').attributes('aria-label'))
				.toBe('上传中');
		});
	});
});
