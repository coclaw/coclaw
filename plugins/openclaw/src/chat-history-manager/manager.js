import fs from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';

import { atomicWriteJsonFile } from '../utils/atomic-write.js';
import { createMutex } from '../utils/mutex.js';

const HISTORY_FILE = 'coclaw-chat-history.json';

function emptyStore() {
	return { version: 1 };
}

/**
 * Chat History 管理器：追踪 chat（sessionKey）因 reset 产生的孤儿 session。
 *
 * 每个 agentId 对应一份 coclaw-chat-history.json，按需懒加载到内存。
 * 写操作通过 mutex + atomicWriteJsonFile 保证一致性。
 *
 * 文件结构示例：
 * {
 *   "version": 1,
 *   "agent:main:main": [
 *     { "sessionId": "xxx", "archivedAt": 1742003000000 }
 *   ]
 * }
 */
export class ChatHistoryManager {
	/**
	 * @param {object} [opts]
	 * @param {string} [opts.rootDir] - agents 根目录，默认 ~/.openclaw/agents
	 * @param {object} [opts.logger]
	 * @param {Function} [opts.readFile] - 测试注入
	 * @param {Function} [opts.writeJsonFile] - 测试注入
	 */
	constructor(opts = {}) {
		this.__rootDir = opts.rootDir ?? nodePath.join(os.homedir(), '.openclaw', 'agents');
		this.__logger = opts.logger ?? console;
		/* c8 ignore next 2 -- ?? fallback：测试始终注入 */
		this.__readFile = opts.readFile ?? fs.readFile;
		this.__writeJsonFile = opts.writeJsonFile ?? atomicWriteJsonFile;
		// 内存缓存：agentId -> { version, [sessionKey]: [...] }
		this.__cache = new Map();
		// 每个 agentId 一把锁
		this.__mutexes = new Map();
		// 进行中的 load Promise（防止并发 load 竞态）
		this.__loadingPromises = new Map();
	}

	__sessionsDir(agentId) {
		return nodePath.join(this.__rootDir, agentId, 'sessions');
	}

	__historyFilePath(agentId) {
		return nodePath.join(this.__sessionsDir(agentId), HISTORY_FILE);
	}

	__mutex(agentId) {
		if (!this.__mutexes.has(agentId)) {
			this.__mutexes.set(agentId, createMutex());
		}
		return this.__mutexes.get(agentId);
	}

	/**
	 * 从磁盘加载指定 agent 的 chat history 到内存。
	 * @param {string} agentId
	 */
	async load(agentId) {
		if (this.__cache.has(agentId)) return;
		const pending = this.__loadingPromises.get(agentId);
		if (pending) return pending;

		const p = this.__doLoad(agentId).finally(() => {
			this.__loadingPromises.delete(agentId);
		});
		this.__loadingPromises.set(agentId, p);
		return p;
	}

	async __doLoad(agentId) {
		const filePath = this.__historyFilePath(agentId);
		try {
			const raw = await this.__readFile(filePath, 'utf8');
			const data = JSON.parse(raw);
			if (data && typeof data === 'object' && typeof data.version === 'number') {
				this.__cache.set(agentId, data);
				return;
			}
		} catch {
			// 文件不存在或解析失败，初始化空数据
		}
		this.__cache.set(agentId, emptyStore());
	}

	__ensureLoaded(agentId) {
		/* c8 ignore start -- recordArchived/list 均先 __reloadFromDisk，此分支为防御性守卫 */
		if (!this.__cache.has(agentId)) {
			throw new Error(`ChatHistoryManager: agent "${agentId}" not loaded, call load() first`);
		}
		/* c8 ignore stop */
	}

	__getStore(agentId) {
		this.__ensureLoaded(agentId);
		return this.__cache.get(agentId);
	}

	async __persist(agentId) {
		const store = this.__getStore(agentId);
		await this.__writeJsonFile(this.__historyFilePath(agentId), store);
	}

	/**
	 * 记录一个被抛弃的孤儿 session
	 * @param {{ agentId: string, sessionKey: string, sessionId: string }} params
	 */
	async recordArchived({ agentId, sessionKey, sessionId }) {
		if (!sessionKey || !sessionId) return;
		await this.__mutex(agentId).withLock(async () => {
			// 从磁盘重载确保最新状态：list() 无锁覆写 __cache 可能导致缓存过期
			await this.__reloadFromDisk(agentId);
			const store = this.__getStore(agentId);
			if (!Array.isArray(store[sessionKey])) {
				store[sessionKey] = [];
			}
			// 去重：同一 sessionId 不重复记录
			if (store[sessionKey].some((r) => r.sessionId === sessionId)) return;
			// 头部插入（最近的在前）
			store[sessionKey].unshift({
				sessionId,
				archivedAt: Date.now(),
			});
			await this.__persist(agentId);
		});
	}

	/**
	 * 获取指定 chat 的孤儿 session 列表。
	 * 每次调用从磁盘重载，确保跨模块实例一致性
	 * （OpenClaw 的 hook 和 gateway method 可能在不同 ESM 模块实例中运行）。
	 * @param {{ agentId: string, sessionKey: string }} params
	 * @returns {Promise<{ history: { sessionId: string, archivedAt: number }[] }>}
	 */
	async list({ agentId, sessionKey }) {
		await this.__reloadFromDisk(agentId);
		const store = this.__getStore(agentId);
		const history = Array.isArray(store[sessionKey]) ? store[sessionKey] : [];
		return { history };
	}

	/**
	 * 从磁盘重载指定 agent 的数据到内存（覆盖缓存）
	 * @param {string} agentId
	 */
	async __reloadFromDisk(agentId) {
		const filePath = this.__historyFilePath(agentId);
		try {
			const raw = await this.__readFile(filePath, 'utf8');
			const data = JSON.parse(raw);
			if (data && typeof data === 'object' && typeof data.version === 'number') {
				this.__cache.set(agentId, data);
				return;
			}
		} catch {
			// 文件不存在或解析失败
		}
		if (!this.__cache.has(agentId)) {
			this.__cache.set(agentId, emptyStore());
		}
	}
}
