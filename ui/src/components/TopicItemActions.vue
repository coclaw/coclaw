<template>
	<div class="relative" @click.prevent>
		<UPopover v-model:open="menuOpen" :content="{ side: 'bottom', align: 'end' }">
			<UButton
				variant="ghost"
				color="neutral"
				size="xs"
				icon="i-lucide-ellipsis"
				class="cc-icon-btn"
				:class="menuOpen ? 'opacity-100' : ''"
				aria-label="More"
			/>
			<template #content>
				<div class="flex max-w-60 flex-col py-1">
					<button
						class="flex min-h-11 items-center gap-2.5 px-3.5 text-sm text-default transition-colors hover:bg-accented active:bg-accented"
						@click="onRename"
					>
						<UIcon name="i-lucide-pencil" class="size-[18px] shrink-0" />
						<span class="truncate">{{ $t('topic.rename') }}</span>
					</button>
					<button
						class="flex min-h-11 items-center gap-2.5 px-3.5 text-sm text-error transition-colors hover:bg-accented active:bg-accented"
						@click="onDelete"
					>
						<UIcon name="i-lucide-trash-2" class="size-[18px] shrink-0" />
						<span class="truncate">{{ $t('topic.delete') }}</span>
					</button>
				</div>
			</template>
		</UPopover>

		<!-- 重命名对话框 -->
		<UModal v-model:open="renameOpen" :title="$t('topic.rename')" :ui="promptUi">
			<template #body>
				<UInput
					ref="renameInput"
					v-model="renameValue"
					autofocus
					class="w-full"
					:placeholder="$t('topic.newTopic')"
					@keydown.enter="onConfirmRename"
				/>
			</template>
			<template #footer>
				<div class="flex w-full justify-end gap-2">
					<UButton variant="ghost" color="neutral" @click="renameOpen = false">{{ $t('common.cancel') }}</UButton>
					<UButton :disabled="!renameValue.trim()" :loading="renaming" @click="onConfirmRename">{{ $t('common.confirm') }}</UButton>
				</div>
			</template>
		</UModal>

		<!-- 删除确认对话框 -->
		<UModal v-model:open="deleteOpen" :title="$t('topic.deleteConfirmTitle')" :ui="promptUi">
			<template #body>
				<p class="text-sm text-muted">{{ $t('topic.deleteConfirmDesc') }}</p>
			</template>
			<template #footer>
				<div class="flex w-full justify-end gap-2">
					<UButton variant="ghost" color="neutral" @click="deleteOpen = false">{{ $t('common.cancel') }}</UButton>
					<UButton color="error" :loading="deleting" @click="onConfirmDelete">{{ $t('common.confirm') }}</UButton>
				</div>
			</template>
		</UModal>
	</div>
</template>

<script>
import { useNotify } from '../composables/use-notify.js';
import { useTopicsStore } from '../stores/topics.store.js';
import { promptModalUi } from '../constants/prompt-modal-ui.js';

export default {
	name: 'TopicItemActions',
	props: {
		topicId: { type: String, required: true },
		botId: { type: String, required: true },
		title: { type: String, default: '' },
	},
	emits: ['deleted'],
	setup() {
		return {
			notify: useNotify(),
			promptUi: promptModalUi,
		};
	},
	data() {
		return {
			menuOpen: false,
			renameOpen: false,
			renameValue: '',
			renaming: false,
			deleteOpen: false,
			deleting: false,
		};
	},
	methods: {
		onRename() {
			this.menuOpen = false;
			this.renameValue = this.title || '';
			this.renameOpen = true;
		},
		async onConfirmRename() {
			const newTitle = this.renameValue.trim();
			if (!newTitle) return;
			this.renaming = true;
			try {
				const store = useTopicsStore();
				await store.updateTopic(this.botId, this.topicId, { title: newTitle });
				this.renameOpen = false;
			} catch (err) {
				this.notify.error(this.$t('topic.renameFailed'));
				console.warn('[TopicItemActions] rename failed:', err);
			} finally {
				this.renaming = false;
			}
		},
		onDelete() {
			this.menuOpen = false;
			this.deleteOpen = true;
		},
		async onConfirmDelete() {
			this.deleting = true;
			try {
				const store = useTopicsStore();
				await store.deleteTopic(this.botId, this.topicId);
				this.deleteOpen = false;
				this.$emit('deleted', this.topicId);
			} catch (err) {
				this.notify.error(this.$t('topic.deleteFailed'));
				console.warn('[TopicItemActions] delete failed:', err);
			} finally {
				this.deleting = false;
			}
		},
	},
};
</script>
