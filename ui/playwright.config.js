import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './e2e',
	timeout: 30_000,
	retries: 0,
	workers: 1,
	globalSetup: './e2e/global-setup.js',
	use: {
		baseURL: 'http://127.0.0.1:4173',
		// ⚠ 禁止改为 true。headless Chrome 在部分环境（如 WSL2）下动画帧渲染异常，
		// 导致 Playwright actionability "stable" 检查永远无法通过，所有 click() 超时。
		// 使用 headed 模式可跨环境兼容；无 GUI 环境通过 xvfb-run 提供虚拟 display（pnpm e2e:ci）。
		headless: false,
	},
	webServer: [
		{
			command: 'pnpm --filter @coclaw/server exec cross-env NODE_ENV=development node src/index.js',
			port: 3000,
			reuseExistingServer: true,
			timeout: 120_000,
		},
		{
			command: 'pnpm dev --host 127.0.0.1 --port 4173',
			port: 4173,
			reuseExistingServer: true,
			timeout: 120_000,
		},
	],
});
