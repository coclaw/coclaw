<template>
	<UApp :toaster="toasterConfig">
		<router-view />
	</UApp>
</template>

<script>
import { useEnvStore } from './stores/env.store.js';
import { useUiStore } from './stores/ui.store.js';
import { useNotify } from './composables/use-notify.js';
import { setGlobalErrorNotify } from './utils/global-error-handler.js';

export default {
	name: 'AppRoot',

	setup() {
		const notify = useNotify();
		setGlobalErrorNotify((msg) => notify.error({ title: msg }));
		return {
			envStore: useEnvStore(),
			uiStore: useUiStore(),
		};
	},

	computed: {
		toasterConfig() {
			return {
				position: this.envStore.screen.ltMd ? 'top-center' : 'top-right',
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
