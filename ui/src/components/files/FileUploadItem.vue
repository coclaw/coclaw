<template>
	<div class="flex min-h-12 items-center gap-3 border-b border-default pl-4 pr-2 md:pr-3 py-2">
		<!-- 上传图标 -->
		<UIcon name="i-lucide-upload" class="size-5 shrink-0 text-muted" />

		<!-- 文件名 -->
		<div class="min-w-0 flex-1">
			<p class="truncate text-sm">{{ task.fileName }}</p>

			<!-- 进度条（running 时显示） -->
			<div v-if="task.status === 'running'" class="mt-1 flex items-center gap-2">
				<div class="h-1.5 flex-1 overflow-hidden rounded-full bg-accented">
					<div class="h-full rounded-full bg-primary transition-all" :style="{ width: `${Math.round(task.progress * 100)}%` }" />
				</div>
				<span class="shrink-0 text-xs text-muted">{{ Math.round(task.progress * 100) }}%</span>
			</div>

			<!-- 状态文字 -->
			<p v-else-if="task.status === 'pending'" class="text-xs text-muted">{{ $t('files.pending') }}</p>
			<p v-else-if="task.status === 'failed'" class="text-xs text-error">{{ task.error || $t('files.uploadFailed') }}</p>
		</div>

		<!-- 操作 -->
		<UButton
			v-if="task.status === 'running' || task.status === 'pending'"
			variant="ghost" color="neutral" size="xs"
			icon="i-lucide-circle-stop" class="cc-icon-btn"
			@click="$emit('cancel', task.id)"
		/>
		<UButton
			v-else-if="task.status === 'failed'"
			variant="ghost" color="primary" size="xs"
			icon="i-lucide-rotate-cw" class="cc-icon-btn"
			@click="$emit('retry', task.id)"
		/>
	</div>
</template>

<script>
export default {
	name: 'FileUploadItem',
	props: {
		task: { type: Object, required: true },
	},
	emits: ['cancel', 'retry'],
};
</script>
