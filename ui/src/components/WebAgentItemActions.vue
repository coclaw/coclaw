<template>
	<div class="relative" @click.prevent>
		<UDropdownMenu
			v-model:open="menuOpen"
			:items="menuItems"
			:content="{ side: 'bottom', align: 'end' }"
			:modal="false"
		>
			<UButton
				:data-testid="instance === 'main' ? `web-agent-actions-trigger-${webAgentId}` : null"
				variant="ghost"
				color="neutral"
				size="xs"
				icon="i-lucide-ellipsis"
				class="cc-icon-btn"
				:class="menuOpen ? 'opacity-100' : ''"
				:aria-label="name ? $t('common.moreActionsFor', { name }) : $t('common.moreActions')"
			/>
			<!-- 在 label 上挂 data-testid（E2E 锚点）：标准 item 元素不透传任意 data-* 属性 -->
			<template #item-label="{ item }">
				<span :data-testid="item.testid">{{ item.label }}</span>
			</template>
		</UDropdownMenu>
	</div>
</template>

<script>
import { useWebAgentsStore } from '../stores/web-agents.store.js';

export default {
	name: 'WebAgentItemActions',
	props: {
		webAgentId: { type: Number, required: true },
		/**
		 * 实例标记，与 MainList 同义：'main' 渲染 data-testid，其它值（如 'sidebar'）不渲染。
		 * 详见 MainList.vue 同名 prop 注释。
		 */
		instance: { type: String, default: 'main' },
		name: { type: String, default: '' },
	},
	data() {
		return {
			menuOpen: false,
		};
	},
	computed: {
		menuItems() {
			return [
				{
					label: this.$t('webAgents.removeFromRecent'),
					icon: 'i-lucide-x',
					// testid 仅 'main' 实例渲染（与原逻辑一致，避免 strict-mode 撞号）；undefined 时 Vue 不落属性
					testid: this.instance === 'main' ? `web-agent-actions-remove-${this.webAgentId}` : undefined,
					onSelect: () => this.onRemove(),
				},
			];
		},
	},
	methods: {
		onRemove() {
			this.menuOpen = false;
			useWebAgentsStore().hide(this.webAgentId);
		},
	},
};
</script>
