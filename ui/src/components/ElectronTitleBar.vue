<template>
	<!--
		Electron 自定义壳标题栏色带：满窗宽、固定盖在两列之上、不占流；
		Windows（platform==='win32'）在条左侧渲染品牌 logo+产品名——条紧贴侧边栏头上，对齐基准取
		下方侧边栏图标列而非微软标准度量：logo 24px（size-6）左缘 16px（ml-4），与列表项图标/头像列
		（nav px-2 + 项 pl-2/px-2 = 16px，图标 size-6）左缘和宽度双对齐；文字 14px、距 logo 12px
		（gap-3，对齐列表项图标→文字间距，文本左缘 = 16+24+12 = 52px 与列表项文字同列）。
		品牌不可点、随整条拖拽区（不加 no-drag）。
		mac/Linux 条内留空（mac 身份由系统菜单栏+侧边栏承载，无标题栏品牌惯例）。
		渲染门控：父级（App.vue）先 v-if="custom" 控实例化（web/Capacitor 恒不渲染）；
		本组件再 v-if="!isFullScreen" 在全屏时收起。isFullScreen/platform 均由 App.vue 作 prop 传入，
		本组件不自订阅 IPC、不访问任何 Electron API（即便被 web 误导入也无副作用）。
	-->
	<div
		v-if="!isFullScreen"
		class="cc-electron-titlebar fixed inset-x-0 top-0 z-[60] bg-elevated"
		aria-hidden="true"
	>
		<div v-if="showBrand" class="cc-titlebar-brand flex h-full items-center gap-3">
			<img :src="logoSrc" alt="" class="ml-4 size-6 rounded" />
			<span class="text-sm text-default">{{ $t('layout.productName') }}</span>
		</div>
	</div>
</template>

<script>
import logoSrc from '../assets/coclaw-logo.jpg';

export default {
	name: 'ElectronTitleBar',
	props: {
		// 全屏态由 App.vue 作 prop 传入；不收 custom prop——custom 门由父级 v-if 负责
		isFullScreen: {
			type: Boolean,
			default: false,
		},
		// electronAPI.platform 的透传值（'win32'|'darwin'|'linux'），由 App.vue 传入；仅 win32 渲染品牌
		platform: {
			type: String,
			default: '',
		},
	},
	data() {
		return {
			logoSrc,
		};
	},
	computed: {
		showBrand() {
			return this.platform === 'win32';
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
