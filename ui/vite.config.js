import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import vue from '@vitejs/plugin-vue';
import ui from '@nuxt/ui/vite';
import compression from 'vite-plugin-compression';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
	build: {
		target: ['es2020', 'chrome90', 'edge90', 'safari15', 'firefox90'],
	},
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
	},
	plugins: [
		{
			name: 'generate-version-json',
			writeBundle() {
				mkdirSync('dist', { recursive: true });
				writeFileSync('dist/version.json', JSON.stringify({
					version: pkg.version,
					buildTime: new Date().toISOString(),
				}));
			},
		},
		vue(),
		compression({ threshold: 1024 }),
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
					compoundVariants: [{
						color: 'neutral',
						variant: 'ghost',
						class: 'hover:bg-black/8 dark:hover:bg-white/10 active:bg-black/8 dark:active:bg-white/10 focus-visible:bg-black/8 dark:focus-visible:bg-white/10',
					}],
				},
				radioGroup: {
					slots: {
						item: 'cursor-pointer',
					},
				},
				toaster: {
					slots: {
						viewport: 'mt-[var(--safe-area-inset-top)] mb-[var(--safe-area-inset-bottom)]',
					},
				},
				modal: {
					slots: {
						header: 'flex items-center justify-between gap-1.5 px-4 py-1 sm:px-6 min-h-16',
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
		host: '0.0.0.0',
		proxy: {
			'/api': {
				target: 'http://localhost:3000',
				changeOrigin: true,
				ws: true,
			},
		},
	},
});
