<template>
	<div class="pointer-events-none mx-auto w-full max-w-3xl pl-1.5">
		<UPopover v-model:open="menuOpen" class="pointer-events-auto" :content="{ side: 'top', align: 'start' }">
			<UButton
				data-testid="btn-slash-menu"
				variant="ghost"
				color="primary"
				:icon="menuOpen ? 'i-lucide-chevron-left' : 'i-lucide-chevron-right'"
				class="cc-icon-btn-lg"
				:disabled="disabled"
			/>
			<template #content>
				<div class="flex max-w-60 flex-col py-1">
					<button
						class="flex min-h-11 items-center gap-2.5 px-3.5 text-sm text-default transition-colors hover:bg-accented active:bg-accented"
						@click="onCommand('/compact')"
					>
						<UIcon name="i-lucide-archive" class="size-[18px] shrink-0" />
						<span class="truncate">{{ $t('slashCmd.compact') }}</span>
					</button>
					<button
						class="flex min-h-11 items-center gap-2.5 px-3.5 text-sm text-default transition-colors hover:bg-accented active:bg-accented"
						@click="onCommand('/new')"
					>
						<UIcon name="i-lucide-refresh-cw" class="size-[18px] shrink-0" />
						<span class="truncate">{{ $t('slashCmd.reset') }}</span>
					</button>
				</div>
			</template>
		</UPopover>
	</div>
</template>

<script>
export default {
	name: 'SlashCommandMenu',
	props: {
		disabled: { type: Boolean, default: false },
	},
	emits: ['command'],
	data() {
		return { menuOpen: false };
	},
	methods: {
		onCommand(cmd) {
			this.menuOpen = false;
			this.$emit('command', cmd);
		},
	},
};
</script>
