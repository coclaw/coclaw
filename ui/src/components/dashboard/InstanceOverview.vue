<template>
	<div class="rounded-xl bg-elevated p-4 sm:p-5">
		<!-- 名称 + 状态灯 + 花费 -->
		<div class="flex items-center justify-between">
			<div class="flex items-center gap-2">
				<span
					class="inline-block size-2.5 rounded-full"
					:class="instance.online ? 'bg-green-400 animate-pulse motion-reduce:animate-none' : 'bg-gray-500'"
				></span>
				<h2 class="text-lg font-semibold">{{ instance.name }}</h2>
			</div>
			<div v-if="instance.monthlyCost && typeof instance.monthlyCost.total === 'number'" class="text-right">
				<p class="text-2xl font-bold tracking-tight">{{ formatCost(instance.monthlyCost) }}</p>
				<p class="text-xs text-muted">{{ $t('dashboard.monthlyCost') }}</p>
			</div>
		</div>
		<!-- 版本 + 频道状态 + agent 数 -->
		<div class="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted">
			<span v-if="instance.pluginVersion">{{ $t('bots.pluginVersion') }}{{ instance.pluginVersion }}</span>
			<span v-if="instance.clawVersion">{{ $t('bots.clawVersion') }}{{ instance.clawVersion }}</span>
			<span v-if="instance.channels?.length" class="flex items-center gap-1.5">
				<span v-for="ch in instance.channels" :key="ch.id" class="inline-flex items-center gap-0.5" :title="ch.id">
					<span class="text-[10px]">{{ ch.connected ? '✅' : '❌' }}</span>
					<span>{{ ch.id }}</span>
				</span>
			</span>
			<UBadge color="primary" variant="subtle" size="xs">{{ agentCount }} {{ $t('dashboard.agents') }}</UBadge>
		</div>
	</div>
</template>

<script>
export default {
	name: 'InstanceOverview',
	props: {
		instance: { type: Object, required: true },
		agentCount: { type: Number, default: 0 },
	},
	methods: {
		formatCost(cost) {
			if (cost && typeof cost.total === 'number') {
				return new Intl.NumberFormat(undefined, {
					style: 'currency',
					currency: cost.currency || 'USD',
				}).format(cost.total);
			}
			return '—';
		},
	},
};
</script>
