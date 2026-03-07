import { afterEach } from 'vitest';

afterEach(() => {
	// 保持测试之间状态隔离
	localStorage.clear();
	sessionStorage.clear();
});
