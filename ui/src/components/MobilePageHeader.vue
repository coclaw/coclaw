<template>
	<header class="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-default bg-default px-1 py-[3px] md:hidden">
		<div class="flex shrink-0 items-center">
			<UButton
				size="xl"
				variant="ghost"
				color="primary"
				class="cc-icon-btn-lg"
				icon="i-lucide-arrow-left"
				@click="goBack"
			/>
		</div>
		<h1 class="min-w-0 truncate text-base font-medium">{{ title }}</h1>
		<div class="flex shrink-0 items-center">
			<slot name="actions" />
			<!-- 无 actions 时占位，宽度与左侧按钮对齐以保持标题居中 -->
			<span v-if="!$slots.actions" class="inline-block size-10" />
		</div>
	</header>
</template>

<script>
export default {
	name: 'MobilePageHeader',
	props: {
		title: {
			type: String,
			default: '',
		},
	},
	methods: {
		goBack() {
			if (!history.state?.back) {
				this.$router.replace('/');
			}
			else {
				this.$router.back();
			}
		},
	},
};
</script>
