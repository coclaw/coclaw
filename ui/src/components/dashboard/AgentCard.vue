<template>
	<div
		class="rounded-xl border border-default bg-white dark:bg-gray-900 overflow-hidden"
		:class="online ? '' : 'opacity-60'"
	>
		<!-- 主题色条 -->
		<div class="h-1" :style="agent.theme ? `background: ${agent.theme}` : 'background: #6366f1'"></div>

		<div class="p-3 sm:p-4 space-y-3">
			<!-- 身份区 -->
			<div class="flex items-center gap-3">
				<span class="size-10 shrink-0 rounded-full bg-accented flex items-center justify-center overflow-hidden text-lg">
					<img v-if="agent.avatarUrl" :src="agent.avatarUrl" class="size-full object-cover" />
					<span v-else-if="agent.emoji">{{ agent.emoji }}</span>
					<span v-else class="text-sm font-medium text-dimmed">{{ agent.name.charAt(0).toUpperCase() }}</span>
				</span>
				<div class="min-w-0 flex-1">
					<p class="font-medium truncate">{{ agent.name }}</p>
					<span
						class="inline-block size-2 rounded-full"
						:class="online ? 'bg-green-400' : 'bg-gray-400'"
					></span>
				</div>
			</div>

			<!-- 模型标签 -->
			<div v-if="agent.modelTags?.length" class="flex flex-wrap gap-1.5">
				<UBadge v-for="tag in agent.modelTags" :key="tag.label" color="primary" variant="subtle" size="xs">
					<span v-if="tag.icon" class="mr-0.5">{{ tag.icon }}</span>{{ tag.label }}
				</UBadge>
			</div>

			<!-- 能力标签 -->
			<div v-if="agent.capabilities?.length" class="flex flex-wrap gap-1.5">
				<UBadge v-for="cap in agent.capabilities" :key="cap.id" color="neutral" variant="soft" size="xs">
					<span class="mr-0.5">{{ cap.icon }}</span>{{ cap.label }}
				</UBadge>
			</div>

			<!-- 数据区 -->
			<div class="grid grid-cols-3 gap-2 text-center text-xs text-dimmed">
				<div>
					<p class="text-sm font-medium text-default">{{ formatTokens(agent.totalTokens) }}</p>
					<p>{{ $t('dashboard.tokens') }}</p>
				</div>
				<div>
					<p class="text-sm font-medium text-default">{{ agent.activeSessions }}</p>
					<p>{{ $t('dashboard.sessions') }}</p>
				</div>
				<div>
					<p class="text-sm font-medium text-default">{{ formatTimeAgo(agent.lastActivity) }}</p>
					<p>{{ $t('dashboard.lastActive') }}</p>
				</div>
			</div>

			<!-- 动作区 -->
			<UButton class="w-full" color="primary" :disabled="!online" @click="$emit('chat', agent.id)">
				{{ $t('agents.chat') }}
			</UButton>
		</div>
	</div>
</template>

<script>
export default {
	name: 'AgentCard',
	props: {
		agent: { type: Object, required: true },
		online: { type: Boolean, default: false },
	},
	emits: ['chat'],
	methods: {
		formatTokens(n) {
			if (typeof n !== 'number' || n <= 0) return '0';
			if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
			if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
			return String(n);
		},
		formatTimeAgo(iso) {
			if (!iso) return '—';
			const diff = (Date.now() - new Date(iso).getTime()) / 1000;
			if (diff < 0 || Number.isNaN(diff)) return '—';
			if (diff < 60) return this.$t('dashboard.justNow');
			if (diff < 3600) return this.$t('dashboard.minutesAgo', { n: Math.floor(diff / 60) });
			if (diff < 86400) return this.$t('dashboard.hoursAgo', { n: Math.floor(diff / 3600) });
			return this.$t('dashboard.daysAgo', { n: Math.floor(diff / 86400) });
		},
	},
};
</script>
