<template>
	<UModal
		:open="open"
		:title="$t('modelConfig.providerAuth.remove.title', { provider: providerLabel })"
		description=" "
		:ui="promptUi"
		@update:open="onOpenChange"
	>
		<template #body>
			<p data-testid="remove-provider-desc" class="text-sm text-muted">{{ description }}</p>
		</template>
		<template #footer>
			<div class="flex w-full justify-end gap-2">
				<UButton
					data-testid="btn-remove-cancel"
					variant="ghost"
					color="neutral"
					:disabled="busy"
					@click="onCancel"
				>
					{{ $t('common.cancel') }}
				</UButton>
				<UButton
					data-testid="btn-remove-confirm"
					color="error"
					:loading="busy"
					@click="onConfirm"
				>
					{{ confirmLabel }}
				</UButton>
			</div>
		</template>
	</UModal>
</template>

<script>
import { promptModalUi } from '../../constants/prompt-modal-ui.js';
import { getProviderName } from '../../constants/provider-meta.js';

export default {
	name: 'RemoveProviderConfirmDialog',
	props: {
		open: {
			type: Boolean,
			default: false,
		},
		/** 待撤的 provider id（唯一真值；展示时经 getProviderName 换成品牌名） */
		provider: {
			type: String,
			default: '',
		},
		/** 当前默认主模型字符串（如 'groq/llama-3.3-70b-versatile'）；强提示分支渲染用 */
		currentPrimary: {
			type: String,
			default: '',
		},
		/** 该 provider 是否是当前主模型的载体——决定强提示分支 */
		isPrimaryCarrier: {
			type: Boolean,
			default: false,
		},
		/** RPC 在飞，禁用按钮防双击 */
		busy: {
			type: Boolean,
			default: false,
		},
	},
	emits: ['update:open', 'confirm', 'cancel'],
	setup() {
		return { promptUi: promptModalUi };
	},
	computed: {
		/** 展示友好品牌名（getProviderName）；provider prop 仍是裸 id（撤销 RPC 用裸 id，由父组件持有） */
		providerLabel() {
			return getProviderName(this.provider);
		},
		description() {
			// 撤内联不再单独提示"会改配置文件"：来源已由列表行标签表达，弹窗与普通删除一致（2026-05-28 拍板）。
			// 主模型载体的强提示仍保留（安全闸）。
			return this.isPrimaryCarrier
				? this.$t('modelConfig.providerAuth.remove.descAffectPrimary', {
					primary: this.currentPrimary,
					provider: this.providerLabel,
				})
				: this.$t('modelConfig.providerAuth.remove.descNormal', { provider: this.providerLabel });
		},
		confirmLabel() {
			return this.isPrimaryCarrier
				? this.$t('modelConfig.providerAuth.remove.confirmButtonStrong')
				: this.$t('modelConfig.providerAuth.remove.confirmButton');
		},
	},
	methods: {
		onCancel() {
			if (this.busy) return; // RPC 在飞时按 cancel 也忽略，避免对话框消失而后台仍跑
			this.$emit('update:open', false);
			this.$emit('cancel');
		},
		onConfirm() {
			this.$emit('confirm');
		},
		onOpenChange(value) {
			// UModal 自身 close（点遮罩 / Esc）等价于 cancel——busy 中同样忽略
			if (!value) {
				if (this.busy) return;
				this.$emit('update:open', false);
				this.$emit('cancel');
			}
		},
	},
};
</script>
