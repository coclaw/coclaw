import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [vue()],
	test: {
		include: ['src/**/*.test.js'],
		exclude: ['e2e/**'],
		environment: 'jsdom',
		globals: true,
		setupFiles: ['./vitest.setup.js'],
		// 用例间清空 mock 调用历史，防止上一例的 toHaveBeenCalled 残留干扰。
		// 注意：若测试需要读 import-time 注册的 mock.calls[0]（如 axios.create 的拦截器登记），
		// 必须把回调引用在模块顶层就 capture 下来，不能放进 beforeEach；clearMocks 在 beforeEach
		// 之前跑，会把模块加载时的调用历史一并清空。
		// 不开 restoreMocks：会清掉 vi.hoisted(() => vi.fn().mockResolvedValue()) 这类
		// 模块顶层默认实现，少量 hoisted mock 用法会被打断。
		// 不开 unstubGlobals / unstubEnvs：会清掉模块顶层 vi.stubGlobal（如 __APP_VERSION__），
		// 后续用例触发组件 data() 时 ReferenceError。
		clearMocks: true,
		coverage: {
			include: [
				'src/stores/**/*.js',
				'src/services/**/*.js',
				'src/utils/**/*.js',
				'src/composables/**/*.js',
				'src/validators/**/*.js',
			],
			provider: 'v8',
			reporter: ['text', 'lcov'],
			exclude: [
				'e2e/**',
				'playwright.config.js',
				'vitest.config.js',
				'vite.config.js',
				'src/utils/tauri-app.js',
				'src/utils/tauri-notify.js',
			],
			thresholds: {
				lines: 95,
				functions: 95,
				branches: 90,
				statements: 95,
			},
		},
	},
});
