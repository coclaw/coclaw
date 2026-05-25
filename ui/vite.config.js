import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import vue from '@vitejs/plugin-vue';
import ui from '@nuxt/ui/vite';
import compression from 'vite-plugin-compression';
import { defineConfig } from 'vite';
import { MODAL_THEME } from './src/constants/modal-theme.js';
import { MENU_ELEVATION } from './src/constants/popup-elevation.js';

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
				checkbox: {
					slots: {
						root: 'cursor-pointer',
					},
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
				modal: MODAL_THEME,
				// 弹出菜单脱离背景：quasar 多层投影 + 暗色提亮描边，叠在内置 content 上（shadow-lg 被去重换掉）
				popover: { slots: { content: MENU_ELEVATION } },
				select: { slots: { content: MENU_ELEVATION } },
				// 输入框全局基线（落在 size 变体的 base 上——覆盖 slots.base 会被变体类去重吃掉，tv 实测）：
				//   text-base   字体锁 1rem，防 iOS 聚焦自动缩放（字体 <16px 时 Safari 会放大页面）
				//   leading-normal  内置行高过紧（text-sm/4 · text-base/5）会切高字形头尾，抬到 1.5
				//   py-2        默认 py-1.5 偏挤，抬到 py-2 更舒展
				// px / gap 仍按各 size 内置值保留。
				// fixed:true 关掉内置「md+ 缩到 text-sm/xs」的响应式字号——那套按"宽度≥768=桌面"判断，
				// 但横屏 iPhone / iPad 也命中 md 却仍是 iOS Safari，缩到 14px 会触发聚焦缩放；
				// fixed 只挂字号缩小那 4 条规则，不碰 py/px/gap，翻 true 后全断点稳在 16px。
				input: {
					variants: {
						size: {
							xs: { base: 'text-base leading-normal py-2' },
							sm: { base: 'text-base leading-normal py-2' },
							md: { base: 'text-base leading-normal py-2' },
							lg: { base: 'text-base leading-normal py-2' },
							xl: { base: 'text-base leading-normal py-2' },
						},
					},
					defaultVariants: { fixed: true },
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
