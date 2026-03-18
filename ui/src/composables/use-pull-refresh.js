/**
 * 下拉刷新 composable
 * - 仅触屏生效（touchstart/touchmove/touchend）
 * - 自动检测最近的可滚动祖先是否在顶部
 * - 带阻尼效果的视觉距离
 */
import { ref, shallowRef, onMounted, onBeforeUnmount } from 'vue';

/** 触发刷新的视觉距离阈值（px） */
const THRESHOLD = 60;
/** 视觉距离上限 */
const MAX_PULL = 100;
/** 阻尼系数（原始距离 → 视觉距离） */
const RESISTANCE = 0.45;

/**
 * 从触摸目标向上查找最近的可滚动祖先，判断其是否在顶部
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function isScrolledToTop(el) {
	let node = el;
	while (node && node !== document.documentElement) {
		const { overflowY } = getComputedStyle(node);
		if (overflowY === 'auto' || overflowY === 'scroll') {
			return node.scrollTop <= 0;
		}
		node = node.parentElement;
	}
	return window.scrollY <= 0;
}

/**
 * 全局 suppress 标志——活跃时下拉手势不触发刷新
 * 用于 ChatPage 等需要接管顶部下拉行为的页面
 */
const suppressRef = shallowRef(false);

/**
 * 注册/注销 pull-to-refresh 抑制
 * @returns {{ suppress: () => void, unsuppress: () => void }}
 */
export function usePullRefreshSuppress() {
	return {
		suppress() { suppressRef.value = true; },
		unsuppress() { suppressRef.value = false; },
	};
}

/**
 * @param {import('vue').Ref<HTMLElement>} containerRef - 挂载触摸事件的容器
 * @param {object} [opts]
 * @param {() => void} [opts.onRefresh] - 触发刷新回调，默认 window.location.reload()
 * @returns {{ pulling: import('vue').Ref<boolean>, pullDistance: import('vue').Ref<number>, pastThreshold: import('vue').Ref<boolean> }}
 */
export function usePullRefresh(containerRef, opts = {}) {
	const pulling = ref(false);
	const pullDistance = ref(0);
	const pastThreshold = ref(false);

	let startY = 0;
	let tracking = false;

	function onTouchStart(e) {
		if (suppressRef.value) return;
		if (isScrolledToTop(e.target)) {
			tracking = true;
			startY = e.touches[0].clientY;
		}
	}

	function onTouchMove(e) {
		if (!tracking) return;
		const rawDist = e.touches[0].clientY - startY;
		if (rawDist > 0) {
			pulling.value = true;
			pullDistance.value = Math.min(rawDist * RESISTANCE, MAX_PULL);
			pastThreshold.value = pullDistance.value >= THRESHOLD;
		}
		else {
			// 向上滑 → 取消下拉
			pulling.value = false;
			pullDistance.value = 0;
			pastThreshold.value = false;
		}
	}

	function onTouchEnd() {
		if (!tracking) return;
		tracking = false;

		if (pastThreshold.value) {
			// 触发刷新，保持指示器可见直到页面重载
			const onRefresh = opts.onRefresh ?? (() => window.location.reload());
			onRefresh();
			return;
		}
		// 未达阈值：动画回弹（CSS transition 处理）
		pullDistance.value = 0;
		setTimeout(() => {
			pulling.value = false;
			pastThreshold.value = false;
		}, 200);
	}

	onMounted(() => {
		const el = containerRef.value;
		if (!el) return;
		el.addEventListener('touchstart', onTouchStart, { passive: true });
		el.addEventListener('touchmove', onTouchMove, { passive: true });
		el.addEventListener('touchend', onTouchEnd);
	});

	onBeforeUnmount(() => {
		const el = containerRef.value;
		if (!el) return;
		el.removeEventListener('touchstart', onTouchStart);
		el.removeEventListener('touchmove', onTouchMove);
		el.removeEventListener('touchend', onTouchEnd);
	});

	return { pulling, pullDistance, pastThreshold };
}
