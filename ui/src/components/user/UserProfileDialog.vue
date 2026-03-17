<template>
	<UModal
		v-model:open="openProxy"
		:title="$t('layout.menu.profile')"
		description=" "
		:fullscreen="isMobile"
		:ui="isMobile ? safeAreaUi : undefined"
		@after:leave="$emit('after:leave')"
	>
		<template #body>
			<UserProfilePanel />
		</template>
	</UModal>
</template>

<script>
import UserProfilePanel from './UserProfilePanel.vue';
import { popDialogState } from '../../utils/dialog-history.js';
import { useEnvStore } from '../../stores/env.store.js';

export default {
	name: 'UserProfileDialog',
	components: {
		UserProfilePanel,
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
	data() {
		return {
			safeAreaUi: {
				header: 'pt-[max(0.25rem,var(--safe-area-inset-top))]',
				body: 'pb-[var(--safe-area-inset-bottom)]',
			},
		};
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
