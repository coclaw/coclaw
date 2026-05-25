<template>
	<div class="flex h-full min-h-0 flex-1 flex-col">
		<!-- 移动端 header（fallback /claws 处理 Electron / Capacitor 冷启 deep link） -->
		<MobilePageHeader :title="pageTitle" fallback="/claws" />

		<!-- 桌面端 header -->
		<header class="z-10 hidden shrink-0 min-h-12 items-center gap-1 border-b border-default bg-elevated pl-2 py-1 md:flex">
			<!-- 注意：icon-only 返回按钮无 aria-label——与 FileManagerPage 等姊妹页面一致；
			     a11y 改进作为统一项见仓库 TODO -->
			<UButton
				class="cc-icon-btn-lg shrink-0"
				size="xl"
				variant="ghost"
				color="neutral"
				icon="i-lucide-arrow-left"
				@click="goBack"
			/>
			<h1 class="text-base">{{ pageTitle }}</h1>
		</header>

		<!-- 内容区 -->
		<main class="flex-1 min-h-0 overflow-y-auto">
			<div class="mx-auto w-full max-w-2xl px-3 py-5 sm:px-4 lg:px-5">
				<!-- claw 离线提示：所有动作 disabled，按 design § 10 -->
				<div
					v-if="offline"
					data-testid="claw-offline-banner"
					class="mb-4 rounded border border-warning bg-warning/10 px-3 py-2 text-sm text-warning"
				>
					{{ $t('modelConfig.common.clawOffline') }}
				</div>

				<!-- 首屏 loading：仅在尚未拿到任何数据时展示，避免重连刷新闪烁 -->
				<div v-if="initialLoading" class="px-2 py-8 text-center text-sm text-muted">
					{{ $t('common.loading') }}
				</div>

				<template v-else>
					<!-- 三 RPC 全失败时的 retry 入口（任意一个 RPC 成功则继续渲染正常区块） -->
					<div
						v-if="fullyFailed"
						data-testid="load-failed"
						class="mb-4 flex items-center justify-between rounded border border-default bg-elevated px-3 py-2 text-sm"
					>
						<span class="text-muted">{{ $t('modelConfig.providerAuth.loadFailed') }}</span>
						<UButton
							size="xs"
							variant="ghost"
							color="primary"
							:disabled="loading"
							:loading="loading"
							@click="loadAll"
						>
							{{ $t('common.retry') }}
						</UButton>
					</div>

					<!-- A. 默认主模型区 -->
					<section class="mb-6 rounded border border-default bg-default">
						<div class="flex items-center justify-between border-b border-default px-3 py-2">
							<h2 class="text-sm font-medium">{{ $t('modelConfig.primary.title') }}</h2>
						</div>
						<div class="px-3 py-2">
							<!-- 已配且有效 -->
							<div v-if="primaryState === 'effective' && primary" class="flex flex-wrap items-center justify-between gap-2">
								<span data-testid="primary-current" class="font-mono text-sm">{{ primary }}</span>
								<UButton
									data-testid="btn-primary-change"
									variant="soft"
									color="primary"
									:disabled="!actionsEnabled"
									@click="onChangePrimary"
								>
									{{ $t('modelConfig.primary.changeButton') }}
								</UButton>
							</div>
							<!-- 主模型未知（model.list RPC 失败）：placeholder，不强行报警告 -->
							<div v-else-if="primaryState === 'unknown'" data-testid="primary-unknown" class="text-sm text-muted">
								—
							</div>
							<!-- 未配 / 失效：均走 selectButton -->
							<div v-else class="space-y-3">
								<p data-testid="primary-warning" class="text-sm text-warning">
									{{ primaryState === 'invalid' ? $t('modelConfig.primary.invalidWarning') : $t('modelConfig.primary.notSetWarning') }}
								</p>
								<UButton
									data-testid="btn-primary-select"
									variant="soft"
									color="primary"
									:disabled="!actionsEnabled"
									@click="onSelectPrimary"
								>
									{{ $t('modelConfig.primary.selectButton') }}
								</UButton>
							</div>
						</div>
					</section>

					<!-- B. API 凭据区 -->
					<section class="rounded border border-default bg-default">
						<div class="flex items-center justify-between border-b border-default px-3 py-2">
							<h2 class="text-sm font-medium">{{ $t('modelConfig.providerAuth.title') }}</h2>
							<UButton
								data-testid="btn-add-provider"
								variant="soft"
								color="primary"
								:disabled="!actionsEnabled"
								@click="onAddProvider"
							>
								{{ $t('modelConfig.providerAuth.addButton') }}
							</UButton>
						</div>
						<!-- providers RPC 失败 → 不要假装"无 provider"，给一个 placeholder；
						     全 3 RPC 失败时 fullyFailed banner 已在上方暴露 retry 入口 -->
						<div v-if="!loadOk.profiles && !profiles.length" data-testid="provider-load-failed" class="px-3 py-6 text-center text-sm text-muted">
							—
						</div>
						<div v-else-if="!profiles.length" data-testid="provider-empty" class="px-3 py-6 text-center text-sm text-muted">
							{{ $t('modelConfig.providerAuth.emptyState') }}
						</div>
						<div v-else>
							<!-- !loadOk.primary 时禁用 Remove：primary 未知就无法判 carrier，
							     否则可能在不该用强警告时静悄悄走了普通确认 -->
							<ProviderAuthRow
								v-for="p in profiles"
								:key="p.profileId || p.provider"
								:profile="p"
								:disabled="!actionsEnabled || removeBusy || !loadOk.primary"
								@remove="onRemoveProvider"
							/>
						</div>
					</section>
				</template>
			</div>
		</main>

		<!-- 撤销确认对话框 -->
		<RemoveProviderConfirmDialog
			v-model:open="removeOpen"
			:provider="removeTarget"
			:current-primary="primary || ''"
			:is-primary-carrier="removeTargetIsPrimaryCarrier"
			:busy="removeBusy"
			@confirm="onConfirmRemove"
			@cancel="onCancelRemove"
		/>

		<!-- 添加 provider 流程：单 dialog 内 stepper（选 provider → 输 API key） -->
		<AddProviderDialog
			v-model:open="addOpen"
			:catalog="catalog"
			:existing-providers="providerIds"
			:set-api-key="addProviderRpc"
			@added="onProviderAdded"
		/>

		<!-- 选 / 换主模型 -->
		<PrimaryModelPickerDialog
			v-model:open="pickerOpen"
			:providers="providerIds"
			:catalog="catalog"
			:current="primary"
			:set-primary="setPrimaryRpc"
			@picked="onPrimaryPicked"
		/>
	</div>
</template>

<script>
import MobilePageHeader from '../components/MobilePageHeader.vue';
import ProviderAuthRow from '../components/model-config/ProviderAuthRow.vue';
import RemoveProviderConfirmDialog from '../components/model-config/RemoveProviderConfirmDialog.vue';
import AddProviderDialog from '../components/model-config/AddProviderDialog.vue';
import PrimaryModelPickerDialog from '../components/model-config/PrimaryModelPickerDialog.vue';
import { navBack } from '../utils/nav-back.js';
import { useClawsStore } from '../stores/claws.store.js';
import { useDashboardStore, computePrimaryEffective } from '../stores/dashboard.store.js';
import { useClawConnections } from '../services/claw-connection-manager.js';
import { useNotify } from '../composables/use-notify.js';
import { mapModelConfigErrorKey } from '../utils/model-config-errors.js';

const RPC_TIMEOUT = 60_000;

export default {
	name: 'ModelConfigPage',
	components: {
		MobilePageHeader,
		ProviderAuthRow,
		RemoveProviderConfirmDialog,
		AddProviderDialog,
		PrimaryModelPickerDialog,
	},
	setup() {
		return {
			clawsStore: useClawsStore(),
			dashboardStore: useDashboardStore(),
			notify: useNotify(),
		};
	},
	data() {
		return {
			loading: false,
			loadAttempted: false,
			// 三项 RPC 各自 fetched 标记；用于区分"已加载且为空"与"未加载所以默认空"
			loadOk: { profiles: false, primary: false, catalog: false },
			profiles: [],
			primary: null,
			catalog: [],
			removeOpen: false,
			removeTarget: '',
			removeBusy: false,
			// add provider / 主模型 picker 对话框开合（dialog 内部各自管 busy）
			addOpen: false,
			pickerOpen: false,
		};
	},
	computed: {
		clawId() {
			return String(this.$route?.params?.clawId ?? '');
		},
		clawName() {
			return this.dashboardStore.getDashboard(this.clawId)?.instance?.name
				|| this.clawsStore.byId?.[this.clawId]?.name
				|| this.clawId;
		},
		pageTitle() {
			return `${this.clawName} · ${this.$t('modelConfig.title')}`;
		},
		offline() {
			return !this.clawsStore.byId?.[this.clawId]?.online;
		},
		connReady() {
			return !!this.clawsStore.byId?.[this.clawId]?.dcReady;
		},
		actionsEnabled() {
			return !this.offline && this.connReady && !this.loading;
		},
		initialLoading() {
			return this.loading && !this.loadAttempted;
		},
		fullyFailed() {
			// 仅在已尝试加载且三项全失败时展示；避免离线 / 未尝试时误报
			return this.loadAttempted && !this.loadOk.profiles && !this.loadOk.primary && !this.loadOk.catalog;
		},
		providerIds() {
			return this.profiles
				.map(p => (p && typeof p.provider === 'string') ? p.provider : null)
				.filter(v => !!v);
		},
		primaryEffective() {
			return computePrimaryEffective(this.primary, this.providerIds, this.catalog);
		},
		/**
		 * 主模型显示状态：
		 *   - 'unknown'  → 主模型 RPC 未成功，无法判断；不渲染主模型区警告/值
		 *   - 'notSet'   → 主模型 RPC 成功且 primary 为空：渲染未配置警告
		 *   - 'effective'→ primary 非空，且 catalog/profiles 都加载成功并确认 effective；或两者任一缺失时仅渲染当前 primary（保守不报失效）
		 *   - 'invalid'  → primary 非空，profiles + catalog 都加载成功，但 computePrimaryEffective=false
		 *
		 * 关键原则：不要在数据不全时报"失效"——会让"我配好的 key 怎么变失效了"的误判（设计 § 7.2 同精神）
		 */
		primaryState() {
			if (!this.loadOk.primary) return 'unknown';
			if (!this.primary) return 'notSet';
			if (!this.loadOk.profiles || !this.loadOk.catalog) return 'effective';
			return this.primaryEffective ? 'effective' : 'invalid';
		},
		removeTargetProvider() {
			if (!this.primary || !this.removeTarget) return '';
			const idx = this.primary.indexOf('/');
			if (idx <= 0) return '';
			return this.primary.slice(0, idx);
		},
		removeTargetIsPrimaryCarrier() {
			return !!this.removeTarget && this.removeTargetProvider === this.removeTarget;
		},
	},
	watch: {
		clawId: {
			immediate: false,
			handler() {
				// 路由换到另一台 claw → 立刻清状态并启新一轮 load，旧 load 的 await 落地后会被 seq 拦下
				this.profiles = [];
				this.primary = null;
				this.catalog = [];
				this.loadOk = { profiles: false, primary: false, catalog: false };
				this.loadAttempted = false;
				// 撤销对话框是属于上一台 claw 的，强制关掉避免新 claw confirm 时拿到旧 provider
				this.removeOpen = false;
				this.removeTarget = '';
				this.removeBusy = false;
				// add / picker 同样属于上一台 claw，强制关掉防止状态泄漏
				this.addOpen = false;
				this.pickerOpen = false;
				// 清掉写目标标记：即便旧 dialog 的 inflight RPC 之后落地，
				// onProviderAdded/onPrimaryPicked 的 target 守卫也会因 clawId 不匹配而丢弃
				this.__writeClawId = '';
				this.loadAll();
			},
		},
		connReady: {
			immediate: true,
			handler(ready) {
				// DC 翻 ready 即拉一次；离线 → 在线恢复也走这里
				if (ready) this.loadAll();
			},
		},
	},
	methods: {
		goBack() {
			navBack(this.$router, '/claws');
		},

		async loadAll() {
			// 始终先 ++seq：让任何仍 inflight 的旧 load 在 await 后被丢弃。
			// 必须在所有早返前——否则 clawId 切到 "无连接 claw" 时不 bump，
			// 上一台 claw 的 inflight 还能写入新 claw 的状态
			const seq = ++this.__loadSeq;
			const id = this.clawId;
			if (!id) return;
			const conn = useClawConnections().get(id);
			if (!conn) return;
			this.loading = true;
			try {
				const [profilesRes, modelRes, catalogRes] = await Promise.allSettled([
					conn.request('coclaw.providerAuth.list', {}, { timeout: RPC_TIMEOUT }),
					conn.request('coclaw.model.list', {}, { timeout: RPC_TIMEOUT }),
					conn.request('models.list', { view: 'all' }, { timeout: RPC_TIMEOUT }),
				]);
				// 三重门：1) 组件还活着；2) clawId 还是同一个；3) 没被更新一轮抢占
				if (this.__unmounted || seq !== this.__loadSeq || id !== this.clawId) return;
				this.loadOk = {
					profiles: profilesRes.status === 'fulfilled',
					primary: modelRes.status === 'fulfilled',
					catalog: catalogRes.status === 'fulfilled',
				};
				if (profilesRes.status === 'fulfilled') {
					const arr = profilesRes.value?.profiles;
					this.profiles = Array.isArray(arr) ? arr : [];
				}
				if (modelRes.status === 'fulfilled') {
					const pri = modelRes.value?.default?.primary;
					this.primary = (typeof pri === 'string' && pri) ? pri : null;
				}
				if (catalogRes.status === 'fulfilled') {
					const arr = catalogRes.value?.models;
					this.catalog = Array.isArray(arr) ? arr : [];
				}
				this.loadAttempted = true;
				if (this.fullyFailed) {
					this.notify.error(this.$t('modelConfig.common.connError'));
				}
			}
			finally {
				if (!this.__unmounted && seq === this.__loadSeq) this.loading = false;
			}
		},

		// --- 写后局部刷新：只重拉 providerAuth.list + model.list，catalog 不会因写操作变化 ---
		async refreshAfterWrite() {
			const id = this.clawId;
			const conn = useClawConnections().get(id);
			if (!conn) return;
			try {
				const [profilesRes, modelRes] = await Promise.allSettled([
					conn.request('coclaw.providerAuth.list', {}, { timeout: RPC_TIMEOUT }),
					conn.request('coclaw.model.list', {}, { timeout: RPC_TIMEOUT }),
				]);
				// unmount / 切 claw 后丢弃这次 refresh 结果
				if (this.__unmounted || id !== this.clawId) return;
				if (profilesRes.status === 'fulfilled') {
					const arr = profilesRes.value?.profiles;
					this.profiles = Array.isArray(arr) ? arr : [];
					this.loadOk.profiles = true;
				}
				if (modelRes.status === 'fulfilled') {
					const pri = modelRes.value?.default?.primary;
					this.primary = (typeof pri === 'string' && pri) ? pri : null;
					this.loadOk.primary = true;
				}
				if (profilesRes.status === 'rejected' || modelRes.status === 'rejected') {
					console.warn('[ModelConfigPage] refreshAfterWrite partial failure',
						profilesRes.status === 'rejected' ? profilesRes.reason?.message : null,
						modelRes.status === 'rejected' ? modelRes.reason?.message : null);
				}
			}
			catch (err) {
				// allSettled 应该不会进这里；万一进了，仅日志，外层 dashboard.store 重拉兜底一致性
				console.warn('[ModelConfigPage] refreshAfterWrite unexpected error:', err?.message);
			}
		},

		// --- 主模型按钮：打开 picker（change / select 同一对话框） ---
		onChangePrimary() {
			if (!this.actionsEnabled) return;
			// 记下"这次写操作针对哪台 claw"：clawId 在 dialog 打开期间稳定（一旦切换 watcher 会关掉 dialog），
			// 所以打开时刻即写操作目标。事件回调据此判断 inflight RPC 落地时是否已切走
			this.__writeClawId = this.clawId;
			this.pickerOpen = true;
		},
		onSelectPrimary() {
			if (!this.actionsEnabled) return;
			this.__writeClawId = this.clawId;
			this.pickerOpen = true;
		},

		// --- 添加 provider：打开 stepper ---
		onAddProvider() {
			if (!this.actionsEnabled) return;
			this.__writeClawId = this.clawId;
			this.addOpen = true;
		},

		/**
		 * 给 AddProviderDialog 注入的 setApiKey 函数；执行时再绑当前 clawId + conn，
		 * 用 arrow 保留 this，避免 dialog 透传时丢上下文
		 *
		 * @param {{ provider: string, apiKey: string, timeout?: number }} args
		 */
		addProviderRpc({ provider, apiKey, timeout }) {
			const id = this.clawId;
			const conn = useClawConnections().get(id);
			if (!conn) {
				// dialog 内会把 reject 映成 connError；按通道层错误码抛
				return Promise.reject(Object.assign(new Error('connection not ready'), { code: 'DC_CLOSED' }));
			}
			return conn.request(
				'coclaw.providerAuth.setApiKey',
				{ provider, apiKey },
				{ timeout: timeout || RPC_TIMEOUT }
			);
		},

		/**
		 * 给 PrimaryModelPickerDialog 注入的 setPrimary 函数
		 *
		 * @param {{ primary: string, timeout?: number }} args
		 */
		setPrimaryRpc({ primary, timeout }) {
			const id = this.clawId;
			const conn = useClawConnections().get(id);
			if (!conn) {
				return Promise.reject(Object.assign(new Error('connection not ready'), { code: 'DC_CLOSED' }));
			}
			return conn.request(
				'coclaw.model.set',
				{ primary },
				{ timeout: timeout || RPC_TIMEOUT }
			);
		},

		/**
		 * AddProviderDialog 'added' 事件回调：refresh + dashboard reload + notify
		 *
		 * 关键：用打开时记下的 __writeClawId 作目标。若 inflight RPC 落地时用户已切到别的 claw，
		 * 直接丢弃——不要给当前 claw 弹"已添加"、也不要拿别的 claw 的写结果去刷它的 dashboard
		 *
		 * @param {{ provider: string, profileId?: string }} info
		 */
		async onProviderAdded(info) {
			const target = this.__writeClawId;
			if (this.__unmounted || !target || this.clawId !== target) return;
			// 先局部 refresh 让子页凭据列表立即一致，再 notify 成功——避免"提示成功但列表还旧"
			await this.refreshAfterWrite();
			if (this.__unmounted || this.clawId !== target) return;
			this.notify.success(this.$t('modelConfig.providerAuth.add.success', {
				provider: info?.provider ?? '',
			}));
			// dashboard.store 触发外层（ManageClaws 卡片）一致性，稍后追上
			try {
				await this.dashboardStore.loadDashboard(target, { force: true });
			}
			catch (err) {
				console.warn('[ModelConfigPage] dashboard reload after add failed:', err?.message);
			}
		},

		/**
		 * PrimaryModelPickerDialog 'picked' 事件回调
		 *
		 * @param {{ primary: string }} info
		 */
		async onPrimaryPicked(info) {
			const target = this.__writeClawId;
			if (this.__unmounted || !target || this.clawId !== target) return;
			// 立即把本地 primary 字段同步给用户看到的"已选"状态——比等 RPC refresh 更快
			if (info?.primary) this.primary = info.primary;
			await this.refreshAfterWrite();
			if (this.__unmounted || this.clawId !== target) return;
			// 成功不 notify：主模型区会立即刷新成新模型，用户可直接分辨；失败才提示
			try {
				await this.dashboardStore.loadDashboard(target, { force: true });
			}
			catch (err) {
				console.warn('[ModelConfigPage] dashboard reload after pick failed:', err?.message);
			}
		},

		// --- 撤销 provider：T2 完整 E2E ---
		onRemoveProvider(providerId) {
			if (!providerId) return;
			this.removeTarget = providerId;
			this.removeOpen = true;
		},
		onCancelRemove() {
			// busy 时忽略 cancel（在 busy 中按 cancel/Esc/遮罩 都不该让 RPC 继续在后台跑+对话框消失）
			if (this.removeBusy) return;
			this.removeOpen = false;
			this.removeTarget = '';
		},
		async onConfirmRemove() {
			const id = this.clawId;
			const provider = this.removeTarget;
			if (!id || !provider || this.removeBusy) return;
			const conn = useClawConnections().get(id);
			if (!conn) {
				// 连接没了就别静默——给用户反馈并关掉对话框
				this.notify.error(this.$t('modelConfig.common.connError'));
				this.removeOpen = false;
				this.removeTarget = '';
				return;
			}
			this.removeBusy = true;
			try {
				await conn.request('coclaw.providerAuth.remove', { provider }, { timeout: RPC_TIMEOUT });
				if (this.__unmounted || id !== this.clawId) return; // 切页 / 切 claw 后只静默退出
				this.removeOpen = false;
				this.notify.success(this.$t('modelConfig.providerAuth.removeSuccess', { provider }));
				// 先局部刷新（页面立即一致）；再触发 dashboard.store 重拉（外层一致性）
				await this.refreshAfterWrite();
				if (this.__unmounted || id !== this.clawId) return;
				try {
					await this.dashboardStore.loadDashboard(id, { force: true });
				}
				catch (err) {
					// dashboard 重拉失败不影响子页主流程，仅日志
					console.warn('[ModelConfigPage] dashboard reload after remove failed:', err?.message);
				}
				if (this.__unmounted) return;
				this.removeTarget = '';
			}
			catch (err) {
				if (this.__unmounted || id !== this.clawId) return;
				// 错误码 → i18n key 走共享 util；fallback 是 removeFailed（带 provider 参数）
				// 注意：mapModelConfigErrorKey 不带参数，所以 fallback 自带 {provider} 参数时
				// 仍需在调用方把 provider 注入；下方对 fallback 与公共 key 分别处理
				const code = err && typeof err === 'object' ? err.code : undefined;
				let key = mapModelConfigErrorKey(err, '');
				let msg;
				if (key) {
					msg = this.$t(key);
				}
				else {
					msg = this.$t('modelConfig.providerAuth.removeFailed', { provider });
				}
				this.notify.error(msg);
				console.warn('[ModelConfigPage] remove provider failed code=%s msg=%s', code ?? 'n/a', err?.message ?? 'n/a');
			}
			finally {
				if (!this.__unmounted) this.removeBusy = false;
			}
		},
	},
	beforeCreate() {
		this.__loadSeq = 0;
		this.__unmounted = false;
		// 当前打开的 add/picker dialog 所针对的 claw（写操作目标），见 onProviderAdded/onPrimaryPicked
		this.__writeClawId = '';
	},
	beforeUnmount() {
		// 标记 + 抢占 seq：让任何 inflight 的 loadAll / refreshAfterWrite / onConfirmRemove
		// 在 await 落地后只静默退出，不再写已卸载的组件状态
		this.__unmounted = true;
		++this.__loadSeq;
	},
};
</script>
