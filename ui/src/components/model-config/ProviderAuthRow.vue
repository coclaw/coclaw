<template>
	<div
		class="flex min-h-12 items-center gap-3 px-3 py-2 border-b border-default last:border-b-0"
		:class="{ 'opacity-75': source === 'env' }"
	>
		<!-- 品牌名 + 来源小标签 + 凭据预览 -->
		<div class="min-w-0 flex-1">
			<div class="flex items-end gap-1.5">
				<p class="truncate text-sm font-medium">{{ displayName }}</p>
				<UBadge
					v-if="showSourceTag"
					data-testid="provider-source-tag"
					color="neutral"
					variant="subtle"
					size="xs"
					class="shrink-0"
				>
					{{ sourceLabel }}
				</UBadge>
			</div>
			<p v-if="secondary" class="truncate text-xs text-muted">{{ secondary }}</p>
		</div>

		<!-- 撤销按钮：
		     - oauth 默认只读（无 affordance）→ 不渲染，仅 CoClaw 管理的扫码服务商例外
		     - env 来源不可撤销（在 OpenClaw 主机环境里）→ 渲染但禁用 + 次行提示去哪移除
		     - 账本 / 内联 → 可撤 -->
		<UButton
			v-if="showRemoveButton"
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
import { getProviderMeta, COCLAW_OAUTH_PROVIDERS } from '../../constants/provider-meta.js';

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
		displayName() {
			return getProviderMeta(this.profile?.provider ?? '').displayName;
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
		/**
		 * UI 侧 oauth 策略：oauth 默认只读，仅 CoClaw 管理的扫码服务商可撤
		 * （撤后能在 CoClaw 内重登回来，构成往返闭环；否则成单向陷阱）。
		 */
		oauthAllowed() {
			const p = this.profile ?? {};
			if (p.type !== 'oauth') return true;
			return COCLAW_OAUTH_PROVIDERS.has(p.provider);
		},
		/** 真正可撤 = 后端允许 且 通过 UI oauth 策略 */
		canRemove() {
			return this.backendRemovable && this.oauthAllowed;
		},
		/** 只读 oauth 不渲染按钮（无 affordance）；env 渲染但禁用 */
		showRemoveButton() {
			return this.oauthAllowed;
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
