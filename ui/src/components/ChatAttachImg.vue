<template>
	<div v-if="loading" class="flex h-24 w-32 items-center justify-center rounded-lg bg-elevated">
		<UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-dimmed" />
	</div>
	<div v-else-if="error" class="flex h-24 w-32 items-center justify-center rounded-lg bg-elevated">
		<UIcon name="i-lucide-image-off" class="size-6 text-dimmed" />
	</div>
	<ChatImg
		v-else-if="resolvedSrc"
		:src="resolvedSrc"
		:filename="filename"
		:custom-class="customClass"
	/>
</template>

<script>
import ChatImg from './ChatImg.vue';
import { isCoclawUrl, fetchCoclawFile } from '../services/coclaw-file.js';

export default {
	name: 'ChatAttachImg',
	components: { ChatImg },
	props: {
		/**
		 * 图片来源：
		 * - blob URL / data URI → 直接显示
		 * - coclaw-file://botId:agentId/path → 自动下载后显示
		 */
		src: {
			type: String,
			default: null,
		},
		filename: {
			type: String,
			default: 'image',
		},
		customClass: {
			type: String,
			default: '',
		},
	},
	data() {
		return {
			resolvedSrc: null,
			loading: false,
			error: false,
		};
	},
	watch: {
		src: {
			immediate: true,
			handler() {
				this.__resolve();
			},
		},
	},
	beforeUnmount() {
		this.__revokeResolved();
	},
	methods: {
		async __resolve() {
			this.__revokeResolved();
			this.error = false;

			if (!this.src) {
				this.resolvedSrc = null;
				return;
			}

			if (!isCoclawUrl(this.src)) {
				this.resolvedSrc = this.src;
				return;
			}

			// coclaw-file URL: 下载后显示
			const srcAtStart = this.src;
			this.loading = true;
			try {
				const blob = await fetchCoclawFile(srcAtStart);
				if (this.src !== srcAtStart) return; // src 已变更
				this.resolvedSrc = URL.createObjectURL(blob);
			} catch (err) {
				console.warn('[ChatAttachImg] fetch failed:', err);
				if (this.src === srcAtStart) this.error = true;
			} finally {
				this.loading = false;
			}
		},

		__revokeResolved() {
			if (this.resolvedSrc && this.resolvedSrc.startsWith('blob:')) {
				URL.revokeObjectURL(this.resolvedSrc);
			}
			this.resolvedSrc = null;
		},
	},
};
</script>
