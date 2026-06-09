<template>
	<UModal
		v-model:open="openProxy"
		:title="$t('layout.menu.profile')"
		description=" "
		:fullscreen="isMobile"
		@after:leave="$emit('after:leave')"
	>
		<template #body>
			<UserProfilePanel data-testid="profile-info" />
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
