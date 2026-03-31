<template>
	<div
		class="rounded-xl border-2 bg-white dark:bg-gray-900 overflow-hidden transition-colors"
		:class="cardBorderClass"
		:data-testid="`agent-card-${bot.id}`"
	>
		<!-- 卡片头部（始终显示，可点击展开/折叠） -->
		<div
			class="flex items-center gap-3 px-3 py-3 cursor-pointer select-none"
			:class="statusKey === 'offline' ? 'cursor-pointer' : ''"
			@click="onHeaderClick"
		>
			<!-- 状态指示点 -->
			<span class="size-2.5 shrink-0 rounded-full" :class="dotClass"></span>

			<!-- 名称 -->
			<p class="font-medium flex-1 truncate">{{ bot.name }}</p>

			<!-- running 时的简要计时 -->
			<span v-if="statusKey === 'running'" class="text-xs text-blue-500 font-mono shrink-0">
				{{ elapsedText }}
			</span>

			<!-- offline 展开/折叠图标 -->
			<UIcon
				v-if="statusKey === 'offline'"
				:name="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
				class="size-4 text-muted shrink-0"
			/>
		</div>

		<!-- 展开内容区 -->
		<div v-if="expanded" class="px-3 pb-3 space-y-3 border-t border-default">

			<!-- failed 状态内容 -->
			<template v-if="statusKey === 'failed'">
				<div class="pt-2 space-y-1 text-sm">
					<p class="text-danger text-xs">{{ $t('agentCard.rtcPhase') }}：{{ bot.rtcPhase }}</p>
					<p class="text-muted text-xs">{{ $t('agentCard.lastAlive') }}：{{ formatLastAlive(bot.lastAliveAt) }}</p>
				</div>
				<UButton
					data-testid="btn-reconnect"
					color="error"
					variant="soft"
					size="sm"
					class="w-full justify-center"
					:loading="reconnecting"
					@click="onReconnect"
				>
					{{ $t('agentCard.reconnect') }}
				</UButton>
			</template>

			<!-- running 状态内容 -->
			<template v-else-if="statusKey === 'running'">
				<div class="pt-2 space-y-1 text-sm">
					<p class="text-default font-medium">{{ $t('agentCard.working') }} <span class="font-mono text-blue-500">{{ elapsedText }}</span></p>
					<p v-if="modelLabel" class="text-xs text-muted">{{ modelLabel }}</p>
					<p v-if="totalTokens > 0" class="text-xs text-muted">{{ formatTokens(totalTokens) }} tokens</p>
				</div>
				<!-- topic 列表 -->
				<div v-if="agentTopics.length" class="space-y-1">
					<div
						v-for="topic in visibleTopics"
						:key="topic.topicId"
						class="text-xs text-muted truncate pl-1 border-l-2 border-blue-300"
					>
						{{ topic.title || $t('agentCard.mainTopic') }}
					</div>
					<button
						v-if="agentTopics.length > 3 && !showAllTopics"
						class="text-xs text-primary underline decoration-dotted"
						@click.stop="showAllTopics = true"
					>
						{{ $t('agentCard.viewMore', { n: agentTopics.length - 3 }) }}
					</button>
				</div>
				<!-- 操作 -->
				<div class="grid grid-cols-2 gap-2 pt-1">
					<UButton
						data-testid="btn-chat"
						color="primary"
						size="sm"
						class="justify-center"
						@click="$emit('chat', bot.agentId)"
					>{{ $t('agents.chat') }}</UButton>
					<UButton
						data-testid="btn-files"
						color="primary"
						variant="outline"
						size="sm"
						class="justify-center"
						@click="$emit('files', bot.agentId)"
					>{{ $t('agents.files') }}</UButton>
				</div>
			</template>

			<!-- idle 状态内容 -->
			<template v-else-if="statusKey === 'idle'">
				<div class="pt-2 space-y-1 text-sm">
					<p v-if="modelLabel" class="text-xs text-muted">{{ modelLabel }}</p>
					<p v-if="totalTokens > 0" class="text-xs text-muted">{{ formatTokens(totalTokens) }} tokens</p>
					<p class="text-xs text-muted">
						{{ $t('agentCard.sessions') }}：{{ sessionCount }}
						<span v-if="topicCount > 0"> · {{ $t('agentCard.topics') }}：{{ topicCount }}</span>
					</p>
				</div>
				<div class="grid grid-cols-2 gap-2 pt-1">
					<UButton
						data-testid="btn-chat"
						color="primary"
						size="sm"
						class="justify-center"
						@click="$emit('chat', bot.agentId)"
					>{{ $t('agents.chat') }}</UButton>
					<UButton
						data-testid="btn-files"
						color="primary"
						variant="outline"
						size="sm"
						class="justify-center"
						@click="$emit('files', bot.agentId)"
					>{{ $t('agents.files') }}</UButton>
				</div>
			</template>

			<!-- connecting 状态内容 -->
			<template v-else-if="statusKey === 'connecting'">
				<div class="pt-2 text-sm text-muted">
					<p>{{ connectingLabel }}</p>
				</div>
			</template>

			<!-- offline 状态内容 -->
			<template v-else-if="statusKey === 'offline'">
				<div class="pt-2 space-y-1 text-sm">
					<p class="text-xs text-muted">{{ $t('agentCard.lastAlive') }}：{{ formatLastAlive(bot.lastAliveAt) }}</p>
					<p v-if="topicCount > 0" class="text-xs text-muted">{{ $t('agentCard.topics') }}（{{ $t('agentCard.cached') }}）：{{ topicCount }}</p>
				</div>
			</template>
		</div>
	</div>
</template>

<script>
import { useBotsStore } from '../stores/bots.store.js';
import { useAgentRunsStore } from '../stores/agent-runs.store.js';
import { useDashboardStore } from '../stores/dashboard.store.js';
import { useTopicsStore } from '../stores/topics.store.js';
import { useNotify } from '../composables/use-notify.js';

export default {
	name: 'AgentCard',

	props: {
		/** botsStore 中的单个 bot 对象 */
		bot: { type: Object, required: true },
	},

	emits: ['chat', 'files'],

	setup() {
		return { notify: useNotify() };
	},

	data() {
		return {
			/** 仅 offline 时用于手动展开 */
			expanded: false,
			/** running 计时（秒） */
			elapsedSecs: 0,
			/** 计时器句柄 */
			_timer: null,
			botsStore: null,
			agentRunsStore: null,
			dashboardStore: null,
			topicsStore: null,
			reconnecting: false,
			showAllTopics: false,
		};
	},

	computed: {
		/**
		 * 五种状态之一：'failed' | 'running' | 'connecting' | 'idle' | 'offline'
		 * @returns {string}
		 */
		statusKey() {
			const bot = this.bot;
			if (!bot.online) return 'offline';
			if (bot.rtcPhase === 'failed') return 'failed';
			const runKey = `agent:${bot.agentId}:main`;
			if (this.agentRunsStore?.isRunning(runKey)) return 'running';
			if (bot.rtcPhase === 'building' || bot.rtcPhase === 'recovering') return 'connecting';
			return 'idle';
		},

		/** 卡片边框 class */
		cardBorderClass() {
			const map = {
				failed: 'border-red-400 dark:border-red-500',
				running: 'border-blue-400 dark:border-blue-500',
				connecting: 'border-yellow-400 dark:border-yellow-500',
				idle: 'border-green-400 dark:border-green-500',
				offline: 'border-gray-300 dark:border-gray-600 opacity-70',
			};
			return map[this.statusKey] ?? '';
		},

		/** 状态指示点 class */
		dotClass() {
			const map = {
				failed: 'bg-red-400',
				running: 'bg-blue-400 animate-pulse',
				connecting: 'bg-yellow-400 animate-pulse',
				idle: 'bg-green-400',
				offline: 'bg-gray-400',
			};
			return map[this.statusKey] ?? 'bg-gray-400';
		},

		/** running 计时文字 */
		elapsedText() {
			const s = this.elapsedSecs;
			const m = Math.floor(s / 60);
			const sec = s % 60;
			if (m === 0) return `${sec}s`;
			return `${m}m ${sec}s`;
		},

		/** connecting 文字 */
		connectingLabel() {
			const phase = this.bot.rtcPhase;
			if (phase === 'recovering') return this.$t('chat.connRecovering');
			return this.$t('chat.connBuilding');
		},

		/** 当前 bot 的 dashboard 数据 */
		dashboardData() {
			return this.dashboardStore?.getDashboard(String(this.bot.id)) ?? null;
		},

		/** 模型标签文字（取第一条 modelTag label） */
		modelLabel() {
			const tags = this.dashboardData?.agents?.find(a => a.id === this.bot.agentId)?.modelTags;
			return tags?.[0]?.label ?? null;
		},

		/** token 总量 */
		totalTokens() {
			return this.dashboardData?.agents?.find(a => a.id === this.bot.agentId)?.totalTokens ?? 0;
		},

		/** session 数量 */
		sessionCount() {
			return this.dashboardData?.agents?.find(a => a.id === this.bot.agentId)?.activeSessions ?? 0;
		},

		/** 当前 agent 的 topic 列表 */
		agentTopics() {
			if (!this.topicsStore) return [];
			return this.topicsStore.items.filter(
				t => t.botId === String(this.bot.id) && t.agentId === (this.bot.agentId ?? 'main')
			);
		},

		topicCount() {
			return this.agentTopics.length;
		},

		/** topic 列表展示（超3条折叠） */
		visibleTopics() {
			if (this.showAllTopics) return this.agentTopics;
			return this.agentTopics.slice(0, 3);
		},
	},

	watch: {
		/** statusKey 变为 running 时启动计时；离开时停止 */
		statusKey(val, prev) {
			if (val === 'running') {
				this.startTimer();
			}
			else if (prev === 'running') {
				this.stopTimer();
			}
			// 非 offline 状态时自动展开
			if (val === 'failed' || val === 'running') {
				this.expanded = true;
			}
		},
	},

	mounted() {
		this.botsStore = useBotsStore();
		this.agentRunsStore = useAgentRunsStore();
		this.dashboardStore = useDashboardStore();
		this.topicsStore = useTopicsStore();

		// 初始化展开状态
		if (this.statusKey === 'failed' || this.statusKey === 'running') {
			this.expanded = true;
		}
		else if (this.statusKey !== 'offline') {
			this.expanded = true;
		}

		// running 时启动计时
		if (this.statusKey === 'running') {
			this.startTimer();
		}
	},

	beforeUnmount() {
		this.stopTimer();
	},

	methods: {
		onHeaderClick() {
			// 仅 offline 时点击头部切换展开
			if (this.statusKey === 'offline') {
				this.expanded = !this.expanded;
			}
		},

		startTimer() {
			this.stopTimer();
			this.elapsedSecs = 0;
			const runKey = `agent:${this.bot.agentId}:main`;
			// 从 run.startTime 算起
			const run = this.agentRunsStore?.getActiveRun(runKey);
			if (run?.startTime) {
				this.elapsedSecs = Math.floor((Date.now() - run.startTime) / 1000);
			}
			this._timer = setInterval(() => {
				this.elapsedSecs++;
			}, 1000);
		},

		stopTimer() {
			if (this._timer) {
				clearInterval(this._timer);
				this._timer = null;
			}
		},

		async onReconnect() {
			if (this.reconnecting) return;
			this.reconnecting = true;
			try {
				await this.botsStore?.__ensureRtc(this.bot.id);
				this.$emit('chat', this.bot.agentId);
			}
			catch (err) {
				this.notify.error(err?.message ?? this.$t('agentCard.reconnectFailed'));
			}
			finally {
				this.reconnecting = false;
			}
		},

		/**
		 * 格式化最后心跳时间
		 * @param {number} ts - Unix timestamp (ms)
		 * @returns {string}
		 */
		formatLastAlive(ts) {
			if (!ts) return '—';
			const diff = (Date.now() - ts) / 1000;
			if (diff < 60) return this.$t('dashboard.justNow');
			if (diff < 3600) return this.$t('dashboard.minutesAgo', { n: Math.floor(diff / 60) });
			if (diff < 86400) return this.$t('dashboard.hoursAgo', { n: Math.floor(diff / 3600) });
			return this.$t('dashboard.daysAgo', { n: Math.floor(diff / 86400) });
		},

		/**
		 * 格式化 token 数量
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
