<template>
	<!-- 加载中 -->
	<div v-if="loading" class="flex h-24 w-32 items-center justify-center rounded-lg bg-elevated">
		<UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-dimmed" />
	</div>
	<!-- 加载失败 -->
	<div v-else-if="error" class="flex h-24 w-32 items-center justify-center rounded-lg bg-elevated">
		<UIcon name="i-lucide-image-off" class="size-6 text-dimmed" />
	</div>
	<!-- 图片 -->
	<template v-else-if="resolvedSrc">
		<img
			:src="resolvedSrc"
			alt=""
			class="rounded-lg"
			:class="[customClass, { 'cursor-pointer': imgLoaded }]"
			@load="imgLoaded = true"
			@click="viewImg"
		/>
		<ImgViewDialog
			v-model:open="dialogOpen"
			:src="resolvedSrc"
			:filename="filename"
		/>
	</template>
</template>

<script>
import ImgViewDialog from './ImgViewDialog.vue';
import { pushDialogState } from '../utils/dialog-history.js';
import { isCoclawUrl, fetchCoclawFile } from '../services/coclaw-file.js';

export default {
	name: 'ChatImg',
	components: { ImgViewDialog },
	props: {
		/**
		 * 图片来源：
		 * - data URI / blob URL → 直接显示
		 * - coclaw-file://botId:agentId/path → 自动下载后显示
		 */
		src: {
			type: String,
			required: true,
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
			imgLoaded: false,
			dialogOpen: false,
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
		this.__unmounted = true;
		this.__revokeResolved();
	},
	methods: {
		async __resolve() {
			this.__revokeResolved();
			this.error = false;
			this.imgLoaded = false;

			if (!this.src) {
				this.resolvedSrc = null;
				return;
			}

			if (!isCoclawUrl(this.src)) {
				this.resolvedSrc = this.src;
				return;
			}

			// coclaw-file URL → 下载后显示
			const srcAtStart = this.src;
			this.loading = true;
			try {
				const blob = await fetchCoclawFile(srcAtStart);
				if (this.src !== srcAtStart || this.__unmounted) return;
				this.resolvedSrc = URL.createObjectURL(blob);
			} catch (err) {
				console.warn('[ChatImg] fetch failed:', err);
				if (this.src === srcAtStart && !this.__unmounted) this.error = true;
			} finally {
				this.loading = false;
			}
		},

		__revokeResolved() {
			// 仅 revoke 自己创建的 blob URL，不 revoke 外部传入的 src
			if (this.resolvedSrc && this.resolvedSrc.startsWith('blob:') && this.resolvedSrc !== this.src) {
				URL.revokeObjectURL(this.resolvedSrc);
			}
			this.resolvedSrc = null;
		},

		viewImg() {
			if (!this.imgLoaded) return;
			pushDialogState(() => {
				this.dialogOpen = false;
			});
			this.dialogOpen = true;
		},
	},
};
</script>
