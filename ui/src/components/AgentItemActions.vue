<template>
	<div class="relative" @click.prevent>
		<UPopover v-model:open="menuOpen" :content="{ side: 'bottom', align: 'end' }">
			<UButton
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
						class="flex min-h-11 items-center gap-2.5 px-3.5 text-sm text-default transition-colors hover:bg-accented active:bg-accented"
						@click="onChat"
					>
						<UIcon name="i-lucide-message-square" class="size-[18px] shrink-0" />
						<span class="truncate">{{ $t('agents.chat') }}</span>
					</button>
					<button
						class="flex min-h-11 items-center gap-2.5 px-3.5 text-sm text-default transition-colors hover:bg-accented active:bg-accented"
						@click="onFiles"
					>
						<UIcon name="i-lucide-folder" class="size-[18px] shrink-0" />
						<span class="truncate">{{ $t('agents.files') }}</span>
					</button>
				</div>
			</template>
		</UPopover>
	</div>
</template>

<script>
export default {
	name: 'AgentItemActions',
	props: {
		clawId: { type: String, required: true },
		agentId: { type: String, required: true },
	},
	data() {
		return {
			menuOpen: false,
		};
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
