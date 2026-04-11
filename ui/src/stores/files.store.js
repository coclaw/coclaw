import { defineStore } from 'pinia';

import { useClawConnections } from '../services/claw-connection-manager.js';
import { uploadFile, downloadFile } from '../services/file-transfer.js';
import { remoteLog } from '../services/remote-log.js';
import { saveBlobToFile } from '../utils/file-helper.js';

/**
 * 任务失败统一上报：高级别 console.error + remoteLog。
 * 用于覆盖 file-transfer.js 内部已 log 之外的失败路径
 * （例如 saveBlobToFile / Capacitor 权限错误 / 未识别的异常等），
 * 确保 UI 显示 failed 时一定有可定位的诊断日志。
 * @param {FileTask} task
 * @param {Error|object} err
 */
function logTaskFailure(task, err) {
	const code = err?.code ?? 'UNKNOWN';
	const message = err?.message ?? String(err);
	const path = task.dir ? `${task.dir}/${task.fileName}` : task.fileName;
	/* c8 ignore next -- ?? fallback for missing progress */
	const progress = (task.progress ?? 0).toFixed(3);
	const ctx = `type=${task.type} clawId=${task.clawId} agentId=${task.agentId} path=${path} size=${task.size} progress=${progress}`;
	remoteLog(`task.${task.type}.failed ${ctx} code=${code} err=${message}`);
	console.error(`[files.store] ${task.type} task failed: ${ctx} code=${code} err=${message}`, err);
}

/**
 * 文件 Store
 *
 * 1. 传输任务（upload/download）生命周期管理
 * 2. 目录列表 RAM 缓存——每个 (clawId, agentId) 缓存最近一次成功加载的目录
 */
export const useFilesStore = defineStore('files', {
	state: () => ({
		/** @type {Map<string, FileTask>} */
		tasks: new Map(),
		/** @type {Map<string, {currentDir: string, entries: object[]}>} key = clawId:agentId */
		dirCache: new Map(),
	}),
	getters: {
		/**
		 * 获取指定目录下的活跃任务（pending / running / failed）
		 * @returns {(clawId: string, agentId: string, dir: string) => FileTask[]}
		 */
		getActiveTasks: (state) => (clawId, agentId, dir) => {
			const result = [];
			for (const task of state.tasks.values()) {
				if (task.clawId === clawId && task.agentId === agentId && task.dir === dir
					&& (task.status === 'pending' || task.status === 'running' || task.status === 'failed')) {
					result.push(task);
				}
			}
			return result;
		},
		/**
		 * 获取指定 agent 的全部任务
		 * @returns {(clawId: string, agentId: string) => FileTask[]}
		 */
		getAgentTasks: (state) => (clawId, agentId) => {
			const result = [];
			for (const task of state.tasks.values()) {
				if (task.clawId === clawId && task.agentId === agentId) {
					result.push(task);
				}
			}
			return result;
		},
		/**
		 * 获取缓存的目录条目
		 * @returns {(clawId: string, agentId: string) => {currentDir: string, entries: object[]} | undefined}
		 */
		getCachedDir: (state) => (clawId, agentId) => {
			return state.dirCache.get(`${clawId}:${agentId}`);
		},
		/** 是否有进行中的传输任务 */
		busy: (state) => {
			for (const task of state.tasks.values()) {
				if (task.status === 'pending' || task.status === 'running') return true;
			}
			return false;
		},
	},
	actions: {
		/**
		 * 入队上传任务（已解决重名冲突后调用）
		 * @param {string} clawId
		 * @param {string} agentId
		 * @param {string} dir - 所在目录（相对 workspace）
		 * @param {File[]} files
		 */
		enqueueUploads(clawId, agentId, dir, files) {
			for (const file of files) {
				const task = createTask({
					type: 'upload',
					clawId, agentId, dir,
					fileName: file.name,
					size: file.size,
					file,
				});
				this.tasks.set(task.id, task);
			}
			this.__runUploadQueue(clawId, agentId);
		},

		/**
		 * 入队下载任务（同一 claw/agent 串行执行）
		 *
		 * 改为串行的原因：插件 pion-node 的 SCTP 缓冲区在多 DC 并行下载下会被无脑灌满，
		 * 应用层 backpressure 失效（详见 pion-node bufferedAmount 修复说明）。
		 * 串行后单个 DC 的实际带宽与 TURN 持平，避免 SCTP 拥塞导致 UI READY_TIMEOUT。
		 *
		 * @param {string} clawId
		 * @param {string} agentId
		 * @param {string} dir
		 * @param {string} fileName
		 * @param {number} size
		 */
		enqueueDownload(clawId, agentId, dir, fileName, size) {
			// 去重：同一文件已有 pending/running 的下载时忽略
			for (const t of this.tasks.values()) {
				if (t.type === 'download' && t.clawId === clawId && t.agentId === agentId
					&& t.dir === dir && t.fileName === fileName
					&& (t.status === 'pending' || t.status === 'running')) {
					return;
				}
			}
			const task = createTask({
				type: 'download',
				clawId, agentId, dir,
				fileName, size,
			});
			this.tasks.set(task.id, task);
			this.__runDownloadQueue(clawId, agentId);
		},

		/**
		 * 取消任务
		 * @param {string} taskId
		 */
		cancelTask(taskId) {
			const task = this.tasks.get(taskId);
			if (!task || (task.status !== 'pending' && task.status !== 'running')) return;
			if (task.status === 'running' && task.transferHandle) {
				task.transferHandle.cancel();
			}
			task.status = 'cancelled';
			task.transferHandle = null;
		},

		/**
		 * 重试失败任务
		 * @param {string} taskId
		 */
		retryTask(taskId) {
			const task = this.tasks.get(taskId);
			if (!task || task.status !== 'failed') return;
			task.status = 'pending';
			task.progress = 0;
			task.error = null;
			task.transferHandle = null;

			if (task.type === 'upload') {
				this.__runUploadQueue(task.clawId, task.agentId);
			} else {
				this.__runDownloadQueue(task.clawId, task.agentId);
			}
		},

		/**
		 * 清除已完成/已取消/已失败的任务
		 * @param {string} clawId
		 * @param {string} agentId
		 */
		clearFinished(clawId, agentId) {
			for (const [id, task] of this.tasks) {
				if (task.clawId === clawId && task.agentId === agentId
					&& (task.status === 'done' || task.status === 'cancelled' || task.status === 'failed')) {
					this.tasks.delete(id);
				}
			}
		},

		/**
		 * 更新目录缓存
		 * @param {string} clawId
		 * @param {string} agentId
		 * @param {string} currentDir
		 * @param {object[]} entries
		 */
		setDirCache(clawId, agentId, currentDir, entries) {
			this.dirCache.set(`${clawId}:${agentId}`, { currentDir, entries });
		},

		/**
		 * 清除指定 claw 的目录缓存
		 * @param {string} clawId
		 */
		clearDirCacheByClaw(clawId) {
			const prefix = `${clawId}:`;
			for (const key of this.dirCache.keys()) {
				if (key.startsWith(prefix)) this.dirCache.delete(key);
			}
		},

		// --- 内部方法 ---

		/**
		 * 串行执行上传队列：同一 (clawId, agentId) 下同时只有一个 running upload
		 */
		async __runUploadQueue(clawId, agentId) {
			// 检查是否已有 running 的上传
			for (const task of this.tasks.values()) {
				if (task.clawId === clawId && task.agentId === agentId
					&& task.type === 'upload' && task.status === 'running') {
					return; // 已有运行中的，等它完成后会继续取下一个
				}
			}

			// 取下一个 pending
			let next = null;
			for (const task of this.tasks.values()) {
				if (task.clawId === clawId && task.agentId === agentId
					&& task.type === 'upload' && task.status === 'pending') {
					next = task;
					break;
				}
			}
			if (!next) return;

			await this.__executeUpload(next);
			// 完成后继续取下一个
			this.__runUploadQueue(clawId, agentId);
		},

		/**
		 * 串行执行下载队列：同一 (clawId, agentId) 下同时只有一个 running download。
		 * 与 __runUploadQueue 对称——参见 enqueueDownload 的注释，串行是为避免
		 * 多 DC 并发下 SCTP 缓冲区拥塞导致 UI 端超时。
		 */
		async __runDownloadQueue(clawId, agentId) {
			// 检查是否已有 running 的下载
			for (const task of this.tasks.values()) {
				if (task.clawId === clawId && task.agentId === agentId
					&& task.type === 'download' && task.status === 'running') {
					return;
				}
			}

			// 取下一个 pending
			let next = null;
			for (const task of this.tasks.values()) {
				if (task.clawId === clawId && task.agentId === agentId
					&& task.type === 'download' && task.status === 'pending') {
					next = task;
					break;
				}
			}
			if (!next) return;

			await this.__executeDownload(next);
			// 完成后继续取下一个
			this.__runDownloadQueue(clawId, agentId);
		},

		/**
		 * 执行单个上传任务
		 * @param {FileTask} task
		 */
		async __executeUpload(task) {
			const clawConn = useClawConnections().get(task.clawId);
			if (!clawConn) {
				task.status = 'failed';
				task.error = 'Claw connection not available';
				logTaskFailure(task, { code: 'CLAW_NOT_AVAILABLE', message: task.error });
				return;
			}

			task.status = 'running';
			const path = task.dir ? `${task.dir}/${task.fileName}` : task.fileName;

			try {
				const handle = uploadFile(clawConn, task.agentId, path, task.file);
				task.transferHandle = handle;
				// 防御：handle 赋值前若被 cancelTask 取消，此处补偿
				if (task.status === 'cancelled') { handle.cancel(); return; }
				handle.onProgress = (sent, total) => {
					task.progress = total > 0 ? sent / total : 0;
				};
				await handle.promise;
				task.status = 'done';
				task.progress = 1;
				task.file = null; // 释放 File 引用
			} catch (err) {
				if (err?.code === 'CANCELLED') return; // cancelTask 已处理状态
				task.status = 'failed';
				task.error = err?.message ?? 'Upload failed';
				logTaskFailure(task, err);
			} finally {
				task.transferHandle = null;
			}
		},

		/**
		 * 执行单个下载任务
		 * @param {FileTask} task
		 */
		async __executeDownload(task) {
			const clawConn = useClawConnections().get(task.clawId);
			if (!clawConn) {
				task.status = 'failed';
				task.error = 'Claw connection not available';
				logTaskFailure(task, { code: 'CLAW_NOT_AVAILABLE', message: task.error });
				return;
			}

			task.status = 'running';
			const path = task.dir ? `${task.dir}/${task.fileName}` : task.fileName;

			// 区分"下载阶段"和"保存阶段"，分别上报便于排查
			let stage = 'download';
			try {
				const handle = downloadFile(clawConn, task.agentId, path);
				task.transferHandle = handle;
				if (task.status === 'cancelled') { handle.cancel(); return; }
				handle.onProgress = (received, total) => {
					task.progress = total > 0 ? received / total : 0;
				};
				const result = await handle.promise;
				task.progress = 1;
				stage = 'save';
				// 保存文件（Web 触发浏览器下载；Capacitor 调起系统分享）
				await saveBlobToFile(result.blob, result.name || task.fileName);
				task.status = 'done';
			} catch (err) {
				if (err?.code === 'CANCELLED') return;
				task.status = 'failed';
				task.error = err?.message ?? 'Download failed';
				// 标注失败阶段，方便排查"传输 OK 但保存失败"等场景
				const annotated = err instanceof Error
					? Object.assign(err, { code: err.code ?? `${stage.toUpperCase()}_FAILED` })
					: { code: err?.code ?? `${stage.toUpperCase()}_FAILED`, message: err?.message ?? String(err) };
				logTaskFailure(task, annotated);
			} finally {
				task.transferHandle = null;
			}
		},

	},
});

// --- 工具函数 ---

/**
 * 创建 task 对象
 * @param {Partial<FileTask>} overrides
 * @returns {FileTask}
 */
function createTask(overrides) {
	return {
		id: crypto.randomUUID(),
		type: 'upload',
		clawId: '',
		agentId: '',
		dir: '',
		fileName: '',
		status: 'pending',
		progress: 0,
		size: 0,
		error: null,
		file: null,
		transferHandle: null,
		createdAt: Date.now(),
		...overrides,
	};
}

/** @internal 仅供测试 */
export { createTask as __createTask };

/**
 * @typedef {object} FileTask
 * @property {string} id
 * @property {'upload' | 'download'} type
 * @property {string} clawId
 * @property {string} agentId
 * @property {string} dir - 所在目录（相对 workspace）
 * @property {string} fileName
 * @property {'pending' | 'running' | 'done' | 'failed' | 'cancelled'} status
 * @property {number} progress - 0~1
 * @property {number} size - 文件总大小（字节）
 * @property {string | null} error
 * @property {File | null} file - upload 时保留原始 File 引用（用于重试）
 * @property {import('../services/file-transfer.js').FileTransferHandle | null} transferHandle
 * @property {number} createdAt
 */
