<template>
	<UModal
		:open="open"
		:title="$t('modelConfig.primary.pickerTitle')"
		description=" "
		:fullscreen="isMobile"
		@update:open="onModalOpenChange"
	>
		<template #body>
			<div data-testid="primary-picker-dialog" class="flex h-full min-h-0 flex-col gap-3 md:h-auto">
				<UInput
					v-model="searchText"
					data-testid="primary-picker-search"
					icon="i-lucide-search"
					:placeholder="$t('modelConfig.primary.pickerSearchPlaceholder')"
					size="md"
					class="w-full"
					:disabled="busy"
				/>

				<div data-testid="primary-picker-list" class="-mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-hide md:max-h-96 md:flex-none">
					<div
						v-if="!groups.length"
						data-testid="primary-picker-empty"
						class="px-2 py-6 text-center text-sm text-muted"
					>
						{{ $t('modelConfig.primary.pickerEmpty') }}
					</div>

					<template
						v-for="(g, gi) in groups"
						:key="g.provider"
					>
						<!-- 首个分组标题贴近搜索框（pt-1），其余分组之间留 pt-3 分隔；与 AddProviderDialog 一致 -->
						<p
							class="px-2 pb-1 text-xs font-medium text-muted"
							:class="gi === 0 ? 'pt-1' : 'pt-3'"
							:data-testid="`primary-picker-group-${g.provider}`"
						>
							{{ g.displayName }}
						</p>

						<button
							v-for="m in g.models"
							:key="`${g.provider}/${m.id}`"
							type="button"
							class="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accented/80"
							:class="{
								'bg-accented/60': isCurrent(g.provider, m.id),
								'opacity-60 pointer-events-none': busy && !isCurrent(g.provider, m.id),
							}"
							:data-testid="`primary-picker-item-${g.provider}__${m.id}`"
							:disabled="busy"
							@click="onPickModel(g.provider, m.id)"
						>
							<UIcon
								v-if="isCurrent(g.provider, m.id)"
								name="i-lucide-check"
								class="size-4 shrink-0 text-primary"
								aria-hidden="true"
							/>
							<span v-else aria-hidden="true" class="size-4 shrink-0" />
							<span class="min-w-0 flex-1 truncate">{{ m.id }}</span>
							<!-- 保存中的 spinner：只看 pendingTarget 是否命中本行，与"是否当前 primary"无关——
							     否则换到一个非当前模型时点击的那行永远不显示 loading -->
							<UIcon
								v-if="pendingTarget === `${g.provider}/${m.id}`"
								name="i-lucide-loader-2"
								class="size-4 shrink-0 animate-spin text-muted"
								aria-hidden="true"
							/>
						</button>
					</template>
				</div>
			</div>
		</template>
	</UModal>
</template>

<script>
import { getProviderMeta } from '../../constants/provider-meta.js';
import { mapModelConfigErrorKey, isCanceledError } from '../../utils/model-config-errors.js';
import { useEnvStore } from '../../stores/env.store.js';
import { useNotify } from '../../composables/use-notify.js';

const RPC_TIMEOUT = 60_000;

export default {
	name: 'PrimaryModelPickerDialog',
	props: {
		open: {
			type: Boolean,
			default: false,
		},
		/**
		 * 已绑 provider id 列表（providerAuth.list 派生）；与 catalog 取交集
		 *
		 * @type {string[]}
		 */
		providers: {
			type: Array,
			default: () => [],
		},
		/**
		 * models.list view:"all" 派生：[{ id, provider }, ...]
		 *
		 * @type {{ id: string, provider?: string }[]}
		 */
		catalog: {
			type: Array,
			default: () => [],
		},
		/**
		 * 当前 primary 字符串（'provider/model'），可为 null
		 *
		 * @type {string|null}
		 */
		current: {
			type: String,
			default: null,
		},
		/**
		 * 触发 model.set 的回调：父组件提供。`{ primary }` 入参，promise 返回。
		 * 与 AddProviderDialog 同模式（注入 fn 而非 conn，方便测试 + 父组件加守卫）
		 *
		 * @type {(args: { primary: string }) => Promise<unknown>}
		 */
		setPrimary: {
			type: Function,
			default: null,
		},
	},
	emits: ['update:open', 'picked'],
	setup() {
		return {
			envStore: useEnvStore(),
			notify: useNotify(),
		};
	},
	data() {
		return {
			searchText: '',
			/** 正在 set 的 'provider/model' 字串（loading 行高亮） */
			pendingTarget: '',
		};
	},
	computed: {
		isMobile() {
			return this.envStore?.screen?.ltMd === true;
		},
		busy() {
			return !!this.pendingTarget;
		},
		/**
		 * 当前主模型的 provider/model 拆分，纯计算
		 * @returns {{ provider: string, model: string }|null}
		 */
		currentParsed() {
			if (!this.current || typeof this.current !== 'string') return null;
			const idx = this.current.indexOf('/');
			if (idx <= 0 || idx === this.current.length - 1) return null;
			return {
				provider: this.current.slice(0, idx),
				model: this.current.slice(idx + 1),
			};
		},
		/**
		 * 按 provider 分组：仅保留 providers 集合内的 provider；
		 * 每个 group 内按 model id 字典序；用搜索词过滤 model.id（命中含 provider 名也算）
		 *
		 * @returns {{ provider: string, displayName: string, models: { id: string }[] }[]}
		 */
		groups() {
			const allowed = new Set(Array.isArray(this.providers) ? this.providers : []);
			const cat = Array.isArray(this.catalog) ? this.catalog : [];
			const q = this.searchText.trim().toLowerCase();
			/** @type {Map<string, { id: string }[]>} */
			const byProvider = new Map();
			for (const m of cat) {
				if (!m || typeof m.provider !== 'string' || typeof m.id !== 'string') continue;
				if (!allowed.has(m.provider)) continue;
				if (q && !m.id.toLowerCase().includes(q) && !m.provider.toLowerCase().includes(q)) continue;
				const arr = byProvider.get(m.provider) ?? [];
				arr.push({ id: m.id });
				byProvider.set(m.provider, arr);
			}
			const out = [];
			for (const [provider, models] of byProvider.entries()) {
				const meta = getProviderMeta(provider);
				const sorted = models.slice().sort((a, b) => a.id.localeCompare(b.id));
				out.push({ provider, displayName: meta.displayName, models: sorted });
			}
			out.sort((a, b) => a.displayName.localeCompare(b.displayName));
			return out;
		},
	},
	watch: {
		open(val) {
			if (val) {
				// 重置搜索 + busy（保留 current 由 prop 自然驱动）
				this.searchText = '';
				this.pendingTarget = '';
			}
		},
	},
	methods: {
		/**
		 * 该行是否是当前 primary
		 *
		 * @param {string} provider
		 * @param {string} model
		 * @returns {boolean}
		 */
		isCurrent(provider, model) {
			const c = this.currentParsed;
			return !!c && c.provider === provider && c.model === model;
		},
		closeAll() {
			this.$emit('update:open', false);
		},
		onModalOpenChange(value) {
			if (!value) {
				if (this.busy) return;
				this.closeAll();
			}
		},
		async onPickModel(provider, model) {
			if (this.busy) return;
			if (!provider || !model) return;
			if (!this.setPrimary) {
				// 父组件没注入 RPC——给一个 notify，不静默
				this.notify.error(this.$t('modelConfig.common.connError'));
				return;
			}
			const primary = `${provider}/${model}`;
			this.pendingTarget = primary;
			try {
				await this.setPrimary({ primary, timeout: RPC_TIMEOUT });
				this.$emit('picked', { primary });
				this.closeAll();
			}
			catch (err) {
				if (isCanceledError(err)) {
					// 显式取消：关闭，不 notify
					this.closeAll();
					return;
				}
				const key = mapModelConfigErrorKey(err, 'modelConfig.common.saveFailed');
				this.notify.error(this.$t(key));
				// 失败：保持对话框打开（per design § 5.3 "失败 → notify、表单不关闭" 同精神）
			}
			finally {
				this.pendingTarget = '';
			}
		},
	},
};
</script>
