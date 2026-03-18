import { readFileSync } from 'fs';
import vue from '@vitejs/plugin-vue';
import ui from '@nuxt/ui/vite';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
	},
	plugins: [
		vue(),
		/* CoClaw 自定义品牌/状态色 — 移除 ui.colors 配置可恢复 Nuxt UI 默认色 */
		ui({
			ui: {
				colors: {
					primary: 'cc-primary',
					success: 'cc-success',
					error: 'cc-error',
					warning: 'cc-warning',
				},
				button: {
					slots: {
						base: 'cursor-pointer active:scale-[0.98] active:opacity-80',
					},
				},
				modal: {
					slots: {
						header: 'flex items-center gap-1.5 px-4 py-1 sm:px-6 min-h-16',
						wrapper: 'flex-1 min-w-0',
						close: 'static -me-2 cc-icon-btn-lg',
					},
				},
			},
		}),
	],
	esbuild: {
		drop: [],
	},
	server: {
		proxy: {
			'/api': {
				target: 'http://localhost:3000',
				changeOrigin: true,
				ws: true,
			},
		},
	},
});
