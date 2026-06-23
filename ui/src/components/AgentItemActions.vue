<template>
	<div class="relative" @click.prevent>
		<UDropdownMenu
			v-model:open="menuOpen"
			:items="menuItems"
			:content="{ side: 'bottom', align: 'end' }"
			:modal="false"
		>
			<UButton
				variant="ghost"
				color="neutral"
				size="xs"
				icon="i-lucide-ellipsis"
				class="cc-icon-btn"
				:class="menuOpen ? 'opacity-100' : ''"
				:aria-label="name ? $t('common.moreActionsFor', { name }) : $t('common.moreActions')"
			/>
		</UDropdownMenu>
	</div>
</template>

<script>
export default {
	name: 'AgentItemActions',
	props: {
		clawId: { type: String, required: true },
		agentId: { type: String, required: true },
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
				{ label: this.$t('agents.chat'), icon: 'i-lucide-message-square', onSelect: () => this.onChat() },
				{ label: this.$t('agents.files'), icon: 'i-lucide-folder', onSelect: () => this.onFiles() },
			];
		},
	},
	methods: {
		onChat() {
			this.menuOpen = false;
			this.$router.push({
				name: 'chat',
				params: { clawId: String(this.clawId), agentId: this.agentId },
			});
		},
		onFiles() {
			this.menuOpen = false;
			this.$router.push({
				name: 'files',
				params: { clawId: String(this.clawId), agentId: this.agentId },
			});
		},
	},
};
</script>
