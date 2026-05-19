import fs from 'node:fs/promises';
import nodePath from 'node:path';

import { agentSessionsDir } from '../claw-paths.js';
import { atomicWriteJsonFile } from '../utils/atomic-write.js';
import { createMutex } from '../utils/mutex.js';
import { remoteLog } from '../remote-log.js';

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
 * 文件结构示例（archivedAt 是 Date.now() 落的 13 位毫秒时间戳）：
 * {
 *   "version": 1,
 *   "agent:main:main": [
 *     { "sessionId": "current-sid" },                          // 首位：未归档头 = 当前活跃 session
 *     { "sessionId": "older",    "archivedAt": 1742003000000 } // 第二位起：已归档（新→旧）
 *   ]
 * }
 *
 * 详见 plugins/openclaw/docs/architecture.md
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
		} catch (err) {
			this.__reportLoadError(filePath, err, '__doLoad');
		}
		this.__cache.set(agentId, emptyStore());
	}

	/**
	 * 读盘失败分流：ENOENT 是正常情况（首次启动文件不存在）静默；
	 * 其他错误（权限、磁盘损坏、JSON 破损）有诊断价值，打 warn + remoteLog 标识可疑。
	 */
	__reportLoadError(filePath, err, callsite) {
		if (err?.code === 'ENOENT') return;
		const fname = nodePath.basename(filePath);
		this.__logger.warn?.(
			`[coclaw] chat-history ${callsite} read failed for ${fname}: ${String(err?.message ?? err)}`,
		);
		remoteLog(
			`chat-history.reload-error site=${callsite} file=${fname} msg=${String(err?.message ?? err)}`,
		);
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
		// 自愈守卫：list[1..]（非头位）若仍有未归档项视为脏数据（cron 顶替 / 旧版本写入 / 异常 race
		// 残留），强制补 archivedAt。放在 __persist 内是为了覆盖所有写盘路径——新增写入点自动受护。
		this.__sanitizeAllSessionKeys(store, agentId);
		await this.__writeJsonFile(this.__historyFilePath(agentId), store);
	}

	/**
	 * 遍历 store 内每个 sessionKey 的 list，把 `list[1..]` 中 `!archivedAt` 的项强制
	 * 写上 `archivedAt = Date.now()`。每修一条同时打本地 warn + remoteLog 暴露信号。
	 * @param {object} store
	 * @param {string} agentId
	 */
	__sanitizeAllSessionKeys(store, agentId) {
		if (!store || typeof store !== 'object') return;
		const now = Date.now();
		for (const [sessionKey, list] of Object.entries(store)) {
			if (!Array.isArray(list) || list.length <= 1) continue;
			for (let i = 1; i < list.length; i++) {
				const item = list[i];
				if (!item || typeof item !== 'object' || item.archivedAt) continue;
				item.archivedAt = now;
				this.__logger.warn?.(
					`[coclaw] chat-history sanitize: non-tail unarchived entry coerced sessionKey=${sessionKey} sid=${item.sessionId}`,
				);
				remoteLog(
					`chat-history.sanitize-coerce sessionKey=${sessionKey} sid=${item.sessionId} agentId=${agentId}`,
				);
			}
		}
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
		// 规范化：archivedSessionId 与 currentSessionId 相同属上游契约异常（resumedFrom 不应等于 sessionId），
		// 丢弃避免在空 list 起手时写出"同 sid 既是头又是归档"的双份记录。打 remoteLog 暴露信号
		// 让运维捕捉到上游可能的回归——只在真触发时打一次，正常路径噪声为零。
		if (archivedSessionId === currentSessionId) {
			remoteLog(`chat-history.archived-equals-current sessionKey=${sessionKey} sid=${currentSessionId}`);
			archivedSessionId = undefined;
		}
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

			// stale 事件防御：currentSessionId 已存在于 list 其他位置（即已被归档）。
			// 此时若继续走"翻 head"会把真正活跃的头错翻成归档，并让该 sid 在 list 中重复出现。
			// 触发场景：A→B→C 快速连续 reset 时，hook 与 sessions.changed 跨通道乱序到达，
			//   旧 transition 的事件晚于新 transition 的事件被处理。
			if (list.some((it) => it.sessionId === currentSessionId)) return;

			// 一般路径：翻 head 为归档（若未归档），然后处理 archivedSessionId，最后头插新 head
			// head 已归档（老格式磁盘数据 / 已正常归档的 list）→ 跳过翻动直接 unshift
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
	 * 启动期对账：把 sessions.json 当前 entries 喂进来，对每条调
	 * recordSessionTransition；现有幂等 + sanitize 自动吞重复。用于覆盖 plugin/gateway
	 * 重启窗口期 cron 顶替导致的漏归档（cron 不走 session_start hook、phase=message 走 DC 慢消费者
	 * 也可能 drop，对账兜底）。
	 *
	 * @param {string} agentId
	 * @param {{ sessionKey: string, sessionId: string }[]} entries
	 */
	async reconcileAll(agentId, entries) {
		if (!Array.isArray(entries)) return;
		for (const entry of entries) {
			if (!entry || typeof entry !== 'object') continue;
			await this.recordSessionTransition({
				agentId,
				sessionKey: entry.sessionKey,
				currentSessionId: entry.sessionId,
			});
		}
	}

	/**
	 * 获取指定 chat 的 session 列表（原始数组：首位可能是未归档的当前活跃 session）。
	 * 每次调用从磁盘重载，确保跨模块实例一致性
	 * （OpenClaw 的 hook 和 gateway method 可能在不同 ESM 模块实例中运行）。
	 *
	 * RPC 契约：`coclaw.chatHistory.list` 直接透传本返回值，不做服务端过滤；调用方
	 * （UI / 其它消费者）按 `archivedAt != null` 自行过滤未归档头与孤儿历史段。
	 *
	 * **返回值是 cache 引用，调用方禁止 mutate**（不要 splice / sort / 改 item 字段）；
	 * RPC handler 立刻 JSON 序列化所以无副作用，进程内消费者若需要修改请先 deep copy。
	 *
	 * @param {{ agentId: string, sessionKey: string }} params
	 * @returns {Promise<{ history: { sessionId: string, archivedAt?: number }[] }>}
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
		} catch (err) {
			this.__reportLoadError(filePath, err, '__reloadFromDisk');
		}
		if (!this.__cache.has(agentId)) {
			this.__cache.set(agentId, emptyStore());
		}
	}
}
