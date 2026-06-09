import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';

// 多屏弹窗位置：优先 E2E_WINDOW_POSITION 环境变量，其次本机专属文件 e2e/.window-position
//（gitignored，内容形如 "1960,80"）。坐标用 macOS 全局逻辑坐标，主屏左上角为 0,0。
// 都没有则返回空 args，维持 Playwright 默认（弹在主屏）——对 CI / 单屏零影响。
function windowPositionArgs() {
	let pos = process.env.E2E_WINDOW_POSITION;
	if (!pos) {
		try {
			pos = readFileSync(new URL('./e2e/.window-position', import.meta.url), 'utf-8').trim();
		} catch {
			// 无本机文件 → 不指定位置
		}
	}
	return pos ? [`--window-position=${pos}`] : [];
}

export default defineConfig({
	testDir: './e2e',
	timeout: 30_000,
	retries: 0,
	workers: 1,
	globalSetup: './e2e/global-setup.js',
	globalTeardown: './e2e/global-teardown.js',
	use: {
		baseURL: 'http://127.0.0.1:4173',
		// ⚠ 禁止改为 true。headless Chrome 在部分环境（如 WSL2）下动画帧渲染异常，
		// 导致 Playwright actionability "stable" 检查永远无法通过，所有 click() 超时。
		// 使用 headed 模式可跨环境兼容；无 GUI 环境通过 xvfb-run 提供虚拟 display（pnpm e2e:ci）。
		headless: false,
		// 多屏：把测试浏览器弹到指定显示器，避免遮挡当前终端。位置来源见上方 windowPositionArgs。
		launchOptions: { args: windowPositionArgs() },
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
