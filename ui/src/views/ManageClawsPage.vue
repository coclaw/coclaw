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

			<div v-for="{ claw, dashboard, connDetail, peerDetail, rtcPhase, guidanceState, modelView } in clawEntries" :key="claw.id" :data-testid="`claw-${claw.id}`">
				<!-- Claw card：左侧信息 + 右侧三点菜单 -->
				<div class="rounded-xl bg-elevated p-3 mb-3">
					<div class="flex">
						<!-- 左侧：claw 信息 -->
						<div class="flex-1 min-w-0">
							<template v-if="dashboard?.instance">
								<div class="flex items-center justify-between gap-2">
									<div class="flex items-center gap-2 min-w-0">
										<!-- 状态色点为装饰：活动态状态已由下方 connLabel 文字呈现，故 aria-hidden 免读屏重复朗读（online+idle 瞬态无文字，视力用户此时亦只见无文字的点，属可接受小缺口） -->
										<span
											class="inline-block size-2.5 rounded-full shrink-0"
											:class="clawDotClass(claw)"
											aria-hidden="true"
										></span>
										<!-- 标题 truncate 兜底：320px 极窄屏 + 长名会被同行 badge/花费/菜单挤到截断（截几字+省略号）。接受现状不专修——移动基态(<640)无子断点，改 flex 让标题独占行会连累 360+ 内联布局，只救 320 须引非标断点+两套变体，性价比不划算 -->
										<h2 class="text-base font-semibold truncate min-w-0">{{ getClawName(claw) }}</h2>
										<UBadge color="primary" variant="subtle" size="xs" class="shrink-0">{{ dashboard.agents?.length ?? 0 }} {{ $t('dashboard.agents') }}</UBadge>
									</div>
									<div v-if="dashboard.instance.monthlyCost && typeof dashboard.instance.monthlyCost.total === 'number'" class="text-right shrink-0" data-testid="monthly-cost">
										<p class="text-base font-bold tracking-tight">{{ formatCost(dashboard.instance.monthlyCost) }}</p>
										<p class="text-xs text-muted">{{ $t('dashboard.monthlyCost') }}</p>
									</div>
								</div>
								<div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
									<span v-if="dashboard.instance.pluginVersion">{{ $t('claws.pluginVersion') }}{{ dashboard.instance.pluginVersion }}</span>
									<span v-if="dashboard.instance.clawVersion">{{ $t('claws.clawVersion') }}{{ dashboard.instance.clawVersion }}</span>
									<span v-if="dashboard.instance.channels?.length" class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0">
										<span v-for="ch in dashboard.instance.channels" :key="ch.id" class="inline-flex items-center gap-0.5" :title="ch.id">
											<span class="text-[10px]">{{ ch.connected ? '✅' : '❌' }}</span>
											<span>{{ ch.id }}</span>
										</span>
									</span>
								</div>
								<!-- 模型行：当前默认模型，整块可点 → 模型配置页；› 紧跟文字、hover/active 高亮示可点；放在版本之后贴近底部橙条；数据没到不渲染（入口交给三点菜单） -->
								<!-- 取内容宽度(inline-flex,非 w-full)：空白区不参与高亮，观感更收敛；max-w-full + 文字 min-w-0 仍保长模型名截断不溢出 -->
								<button
									v-if="modelView"
									type="button"
									:data-testid="`claw-model-${claw.id}`"
									class="mt-2 -mx-1.5 inline-flex max-w-full items-center gap-2 rounded-lg pl-1.5 pr-0.5 py-1 text-start cursor-pointer transition-colors hover:bg-accented active:bg-accented"
									@click="goToModels(claw.id)"
								>
									<span class="min-w-0">
										<template v-if="modelView.kind === 'model'">
											<span v-if="modelView.provider" class="block truncate text-xs text-muted">{{ providerName(modelView.provider) }}</span>
											<span class="block truncate font-mono text-sm">{{ modelView.model }}</span>
										</template>
										<span v-else :data-testid="`claw-model-cta-${claw.id}`" class="block truncate text-sm text-muted">{{ $t(modelView.textKey) }}</span>
									</span>
									<UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-primary" />
								</button>
							</template>
							<template v-else>
								<div class="flex items-center gap-2 min-w-0">
									<span class="inline-block size-2.5 rounded-full bg-gray-500 shrink-0" aria-hidden="true"></span>
									<h2 class="text-base font-semibold truncate min-w-0">{{ getClawName(claw) }}</h2>
									<UBadge color="neutral" variant="subtle" size="xs" class="shrink-0">{{ $t('dashboard.offline') }}</UBadge>
								</div>
							</template>
						</div>
						<!-- 右侧：三点菜单（管理模型 / 重命名 / 移除）。分隔由 clawMenuItems 的嵌套数组分组自动产生 -->
						<div class="pl-3 shrink-0">
							<UDropdownMenu
								v-model:open="menuOpenMap[claw.id]"
								:items="clawMenuItems(claw)"
								:content="{ side: 'bottom', align: 'end' }"
								:modal="false"
							>
								<UButton
									:data-testid="`claw-menu-${claw.id}`"
									class="cc-icon-btn"
									variant="ghost"
									color="neutral"
									size="md"
									icon="i-lucide-ellipsis"
									:loading="!!unbindingMap[claw.id]"
									:aria-label="$t('common.moreActionsFor', { name: getClawName(claw) })"
								/>
								<!-- 在 label 上挂 data-testid（E2E 锚点）：标准 item 元素不透传任意 data-* 属性。
								     truncate 沿用原手搓 label（短动词标签实际不触发，超长本地化时省略而非换行） -->
								<template #item-label="{ item }">
									<span :data-testid="item.testid" class="truncate">{{ item.label }}</span>
								</template>
							</UDropdownMenu>
						</div>
					</div>

					<!-- 首次引导橙条：仅在线 + RPC 真返回 + 命中某个引导态时显示（设计 § 6） -->
					<div
						v-if="guidanceState"
						:data-testid="`guidance-${claw.id}`"
						class="mt-3 flex items-center gap-2 rounded-lg bg-orange-500/10 px-2 py-1.5 text-xs text-orange-600 dark:text-orange-400"
					>
						<span class="flex min-w-0 items-center gap-1.5">
							<UIcon name="i-lucide-triangle-alert" class="size-4 shrink-0" />
							<span class="min-w-0">{{ guidanceText(guidanceState) }}</span>
						</span>
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
					<p v-if="peerDetail">{{ $t('claws.conn.peerCandidate') }}：{{ peerDetail.candidateType }} · {{ peerDetail.protocol?.toUpperCase() }}<span v-if="peerDetail.relayProtocol"> · {{ $t('claws.conn.peerRelayProtocol') }} {{ peerDetail.relayProtocol.toUpperCase() }}</span></p>
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
					<UButton color="error" @click="onConfirmRemove">{{ $t('common.confirm') }}</UButton>
				</div>
			</template>
		</UModal>
	</main>
</template>

<script>
import { useNotify } from '../composables/use-notify.js';
import { unbindClawByUser } from '../services/claws.api.js';
import { promptModalUi } from '../constants/prompt-modal-ui.js';
import { useClawsStore } from '../stores/claws.store.js';
import { getReadyConn } from '../stores/get-ready-conn.js';
import { useAgentRunsStore } from '../stores/agent-runs.store.js';
import { useDashboardStore } from '../stores/dashboard.store.js';
import { pickGuidanceState } from '../utils/guidance-state.js';
import { parseModelId } from '../utils/model-id.js';
import { getProviderName } from '../constants/provider-meta.js';
import AgentCard from '../components/AgentCard.vue';

/** 前台恢复刷新的 freshness gate：60s 内不重复 reload */
const RELOAD_FRESHNESS_MS = 60_000;
/** 失败冷却：catch 后写入 now - (FRESHNESS - COOLDOWN)，等价于 30s 后允许下次重试 */
const FAIL_COOLDOWN_MS = 30_000;
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
			// per-claw in-flight tracker：key=clawId，value=true 表示 unbind 正在跑
			// 写入/删除均只在 onConfirmRemove 内（写在 await 前的同步段、删在 finally）
			unbindingMap: {},
			removeConfirmOpen: false,
			removeTargetId: '',
			renameOpen: false,
			renameValue: '',
			renaming: false,
			renameClawId: '',
			expandedDetails: {},
			// per-claw 三点菜单展开态：key=clawId
			menuOpenMap: {},
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
				const dashboard = this.dashboardStore.getDashboard(id);
				const guidanceState = this.__guidanceStateFor(claw, dashboard);
				return {
					claw,
					dashboard,
					connDetail: clawById?.rtcTransportInfo ?? null,
					peerDetail: clawById?.rtcPeerTransportInfo ?? null,
					rtcPhase: clawById?.rtcPhase ?? 'idle',
					guidanceState,
					modelView: this.__clawModelViewFor(claw, dashboard, guidanceState),
				};
			});
		},
	},
	async mounted() {
		// 仅监听 app:foreground（移动浏览器由 capacitor-app.js 桥接 visibility 覆盖）
		// 桌面浏览器 tab 切换不再触发刷新——避免 desktop 多 claw 用户切 tab 时的 N×10+ RPC 风暴
		this.__lastLoadedAt = 0;
		this.__onResume = () => {
			if (Date.now() - this.__lastLoadedAt < RELOAD_FRESHNESS_MS) return;
			this.loadData();
		};
		window.addEventListener('app:foreground', this.__onResume);

		await this.loadData();
	},
	beforeUnmount() {
		if (this.__onResume) {
			window.removeEventListener('app:foreground', this.__onResume);
		}
	},
	methods: {
		/** provider 友好品牌名（展示用）；id 仍是唯一真值，仅展示文本换名 */
		providerName(id) {
			return getProviderName(id);
		},
		/** 格式化本月花费为本地化货币字符串 */
		formatCost(cost) {
			if (cost && typeof cost.total === 'number') {
				return new Intl.NumberFormat(undefined, {
					style: 'currency',
					currency: cost.currency || 'USD',
				}).format(cost.total);
			}
			return '—';
		},
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
				if (claw.retryNextAt > 0) {
					return this.$t('claws.conn.rtcRetrying');
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
					const rpBrowser = (info.relayProtocol ?? 'udp').toLowerCase();
					const peer = claw.rtcPeerTransportInfo;
					// plugin 侧信息未到（老 plugin 或事件尚未送达）→ 老文案兜底
					if (!peer) {
						return rpBrowser === 'udp'
							? this.$t('claws.conn.rtcRelay')
							: this.$t('claws.conn.rtcRelayProto', { protocol: rpBrowser.toUpperCase() });
					}
					// plugin 侧 relay 时用 relayProtocol，否则用 candidate 的 protocol（通常 UDP）
					const rpPeer = peer.candidateType === 'relay'
						? (peer.relayProtocol ?? peer.protocol ?? 'udp').toLowerCase()
						: (peer.protocol ?? 'udp').toLowerCase();
					// 双端协议一致 → 简化展示（避免刷屏），通过详情面板仍可查看 plugin 侧 candidate type
					if (rpBrowser === rpPeer) {
						return rpBrowser === 'udp'
							? this.$t('claws.conn.rtcRelay')
							: this.$t('claws.conn.rtcRelayProto', { protocol: rpBrowser.toUpperCase() });
					}
					return this.$t('claws.conn.rtcRelayBothSides', {
						browser: rpBrowser.toUpperCase(),
						peer: rpPeer.toUpperCase(),
					});
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
			this.$router.push({
				name: 'files',
				params: { clawId: String(clawId), agentId: String(agentId) },
			});
		},
		goToAgent(clawId, agentId) {
			this.$router.push({
				name: 'chat',
				params: { clawId: String(clawId), agentId },
			});
		},
		goToModels(clawId) {
			this.$router.push(`/claws/${String(clawId)}/models`);
		},
		/**
		 * 三点菜单项：disabled 依赖具体 claw（online）与 renaming / unbindingMap，
		 * 故用方法按 claw 现算（非 computed）。嵌套数组分组 → 组间自动分隔线：
		 * 【管理模型 + 重命名】|【移除】。unbind in-flight（busy）时整菜单禁用，避免对正在解绑的 claw 误操作。
		 * @param {object} claw
		 */
		clawMenuItems(claw) {
			const busy = !!this.unbindingMap[claw.id];
			return [
				[
					{ label: this.$t('claws.manageModel'), icon: 'i-lucide-sliders-horizontal',
						testid: `claw-menu-models-${claw.id}`, disabled: !claw.online || busy,
						onSelect: () => { this.menuOpenMap[claw.id] = false; this.goToModels(claw.id); } },
					{ label: this.$t('claws.rename'), icon: 'i-lucide-pencil',
						testid: `claw-menu-rename-${claw.id}`, disabled: this.renaming || !claw.online || busy,
						onSelect: () => { this.menuOpenMap[claw.id] = false; this.openRename(claw); } },
				],
				[
					// 移除为危险项：per-item color 'error'（红字红图标），高亮底色由全局主题拉回中性
					{ label: this.$t('claws.remove'), icon: 'i-lucide-trash-2', color: 'error',
						testid: `claw-menu-remove-${claw.id}`, disabled: busy,
						onSelect: () => { this.menuOpenMap[claw.id] = false; this.confirmRemove(claw.id); } },
				],
			];
		},
		/** 计算某台 claw 的引导态：离线 / 凭据 RPC 未成功返回时返回 null（设计 § 6 + § 7.4 gating） */
		__guidanceStateFor(claw, dashboard) {
			if (!claw?.online) return null;
			// modelConfigFetched=false 表示凭据 RPC（coclaw.model.list）未成功返回，默认值不可信，不提示。
			// 橙条显隐只绑这一条，不再绑 catalog 是否拉到（§7.4 与目录解耦）
			if (!dashboard || !dashboard.modelConfigFetched) return null;
			return pickGuidanceState({
				hasAny: dashboard.hasUsableCredential,
				primary: dashboard.primaryModel,
				effective: dashboard.primaryProviderUsable,
			});
		},
		/**
		 * claw 卡片「模型行」视图：复用便宜信号（不碰那条 ~12s 可用清单冷调用）。
		 *   - 数据没到（离线 / 凭据 RPC 未返回）→ null：不渲染模型行，入口交给三点菜单
		 *   - noKey（无凭据）/ noPrimary（未设主模型）→ 安静 CTA（文案通用，loud 警告交给橙条）
		 *   - 健康 / invalid（失效）→ 显示真实主模型两行；失效那句警告交给橙条
		 * @param {object} claw
		 * @param {object} dashboard
		 * @param {'noKey'|'noPrimary'|'invalid'|null} guidanceState - 已算好的引导态，避免重复计算
		 * @returns {{ kind: 'model', provider: string, model: string }|{ kind: 'cta', textKey: string }|null}
		 */
		__clawModelViewFor(claw, dashboard, guidanceState) {
			if (!claw?.online || !dashboard || !dashboard.modelConfigFetched) return null;
			if (guidanceState === 'noKey') return { kind: 'cta', textKey: 'claws.model.noProvider' };
			if (guidanceState === 'noPrimary') return { kind: 'cta', textKey: 'claws.model.notSet' };
			// guidanceState 为 null（健康）或 'invalid'：显示主模型；primary 异常空时兜底当未设
			const parsed = parseModelId(dashboard.primaryModel);
			if (!parsed) return { kind: 'cta', textKey: 'claws.model.notSet' };
			return { kind: 'model', provider: parsed.provider, model: parsed.model };
		},
		/** 引导态 → 本地化橙条文案 */
		guidanceText(state) {
			if (state === 'noKey') return this.$t('modelConfig.guidance.noKeyWarning');
			if (state === 'noPrimary') return this.$t('modelConfig.guidance.noPrimaryWarning');
			if (state === 'invalid') return this.$t('modelConfig.guidance.invalidPrimaryWarning');
			return '';
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
				// 进入管理页 / app:foreground 重刷：外层 60s 节流已过，意图就是要拉最新数据；
				// force=true 让 dashboard 走强刷新，避免读到 sessions.store 上次缓存的旧 raw
				await Promise.allSettled(
					this.claws.map(claw => this.dashboardStore.loadDashboard(String(claw.id), { force: true }))
				);
				this.__lastLoadedAt = Date.now();
			}
			catch (err) {
				// 失败冷却：30s 后允许 app:foreground 再次触发重试，防 server 持续 5xx 时的重试风暴
				this.__lastLoadedAt = Date.now() - (RELOAD_FRESHNESS_MS - FAIL_COOLDOWN_MS);
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
			if (!clawId) return;
			// 同 claw 重入挡掉；不同 claw 允许并发（per-claw map）
			if (this.unbindingMap[clawId]) return;
			// 先关弹窗，再发 API：用户点确认后 modal 立刻消失，操作走后台
			this.removeConfirmOpen = false;
			this.unbindingMap[clawId] = true;
			// server 视角是否已无此 claw（success 或 404 都视为"已无"）
			let serverGone = false;
			try {
				await unbindClawByUser(clawId);
				serverGone = true;
			}
			catch (err) {
				console.warn('[ManageClawsPage] onConfirmRemove failed:', err);
				this.notify.error(err?.response?.data?.message ?? err?.message ?? this.$t('claws.removeFailed'));
				// 404 = server 视角已无此 claw，等同 unbind 成功；SSE 不会推 claw.unbound，需主动剔除
				const code = err?.response?.data?.code;
				const status = err?.response?.status;
				if (code === 'CLAW_NOT_FOUND' || status === 404) {
					serverGone = true;
					this.clawsStore.removeClawById(clawId);
				}
			}
			finally {
				delete this.unbindingMap[clawId];
			}
			if (serverGone) {
				this.dashboardStore.clearDashboard(clawId);
				await this.loadData();
			}
		},
	},
};
</script>
