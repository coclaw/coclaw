<template>
	<div
		class="rounded-xl border overflow-hidden transition-colors"
		:class="borderClass"
		:data-testid="`agent-card-${bot.id}`"
	>
		<!-- 头部：状态点 + 名称 + 计时/状态文字 -->
		<div
			class="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none"
			@click="toggleExpand"
		>
			<span class="size-2.5 shrink-0 rounded-full" :class="dotClass"></span>
			<span class="flex-1 font-medium truncate text-sm">{{ displayName }}</span>

			<!-- 工作中计时 -->
			<span v-if="statusKey === 'running'" class="text-xs text-blue-500 shrink-0">
				{{ $t('agentCard.running') }} {{ elapsedText }}
			</span>

			<!-- 连接中 -->
			<span v-else-if="statusKey === 'connecting'" class="text-xs text-yellow-600 dark:text-yellow-400 shrink-0">
				{{ connectingLabel }}
			</span>

			<!-- 展开/折叠图标（离线态） -->
			<UIcon
				v-if="statusKey === 'offline'"
				:name="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
				class="size-4 text-muted shrink-0"
			/>
		</div>

		<!-- 展开内容 -->
		<div v-if="expanded" class="border-t border-default px-3 pb-3 pt-2 space-y-2.5">

			<!-- 异常态 -->
			<template v-if="statusKey === 'failed'">
				<p class="text-xs text-danger">
					{{ $t('agentCard.rtcFailed') }}：{{ bot.rtcPhase }}
				</p>
				<p v-if="bot.lastAliveAt" class="text-xs text-muted">
					{{ $t('agentCard.lastAlive') }}：{{ formatTimeAgo(bot.lastAliveAt) }}
				</p>
				<UButton
					size="sm"
					color="primary"
					variant="soft"
					class="w-full justify-center"
					:loading="reconnecting"
					@click.stop="onReconnect"
				>
					{{ $t('agentCard.reconnectAndChat') }}
				</UButton>
			</template>

			<!-- 工作中 -->
			<template v-else-if="statusKey === 'running'">
				<AgentMetaSection :agent="dashboardAgent" />
				<TopicListSection :topics="agentTopics" :collapsed-count="3" />
				<div class="flex gap-2">
					<UButton size="sm" color="primary" class="flex-1 justify-center" @click.stop="onChat">
						{{ $t('agents.chat') }}
					</UButton>
					<UButton size="sm" color="neutral" variant="soft" class="flex-1 justify-center" @click.stop="onFiles">
						{{ $t('agents.files') }}
					</UButton>
				</div>
			</template>

			<!-- 空闲 -->
			<template v-else-if="statusKey === 'idle'">
				<AgentMetaSection :agent="dashboardAgent" show-counts />
				<div class="flex gap-2">
					<UButton size="sm" color="primary" class="flex-1 justify-center" @click.stop="onChat">
						{{ $t('agents.chat') }}
					</UButton>
					<UButton size="sm" color="neutral" variant="soft" class="flex-1 justify-center" @click.stop="onFiles">
						{{ $t('agents.files') }}
					</UButton>
				</div>
			</template>

			<!-- 连接中：无操作 -->
			<template v-else-if="statusKey === 'connecting'">
				<p class="text-xs text-muted">{{ connectingLabel }}</p>
			</template>

			<!-- 离线 -->
			<template v-else-if="statusKey === 'offline'">
				<p v-if="bot.lastAliveAt" class="text-xs text-muted">
					{{ $t('agentCard.lastAlive') }}：{{ formatTimeAgo(bot.lastAliveAt) }}
				</p>
				<p v-else class="text-xs text-muted">{{ $t('agentCard.neverOnline') }}</p>
				<TopicListSection :topics="agentTopics" :collapsed-count="3" />
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

// =====================================================================
// 内部子组件
// =====================================================================

/** Agent 模型/token/会话元信息展示 */
const AgentMetaSection = {
	name: 'AgentMetaSection',
	props: {
		agent: { type: Object, default: null },
		showCounts: { type: Boolean, default: false },
	},
	methods: {
		formatTokens(n) {
			if (typeof n !== 'number' || n <= 0) return '0';
			if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
			if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
			return String(n);
		},
	},
	template: `
		<div v-if="agent" class="space-y-1">
			<div v-if="agent.modelTags && agent.modelTags.length" class="flex flex-wrap gap-1">
				<span
					v-for="tag in agent.modelTags"
					:key="tag.labelKey || tag.label"
					class="inline-flex items-center rounded px-1.5 py-0.5 bg-primary/10 text-primary text-xs"
				>
					<span v-if="tag.icon" class="mr-0.5">{{ tag.icon }}</span>
					{{ tag.label }}
				</span>
			</div>
			<div v-if="showCounts" class="flex gap-3 text-xs text-muted">
				<span>{{ formatTokens(agent.totalTokens) }} tokens</span>
				<span>{{ agent.activeSessions }} sessions</span>
			</div>
		</div>
	`,
};

/** 话题列表（含折叠） */
const TopicListSection = {
	name: 'TopicListSection',
	props: {
		topics: { type: Array, default: () => [] },
		collapsedCount: { type: Number, default: 3 },
	},
	data() {
		return { showAll: false };
	},
	computed: {
		visibleTopics() {
			return this.showAll ? this.topics : this.topics.slice(0, this.collapsedCount);
		},
		hiddenCount() {
			return Math.max(0, this.topics.length - this.collapsedCount);
		},
	},
	template: `
		<div v-if="topics.length" class="space-y-1 text-xs text-muted">
			<p
				v-for="t in visibleTopics"
				:key="t.topicId"
				class="truncate"
				:title="t.title || ''"
				:data-testid="'topic-item'"
			>
				{{ t.title || '—' }}
			</p>
			<button
				v-if="!showAll && hiddenCount > 0"
				class="text-primary underline-offset-2 hover:underline"
				:data-testid="'topics-show-more'"
				@click.stop="showAll = true"
			>
				{{ $t('agentCard.showMoreTopics', { n: hiddenCount }) }}
			</button>
		</div>
	`,
};

// =====================================================================
// 常量
// =====================================================================

/** 主 agent ID */
const MAIN_AGENT_ID = 'main';

/** chat 模式 runKey */
function buildRunKey(agentId) {
	return `agent:${agentId}:main`;
}

// =====================================================================
// AgentCard 主组件
// =====================================================================

export default {
	name: 'AgentCard',
	components: { AgentMetaSection, TopicListSection },

	props: {
		/** 来自 botsStore 的 bot 对象 */
		bot: { type: Object, required: true },
	},

	emits: ['chat', 'files'],

	setup() {
		return { notify: useNotify() };
	},

	data() {
		return {
			botsStore: null,
			agentRunsStore: null,
			dashboardStore: null,
			topicsStore: null,
			/** 手动控制展开（仅针对 offline 等默认折叠状态） */
			manualExpanded: null,
			/** 工作中实时计时文本 */
			elapsedText: '',
			/** 计时器 ID */
			_elapsedTimer: null,
			/** 重连中 */
			reconnecting: false,
		};
	},

	computed: {
		mainRunKey() {
			return buildRunKey(MAIN_AGENT_ID);
		},

		/** dashboard 中第一个 agent（大多数 bot 只有 main 一个 agent） */
		dashboardAgent() {
			const dash = this.dashboardStore?.getDashboard(String(this.bot.id));
			return dash?.agents?.[0] ?? null;
		},

		displayName() {
			return this.dashboardAgent?.name || this.bot.name || 'Agent';
		},

		/** 该 bot 下 main agent 的话题列表 */
		agentTopics() {
			if (!this.topicsStore) return [];
			return this.topicsStore.items.filter(
				t => String(t.botId) === String(this.bot.id) && t.agentId === MAIN_AGENT_ID
			);
		},

		/**
		 * 五种状态之一：'failed' | 'running' | 'connecting' | 'idle' | 'offline'
		 */
		statusKey() {
			const bot = this.bot;
			if (!bot.online) return 'offline';
			if (bot.rtcPhase === 'failed') return 'failed';
			if (bot.rtcPhase === 'building' || bot.rtcPhase === 'recovering') return 'connecting';
			if (this.agentRunsStore?.isRunning(this.mainRunKey)) return 'running';
			return 'idle';
		},

		/** 是否自动展开（failed / running 默认展开） */
		autoExpand() {
			return this.statusKey === 'failed' || this.statusKey === 'running';
		},

		/** 当前展开状态 */
		expanded() {
			if (this.manualExpanded !== null) return this.manualExpanded;
			return this.autoExpand;
		},

		/** 边框+背景 */
		borderClass() {
			const map = {
				failed: 'border-red-400 bg-red-50 dark:bg-red-950/20',
				running: 'border-blue-400 bg-blue-50 dark:bg-blue-950/20',
				connecting: 'border-yellow-400 bg-yellow-50 dark:bg-yellow-950/20',
				idle: 'border-green-400 bg-white dark:bg-gray-900',
				offline: 'border-gray-300 bg-white dark:bg-gray-900 opacity-70',
			};
			return map[this.statusKey] ?? 'border-default';
		},

		/** 状态指示点颜色 */
		dotClass() {
			const map = {
				failed: 'bg-red-500',
				running: 'bg-blue-500 animate-pulse',
				connecting: 'bg-yellow-400 animate-pulse',
				idle: 'bg-green-400',
				offline: 'bg-gray-400',
			};
			return map[this.statusKey] ?? 'bg-gray-400';
		},

		/** 连接中状态文字 */
		connectingLabel() {
			return this.bot.rtcPhase === 'recovering'
				? this.$t('chat.connRecovering')
				: this.$t('chat.connBuilding');
		},
	},

	watch: {
		statusKey(val) {
			// 状态变化 → 重置手动展开，让 autoExpand 重新生效
			this.manualExpanded = null;
			if (val === 'running') {
				this.startElapsedTimer();
			} else {
				this.stopElapsedTimer();
			}
		},
	},

	mounted() {
		this.botsStore = useBotsStore();
		this.agentRunsStore = useAgentRunsStore();
		this.dashboardStore = useDashboardStore();
		this.topicsStore = useTopicsStore();

		if (this.statusKey === 'running') {
			this.startElapsedTimer();
		}
	},

	beforeUnmount() {
		this.stopElapsedTimer();
	},

	methods: {
		toggleExpand() {
			// 自动展开态点击不切换
			if (this.autoExpand) return;
			this.manualExpanded = !this.expanded;
		},

		startElapsedTimer() {
			this.stopElapsedTimer();
			const tick = () => {
				const runId = this.agentRunsStore?.runKeyIndex?.[this.mainRunKey];
				const run = runId ? this.agentRunsStore?.runs?.[runId] : null;
				if (!run?.startTime) {
					this.elapsedText = '';
					return;
				}
				const sec = Math.floor((Date.now() - run.startTime) / 1000);
				const m = Math.floor(sec / 60);
				const s = sec % 60;
				this.elapsedText = m > 0
					? `${m}m${String(s).padStart(2, '0')}s`
					: `${s}s`;
			};
			tick();
			this._elapsedTimer = setInterval(tick, 1000);
		},

		stopElapsedTimer() {
			if (this._elapsedTimer) {
				clearInterval(this._elapsedTimer);
				this._elapsedTimer = null;
			}
			this.elapsedText = '';
		},

		/**
		 * 格式化相对时间（支持 ms 时间戳或 ISO 字符串）
		 * @param {number|string} val
		 * @returns {string}
		 */
		formatTimeAgo(val) {
			if (!val) return '—';
			const ts = typeof val === 'number' ? val : new Date(val).getTime();
			const diff = (Date.now() - ts) / 1000;
			if (diff < 0 || Number.isNaN(diff)) return '—';
			if (diff < 60) return this.$t('dashboard.justNow');
			if (diff < 3600) return this.$t('dashboard.minutesAgo', { n: Math.floor(diff / 60) });
			if (diff < 86400) return this.$t('dashboard.hoursAgo', { n: Math.floor(diff / 3600) });
			return this.$t('dashboard.daysAgo', { n: Math.floor(diff / 86400) });
		},

		/** 重新连接 → 跳转 chat */
		async onReconnect() {
			if (this.reconnecting) return;
			this.reconnecting = true;
			try {
				await this.botsStore.__ensureRtc(String(this.bot.id));
				this.$emit('chat', this.bot.id);
			}
			catch (err) {
				console.warn('[AgentCard] onReconnect failed:', err);
				this.notify.error(err?.message ?? this.$t('bots.conn.rtcFailed'));
			}
			finally {
				this.reconnecting = false;
			}
		},

		onChat() {
			this.$emit('chat', this.bot.id);
		},

		onFiles() {
			this.$emit('files', this.bot.id);
		},
	},
};
</script>
