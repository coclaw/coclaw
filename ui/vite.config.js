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
				// select 同 input：默认 outline 变体给 trigger base 加 text-highlighted，选中值文字跟着变纯白；
				// 统一跳柔到 text-default（落 size 变体 base + ! 锁定，理由同下方 input 注释）。
				select: {
					slots: { content: MENU_ELEVATION },
					variants: {
						size: {
							xs: { base: 'text-default!' },
							sm: { base: 'text-default!' },
							md: { base: 'text-default!' },
							lg: { base: 'text-default!' },
							xl: { base: 'text-default!' },
						},
					},
				},
				// textarea（如 ChatPage 底部输入框）：主题由 input 工厂派生，但 appConfig.ui.input 覆盖只作用于
				// <UInput> 实例、不传导到 <UTextarea>，故须单独再写一份；同样落 size 变体 base + ! 跳柔到 text-default。
				textarea: {
					variants: {
						size: {
							xs: { base: 'text-default!' },
							sm: { base: 'text-default!' },
							md: { base: 'text-default!' },
							lg: { base: 'text-default!' },
							xl: { base: 'text-default!' },
						},
					},
				},
				// 输入框全局基线（落在 size 变体的 base 上——覆盖 slots.base 会被变体类去重吃掉，tv 实测）：
				//   text-base   字体锁 1rem，防 iOS 聚焦自动缩放（字体 <16px 时 Safari 会放大页面）
				//   leading-normal  内置行高过紧（text-sm/4 · text-base/5）会切高字形头尾，抬到 1.5
				//   py-2        默认 py-1.5 偏挤，抬到 py-2 更舒展
				// px / gap 仍按各 size 内置值保留。
				// 内置有「md+ 把字号缩到 text-sm/xs」的响应式规则（按宽度≥768=桌面判断，
				// 但横屏 iPhone / iPad 也命中 md 却仍是 iOS Safari，缩到 <16px 会触发聚焦缩放）。
				// 用 compoundVariants 追加同尺寸的 md:text-base 盖回去——tv 合并 compoundVariants 是
				// append，我们这条排在内置 md:text-sm 之后，靠 tailwind-merge 同断点后者胜出。
				input: {
					// 文本色跳柔：内置默认 variant=outline 会给 base 加 text-highlighted(纯白)，与全局"默认文字
					// 回落 text-default"基调统一改为 text-default。落点同字号——必须在 size 变体 base 上（覆盖
					// 顶层 slots.base 会被丢弃，tv 实测）。用 ! 锁定：tailwind-merge 不认 Nuxt UI 语义色为同组，
					// text-default 不会去重掉 outline 的 text-highlighted，两者并存只能 important 决胜。
					variants: {
						size: {
							xs: { base: 'text-base leading-normal py-2 text-default!' },
							sm: { base: 'text-base leading-normal py-2 text-default!' },
							md: { base: 'text-base leading-normal py-2 text-default!' },
							lg: { base: 'text-base leading-normal py-2 text-default!' },
							xl: { base: 'text-base leading-normal py-2 text-default!' },
						},
					},
					compoundVariants: [
						{ size: 'xs', class: 'md:text-base' },
						{ size: 'sm', class: 'md:text-base' },
						{ size: 'md', class: 'md:text-base' },
						{ size: 'lg', class: 'md:text-base' },
					],
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
