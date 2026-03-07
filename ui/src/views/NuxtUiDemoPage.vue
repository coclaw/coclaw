<template>
	<main class="min-h-screen bg-default px-4 py-10">
		<UContainer class="mx-auto max-w-2xl">
			<UCard>
				<template #header>
					<div class="flex items-center justify-between gap-3">
						<div>
							<h1 class="text-xl font-semibold text-highlighted">{{ $t('demo.title') }}</h1>
							<p class="mt-1 text-sm text-muted">{{ $t('demo.desc') }}</p>
						</div>
						<UBadge color="primary" variant="soft">{{ $t('demo.ready') }}</UBadge>
					</div>
				</template>

				<div class="flex flex-wrap items-center gap-3">
					<UButton
						data-testid="demo-count-btn"
						color="primary"
						icon="i-lucide-plus"
						@click="onIncrease"
					>
						{{ $t('demo.clickedTimes', { count }) }}
					</UButton>
					<UButton to="/" variant="ghost" color="neutral">{{ $t('demo.backToAuthPrototype') }}</UButton>
				</div>
			</UCard>
		</UContainer>
	</main>
</template>

<script>
export default {
	name: 'NuxtUiDemoPage',
	data() {
		return {
			count: 0,
		};
	},
	methods: {
		onIncrease() {
			this.count += 1;
		},
	},
};
</script>
