<template>
	<UModal
		:open="open"
		:title="title"
		description=" "
		:fullscreen="isMobile"
		@update:open="onModalOpenChange"
	>
		<template #body>
			<div data-testid="add-provider-dialog" class="flex min-h-0 flex-col gap-3">
				<!-- Step 1: 选 provider -->
				<div v-if="step === 'select'" class="flex min-h-0 flex-col gap-3">
					<UInput
						v-model="searchText"
						data-testid="add-provider-search"
						icon="i-lucide-search"
						:placeholder="$t('modelConfig.providerAuth.add.searchPlaceholder')"
						size="md"
						class="w-full"
					/>

					<!-- 列表区：限高 + 内部滚动；为空时给提示 -->
					<div data-testid="add-provider-list" class="-mx-2 flex max-h-[60vh] flex-col overflow-y-auto md:max-h-96">
						<template v-if="popularList.length">
							<p class="px-2 pt-1 pb-1 text-xs font-medium text-muted">
								{{ $t('modelConfig.providerAuth.add.groupPopular') }}
							</p>
							<button
								v-for="p in popularList"
								:key="`pop-${p.id}`"
								type="button"
								class="flex h-11 items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-accented/80"
								:data-testid="`add-provider-item-${p.id}`"
								@click="onPickProvider(p.id)"
							>
								<span class="min-w-0 flex-1 truncate font-medium">{{ p.displayName }}</span>
								<span class="shrink-0 text-xs text-muted">{{ p.id }}</span>
							</button>
						</template>

						<template v-if="otherList.length">
							<p class="px-2 pt-3 pb-1 text-xs font-medium text-muted">
								{{ $t('modelConfig.providerAuth.add.groupOther') }}
							</p>
							<button
								v-for="p in otherList"
								:key="`oth-${p.id}`"
								type="button"
								class="flex h-11 items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-accented/80"
								:data-testid="`add-provider-item-${p.id}`"
								@click="onPickProvider(p.id)"
							>
								<span class="min-w-0 flex-1 truncate font-medium">{{ p.displayName }}</span>
								<span class="shrink-0 text-xs text-muted">{{ p.id }}</span>
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

				<!-- Step 2: 输 API key -->
				<div v-else class="flex flex-col gap-3">
					<div class="flex flex-col gap-1">
						<label :for="apiKeyInputId" class="text-sm font-medium">
							{{ $t('modelConfig.providerAuth.add.keyLabel') }}
						</label>
						<!-- type=password：UInput 透传给原生 input -->
						<UInput
							:id="apiKeyInputId"
							v-model="apiKey"
							data-testid="add-provider-key-input"
							type="password"
							autocomplete="off"
							spellcheck="false"
							:placeholder="$t('modelConfig.providerAuth.add.keyPlaceholder')"
							:disabled="submitting"
							@keydown.enter="onSubmit"
						/>
					</div>

					<!-- 错误：仅在 inlineErrorKey 非空时渲染 -->
					<p
						v-if="inlineErrorKey"
						data-testid="add-provider-error"
						class="text-sm text-error"
					>
						{{ $t(inlineErrorKey) }}
					</p>

					<!-- "去官网创建"链接：仅当 PROVIDER_META 含 dashboardUrl 时渲染 -->
					<div v-if="dashboardUrl" class="text-sm text-muted">
						<span class="mr-1">{{ $t('modelConfig.providerAuth.add.noKeyHint', { provider: providerDisplayName }) }}</span>
						<a
							data-testid="add-provider-dashboard-link"
							class="text-primary underline cursor-pointer"
							:aria-label="$t('modelConfig.providerAuth.add.dashboardLink', { provider: providerDisplayName })"
							@click="onOpenDashboard"
						>
							{{ $t('modelConfig.providerAuth.add.dashboardLink', { provider: providerDisplayName }) }}
						</a>
					</div>

					<!-- 提交按钮：无 footer，提交动作内嵌于 Step 2 表单底部（取消走 X / 遮罩 / Esc） -->
					<UButton
						data-testid="add-provider-submit"
						block
						color="primary"
						:loading="submitting"
						:disabled="submitting"
						@click="onSubmit"
					>
						{{ $t('modelConfig.providerAuth.add.submitButton') }}
					</UButton>
				</div>
			</div>
		</template>
	</UModal>
</template>

<script>
import { getProviderMeta, PROVIDER_META } from '../../constants/provider-meta.js';
import { mapModelConfigErrorKey, isCanceledError } from '../../utils/model-config-errors.js';
import { openExternalUrl } from '../../utils/external-url.js';
import { useEnvStore } from '../../stores/env.store.js';

const RPC_TIMEOUT = 60_000;

// 自增 id，给 input 一个独立 id 让 <label for> 可达 a11y
let __uid = 0;

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
		__uid += 1;
		return {
			envStore: useEnvStore(),
			apiKeyInputId: `add-provider-key-${__uid}`,
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
		 * 标题文案：Step 1 是 "选择 provider"，Step 2 是 "配置 <displayName>"
		 */
		title() {
			if (this.step === 'select') {
				return this.$t('modelConfig.providerAuth.add.stepSelectTitle');
			}
			return this.$t('modelConfig.providerAuth.add.stepConfigTitle', {
				provider: this.providerDisplayName,
			});
		},
		providerDisplayName() {
			return getProviderMeta(this.selectedProvider).displayName;
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
