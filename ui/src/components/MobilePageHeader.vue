<template>
	<header data-testid="mobile-page-header" class="sticky top-0 z-10 flex items-center gap-1 border-b border-default bg-default px-1 py-[3px] pt-[3px] md:hidden">
		<UButton
			size="xl"
			variant="ghost"
			color="neutral"
			class="cc-icon-btn-lg shrink-0"
			icon="i-lucide-arrow-left"
			:aria-label="$t('common.back')"
			@click="goBack"
		/>
		<h1 class="min-w-0 truncate text-base font-medium">
			<slot>{{ title }}</slot>
		</h1>
		<div class="ml-auto flex shrink-0 items-center">
			<slot name="actions" />
		</div>
	</header>
</template>

<script>
import { navBack } from '../utils/nav-back.js';

export default {
	name: 'MobilePageHeader',
	props: {
		title: {
			type: String,
			default: '',
		},
		fallback: {
			type: String,
			default: '/',
		},
	},
	methods: {
		goBack() {
			navBack(this.$router, this.fallback);
		},
	},
};
</script>
