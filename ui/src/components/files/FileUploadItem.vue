<template>
	<div class="flex min-h-12 items-center gap-3 border-b border-default pl-4 pr-2 md:pr-3 py-2">
		<!-- 上传图标 -->
		<UIcon name="i-lucide-upload" class="size-5 shrink-0 text-muted" />

		<!-- 文件名 + 状态文字 -->
		<div class="min-w-0 flex-1">
			<p class="truncate text-sm">{{ task.fileName }}</p>
			<p v-if="task.status === 'pending'" class="text-xs text-muted">{{ $t('files.pending') }}</p>
			<p v-else-if="task.status === 'failed'" class="text-xs text-error">{{ task.error || $t('files.uploadFailed') }}</p>
		</div>

		<!-- 进度环（running 时与 action 并列） -->
		<ProgressRing
			v-if="task.status === 'running'"
			:value="task.progress"
		/>

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
import ProgressRing from '../ProgressRing.vue';

export default {
	name: 'FileUploadItem',
	components: { ProgressRing },
	props: {
		task: { type: Object, required: true },
	},
	emits: ['cancel', 'retry'],
};
</script>
