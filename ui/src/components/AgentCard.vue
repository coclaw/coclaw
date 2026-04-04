<template>
	<div
		class="rounded-lg border border-default overflow-hidden"
		:class="statusKey === 'offline' ? 'opacity-60' : ''"
		:data-testid="`agent-card-${agent.id}`"
	>
		<!-- 两栏布局：左侧信息区 + 右侧按钮区 -->
		<div class="flex p-3">
			<!-- 左栏：名称 + 基本信息 + 详情入口 -->
			<div class="flex-1 min-w-0">
				<!-- 第一行：状态点 + 名称 + 模型标签 + running 计时 -->
				<div class="flex items-center gap-2">
					<span class="size-2 shrink-0 rounded-full" :class="dotClass"></span>
					<span class="font-medium truncate text-sm">{{ agent.name }}</span>
					<UBadge v-if="modelLabel" color="primary" variant="subtle" size="xs">{{ modelLabel }}</UBadge>
					<span v-if="statusKey === 'running'" class="text-xs text-blue-500 font-mono shrink-0">
						{{ elapsedText }}
					</span>
				</div>

				<!-- 离线时显示 lastAlive -->
				<div v-if="statusKey === 'offline'" class="mt-3 pl-4">
					<p class="text-xs text-muted">{{ $t('agentCard.lastAlive') }}：{{ formatRelativeTime(bot.lastAliveAt) }}</p>
				</div>

				<!-- 数据区：tokens / 会话 / 最近活跃（始终显示缓存数据） -->
				<div class="mt-3 flex flex-wrap items-end gap-x-5 gap-y-1 text-xs text-dimmed">
					<div>
						<p class="text-sm font-medium text-default">{{ formatTokens(agent.totalTokens) }}</p>
						<p>{{ $t('dashboard.tokens') }}</p>
					</div>
					<div>
						<p class="text-sm font-medium text-default">{{ agent.activeSessions }}</p>
						<p>{{ $t('dashboard.sessions') }}</p>
					</div>
					<div>
						<p class="text-sm font-medium text-default">{{ formatRelativeTime(agent.lastActivity) }}</p>
						<p>{{ $t('dashboard.lastActive') }}</p>
					</div>
				</div>

				<!-- 详情展开/收起入口 -->
				<button
					v-if="hasDetails"
					class="mt-2 inline-flex items-center gap-0.5 text-xs text-muted underline decoration-dotted underline-offset-2 opacity-70 hover:opacity-100"
					data-testid="btn-details"
					@click="expanded = !expanded"
				>
					{{ $t('bots.conn.detailTitle') }}
					<UIcon :name="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-3.5" />
				</button>
			</div>

			<!-- 右栏：操作按钮（bot 在线时显示） -->
			<div v-if="bot.online" class="grid gap-3 pl-3 self-center shrink-0">
				<UButton
					data-testid="btn-chat"
					color="primary"
					class="justify-center"
					@click="$emit('chat', agent.id)"
				>{{ $t('agents.chat') }}</UButton>
				<UButton
					data-testid="btn-files"
					color="primary"
					variant="outline"
					class="justify-center"
					@click="$emit('files', agent.id)"
				>{{ $t('agents.files') }}</UButton>
			</div>
		</div>

		<!-- 展开详情 -->
		<div v-if="expanded" class="border-t border-default px-3 pb-3 pt-2 space-y-2">
			<!-- 可用工具（排在 topics 前） -->
			<div v-if="agent.capabilities?.length" class="flex flex-wrap gap-1.5">
				<UBadge
					v-for="cap in agent.capabilities"
					:key="cap.id"
					color="neutral"
					variant="soft"
					size="md"
				>
					<span class="mr-0.5">{{ cap.icon }}</span>{{ $t(cap.labelKey) }}
				</UBadge>
			</div>
			<!-- topics -->
			<div v-if="agentTopics.length" class="space-y-1">
				<div
					v-for="topic in visibleTopics"
					:key="topic.topicId"
					class="text-xs text-muted truncate pl-1 border-l-2 border-blue-300"
				>
					{{ topic.title || $t('topic.newTopic') }}
				</div>
				<button
					v-if="agentTopics.length > 3 && !showAllTopics"
					class="text-xs text-primary underline decoration-dotted"
					@click.stop="showAllTopics = true"
				>
					{{ $t('agentCard.viewMore', { n: agentTopics.length - 3 }) }}
				</button>
			</div>
		</div>
	</div>
</template>

<script>
import { useAgentRunsStore } from '../stores/agent-runs.store.js';
import { useTopicsStore } from '../stores/topics.store.js';

export default {
	name: 'AgentCard',

	props: {
		/** dashboardStore.getDashboard(botId).agents[] 中的单个 agent */
		agent: { type: Object, required: true },
		/** botsStore 中的 bot 对象，提供连接状态 */
		bot: { type: Object, required: true },
	},

	emits: ['chat', 'files'],

	setup() {
		return {
			agentRunsStore: useAgentRunsStore(),
			topicsStore: useTopicsStore(),
		};
	},

	data() {
		return {
			expanded: false,
			elapsedSecs: 0,
			showAllTopics: false,
		};
	},

	computed: {
		/**
		 * agent 级状态：仅关注 agent 自身运行状态，不反映 claw 级连接状态
		 * @returns {'running' | 'idle' | 'offline'}
		 */
		statusKey() {
			if (!this.bot.online) return 'offline';
			const runKey = `agent:${this.agent.id}:main`;
			if (this.agentRunsStore.isRunning(runKey)) return 'running';
			return 'idle';
		},

		dotClass() {
			const map = {
				running: 'bg-blue-400 animate-pulse',
				idle: 'bg-green-400',
				offline: 'bg-gray-400',
			};
			return map[this.statusKey] ?? 'bg-gray-400';
		},

		elapsedText() {
			const s = this.elapsedSecs;
			const m = Math.floor(s / 60);
			const sec = s % 60;
			if (m === 0) return `${sec}s`;
			return `${m}m ${sec}s`;
		},

		modelLabel() {
			const tags = this.agent.modelTags;
			return tags?.[0]?.label ?? null;
		},

		agentTopics() {
			return this.topicsStore.items.filter(
				t => t.botId === String(this.bot.id) && t.agentId === this.agent.id
			);
		},

		visibleTopics() {
			if (this.showAllTopics) return this.agentTopics;
			return this.agentTopics.slice(0, 3);
		},

		/** 是否有可展开的详情（capabilities 或 topics） */
		hasDetails() {
			return (this.agent.capabilities?.length > 0) || (this.agentTopics.length > 0);
		},
	},

	watch: {
		statusKey(val, prev) {
			if (val === 'running') {
				this.__startTimer();
			} else if (prev === 'running') {
				this.__stopTimer();
			}
		},
	},

	mounted() {
		if (this.statusKey === 'running') {
			this.__startTimer();
		}
	},

	beforeUnmount() {
		this.__stopTimer();
	},

	methods: {
		/** @private */
		__startTimer() {
			this.__stopTimer();
			this.elapsedSecs = 0;
			const runKey = `agent:${this.agent.id}:main`;
			const run = this.agentRunsStore.getActiveRun(runKey);
			if (run?.startTime) {
				this.elapsedSecs = Math.floor((Date.now() - run.startTime) / 1000);
			}
			this.__timer = setInterval(() => { this.elapsedSecs++; }, 1000);
		},

		/** @private */
		__stopTimer() {
			if (this.__timer) {
				clearInterval(this.__timer);
				this.__timer = null;
			}
		},

		/**
		 * 统一的相对时间格式化，自动识别输入类型
		 * @param {number|string|null} value - Unix timestamp (ms) 或 ISO 时间字符串
		 * @returns {string}
		 */
		formatRelativeTime(value) {
			if (!value) return '—';
			const ms = typeof value === 'number' ? value : new Date(value).getTime();
			const diff = (Date.now() - ms) / 1000;
			if (diff < 0 || Number.isNaN(diff)) return '—';
			if (diff < 60) return this.$t('dashboard.justNow');
			if (diff < 3600) return this.$t('dashboard.minutesAgo', { n: Math.floor(diff / 60) });
			if (diff < 86400) return this.$t('dashboard.hoursAgo', { n: Math.floor(diff / 3600) });
			return this.$t('dashboard.daysAgo', { n: Math.floor(diff / 86400) });
		},

		/**
		 * @param {number} n
		 * @returns {string}
		 */
		formatTokens(n) {
			if (typeof n !== 'number' || n <= 0) return '0';
			if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
			if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
			return String(n);
		},
	},
};
</script>
