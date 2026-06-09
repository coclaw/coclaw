<template>
	<UApp :toaster="toasterConfig">
		<ElectronTitleBar v-if="custom" :is-full-screen="isFullScreen" />
		<!-- cc-app-content：纯惰性 marker（作用域 CSS 唯一落点）；web/Capacitor 无规则命中、不改布局 -->
		<div class="cc-app-content">
			<router-view />
		</div>
	</UApp>
</template>

<script>
import ElectronTitleBar from './components/ElectronTitleBar.vue';
import { useEnvStore } from './stores/env.store.js';
import { useUiStore } from './stores/ui.store.js';
import { useNotify } from './composables/use-notify.js';
import { setGlobalErrorNotify } from './utils/global-error-handler.js';
import { wireNotifyHooks } from './stores/notify-hook-bridge.js';

export default {
	name: 'AppRoot',

	components: {
		// 显式注册：vitest 仅挂 vue() 插件、不走 @nuxt/ui 的自动导入，故必须显式 import
		ElectronTitleBar,
	},

	setup() {
		const notify = useNotify();
		setGlobalErrorNotify((msg) => notify.error({ title: msg }));
		// setup 内一次性把 notifier 接到 claws.store hook，并存为 shared 供 Capacitor 等回调按需取
		wireNotifyHooks(notify);
		return {
			envStore: useEnvStore(),
			uiStore: useUiStore(),
		};
	},

	data() {
		return {
			// Electron 自定义壳标题栏状态。custom 初值 false：保证收口判定前父级 v-if 不误挂 <ElectronTitleBar>
			custom: false,
			isFullScreen: false,
		};
	},

	computed: {
		toasterConfig() {
			return {
				position: this.envStore.screen.ltMd ? 'top-center' : 'top-right',
			};
		},
	},

	watch: {
		// 类的增删走同步 watcher（flush:'pre'，与渲染同一次 flush）；
		// 禁止 defer 到 rAF/setTimeout/flush:'post'——否则条 v-if 与作用域 CSS 跨帧 desync、离开全屏瞬间一帧压内容
		isFullScreen: {
			handler() {
				this.__syncTitlebarClass();
			},
			flush: 'pre',
		},
	},

	mounted() {
		// resize 初始化对所有端（含桌面浏览器）都要跑，绝不能被 Electron 收口跳过
		this.uiStore.initResize();
		this.initElectronTitlebar();
	},

	beforeUnmount() {
		this.uiStore.destroyResize();
		if (this.__fsUnsub) {
			this.__fsUnsub();
			this.__fsUnsub = null;
		}
		// HMR / 单测 / 异常重挂残留防护：始终摘掉根类
		document.documentElement.classList.remove('cc-electron-custom');
	},

	methods: {
		initElectronTitlebar() {
			// 必须走 window.electronAPI：裸 electronAPI 在浏览器是未声明全局、可选链也救不了、会抛 ReferenceError
			const api = window.electronAPI;
			const custom = !!api?.titleBar?.custom;
			// 这一道门同时兜住浏览器/Capacitor/老壳/Linux/原生栏/forceNative 全部「无条」分支
			if (!custom) {
				return;
			}
			// 立即写 data.custom，否则根类虽挂上、但父级 v-if="custom" 不会挂出 <ElectronTitleBar>
			this.custom = true;
			// 同步段（任何 await 之前）即按 custom && !isFullScreen 挂作用域类：首帧就让出 38px、不压内容
			this.__syncTitlebarClass();
			// 订阅实时全屏事件——必须早于 getFullScreen，否则「挂类后、getter 前后」窗口里漏掉的 enter/leave 无从补回
			this.__primed = false;
			this.__fsUnsub = api.onFullScreenChange((isFs) => {
				this.__primed = true;
				this.isFullScreen = !!isFs;
			});
			// 异步 getFullScreen 仅纠正「冷启即处于全屏」少数态；
			// 防陈旧覆盖：已收到任何实时事件（primed）后忽略 getter 回填，旧值不得覆盖新值
			Promise.resolve(api.getFullScreen?.())
				.then((isFs) => {
					if (this.__primed) {
						return;
					}
					this.isFullScreen = !!isFs;
				})
				.catch(() => {});
		},

		// 按 custom && !isFullScreen 同步增删根类；该类是 cc-electron-custom 作用域 CSS 的唯一开关
		__syncTitlebarClass() {
			const on = this.custom && !this.isFullScreen;
			document.documentElement.classList.toggle('cc-electron-custom', on);
		},
	},
};
</script>
