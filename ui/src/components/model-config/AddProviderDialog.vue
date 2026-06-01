<template>
	<UModal
		:open="open"
		:title="title"
		description=" "
		:ui="modalUi"
		:fullscreen="modalFullscreen"
		@update:open="onModalOpenChange"
	>
		<template #body>
			<div data-testid="add-provider-dialog" class="flex h-full min-h-0 flex-col gap-3 md:h-auto">
				<!-- Step 1: 选 provider（全屏下 flex-1 填满，桌面端 md:flex-none 维持紧凑） -->
				<div v-if="step === 'select'" class="flex min-h-0 flex-1 flex-col gap-3 md:flex-none">
					<!-- 搜索框两端各冒出 2px：外层块级 div 用 -mx-0.5 自动撑出 4px，内层 input w-full 填满（同列表 -mx-2 的做法） -->
					<div class="-mx-0.5">
						<UInput
							v-model="searchText"
							data-testid="add-provider-search"
							icon="i-lucide-search"
							:placeholder="$t('modelConfig.providerAuth.add.searchPlaceholder')"
							size="md"
							class="w-full"
						/>
					</div>

					<!-- 列表区：全屏下填满高度、桌面端 md:max-h-96 限高；内部滚动且隐藏滚动条（与主列表一致） -->
					<div data-testid="add-provider-list" class="-mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-hide md:max-h-96 md:flex-none">
						<template v-if="popularList.length">
							<p class="px-2 pt-1 pb-1 text-xs font-medium text-muted">
								{{ $t('modelConfig.providerAuth.add.groupPopular') }}
							</p>
							<button
								v-for="p in popularList"
								:key="`pop-${p.id}`"
								type="button"
								class="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accented/80"
								:data-testid="`add-provider-item-${p.id}`"
								@click="onPickProvider(p.id)"
							>
								<!-- 直接显示 OpenClaw 原生 provider id（映射的 displayName 不全且二者大致相同，暂不用映射） -->
								<span class="min-w-0 truncate -mt-0.5">{{ p.id }}</span>
								<!-- oauth 能力徽章：authMethods 含 oauth 入口才贴（api-key 默认不贴，降噪）；样式同已配栏 -->
								<UBadge
									v-if="p.hasOauth"
									:data-testid="`add-provider-oauth-tag-${p.id}`"
									color="neutral"
									variant="subtle"
									size="sm"
									class="shrink-0"
								>
									oauth
								</UBadge>
							</button>
						</template>

						<template v-if="otherList.length">
							<p class="px-2 pt-1 pb-1 text-xs font-medium text-muted">
								{{ $t('modelConfig.providerAuth.add.groupOther') }}
							</p>
							<button
								v-for="p in otherList"
								:key="`oth-${p.id}`"
								type="button"
								class="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accented/80"
								:data-testid="`add-provider-item-${p.id}`"
								@click="onPickProvider(p.id)"
							>
								<!-- 直接显示 OpenClaw 原生 provider id（映射的 displayName 不全且二者大致相同，暂不用映射） -->
								<span class="min-w-0 truncate -mt-0.5">{{ p.id }}</span>
								<!-- oauth 能力徽章：authMethods 含 oauth 入口才贴（api-key 默认不贴，降噪）；样式同已配栏 -->
								<UBadge
									v-if="p.hasOauth"
									:data-testid="`add-provider-oauth-tag-${p.id}`"
									color="neutral"
									variant="subtle"
									size="sm"
									class="shrink-0"
								>
									oauth
								</UBadge>
							</button>
						</template>

						<div
							v-if="!popularList.length && !otherList.length"
							data-testid="add-provider-empty"
							class="px-2 py-6 text-center text-sm text-muted"
						>
							{{ $t('modelConfig.providerAuth.add.noProviders') }}
						</div>
					</div>
				</div>

				<!-- Step 2: 配置（按 catalog authMethods 多入口；零特判，OpenClaw 给什么列什么） -->
				<div v-else class="flex h-full min-h-0 flex-col gap-3 md:h-auto">
					<!-- 多方式时先选入口（单方式 onPickProvider 已直接进对应入口，不显示 chooser） -->
					<div v-if="!selectedMethod" data-testid="add-method-chooser" class="flex flex-col gap-3">
						<button
							v-for="m in selectedProviderMethods"
							:key="m"
							type="button"
							:data-testid="`add-method-${m}`"
							class="flex min-h-10 cursor-pointer items-center rounded-md border border-default px-3 py-2 text-left text-sm hover:bg-accented/80"
							@click="onPickMethod(m)"
						>
							{{ methodLabel(m) }}
						</button>
						<!-- 返回按钮统一落到对话框 footer（见下方 #footer），此处不再内联 -->
					</div>

					<!-- oauth-device-code：账号授权两阶段步。动作（取消/返回/重试）由 footer 承载，
					     本步只显示状态文案；通过 update:phase 把阶段抛上来驱动 footer -->
					<ProviderOAuthLoginStep
						v-else-if="selectedMethod === 'oauth-device-code'"
						ref="oauthStep"
						:provider="selectedProvider"
						:login-oauth="loginOauth"
						:cancel-oauth="cancelOauth"
						@update:phase="oauthPhase = $event"
						@success="onOauthSuccess"
						@cancel="onMethodBack"
					/>

					<!-- api-key：输 key（form 仅用于支持原生回车提交；提交按钮与回车都走 onSubmit）-->
					<!-- 注：oauth-login（cb 回环回调）暂不支持，不再进入配置子屏——点击该入口直接 notify，
					     selectedMethod 永不为 'oauth-login'（见 onPickProvider/onPickMethod） -->
					<form v-else class="flex flex-col gap-3" autocomplete="off" @submit.prevent="onSubmit">
						<!-- API key 是秘钥而非登录凭据：用 type=text + CSS 打码（cc-secret-mask）而非 type=password。
						     若用 type=password，浏览器密码管家会弹“保存/更新密码”——Chrome 无视 autocomplete=off，只要是
						     password 框就提示，还把当前登录账号名当 username 关联。改 type=text 后它不再被当密码框，弹窗连同
						     “password 不在 form 内 / 表单应含 username 字段”等相关告警一并消失。 -->
						<!-- 输入框自带 placeholder，无需额外 label；aria-label 保留可达性 -->
						<!-- type=text 后移动端输入法的自动大写/纠错会复活，可能把手敲的 key 首字母大写或纠错弄坏，
						     故显式关掉 autocapitalize/autocorrect/spellcheck（type=password 时浏览器默认就不做这些） -->
						<UInput
							v-model="apiKey"
							data-testid="add-provider-key-input"
							type="text"
							autocomplete="off"
							spellcheck="false"
							autocapitalize="none"
							autocorrect="off"
							:ui="{ base: 'cc-secret-mask' }"
							:aria-label="$t('modelConfig.providerAuth.add.keyLabel')"
							:placeholder="$t('modelConfig.providerAuth.add.keyPlaceholder')"
							:disabled="submitting"
						/>
	
						<!-- 错误：仅在 inlineErrorKey 非空时渲染 -->
						<p
							v-if="inlineErrorKey"
							data-testid="add-provider-error"
							class="text-sm text-error"
						>
							{{ $t(inlineErrorKey) }}
						</p>
	
						<!-- "去官网创建"提示：问句与链接分两行——窄卡片宽度更从容，整体高度更协调 -->
						<div v-if="dashboardUrl" class="flex flex-col gap-1 text-sm text-muted">
							<span>{{ $t('modelConfig.providerAuth.add.noKeyHint', { provider: selectedProvider }) }}</span>
							<a
								data-testid="add-provider-dashboard-link"
								class="self-start text-primary underline cursor-pointer"
								:aria-label="$t('modelConfig.providerAuth.add.dashboardLink', { provider: selectedProvider })"
								@click="onOpenDashboard"
							>
								{{ $t('modelConfig.providerAuth.add.dashboardLink', { provider: selectedProvider }) }}
							</a>
						</div>
					</form>
				</div>
			</div>
		</template>

		<!-- 统一 footer：configure 步的所有动作都右下角对齐（select 步无 footer）。
		     返回用实心 primary（同 prompt 对话框"确认"按钮，暗色下不发白）；取消用实心 error（abort 语义）；
		     双按钮保持 ghost neutral + primary。 -->
		<template v-if="footerMode" #footer>
			<div class="flex w-full justify-end gap-2">
				<!-- 方法 chooser：单个返回 → 实心 primary -->
				<UButton
					v-if="footerMode === 'chooser'"
					data-testid="add-method-back"
					color="primary"
					@click="onMethodBack"
				>
					{{ $t('modelConfig.providerAuth.add.back') }}
				</UButton>

				<!-- 账号授权 starting/pending：单个取消 → 实心 error（abort 语义，同撤销凭据对话框"仍然撤销"） -->
				<UButton
					v-else-if="footerMode === 'oauth-cancel'"
					data-testid="oauth-cancel"
					color="error"
					@click="onOauthCancel"
				>
					{{ $t('common.cancel') }}
				</UButton>

				<!-- 账号授权 error：返回 + 重试（双按钮） -->
				<template v-else-if="footerMode === 'oauth-error'">
					<UButton
						data-testid="oauth-back"
						variant="ghost"
						color="neutral"
						@click="onOauthBack"
					>
						{{ $t('modelConfig.providerAuth.add.back') }}
					</UButton>
					<UButton
						data-testid="oauth-retry"
						color="primary"
						@click="onOauthRetry"
					>
						{{ $t('common.retry') }}
					</UButton>
				</template>

				<!-- api-key：取消 + 提交（双按钮） -->
				<template v-else-if="footerMode === 'api-key'">
					<UButton
						data-testid="add-provider-cancel"
						variant="ghost"
						color="neutral"
						:disabled="submitting"
						@click="onCancel"
					>
						{{ $t('common.cancel') }}
					</UButton>
					<UButton
						data-testid="add-provider-submit"
						color="primary"
						:loading="submitting"
						:disabled="submitting"
						@click="onSubmit"
					>
						{{ $t('modelConfig.providerAuth.add.submitButton') }}
					</UButton>
				</template>
			</div>
		</template>
	</UModal>
</template>

<script>
import { getProviderMeta, PROVIDER_META } from '../../constants/provider-meta.js';
import { promptModalUi } from '../../constants/prompt-modal-ui.js';
import { mapModelConfigErrorKey, isCanceledError } from '../../utils/model-config-errors.js';
import { openExternalUrl } from '../../utils/external-url.js';
import { useEnvStore } from '../../stores/env.store.js';
import { useNotify } from '../../composables/use-notify.js';
import ProviderOAuthLoginStep from './ProviderOAuthLoginStep.vue';

const RPC_TIMEOUT = 60_000;

// catalog authMethods 已知三类 + 固定渲染顺序（api-key 优先，其次账号授权，最后 oauth-login 暂不支持）。
// 顺序写死让多入口渲染稳定、零特判；未知 kind（token/custom）catalog 本就不会下发。
const KNOWN_AUTH_METHODS = ['api-key', 'oauth-device-code', 'oauth-login'];

export default {
	name: 'AddProviderDialog',
	components: {
		ProviderOAuthLoginStep,
	},
	props: {
		open: {
			type: Boolean,
			default: false,
		},
		/**
		 * provider 目录（`coclaw.providerAuth.catalog` 出参 providers）：每项
		 * `{ provider, authMethods, hasCred }`（setup 全集，基座 id、每 provider 一条）。
		 * 本组件按 `provider` 字段去重出可选项；hasCred 维度的"已配排除"由父组件经
		 * `existingProviders` 传入（口径全在父组件）。`authMethods` 驱动配置步的多入口渲染
		 * （api-key 输 key / oauth-device-code 账号授权 / oauth-login 暂不支持）。
		 *
		 * @type {{ provider: string, authMethods?: string[], hasCred?: boolean }[]}
		 */
		catalog: {
			type: Array,
			default: () => [],
		},
		/**
		 * 要从"可加 provider"列表里排除的 provider id 集（Step 1）。由父组件按 catalog 的
		 * `hasCred === true`（已配）算好传入；本组件只做按 id 精确排除，不关心来源。
		 *
		 * @type {string[]}
		 */
		existingProviders: {
			type: Array,
			default: () => [],
		},
		/**
		 * 触发 setApiKey 的回调：由父组件提供（通常 wrap 一次 conn.request）
		 * 返回 promise；成功 resolve 任何值，失败 reject Error（带 code）
		 *
		 * 把 RPC 调用以函数形式注入而非组件直接拿 conn，是为了：
		 *   1) 让测试只注入一个 vi.fn() 即可，不必 mock 整个 connection manager
		 *   2) 父组件 ModelConfigPage 在 wrap 时可注入 unmount/clawId 守卫
		 *
		 * @type {(args: { provider: string, apiKey: string }) => Promise<unknown>}
		 */
		setApiKey: {
			type: Function,
			default: null,
		},
		/**
		 * 发起两阶段 OAuth 账号授权的回调，透传给 ProviderOAuthLoginStep（账号授权入口用）。
		 *   ({ provider, onAccepted, signal }) => Promise
		 * 父组件 ModelConfigPage wrap 一次 conn.request('coclaw.providerAuth.loginOauth')。
		 *
		 * @type {(args: { provider: string, onAccepted: Function, signal: AbortSignal }) => Promise<unknown>}
		 */
		loginOauth: {
			type: Function,
			default: null,
		},
		/**
		 * 取消进行中的 OAuth 登录，透传给 ProviderOAuthLoginStep：({ loginId }) => Promise。
		 *
		 * @type {(args: { loginId: string }) => Promise<unknown>}
		 */
		cancelOauth: {
			type: Function,
			default: null,
		},
	},
	emits: ['update:open', 'added'],
	setup() {
		return {
			envStore: useEnvStore(),
			notify: useNotify(),
		};
	},
	data() {
		return {
			/** 'select' = 选 provider，'configure' = 配置（按 authMethods 多入口） */
			step: 'select',
			/** Step 1 搜索关键词 */
			searchText: '',
			/** Step 1 选定的 provider id（进入 configure 前 set） */
			selectedProvider: '',
			/**
			 * configure 步选定的认证入口（'' = 显示方法 chooser，多方式时用）。
			 * 单方式 provider 在 onPickProvider 即直接置成那一种，跳过 chooser。
			 */
			selectedMethod: '',
			/** api-key 入口的 key input（提交成功立即清空，防止内存里残留） */
			apiKey: '',
			/** Step 2 内联错误的 i18n key（'' 表示无错误） */
			inlineErrorKey: '',
			/** 正在调 setApiKey RPC */
			submitting: false,
			/** 账号授权子步当前阶段（starting/pending/error），经子步 update:phase 同步，驱动 footer */
			oauthPhase: 'starting',
		};
	},
	computed: {
		isMobile() {
			return this.envStore?.screen?.ltMd === true;
		},
		/**
		 * Step 2（输 key）套用项目统一 confirm 弹窗样式（窄卡片 max-w-sm + 无分割线 + footer 放按钮）；
		 * Step 1（选 provider 列表）保持默认更宽的弹窗，承载列表
		 */
		modalUi() {
			if (this.step !== 'configure') return undefined;
			// 局部收紧 body 底部 padding（pt-3 同全局、pb-2 收紧），不改全局 promptModalUi
			return { ...promptModalUi, body: 'px-4 pt-3 pb-2 sm:px-5 sm:pt-3 sm:pb-2' };
		},
		/**
		 * 仅 Step 1 列表在移动端全屏铺开；Step 2 走 confirm 小卡片，移动端也居中显示不全屏
		 */
		modalFullscreen() {
			return this.isMobile && this.step === 'select';
		},
		/**
		 * 标题文案：Step 1 是 "选择 provider"，Step 2 是 "配置 <provider id>"（统一用原生 id，不用映射名）
		 */
		title() {
			if (this.step === 'select') {
				return this.$t('modelConfig.providerAuth.add.stepSelectTitle');
			}
			return this.$t('modelConfig.providerAuth.add.stepConfigTitle', {
				provider: this.selectedProvider,
			});
		},
		dashboardUrl() {
			return PROVIDER_META[this.selectedProvider]?.dashboardUrl ?? '';
		},
		/**
		 * catalog 派生的可加 provider 集合：按 provider 去重、剔除已配（existingProviders）。
		 * 返回 [{ id, displayName, popular, hasOauth }]，按 displayName 字典序排。
		 * hasOauth：authMethods 含任一 oauth 入口（device-code / login）即真，驱动列表项 oauth 徽章
		 * （api-key 默认不贴，降噪；与 selectedProviderMethods 同口径——防御性合并同 provider 多条目）。
		 */
		availableProviders() {
			const existing = new Set(Array.isArray(this.existingProviders) ? this.existingProviders : []);
			const cat = Array.isArray(this.catalog) ? this.catalog : [];
			const byId = new Map();
			for (const m of cat) {
				const id = m && typeof m.provider === 'string' ? m.provider : '';
				if (!id || existing.has(id)) continue;
				let entry = byId.get(id);
				if (!entry) {
					const meta = getProviderMeta(id);
					entry = { id, displayName: meta.displayName, popular: !!meta.popular, hasOauth: false };
					byId.set(id, entry);
				}
				if (Array.isArray(m.authMethods) &&
					(m.authMethods.includes('oauth-device-code') || m.authMethods.includes('oauth-login'))) {
					entry.hasOauth = true;
				}
			}
			const out = Array.from(byId.values());
			out.sort((a, b) => a.displayName.localeCompare(b.displayName));
			return out;
		},
		filteredProviders() {
			const q = this.searchText.trim().toLowerCase();
			if (!q) return this.availableProviders;
			return this.availableProviders.filter(p =>
				p.id.toLowerCase().includes(q) || p.displayName.toLowerCase().includes(q)
			);
		},
		popularList() {
			return this.filteredProviders.filter(p => p.popular);
		},
		otherList() {
			return this.filteredProviders.filter(p => !p.popular);
		},
		/**
		 * 选定 provider 的认证入口集（来自 catalog.authMethods）：合并该 provider 全部 catalog
		 * 条目的 authMethods、仅保留已知三类、按固定顺序去重。决定 configure 步渲染哪些入口。
		 *
		 * 同一 provider 同时含 device-code 与 oauth-login 时只留 device-code：cb（回环回调）我们
		 * 暂不支持，留着只会多出一个点了即"暂不支持"的死入口；隐掉后这类 provider 塌成单/少入口。
		 * 对用户而言两种 OAuth 体验等价（都开页授权），无需暴露差异。
		 *
		 * @returns {string[]}
		 */
		selectedProviderMethods() {
			const cat = Array.isArray(this.catalog) ? this.catalog : [];
			const found = new Set();
			for (const m of cat) {
				if (m && m.provider === this.selectedProvider && Array.isArray(m.authMethods)) {
					for (const k of m.authMethods) found.add(k);
				}
			}
			if (found.has('oauth-device-code')) found.delete('oauth-login');
			return KNOWN_AUTH_METHODS.filter(k => found.has(k));
		},
		/**
		 * 当前 footer 渲染模式（'' = 不渲染 footer）。统一各 configure 子态的动作落点：
		 *   chooser = 单返回；oauth-cancel（账号授权 starting/pending）= 单取消；
		 *   oauth-error = 返回+重试；api-key = 取消+提交。
		 * 账号授权 starting 态也渲染取消：①否则提示文案下无动作、标题区显得很重；
		 * ②phase-1 受理可能因网络阻障迟迟不回，用户需能随时取消（取消的本地容错见 ProviderOAuthLoginStep.onCancel）。
		 *
		 * @returns {string}
		 */
		footerMode() {
			if (this.step !== 'configure') return '';
			if (!this.selectedMethod) return 'chooser';
			if (this.selectedMethod === 'api-key') return 'api-key';
			if (this.selectedMethod === 'oauth-device-code') {
				if (this.oauthPhase === 'error') return 'oauth-error';
				// starting + pending 都可取消
				return 'oauth-cancel';
			}
			return '';
		},
	},
	watch: {
		open(val) {
			// open=true 时重置：保证关掉再开是干净状态
			if (val) {
				this.resetState();
			}
			else if (!val) {
				// 关闭后清空 apiKey——防止后续重开仍保留前次输入
				// （即便父组件没销毁本组件——v-model:open 控制可见性而已）
				this.apiKey = '';
				this.inlineErrorKey = '';
			}
		},
	},
	methods: {
		resetState() {
			this.step = 'select';
			this.searchText = '';
			this.selectedProvider = '';
			this.selectedMethod = '';
			this.apiKey = '';
			this.inlineErrorKey = '';
			this.submitting = false;
			this.oauthPhase = 'starting';
		},
		/** footer 取消（账号授权 pending 态）：委托子步做 teardown + emit cancel → onMethodBack */
		onOauthCancel() {
			this.$refs.oauthStep?.onCancel();
		},
		/** footer 返回（账号授权 error 态）：委托子步 emit cancel → onMethodBack */
		onOauthBack() {
			this.$refs.oauthStep?.onBack();
		},
		/** footer 重试（账号授权 error 态）：委托子步重新发起登录 */
		onOauthRetry() {
			this.$refs.oauthStep?.start();
		},
		/** configure 入口的人类可读标签（chooser 列表项用） */
		methodLabel(method) {
			if (method === 'api-key') return this.$t('modelConfig.providerAuth.add.methodApiKey');
			if (method === 'oauth-device-code') return this.$t('modelConfig.providerAuth.add.methodDeviceCode');
			return this.$t('modelConfig.providerAuth.add.methodOauthLogin');
		},
		closeAll() {
			this.$emit('update:open', false);
		},
		onCancel() {
			// footer 取消按钮：等价于关闭；submitting 期间忽略，避免对话框消失而后台仍跑
			if (this.submitting) return;
			this.closeAll();
		},
		onModalOpenChange(value) {
			// UModal close（X / 遮罩 / Esc）等价于取消；submitting 期间忽略
			if (!value) {
				if (this.submitting) return;
				this.closeAll();
			}
		},
		onPickProvider(providerId) {
			if (!providerId) return;
			// 先置 provider 让 selectedProviderMethods 可计算；仅当真要进配置屏才推进 step。
			this.selectedProvider = providerId;
			const methods = this.selectedProviderMethods;
			// 仅 oauth-login（cb 回环回调，暂不支持）这一种方式时不进配置屏：弹 toast、留在 provider 列表。
			// 避免切屏导致列表滚动位置丢失（select / configure 互斥渲染，返回会从头重渲染）。
			if (methods.length === 1 && methods[0] === 'oauth-login') {
				this.selectedProvider = '';
				this.notify.warning(this.$t('modelConfig.providerAuth.add.oauthLoginUnsupported', { provider: providerId }));
				return;
			}
			this.step = 'configure';
			this.apiKey = '';
			this.inlineErrorKey = '';
			// 单方式直接进入对应入口（跳过 chooser）；多方式（含 0，理论不出现）显示 chooser
			this.selectedMethod = methods.length === 1 ? methods[0] : '';
		},
		onPickMethod(method) {
			if (!method) return;
			// oauth-login（cb 回环回调）暂不支持：留在 chooser、弹 toast（不进配置子屏，移动端更友好）。
			if (method === 'oauth-login') {
				this.notify.warning(this.$t('modelConfig.providerAuth.add.oauthLoginUnsupported', { provider: this.selectedProvider }));
				return;
			}
			this.selectedMethod = method;
			this.apiKey = '';
			this.inlineErrorKey = '';
		},
		/**
		 * 配置步内的"返回"：多方式 provider 从某入口回到 chooser；否则（chooser 自身 / 单方式）
		 * 回到 provider 选择。也复用为账号授权步的取消回退。
		 */
		onMethodBack() {
			if (this.selectedMethod && this.selectedProviderMethods.length > 1) {
				this.selectedMethod = '';
				this.apiKey = '';
				this.inlineErrorKey = '';
				return;
			}
			this.backToSelect();
		},
		backToSelect() {
			this.step = 'select';
			this.selectedProvider = '';
			this.selectedMethod = '';
			this.apiKey = '';
			this.inlineErrorKey = '';
		},
		/**
		 * ProviderOAuthLoginStep 'success'：与 api-key 成功同路——透传给父组件 + 关闭对话框。
		 * @param {{ provider: string, profileId?: string }} info
		 */
		onOauthSuccess(info) {
			this.$emit('added', { provider: info?.provider ?? this.selectedProvider, profileId: info?.profileId });
			this.closeAll();
		},
		onOpenDashboard() {
			if (!this.dashboardUrl) return;
			// fire-and-forget：openExternalUrl 内部已兜底；这里再 catch 一层避免极端环境抛出
			Promise.resolve(openExternalUrl(this.dashboardUrl)).catch(() => {});
		},
		async onSubmit() {
			if (this.submitting) return;
			const provider = this.selectedProvider;
			if (!provider) return;
			// 必须 trim 后判空——前后空格用户难发现，提交也容易被 plugin 拒
			const trimmed = (this.apiKey ?? '').trim();
			if (!trimmed) {
				this.inlineErrorKey = 'modelConfig.common.errInvalidArgs';
				return;
			}
			if (!this.setApiKey) {
				// 父组件没注入 RPC 通道——给个内联错误，不静默失败
				this.inlineErrorKey = 'modelConfig.common.connError';
				return;
			}
			this.inlineErrorKey = '';
			// 提交前立即清空 input 中的 raw key——设计 § 12「提交后不落地 UI 任何缓存」。
			// trimmed 是不可变 string 本地副本，已携带真正要发的值；清空 this.apiKey 不影响它。
			// 放在 await 前是关键：慢/超时 RPC 期间 raw key 不会在组件 state / 禁用 input 里滞留。
			this.apiKey = '';
			this.submitting = true;
			try {
				const result = await this.setApiKey({ provider, apiKey: trimmed, timeout: RPC_TIMEOUT });
				const profileId = result && typeof result === 'object' ? result.profileId : undefined;
				this.$emit('added', { provider, profileId });
				this.closeAll();
			}
			catch (err) {
				if (isCanceledError(err)) {
					// 显式取消：默默关闭，不报错
					this.closeAll();
					return;
				}
				this.inlineErrorKey = mapModelConfigErrorKey(
					err,
					'modelConfig.providerAuth.add.submitFailed'
				);
			}
			finally {
				this.submitting = false;
			}
		},
	},
};
</script>
