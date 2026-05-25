<template>
	<UModal
		v-model:open="openProxy"
		:title="$t('webAgents.title')"
		description=" "
		:fullscreen="isMobile"
		@after:leave="$emit('after:leave')"
	>
		<template #body>
			<div data-testid="web-agent-picker-dialog">
				<WebAgentPickerPanel @selected="onSelected" />
			</div>
		</template>
	</UModal>
</template>

<script>
import WebAgentPickerPanel from './WebAgentPickerPanel.vue';
import { popDialogState } from '../../utils/dialog-history.js';
import { useEnvStore } from '../../stores/env.store.js';

export default {
	name: 'WebAgentPickerDialog',
	components: {
		WebAgentPickerPanel,
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
	methods: {
		onSelected() {
			this.openProxy = false;
		},
	},
};
</script>
