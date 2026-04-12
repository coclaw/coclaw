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
				<!-- 连接中（有缓存数据时仍展示列表，仅禁用操作） -->
				<div v-if="!connReady && !entries.length" class="px-4 py-8 text-center text-sm text-muted">
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
		<UModal v-model:open="duplicateOpen" :title="$t('files.duplicateTitle')" description=" " :ui="duplicateModalUi">
			<template #body>
				<p class="mb-3 text-sm text-muted">{{ $t('files.duplicateDesc') }}</p>
				<div class="max-h-60 space-y-2 overflow-y-auto">
					<div v-for="item in duplicateItems" :key="item.name" class="flex items-center justify-between gap-2 text-sm">
						<span class="min-w-0 truncate">{{ item.name }}</span>
						<URadioGroup
							:model-value="item.action"
							:items="duplicateActionItems"
							class="shrink-0"
							:ui="{ fieldset: 'flex gap-3' }"
							@update:model-value="item.action = $event"
						/>
					</div>
				</div>
			</template>
			<template #footer>
				<div class="flex w-full items-center gap-2">
					<template v-if="duplicateItems.length > 1">
						<UButton variant="ghost" color="neutral" size="xs" @click="setAllDuplicateAction('overwrite')">{{ $t('files.overwriteAll') }}</UButton>
						<UButton variant="ghost" color="neutral" size="xs" @click="setAllDuplicateAction('skip')">{{ $t('files.skipAll') }}</UButton>
					</template>
					<div class="flex-1" />
					<UButton variant="ghost" color="neutral" @click="duplicateOpen = false">{{ $t('common.cancel') }}</UButton>
					<UButton @click="onConfirmDuplicates">{{ $t('common.confirm') }}</UButton>
				</div>
			</template>
		</UModal>

		<!-- 删除目录确认对话框 -->
		<UModal v-model:open="deleteDirOpen" :title="$t('files.deleteDirTitle')" description=" " :ui="promptUi">
			<template #body>
				<p class="text-sm text-muted">{{ $t('files.deleteDirDesc', { name: deleteDirName }) }}</p>
				<p v-if="deleteDirProtectedDesc" class="mt-2 text-sm text-warning">{{ deleteDirProtectedDesc }}</p>
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
				<template v-if="deleteFileProtectedDesc">
					<p class="mt-2 text-sm text-warning">{{ deleteFileProtectedDesc }}</p>
					<UCheckbox v-model="deleteFileChecked" :label="$t('files.deleteProtectedCheck')" class="mt-3" />
				</template>
			</template>
			<template #footer>
				<div class="flex w-full justify-end gap-2">
					<UButton variant="ghost" color="neutral" @click="deleteFileOpen = false">{{ $t('common.cancel') }}</UButton>
					<UButton color="error" :disabled="!!deleteFileProtectedDesc && !deleteFileChecked" :loading="deleting" @click="onConfirmDeleteFile">{{ $t('common.confirm') }}</UButton>
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
import { useClawsStore } from '../stores/claws.store.js';
import { useClawConnections } from '../services/claw-connection-manager.js';
import { listFiles, deleteFile, mkdirFiles, MAX_UPLOAD_SIZE } from '../services/file-transfer.js';
import { useNotify } from '../composables/use-notify.js';
import { promptModalUi } from '../constants/prompt-modal-ui.js';

// workspace 根目录下受保护的文件/目录 → i18n key 映射
const PROTECTED_FILE_KEYS = {
	'MEMORY.md': 'MEMORY', 'SOUL.md': 'SOUL', 'IDENTITY.md': 'IDENTITY',
	'USER.md': 'USER', 'AGENTS.md': 'AGENTS', 'TOOLS.md': 'TOOLS',
	'HEARTBEAT.md': 'HEARTBEAT',
};
const PROTECTED_DIR_KEYS = { '.coclaw': 'coclaw' };

export default {
	name: 'FileManagerPage',
	components: { MobilePageHeader, FileBreadcrumb, FileListItem, FileUploadItem },
	setup() {
		return {
			filesStore: useFilesStore(),
			agentsStore: useAgentsStore(),
			clawsStore: useClawsStore(),
			notify: useNotify(),
			promptUi: promptModalUi,
			duplicateModalUi: {
				...promptModalUi,
				content: 'w-[calc(100vw-2rem)] max-w-lg divide-y-0',
			},
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
			// 删除目录
			deleteDirOpen: false,
			deleteDirName: '',
			deleteDirChecked: false,
			deleting: false,
			// 删除文件
			deleteFileOpen: false,
			deleteFileName: '',
			deleteFileChecked: false,
			// 新建目录
			mkdirOpen: false,
			mkdirName: '',
			mkdirLoading: false,
		};
	},
	computed: {
		clawId() { return this.$route.params.clawId; },
		agentId() { return this.$route.params.agentId; },
		connReady() {
			const claw = this.clawsStore.byId[this.clawId];
			return !!claw?.dcReady;
		},
		pageTitle() {
			const display = this.agentsStore.getAgentDisplay(this.clawId, this.agentId);
			return `${display.name} ${this.$t('files.titleSuffix')}`;
		},
		sortedEntries() {
			// 过滤掉与活跃上传任务同名的条目（覆盖上传期间隐藏旧条目）
			const uploadingNames = new Set(this.uploadTasks.map((t) => t.fileName));
			const filtered = uploadingNames.size
				? this.entries.filter((e) => e.type === 'dir' || !uploadingNames.has(e.name))
				: this.entries;
			// 目录在前，文件在后
			return [...filtered].sort((a, b) => {
				if (a.type === 'dir' && b.type !== 'dir') return -1;
				if (a.type !== 'dir' && b.type === 'dir') return 1;
				return a.name.localeCompare(b.name);
			});
		},
		uploadTasks() {
			return this.filesStore.getActiveTasks(this.clawId, this.agentId, this.currentDir)
				.filter((t) => t.type === 'upload');
		},
		downloadTasks() {
			return this.filesStore.getActiveTasks(this.clawId, this.agentId, this.currentDir)
				.filter((t) => t.type === 'download');
		},
		deleteFileProtectedDesc() {
			if (this.currentDir) return '';
			const key = PROTECTED_FILE_KEYS[this.deleteFileName];
			return key ? this.$t(`files.protectedFileDesc.${key}`) : '';
		},
		deleteDirProtectedDesc() {
			if (this.currentDir) return '';
			const key = PROTECTED_DIR_KEYS[this.deleteDirName];
			return key ? this.$t(`files.protectedDirDesc.${key}`) : '';
		},
		duplicateActionItems() {
			return [
				{ label: this.$t('files.overwrite'), value: 'overwrite' },
				{ label: this.$t('files.skip'), value: 'skip' },
			];
		},
	},
	watch: {
		'$route.params.clawId'() { this.resetAndLoad(); },
		'$route.params.agentId'() { this.resetAndLoad(); },
		connReady: {
			immediate: true,
			handler(ready) {
				if (!ready) return;
				if (this.entries.length) {
					// 重连：已有数据，静默刷新
					this.loadDir({ silent: true });
				} else {
					// 首次 / 无数据：尝试从缓存恢复再加载
					const cached = this.filesStore.getCachedDir(this.clawId, this.agentId);
					if (cached?.currentDir === this.currentDir) {
						this.entries = cached.entries;
					}
					this.loadDir();
				}
			},
		},
	},
	beforeCreate() {
		this.__loadGen = 0;
		this.__pendingFiles = null;
	},
	mounted() {
		this.$el.addEventListener('dragover', this.__onDragOver);
		this.$el.addEventListener('dragleave', this.__onDragLeave);
		this.$el.addEventListener('drop', this.__onDrop);
	},
	beforeUnmount() {
		this.__unmounted = true;
		clearTimeout(this.__refreshTimer);
		this.filesStore.clearFinished(this.clawId, this.agentId);
		this.$el.removeEventListener('dragover', this.__onDragOver);
		this.$el.removeEventListener('dragleave', this.__onDragLeave);
		this.$el.removeEventListener('drop', this.__onDrop);
	},
	methods: {
		resetAndLoad() {
			clearTimeout(this.__refreshTimer);
			this.__refreshTimer = null;
			this.__cancelInFlight();
			this.currentDir = '';
			// 切换 agent 时尝试从缓存恢复，减少白屏
			const cached = this.filesStore.getCachedDir(this.clawId, this.agentId);
			this.entries = (cached?.currentDir === '') ? cached.entries : [];
			this.loadDir();
		},

		async loadDir({ silent = false, dir } = {}) {
			if (this.loading) return;
			const clawConn = useClawConnections().get(this.clawId);
			if (!clawConn) return; // connReady watcher 会在连接就绪后重新触发
			const targetDir = dir ?? this.currentDir;
			const gen = ++this.__loadGen;
			if (!silent) this.loading = true;
			try {
				const result = await listFiles(clawConn, this.agentId, targetDir || '.');
				if (gen !== this.__loadGen) return; // 被更新的请求取代
				this.currentDir = targetDir;
				this.entries = result.files || [];
				this.filesStore.setDirCache(this.clawId, this.agentId, this.currentDir, this.entries);
			} catch (err) {
				if (gen !== this.__loadGen) return;
				// 静默刷新失败时不打扰用户（已有缓存数据在展示）
				if (!silent) this.notify.error(err?.message ?? this.$t('common.failed'));
				console.warn('[FileManagerPage] loadDir failed:', err);
				// 失败时不清空——保留当前 entries；完全无数据时尝试缓存兜底
				if (!this.entries.length) {
					const cached = this.filesStore.getCachedDir(this.clawId, this.agentId);
					if (cached?.currentDir === this.currentDir) {
						this.entries = cached.entries;
					}
				}
			} finally {
				if (gen === this.__loadGen) this.loading = false;
			}
		},

		navigateTo(path) {
			this.__cancelInFlight();
			this.loadDir({ dir: path });
		},

		goParent() {
			this.__cancelInFlight();
			const parts = this.currentDir.split('/');
			parts.pop();
			this.loadDir({ dir: parts.join('/') });
		},

		onOpenDir(name) {
			this.__cancelInFlight();
			this.loadDir({ dir: this.currentDir ? `${this.currentDir}/${name}` : name });
		},

		/** 中断进行中的 loadDir，确保后续调用不被阻塞且旧响应被丢弃 */
		__cancelInFlight() {
			this.loading = false;
			++this.__loadGen;
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
			// 过滤超限文件
			const allowed = [];
			for (const file of files) {
				if (file.size > MAX_UPLOAD_SIZE) {
					this.notify.error(this.$t('files.fileTooLarge', { name: file.name }));
				} else {
					allowed.push(file);
				}
			}
			if (!allowed.length) return;

			// 检测重名
			const existingNames = new Set(this.entries.map((e) => e.name));
			const duplicates = [];
			const clean = [];
			for (const file of allowed) {
				if (existingNames.has(file.name)) {
					duplicates.push({ name: file.name, file, action: 'skip' });
				} else {
					clean.push(file);
				}
			}

			if (!duplicates.length) {
				this.filesStore.enqueueUploads(this.clawId, this.agentId, this.currentDir, clean);
				this.__watchUploadsForRefresh();
				return;
			}

			// 有重名，弹出对话框
			this.__pendingFiles = clean;
			this.duplicateItems = duplicates;
			this.duplicateOpen = true;
		},

		setAllDuplicateAction(action) {
			for (const d of this.duplicateItems) {
				d.action = action;
			}
		},

		onConfirmDuplicates() {
			const toUpload = [...this.__pendingFiles];
			this.__pendingFiles = null;
			const overwriteNames = [];
			for (const item of this.duplicateItems) {
				if (item.action === 'overwrite') {
					toUpload.push(item.file);
					overwriteNames.push(item.name);
				}
			}
			this.duplicateOpen = false;

			// 覆盖的文件中若有正在下载的，放弃整次上传
			if (overwriteNames.length) {
				const dlNames = new Set(
					this.downloadTasks
						.filter((t) => t.status === 'pending' || t.status === 'running')
						.map((t) => t.fileName),
				);
				if (overwriteNames.some((n) => dlNames.has(n))) {
					this.notify.warning(this.$t('files.uploadConflictDownloading'));
					return;
				}
			}

			if (toUpload.length) {
				this.filesStore.enqueueUploads(this.clawId, this.agentId, this.currentDir, toUpload);
				this.__watchUploadsForRefresh();
			}
		},

		/**
		 * 监听上传完成后自动刷新目录
		 */
		__watchUploadsForRefresh() {
			if (this.__refreshTimer) return; // 已有轮询在跑
			let prevCount = this.__activeUploadCount();
			const check = () => {
				this.__refreshTimer = null;
				if (this.__unmounted) return;
				const count = this.__activeUploadCount();
				if (count < prevCount) this.loadDir(); // 有任务完成，刷新目录
				prevCount = count;
				if (count) {
					this.__refreshTimer = setTimeout(check, 500);
				}
			};
			this.__refreshTimer = setTimeout(check, 500);
		},

		__activeUploadCount() {
			return this.filesStore.getActiveTasks(this.clawId, this.agentId, this.currentDir)
				.filter((t) => t.type === 'upload' && (t.status === 'pending' || t.status === 'running'))
				.length;
		},

		// --- 下载 ---

		onDownload(entry) {
			this.filesStore.enqueueDownload(
				this.clawId, this.agentId, this.currentDir,
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
				this.deleteFileChecked = false;
				this.deleteFileOpen = true;
			}
		},

		async onConfirmDeleteFile() {
			const clawConn = useClawConnections().get(this.clawId);
			if (!clawConn) return;
			this.deleting = true;
			try {
				await deleteFile(clawConn, this.agentId, this.__deleteFilePath);
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
			const clawConn = useClawConnections().get(this.clawId);
			if (!clawConn) return;
			this.deleting = true;
			try {
				await deleteFile(clawConn, this.agentId, this.__deleteDirPath, { force: true });
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
			const clawConn = useClawConnections().get(this.clawId);
			if (!clawConn) return;
			this.mkdirLoading = true;
			try {
				const path = this.currentDir ? `${this.currentDir}/${name}` : name;
				await mkdirFiles(clawConn, this.agentId, path);
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
