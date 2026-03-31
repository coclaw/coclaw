<template>
	<main class="flex-1 overflow-auto px-3 pt-4 pb-8 sm:px-4 lg:px-5">
		<section class="mx-auto flex w-full max-w-5xl flex-col gap-5">
			<div class="flex items-center justify-between gap-3">
				<h1 class="text-base font-medium">{{ $t('bots.pageTitle') }}</h1>
				<div class="flex items-center gap-2">
					<UButton data-testid="btn-refresh-bots" class="cc-icon-btn" color="primary" variant="ghost" size="md" icon="i-lucide-refresh-cw" :loading="loading" @click="loadData" />
					<UButton data-testid="btn-add-bot" color="primary" variant="soft" @click="$router.push('/bots/add')">
						{{ $t('bots.addBot') }}
					</UButton>
				</div>
			</div>

			<p v-if="!loading && !bots.length" class="text-sm text-muted">{{ $t('bots.noBot') }}</p>

			<div v-for="bot in bots" :key="bot.id" :data-testid="`bot-${bot.id}`" class="space-y-4">
				<InstanceOverview
					v-if="getDashboardData(bot.id)?.instance"
					:instance="getDashboardData(bot.id).instance"
					:agent-count="getDashboardData(bot.id).agents?.length ?? 0"
				/>
				<!-- 离线 / 数据未加载时的 fallback header -->
				<div v-else class="rounded-xl bg-elevated p-4 sm:p-5">
					<div class="flex items-center gap-2">
						<span class="inline-block size-2.5 rounded-full bg-gray-500"></span>
						<h2 class="text-lg font-semibold">{{ bot.name }}</h2>
						<UBadge color="neutral" variant="subtle" size="xs">{{ $t('dashboard.offline') }}</UBadge>
					</div>
				</div>

				<!-- 实例状态条汇总 -->
				<div v-if="bot.online" class="flex items-center gap-1.5 px-1 text-sm text-muted" data-testid="status-bar">
					<template v-if="instanceRunningCount(bot.id) === 0 && instanceFailedCount(bot.id) === 0">
						<span>{{ $t('bots.statusNormal', { n: instanceAgentCount(bot.id) }) }}</span>
					</template>
					<template v-else>
						<span>{{ $t('bots.statusAgents', { n: instanceAgentCount(bot.id) }) }}</span>
						<span v-if="instanceRunningCount(bot.id) > 0" class="text-blue-500">
							· {{ $t('bots.statusRunning', { n: instanceRunningCount(bot.id) }) }}
						</span>
						<span v-if="instanceFailedCount(bot.id) > 0" class="text-red-500">
							· {{ $t('bots.statusFailed', { n: instanceFailedCount(bot.id) }) }}
						</span>
					</template>
				</div>

				<!-- 连接信息 + 解绑 -->
				<div class="flex items-center gap-x-3 gap-y-1 px-1">
					<div v-if="bot.online" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
						<span>{{ connLabel(bot.id) }}</span>
						<button
							v-if="hasConnDetail(bot.id)"
							class="inline-flex items-center gap-0.5 underline decoration-dotted underline-offset-2 opacity-70 hover:opacity-100"
							@click="toggleDetail(bot.id)"
						>
							{{ $t('bots.conn.detailTitle') }}
							<UIcon :name="expandedDetails[bot.id] ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-3.5" />
						</button>
					</div>
					<div class="ml-auto">
						<UButton
							color="error"
							variant="soft"
							size="sm"
							:loading="unbindingId === bot.id"
							@click="onUnbindByUser(bot.id)"
						>
							{{ $t('bots.unbind') }}
						</UButton>
					</div>
				</div>
				<div v-if="bot.online && expandedDetails[bot.id] && getConnDetail(bot.id)" class="rounded-lg bg-elevated px-3 py-2 text-xs text-muted">
					<p>{{ $t('bots.conn.localCandidate') }}：{{ getConnDetail(bot.id).localType }} · {{ getConnDetail(bot.id).localProtocol?.toUpperCase() }}</p>
					<p>{{ $t('bots.conn.remoteCandidate') }}：{{ getConnDetail(bot.id).remoteType }} · {{ getConnDetail(bot.id).remoteProtocol?.toUpperCase() }}</p>
					<p>{{ $t('bots.conn.relayProtocol') }}：{{ getConnDetail(bot.id).relayProtocol?.toUpperCase() ?? '—' }}</p>
				</div>

				<!-- Agent 列表（状态驱动排序） -->
				<div class="flex flex-col gap-2">
					<AgentCard
						v-for="agentBot in sortedAgentBots(bot.id)"
						:key="agentBot.id"
						:bot="agentBot"
						@chat="goToAgent(bot.id, $event)"
						@files="goToFiles(bot.id, $event)"
					/>
				</div>

				<div v-if="getDashboardData(bot.id)?.loading" class="flex items-center justify-center py-8">
					<UButton loading variant="ghost" disabled>{{ $t('bots.preparing') }}</UButton>
				</div>
			</div>
		</section>
	</main>
</template>

<script>
import { useNotify } from '../composables/use-notify.js';
import { unbindBotByUser } from '../services/bots.api.js';
import { useBotsStore } from '../stores/bots.store.js';
import { useDashboardStore } from '../stores/dashboard.store.js';
import { useAgentRunsStore } from '../stores/agent-runs.store.js';
import InstanceOverview from '../components/dashboard/InstanceOverview.vue';
import AgentCard from '../components/AgentCard.vue';

/** 状态权重：数值越小越靠前 */
const STATUS_ORDER = { failed: 0, running: 1, connecting: 2, idle: 3, offline: 4 };

/**
 * 从 bot 对象判断 AgentCard 对应的状态 key
 * @param {object} bot - botsStore 中的 bot 对象
 * @param {object} agentRunsStore
 * @param {string} runKey
 * @returns {'failed'|'running'|'connecting'|'idle'|'offline'}
 */
function getBotStatus(bot, agentRunsStore, runKey) {
	if (!bot.online) return 'offline';
	if (bot.rtcPhase === 'failed') return 'failed';
	if (bot.rtcPhase === 'building' || bot.rtcPhase === 'recovering') return 'connecting';
	if (agentRunsStore?.isRunning(runKey)) return 'running';
	return 'idle';
}

export default {
	name: 'ManageBotsPage',
	components: { InstanceOverview, AgentCard },
	setup() {
		return { notify: useNotify() };
	},
	data() {
		return {
			loading: false,
			unbindingId: '',
			botsStore: null,
			dashboardStore: null,
			agentRunsStore: null,
			expandedDetails: {},
		};
	},
	computed: {
		bots() {
			return this.botsStore?.items ?? [];
		},
	},
	async mounted() {
		this.botsStore = useBotsStore();
		this.dashboardStore = useDashboardStore();
		this.agentRunsStore = useAgentRunsStore();

		this.__lastResumeAt = 0;
		this.__onResume = () => {
			const now = Date.now();
			if (now - this.__lastResumeAt < 2000) return;
			this.__lastResumeAt = now;
			this.loadData();
		};
		this.__onVisibility = () => {
			if (document.visibilityState === 'visible') this.__onResume();
		};
		window.addEventListener('app:foreground', this.__onResume);
		document.addEventListener('visibilitychange', this.__onVisibility);

		await this.loadData();
	},
	beforeUnmount() {
		if (this.__onResume) {
			window.removeEventListener('app:foreground', this.__onResume);
		}
		if (this.__onVisibility) {
			document.removeEventListener('visibilitychange', this.__onVisibility);
		}
	},
	methods: {
		getDashboardData(botId) {
			return this.dashboardStore?.getDashboard(String(botId)) ?? null;
		},

		/**
		 * 对当前 bot 下的"agent 代理 bot 对象"按状态排序
		 * 当前版本每个 bot 只有 main agent，直接返回该 bot 自身的包装
		 * 多 agent 场景预留：按 dashboard agents 扩展
		 * @param {string} botId
		 * @returns {object[]}
		 */
		sortedAgentBots(botId) {
			const id = String(botId);
			const bot = this.botsStore?.byId[id];
			if (!bot) return [];
			// 当前版本：每个 bot 实例对应一个 AgentCard（main agent）
			return [bot];
		},

		/**
		 * 返回该实例 agent 数量
		 * @param {string} botId
		 */
		instanceAgentCount(botId) {
			const dash = this.getDashboardData(botId);
			return dash?.agents?.length ?? 1;
		},

		/**
		 * 返回该实例 running 状态数量
		 * @param {string} botId
		 */
		instanceRunningCount(botId) {
			const id = String(botId);
			const bot = this.botsStore?.byId[id];
			if (!bot) return 0;
			const runKey = `agent:main:main`;
			const status = getBotStatus(bot, this.agentRunsStore, runKey);
			return status === 'running' ? 1 : 0;
		},

		/**
		 * 返回该实例 failed 状态数量
		 * @param {string} botId
		 */
		instanceFailedCount(botId) {
			const id = String(botId);
			const bot = this.botsStore?.byId[id];
			if (!bot) return 0;
			return bot.rtcPhase === 'failed' ? 1 : 0;
		},

		connLabel(botId) {
			const id = String(botId);
			const bot = this.botsStore?.byId[id];
			if (!bot) return this.$t('bots.conn.disconnected');
			if (bot.rtcPhase === 'failed') return this.$t('bots.conn.rtcFailed');
			if (bot.rtcPhase !== 'ready') return this.$t('bots.conn.rtcConnecting');
			const info = bot.rtcTransportInfo;
			if (!info) return this.$t('bots.conn.rtcConnecting');
			if (info.localType === 'relay') {
				const rp = (info.relayProtocol ?? 'udp').toLowerCase();
				return rp === 'udp'
					? this.$t('bots.conn.rtcRelay')
					: this.$t('bots.conn.rtcRelayProto', { protocol: rp.toUpperCase() });
			}
			const isLan = info.localType === 'host';
			const proto = (info.localProtocol ?? 'udp').toLowerCase();
			if (proto === 'udp') {
				return this.$t(isLan ? 'bots.conn.rtcLan' : 'bots.conn.rtcP2P');
			}
			const key = isLan ? 'bots.conn.rtcLanProto' : 'bots.conn.rtcP2PProto';
			return this.$t(key, { protocol: proto.toUpperCase() });
		},
		hasConnDetail(botId) {
			return !!this.botsStore?.byId[String(botId)]?.rtcTransportInfo;
		},
		getConnDetail(botId) {
			return this.botsStore?.byId[String(botId)]?.rtcTransportInfo ?? null;
		},
		toggleDetail(botId) {
			const id = String(botId);
			this.expandedDetails = { ...this.expandedDetails, [id]: !this.expandedDetails[id] };
		},
		goToFiles(botId, _agentBotId) {
			// AgentCard emit files 传来的是 bot.id（当前版本 agentBotId === botId）
			const id = String(botId);
			if (this.botsStore?.byId[id]?.pluginVersionOk === false) {
				this.notify.warning(this.$t('pluginUpgrade.outdated'));
				return;
			}
			this.$router.push({
				name: 'files',
				params: { botId: id, agentId: 'main' },
			});
		},
		goToAgent(botId, _agentBotId) {
			const id = String(botId);
			if (this.botsStore?.byId[id]?.pluginVersionOk === false) {
				this.notify.warning(this.$t('pluginUpgrade.outdated'));
			}
			this.$router.push({
				name: 'chat',
				params: { botId: id, agentId: 'main' },
			});
		},
		async loadData() {
			if (this.loading) return;
			this.loading = true;
			try {
				// bot 列表由 SSE 快照维护；等待 fetched 后只加载 dashboard
				if (!this.botsStore?.fetched) {
					await new Promise((resolve) => {
						const timer = setTimeout(() => { unwatch(); resolve(); }, 10_000);
						const unwatch = this.$watch(
							() => this.botsStore?.fetched,
							(val) => {
								if (val) { clearTimeout(timer); unwatch(); resolve(); }
							},
							{ immediate: true },
						);
					});
				}
				await Promise.allSettled(
					this.bots.map(bot => this.dashboardStore.loadDashboard(String(bot.id)))
				);
			}
			catch (err) {
				console.warn('[ManageBotsPage] loadData failed:', err);
				this.notify.error(err?.response?.data?.message ?? err?.message ?? this.$t('bots.loadFailed'));
			}
			finally {
				this.loading = false;
			}
		},
		async onUnbindByUser(botId) {
			if (this.unbindingId) return;
			this.unbindingId = String(botId);
			try {
				await unbindBotByUser(botId);
				this.dashboardStore.clearDashboard(botId);
				await this.loadData();
				this.notify.success(this.$t('bots.unbindSuccess'));
			}
			catch (err) {
				console.warn('[ManageBotsPage] onUnbindByUser failed:', err);
				this.notify.error(err?.response?.data?.message ?? err?.message ?? this.$t('bots.unbindFailed'));
			}
			finally {
				this.unbindingId = '';
			}
		},
	},
};
</script>
