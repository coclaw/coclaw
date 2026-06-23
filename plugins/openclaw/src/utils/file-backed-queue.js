/**
 * 文件回退队列：内存优先，超过预算后追加写入 JSONL 文件。
 * 业务无关纯工具：存储任意字符串（调用方需保证不含裸 `\n`，否则行分隔语义被破坏）。
 *
 * 行为约定详见 docs/rpc-dc-file-queue.md。
 * - FIFO、单一生产者／消费者；多消费者时每条只交付给其中一个。
 * - 构造纯字段初始化，不碰 FS；使用前需 `await q.init()`。
 * - 消费侧：`for await (const item of queue) { ... }`；`destroy()` 让迭代结束。
 * - FS 异常下进入 `fsBroken` 粘性降级：mem 路径继续工作，溢出消息 drop；
 *   命中 bypassAdmission 的白名单消息允许 mem 桶 overshoot（与 MemoryQueue 镜像，保白名单不被误报 fs-error）。
 */

import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import nodePath from 'node:path';
import readline from 'node:readline';

import { createMutex } from './mutex.js';

const DEFAULT_MEM_BUDGET = 8 * 1024 * 1024;
const DEFAULT_DISK_CAP = 1024 * 1024 * 1024;

// id 字符集：UUID / 字母数字 / 点 / 下划线 / 减号，且不能是 "." 或 ".."
const ID_RE = /^[A-Za-z0-9._-]+$/;

// 压缩阈值：head 越过 64 且占 memQueue 一半以上时切片回收
const COMPACT_HEAD_THRESHOLD = 64;

class FileBackedQueue {
	/**
	 * @param {object} opts
	 * @param {string} opts.dir - 队列文件根目录
	 * @param {string} opts.id - 队列标识，字符集受限，防路径穿越
	 * @param {number} [opts.memBudget=8MB] - mem 桶阈值（按 current ≥ threshold 判定，允许 single overshoot）
	 * @param {number} [opts.diskCap=1GB] - mem + 已写文件累计字节总占用阈值（含 `\n`）；按 current ≥ threshold + single overshoot；非文件 size 硬上限
	 * @param {number} [opts.maxMessageBytes=Infinity] - 单条硬上限；超过即 drop（bypass 也不豁免）
	 * @param {(reason: string, size: number, err?: Error|object) => void} [opts.onDrop] - 拒入队时的回调；'fs-error' 第三参传底层 err；'disk-cap' 第三参传 { memBytes, writtenBytes, diskCap } 分量；其它 reason 第三参为 undefined
	 * @param {() => void} [opts.onSpillStart] - 文件创建（spilled false→true）回调，边沿触发
	 * @param {(drainedBytes: number) => void} [opts.onSpillEnd] - 文件 drain 删除（spilled true→false）回调，边沿触发；故障删档不触发
	 * @param {{ warn?: Function, info?: Function, error?: Function }} [opts.logger=console]
	 * @param {(jsonStr: string) => boolean} [opts.bypassAdmission] - 白名单谓词，命中则容量层 admission 豁免（与 MemoryQueue 同义）
	 */
	constructor(opts) {
		const {
			dir,
			id,
			memBudget = DEFAULT_MEM_BUDGET,
			diskCap = DEFAULT_DISK_CAP,
			maxMessageBytes = Infinity,
			onDrop,
			onSpillStart,
			onSpillEnd,
			logger = console,
			bypassAdmission,
		} = opts ?? {};

		if (!dir || typeof dir !== 'string') throw new TypeError('dir is required');
		if (!id || typeof id !== 'string') throw new TypeError('id is required');
		if (id === '.' || id === '..' || !ID_RE.test(id)) {
			throw new TypeError('id contains invalid characters');
		}
		// 基础设施 fail-fast：容量参数必须是有限正数，避免 NaN/Infinity/非数字绕过 admission。
		// NaN 与任何数比较皆为 false → admission 永远通过 → diskCap 变相失效。
		if (!Number.isFinite(memBudget) || memBudget <= 0) {
			throw new TypeError('memBudget must be a finite positive number');
		}
		if (!Number.isFinite(diskCap) || diskCap <= 0) {
			throw new TypeError('diskCap must be a finite positive number');
		}
		if (maxMessageBytes !== Infinity && (!Number.isFinite(maxMessageBytes) || maxMessageBytes <= 0)) {
			throw new TypeError('maxMessageBytes must be Infinity or a finite positive number');
		}

		this.dir = dir;
		this.id = id;
		this.memBudget = memBudget;
		this.diskCap = diskCap;
		this.maxMessageBytes = maxMessageBytes;
		this.onDrop = onDrop;
		this.onSpillStart = onSpillStart;
		this.onSpillEnd = onSpillEnd;
		this.logger = logger;
		// 非函数（含 undefined / null / 字符串等）一律收编为 null，保持向后兼容
		this.bypassAdmission = typeof bypassAdmission === 'function' ? bypassAdmission : null;

		this.filePath = nodePath.join(dir, `${id}.jsonl`);

		// 单文件 ring-ish 结构：head 指针 + 数组；shift 为 O(1) 摊销
		this.memQueue = [];
		this.head = 0;
		this.memBytes = 0;
		this.writtenBytes = 0;    // 已写入文件的累计字节（含 \n）
		this.readOffset = 0;      // 下次 refill 的起始偏移
		this.spilled = false;
		this.initialized = false;
		this.destroyed = false;
		this.fsBroken = false;    // 粘性：一旦 FS 出错，不再尝试 reopen
		this.writeStream = null;
		this.writeErr = null;
		// 粘性最新 fs 错误：__handleFsError 在 mutex 内缓存；后续走 fsBroken 短路的 enqueue 通过
		// __dispatchDrop 第三参把 err 透传给 onDrop，让 monitor / 运维拿到具体 errno
		this.lastFsErr = null;
		this.waiters = [];
		this.mutex = createMutex();
	}

	/**
	 * 派生的未消费磁盘字节数（含 \n），用于 admission 与 stats。
	 */
	get diskBytes() {
		return this.writtenBytes - this.readOffset;
	}

	/**
	 * 异步初始化：清理残留文件，标记可用。幂等。
	 */
	async init() {
		return await this.mutex.withLock(async () => {
			if (this.destroyed) return;
			if (this.initialized) return;
			try {
				await fs.rm(this.filePath, { force: true });
			} catch (err) {
				// best-effort：init 的 rm 可能因 ENOTDIR / EACCES 等失败。
				// 权威残留清理在 __openWriteStream 中（首次 spill 前）再做一次，
				// 确保不会用 'a' flag 追加到旧数据上污染 FIFO。
				this.logger?.warn?.('fbq.init rm warning', err);
			}
			this.initialized = true;
		});
	}

	async [Symbol.asyncDispose]() {
		await this.destroy();
	}

	/**
	 * 入队一条字符串。
	 * @param {string} jsonStr
	 * @returns {Promise<boolean>} accepted（true）/ dropped（false）
	 */
	async enqueue(jsonStr) {
		return await this.mutex.withLock(async () => {
			if (this.destroyed) return false;
			if (!this.initialized) throw new TypeError('queue not initialized');
			if (typeof jsonStr !== 'string') throw new TypeError('jsonStr must be a string');

			const size = Buffer.byteLength(jsonStr, 'utf8');

			// per-message 硬上限：bypass 也不豁免（红线 3：bypass 仅豁免容量层 admission）。
			// 与 sender 端 MAX_SINGLE_MSG_BYTES 检查对齐——避免大帧先入队再被 sender 拒，
			// 导致 backlog 异常膨胀且 oversize 不进 monitor 账（loud-on-loss）。
			if (size > this.maxMessageBytes) {
				this.__dispatchDrop('oversize', size);
				return false;
			}

			// bypass 谓词懒求值缓存：仅 admission / fsBroken overshoot 路径需要时才调用，整次 enqueue 内最多一次。
			// 容量充裕路径（不超 diskCap 且 mem 装得下）完全不调谓词——保留原短路语义、避免每条消息都解析 JSON。
			let isBypass; // undefined = 未求值；?= 后变 true / false 即缓存命中
			const getIsBypass = () => isBypass ??= this.__isBypass(jsonStr);

			// admission：与 MemoryQueue 一致——按 current ≥ threshold 判定，允许 single overshoot。
			// diskCap 语义：mem + 已写文件累计字节（writtenBytes 不减 readOffset，文件前缀已读但未
			// __dropFile 回收前仍计入）的总占用阈值；不是单纯文件 size 上限，所以文件实际峰值约为
			// diskCap - memBudget。允许 single overshoot：当前总占用 < diskCap 时再大的一条都收，
			// 下一条才会 drop——与 MemoryQueue 单条 overshoot 行为对齐，简化两实现的语义分叉。
			// bypass 命中时容量层豁免（红线 3）：白名单消息越过 diskCap 入队，物理 IO 失败仍按 fs-error drop。
			// fsBroken 守卫：粘性降级后 spill 永远不可用、writtenBytes 已重置为 0；mem 桶可能因
			// 持续 bypass overshoot 推过 diskCap，但此时再来的非 bypass 消息根因是 fs 已坏（而非"容量"），
			// 必须让下面的 fsBroken 短路赢、报 fs-error 带 lastFsErr，运维才能看到正确的诊断信号。
			if (!this.fsBroken && this.memBytes + this.writtenBytes >= this.diskCap && !getIsBypass()) {
				// 第三参传分量，让监视器在 disk-cap-start log 里把 mem / written / cap 都展开
				this.__dispatchDrop('disk-cap', size, {
					memBytes: this.memBytes,
					writtenBytes: this.writtenBytes,
					diskCap: this.diskCap,
				});
				return false;
			}

			// 内存路径：与 MemoryQueue 一致——memBytes < memBudget 即接受（含 single overshoot）
			if (!this.spilled) {
				const memFits = this.memBytes < this.memBudget;
				// fsBroken 降级模式：spill 不可用 → mem 桶就是事实上的容量层。
				// 此时 bypass 命中允许 overshoot（与 MemoryQueue 镜像），保白名单消息不被误报 fs-error。
				// 健康路径下 mem 满仍走 spill（不在此处豁免），避免 mem 无界增长违背 spill 设计目标。
				//
				// 设计取舍：fsBroken + bypass 路径下 mem 桶**不再**有显式硬上限——bypass 已豁免 diskCap admission，
				// 这里也豁免 memBudget。理论上同时持续 fsBroken + 高密度 bypass 命中可堆到 OOM，仅靠 maxMessageBytes
				// 单条 50 MB 兜底。**有意识的接受**：业务侧 agent 响应流量由用户活动自然封顶（与"不做 OOM 防御性
				// 检测"项目原则一致）；后续诊断完整性由 monitor.summarize 在 close 时透传 residualStats.fsBroken
				// 让运维侧拿到降级信号即可。请勿在 review 中把"无硬上限"当 P1 误报。
				const bypassOvershoot = !memFits && this.fsBroken && getIsBypass();
				if (memFits || bypassOvershoot) {
					this.memQueue.push(jsonStr);
					this.memBytes += size;
					this.__wakeOne();
					return true;
				}
			}

			// 溢出路径：FS 已破直接 drop，不再尝试 reopen。lastFsErr 由 __handleFsError 已粘性置好，
			// 把它透传给 onDrop 第三参——红线 2 "丢失/延迟必须 loud 可观测" 要求把 errno 抬出去
			if (this.fsBroken) {
				this.__dispatchDrop('fs-error', size, this.lastFsErr);
				return false;
			}

			if (!this.spilled) {
				await this.__openWriteStream();
				if (this.writeErr) {
					const err = this.writeErr;
					this.__dispatchDrop('fs-error', size, err);
					// 前置 mkdir/rm 失败也进入粘性降级：与 stream 'error' 路径语义一致，
					// 避免后续每次 overflow 都重试同一个持续性 FS 故障。
					await this.__handleFsError(err);
					return false;
				}
				this.spilled = true;
				// 文件层翻转 false→true：边沿信号，让监视器记录"开始用磁盘"
				this.__dispatchSpillStart();
			}

			try {
				await this.__writeLine(jsonStr + '\n');
				this.writtenBytes += size + 1;
				this.__wakeOne();
				return true;
			} catch (err) {
				this.logger?.warn?.('fbq.enqueue fs-error', err);
				this.__dispatchDrop('fs-error', size, err);
				// 直接在当前锁内触发粘性降级：真实 Node stream 下 cb err 通常也会 emit 'error'
				// （监听器会另外排一次 handleFsError，但 fsBroken 已置 → no-op）；测试里的 monkey-patch
				// 只触发 cb、不发 'error'，这里主动降级保证行为一致。
				await this.__handleFsError(err);
				return false;
			}
		});
	}

	/**
	 * @returns {{ memCount: number, memBytes: number, diskBytes: number, writtenBytes: number, spilled: boolean, fsBroken: boolean }}
	 *   - diskBytes：未消费 backlog（writtenBytes - readOffset）
	 *   - writtenBytes：本次生命周期累计已写字节（admission 依据的物理占用），drain 或 FS 降级后重置为 0
	 */
	stats() {
		return {
			memCount: this.memQueue.length - this.head,
			memBytes: this.memBytes,
			diskBytes: this.diskBytes,
			writtenBytes: this.writtenBytes,
			spilled: this.spilled,
			fsBroken: this.fsBroken,
		};
	}

	/**
	 * 清空数据但保留实例可用；显式清 fsBroken，允许再次尝试落盘。
	 */
	async clear() {
		return await this.mutex.withLock(async () => {
			if (this.destroyed) return;
			// 与 __dropFile 对称：在重置 spilled 前抓快照，wasSpilled 时配对调 onSpillEnd，
			// 让监视器 spillActive 复位；否则下一轮真实 spill-start 会被监视器幂等吞掉
			const drainedBytes = this.writtenBytes;
			const wasSpilled = this.spilled;
			await this.__closeWriteStream();
			try {
				await fs.rm(this.filePath, { force: true });
			} catch (err) {
				/* c8 ignore next 2 -- rm with force rarely fails */
				this.logger?.warn?.('fbq.clear rm error', err);
			}
			this.memQueue = [];
			this.head = 0;
			this.memBytes = 0;
			this.writtenBytes = 0;
			this.readOffset = 0;
			this.spilled = false;
			this.fsBroken = false;
			this.writeErr = null;
			this.lastFsErr = null;
			if (wasSpilled) this.__dispatchSpillEnd(drainedBytes);
		});
	}

	/**
	 * 停写、关 FD、删文件、结束所有迭代器。幂等。
	 *
	 * @param {(residual: { memCount: number, memBytes: number, diskBytes: number, writtenBytes: number, spilled: boolean, fsBroken: boolean }) => void} [onBeforeClear]
	 *   可选回调（**必须为同步函数**）：在 mutex 内、清空字段 / 关流 / 删文件**之前**触发，
	 *   参数是销毁时刻的 6 字段残留快照。存在意义：mutex 保证 in-flight enqueue 已落地；调用方
	 *   sync 调 `queue.stats()` 看不到 in-flight 入队的消息，改用此回调可拿原子准确的残留快照。
	 *   回调同步抛错被 swallow，不影响 destroy 完成。
	 *   **注意**：返回 Promise 的异步回调其 rejection 不会被捕获——仅设计为 sync 钩子（与 MemoryQueue 一致）。
	 */
	async destroy(onBeforeClear) {
		return await this.mutex.withLock(async () => {
			if (this.destroyed) return;
			this.destroyed = true;

			// 在 mutex 内、清空 / 关流 / 删文件之前快照 6 字段残留：mutex 保证看到所有已入队的消息（含 in-flight）；
			// 异步 IO 清理（__closeWriteStream / fs.rm）会改 spilled/writtenBytes，所以快照必须先抓
			if (typeof onBeforeClear === 'function') {
				const residual = this.stats();
				try { onBeforeClear(residual); }
				catch { /* 回调自身抛是调用方的 bug；不能传染给 destroy 契约（与 MemoryQueue silent gotcha 镜像）*/ }
			}

			// 唤醒所有等待者，让它们在下一轮循环中看到 destroyed 并返回 done
			const toWake = this.waiters.splice(0);
			for (const w of toWake) w.resolve();

			await this.__closeWriteStream();
			try {
				await fs.rm(this.filePath, { force: true });
			} catch (err) {
				/* c8 ignore next 2 -- rm with force rarely fails */
				this.logger?.warn?.('fbq.destroy rm error', err);
			}

			this.memQueue = [];
			this.head = 0;
			this.memBytes = 0;
			this.writtenBytes = 0;
			this.readOffset = 0;
			this.spilled = false;
			this.lastFsErr = null;
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
				const pendingCount = this.memQueue.length - this.head;
				if (pendingCount === 0 && this.spilled && !this.destroyed) {
					await this.__refillImpl();
				}
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

	__wakeAll() {
		const toWake = this.waiters.splice(0);
		for (const w of toWake) w.resolve();
	}

	// 与 MemoryQueue 一致：诊断职责完全交给注入的 onDrop（监视器做边沿去抖 + 状态翻转 log）
	__dispatchDrop(reason, size, err) {
		try {
			this.onDrop?.(reason, size, err);
		} catch (cbErr) {
			/* c8 ignore next 2 -- onDrop throwing is caller's bug */
			this.logger?.warn?.('fbq.onDrop threw', cbErr);
		}
	}

	__dispatchSpillStart() {
		try { this.onSpillStart?.(); }
		catch (cbErr) {
			/* c8 ignore next 2 -- onSpillStart throwing is caller's bug */
			this.logger?.warn?.('fbq.onSpillStart threw', cbErr);
		}
	}

	__dispatchSpillEnd(drainedBytes) {
		try { this.onSpillEnd?.(drainedBytes); }
		catch (cbErr) {
			/* c8 ignore next 2 -- onSpillEnd throwing is caller's bug */
			this.logger?.warn?.('fbq.onSpillEnd threw', cbErr);
		}
	}

	__isBypass(jsonStr) {
		if (!this.bypassAdmission) return false;
		try {
			return Boolean(this.bypassAdmission(jsonStr));
		} catch {
			// 谓词自身抛 → 视为非白名单（最安全的回退；保守 drop 而非误入队）
			return false;
		}
	}

	async __openWriteStream() {
		this.writeErr = null;
		try {
			// 目录 0o700 / 文件 0o600：POSIX best-effort。
			// - 新建目录/文件会按此 mode（再经 umask）创建
			// - 已存在的目录 mkdir(recursive) 不会被 chmod 收紧，以该目录原权限为准
			// - Windows 下 mode 参数语义很弱（无 owner/group/other 概念），实际访问控制依赖父目录 NTFS ACL
			// 仍比默认 0o644 更保守；atomic-write.js 也是同一策略。
			await fs.mkdir(nodePath.dirname(this.filePath), { recursive: true, mode: 0o700 });
			// 权威残留清理：即便 init 的 rm 被吞掉，这里开流前再 rm 一次，
			// 避免 'a' flag 追加到旧数据上污染 FIFO。
			await fs.rm(this.filePath, { force: true });
		} catch (err) {
			this.writeErr = err;
			return;
		}
		this.writeStream = createWriteStream(this.filePath, { flags: 'a', mode: 0o600 });
		this.writeStream.on('error', (err) => {
			this.writeErr = err;
			this.logger?.warn?.('fbq.writeStream error', err);
			// 异步错误：排队到 mutex 做粘性降级清理，避免状态半截卡死
			this.mutex.withLock(() => this.__handleFsError(err)).catch(() => {});
		});
	}

	async __writeLine(str) {
		// 不再前置 writeErr 检查：一旦 writeErr 被异步设置，__handleFsError 会立即排队清理并
		// 把 fsBroken 置粘性；spill 路径入口已判 fsBroken，到这里 writeErr 必为 null。
		// 写失败通过 write 回调的 err 反映，catch 块处理。
		return await new Promise((resolve, reject) => {
			this.writeStream.write(str, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}

	async __closeWriteStream() {
		if (!this.writeStream) return;
		const stream = this.writeStream;
		this.writeStream = null;
		if (stream.destroyed || stream.writableEnded) return;
		// 使用事件而非 end(cb)：errored 流上 end 的回调可能永不触发 → 死锁风险。
		// 'close' 在正常结束后触发；'error' 在异常流上作为兜底。Promise 幂等。
		await new Promise((resolve) => {
			stream.once('close', resolve);
			stream.once('error', resolve);
			try {
				stream.end();
			/* c8 ignore next 3 -- stream.end 同步抛极少见 */
			} catch {
				resolve();
			}
		});
	}

	// mutex 内调用：FS 错误粘性降级。err 缓存到 lastFsErr 供后续 fsBroken 短路 enqueue 透传给 onDrop
	async __handleFsError(err) {
		if (this.destroyed || this.fsBroken) return;
		this.fsBroken = true;
		this.lastFsErr = err;
		await this.__closeWriteStream();
		try {
			await fs.rm(this.filePath, { force: true });
		} catch (rmErr) {
			/* c8 ignore next 2 -- rm with force rarely fails */
			this.logger?.warn?.('fbq.handleFsError rm error', rmErr);
		}
		// 故意不 __dispatchSpillEnd：webrtc 只 destroy 不 clear + fsBroken 粘性不再 spill，spillActive 卡 true 不可达；即便发生也仅 monitor 观测标志失真，不丢消息
		this.spilled = false;
		this.writtenBytes = 0;
		this.readOffset = 0;
		this.writeErr = null;
		// 唤醒全部消费者，让它们重新观察状态
		this.__wakeAll();
	}

	// 调用方必须已持有 mutex，且已确认 !destroyed
	async __refillImpl() {
		if (!this.spilled) return;

		let actualEnd;
		try {
			const st = await fs.stat(this.filePath);
			actualEnd = st.size;
		} catch (err) {
			// 读侧 FS 错误（外部删文件、权限丢失等）走粘性降级，
			// 避免 spilled=true / fsBroken=false 的悬空态让消费者永远挂 waiter。
			this.logger?.warn?.('fbq.refill stat error', err);
			await this.__handleFsError(err);
			return;
		}

		if (this.readOffset >= actualEnd) {
			await this.__dropFile();
			return;
		}

		const newLines = [];
		let cumBytes = 0;     // 文件字节：payload + \n
		let cumPayload = 0;   // 仅 payload
		let stoppedAtEof = true;

		const baseBytes = this.memBytes;

		const stream = createReadStream(this.filePath, {
			start: this.readOffset,
			end: actualEnd - 1,
		});
		const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

		try {
			for await (const line of rl) {
				const sz = Buffer.byteLength(line, 'utf8');
				// 与 admission 一致（current ≥ threshold）：当前 mem 总字节 ≥ memBudget 时停止，
				// 允许首条 single overshoot；后续若仍超阈值再停。
				if (newLines.length > 0 && baseBytes + cumPayload >= this.memBudget) {
					stoppedAtEof = false;
					break;
				}
				newLines.push(line);
				cumBytes += sz + 1;
				cumPayload += sz;
			}
		} catch (err) {
			/* c8 ignore next 6 -- read 错误极罕见（stat 已通过、fd 已打开），路径保留用于粘性降级 */
			// read 错误同 stat：统一走粘性降级而非静默 return
			this.logger?.warn?.('fbq.refill read error', err);
			rl.close();
			stream.destroy();
			await this.__handleFsError(err);
			return;
		} finally {
			rl.close();
			stream.destroy();
		}

		const availableBytes = actualEnd - this.readOffset;

		if (stoppedAtEof && cumBytes > availableBytes) {
			// 最后一行未终止（尾部 \n 缺失）：视为半截，丢弃
			const partial = newLines.pop();
			cumPayload -= Buffer.byteLength(partial, 'utf8');
			this.logger?.warn?.('fbq.refill partial tail discarded', {
				size: Buffer.byteLength(partial, 'utf8'),
			});
			// 将 readOffset 推到 writtenBytes，彻底丢弃尾部残片
			this.readOffset = this.writtenBytes;
		} else {
			this.readOffset += cumBytes;
		}

		for (const line of newLines) {
			this.memQueue.push(line);
			this.memBytes += Buffer.byteLength(line, 'utf8');
		}

		if (this.readOffset >= this.writtenBytes) {
			await this.__dropFile();
		}
	}

	async __dropFile() {
		// 抓 drainedBytes 在重置前——让监视器拿到"删除时这文件累计写入了多少字节"
		const drainedBytes = this.writtenBytes;
		const wasSpilled = this.spilled;
		await this.__closeWriteStream();
		try {
			await fs.rm(this.filePath, { force: true });
		} catch (err) {
			/* c8 ignore next 2 -- rm with force rarely fails */
			this.logger?.warn?.('fbq.dropFile error', err);
		}
		this.spilled = false;
		this.writtenBytes = 0;
		this.readOffset = 0;
		this.writeErr = null;
		// 文件层翻转 true→false：仅 drain 路径调 spill-end；故障删档（__handleFsError）/
		// 清理离场（destroy）不调，由 fs-broken / close 信号各自承载，避免语义混淆
		if (wasSpilled) this.__dispatchSpillEnd(drainedBytes);
	}
}

export { FileBackedQueue };
