<template>
	<header class="sticky top-0 z-10 flex items-center gap-1 border-b border-default bg-default px-1 py-[3px] pt-[3px] md:hidden">
		<UButton
			size="xl"
			variant="ghost"
			color="neutral"
			class="cc-icon-btn-lg shrink-0"
			icon="i-lucide-arrow-left"
			@click="goBack"
		/>
		<h1 class="min-w-0 truncate text-base font-medium">{{ title }}</h1>
		<div class="ml-auto flex shrink-0 items-center">
			<slot name="actions" />
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
