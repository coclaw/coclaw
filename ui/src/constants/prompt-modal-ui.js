/**
 * prompt/confirm 对话框的 UModal :ui 覆盖。
 * 缩小宽度、去掉分割线、统一间距，水平 padding 与全局 header 一致（px-4 sm:px-5）。
 * header 把全局紧凑值（py-1 min-h-13）放宽为 pt-2 pb-1 min-h-14，给标题留足顶部呼吸感；
 * 仅作用于套用本覆盖的轻量弹窗，不影响设置/选择器等大弹窗（它们仍用全局 header）。
 */
export const promptModalUi = {
	content: 'w-[calc(100vw-2rem)] max-w-sm divide-y-0',
	header: 'pt-2 pb-1 min-h-14',
	body: 'px-4 py-3 sm:px-5 sm:py-3',
	footer: 'px-4 py-4 sm:px-5',
};
