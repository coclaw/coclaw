<template>
	<UModal
		v-model:open="openProxy"
		:title="$t('settings.title')"
		description=" "
		:fullscreen="isMobile"
		@after:leave="$emit('after:leave')"
	>
		<template #body>
			<UserSettingsPanel />
		</template>
	</UModal>
</template>

<script>
import UserSettingsPanel from './UserSettingsPanel.vue';
import { popDialogState } from '../../utils/dialog-history.js';
import { useEnvStore } from '../../stores/env.store.js';

export default {
	name: 'UserSettingsDialog',
	components: {
		UserSettingsPanel,
	},
	props: {
		open: {
			type: Boolean,
			default: false,
		},
	},
	emits: ['update:open', 'after:leave'],
	setup() {
		return { envStore: useEnvStore() };
	},
	computed: {
		isMobile() {
			return this.envStore.screen.ltMd;
		},
		openProxy: {
			get() {
				return this.open;
			},
			set(val) {
				this.$emit('update:open', val);
			},
		},
	},
	watch: {
		open(val) {
			if (!val) popDialogState();
		},
	},
};
</script>
