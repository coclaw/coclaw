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
import { wireNotifyHooks } from './stores/notify-hook-bridge.js';

export default {
	name: 'AppRoot',

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
