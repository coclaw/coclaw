<template>
	<div class="flex h-full min-h-0 flex-1 flex-col">
		<!-- 移动端 header（fallback /claws 处理 Electron / Capacitor 冷启 deep link） -->
		<MobilePageHeader :title="pageTitle" fallback="/claws" />

		<!-- 桌面端 header -->
		<header class="z-10 hidden shrink-0 min-h-12 items-center gap-1 border-b border-default bg-elevated pl-2 pr-4 py-1 md:flex">
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
			<!-- space-y-5 统一各区域纵向间距（与 body py-5 顶距一致）；离线 banner / retry / 两个 section 均按此节奏 -->
			<div class="mx-auto w-full max-w-2xl space-y-5 px-3 py-5 sm:px-4 lg:px-5">
				<!-- claw 离线提示：所有动作 disabled，按 design § 10 -->
				<div
					v-if="offline"
					data-testid="claw-offline-banner"
					class="rounded border border-warning bg-warning/10 px-3 py-2 text-sm text-warning"
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
						class="flex items-center justify-between rounded border border-default bg-elevated px-3 py-2 text-sm"
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
					<section class="rounded border border-default bg-default">
						<div class="flex items-center justify-between border-b border-default px-3 py-2">
							<h2 class="text-sm font-medium">{{ $t('modelConfig.primary.title') }}</h2>
						</div>
						<div class="px-3 py-2">
							<!-- 主模型未知（model.list RPC 失败）：占位，不强行报警告（决策4：清单没到先不下结论） -->
							<div v-if="primaryState === 'unknown'" data-testid="primary-unknown" class="text-sm text-muted">
								—
							</div>
							<!-- effective / notSet / invalid 统一一行：左=内容（有主模型把 provider/model 拆两行、各自 truncate，失效/未配再叠警告）、右=按钮（有主模型→更换、未配→配置，共用同一 picker） -->
							<div v-else class="flex items-center justify-between gap-2">
								<div class="min-w-0 flex-1 space-y-1">
									<!-- provider 暗一号 + model 等宽，各自 truncate；移动端不溢出（不换行，靠 truncate 收口、按钮钉右，见外层去掉 flex-wrap） -->
									<template v-if="primaryParsed">
										<span v-if="primaryParsed.provider" data-testid="primary-current-provider" class="block truncate text-xs text-muted">{{ primaryParsed.provider }}</span>
										<span data-testid="primary-current" class="block truncate font-mono text-sm">{{ primaryParsed.model }}</span>
									</template>
									<p v-if="primaryState !== 'effective'" data-testid="primary-warning" class="text-sm text-warning">
										{{ primaryState === 'invalid' ? $t('modelConfig.primary.invalidWarning') : $t('modelConfig.primary.notSetWarning') }}
									</p>
								</div>
								<UButton
									data-testid="btn-primary"
									class="shrink-0"
									variant="soft"
									color="primary"
									:disabled="!actionsEnabled"
									@click="onOpenPrimaryPicker"
								>
									{{ primary ? $t('modelConfig.primary.changeButton') : $t('modelConfig.primary.selectButton') }}
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
						<div v-else-if="!profiles.length" data-testid="provider-empty" class="px-3 py-6 flex justify-center items-center text-sm text-muted">
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
			:catalog="providerCatalog"
			:existing-providers="addProviderExclusion"
			:set-api-key="addProviderRpc"
			:login-oauth="addProviderLoginOauth"
			:cancel-oauth="addProviderCancelOauth"
			@added="onProviderAdded"
		/>

		<!-- 选 / 换主模型：唯一数据源吃 listAvailable 的 byProvider（含别名变体） -->
		<PrimaryModelPickerDialog
			v-model:open="pickerOpen"
			:usable="available"
			:current="primary"
			:set-primary="setPrimaryRpc"
			@picked="onPrimaryPicked"
			@add-provider="onPickerAddProvider"
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
import { mapModelConfigErrorKey, isCanceledError } from '../utils/model-config-errors.js';

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
			// 各 RPC fetched 标记：区分"已加载且为空"与"未加载所以默认空"。
			// 三核心 RPC（profiles/primary/catalogProviders）全失败才算 fullyFailed；listAvailable 不计入。
			loadOk: { profiles: false, primary: false, catalogProviders: false },
			profiles: [],
			// provider 目录（coclaw.providerAuth.catalog 的 providers）：[{ provider, authMethods, hasCred }]。
			// 加 provider 列表 = hasCred===false；authMethods 留 T3 多入口渲染用
			providerCatalog: [],
			// 可用清单（coclaw.model.listAvailable 的 byProvider）：选模型器唯一数据源 + primary 有效性输入。
			// null = 未就绪（还没回来 / 失败）→ primary 有效性"先不下结论"；对象 = 就绪（含空对象 = 权威空）
			available: null,
			primary: null,
			removeOpen: false,
			removeTarget: '',
			// 待撤凭据的来源（profile / inline / env）；决定 remove RPC 的分派 + 确认弹窗的配置文件提示
			removeSource: 'profile',
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
			// 仅在已尝试加载且三核心 RPC 全失败时展示；避免离线 / 未尝试时误报
			return this.loadAttempted && !this.loadOk.profiles && !this.loadOk.primary && !this.loadOk.catalogProviders;
		},
		/**
		 * "加 provider"时要排除的 provider id 集（决策4）：catalog 中 hasCred===true（已配）的 provider。
		 * 可加列表 = catalog 中 hasCred===false 的补集——hasCred 是别名感知、基座归一的权威"已配"信号。
		 */
		addProviderExclusion() {
			const out = [];
			for (const p of (Array.isArray(this.providerCatalog) ? this.providerCatalog : [])) {
				if (p && typeof p.provider === 'string' && p.provider && p.hasCred === true) {
					out.push(p.provider);
				}
			}
			return out;
		},
		/**
		 * primary 有效性（决策4）：输入 = {可用清单 available, 当前 primary}，皆必须项。
		 * 任一未就绪 → null（先不下结论，不误报）；都就绪 → 是否在可用清单内（membership）。
		 */
		primaryEffective() {
			return computePrimaryEffective(this.primary, this.available);
		},
		/**
		 * 主模型显示状态：
		 *   - 'unknown'  → model.list（primary 源）未成功，连 primary 都不知道：占位 —，不渲染警告
		 *   - 'notSet'   → model.list 成功且 primary 为空：渲染未配置警告
		 *   - 'effective'→ primary 非空，且（可用清单未就绪→先不下结论 或 在清单内）：仅渲染当前 primary
		 *   - 'invalid'  → primary 非空、可用清单已就绪、但 primary 不在清单内
		 *
		 * 关键（决策4）：可用清单"还没到"当成"先不下结论"（effective），不是"不在清单里"（invalid）。
		 * primaryEffective 用 null 表达"信息不全"，故仅 ===false 才判失效（不误报）。
		 */
		primaryState() {
			if (!this.loadOk.primary) return 'unknown';
			if (!this.primary) return 'notSet';
			return this.primaryEffective === false ? 'invalid' : 'effective';
		},
		/**
		 * 当前主模型拆 provider/model（镜像 picker 的 currentParsed）供分两行展示；
		 * 无有效 '/' 分隔时整串当 model 显示、不藏 provider 行（兜底，避免信息丢失）
		 * @returns {{ provider: string, model: string }|null} primary 为空时 null
		 */
		primaryParsed() {
			const p = this.primary;
			if (!p || typeof p !== 'string') return null;
			const idx = p.indexOf('/');
			if (idx <= 0 || idx === p.length - 1) return { provider: '', model: p };
			return { provider: p.slice(0, idx), model: p.slice(idx + 1) };
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
				this.providerCatalog = [];
				this.available = null;
				this.loadOk = { profiles: false, primary: false, catalogProviders: false };
				this.loadAttempted = false;
				// 撤销对话框是属于上一台 claw 的，强制关掉避免新 claw confirm 时拿到旧 provider
				this.removeOpen = false;
				this.removeTarget = '';
				this.removeSource = 'profile';
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

		/**
		 * 从 coclaw.model.list 出参解出主模型字符串。loadAll / refreshAfterWrite 复用，避免两处口径漂移。
		 * primary 有效性改由 listAvailable membership 判（决策4），故这里只取 primary、不再读凭据信号。
		 * @param {object} val - coclaw.model.list 出参
		 */
		__applyModelList(val) {
			const pri = val?.default?.primary;
			this.primary = (typeof pri === 'string' && pri) ? pri : null;
		},

		/**
		 * 应用一次 coclaw.model.listAvailable 的 allSettled 结果（loadAll / refreshAfterWrite 复用）。
		 * 成功 → byProvider 对象（含空对象 = 权威空）；失败 → null（未就绪：primary 有效性"先不下结论"、
		 * 选模型器显示空）。不做"新 UI + 旧 plugin"兼容兜底（决策1）。
		 *
		 * @param {{ status: string, value?: any, reason?: any }} res
		 */
		__applyAvailable(res) {
			if (res.status === 'fulfilled') {
				const val = res.value;
				this.available = (val && typeof val.byProvider === 'object' && val.byProvider) ? val.byProvider : {};
			}
			else {
				this.available = null;
				console.warn('[ModelConfigPage] listAvailable unavailable code=%s',
					(res.reason && res.reason.code) || 'n/a');
			}
		},

		/**
		 * 应用一次 coclaw.providerAuth.catalog 的 allSettled 结果（loadAll / refreshAfterWrite 复用）。
		 * 成功 → providers 数组（含空数组）；失败 → 清空为 []（不留陈旧 hasCred 误导加 provider 列表，
		 * 与 __applyAvailable 失败清 null 同精神；下次刷新 / 重连补回）。loadOk.catalogProviders 由调用方设。
		 *
		 * @param {{ status: string, value?: any, reason?: any }} res
		 */
		__applyCatalog(res) {
			if (res.status === 'fulfilled') {
				const arr = res.value?.providers;
				this.providerCatalog = Array.isArray(arr) ? arr : [];
			}
			else {
				this.providerCatalog = [];
				console.warn('[ModelConfigPage] providerAuth.catalog unavailable code=%s',
					(res.reason && res.reason.code) || 'n/a');
			}
		},

		async loadAll() {
			// 始终先 ++seq：让任何仍 inflight 的旧 load 在 await 后被丢弃。
			const seq = ++this.__loadSeq;
			// loading 一律在此置位、由 finally 按 seq 复位——连早返路径（无 id / 无连接）也走 finally；
			// 否则"加载在飞时切到无连接 claw"会留下 loading=true（旧 load 被 seq 拦下不复位、新 load 早返又不置位/复位）
			// → initialLoading 永久卡住。loading 生命周期完全归 loadAll 自管，watcher 不再代管。
			this.loading = true;
			try {
				const id = this.clawId;
				if (!id) return;
				const conn = useClawConnections().get(id);
				if (!conn) return;
				// 记下发请求那一刻的"配置版本"：若 await 期间有写操作（切主模型 / 增删凭据）落地，
				// __writeEpoch 会被 refreshAfterWrite 抬高 → 这批读到的是写前的陈旧数据，落地后必须丢弃，
				// 否则会把写后已刷新的新值覆盖回旧值（连接抖动重连触发的 loadAll 与切换撞车时的竞态）。
				// 残留竞态（已记 TODO，未修）：本守卫只挡"写前发出、await 期间被写抢占"的 loadAll；若 loadAll
				// 在写后 ~800ms 运行时陈旧快照窗口内才发起，会捕到新 epoch、读到陈旧 model.list 覆盖刚切的 primary。
				// 需重连恰好撞窗口（dcReady 很稳，几乎不翻）故极罕见，未加时间栅栏（避免耦合后端 hot-reload 时序 / 遮蔽外部改动）。
				const writeEpoch = this.__writeEpoch;
				// listAvailable 缺省 default scope（本期 UI 不暴露 per-agent，不传 agentId）
				const [profilesRes, modelRes, catalogRes, availableRes] = await Promise.allSettled([
					conn.request('coclaw.providerAuth.list', {}, { timeout: RPC_TIMEOUT }),
					conn.request('coclaw.model.list', {}, { timeout: RPC_TIMEOUT }),
					conn.request('coclaw.providerAuth.catalog', {}, { timeout: RPC_TIMEOUT }),
					conn.request('coclaw.model.listAvailable', {}, { timeout: RPC_TIMEOUT }),
				]);
				// 四重门：1) 组件还活着；2) clawId 还是同一个；3) 没被更新一轮 loadAll 抢占；
				// 4) await 期间没有写操作落地（否则这批已是写前陈旧数据，丢弃以防覆盖写后新值）
				if (this.__unmounted || seq !== this.__loadSeq || id !== this.clawId || writeEpoch !== this.__writeEpoch) return;
				this.loadOk = {
					profiles: profilesRes.status === 'fulfilled',
					primary: modelRes.status === 'fulfilled',
					catalogProviders: catalogRes.status === 'fulfilled',
				};
				if (profilesRes.status === 'fulfilled') {
					const arr = profilesRes.value?.profiles;
					this.profiles = Array.isArray(arr) ? arr : [];
				}
				if (modelRes.status === 'fulfilled') {
					this.__applyModelList(modelRes.value);
				}
				this.__applyCatalog(catalogRes);
				// listAvailable 失败不计入 fullyFailed（仅决定选模型器/primary 有效性数据，非三核心 RPC）
				this.__applyAvailable(availableRes);
				this.loadAttempted = true;
				if (this.fullyFailed) {
					this.notify.error(this.$t('modelConfig.common.connError'));
				}
			}
			finally {
				if (!this.__unmounted && seq === this.__loadSeq) this.loading = false;
			}
		},

		// --- 写后局部刷新 ---
		// trustPrimary 区分两类写：
		//   - trustPrimary=true（仅切主模型）：primary 已由 onPrimaryPicked 按"成功即权威"乐观置好，
		//     且刚切的模型本就来自当前可用清单（picker 数据源）→ 已是 effective。此路只重拉 profiles，
		//     刻意不重拉 model.list / catalog / listAvailable——任何重读都可能命中写前运行时陈旧快照、
		//     把乐观值/有效性判定覆盖回旧值（"切主模型回跳"bug 根因，红线）。
		//   - 默认（加/删 provider，pullWrite=true）：凭据变了 → 重拉 model.list（primary）+ providerAuth.catalog
		//     （hasCred 翻转 → 加 provider 列表刷新）+ listAvailable（可用清单 → 选模型器/primary 有效性刷新）。
		//     删掉主模型那家 provider 时，listAvailable 会少掉该 provider → membership 翻失效，必须放行。
		async refreshAfterWrite({ trustPrimary = false } = {}) {
			// 写操作已落地：抬高"配置版本"。一抬两用：① 让写前发出、仍在飞的 loadAll 落地时被四重门判陈旧丢弃；
			// ② 本方法 await 后自校验 writeEpoch——若在飞期间又有更晚的写落地，更早这次 refresh 不得覆盖新值。
			// 同步执行、先于任何 await——确保与 onPrimaryPicked 的成功赋值在同一同步段内完成。
			const writeEpoch = ++this.__writeEpoch;
			const id = this.clawId;
			const conn = useClawConnections().get(id);
			if (!conn) return;
			const pullWrite = !trustPrimary;
			try {
				// 固定四槽（profiles / model / catalog / available），未拉的槽以 resolve(null) 占位保持解构稳定
				const [profilesRes, modelRes, catalogRes, availableRes] = await Promise.allSettled([
					conn.request('coclaw.providerAuth.list', {}, { timeout: RPC_TIMEOUT }),
					pullWrite ? conn.request('coclaw.model.list', {}, { timeout: RPC_TIMEOUT }) : Promise.resolve(null),
					pullWrite ? conn.request('coclaw.providerAuth.catalog', {}, { timeout: RPC_TIMEOUT }) : Promise.resolve(null),
					pullWrite ? conn.request('coclaw.model.listAvailable', {}, { timeout: RPC_TIMEOUT }) : Promise.resolve(null),
				]);
				// unmount / 切 claw / 被更晚的写抢占 后丢弃这次 refresh 结果（见上方 writeEpoch 注释 ②）
				if (this.__unmounted || id !== this.clawId || writeEpoch !== this.__writeEpoch) return;
				if (profilesRes.status === 'fulfilled') {
					const arr = profilesRes.value?.profiles;
					this.profiles = Array.isArray(arr) ? arr : [];
					this.loadOk.profiles = true;
				}
				if (pullWrite) {
					if (modelRes.status === 'fulfilled') {
						this.__applyModelList(modelRes.value);
						this.loadOk.primary = true;
					}
					// 成功 → 刷新 hasCred；失败 → 清空（不留写前陈旧 hasCred 误导加 provider 列表）
					this.__applyCatalog(catalogRes);
					this.loadOk.catalogProviders = catalogRes.status === 'fulfilled';
					// 成功 → 刷新可用清单；失败 → null（未就绪，primary 有效性"先不下结论"，不误报失效）
					this.__applyAvailable(availableRes);
				}
				if (profilesRes.status === 'rejected' || (pullWrite && modelRes.status === 'rejected')) {
					console.warn('[ModelConfigPage] refreshAfterWrite partial failure',
						profilesRes.status === 'rejected' ? profilesRes.reason?.message : null,
						(pullWrite && modelRes.status === 'rejected') ? modelRes.reason?.message : null);
				}
			}
			catch (err) {
				// allSettled 应该不会进这里；万一进了，仅日志，外层 dashboard.store 重拉兜底一致性
				console.warn('[ModelConfigPage] refreshAfterWrite unexpected error:', err?.message);
			}
		},

		// --- 主模型按钮：打开 picker（更换 / 配置 共用同一对话框与处理） ---
		onOpenPrimaryPicker() {
			if (!this.actionsEnabled) return;
			// 记下"这次写操作针对哪台 claw"：clawId 在 dialog 打开期间稳定（一旦切换 watcher 会关掉 dialog），
			// 所以打开时刻即写操作目标。事件回调据此判断 inflight RPC 落地时是否已切走
			this.__writeClawId = this.clawId;
			this.pickerOpen = true;
		},

		// --- 添加 provider：打开 stepper ---
		onAddProvider() {
			if (!this.actionsEnabled) return;
			this.__writeClawId = this.clawId;
			this.addOpen = true;
		},

		// picker 空态"去添加"快捷入口：关选择器 + 开添加对话框（单向，加完不自动回选择器）
		onPickerAddProvider() {
			this.pickerOpen = false;
			this.onAddProvider();
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
		 * 给 AddProviderDialog / ProviderOAuthLoginStep 注入的两阶段账号授权函数。
		 * timeout:0——账号授权要等用户去授权（可能分钟级），不设 RPC 超时；终态由 plugin 后端
		 * phase-2 帧驱动（成功 / OAUTH_*），断连兜底由组件层 signal abort 清理。
		 *
		 * @param {{ provider: string, onAccepted: Function, signal: AbortSignal }} args
		 */
		addProviderLoginOauth({ provider, onAccepted, signal }) {
			const id = this.clawId;
			// 记下本次登录针对哪台 claw：取消/卸载清理时据此定位后端，而非读当时的 this.clawId。
			// 账号授权期间切到别的 claw 会改 this.clawId；cancelOauth 若读当前值会把取消发去错的 claw、
			// 留原 claw 后台轮询到授权码过期才自停。client 侧 waiter 由组件 signal abort 收掉，与此独立。
			this.__oauthClawId = id;
			const conn = useClawConnections().get(id);
			if (!conn) {
				return Promise.reject(Object.assign(new Error('connection not ready'), { code: 'DC_CLOSED' }));
			}
			return conn.request(
				'coclaw.providerAuth.loginOauth',
				{ provider },
				{ onAccepted, signal, timeout: 0 }
			);
		},

		/**
		 * 取消进行中的账号授权（拨掉后端轮询，幂等）。无连接时静默 resolve（best-effort 清理）。
		 * 用登录时记下的 __oauthClawId 定位（见 addProviderLoginOauth），缺省回退当前 claw。
		 *
		 * @param {{ loginId: string }} args
		 */
		addProviderCancelOauth({ loginId }) {
			const id = this.__oauthClawId || this.clawId;
			const conn = useClawConnections().get(id);
			if (!conn) return Promise.resolve({});
			return conn.request(
				'coclaw.providerAuth.cancelOauth',
				{ loginId },
				{ timeout: RPC_TIMEOUT }
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
		 * AddProviderDialog 'added' 事件回调：refresh + dashboard reload（成功不 notify）
		 *
		 * 关键：用打开时记下的 __writeClawId 作目标。若 inflight RPC 落地时用户已切到别的 claw，
		 * 直接丢弃——不要给当前 claw 弹"已添加"、也不要拿别的 claw 的写结果去刷它的 dashboard
		 *
		 * @param {{ provider: string, profileId?: string }} info
		 */
		async onProviderAdded(info) {
			const target = this.__writeClawId;
			if (this.__unmounted || !target || this.clawId !== target) return;
			// 局部 refresh 让子页凭据列表立即一致；成功不 notify：新 provider 立即出现在凭据列表，
			// 用户可直接分辨，失败才提示（与 onPrimaryPicked / 撤销 provider 一致）
			await this.refreshAfterWrite();
			if (this.__unmounted || this.clawId !== target) return;
			// dashboard.store 触发外层（ManageClaws 卡片）一致性，稍后追上
			try {
				await this.dashboardStore.loadDashboard(target, { force: true });
			}
			catch (err) {
				console.warn('[ModelConfigPage] dashboard reload after add failed:', err?.message);
			}
		},

		/**
		 * PrimaryModelPickerDialog 'picked' 事件回调。
		 *
		 * picker 是 await setPrimary 成功后才 emit 'picked'，故进到这里时主模型已写盘成功。
		 * 按"成功即权威、不重读确认"：直接把成功值设为页面主模型，不靠之后那次可能陈旧的 model.list 读回覆盖
		 * （那次读可能命中写前的运行时快照 → 把新值盖回旧值，即"切主模型回跳"bug）。
		 *
		 * primary 有效性（决策4）：刚切的模型本就来自当前可用清单（picker 的数据源 available），故乐观置
		 * primary 后 membership 立即成立 → effective，无需 model.list 凭据信号。经 refreshAfterWrite(trustPrimary)
		 * 跳过 model.list / catalog / listAvailable 重读，避免任何陈旧读把乐观值或有效性判定打翻。
		 *
		 * @param {{ primary: string }} info
		 */
		async onPrimaryPicked(info) {
			const target = this.__writeClawId;
			if (this.__unmounted || !target || this.clawId !== target) return;
			if (info?.primary) {
				// 成功即权威：直接置主模型，refreshAfterWrite(trustPrimary) 不再重读覆盖
				this.primary = info.primary;
				this.loadOk.primary = true;
			}
			// 仅在确有成功值时信任 primary；缺值（理论上 picker 不会发）回退默认路径，照常重读 model.list
			await this.refreshAfterWrite({ trustPrimary: !!info?.primary });
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
		// ProviderAuthRow emit 带 { provider, source }：source 决定 remove RPC 的分派
		// （账本删凭据 / 内联删 key 字段）与确认弹窗的配置文件提示。env 行删除按钮已禁用，不会到这。
		onRemoveProvider({ provider, source } = {}) {
			if (!provider) return;
			this.removeTarget = provider;
			this.removeSource = (source === 'inline' || source === 'env') ? source : 'profile';
			this.removeOpen = true;
		},
		onCancelRemove() {
			// busy 时忽略 cancel（在 busy 中按 cancel/Esc/遮罩 都不该让 RPC 继续在后台跑+对话框消失）
			if (this.removeBusy) return;
			this.removeOpen = false;
			this.removeTarget = '';
			this.removeSource = 'profile';
		},
		async onConfirmRemove() {
			const id = this.clawId;
			const provider = this.removeTarget;
			const source = this.removeSource;
			if (!id || !provider || this.removeBusy) return;
			const conn = useClawConnections().get(id);
			if (!conn) {
				// 连接没了就别静默——给用户反馈并关掉对话框
				this.notify.error(this.$t('modelConfig.common.connError'));
				this.removeOpen = false;
				this.removeTarget = '';
				this.removeSource = 'profile';
				return;
			}
			this.removeBusy = true;
			try {
				// 带 source：账本删凭据 / 内联删 key 字段（§2.5）。旧插件忽略 source、只按 provider 删账本——
				// 但旧插件也列不出内联（list 无 source 字段），故不会出现"对旧插件发 inline source"的不一致
				await conn.request('coclaw.providerAuth.remove', { provider, source }, { timeout: RPC_TIMEOUT });
				if (this.__unmounted || id !== this.clawId) return; // 切页 / 切 claw 后只静默退出
				this.removeOpen = false;
				// 成功不 notify：撤销后列表会刷掉该行，用户可直接分辨（与设主模型同精神，失败才提示）
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
				this.removeSource = 'profile';
			}
			catch (err) {
				if (this.__unmounted || id !== this.clawId) return;
				if (isCanceledError(err)) {
					// 显式取消：默默关闭，不报错（与加 provider / 设主模型两弹窗对齐）
					this.removeOpen = false;
					this.removeTarget = '';
					this.removeSource = 'profile';
					return;
				}
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
		// "配置版本"计数器：每次写操作（refreshAfterWrite）+1，loadAll 据此丢弃跨写陈旧结果
		this.__writeEpoch = 0;
		this.__unmounted = false;
		// 当前打开的 add/picker dialog 所针对的 claw（写操作目标），见 onProviderAdded/onPrimaryPicked
		this.__writeClawId = '';
		// 账号授权针对的 claw：取消清理用它定位后端（切 claw 后 this.clawId 已变），见 addProviderLoginOauth
		this.__oauthClawId = '';
	},
	beforeUnmount() {
		// 标记 + 抢占 seq：让任何 inflight 的 loadAll / refreshAfterWrite / onConfirmRemove
		// 在 await 落地后只静默退出，不再写已卸载的组件状态
		this.__unmounted = true;
		++this.__loadSeq;
	},
};
</script>
