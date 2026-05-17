import fs from 'node:fs/promises';
import nodePath from 'node:path';

import { agentSessionsDir } from '../claw-paths.js';
import { atomicWriteJsonFile } from '../utils/atomic-write.js';
import { createMutex } from '../utils/mutex.js';

const HISTORY_FILE = 'coclaw-chat-history.json';

function emptyStore() {
	return { version: 1 };
}

/**
 * Chat History 管理器：追踪 chat（sessionKey）下的 session 流水。
 *
 * 每个 agentId 对应一份 coclaw-chat-history.json，按需懒加载到内存。
 * 写操作通过 mutex + atomicWriteJsonFile 保证一致性。
 *
 * 文件结构示例：
 * {
 *   "version": 1,
 *   "agent:main:main": [
 *     { "sessionId": "current-sid" },                       // 首位：未归档头 = 当前活跃 session
 *     { "sessionId": "older",    "archivedAt": 1742003000 } // 第二位起：已归档（新→旧）
 *   ]
 * }
 *
 * 双源事件供给：
 * - session_start hook：event 同时含新 sid (currentSessionId) + 旧 sid (archivedSessionId)
 * - sessions.changed reason=create：payload 含 sessionKey + 新 sid，旧 sid 从文件首位推断
 */
export class ChatHistoryManager {
	/**
	 * @param {object} [opts]
	 * @param {object} [opts.logger]
	 * @param {Function} [opts.resolveSessionsDir] - 测试注入：自定义 sessions 目录解析
	 * @param {Function} [opts.readFile] - 测试注入
	 * @param {Function} [opts.writeJsonFile] - 测试注入
	 */
	constructor(opts = {}) {
		this.__resolveSessionsDir = opts.resolveSessionsDir ?? agentSessionsDir;
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
		return this.__resolveSessionsDir(agentId);
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
		/* c8 ignore start -- recordSessionTransition/list 均先 __reloadFromDisk，此分支为防御性守卫 */
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
	 * 记录一次 session 转换。双源事件共用：
	 * - session_start hook：
	 *     currentSessionId = event.sessionId，
	 *     archivedSessionId = event.resumedFrom
	 * - sessions.changed reason=create：
	 *     currentSessionId = payload.sessionId，
	 *     archivedSessionId 不提供（从文件首位推断）
	 *
	 * 文件首位（list[0]）维护当前活跃 session（未归档），其后是已归档 item（新→旧）。
	 *
	 * 幂等：head 已是 currentSessionId 且
	 *   - 无 archivedSessionId，或
	 *   - archivedSessionId 已存在于 list 中
	 * 时整体 no-op（不写盘）。
	 *
	 * @param {{ agentId: string, sessionKey: string, currentSessionId: string, archivedSessionId?: string }} params
	 */
	async recordSessionTransition({ agentId, sessionKey, currentSessionId, archivedSessionId }) {
		if (!sessionKey || !currentSessionId) return;
		await this.__mutex(agentId).withLock(async () => {
			// 从磁盘重载确保最新状态：list() 无锁覆写 __cache 可能导致缓存过期
			await this.__reloadFromDisk(agentId);
			const store = this.__getStore(agentId);
			if (!Array.isArray(store[sessionKey])) {
				store[sessionKey] = [];
			}
			const list = store[sessionKey];
			const head = list[0];
			const headIsCurrent = head && !head.archivedAt && head.sessionId === currentSessionId;
			const archivedAlreadyInList = archivedSessionId
				&& list.some((it) => it.sessionId === archivedSessionId);
			// 完全 no-op：head 已是 current 且无新 archived 要追加
			if (headIsCurrent && (!archivedSessionId || archivedAlreadyInList)) return;

			// head 已是 current（双源到达：第二个事件提供了之前未带的 archivedSessionId）
			// → 不动 head，仅在第二位插入 archivedSessionId
			if (headIsCurrent) {
				list.splice(1, 0, { sessionId: archivedSessionId, archivedAt: Date.now() });
				await this.__persist(agentId);
				return;
			}

			// 一般路径：翻 head 为归档（若未归档），然后处理 archivedSessionId，最后头插新 head
			if (head && !head.archivedAt) {
				head.archivedAt = Date.now();
			}
			// archivedSessionId 与 head 不同且不在 list → 在第二位追加（保证不丢前任记录）
			if (archivedSessionId
				&& archivedSessionId !== head?.sessionId
				&& !list.some((it) => it.sessionId === archivedSessionId)) {
				list.splice(1, 0, { sessionId: archivedSessionId, archivedAt: Date.now() });
			}
			list.unshift({ sessionId: currentSessionId });
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
