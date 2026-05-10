<template>
	<div class="relative" @click.prevent>
		<UPopover v-model:open="menuOpen" :content="{ side: 'bottom', align: 'end' }">
			<UButton
				:data-testid="`web-agent-actions-trigger-${webAgentId}`"
				variant="ghost"
				color="neutral"
				size="xs"
				icon="i-lucide-ellipsis"
				class="cc-icon-btn"
				:class="menuOpen ? 'opacity-100' : ''"
				aria-label="More"
			/>
			<template #content>
				<div class="flex max-w-60 flex-col py-1">
					<button
						:data-testid="`web-agent-actions-remove-${webAgentId}`"
						class="flex min-h-11 items-center gap-2.5 px-3.5 text-sm text-default transition-colors hover:bg-accented active:bg-accented"
						@click="onRemove"
					>
						<UIcon name="i-lucide-x" class="size-[18px] shrink-0" />
						<span class="truncate">{{ $t('webAgents.removeFromRecent') }}</span>
					</button>
				</div>
			</template>
		</UPopover>
	</div>
</template>

<script>
import { useWebAgentsStore } from '../stores/web-agents.store.js';

export default {
	name: 'WebAgentItemActions',
	props: {
		webAgentId: { type: Number, required: true },
	},
	data() {
		return {
			menuOpen: false,
		};
	},
	methods: {
		onRemove() {
			this.menuOpen = false;
			useWebAgentsStore().hide(this.webAgentId);
		},
	},
};
</script>
