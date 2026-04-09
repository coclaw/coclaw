<template>
	<!-- 加载中（最小占位，不预设固定尺寸，避免与实际图片的尺寸差导致布局位移） -->
	<div v-if="loading" class="flex min-h-[52px] min-w-[128px] items-center justify-center rounded-lg bg-elevated">
		<UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-dimmed" />
	</div>
	<!-- 加载失败：退化为类 ChatFile 卡片 -->
	<div v-else-if="error" class="inline-flex max-w-full items-center gap-2 rounded-xl border border-accented py-2 pl-2 pr-1">
		<UIcon name="i-lucide-image-off" class="size-8 shrink-0 text-dimmed" />
		<div class="min-w-0 flex-1 leading-tight">
			<div class="flex text-sm text-default">
				<span class="truncate">{{ errorBaseName }}</span>
				<span v-if="errorExt" class="shrink-0">.{{ errorExt }}</span>
			</div>
			<div v-if="displaySize" class="truncate text-xs text-muted">{{ displaySize }}</div>
		</div>
		<UButton
			class="cc-icon-btn shrink-0"
			:icon="isNative ? 'i-lucide-share-2' : 'i-lucide-download'"
			variant="ghost"
			color="neutral"
			size="md"
			:loading="downloading"
			:title="isNative ? $t('chat.fileShare') : $t('chat.fileDownload')"
			@click.stop="__download"
		/>
	</div>
	<!-- 图片 -->
	<div v-else-if="resolvedSrc" class="relative w-fit">
		<img
			:src="resolvedSrc"
			alt=""
			class="min-h-10 min-w-10 rounded-lg"
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
		<!-- 下载/分享按钮 -->
		<UButton
			class="absolute top-1 right-1 cc-icon-btn"
			:icon="isNative ? 'i-lucide-share-2' : 'i-lucide-download'"
			variant="ghost"
			color="neutral"
			size="md"
			:loading="downloading"
			:ui="{ base: 'text-white bg-black/30 hover:bg-black/50' }"
			:aria-label="isNative ? $t('chat.fileShare') : $t('chat.fileDownload')"
			:title="isNative ? $t('chat.fileShare') : $t('chat.fileDownload')"
			@click.stop="__download"
		/>
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
import { isCoclawUrl, fetchCoclawFile, parseCoclawUrl } from '../services/coclaw-file.js';
import { compressImage } from '../utils/image-helper.js';
import { formatFileSize, saveBlobToFile, saveUrlAsFile } from '../utils/file-helper.js';
import { useNotify } from '../composables/use-notify.js';
import { isCapacitorApp } from '../utils/platform.js';

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
		 * - coclaw-file://clawId:agentId/path → 下载后压缩为缩略图显示
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
		/** 文件大小（数字会格式化，字符串原样显示），用于加载失败时的退化卡片 */
		size: {
			type: [Number, String],
			default: null,
		},
	},
	setup() {
		return { notify: useNotify() };
	},
	computed: {
		errorExt() {
			if (!this.filename) return '';
			const dot = this.filename.lastIndexOf('.');
			return dot > 0 ? this.filename.slice(dot + 1) : '';
		},
		errorBaseName() {
			const n = this.filename || this.$t('chat.fileUnknown');
			if (!this.errorExt) return n;
			return n.slice(0, -(this.errorExt.length + 1));
		},
		displaySize() {
			if (this.size == null) return '';
			return typeof this.size === 'number' ? formatFileSize(this.size) : this.size;
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
			isNative: isCapacitorApp,
			downloading: false,
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
				const filePath = parseCoclawUrl(srcAtStart)?.path || srcAtStart;
				console.warn('[ChatImg] resolve failed:', filePath, err);
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
				this.fullLoading = false;
			}
		},

		async __download() {
			if (this.downloading) return;
			const srcAtStart = this.src;
			const filename = this.filename;

			// 外部 URL 且未压缩：Web 端用链接下载避免 CORS，原生端无此限制
			if (!this.__isThumb && !this.isNative
				&& !srcAtStart.startsWith('data:') && !srcAtStart.startsWith('blob:')
				&& !isCoclawUrl(srcAtStart)) {
				saveUrlAsFile(this.resolvedSrc, filename);
				return;
			}

			this.downloading = true;
			const wasError = this.error;
			try {
				const blob = await this.__getFullBlob(srcAtStart);
				if (this.__unmounted || this.src !== srcAtStart) return;
				await saveBlobToFile(blob, filename);
				// 下载成功且此前处于错误态 → 恢复为缩略图显示
				if (wasError) this.__recoverFromBlob(blob, srcAtStart);
			} catch (err) {
				console.warn('[ChatImg] download failed:', err);
				if (!this.__unmounted) this.notify.error(this.$t('files.downloadFailed'));
			} finally {
				this.downloading = false;
			}
		},

		/** 获取原图 Blob（缩略图场景需还原为原图） */
		async __getFullBlob(srcAtStart) {
			// 错误态（coclaw-file 加载失败）→ 优先用缓存，否则重新获取
			if (this.error) {
				if (this.__fullBlob) return this.__fullBlob;
				const blob = await fetchCoclawFile(srcAtStart);
				if (!this.__unmounted && this.src === srcAtStart) {
					this.__fullBlob = blob;
					this.__startFullBlobTimer();
				}
				return blob;
			}
			// 未压缩 → resolvedSrc 就是完整图
			if (!this.__isThumb) {
				const resp = await fetch(this.resolvedSrc);
				return resp.blob();
			}
			// 有缓存
			if (this.__fullBlob) return this.__fullBlob;
			// data URI 本身是全图
			if (this.src.startsWith('data:')) {
				const resp = await fetch(this.src);
				return resp.blob();
			}
			// 重新获取原图（coclaw-file / blob URL）
			let blob;
			if (isCoclawUrl(this.src)) {
				blob = await fetchCoclawFile(this.src);
			} else {
				const resp = await fetch(this.src);
				blob = await resp.blob();
			}
			if (this.__unmounted || this.src !== srcAtStart) return blob;
			this.__fullBlob = blob;
			this.__startFullBlobTimer();
			return blob;
		},

		/** 下载成功后从错误态恢复为缩略图显示 */
		async __recoverFromBlob(blob, srcAtStart) {
			try {
				const result = await compressImage(blob, { maxWidth: THUMB_MAX, maxHeight: THUMB_MAX });
				if (this.__unmounted || this.src !== srcAtStart) return;
				this.__revokeResolved();
				if (result.skipped || result.blob === blob) {
					this.resolvedSrc = URL.createObjectURL(blob);
					this.__isThumb = false;
				} else {
					this.resolvedSrc = URL.createObjectURL(result.blob);
					this.__isThumb = true;
					// 重启缓存计时器，使 TTL 从缩略图显示时刻算起
					if (this.__fullBlob) this.__startFullBlobTimer();
				}
				this.error = false;
			} catch {
				// 压缩失败则保持错误态
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
