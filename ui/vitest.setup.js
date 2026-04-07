import { afterEach } from 'vitest';
import { config } from '@vue/test-utils';

// 全局 stub Nuxt UI 组件，消除测试中的 "Failed to resolve component" 警告
config.global.stubs = {
	UInput: { template: '<div />', inheritAttrs: false },
	UModal: { template: '<div><slot /></div>' },
	UButton: { template: '<button><slot /></button>' },
};

afterEach(() => {
	// 保持测试之间状态隔离
	localStorage.clear();
	sessionStorage.clear();
});
