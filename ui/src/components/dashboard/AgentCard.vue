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
					<div class="flex items-center gap-1.5 mt-0.5">
						<span class="inline-block size-2 rounded-full" :class="online ? 'bg-green-400' : 'bg-gray-400'"></span>
						<span v-if="agent.hasError" class="inline-block size-2 rounded-full bg-red-500" :title="$t('dashboard.hasError')"></span>
						<span v-if="agent.cronCount > 0" class="text-xs text-dimmed">⏰ {{ agent.cronCount }}</span>
					</div>
				</div>
			</div>

			<!-- 模型标签 -->
			<div v-if="agent.modelTags?.length" class="flex flex-wrap gap-1.5">
				<UBadge v-for="tag in agent.modelTags" :key="tag.labelKey || tag.label" color="primary" variant="subtle" size="xs">
					<span v-if="tag.icon" class="mr-0.5">{{ tag.icon }}</span>{{ tag.label || $t(tag.labelKey, tag.labelParams || {}) }}
				</UBadge>
			</div>

			<!-- 能力标签 -->
			<div v-if="agent.capabilities?.length" class="flex flex-wrap gap-1.5">
				<UBadge v-for="cap in agent.capabilities" :key="cap.id" color="neutral" variant="soft" size="xs">
					<span class="mr-0.5">{{ cap.icon }}</span>{{ $t(cap.labelKey) }}
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

			<!-- context 压力条 -->
			<div v-if="agent.contextPressure >= 0" class="space-y-1">
				<div class="flex items-center justify-between text-xs text-dimmed">
					<span>Context</span>
					<span :class="contextPressureColor">{{ agent.contextPressure }}%</span>
				</div>
				<div class="h-1 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
					<div
						class="h-full rounded-full transition-all"
						:class="contextPressureBarColor"
						:style="`width:${agent.contextPressure}%`"
					></div>
				</div>
			</div>

			<!-- 7 天 token 趋势 -->
			<div v-if="hasSparklineData" class="flex items-end gap-px h-8">
				<div
					v-for="(val, i) in agent.sparkline"
					:key="i"
					class="flex-1 rounded-sm bg-primary/40 transition-all"
					:style="`height:${sparklineBarHeight(val)}%`"
					:title="`Day ${i + 1}: ${val} tokens`"
				></div>
			</div>

			<!-- 最近对话 -->
			<div v-if="agent.recentSessions?.length" class="space-y-1">
				<p class="text-xs text-dimmed">{{ $t('dashboard.recentChats') }}</p>
				<ul class="space-y-0.5">
					<li
						v-for="s in agent.recentSessions"
						:key="s.key"
						class="flex items-center justify-between text-xs truncate cursor-pointer hover:text-primary transition-colors"
						@click="$emit('open-session', s.key)"
					>
						<span class="truncate">{{ s.label || s.key }}</span>
						<span class="ml-2 shrink-0 text-dimmed">{{ formatTimeAgo(s.updatedAt) }}</span>
					</li>
				</ul>
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
	emits: ['chat', 'open-session'],
	computed: {
		contextPressureColor() {
			if (this.agent.contextPressure >= 90) return 'text-red-500';
			if (this.agent.contextPressure >= 70) return 'text-yellow-500';
			return 'text-green-500';
		},
		contextPressureBarColor() {
			if (this.agent.contextPressure >= 90) return 'bg-red-500';
			if (this.agent.contextPressure >= 70) return 'bg-yellow-400';
			return 'bg-green-400';
		},
		hasSparklineData() {
			return this.agent.sparkline?.length > 0 && this.agent.sparkline.some(v => v > 0);
		},
		sparklineMax() {
			return Math.max(...(this.agent.sparkline ?? []), 1);
		},
	},
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
		sparklineBarHeight(val) {
			return Math.max(8, Math.round((val / this.sparklineMax) * 100));
		},
	},
};
</script>
