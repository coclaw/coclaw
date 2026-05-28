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
				<!-- 搜索框两端各冒出 2px：外层块级 div 用 -mx-0.5 自动撑出 4px，内层 input w-full 填满（同列表 -mx-2 的做法） -->
				<div class="-mx-0.5">
					<UInput
						v-model="searchText"
						data-testid="primary-picker-search"
						icon="i-lucide-search"
						:placeholder="$t('modelConfig.primary.pickerSearchPlaceholder')"
						size="md"
						class="w-full"
						:disabled="busy"
					/>
				</div>

				<div data-testid="primary-picker-list" class="-mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-hide md:max-h-96 md:flex-none">
					<div
						v-if="!groups.length"
						data-testid="primary-picker-empty"
						class="px-2 py-6 text-center text-sm text-muted"
					>
						{{ $t('modelConfig.primary.pickerEmpty') }}
					</div>

					<template
						v-for="g in groups"
						:key="g.provider"
					>
						<!-- 所有分组标题统一 pt-1：分组名本身已起分隔作用，不再按首组/其余区别加间距 -->
						<!-- 直接显示原生 provider id（与 AddProviderDialog 一致，暂不用映射 displayName；排序仍按 displayName） -->
						<p
							class="px-2 pt-1 pb-1 text-xs font-medium text-muted"
							:data-testid="`primary-picker-group-${g.provider}`"
						>
							{{ g.provider }}
						</p>

						<button
							v-for="m in g.models"
							:key="`${g.provider}/${m.id}`"
							type="button"
							class="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accented/80"
							:class="{
								'bg-accented/60': isCurrent(g.provider, m.id),
								'opacity-60 pointer-events-none': busy && !isCurrent(g.provider, m.id),
							}"
							:data-testid="`primary-picker-item-${g.provider}__${m.id}`"
							:disabled="busy"
							@click="onPickModel(g.provider, m.id)"
						>
							<span class="min-w-0 flex-1 truncate">{{ m.id }}</span>
							<!-- 尾部状态 icon：保存中显示 spinner，否则当前 primary 显示勾。
							     勾移到尾部后头部文本纵向对齐；spinner 只看 pendingTarget 命中本行
							     （与是否 current 无关），优先于勾，避免重选当前模型时两个 icon 叠一起 -->
							<UIcon
								v-if="pendingTarget === `${g.provider}/${m.id}`"
								name="i-lucide-loader-2"
								class="size-4 shrink-0 animate-spin text-muted"
								aria-hidden="true"
							/>
							<UIcon
								v-else-if="isCurrent(g.provider, m.id)"
								name="i-lucide-check"
								class="size-4 shrink-0 text-primary"
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
		 * 别名感知"可用 provider→模型"枚举（coclaw.model.listUsable 的 byProvider）：
		 * provider id（含别名套餐变体 id，如 `volcengine-plan`）→ 可用 modelId 列表。
		 * 非回退态（fallback=false）下作为唯一数据源直接出可选项，无幽灵、含变体。
		 *
		 * @type {Record<string, string[]>}
		 */
		usable: {
			type: Object,
			default: () => ({}),
		},
		/**
		 * 是否走旧插件回退：true 时用 `providers ∩ catalog` 派生（旧插件无 listUsable / 拉取失败时），
		 * false 时吃 `usable` 的 byProvider。由父组件按 listUsable 是否成功决定。
		 *
		 * @type {boolean}
		 */
		fallback: {
			type: Boolean,
			default: false,
		},
		/**
		 * 已绑 provider id 列表（providerAuth.list 派生）；仅回退态与 catalog 取交集
		 *
		 * @type {string[]}
		 */
		providers: {
			type: Array,
			default: () => [],
		},
		/**
		 * models.list view:"all" 派生：[{ id, provider }, ...]；仅回退态用
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
		 * 按 provider 分组：
		 *   - 非回退态：吃 listUsable 的 byProvider（含别名变体，已是干净目录∩别名感知凭据，无幽灵）
		 *   - 回退态（旧插件/拉取失败）：用 `providers ∩ catalog` 派生
		 * 每个 group 内按 model id 字典序；搜索词过滤 model id（命中 provider 名也算）；group 间按 displayName 排序。
		 *
		 * @returns {{ provider: string, displayName: string, models: { id: string }[] }[]}
		 */
		groups() {
			const q = this.searchText.trim().toLowerCase();
			const hit = (id, provider) => !q || id.toLowerCase().includes(q) || provider.toLowerCase().includes(q);
			/** @type {Map<string, { id: string }[]>} */
			const byProvider = new Map();
			if (this.fallback) {
				// 旧插件回退：providers（providerAuth.list 三源原始名）∩ catalog（view:'all'）
				const allowed = new Set(Array.isArray(this.providers) ? this.providers : []);
				const cat = Array.isArray(this.catalog) ? this.catalog : [];
				for (const m of cat) {
					if (!m || typeof m.provider !== 'string' || typeof m.id !== 'string') continue;
					if (!allowed.has(m.provider)) continue;
					if (!hit(m.id, m.provider)) continue;
					const arr = byProvider.get(m.provider) ?? [];
					arr.push({ id: m.id });
					byProvider.set(m.provider, arr);
				}
			}
			else {
				// 主路径：直接吃 listUsable 的 byProvider（provider→modelId[]）
				const src = (this.usable && typeof this.usable === 'object') ? this.usable : {};
				for (const provider of Object.keys(src)) {
					if (typeof provider !== 'string' || !provider) continue;
					const ids = Array.isArray(src[provider]) ? src[provider] : [];
					for (const id of ids) {
						if (typeof id !== 'string' || !id) continue;
						if (!hit(id, provider)) continue;
						const arr = byProvider.get(provider) ?? [];
						arr.push({ id });
						byProvider.set(provider, arr);
					}
				}
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
