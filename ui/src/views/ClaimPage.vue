<template>
	<div class="flex min-h-0 flex-1 flex-col">
		<MobilePageHeader :title="$t('claim.title')" />
		<main class="flex flex-1 items-center justify-center px-4">
			<section class="w-full max-w-sm text-center">
				<!-- 加载中 -->
				<div v-if="loading" class="flex flex-col items-center gap-3">
					<UIcon name="i-heroicons-arrow-path" class="size-8 animate-spin text-muted" />
					<p class="text-sm text-muted">{{ $t('claim.claiming') }}</p>
				</div>

				<!-- 成功 -->
				<div v-else-if="success" class="flex flex-col items-center gap-3">
					<UIcon name="i-heroicons-check-circle" class="size-12 text-success" />
					<p class="text-sm">{{ $t('claim.success') }}</p>
				</div>

				<!-- 失败 -->
				<div v-else-if="errorCode" class="flex flex-col items-center gap-3">
					<UIcon name="i-heroicons-x-circle" class="size-12 text-error" />
					<p class="text-sm text-error">{{ errorMessage }}</p>
					<p class="text-xs text-muted">{{ $t('claim.retryHint') }}</p>
				</div>

				<!-- 无认领码 -->
				<div v-else class="flex flex-col items-center gap-3">
					<UIcon name="i-heroicons-exclamation-triangle" class="size-12 text-warning" />
					<p class="text-sm text-muted">{{ $t('claim.noCode') }}</p>
				</div>
			</section>
		</main>
	</div>
</template>

<script>
import MobilePageHeader from '../components/MobilePageHeader.vue';
import { claimClaw } from '../services/claws.api.js';

export default {
	name: 'ClaimPage',
	components: {
		MobilePageHeader,
	},
	data() {
		return {
			loading: false,
			success: false,
			errorCode: '',
			__navTimer: null,
		};
	},
	beforeUnmount() {
		if (this.__navTimer) {
			clearTimeout(this.__navTimer);
		}
	},
	computed: {
		errorMessage() {
			if (this.errorCode === 'CLAIM_CODE_INVALID') {
				return this.$t('claim.invalid');
			}
			if (this.errorCode === 'CLAIM_CODE_EXPIRED') {
				return this.$t('claim.expired');
			}
			return this.$t('claim.failed');
		},
	},
	async mounted() {
		const code = this.$route.query.code;
		if (!code) {
			return;
		}
		await this.doClaim(code);
	},
	methods: {
		async doClaim(code) {
			this.loading = true;
			this.errorCode = '';
			try {
				await claimClaw(code);
				this.success = true;
				this.__navTimer = setTimeout(() => {
					this.$router.replace('/claws');
				}, 1500);
			} catch (err) {
				this.errorCode = err?.response?.data?.code || 'UNKNOWN';
				console.warn('[ClaimPage] claimClaw failed:', err);
			} finally {
				this.loading = false;
			}
		},
	},
};
</script>
