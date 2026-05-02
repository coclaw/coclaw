/**
 * 纯内存版 FBQ-API 兼容容器
 *
 * 阶段 1 用作 RpcDcSender 的前置缓冲，替换原 `RpcSendQueue` 中的"容器层"职责（admission +
 * overflow 边沿状态机 + close 汇总）。阶段 2 再把本模块替换为 `FileBackedQueue`，因接口对齐，
 * 替换近乎一行 import 改动。
 *
 * 与 FBQ 的差异：
 * - 不引入 fs；`diskBytes / writtenBytes` 永为 0，`spilled / fsBroken` 永为 false
 * - admission 仅基于 `memBudget`；命中 `bypassAdmission(jsonStr)` 时即使队列满也接收（保留
 *   `RpcSendQueue` 的 agent run 白名单豁免行为）
 * - 内部携带 overflow-start/-end 边沿状态机和 close 汇总日志（搬自原 `RpcSendQueue`）
 *
 * 契约：`enqueue / __nextIter / destroy / clear` 内部任何分支都不得因 logger / remoteLog / onDrop /
 * bypassAdmission 自身抛而传染调用方——所有外部调用均经过 safe wrapper（try/catch）。
 *
 * 使用方式（消费侧）：
 * ```js
 * for await (const str of queue) { await sender.send(str); }
 * ```
 * 调用 `queue.destroy()` 后 iterator 在下一轮返回 `{ done: true }`。
 */

import { remoteLog } from '../remote-log.js';
import { createMutex } from './mutex.js';

/** 默认内存预算：与原 RpcSendQueue 的 MAX_QUEUE_BYTES 对齐 */
export const DEFAULT_MEM_BUDGET = 10 * 1024 * 1024;

const ID_RE = /^[A-Za-z0-9._-]+$/;

// 惰性压缩阈值（与 FBQ 一致）：head 越过 64 且占数组一半以上时切片回收
const COMPACT_HEAD_THRESHOLD = 64;

class MemoryQueue {
	/**
	 * @param {object} opts
	 * @param {string} opts.id - 队列标识（仅用于日志 tag/路径校验对齐 FBQ）
	 * @param {number} [opts.memBudget=10MB] - 内存软上限；queueBytes >= memBudget 且非 bypass 时新消息 drop
	 * @param {number} [opts.maxMessageBytes=Infinity] - 单条硬上限；超过即 drop（bypass 也不豁免）
	 * @param {(reason: string, size: number) => void} [opts.onDrop] - 拒入队回调
	 * @param {{ warn?: Function, info?: Function, error?: Function }} [opts.logger=console]
	 * @param {(jsonStr: string) => boolean} [opts.bypassAdmission] - 白名单谓词，命中则 admission 豁免
	 * @param {string} [opts.tag] - 日志前缀（如 connId），缺省不带
	 */
	constructor(opts) {
		const {
			id,
			memBudget = DEFAULT_MEM_BUDGET,
			maxMessageBytes = Infinity,
			onDrop,
			logger,
			bypassAdmission,
			tag,
		} = opts ?? {};

		if (!id || typeof id !== 'string') throw new TypeError('id is required');
		if (id === '.' || id === '..' || !ID_RE.test(id)) {
			throw new TypeError('id contains invalid characters');
		}
		if (!Number.isFinite(memBudget) || memBudget <= 0) {
			throw new TypeError('memBudget must be a finite positive number');
		}
		// Infinity 也合法；只挡 NaN / 非数字 / 非正数
		if (maxMessageBytes !== Infinity && (!Number.isFinite(maxMessageBytes) || maxMessageBytes <= 0)) {
			throw new TypeError('maxMessageBytes must be Infinity or a finite positive number');
		}

		this.id = id;
		this.memBudget = memBudget;
		this.maxMessageBytes = maxMessageBytes;
		this.onDrop = onDrop;
		this.logger = logger ?? console;
		this.bypassAdmission = typeof bypassAdmission === 'function' ? bypassAdmission : null;
		this.tag = tag ?? '';

		// 单文件 ring-ish 结构：head 指针 + 数组；shift 为 O(1) 摊销
		this.memQueue = [];
		this.head = 0;
		this.memBytes = 0;

		// 构造即可用：MemoryQueue 不碰 fs。`init()` 仍保留为 no-op-but-callable，便于
		// 阶段 2 替换为 FileBackedQueue 时调用方仅需在创建处加一行 `await queue.init()`。
		this.initialized = true;
		this.destroyed = false;
		this.waiters = [];
		this.mutex = createMutex();

		// drop 统计 + overflow 边沿状态机
		this.droppedCount = 0;
		this.droppedBytes = 0;
		this.queueOverflowActive = false;
	}

	/**
	 * 异步初始化（接口对齐 FBQ）。MemoryQueue 不碰 fs，构造时 initialized 已置 true，本函数为 no-op。
	 * 阶段 2 切到 FBQ 时此函数承担实际的残留清理。幂等。
	 */
	async init() {
		// 不持锁也无副作用；保留 await 与 mutex 交互结构是为了让阶段 2 切换 FBQ 时无需改外部时序
		return await this.mutex.withLock(async () => { /* no-op */ });
	}

	async [Symbol.asyncDispose]() {
		await this.destroy();
	}

	/**
	 * 入队一条字符串。
	 * - 队列满（memBytes >= memBudget）且未命中 bypassAdmission → onDrop + 返回 false
	 *   首次进入溢出态打 overflow-start（warn + remoteLog），持续期间静默累加
	 * - 否则入队 + 返回 true（包括"单条 overshoot"：当前 memBytes < memBudget，但本条很大）
	 *
	 * @param {string} jsonStr
	 * @returns {Promise<boolean>}
	 */
	async enqueue(jsonStr) {
		return await this.mutex.withLock(async () => {
			if (this.destroyed) return false;
			if (typeof jsonStr !== 'string') throw new TypeError('jsonStr must be a string');

			const size = Buffer.byteLength(jsonStr, 'utf8');

			// per-message 硬上限：bypass 也不豁免。对齐 sender 端 MAX_SINGLE_MSG_BYTES 检查，
			// 避免大帧先入队再被 sender 拒，导致 memBytes 异常膨胀（特别是 sender 阻塞期间）。
			if (size > this.maxMessageBytes) {
				this.droppedCount += 1;
				this.droppedBytes += size;
				this.__dispatchDrop('oversize', size);
				this.__safeWarn(`drop reason=oversize size=${size} cap=${this.maxMessageBytes}`);
				return false;
			}

			// admission：与原 RpcSendQueue 行为对齐——按当前已积压字节判断（不含本条 size），
			// 允许"单条 overshoot"：上一条消息把 queueBytes 顶到 < MAX 但 >= MAX 之间任一值时
			// 仍能入队；下一次再有非白名单消息才会被 drop。
			if (this.memBytes >= this.memBudget && !this.__isBypass(jsonStr)) {
				this.droppedCount += 1;
				this.droppedBytes += size;
				this.__dispatchDrop('queue-full', size);
				// 仅状态翻转点打 log，避免 DC 卡死时刷屏
				if (!this.queueOverflowActive) {
					this.queueOverflowActive = true;
					this.__safeWarn(`overflow-start queueBytes=${this.memBytes}`);
					this.__safeRemoteLog(`rpc-queue.overflow-start${this.__tagSuffix()} queueBytes=${this.memBytes}`);
				}
				return false;
			}

			this.memQueue.push(jsonStr);
			this.memBytes += size;
			this.__wakeOne();
			return true;
		});
	}

	/**
	 * 当前快照，用于诊断 dump。形态与 FBQ 对齐 + 阶段 1 私有诊断字段。
	 * @returns {{
	 *   memCount: number, memBytes: number, diskBytes: number, writtenBytes: number,
	 *   spilled: boolean, fsBroken: boolean,
	 *   droppedCount: number, droppedBytes: number, queueOverflowActive: boolean
	 * }}
	 */
	stats() {
		return {
			memCount: this.memQueue.length - this.head,
			memBytes: this.memBytes,
			diskBytes: 0,
			writtenBytes: 0,
			spilled: false,
			fsBroken: false,
			droppedCount: this.droppedCount,
			droppedBytes: this.droppedBytes,
			queueOverflowActive: this.queueOverflowActive,
		};
	}

	/**
	 * 清空数据但保留实例可用，重置 drop 统计与 overflow 状态。
	 */
	async clear() {
		return await this.mutex.withLock(async () => {
			if (this.destroyed) return;
			this.memQueue = [];
			this.head = 0;
			this.memBytes = 0;
			this.droppedCount = 0;
			this.droppedBytes = 0;
			this.queueOverflowActive = false;
		});
	}

	/**
	 * 关闭队列：唤醒所有 waiter（让 iterator 返回 done）、汇总 drop/residual log。幂等。
	 */
	async destroy() {
		return await this.mutex.withLock(async () => {
			if (this.destroyed) return;
			this.destroyed = true;

			const residual = this.memQueue.length - this.head;
			const residualBytes = this.memBytes;

			// 唤醒所有等待者，让它们在下一轮循环看到 destroyed 并返回 done
			const toWake = this.waiters.splice(0);
			for (const w of toWake) w.resolve();

			this.memQueue = [];
			this.head = 0;
			this.memBytes = 0;

			if (this.droppedCount > 0 || residual > 0) {
				this.__safeRemoteLog(
					`rpc-queue.close${this.__tagSuffix()} dropped=${this.droppedCount} droppedBytes=${this.droppedBytes} residualChunks=${residual} residualBytes=${residualBytes}`,
				);
			}
		});
	}

	[Symbol.asyncIterator]() {
		const self = this;
		return {
			next() { return self.__nextIter(); },
			return() { return Promise.resolve({ done: true, value: undefined }); },
			[Symbol.asyncIterator]() { return this; },
		};
	}

	async __nextIter() {
		while (true) {
			let waitPromise = null;
			const result = await this.mutex.withLock(async () => {
				if (this.memQueue.length - this.head > 0) {
					const item = this.memQueue[this.head];
					this.memQueue[this.head] = undefined;
					this.head += 1;
					this.memBytes -= Buffer.byteLength(item, 'utf8');

					// 惰性压缩：避免 head 一直向前、数组永不回收
					if (this.head > COMPACT_HEAD_THRESHOLD && this.head * 2 >= this.memQueue.length) {
						this.memQueue = this.memQueue.slice(this.head);
						this.head = 0;
					}

					// 满 → 未满 状态翻转：与 overflow-start 对称，含累计 dropped
					if (this.queueOverflowActive && this.memBytes < this.memBudget) {
						this.queueOverflowActive = false;
						this.__safeInfo(`overflow-end dropped=${this.droppedCount} droppedBytes=${this.droppedBytes}`);
						this.__safeRemoteLog(
							`rpc-queue.overflow-end${this.__tagSuffix()} dropped=${this.droppedCount} droppedBytes=${this.droppedBytes}`,
						);
					}
					return { value: item, done: false };
				}
				if (this.destroyed) return { done: true, value: undefined };
				waitPromise = new Promise((resolve, reject) => {
					this.waiters.push({ resolve, reject });
				});
				return null;
			});
			if (result !== null) return result;
			await waitPromise;
		}
	}

	__wakeOne() {
		if (this.waiters.length > 0) {
			const w = this.waiters.shift();
			w.resolve();
		}
	}

	__isBypass(jsonStr) {
		if (!this.bypassAdmission) return false;
		try {
			return Boolean(this.bypassAdmission(jsonStr));
		} catch {
			// bypass 谓词自身抛 → 视为非白名单（最安全的回退；保守 drop 而非误入队）
			return false;
		}
	}

	__dispatchDrop(reason, size) {
		try {
			this.onDrop?.(reason, size);
		} catch (err) {
			// onDrop 自身抛是调用方的 bug；不能传染给 enqueue 契约
			this.__safeWarn(`onDrop threw: ${err?.message}`);
		}
	}

	__tagSuffix() {
		return this.tag ? ` ${this.tag}` : '';
	}

	__safeWarn(msg) {
		try { this.logger.warn?.(`[rpc-queue${this.__tagSuffix()}] ${msg}`); } catch { /* logger 自身坏了也不能让 enqueue 抛 */ }
	}

	__safeInfo(msg) {
		try { this.logger.info?.(`[rpc-queue${this.__tagSuffix()}] ${msg}`); } catch { /* logger 自身坏了也不能让 enqueue/__nextIter 抛 */ }
	}

	__safeRemoteLog(text) {
		try { remoteLog(text); } catch { /* 防御性：remoteLog 当前同步路径不抛，未来若变化此 wrapper 兜底 */ }
	}
}

export { MemoryQueue };
