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
								<span class="min-w-0 flex-1 truncate">{{ p.id }}</span>
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
								<span class="min-w-0 flex-1 truncate">{{ p.id }}</span>
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

				<!-- Step 2: 输 API key（用 form 包裹密码框：消除浏览器“password 不在 form 内”告警；提交 + 原生回车都走 onSubmit）-->
				<form v-else class="flex flex-col gap-3" @submit.prevent="onSubmit">
					<!-- 输入框自带 placeholder，无需额外 label；aria-label 保留可达性。type=password 透传给原生 input -->
					<UInput
						v-model="apiKey"
						data-testid="add-provider-key-input"
						type="password"
						autocomplete="off"
						spellcheck="false"
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
		</template>

		<!-- footer 仅在 Step 2 提供：右下角 取消 + 提交，与项目其它 confirm 弹窗一致 -->
		<template v-if="step === 'configure'" #footer>
			<div class="flex w-full justify-end gap-2">
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

const RPC_TIMEOUT = 60_000;

export default {
	name: 'AddProviderDialog',
	props: {
		open: {
			type: Boolean,
			default: false,
		},
		/**
		 * models.list view:"all" 派生：所有 catalog 内出现过的 provider id 列表（去重前由调用方计算）
		 * 也可直接传整个 catalog 数组，组件自行 dedupe——选后者，让上层更省事
		 *
		 * @type {{ id: string, provider?: string }[]}
		 */
		catalog: {
			type: Array,
			default: () => [],
		},
		/**
		 * 当前已绑 provider id 列表（来自 providerAuth.list）；在 Step 1 中会被排除
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
	},
	emits: ['update:open', 'added'],
	setup() {
		return {
			envStore: useEnvStore(),
		};
	},
	data() {
		return {
			/** 'select' = 选 provider，'configure' = 输 API key */
			step: 'select',
			/** Step 1 搜索关键词 */
			searchText: '',
			/** Step 1 选定的 provider id（进入 Step 2 前 set） */
			selectedProvider: '',
			/** Step 2 API key input（提交成功立即清空，防止内存里残留） */
			apiKey: '',
			/** Step 2 内联错误的 i18n key（'' 表示无错误） */
			inlineErrorKey: '',
			/** 正在调 setApiKey RPC */
			submitting: false,
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
			return this.step === 'configure' ? promptModalUi : undefined;
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
		 * catalog 派生的 provider id 集合，剔除已绑的
		 * 返回 [{ id, displayName, popular }]，按 displayName 字典序排
		 */
		availableProviders() {
			const existing = new Set(Array.isArray(this.existingProviders) ? this.existingProviders : []);
			const seen = new Set();
			const out = [];
			const cat = Array.isArray(this.catalog) ? this.catalog : [];
			for (const m of cat) {
				const id = m && typeof m.provider === 'string' ? m.provider : '';
				if (!id || seen.has(id) || existing.has(id)) continue;
				seen.add(id);
				const meta = getProviderMeta(id);
				out.push({ id, displayName: meta.displayName, popular: !!meta.popular });
			}
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
			this.apiKey = '';
			this.inlineErrorKey = '';
			this.submitting = false;
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
			this.selectedProvider = providerId;
			this.step = 'configure';
			this.apiKey = '';
			this.inlineErrorKey = '';
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
