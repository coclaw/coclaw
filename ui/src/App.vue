<template>
	<UApp :toaster="toasterConfig">
		<router-view />
	</UApp>
</template>

<script>
import { isMobileViewport } from './utils/layout.js';
import { useUiStore } from './stores/ui.store.js';

export default {
	name: 'AppRoot',

	setup() {
		return {
			uiStore: useUiStore(),
		};
	},

	computed: {
		toasterConfig() {
			return {
				position: isMobileViewport(this.uiStore.screenWidth) ? 'top-center' : 'top-right',
			};
		},
	},

	mounted() {
		this.uiStore.initResize();
	},

	beforeUnmount() {
		this.uiStore.destroyResize();
	},
};
</script>
