<template>
	<main class="flex-1 overflow-auto px-3 pt-4 pb-8 sm:px-4 lg:px-5">
		<section class="mx-auto flex w-full max-w-2xl flex-col gap-5">
			<div class="flex items-center justify-between gap-3">
				<h1 class="text-base font-medium ps-1">{{ $t('bots.pageTitle') }}</h1>
				<div class="flex items-center gap-2">
					<UButton data-testid="btn-refresh-bots" class="cc-icon-btn" color="primary" variant="ghost" size="md" icon="i-lucide-refresh-cw" :loading="loading" @click="loadData" />
					<UButton data-testid="btn-add-bot" color="primary" variant="soft" @click="$router.push('/bots/add')">
						{{ $t('bots.addBot') }}
					</UButton>
				</div>
			</div>

			<!-- 状态摘要栏：有 bot 时显示 -->
			<p
				v-if="bots.length"
				data-testid="status-summary"
				class="text-xs text-muted -mt-2 ps-1"
			>
				{{ $t('bots.summary.claws', { n: bots.length }) }}
				<template v-if="statusSummary.running > 0 || statusSummary.failed > 0">
					<span class="mx-1">·</span>
					<span v-if="statusSummary.running > 0" class="text-blue-500">{{ $t('bots.summary.running', { n: statusSummary.running }) }}</span>
					<template v-if="statusSummary.running > 0 && statusSummary.failed > 0"><span class="mx-1">·</span></template>
					<span v-if="statusSummary.failed > 0" class="text-red-500">{{ $t('bots.summary.failed', { n: statusSummary.failed }) }}</span>
				</template>
			</p>

			<p v-if="!loading && !bots.length" class="text-sm text-muted">{{ $t('bots.noBot') }}</p>

			<div v-for="{ bot, dashboard, connDetail } in botEntries" :key="bot.id" :data-testid="`bot-${bot.id}`">
				<!-- Claw card：左侧信息 + 右侧解绑 -->
				<div class="rounded-xl bg-elevated p-3 mb-3">
					<div class="flex">
						<!-- 左侧：claw 信息 -->
						<div class="flex-1 min-w-0">
							<template v-if="dashboard?.instance">
								<div class="flex items-center gap-2">
									<span
										class="inline-block size-2.5 rounded-full"
										:class="bot.online ? 'bg-green-400 animate-pulse motion-reduce:animate-none' : 'bg-gray-500'"
									></span>
									<div class="flex items-center gap-1">
										<h2 class="text-base font-semibold">{{ getClawName(bot) }}</h2>
										<UButton
											class="cc-icon-btn"
											variant="ghost"
											color="primary"
											size="md"
											icon="i-lucide-pencil"
											:disabled="renaming"
											@click="openRename(bot)"
										/>
									</div>
									<UBadge color="primary" variant="subtle" size="xs">{{ dashboard.agents?.length ?? 0 }} {{ $t('dashboard.agents') }}</UBadge>
								</div>
								<div class="mt-3 mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
									<span v-if="dashboard.instance.pluginVersion">{{ $t('bots.pluginVersion') }}{{ dashboard.instance.pluginVersion }}</span>
									<span v-if="dashboard.instance.clawVersion">{{ $t('bots.clawVersion') }}{{ dashboard.instance.clawVersion }}</span>
									<span v-if="dashboard.instance.channels?.length" class="flex items-center gap-1.5">
										<span v-for="ch in dashboard.instance.channels" :key="ch.id" class="inline-flex items-center gap-0.5" :title="ch.id">
											<span class="text-[10px]">{{ ch.connected ? '✅' : '❌' }}</span>
											<span>{{ ch.id }}</span>
										</span>
									</span>
								</div>
							</template>
							<template v-else>
								<div class="flex items-center gap-2">
									<span class="inline-block size-2.5 rounded-full bg-gray-500"></span>
									<h2 class="text-base font-semibold">{{ getClawName(bot) }}</h2>
									<UBadge color="neutral" variant="subtle" size="xs">{{ $t('dashboard.offline') }}</UBadge>
								</div>
							</template>
						</div>
						<!-- 右侧：解绑按钮 -->
						<div class="pl-3 shrink-0">
							<UButton
								color="error"
								variant="soft"
								:loading="unbindingId === bot.id"
								@click="confirmRemove(bot.id)"
							>
								{{ $t('bots.remove') }}
							</UButton>
						</div>
					</div>
				</div>

				<!-- 连接信息（在线 或 有缓存连接信息时显示） -->
				<div v-if="bot.online || connDetail" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 mb-3 text-xs text-muted">
					<span>{{ connLabel(bot.id) }}</span>
					<button
						v-if="bot.online && connDetail"
						class="inline-flex items-center gap-0.5 underline decoration-dotted underline-offset-2 opacity-70 hover:opacity-100"
						@click="toggleDetail(bot.id)"
					>
						{{ $t('bots.conn.detailTitle') }}
						<UIcon :name="expandedDetails[bot.id] ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-3.5" />
					</button>
				</div>
				<div v-if="bot.online && expandedDetails[bot.id] && connDetail" class="rounded-lg bg-elevated px-3 py-2 text-xs text-muted mb-3">
					<p>{{ $t('bots.conn.localCandidate') }}：{{ connDetail.localType }} · {{ connDetail.localProtocol?.toUpperCase() }}</p>
					<p>{{ $t('bots.conn.remoteCandidate') }}：{{ connDetail.remoteType }} · {{ connDetail.remoteProtocol?.toUpperCase() }}</p>
					<p>{{ $t('bots.conn.relayProtocol') }}：{{ connDetail.relayProtocol?.toUpperCase() ?? '—' }}</p>
				</div>

				<div class="flex flex-col gap-3">
					<AgentCard
						v-for="agent in dashboard?.agents ?? []"
						:key="agent.id"
						:agent="agent"
						:bot="bot"
						@chat="goToAgent(bot.id, $event)"
						@files="goToFiles(bot.id, $event)"
					/>
				</div>
			</div>
		</section>

		<!-- 重命名对话框 -->
		<UModal v-model:open="renameOpen" :title="$t('bots.renameClaw')" description=" " :ui="promptUi">
			<template #body>
				<UInput v-model="renameValue" autofocus class="w-full" @keydown.enter="onConfirmRename" />
			</template>
			<template #footer>
				<div class="flex w-full justify-end gap-2">
					<UButton variant="ghost" color="neutral" @click="renameOpen = false">{{ $t('common.cancel') }}</UButton>
					<UButton :disabled="!renameValue.trim()" :loading="renaming" @click="onConfirmRename">{{ $t('common.confirm') }}</UButton>
				</div>
			</template>
		</UModal>

		<!-- 移除确认对话框 -->
		<UModal v-model:open="removeConfirmOpen" :title="$t('bots.removeConfirmTitle')" description=" " :ui="promptUi">
			<template #body>
				<p class="text-sm text-muted">{{ $t('bots.removeConfirmDesc') }}</p>
			</template>
			<template #footer>
				<div class="flex w-full justify-end gap-2">
					<UButton variant="ghost" color="neutral" @click="removeConfirmOpen = false">{{ $t('common.cancel') }}</UButton>
					<UButton color="error" :loading="!!unbindingId" @click="onConfirmRemove">{{ $t('common.confirm') }}</UButton>
				</div>
			</template>
		</UModal>
	</main>
</template>

<script>
import { useNotify } from '../composables/use-notify.js';
import { unbindBotByUser } from '../services/bots.api.js';
import { promptModalUi } from '../constants/prompt-modal-ui.js';
import { useBotsStore, getReadyConn, MAX_BACKOFF_RETRIES } from '../stores/bots.store.js';
import { useAgentRunsStore } from '../stores/agent-runs.store.js';
import { useDashboardStore } from '../stores/dashboard.store.js';
import AgentCard from '../components/AgentCard.vue';

const RESUME_THROTTLE_MS = 2000;
const FETCHED_WAIT_MS = 10_000;

export default {
	name: 'ManageBotsPage',
	components: { AgentCard },
	setup() {
		return {
			notify: useNotify(),
			promptUi: promptModalUi,
			botsStore: useBotsStore(),
			agentRunsStore: useAgentRunsStore(),
			dashboardStore: useDashboardStore(),
		};
	},
	data() {
		return {
			loading: false,
			unbindingId: '',
			removeConfirmOpen: false,
			removeTargetId: '',
			renameOpen: false,
			renameValue: '',
			renaming: false,
			renameBotId: '',
			expandedDetails: {},
		};
	},
	computed: {
		bots() {
			return this.botsStore.items;
		},
		/** 按状态排序的 bot 列表：failed > running > connecting > idle > offline */
		sortedBots() {
			const statusPriority = (bot) => {
				if (!bot.online) return 4; // offline
				if (bot.rtcPhase === 'failed') return 0; // failed
				if (this.__hasRunningAgent(bot.id)) return 1; // running
				if (bot.rtcPhase === 'building' || bot.rtcPhase === 'recovering') return 2; // connecting
				return 3; // idle
			};
			return [...this.bots].sort((a, b) => {
				const pa = statusPriority(a);
				const pb = statusPriority(b);
				if (pa !== pb) return pa - pb;
				// 同优先级按 lastAliveAt 降序
				return (b.lastAliveAt ?? 0) - (a.lastAliveAt ?? 0);
			});
		},
		/** 状态摘要：running = 有 agent 在工作的 bot 数；failed = 连接异常的 bot 数 */
		statusSummary() {
			let running = 0;
			let failed = 0;
			for (const bot of this.bots) {
				if (!bot.online) continue;
				if (bot.rtcPhase === 'failed') {
					failed++;
				} else if (this.__hasRunningAgent(bot.id)) {
					running++;
				}
			}
			return { running, failed };
		},
		/** 排序后的 bot 列表，附带预查 dashboard 和连接详情，避免模板重复调用 */
		botEntries() {
			return this.sortedBots.map(bot => {
				const id = String(bot.id);
				return {
					bot,
					dashboard: this.dashboardStore.getDashboard(id),
					connDetail: this.botsStore.byId[id]?.rtcTransportInfo ?? null,
				};
			});
		},
	},
	async mounted() {
		this.__lastResumeAt = 0;
		this.__onResume = () => {
			const now = Date.now();
			if (now - this.__lastResumeAt < RESUME_THROTTLE_MS) return;
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
		/** 检查 bot 是否有任一 agent 在工作中 */
		__hasRunningAgent(botId) {
			const agents = this.dashboardStore.getDashboard(String(botId))?.agents ?? [];
			return agents.some(a => this.agentRunsStore.isRunning(`agent:${a.id}:main`));
		},
		connLabel(botId) {
			const id = String(botId);
			const bot = this.botsStore.byId[id];
			if (!bot) return this.$t('bots.conn.disconnected');
			if (!bot.online) return this.$t('bots.conn.disconnected');
			if (bot.rtcPhase === 'failed') {
				if (bot.retryCount > 0) {
					return this.$t('bots.conn.rtcRetrying', { n: bot.retryCount, max: MAX_BACKOFF_RETRIES });
				}
				return this.$t('bots.conn.rtcRetryExhausted');
			}
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
		toggleDetail(botId) {
			const id = String(botId);
			this.expandedDetails[id] = !this.expandedDetails[id];
		},
		goToFiles(botId, agentId) {
			if (this.botsStore.byId[String(botId)]?.pluginVersionOk === false) {
				this.notify.warning(this.$t('pluginUpgrade.outdated'));
				return;
			}
			this.$router.push({
				name: 'files',
				params: { botId: String(botId), agentId: String(agentId) },
			});
		},
		goToAgent(botId, agentId) {
			if (this.botsStore.byId[String(botId)]?.pluginVersionOk === false) {
				this.notify.warning(this.$t('pluginUpgrade.outdated'));
			}
			this.$router.push({
				name: 'chat',
				params: { botId: String(botId), agentId },
			});
		},
		async loadData() {
			if (this.loading) return;
			this.loading = true;
			try {
				// bot 列表由 SSE 快照维护；等待 fetched 后只加载 dashboard
				if (!this.botsStore.fetched) {
					await new Promise((resolve) => {
						const timer = setTimeout(() => { unwatch(); resolve(); }, FETCHED_WAIT_MS);
						const unwatch = this.$watch(
							() => this.botsStore.fetched,
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
		getClawName(bot) {
			const pi = bot.pluginInfo;
			return pi?.name || pi?.hostName || bot.name || 'OpenClaw';
		},
		openRename(bot) {
			this.renameBotId = String(bot.id);
			this.renameValue = this.getClawName(bot);
			this.renameOpen = true;
		},
		async onConfirmRename() {
			const name = this.renameValue.trim();
			if (!name || this.renaming) return;
			this.renaming = true;
			const botId = this.renameBotId;
			const conn = getReadyConn(botId);
			if (!conn) {
				this.renaming = false;
				this.notify.error(this.$t('bots.renameFailed'));
				return;
			}
			try {
				await conn.request('coclaw.info.patch', { name });
				// 乐观更新，不依赖 event:coclaw.info.updated 广播
				const bot = this.botsStore.byId[botId];
				if (bot) {
					if (!bot.pluginInfo) bot.pluginInfo = {};
					bot.pluginInfo.name = name;
				}
				this.renameOpen = false;
			} catch (err) {
				console.warn('[ManageBotsPage] rename failed:', err);
				this.notify.error(err?.message ?? this.$t('bots.renameFailed'));
			} finally {
				this.renaming = false;
			}
		},
		confirmRemove(botId) {
			this.removeTargetId = String(botId);
			this.removeConfirmOpen = true;
		},
		async onConfirmRemove() {
			const botId = this.removeTargetId;
			if (!botId || this.unbindingId) return;
			this.unbindingId = botId;
			try {
				await unbindBotByUser(botId);
				this.removeConfirmOpen = false;
				this.dashboardStore.clearDashboard(botId);
				await this.loadData();
			}
			catch (err) {
				console.warn('[ManageBotsPage] onConfirmRemove failed:', err);
				this.notify.error(err?.response?.data?.message ?? err?.message ?? this.$t('bots.removeFailed'));
			}
			finally {
				this.unbindingId = '';
			}
		},
	},
};
</script>
