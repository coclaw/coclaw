import { defineStore } from 'pinia';

const MAX_DRAWER_WIDTH = 384;

// 模块级变量，避免挂到 reactive state 上
let resizeHandler = null;

export const useUiStore = defineStore('ui', {
	state: () => ({
		screenWidth: typeof window !== 'undefined' ? window.innerWidth : 1024,
	}),
	getters: {
		drawerWidth(state) {
			return Math.min(Math.round(state.screenWidth * 0.3), MAX_DRAWER_WIDTH);
		},
	},
	actions: {
		initResize() {
			if (resizeHandler) return;
			resizeHandler = () => {
				this.screenWidth = window.innerWidth;
			};
			window.addEventListener('resize', resizeHandler);
		},
		destroyResize() {
			if (resizeHandler) {
				window.removeEventListener('resize', resizeHandler);
				resizeHandler = null;
			}
		},
	},
});
