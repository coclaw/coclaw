<template>
	<nav class="flex min-h-9 items-center gap-1 overflow-x-auto px-3 text-sm">
		<button
			class="shrink-0 text-primary hover:underline"
			@click="$emit('navigate', '')"
		>
			{{ $t('files.rootDir') }}
		</button>
		<template v-for="(seg, idx) in segments" :key="idx">
			<UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 text-muted" />
			<button
				v-if="idx < segments.length - 1"
				class="shrink-0 text-primary hover:underline"
				@click="$emit('navigate', pathAt(idx))"
			>
				{{ seg }}
			</button>
			<span v-else class="shrink-0 font-medium">{{ seg }}</span>
		</template>
	</nav>
</template>

<script>
export default {
	name: 'FileBreadcrumb',
	props: {
		/** 当前目录路径（相对 workspace，如 "src/components"） */
		path: { type: String, default: '' },
	},
	emits: ['navigate'],
	computed: {
		segments() {
			if (!this.path) return [];
			return this.path.split('/').filter(Boolean);
		},
	},
	methods: {
		pathAt(idx) {
			return this.segments.slice(0, idx + 1).join('/');
		},
	},
};
</script>
