<template>
	<div
		class="flex min-h-12 items-center gap-3 px-3 py-2 border-b border-default last:border-b-0"
		:class="{ 'opacity-75': source === 'env' }"
	>
		<!-- provider id + oauth 徽章 + 来源小标签 + 凭据预览。
		     徽章字号提到 sm 后整体高度≈文本，items-end 底边对齐已失效；改 items-center
		     + 文本 -mt-0.5 上浮，做纵向视觉居中。 -->
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-1.5">
				<p class="truncate text-sm font-medium -mt-0.5">{{ providerLabel }}</p>
				<!-- oauth 类型徽章：字面量 oauth 不进 i18n（与 provider id 同属技术标识，不翻译） -->
				<UBadge
					v-if="isOauth"
					data-testid="provider-oauth-tag"
					color="neutral"
					variant="subtle"
					size="sm"
					class="shrink-0"
				>
					oauth
				</UBadge>
				<UBadge
					v-if="showSourceTag"
					data-testid="provider-source-tag"
					color="neutral"
					variant="subtle"
					size="sm"
					class="shrink-0"
				>
					{{ sourceLabel }}
				</UBadge>
			</div>
			<p v-if="secondary" class="truncate text-xs text-muted">{{ secondary }}</p>
		</div>

		<!-- 撤销按钮：所有凭据行都渲染（有凭据即可撤销，含 oauth——本地删可经 CoClaw 重登回来）；
		     env 来源不可撤销（在 OpenClaw 主机环境里）→ 渲染但禁用 + 次行提示去哪移除。 -->
		<UButton
			data-testid="btn-remove-provider"
			variant="soft"
			color="error"
			:disabled="removeDisabled"
			@click="onRemove"
		>
			{{ $t('modelConfig.providerAuth.removeButton') }}
		</UButton>
	</div>
</template>

<script>
export default {
	name: 'ProviderAuthRow',
	props: {
		/** plugin coclaw.providerAuth.list 返回的单条 profile（含 source / removable，§2.4） */
		profile: {
			type: Object,
			required: true,
		},
		/** 是否禁用动作（外部 claw 离线 / 通道未就绪 / 撤销中等情况） */
		disabled: {
			type: Boolean,
			default: false,
		},
	},
	emits: ['remove'],
	computed: {
		/**
		 * 直接展示 OpenClaw 原生 provider id：管理界面与选择器统一显示原生 id，
		 * 不用 provider-meta 的映射品牌名（见 constants/provider-meta.js 顶部说明）。
		 */
		providerLabel() {
			return this.profile?.provider ?? '';
		},
		/**
		 * 凭据来源：profile（账本）/ inline（配置文件）/ env（环境变量）。
		 * 旧插件出参无 source 字段 → 退化为 'profile'（等价旧行为）。
		 */
		source() {
			const s = this.profile?.source;
			return (s === 'inline' || s === 'env') ? s : 'profile';
		},
		/**
		 * 是否显示来源小标签：仅内联 / 环境变量来源打标签；
		 * 账本 profile 是默认存储（多数新用户只有这一种），不打标签——降低视觉负担。
		 */
		showSourceTag() {
			return this.source === 'inline' || this.source === 'env';
		},
		/** 是否为 oauth 凭据（决定是否渲染 oauth 徽章） */
		isOauth() {
			return this.profile?.type === 'oauth';
		},
		sourceLabel() {
			return this.$t(`modelConfig.providerAuth.source.${this.source}`);
		},
		/**
		 * 次行内容：env 来源显示"去主机移除"提示；api_key 显示 keyPreview；
		 * oauth/token 优先 email、回退 displayName。都没有就不显示次行，避免空字符串占位。
		 */
		secondary() {
			const p = this.profile ?? {};
			if (this.source === 'env') return this.$t('modelConfig.providerAuth.envReadonlyHint');
			if (p.type === 'api_key') return p.keyPreview ?? '';
			return p.email || p.displayName || '';
		},
		/**
		 * 后端是否允许撤销（§2.4 removable）。env 来源恒 false；
		 * 旧插件缺省字段 → 视为 true（退化，至多漏 env/inline 来源、不回归）。
		 */
		backendRemovable() {
			return this.profile?.removable !== false;
		},
		/** 真正可撤 = 后端允许撤销（纯看 removable，不再有 UI 侧 oauth 白名单门） */
		canRemove() {
			return this.backendRemovable;
		},
		removeDisabled() {
			return this.disabled || !this.backendRemovable;
		},
	},
	methods: {
		onRemove() {
			if (!this.canRemove) return;
			this.$emit('remove', { provider: this.profile?.provider ?? '', source: this.source });
		},
	},
};
</script>
