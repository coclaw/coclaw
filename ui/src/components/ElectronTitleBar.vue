<template>
	<!--
		Electron 自定义壳标题栏色带：满窗宽、固定盖在两列之上、不占流；
		v1 内容留空（仅色带 + 拖动把手 + 给系统窗口按钮让出竖直空间），aria-hidden。
		渲染门控：父级（App.vue）先 v-if="custom" 控实例化（web/Capacitor 恒不渲染）；
		本组件再 v-if="!isFullScreen" 在全屏时收起。isFullScreen 由 App.vue 传入，
		本组件不自订阅 IPC、不访问任何 Electron API（即便被 web 误导入也无副作用）。
	-->
	<div
		v-if="!isFullScreen"
		class="cc-electron-titlebar fixed inset-x-0 top-0 z-[60] bg-elevated"
		aria-hidden="true"
	/>
</template>

<script>
export default {
	name: 'ElectronTitleBar',
	props: {
		// 全屏态由 App.vue 作 prop 传入；不收 custom prop——custom 门由父级 v-if 负责
		isFullScreen: {
			type: Boolean,
			default: false,
		},
	},
};
</script>

<style scoped>
.cc-electron-titlebar {
	/* 高 = 作用域常量 --cc-titlebar-h（仅 html.cc-electron-custom 下定义；本条渲染时该类必在，故必然解析为 38px，留 fallback 兜底） */
	height: var(--cc-titlebar-h, 38px);
	/* 拖动整条窗口——同写带前缀与不带前缀，新旧 Electron 都认 */
	-webkit-app-region: drag;
	app-region: drag;
}
</style>
