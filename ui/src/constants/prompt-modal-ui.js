/**
 * prompt/confirm 对话框的 UModal :ui 覆盖。
 * 缩小宽度、去掉分割线、统一间距，水平 padding 与全局 header 一致（px-4 sm:px-5）。
 */
export const promptModalUi = {
	content: 'w-[calc(100vw-2rem)] max-w-sm divide-y-0',
	body: 'px-4 py-3 sm:px-5 sm:py-3',
	footer: 'px-4 py-4 sm:px-5',
};
