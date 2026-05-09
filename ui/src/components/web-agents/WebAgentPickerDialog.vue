<template>
	<UModal
		v-model:open="openProxy"
		:title="$t('webAgents.title')"
		description=" "
		:fullscreen="isMobile"
		:ui="modalUi"
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
		// UModal 默认 body 的 p-4 sm:p-6 在桌面端显得过空：pt 收紧到 pt-3，pb 维持 pb-4 留呼吸空间。
		// sm:* 必须显式写——基础断点的 py 不会顶掉 sm:p-6。
		// 移动端 pb 用 max(1rem, safe-area-inset-bottom)：地板值 1rem = pb-4，与桌面一致；
		// iPhone home indicator 时撑到 safe-area；同样需要 sm:pb 覆盖 sm:p-6 的 sm:pb-6。
		modalUi() {
			if (this.isMobile) {
				const pbSafe = 'pb-[max(1rem,var(--safe-area-inset-bottom))] sm:pb-[max(1rem,var(--safe-area-inset-bottom))]';
				return {
					header: 'pt-[max(0.25rem,var(--safe-area-inset-top))]',
					body: `pt-3 sm:pt-3 ${pbSafe}`,
				};
			}
			return { body: 'pt-3 sm:pt-3 pb-4 sm:pb-4' };
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
