<template>
	<div class="relative flex h-full flex-col overflow-hidden">
		<!-- 移动端 header -->
		<MobilePageHeader :title="pageTitle">
			<template #actions>
				<UButton
					class="cc-icon-btn-lg" variant="ghost" color="primary"
					icon="i-lucide-upload" :disabled="!connReady"
					@click="triggerUpload"
				/>
			</template>
		</MobilePageHeader>

		<!-- 桌面端 header -->
		<header class="z-10 hidden shrink-0 min-h-12 items-center border-b border-default bg-elevated pl-4 py-1 md:flex">
			<h1 class="text-base">{{ pageTitle }}</h1>
			<div class="ml-auto flex items-center gap-1 pr-2">
				<UButton
					class="cc-icon-btn-lg" variant="ghost" color="primary"
					icon="i-lucide-upload" :disabled="!connReady"
					@click="triggerUpload"
				/>
			</div>
		</header>

		<!-- 面包屑 + 操作栏 -->
		<div class="mx-auto flex w-full max-w-4xl items-center border-b border-default">
			<FileBreadcrumb :path="currentDir" class="flex-1" @navigate="navigateTo" />
			<div class="flex shrink-0 items-center gap-1 pr-2 md:pr-3">
				<UButton
					data-testid="btn-mkdir"
					variant="ghost" color="neutral" size="xs"
					icon="i-lucide-folder-plus" class="cc-icon-btn"
					:disabled="!connReady" @click="onMkdir"
				/>
				<UButton
					data-testid="btn-refresh"
					variant="ghost" color="neutral" size="xs"
					icon="i-lucide-refresh-cw" class="cc-icon-btn"
					:disabled="!connReady" :loading="loading"
					@click="loadDir"
				/>
			</div>
		</div>

		<!-- 文件列表 -->
		<main class="flex-1 min-h-0 overflow-y-auto">
			<div class="mx-auto w-full max-w-4xl">
				<!-- 连接中 -->
				<div v-if="!connReady" class="px-4 py-8 text-center text-sm text-muted">
					{{ $t('files.connecting') }}
				</div>

				<!-- 加载中 -->
				<div v-else-if="loading && !entries.length" class="px-4 py-8 text-center text-sm text-muted">
					{{ $t('files.loading') }}
				</div>

				<!-- 空目录（根目录且无内容时） -->
				<div v-else-if="!currentDir && !entries.length && !uploadTasks.length" class="px-4 py-8 text-center text-sm text-muted">
					{{ $t('files.emptyDir') }}
				</div>

				<!-- 列表 -->
				<template v-else>
					<!-- 返回上层（非根目录时显示） -->
					<div
						v-if="currentDir"
						class="flex min-h-12 items-center gap-3 border-b border-default px-4 py-2 cursor-pointer transition-colors hover:bg-accented/80 active:bg-accented"
						@click="goParent"
					>
						<UIcon name="i-lucide-corner-left-up" class="size-5 shrink-0 text-muted" />
						<p class="text-sm text-muted">..</p>
					</div>
					<FileListItem
						v-for="entry in sortedEntries"
						:key="entry.name"
						:entry="entry"
						:download-task="getDownloadTask(entry)"
						@open-dir="onOpenDir"
						@download="onDownload"
						@delete="onDelete"
						@cancel-download="onCancelDownload"
						@retry-download="onRetryDownload"
					/>
				</template>

				<!-- 上传任务（虚拟条目） -->
				<FileUploadItem
					v-for="task in uploadTasks"
					:key="task.id"
					:task="task"
					@cancel="onCancelUpload"
					@retry="onRetryUpload"
				/>
			</div>
		</main>

		<!-- 拖拽蒙层（事件由 root listener 统一处理，蒙层仅展示 + 保持 dragover） -->
		<div
			v-if="dragging"
			class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-default/80"
		>
			<p class="text-lg font-medium text-primary">{{ $t('files.dropHint') }}</p>
		</div>

		<!-- 隐藏的文件 input -->
		<input ref="fileInput" type="file" multiple class="hidden" @change="onFileInputChange" />

		<!-- 重名处理对话框 -->
		<UModal v-model:open="duplicateOpen" :title="$t('files.duplicateTitle')" description=" " :ui="promptUi">
			<template #body>
				<p class="mb-3 text-sm text-muted">{{ $t('files.duplicateDesc') }}</p>
				<div class="space-y-2">
					<div v-for="item in duplicateItems" :key="item.name" class="flex items-center justify-between gap-2 text-sm">
						<span class="min-w-0 truncate">{{ item.name }}</span>
						<div class="flex shrink-0 gap-3">
							<label class="flex items-center gap-1 cursor-pointer">
								<input
									type="radio" :name="'dup-' + item.name" :value="'overwrite'"
									:checked="item.action === 'overwrite'"
									@change="setDuplicateAction(item, 'overwrite')"
								/>
								<span class="text-xs">{{ $t('files.overwrite') }}</span>
							</label>
							<label class="flex items-center gap-1 cursor-pointer">
								<input
									type="radio" :name="'dup-' + item.name" :value="'skip'"
									:checked="item.action === 'skip'"
									@change="setDuplicateAction(item, 'skip')"
								/>
								<span class="text-xs">{{ $t('files.skip') }}</span>
							</label>
						</div>
					</div>
				</div>
				<UCheckbox v-if="duplicateItems.length > 1" v-model="duplicateApplyAll" :label="$t('files.applyToAll')" class="mt-3" />
			</template>
			<template #footer>
				<div class="flex w-full justify-end gap-2">
					<UButton variant="ghost" color="neutral" @click="duplicateOpen = false">{{ $t('common.cancel') }}</UButton>
					<UButton @click="onConfirmDuplicates">{{ $t('common.confirm') }}</UButton>
				</div>
			</template>
		</UModal>

		<!-- 删除目录确认对话框 -->
		<UModal v-model:open="deleteDirOpen" :title="$t('files.deleteDirTitle')" description=" " :ui="promptUi">
			<template #body>
				<p class="text-sm text-muted">{{ $t('files.deleteDirDesc', { name: deleteDirName }) }}</p>
				<UCheckbox v-model="deleteDirChecked" :label="$t('files.deleteDirCheck')" class="mt-3" />
			</template>
			<template #footer>
				<div class="flex w-full justify-end gap-2">
					<UButton variant="ghost" color="neutral" @click="deleteDirOpen = false">{{ $t('common.cancel') }}</UButton>
					<UButton color="error" :disabled="!deleteDirChecked" :loading="deleting" @click="onConfirmDeleteDir">{{ $t('files.delete') }}</UButton>
				</div>
			</template>
		</UModal>

		<!-- 删除文件确认对话框 -->
		<UModal v-model:open="deleteFileOpen" :title="$t('files.delete')" description=" " :ui="promptUi">
			<template #body>
				<p class="text-sm text-muted">{{ $t('files.deleteFileConfirm', { name: deleteFileName }) }}</p>
			</template>
			<template #footer>
				<div class="flex w-full justify-end gap-2">
					<UButton variant="ghost" color="neutral" @click="deleteFileOpen = false">{{ $t('common.cancel') }}</UButton>
					<UButton color="error" :loading="deleting" @click="onConfirmDeleteFile">{{ $t('common.confirm') }}</UButton>
				</div>
			</template>
		</UModal>

		<!-- 新建目录对话框 -->
		<UModal v-model:open="mkdirOpen" :title="$t('files.mkdirTitle')" description=" " :ui="promptUi">
			<template #body>
				<UInput
					ref="mkdirInput"
					v-model="mkdirName"
					autofocus
					class="w-full"
					:placeholder="$t('files.mkdirPlaceholder')"
					@keydown.enter="onConfirmMkdir"
				/>
			</template>
			<template #footer>
				<div class="flex w-full justify-end gap-2">
					<UButton variant="ghost" color="neutral" @click="mkdirOpen = false">{{ $t('common.cancel') }}</UButton>
					<UButton :disabled="!mkdirName.trim()" :loading="mkdirLoading" @click="onConfirmMkdir">{{ $t('common.confirm') }}</UButton>
				</div>
			</template>
		</UModal>
	</div>
</template>

<script>
import MobilePageHeader from '../components/MobilePageHeader.vue';
import FileBreadcrumb from '../components/files/FileBreadcrumb.vue';
import FileListItem from '../components/files/FileListItem.vue';
import FileUploadItem from '../components/files/FileUploadItem.vue';
import { useFilesStore } from '../stores/files.store.js';
import { useAgentsStore } from '../stores/agents.store.js';
import { useBotsStore } from '../stores/bots.store.js';
import { useBotConnections } from '../services/bot-connection-manager.js';
import { listFiles, deleteFile, mkdirFiles } from '../services/file-transfer.js';
import { useNotify } from '../composables/use-notify.js';
import { promptModalUi } from '../constants/prompt-modal-ui.js';

export default {
	name: 'FileManagerPage',
	components: { MobilePageHeader, FileBreadcrumb, FileListItem, FileUploadItem },
	setup() {
		return {
			filesStore: useFilesStore(),
			agentsStore: useAgentsStore(),
			botsStore: useBotsStore(),
			notify: useNotify(),
			promptUi: promptModalUi,
		};
	},
	data() {
		return {
			currentDir: '',
			entries: [],
			loading: false,
			dragging: false,
			// 重名处理
			duplicateOpen: false,
			duplicateItems: [],
			duplicateApplyAll: false,
			// 删除目录
			deleteDirOpen: false,
			deleteDirName: '',
			deleteDirChecked: false,
			deleting: false,
			// 删除文件
			deleteFileOpen: false,
			deleteFileName: '',
			// 新建目录
			mkdirOpen: false,
			mkdirName: '',
			mkdirLoading: false,
		};
	},
	computed: {
		botId() { return this.$route.params.botId; },
		agentId() { return this.$route.params.agentId; },
		connReady() {
			const bot = this.botsStore.byId[this.botId];
			return !!bot?.dcReady;
		},
		pageTitle() {
			const display = this.agentsStore.getAgentDisplay(this.botId, this.agentId);
			return `${display.name} ${this.$t('files.titleSuffix')}`;
		},
		sortedEntries() {
			// 目录在前，文件在后
			return [...this.entries].sort((a, b) => {
				if (a.type === 'dir' && b.type !== 'dir') return -1;
				if (a.type !== 'dir' && b.type === 'dir') return 1;
				return a.name.localeCompare(b.name);
			});
		},
		uploadTasks() {
			return this.filesStore.getActiveTasks(this.botId, this.agentId, this.currentDir)
				.filter((t) => t.type === 'upload');
		},
		downloadTasks() {
			return this.filesStore.getActiveTasks(this.botId, this.agentId, this.currentDir)
				.filter((t) => t.type === 'download');
		},
	},
	watch: {
		'$route.params.botId'() { this.resetAndLoad(); },
		'$route.params.agentId'() { this.resetAndLoad(); },
		connReady: {
			immediate: true,
			handler(ready) {
				if (ready) this.loadDir();
			},
		},
	},
	beforeCreate() {
		this.__loadGen = 0;
	},
	mounted() {
		this.$el.addEventListener('dragover', this.__onDragOver);
		this.$el.addEventListener('dragleave', this.__onDragLeave);
		this.$el.addEventListener('drop', this.__onDrop);
	},
	beforeUnmount() {
		this.__unmounted = true;
		clearTimeout(this.__refreshTimer);
		this.filesStore.clearFinished(this.botId, this.agentId);
		this.$el.removeEventListener('dragover', this.__onDragOver);
		this.$el.removeEventListener('dragleave', this.__onDragLeave);
		this.$el.removeEventListener('drop', this.__onDrop);
	},
	methods: {
		resetAndLoad() {
			clearTimeout(this.__refreshTimer);
			this.__refreshTimer = null;
			this.currentDir = '';
			this.entries = [];
			this.loadDir();
		},

		async loadDir() {
			if (this.loading) return;
			const botConn = useBotConnections().get(this.botId);
			if (!botConn) return; // connReady watcher 会在连接就绪后重新触发
			const gen = ++this.__loadGen;
			this.loading = true;
			try {
				const result = await listFiles(botConn, this.agentId, this.currentDir || '.');
				if (gen !== this.__loadGen) return; // 被更新的请求取代
				this.entries = result.files || [];
			} catch (err) {
				if (gen !== this.__loadGen) return;
				this.notify.error(err?.message ?? this.$t('common.failed'));
				console.warn('[FileManagerPage] loadDir failed:', err);
				this.entries = [];
			} finally {
				if (gen === this.__loadGen) this.loading = false;
			}
		},

		navigateTo(path) {
			this.currentDir = path;
			this.loadDir();
		},

		goParent() {
			const parts = this.currentDir.split('/');
			parts.pop();
			this.currentDir = parts.join('/');
			this.loadDir();
		},

		onOpenDir(name) {
			this.currentDir = this.currentDir ? `${this.currentDir}/${name}` : name;
			this.loadDir();
		},

		// --- 上传 ---

		triggerUpload() {
			this.$refs.fileInput.click();
		},

		onFileInputChange(e) {
			const files = Array.from(e.target.files || []);
			e.target.value = ''; // reset input
			if (files.length) this.__handleUploadFiles(files);
		},

		__handleUploadFiles(files) {
			// 检测重名
			const existingNames = new Set(this.entries.map((e) => e.name));
			const duplicates = [];
			const clean = [];
			for (const file of files) {
				if (existingNames.has(file.name)) {
					duplicates.push({ name: file.name, file, action: 'skip' });
				} else {
					clean.push(file);
				}
			}

			if (!duplicates.length) {
				this.filesStore.enqueueUploads(this.botId, this.agentId, this.currentDir, clean);
				this.__watchUploadsForRefresh();
				return;
			}

			// 有重名，弹出对话框
			this.__pendingFiles = clean;
			this.duplicateItems = duplicates;
			this.duplicateApplyAll = false;
			this.duplicateOpen = true;
		},

		setDuplicateAction(item, action) {
			item.action = action;
			if (this.duplicateApplyAll) {
				for (const d of this.duplicateItems) {
					d.action = action;
				}
				// 设计要求：勾选"应用于全部"后选择即直接确认
				this.onConfirmDuplicates();
			}
		},

		onConfirmDuplicates() {
			const toUpload = [...this.__pendingFiles];
			this.__pendingFiles = null;
			for (const item of this.duplicateItems) {
				if (item.action === 'overwrite') {
					toUpload.push(item.file);
				}
			}
			this.duplicateOpen = false;
			if (toUpload.length) {
				this.filesStore.enqueueUploads(this.botId, this.agentId, this.currentDir, toUpload);
				this.__watchUploadsForRefresh();
			}
		},

		/**
		 * 监听上传完成后自动刷新目录
		 */
		__watchUploadsForRefresh() {
			if (this.__refreshTimer) return; // 已有轮询在跑
			const check = () => {
				this.__refreshTimer = null;
				if (this.__unmounted) return;
				const active = this.filesStore.getActiveTasks(this.botId, this.agentId, this.currentDir)
					.filter((t) => t.type === 'upload' && (t.status === 'pending' || t.status === 'running'));
				if (!active.length) {
					this.loadDir();
				} else {
					this.__refreshTimer = setTimeout(check, 500);
				}
			};
			this.__refreshTimer = setTimeout(check, 500);
		},

		// --- 下载 ---

		onDownload(entry) {
			this.filesStore.enqueueDownload(
				this.botId, this.agentId, this.currentDir,
				entry.name, entry.size,
			);
		},

		getDownloadTask(entry) {
			if (entry.type === 'dir') return null;
			return this.downloadTasks.find((t) => t.fileName === entry.name) || null;
		},

		onCancelDownload(taskId) {
			this.filesStore.cancelTask(taskId);
		},

		onRetryDownload(taskId) {
			this.filesStore.retryTask(taskId);
		},

		// --- 删除 ---

		onDelete(entry) {
			if (entry.type === 'dir') {
				this.deleteDirName = entry.name;
				this.__deleteDirPath = this.currentDir ? `${this.currentDir}/${entry.name}` : entry.name;
				this.deleteDirChecked = false;
				this.deleteDirOpen = true;
			} else {
				this.deleteFileName = entry.name;
				this.__deleteFilePath = this.currentDir ? `${this.currentDir}/${entry.name}` : entry.name;
				this.deleteFileOpen = true;
			}
		},

		async onConfirmDeleteFile() {
			const botConn = useBotConnections().get(this.botId);
			if (!botConn) return;
			this.deleting = true;
			try {
				await deleteFile(botConn, this.agentId, this.__deleteFilePath);
				this.deleteFileOpen = false;
				this.loadDir();
			} catch (err) {
				this.notify.error(this.$t('files.deleteFailed'));
				console.warn('[FileManagerPage] delete file failed:', err);
			} finally {
				this.deleting = false;
			}
		},

		async onConfirmDeleteDir() {
			const botConn = useBotConnections().get(this.botId);
			if (!botConn) return;
			this.deleting = true;
			try {
				await deleteFile(botConn, this.agentId, this.__deleteDirPath, { force: true });
				this.deleteDirOpen = false;
				this.loadDir();
			} catch (err) {
				this.notify.error(this.$t('files.deleteFailed'));
				console.warn('[FileManagerPage] delete dir failed:', err);
			} finally {
				this.deleting = false;
			}
		},

		// --- 新建目录 ---

		onMkdir() {
			this.mkdirName = '';
			this.mkdirOpen = true;
		},

		async onConfirmMkdir() {
			if (this.mkdirLoading) return;
			const name = this.mkdirName.trim();
			if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) return;
			const botConn = useBotConnections().get(this.botId);
			if (!botConn) return;
			this.mkdirLoading = true;
			try {
				const path = this.currentDir ? `${this.currentDir}/${name}` : name;
				await mkdirFiles(botConn, this.agentId, path);
				this.mkdirOpen = false;
				this.loadDir();
			} catch (err) {
				this.notify.error(this.$t('files.mkdirFailed'));
				console.warn('[FileManagerPage] mkdir failed:', err);
			} finally {
				this.mkdirLoading = false;
			}
		},

		// --- 上传取消/重试 ---

		onCancelUpload(taskId) {
			this.filesStore.cancelTask(taskId);
		},

		onRetryUpload(taskId) {
			this.filesStore.retryTask(taskId);
		},

		// --- 拖拽事件 ---

		__onDragOver(e) {
			e.preventDefault();
			this.dragging = true;
		},
		__onDragLeave(e) {
			// 只在离开组件根元素时关闭蒙层
			if (!this.$el.contains(e.relatedTarget)) {
				this.dragging = false;
			}
		},
		__onDrop(e) {
			e.preventDefault();
			this.dragging = false;
			const files = Array.from(e.dataTransfer?.files || []);
			if (files.length) this.__handleUploadFiles(files);
		},
	},
};
</script>
