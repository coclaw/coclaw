/**
 * 纯内存版 FBQ-API 兼容容器
 *
 * 阶段 1 用作 RpcDcSender 的前置缓冲，与 `FileBackedQueue` 接口对齐。阶段 2 单点平替，
 * webrtc-peer 仅一行 `new` 改写。
 *
 * 与 FBQ 的差异：
 * - 不引入 fs；`diskBytes / writtenBytes` 永为 0，`spilled / fsBroken` 永为 false
 * - admission 仅基于 `memBudget`；命中 `bypassAdmission(jsonStr)` 时即使队列满也接收
 *
 * 容器纯净化（B-stage1）：本模块不承担诊断职责（边沿日志、累计、汇总），仅通过
 * `onDrop(reason, size)` 回调把丢弃事件外抛，由调用方（rpc-drop-monitor 等）统一
 * 处理日志输出。容器与诊断解耦后 MemoryQueue ≡ FBQ minus 磁盘语义。
 *
 * 契约：`enqueue / __nextIter / destroy / clear` 内部任何分支都不得因 onDrop /
 * bypassAdmission 自身抛而传染调用方——所有外部回调均经过 try/catch 包裹。
 *
 * 使用方式（消费侧）：
 * ```js
 * for await (const str of queue) { await sender.send(str); }
 * ```
 * 调用 `queue.destroy()` 后 iterator 在下一轮返回 `{ done: true }`。
 */

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
	 * - destroyed → 直接返回 false（**silent 短路**，**不触发 onDrop**）。设计意图：destroyed
	 *   意味着对应连接已死/正在清理，丢弃是正确清理副作用，不需要 noisy 日志。loud-on-loss
	 *   红线只对"连接活着但拒收"场景生效（oversize / queue-full）。
	 * - 单条 size > maxMessageBytes（bypass 也不豁免）→ onDrop('oversize', size) + 返回 false
	 * - 队列满（memBytes >= memBudget）且未命中 bypassAdmission → onDrop('queue-full', size) + 返回 false
	 * - 否则入队 + 返回 true（包括"单条 overshoot"：当前 memBytes < memBudget，但本条很大）
	 *
	 * 不输出任何日志/累计：诊断职责由调用方注入的 onDrop 处理。
	 *
	 * @param {string} jsonStr
	 * @returns {Promise<boolean>}
	 */
	async enqueue(jsonStr) {
		return await this.mutex.withLock(async () => {
			// destroyed 短路：silent，不调 onDrop。详见上方 JSDoc。
			if (this.destroyed) return false;
			if (typeof jsonStr !== 'string') throw new TypeError('jsonStr must be a string');

			const size = Buffer.byteLength(jsonStr, 'utf8');

			// per-message 硬上限：bypass 也不豁免。对齐 sender 端 MAX_SINGLE_MSG_BYTES 检查，
			// 避免大帧先入队再被 sender 拒，导致 memBytes 异常膨胀（特别是 sender 阻塞期间）。
			if (size > this.maxMessageBytes) {
				this.__dispatchDrop('oversize', size);
				return false;
			}

			// admission：与原 RpcSendQueue 行为对齐——按当前已积压字节判断（不含本条 size），
			// 允许"单条 overshoot"：上一条消息把 queueBytes 顶到 < MAX 但 >= MAX 之间任一值时
			// 仍能入队；下一次再有非白名单消息才会被 drop。
			if (this.memBytes >= this.memBudget && !this.__isBypass(jsonStr)) {
				this.__dispatchDrop('queue-full', size);
				return false;
			}

			this.memQueue.push(jsonStr);
			this.memBytes += size;
			this.__wakeOne();
			return true;
		});
	}

	/**
	 * 当前快照，用于诊断 dump。形态与 FBQ 完全对齐（6 字段）。
	 * @returns {{
	 *   memCount: number, memBytes: number, diskBytes: number, writtenBytes: number,
	 *   spilled: boolean, fsBroken: boolean
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
		};
	}

	/**
	 * 清空数据但保留实例可用。
	 */
	async clear() {
		return await this.mutex.withLock(async () => {
			if (this.destroyed) return;
			this.memQueue = [];
			this.head = 0;
			this.memBytes = 0;
		});
	}

	/**
	 * 关闭队列：唤醒所有 waiter（让 iterator 返回 done）。幂等。
	 * 不输出汇总日志：close 汇总职责由调用方注入的 monitor.summarize 处理。
	 *
	 * @param {(residual: { memCount: number, memBytes: number, diskBytes: number, writtenBytes: number, spilled: boolean, fsBroken: boolean }) => void} [onBeforeClear]
	 *   可选回调（**必须为同步函数**）：在 mutex 内、清空 memQueue **之前**触发，参数是销毁时刻的残留快照。
	 *   存在意义：mutex 保证 in-flight enqueue 已落地（broadcast 是 fire-and-forget），调用方
	 *   sync 调 `queue.stats()` 读不到 in-flight 入队的消息；改用此回调可拿到原子准确的残留快照。
	 *   回调同步抛错被 swallow，不影响 destroy 完成。
	 *   **注意**：返回 Promise 的异步回调其 rejection 不会被捕获——仅设计为 sync 钩子。
	 */
	async destroy(onBeforeClear) {
		return await this.mutex.withLock(async () => {
			if (this.destroyed) return;
			this.destroyed = true;

			// 在 mutex 内、清空之前快照残留：保证看到所有已入队的消息（含 in-flight）
			if (typeof onBeforeClear === 'function') {
				const residual = {
					memCount: this.memQueue.length - this.head,
					memBytes: this.memBytes,
					diskBytes: 0,
					writtenBytes: 0,
					spilled: false,
					fsBroken: false,
				};
				try { onBeforeClear(residual); }
				catch { /* 回调自身抛是调用方的 bug；不能传染给 destroy 契约 */ }
			}

			// 唤醒所有等待者，让它们在下一轮循环看到 destroyed 并返回 done
			const toWake = this.waiters.splice(0);
			for (const w of toWake) w.resolve();

			this.memQueue = [];
			this.head = 0;
			this.memBytes = 0;
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
}

export { MemoryQueue };
