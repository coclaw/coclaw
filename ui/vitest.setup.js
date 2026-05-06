import { afterEach } from 'vitest';
import { config } from '@vue/test-utils';

// jsdom 未实现 ResizeObserver，提供最小 stub；只在 browser-like 环境装，避免污染 node 全局
// （否则 node 环境下的 feature-detect 'typeof ResizeObserver' 会被本 stub 误导）
if (typeof window !== 'undefined') {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
}

// 全局 stub Nuxt UI 组件，消除测试中的 "Failed to resolve component" 警告
config.global.stubs = {
	UInput: { template: '<div />', inheritAttrs: false },
	UModal: { template: '<div><slot /></div>' },
	UButton: { template: '<button><slot /></button>' },
};

afterEach(() => {
	// 只在 browser-like 环境清；node 测试无 storage 不需要清。
	// 双层守卫：jsdom 下走 window.localStorage（jsdom 提供），node 下完全不碰，比裸 typeof localStorage 更精准。
	if (typeof window !== 'undefined') {
		window.localStorage?.clear();
		window.sessionStorage?.clear();
	}
});
