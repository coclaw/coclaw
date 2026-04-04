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
	<div v-else-if="resolvedSrc" class="relative w-fit">
		<img
			:src="resolvedSrc"
			alt=""
			class="rounded-lg"
			:class="[customClass, { 'cursor-pointer': imgLoaded }]"
			@load="imgLoaded = true"
			@click="viewImg"
		/>
		<!-- 全图加载中遮罩 -->
		<div
			v-if="fullLoading"
			class="absolute inset-0 flex items-center justify-center rounded-lg bg-black/30"
		>
			<UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-white" />
		</div>
		<ImgViewDialog
			v-if="fullSrc || dialogOpen"
			v-model:open="dialogOpen"
			:src="fullSrc"
			:filename="filename"
			@after:leave="__onDialogLeave"
		/>
	</div>
</template>

<script>
import ImgViewDialog from './ImgViewDialog.vue';
import { pushDialogState, popDialogState } from '../utils/dialog-history.js';
import { isCoclawUrl, fetchCoclawFile } from '../services/coclaw-file.js';
import { compressImage } from '../utils/image-helper.js';

/** 缩略图最大边长 */
const THUMB_MAX = 384;
/** 原图 Blob 缓存时长（ms） */
const FULL_BLOB_TTL = 300_000;

export default {
	name: 'ChatImg',
	components: { ImgViewDialog },
	props: {
		/**
		 * 图片来源：
		 * - data URI / blob URL → 获取 Blob 后压缩为缩略图显示
		 * - coclaw-file://botId:agentId/path → 下载后压缩为缩略图显示
		 * - https:// 等 → 直接显示（不压缩）
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
			fullLoading: false,
			fullSrc: null,
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
		if (this.dialogOpen) {
			popDialogState();
			this.dialogOpen = false;
		}
		this.__cleanup();
	},
	methods: {
		async __resolve() {
			this.__cleanup();
			this.error = false;
			this.imgLoaded = false;

			if (!this.src) {
				this.resolvedSrc = null;
				return;
			}

			const isData = this.src.startsWith('data:');
			const isBlob = this.src.startsWith('blob:');
			const isCoclaw = isCoclawUrl(this.src);

			// 非可处理的 URL（如 https://）直接显示
			if (!isData && !isBlob && !isCoclaw) {
				this.resolvedSrc = this.src;
				return;
			}

			const srcAtStart = this.src;
			this.loading = true;
			try {
				// 1. 获取 Blob
				let blob;
				if (isCoclaw) {
					blob = await fetchCoclawFile(srcAtStart);
				} else {
					const resp = await fetch(srcAtStart);
					blob = await resp.blob();
				}
				if (this.src !== srcAtStart || this.__unmounted) return;

				// 2. 压缩
				const result = await compressImage(blob, { maxWidth: THUMB_MAX, maxHeight: THUMB_MAX });
				if (this.src !== srcAtStart || this.__unmounted) return;

				if (result.skipped || result.blob === blob) {
					// 小图或不可压缩类型 → 直接显示
					if (isData || isBlob) {
						this.resolvedSrc = this.src;
					} else {
						// coclaw-file：用下载到的 blob 创建 URL
						this.resolvedSrc = URL.createObjectURL(blob);
					}
					this.__isThumb = false;
				} else {
					// 压缩成功 → 显示缩略图
					this.resolvedSrc = URL.createObjectURL(result.blob);
					this.__isThumb = true;
					// data URI 不缓存原图 Blob（this.src 本身是完整数据，避免双份内存）
					if (!isData) {
						this.__fullBlob = blob;
						this.__startFullBlobTimer();
					}
				}
			} catch (err) {
				console.warn('[ChatImg] resolve failed:', err);
				if (this.src !== srcAtStart || this.__unmounted) return;
				// data URI / blob URL 可回退为直接显示
				if (isData || isBlob) {
					this.resolvedSrc = this.src;
				} else {
					this.error = true;
				}
			} finally {
				if (this.src === srcAtStart) this.loading = false;
			}
		},

		async viewImg() {
			if (!this.imgLoaded || this.fullLoading || this.dialogOpen) return;

			// 未压缩：resolvedSrc 就是完整图
			if (!this.__isThumb) {
				this.__setFullSrcAndOpen(this.resolvedSrc);
				return;
			}

			// 有缓存的原图 Blob
			if (this.__fullBlob) {
				this.__clearFullBlobTimer();
				this.__revokeFullSrc();
				this.fullSrc = URL.createObjectURL(this.__fullBlob);
				this.__openDialog();
				return;
			}

			// data URI：this.src 本身就是全图
			if (this.src.startsWith('data:')) {
				this.__setFullSrcAndOpen(this.src);
				return;
			}

			// 需要重新获取（coclaw-file / blob URL）
			const srcAtStart = this.src;
			this.fullLoading = true;
			try {
				let blob;
				if (isCoclawUrl(this.src)) {
					blob = await fetchCoclawFile(this.src);
				} else {
					const resp = await fetch(this.src);
					blob = await resp.blob();
				}
				if (this.__unmounted || this.src !== srcAtStart) return;
				this.__fullBlob = blob;
				this.__revokeFullSrc();
				this.fullSrc = URL.createObjectURL(blob);
				this.__openDialog();
			} catch (err) {
				console.warn('[ChatImg] full image fetch failed:', err);
				if (this.__unmounted || this.src !== srcAtStart) return;
				// 回退：用缩略图打开预览
				this.__setFullSrcAndOpen(this.resolvedSrc);
			} finally {
				if (this.src === srcAtStart) this.fullLoading = false;
			}
		},

		/** 设置 fullSrc 并打开 dialog（fullSrc 是外部 URL，关闭时无需 revoke） */
		__setFullSrcAndOpen(url) {
			this.__revokeFullSrc();
			this.fullSrc = url;
			this.__openDialog();
		},

		__openDialog() {
			pushDialogState(() => { this.dialogOpen = false; });
			this.dialogOpen = true;
		},

		/** ImgViewDialog @after:leave 回调 */
		__onDialogLeave() {
			this.__revokeFullSrc();
			// 重启缓存计时器
			if (this.__fullBlob) {
				this.__startFullBlobTimer();
			}
		},

		// ── 原图 Blob 缓存管理 ──

		__startFullBlobTimer() {
			this.__clearFullBlobTimer();
			this.__fullBlobTimer = setTimeout(() => {
				this.__fullBlobTimer = null;
				this.__fullBlob = null;
			}, FULL_BLOB_TTL);
		},

		__clearFullBlobTimer() {
			if (this.__fullBlobTimer) {
				clearTimeout(this.__fullBlobTimer);
				this.__fullBlobTimer = null;
			}
		},

		// ── blob URL 生命周期 ──

		__revokeFullSrc() {
			if (this.fullSrc
				&& this.fullSrc.startsWith('blob:')
				&& this.fullSrc !== this.resolvedSrc
				&& this.fullSrc !== this.src) {
				URL.revokeObjectURL(this.fullSrc);
			}
			this.fullSrc = null;
		},

		__revokeResolved() {
			if (this.resolvedSrc
				&& this.resolvedSrc.startsWith('blob:')
				&& this.resolvedSrc !== this.src) {
				URL.revokeObjectURL(this.resolvedSrc);
			}
			this.resolvedSrc = null;
		},

		/** 统一清理：timer、缓存、blob URL */
		__cleanup() {
			this.__clearFullBlobTimer();
			this.__fullBlob = null;
			this.__isThumb = false;
			this.__revokeFullSrc();
			this.__revokeResolved();
		},
	},
};
</script>
