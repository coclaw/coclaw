<template>
	<div
		class="flex min-h-12 items-center gap-3 border-b border-default pl-4 pr-2 md:pr-3 py-2 cursor-pointer transition-colors hover:bg-accented/80 active:bg-accented"
		@click="onClick"
	>
		<!-- 图标 -->
		<UIcon
			:name="entry.type === 'dir' ? 'i-lucide-folder' : 'i-lucide-file'"
			class="size-5 shrink-0"
			:class="entry.type === 'dir' ? 'text-primary' : 'text-muted'"
		/>

		<!-- 名称 + 元信息 -->
		<div class="min-w-0 flex-1">
			<p class="truncate text-sm">{{ entry.name }}</p>
			<p class="text-xs text-muted">
				<span v-if="entry.type !== 'dir' && entry.size != null">{{ formatFileSize(entry.size) }}</span>
				<span v-if="entry.mtime" :class="entry.type !== 'dir' && entry.size != null ? 'ml-2' : ''">
					{{ formatDate(entry.mtime) }}
				</span>
			</p>
		</div>

		<!-- 下载进度（running 时显示进度 + 取消） -->
		<div v-if="downloadTask?.status === 'running'" class="flex items-center gap-2">
			<div class="h-1.5 w-16 overflow-hidden rounded-full bg-accented">
				<div class="h-full rounded-full bg-primary transition-all" :style="{ width: `${Math.round(downloadTask.progress * 100)}%` }" />
			</div>
			<UButton
				variant="ghost" color="neutral" size="xs"
				icon="i-lucide-x" class="cc-icon-btn"
				@click.stop="$emit('cancel-download', downloadTask.id)"
			/>
		</div>

		<!-- 下载失败（重试按钮） -->
		<div v-else-if="downloadTask?.status === 'failed'" class="flex items-center gap-1">
			<span class="text-xs text-error">{{ $t('common.failed') }}</span>
			<UButton
				variant="ghost" color="primary" size="xs"
				icon="i-lucide-rotate-cw" class="cc-icon-btn"
				@click.stop="$emit('retry-download', downloadTask.id)"
			/>
		</div>

		<!-- 删除按钮（下载 running 时隐藏） -->
		<UButton
			v-if="downloadTask?.status !== 'running'"
			variant="ghost" color="error" size="xs"
			icon="i-lucide-trash-2" class="cc-icon-btn"
			@click.stop="$emit('delete', entry)"
		/>
	</div>
</template>

<script>
import { formatFileSize } from '../../utils/file-helper.js';

export default {
	name: 'FileListItem',
	props: {
		entry: { type: Object, required: true },
		/** 该文件关联的下载任务（可选） */
		downloadTask: { type: Object, default: null },
	},
	emits: ['open-dir', 'download', 'delete', 'cancel-download', 'retry-download'],
	methods: {
		formatFileSize,
		onClick() {
			if (this.entry.type === 'dir') {
				this.$emit('open-dir', this.entry.name);
			} else {
				this.$emit('download', this.entry);
			}
		},
		formatDate(ts) {
			if (!ts) return '';
			const d = new Date(ts);
			if (isNaN(d.getTime())) return '';
			const y = d.getFullYear();
			const mo = String(d.getMonth() + 1).padStart(2, '0');
			const dd = String(d.getDate()).padStart(2, '0');
			return `${y}-${mo}-${dd}`;
		},
	},
};
</script>
