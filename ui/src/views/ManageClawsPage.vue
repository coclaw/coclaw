<template>
	<main class="flex-1 overflow-auto px-3 pt-4 pb-8 sm:px-4 lg:px-5">
		<section class="mx-auto flex w-full max-w-2xl flex-col gap-5">
			<div class="flex items-center justify-between gap-3">
				<h1 class="text-base font-medium ps-1">{{ $t('claws.pageTitle') }}</h1>
				<div class="flex items-center gap-2">
					<UButton data-testid="btn-refresh-claws" class="cc-icon-btn" color="primary" variant="ghost" size="md" icon="i-lucide-refresh-cw" :loading="loading" @click="loadData" />
					<UButton data-testid="btn-add-claw" color="primary" variant="soft" @click="$router.push('/claws/add')">
						{{ $t('claws.addClaw') }}
					</UButton>
				</div>
			</div>

			<!-- 状态摘要栏：有 claw 时显示 -->
			<p
				v-if="claws.length"
				data-testid="status-summary"
				class="text-xs text-muted -mt-2 ps-1"
			>
				{{ $t('claws.summary.claws', { n: claws.length }) }}
				<template v-if="statusSummary.running > 0 || statusSummary.failed > 0">
					<span class="mx-1">·</span>
					<span v-if="statusSummary.running > 0" class="text-blue-500">{{ $t('claws.summary.running', { n: statusSummary.running }) }}</span>
					<template v-if="statusSummary.running > 0 && statusSummary.failed > 0"><span class="mx-1">·</span></template>
					<span v-if="statusSummary.failed > 0" class="text-red-500">{{ $t('claws.summary.failed', { n: statusSummary.failed }) }}</span>
				</template>
			</p>

			<p v-if="!loading && !claws.length" class="text-sm text-muted">{{ $t('claws.noClaw') }}</p>

			<div v-for="{ claw, dashboard, connDetail, rtcPhase } in clawEntries" :key="claw.id" :data-testid="`claw-${claw.id}`">
				<!-- Claw card：左侧信息 + 右侧解绑 -->
				<div class="rounded-xl bg-elevated p-3 mb-3">
					<div class="flex">
						<!-- 左侧：claw 信息 -->
						<div class="flex-1 min-w-0">
							<template v-if="dashboard?.instance">
								<div class="flex items-center gap-2">
									<span
										class="inline-block size-2.5 rounded-full"
										:class="clawDotClass(claw)"
									></span>
									<div class="flex items-center gap-1">
										<h2 class="text-base font-semibold">{{ getClawName(claw) }}</h2>
										<UButton
											class="cc-icon-btn"
											variant="ghost"
											color="primary"
											size="md"
											icon="i-lucide-pencil"
											:disabled="renaming || !claw.online"
											@click="openRename(claw)"
										/>
									</div>
									<UBadge color="primary" variant="subtle" size="xs">{{ dashboard.agents?.length ?? 0 }} {{ $t('dashboard.agents') }}</UBadge>
								</div>
								<div class="mt-3 mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
									<span v-if="dashboard.instance.pluginVersion">{{ $t('claws.pluginVersion') }}{{ dashboard.instance.pluginVersion }}</span>
									<span v-if="dashboard.instance.clawVersion">{{ $t('claws.clawVersion') }}{{ dashboard.instance.clawVersion }}</span>
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
									<h2 class="text-base font-semibold">{{ getClawName(claw) }}</h2>
									<UBadge color="neutral" variant="subtle" size="xs">{{ $t('dashboard.offline') }}</UBadge>
								</div>
							</template>
						</div>
						<!-- 右侧：解绑按钮 -->
						<div class="pl-3 shrink-0">
							<UButton
								color="error"
								variant="soft"
								:loading="unbindingId === claw.id"
								@click="confirmRemove(claw.id)"
							>
								{{ $t('claws.remove') }}
							</UButton>
						</div>
					</div>
				</div>

				<!-- 连接信息（有 RTC 活动迹象时显示；与 claw.online 解耦，独立反映 rtcPhase） -->
				<div v-if="connDetail || rtcPhase !== 'idle'" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 mb-3 text-xs text-muted">
					<span>{{ connLabel(claw.id) }}</span>
					<button
						v-if="connDetail"
						class="inline-flex items-center gap-0.5 underline decoration-dotted underline-offset-2 opacity-70 hover:opacity-100"
						@click="toggleDetail(claw.id)"
					>
						{{ $t('claws.conn.detailTitle') }}
						<UIcon :name="expandedDetails[claw.id] ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-3.5" />
					</button>
				</div>
				<div v-if="expandedDetails[claw.id] && connDetail" class="rounded-lg bg-elevated px-3 py-2 text-xs text-muted mb-3">
					<p>{{ $t('claws.conn.localCandidate') }}：{{ connDetail.localType }} · {{ connDetail.localProtocol?.toUpperCase() }}</p>
					<p>{{ $t('claws.conn.remoteCandidate') }}：{{ connDetail.remoteType }} · {{ connDetail.remoteProtocol?.toUpperCase() }}</p>
					<p>{{ $t('claws.conn.relayProtocol') }}：{{ connDetail.relayProtocol?.toUpperCase() ?? '—' }}</p>
				</div>

				<div class="flex flex-col gap-3">
					<AgentCard
						v-for="agent in dashboard?.agents ?? []"
						:key="agent.id"
						:agent="agent"
						:claw="claw"
						@chat="goToAgent(claw.id, $event)"
						@files="goToFiles(claw.id, $event)"
					/>
				</div>
			</div>
		</section>

		<!-- 重命名对话框 -->
		<UModal v-model:open="renameOpen" :title="$t('claws.renameClaw')" description=" " :ui="promptUi">
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
		<UModal v-model:open="removeConfirmOpen" :title="$t('claws.removeConfirmTitle')" description=" " :ui="promptUi">
			<template #body>
				<p class="text-sm text-muted">{{ $t('claws.removeConfirmDesc') }}</p>
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
import { unbindClawByUser } from '../services/claws.api.js';
import { promptModalUi } from '../constants/prompt-modal-ui.js';
import { useClawsStore, MAX_BACKOFF_RETRIES } from '../stores/claws.store.js';
import { getReadyConn } from '../stores/get-ready-conn.js';
import { useAgentRunsStore } from '../stores/agent-runs.store.js';
import { useDashboardStore } from '../stores/dashboard.store.js';
import AgentCard from '../components/AgentCard.vue';

const RESUME_THROTTLE_MS = 2000;
const FETCHED_WAIT_MS = 10_000;

export default {
	name: 'ManageClawsPage',
	components: { AgentCard },
	setup() {
		return {
			notify: useNotify(),
			promptUi: promptModalUi,
			clawsStore: useClawsStore(),
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
			renameClawId: '',
			expandedDetails: {},
		};
	},
	computed: {
		claws() {
			return this.clawsStore.items;
		},
		/** 按状态排序的 claw 列表：failed > running > connecting > idle > offline */
		sortedClaws() {
			const statusPriority = (claw) => {
				if (!claw.online) return 4; // offline
				if (claw.rtcPhase === 'failed') return 0; // failed
				if (this.__hasRunningAgent(claw.id)) return 1; // running
				if (claw.rtcPhase === 'building' || claw.rtcPhase === 'recovering' || claw.rtcPhase === 'restarting') return 2; // connecting
				return 3; // idle
			};
			return [...this.claws].sort((a, b) => {
				const pa = statusPriority(a);
				const pb = statusPriority(b);
				if (pa !== pb) return pa - pb;
				// 同优先级按 lastAliveAt 降序
				return (b.lastAliveAt ?? 0) - (a.lastAliveAt ?? 0);
			});
		},
		/** 状态摘要：running = 有 agent 在工作的 claw 数；failed = 连接异常的 claw 数 */
		statusSummary() {
			let running = 0;
			let failed = 0;
			for (const claw of this.claws) {
				if (!claw.online) continue;
				if (claw.rtcPhase === 'failed') {
					failed++;
				} else if (this.__hasRunningAgent(claw.id)) {
					running++;
				}
			}
			return { running, failed };
		},
		/** 排序后的 claw 列表，附带预查 dashboard 和连接详情，避免模板重复调用 */
		clawEntries() {
			return this.sortedClaws.map(claw => {
				const id = String(claw.id);
				const clawById = this.clawsStore.byId[id];
				return {
					claw,
					dashboard: this.dashboardStore.getDashboard(id),
					connDetail: clawById?.rtcTransportInfo ?? null,
					rtcPhase: clawById?.rtcPhase ?? 'idle',
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
		/** claw 卡片状态点颜色，同时反映在线状态和 RTC 连接阶段 */
		clawDotClass(claw) {
			if (!claw.online) return 'bg-gray-500';
			if (claw.rtcPhase === 'failed') return 'bg-red-400';
			if (claw.rtcPhase === 'ready') return 'bg-green-400 animate-pulse motion-reduce:animate-none';
			return 'bg-yellow-400 animate-pulse motion-reduce:animate-none';
		},
		/** 检查 claw 是否有任一 agent 在工作中 */
		__hasRunningAgent(clawId) {
			const id = String(clawId);
			const agents = this.dashboardStore.getDashboard(id)?.agents ?? [];
			return agents.some(a => this.agentRunsStore.isRunning(`${id}::agent:${a.id}:main`));
		},
		connLabel(clawId) {
			const id = String(clawId);
			const claw = this.clawsStore.byId[id];
			if (!claw) return '';
			const phase = claw.rtcPhase;
			if (phase === 'failed') {
				if (claw.retryCount > 0) {
					return this.$t('claws.conn.rtcRetrying', { n: claw.retryCount, max: MAX_BACKOFF_RETRIES });
				}
				return this.$t('claws.conn.rtcRetryExhausted');
			}
			if (phase === 'restarting') return this.$t('claws.conn.rtcRestarting');
			if (phase === 'building') return this.$t('claws.conn.rtcBuilding');
			if (phase === 'recovering') return this.$t('claws.conn.rtcRecovering');
			if (phase === 'ready') {
				const info = claw.rtcTransportInfo;
				// ready 但 transportInfo 尚未落地属极短暂过渡态，退回到 building 文案
				if (!info) return this.$t('claws.conn.rtcBuilding');
				if (info.localType === 'relay') {
					const rp = (info.relayProtocol ?? 'udp').toLowerCase();
					return rp === 'udp'
						? this.$t('claws.conn.rtcRelay')
						: this.$t('claws.conn.rtcRelayProto', { protocol: rp.toUpperCase() });
				}
				const isLan = info.localType === 'host';
				const proto = (info.localProtocol ?? 'udp').toLowerCase();
				if (proto === 'udp') {
					return this.$t(isLan ? 'claws.conn.rtcLan' : 'claws.conn.rtcP2P');
				}
				const key = isLan ? 'claws.conn.rtcLanProto' : 'claws.conn.rtcP2PProto';
				return this.$t(key, { protocol: proto.toUpperCase() });
			}
			return this.$t('claws.conn.rtcIdle');
		},
		toggleDetail(clawId) {
			const id = String(clawId);
			this.expandedDetails[id] = !this.expandedDetails[id];
		},
		goToFiles(clawId, agentId) {
			if (this.clawsStore.byId[String(clawId)]?.pluginVersionOk === false) {
				this.notify.warning(this.$t('pluginUpgrade.outdated'));
				return;
			}
			this.$router.push({
				name: 'files',
				params: { clawId: String(clawId), agentId: String(agentId) },
			});
		},
		goToAgent(clawId, agentId) {
			if (this.clawsStore.byId[String(clawId)]?.pluginVersionOk === false) {
				this.notify.warning(this.$t('pluginUpgrade.outdated'));
			}
			this.$router.push({
				name: 'chat',
				params: { clawId: String(clawId), agentId },
			});
		},
		async loadData() {
			if (this.loading) return;
			this.loading = true;
			try {
				// claw 列表由 SSE 快照维护；等待 fetched 后只加载 dashboard
				if (!this.clawsStore.fetched) {
					await new Promise((resolve) => {
						const timer = setTimeout(() => { unwatch(); resolve(); }, FETCHED_WAIT_MS);
						const unwatch = this.$watch(
							() => this.clawsStore.fetched,
							(val) => {
								if (val) { clearTimeout(timer); unwatch(); resolve(); }
							},
							{ immediate: true },
						);
					});
				}
				await Promise.allSettled(
					this.claws.map(claw => this.dashboardStore.loadDashboard(String(claw.id)))
				);
			}
			catch (err) {
				console.warn('[ManageClawsPage] loadData failed:', err);
				this.notify.error(err?.response?.data?.message ?? err?.message ?? this.$t('claws.loadFailed'));
			}
			finally {
				this.loading = false;
			}
		},
		getClawName(claw) {
			const pi = claw.pluginInfo;
			return pi?.name || pi?.hostName || claw.name || 'OpenClaw';
		},
		openRename(claw) {
			this.renameClawId = String(claw.id);
			this.renameValue = this.getClawName(claw);
			this.renameOpen = true;
		},
		async onConfirmRename() {
			const name = this.renameValue.trim();
			if (!name || this.renaming) return;
			this.renaming = true;
			const clawId = this.renameClawId;
			const conn = getReadyConn(clawId);
			if (!conn) {
				this.renaming = false;
				this.notify.error(this.$t('claws.renameFailed'));
				return;
			}
			try {
				await conn.request('coclaw.info.patch', { name });
				// 乐观更新，不依赖 event:coclaw.info.updated 广播
				const claw = this.clawsStore.byId[clawId];
				if (claw) {
					if (!claw.pluginInfo) claw.pluginInfo = {};
					claw.pluginInfo.name = name;
				}
				this.renameOpen = false;
			} catch (err) {
				console.warn('[ManageClawsPage] rename failed:', err);
				this.notify.error(err?.message ?? this.$t('claws.renameFailed'));
			} finally {
				this.renaming = false;
			}
		},
		confirmRemove(clawId) {
			this.removeTargetId = String(clawId);
			this.removeConfirmOpen = true;
		},
		async onConfirmRemove() {
			const clawId = this.removeTargetId;
			if (!clawId || this.unbindingId) return;
			this.unbindingId = clawId;
			try {
				await unbindClawByUser(clawId);
				this.removeConfirmOpen = false;
				this.dashboardStore.clearDashboard(clawId);
				await this.loadData();
			}
			catch (err) {
				console.warn('[ManageClawsPage] onConfirmRemove failed:', err);
				this.notify.error(err?.response?.data?.message ?? err?.message ?? this.$t('claws.removeFailed'));
			}
			finally {
				this.unbindingId = '';
			}
		},
	},
};
</script>
