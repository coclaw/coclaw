<template>
	<div class="inline-flex max-w-full items-center gap-2 rounded-xl border border-accented py-2 pl-2 pr-1">
		<!-- 文件图标 -->
		<UIcon name="i-lucide-file" class="size-8 shrink-0 text-amber-400" />

		<!-- 文件名 + 大小 -->
		<div class="min-w-0 flex-1 leading-tight">
			<div class="flex text-sm text-default">
				<span class="truncate">{{ baseName }}</span>
				<span v-if="ext" class="shrink-0">.{{ ext }}</span>
			</div>
			<div class="truncate text-xs text-muted">{{ displaySize }}</div>
		</div>

		<!-- 下载按钮 -->
		<UButton
			v-if="src"
			class="cc-icon-btn shrink-0"
			icon="i-lucide-download"
			variant="ghost"
			color="neutral"
			size="md"
			:loading="downloading"
			:title="$t('chat.fileDownload')"
			@click="onDownload"
		/>
	</div>
</template>

<script>
import { isCoclawUrl, fetchCoclawFile } from '../services/coclaw-file.js';
import { formatFileSize, saveBlobToFile } from '../utils/file-helper.js';
import { useNotify } from '../composables/use-notify.js';

export default {
	name: 'ChatFile',
	props: {
		/** 文件名 */
		name: {
			type: String,
			default: '',
		},
		/** 文件大小（数字会格式化，字符串原样显示） */
		size: {
			type: [Number, String],
			default: null,
		},
		/**
		 * 下载来源。支持：
		 * - blob URL → 直接下载
		 * - coclaw-file://clawId:agentId/path → 按需下载后触发保存
		 */
		src: {
			type: String,
			default: null,
		},
	},
	setup() {
		return { notify: useNotify() };
	},
	data() {
		return {
			downloading: false,
		};
	},
	computed: {
		ext() {
			if (!this.name) return '';
			const dot = this.name.lastIndexOf('.');
			return dot > 0 ? this.name.slice(dot + 1) : '';
		},
		baseName() {
			const n = this.name || this.$t('chat.fileUnknown');
			if (!this.ext) return n;
			return n.slice(0, -(this.ext.length + 1));
		},
		displayName() {
			return this.name || this.$t('chat.fileUnknown');
		},
		displaySize() {
			if (this.size == null) return '';
			return typeof this.size === 'number' ? formatFileSize(this.size) : this.size;
		},
	},
	methods: {
		async onDownload() {
			if (this.downloading) return;
			if (!this.src) return;

			try {
				this.downloading = true;
				let blob;
				if (isCoclawUrl(this.src)) {
					blob = await fetchCoclawFile(this.src);
				} else {
					// blob URL → 取回 Blob
					const resp = await fetch(this.src);
					blob = await resp.blob();
				}
				await saveBlobToFile(blob, this.displayName);
			} catch (err) {
				console.warn('[ChatFile] download failed:', err);
				this.notify.error(this.$t('chat.fileDownloadFailed'));
			} finally {
				this.downloading = false;
			}
		},
	},
};
</script>
