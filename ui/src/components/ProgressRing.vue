<template>
	<div
		class="relative inline-flex items-center justify-center shrink-0"
		:style="rootStyle"
		role="progressbar"
		:aria-valuenow="indeterminate ? undefined : percent"
		:aria-valuemin="indeterminate ? undefined : 0"
		:aria-valuemax="indeterminate ? undefined : 100"
		:aria-label="ariaLabel"
	>
		<svg
			:viewBox="`0 0 ${viewBoxSize} ${viewBoxSize}`"
			class="size-full"
			:class="indeterminate ? 'animate-spin' : ''"
		>
			<!-- 轨道 -->
			<circle
				:cx="center" :cy="center" :r="radius"
				fill="none"
				:stroke-width="strokeWidth"
				:class="trackClass"
			/>
			<!-- 进度弧 -->
			<circle
				:cx="center" :cy="center" :r="radius"
				fill="none"
				:stroke-width="strokeWidth"
				stroke-linecap="round"
				:class="[strokeClass, indeterminate ? '' : 'transition-[stroke-dashoffset] duration-200']"
				:stroke-dasharray="dashArray"
				:stroke-dashoffset="dashOffset"
				:transform="`rotate(-90 ${center} ${center})`"
			/>
		</svg>
		<span
			v-if="showValue && !indeterminate"
			class="absolute font-medium leading-none"
			:class="textClass"
			:style="{ fontSize: valueFontSize }"
		>{{ percent }}%</span>
	</div>
</template>

<script>
// 语义色 → 静态 class map(让 Tailwind JIT 能扫描到完整类名)
const STROKE_CLASSES = {
	primary: 'stroke-primary',
	success: 'stroke-success',
	error: 'stroke-error',
	warning: 'stroke-warning',
	info: 'stroke-info',
	neutral: 'stroke-neutral',
};
const TEXT_CLASSES = {
	primary: 'text-primary',
	success: 'text-success',
	error: 'text-error',
	warning: 'text-warning',
	info: 'text-info',
	neutral: 'text-neutral',
};

export default {
	name: 'ProgressRing',
	props: {
		/** 进度值 0~1;null/undefined 为不确定进度(旋转态) */
		value: { type: Number, default: null },
		/** 直径(px) */
		size: { type: Number, default: 36 },
		/** 线条粗细比例,与 Quasar q-circular-progress thickness 一致 */
		thickness: { type: Number, default: 0.15 },
		/** 是否在中央显示百分比(确定态时有效) */
		showValue: { type: Boolean, default: true },
		/** 进度弧 / 文字的颜色,需是 Nuxt UI 语义色之一 */
		color: {
			type: String,
			default: 'primary',
			validator: (v) => Object.prototype.hasOwnProperty.call(STROKE_CLASSES, v),
		},
		/** 无障碍 label */
		ariaLabel: { type: String, default: 'Progress' },
	},
	computed: {
		indeterminate() {
			return this.value == null || Number.isNaN(this.value);
		},
		clampedValue() {
			if (this.indeterminate) return 0;
			return Math.min(1, Math.max(0, this.value));
		},
		percent() {
			return Math.round(this.clampedValue * 100);
		},
		radius() {
			return 50;
		},
		// Quasar 几何:viewBox = 100 / (1 - thickness/2),strokeWidth = (thickness/2) * viewBox
		viewBoxSize() {
			return 100 / (1 - this.thickness / 2);
		},
		center() {
			return this.viewBoxSize / 2;
		},
		strokeWidth() {
			return (this.thickness / 2) * this.viewBoxSize;
		},
		circumference() {
			return 2 * Math.PI * this.radius;
		},
		// 不定态显示 25% 弧长,整体旋转;确定态整圈 dashArray,用 offset 控制可见部分
		dashArray() {
			if (this.indeterminate) {
				const arc = this.circumference * 0.25;
				return `${arc} ${this.circumference - arc}`;
			}
			return this.circumference;
		},
		dashOffset() {
			if (this.indeterminate) return 0;
			return this.circumference * (1 - this.clampedValue);
		},
		strokeClass() {
			return STROKE_CLASSES[this.color] || STROKE_CLASSES.primary;
		},
		textClass() {
			return TEXT_CLASSES[this.color] || TEXT_CLASSES.primary;
		},
		trackClass() {
			return 'stroke-muted';
		},
		rootStyle() {
			return { width: `${this.size}px`, height: `${this.size}px` };
		},
		valueFontSize() {
			// 百分比字号约为直径的 30%
			return `${Math.max(10, Math.round(this.size * 0.3))}px`;
		},
	},
};
</script>
