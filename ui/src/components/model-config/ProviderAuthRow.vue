<template>
	<div class="flex min-h-12 items-center gap-3 px-3 py-2 border-b border-default last:border-b-0">
		<!-- 品牌名 + 凭据预览 -->
		<div class="min-w-0 flex-1">
			<p class="truncate text-sm font-medium">{{ displayName }}</p>
			<p v-if="secondary" class="truncate text-xs text-muted">{{ secondary }}</p>
		</div>

		<!-- 撤销按钮：api_key / token 可撤；oauth 默认只读，仅 CoClaw 管理的扫码服务商例外 -->
		<UButton
			v-if="removable"
			data-testid="btn-remove-provider"
			variant="soft"
			color="error"
			:disabled="disabled"
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
		/** plugin coclaw.providerAuth.list 返回的单条 profile */
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
		 * 次行内容：api_key 显示 keyPreview，oauth/token 优先 email、回退 displayName。
		 * 都没有就不显示次行，避免空字符串占位。
		 */
		secondary() {
			const p = this.profile ?? {};
			if (p.type === 'api_key') return p.keyPreview ?? '';
			return p.email || p.displayName || '';
		},
		removable() {
			// api_key / token / 未知类型一律可撤；oauth 默认只读，仅 CoClaw 管理的扫码服务商例外
			const p = this.profile ?? {};
			if (p.type !== 'oauth') return true;
			return COCLAW_OAUTH_PROVIDERS.has(p.provider);
		},
	},
	methods: {
		onRemove() {
			this.$emit('remove', this.profile?.provider ?? '');
		},
	},
};
</script>
