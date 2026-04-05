import { defineStore } from 'pinia';

import { useClawConnections } from '../services/claw-connection-manager.js';
import { uploadFile, downloadFile } from '../services/file-transfer.js';

/**
 * 文件传输任务 Store
 *
 * 管理上传/下载任务的生命周期。
 * 目录浏览状态由 FileManagerPage 组件自行管理（局部 UI 状态）。
 */
export const useFilesStore = defineStore('files', {
	state: () => ({
		/** @type {Map<string, FileTask>} */
		tasks: new Map(),
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
		 * 入队下载任务（并行执行）
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
			this.__executeDownload(task);
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
				this.__executeDownload(task);
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
		 * 执行单个上传任务
		 * @param {FileTask} task
		 */
		async __executeUpload(task) {
			const clawConn = useClawConnections().get(task.clawId);
			if (!clawConn) {
				task.status = 'failed';
				task.error = 'Claw connection not available';
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
				return;
			}

			task.status = 'running';
			const path = task.dir ? `${task.dir}/${task.fileName}` : task.fileName;

			try {
				const handle = downloadFile(clawConn, task.agentId, path);
				task.transferHandle = handle;
				if (task.status === 'cancelled') { handle.cancel(); return; }
				handle.onProgress = (received, total) => {
					task.progress = total > 0 ? received / total : 0;
				};
				const result = await handle.promise;
				task.status = 'done';
				task.progress = 1;
				// 触发浏览器下载
				triggerBrowserDownload(result.blob, result.name || task.fileName);
			} catch (err) {
				if (err?.code === 'CANCELLED') return;
				task.status = 'failed';
				task.error = err?.message ?? 'Download failed';
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

/**
 * 触发浏览器下载
 * @param {Blob} blob
 * @param {string} fileName
 */
function triggerBrowserDownload(blob, fileName) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = fileName;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	// 延迟释放，确保浏览器有足够时间发起下载
	setTimeout(() => URL.revokeObjectURL(url), 200);
}

/** @internal 仅供测试 */
export { createTask as __createTask, triggerBrowserDownload as __triggerBrowserDownload };

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
