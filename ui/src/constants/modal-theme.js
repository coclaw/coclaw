// 全局 modal 主题覆盖：被 vite.config.js 注入到 @nuxt/ui（构建期经 defu 深合并叠在内置主题上）。
// 抽成独立模块是为了能单测形态——尤其守住那条红线：variants.fullscreen.true 里绝不能出现 content 键，
// 否则 defu「字符串叶子第一个赢」会把内置的 content:'inset-0' 顶掉、全屏弹窗尺寸画错。
//
// 设计要点：
// - header 紧凑(min-h 52px + py-1)、关闭叉行内静态居中、横向 px 两级响应(px-4/px-5)
// - body 顶 pt 两级响应(pt-4/pt-5)、底 pb-5 sm:pb-5；footer 横向对齐 + py-2
// - 安全区只在全屏(fullscreen)时垫，且自动落到最底那一段：有 footer 落 footer，无 footer 落 body
//   （body 用 :last-child 守卫——非最底时不垫，由下方 footer 负责）
// - max(地板, 安全区) 写法让桌面/非全屏退化为地板值(8px/20px)，与移动端一致、非全屏无副作用
//
// ⚠ 合并是「拼接」不是「替换」：@nuxt/ui 把内置默认 class 与本覆盖拼在一起，仅靠 tailwind-merge
//   去重直接冲突项 + CSS 优先级决胜。内置 body 的 `p-4 sm:p-6`、header/footer 的 `p-4` 不会被删，
//   会残留在最终 class 串里。因此凡是内置在某断点设了简写(如 body 的 sm:p-6)，我们就必须在「同断点」
//   把对应方向显式盖掉，否则桌面端会被 sm:p-6 顶回 24px。body 的 `sm:pb-5` 正是为压住 `sm:p-6` 而存在，
//   看似与 pb-5 重复，实则不可删（px/pt 同理已配 sm:）。
export const MODAL_THEME = {
	slots: {
		header: 'flex items-center justify-between gap-1.5 px-4 py-1 sm:px-5 min-h-13',
		wrapper: 'flex-1 min-w-0',
		close: 'static -me-2 cc-icon-btn-lg',
		body: 'flex-1 px-4 sm:px-5 pt-4 sm:pt-5 pb-5 sm:pb-5',
		footer: 'flex items-center gap-1.5 px-4 sm:px-5 py-2',
	},
	variants: {
		fullscreen: {
			// 只补 header/body/footer 的安全区，不碰 content（内置 content:'inset-0' 要保留）
			true: {
				header: 'pt-[max(0.25rem,var(--safe-area-inset-top))]',
				body: '[&:last-child]:pb-[max(1.25rem,var(--safe-area-inset-bottom))]',
				footer: 'pb-[max(0.5rem,var(--safe-area-inset-bottom))]',
			},
		},
	},
};
