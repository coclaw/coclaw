import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { randomUUID } from 'node:crypto';

import { agentSessionsDir } from '../claw-paths.js';
import { atomicWriteJsonFile } from '../utils/atomic-write.js';
import { createMutex } from '../utils/mutex.js';
import { remoteLog } from '../remote-log.js';

const TOPICS_FILE = 'coclaw-topics.json';

function emptyStore() {
	return { version: 1, topics: [] };
}

/**
 * Topic 管理器：内存模型 + CRUD + 磁盘持久化。
 *
 * 每个 agentId 对应一份 coclaw-topics.json，按需懒加载到内存。
 * 写操作通过 mutex + atomicWriteJsonFile 保证一致性。
 */
export class TopicManager {
	/**
	 * @param {object} [opts]
	 * @param {object} [opts.logger]
	 * @param {Function} [opts.resolveSessionsDir] - 测试注入：自定义 sessions 目录解析
	 * @param {Function} [opts.readFile] - 测试注入
	 * @param {Function} [opts.writeJsonFile] - 测试注入
	 * @param {Function} [opts.unlinkFile] - 测试注入
	 * @param {Function} [opts.copyFile] - 测试注入
	 */
	constructor(opts = {}) {
		this.__resolveSessionsDir = opts.resolveSessionsDir ?? agentSessionsDir;
		this.__logger = opts.logger ?? console;
		this.__readFile = opts.readFile ?? fs.readFile;
		this.__writeJsonFile = opts.writeJsonFile ?? atomicWriteJsonFile;
		this.__unlinkFile = opts.unlinkFile ?? fs.unlink;
		this.__copyFile = opts.copyFile ?? fs.copyFile;
		// 内存缓存：agentId -> { version, topics[] }
		this.__cache = new Map();
		// 每个 agentId 一把锁
		this.__mutexes = new Map();
		// 进行中的 load Promise（防止并发 load 竞态）
		this.__loadingPromises = new Map();
	}

	__sessionsDir(agentId) {
		return this.__resolveSessionsDir(agentId);
	}

	__topicsFilePath(agentId) {
		return nodePath.join(this.__sessionsDir(agentId), TOPICS_FILE);
	}

	__mutex(agentId) {
		if (!this.__mutexes.has(agentId)) {
			this.__mutexes.set(agentId, createMutex());
		}
		return this.__mutexes.get(agentId);
	}

	/**
	 * 从磁盘加载指定 agent 的 topics 到内存（文件不存在时初始化空数据）。
	 * 若同一 agentId 的 load 已在进行中，复用同一 Promise，防止并发竞态。
	 * @param {string} agentId
	 */
	async load(agentId) {
		// 已加载 → 跳过
		if (this.__cache.has(agentId)) return;
		// 正在加载 → 复用
		const pending = this.__loadingPromises.get(agentId);
		if (pending) return pending;

		const p = this.__doLoad(agentId).finally(() => {
			this.__loadingPromises.delete(agentId);
		});
		this.__loadingPromises.set(agentId, p);
		return p;
	}

	async __doLoad(agentId) {
		const filePath = this.__topicsFilePath(agentId);
		try {
			const raw = await this.__readFile(filePath, 'utf8');
			const data = JSON.parse(raw);
			if (data && typeof data === 'object' && Array.isArray(data.topics)) {
				this.__cache.set(agentId, data);
				return;
			}
		} catch (err) {
			// ENOENT 是正常情况（首次启动）静默；其他错误有诊断价值打 remoteLog。
			if (err?.code !== 'ENOENT') {
				const fname = nodePath.basename(filePath);
				this.__logger.warn?.(
					`[coclaw] topics __doLoad read failed for ${fname}: ${String(err?.message ?? err)}`,
				);
				remoteLog(
					`topics.reload-error site=__doLoad file=${fname} msg=${String(err?.message ?? err)}`,
				);
			}
		}
		this.__cache.set(agentId, emptyStore());
	}

	__ensureLoaded(agentId) {
		if (!this.__cache.has(agentId)) {
			throw new Error(`TopicManager: agent "${agentId}" not loaded, call load() first`);
		}
	}

	__getStore(agentId) {
		this.__ensureLoaded(agentId);
		return this.__cache.get(agentId);
	}

	async __persist(agentId) {
		const store = this.__getStore(agentId);
		await this.__writeJsonFile(this.__topicsFilePath(agentId), store);
	}

	/**
	 * 创建新 Topic
	 * @param {{ agentId: string }} params
	 * @returns {Promise<{ topicId: string }>}
	 */
	async create({ agentId }) {
		const topicId = randomUUID();
		const record = {
			topicId,
			agentId,
			title: null,
			createdAt: Date.now(),
		};
		await this.__mutex(agentId).withLock(async () => {
			const store = this.__getStore(agentId);
			store.topics.unshift(record);
			await this.__persist(agentId);
		});
		return { topicId };
	}

	/**
	 * 获取指定 agent 的 Topic 列表（已按 createdAt 倒序）
	 * @param {{ agentId: string }} params
	 * @returns {{ topics: object[] }}
	 */
	list({ agentId }) {
		const store = this.__getStore(agentId);
		return { topics: store.topics };
	}

	/**
	 * 获取单个 Topic 元信息
	 * @param {{ topicId: string }} params
	 * @returns {{ topic: object | null }}
	 */
	get({ topicId }) {
		for (const [, store] of this.__cache) {
			const found = store.topics.find((t) => t.topicId === topicId);
			if (found) return { topic: found };
		}
		return { topic: null };
	}

	/**
	 * 更新 Topic 标题
	 * @param {{ topicId: string, title: string }} params
	 */
	async updateTitle({ topicId, title }) {
		// 查找 topic 所属 agentId
		let targetAgentId = null;
		for (const [agentId, store] of this.__cache) {
			if (store.topics.some((t) => t.topicId === topicId)) {
				targetAgentId = agentId;
				break;
			}
		}
		if (!targetAgentId) {
			throw new Error(`Topic not found: ${topicId}`);
		}
		await this.__mutex(targetAgentId).withLock(async () => {
			const store = this.__getStore(targetAgentId);
			const topic = store.topics.find((t) => t.topicId === topicId);
			if (!topic) throw new Error(`Topic not found: ${topicId}`);
			topic.title = title;
			await this.__persist(targetAgentId);
		});
	}

	/**
	 * 删除 Topic 及其 .jsonl 文件
	 * @param {{ topicId: string }} params
	 * @returns {Promise<{ ok: boolean }>}
	 */
	async delete({ topicId }) {
		let targetAgentId = null;
		for (const [agentId, store] of this.__cache) {
			if (store.topics.some((t) => t.topicId === topicId)) {
				targetAgentId = agentId;
				break;
			}
		}
		if (!targetAgentId) {
			return { ok: false };
		}
		await this.__mutex(targetAgentId).withLock(async () => {
			const store = this.__getStore(targetAgentId);
			const idx = store.topics.findIndex((t) => t.topicId === topicId);
			if (idx === -1) return;
			store.topics.splice(idx, 1);
			await this.__persist(targetAgentId);
		});
		// 删除 .jsonl（忽略不存在）
		const jsonlPath = nodePath.join(this.__sessionsDir(targetAgentId), `${topicId}.jsonl`);
		try {
			await this.__unlinkFile(jsonlPath);
		} catch (err) {
			if (err?.code !== 'ENOENT') throw err;
		}
		return { ok: true };
	}

	/**
	 * 复制 topic 的 .jsonl 为临时文件（用于标题生成）
	 * @param {{ agentId: string, topicId: string }} params
	 * @returns {Promise<{ tempId: string, tempPath: string }>}
	 */
	async copyTranscript({ agentId, topicId }) {
		const srcPath = nodePath.join(this.__sessionsDir(agentId), `${topicId}.jsonl`);
		const tempId = randomUUID();
		const tempPath = nodePath.join(this.__sessionsDir(agentId), `${tempId}.jsonl`);
		// fs.copyFile 非 atomic；崩在半路的临时 *.jsonl 可能被 session-manager 扫到列为幽灵会话，用户重试导出即恢复
		await this.__copyFile(srcPath, tempPath);
		return { tempId, tempPath };
	}

	/**
	 * 删除临时 .jsonl 文件
	 * @param {string} filePath
	 */
	async cleanupTempFile(filePath) {
		try {
			await this.__unlinkFile(filePath);
		} catch (err) {
			if (err?.code !== 'ENOENT') throw err;
		}
	}
}
