/**
 * 文件回退队列：内存优先，超过预算后追加写入 JSONL 文件。
 * 业务无关纯工具：存储任意字符串（调用方需保证不含裸 `\n`，否则行分隔语义被破坏）。
 *
 * 行为约定详见 docs/rpc-dc-file-queue.md。
 * - FIFO、单一生产者／消费者；多消费者时每条只交付给其中一个。
 * - 构造纯字段初始化，不碰 FS；使用前需 `await q.init()`。
 * - 消费侧：`for await (const item of queue) { ... }`；`destroy()` 让迭代结束。
 * - FS 异常下进入 `fsBroken` 粘性降级：mem 路径继续工作，溢出消息 drop。
 */

import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import nodePath from 'node:path';
import readline from 'node:readline';

import { createMutex } from './mutex.js';

const DEFAULT_MEM_BUDGET = 8 * 1024 * 1024;
const DEFAULT_DISK_CAP = 1024 * 1024 * 1024;

// JS 对象开销估算（string header + array slot 等），仅用于 admission 决策不影响 memBytes 报告
const ENTRY_OVERHEAD = 64;

// id 字符集：UUID / 字母数字 / 点 / 下划线 / 减号，且不能是 "." 或 ".."
const ID_RE = /^[A-Za-z0-9._-]+$/;

// 压缩阈值：head 越过 64 且占 memQueue 一半以上时切片回收
const COMPACT_HEAD_THRESHOLD = 64;

class FileBackedQueue {
	/**
	 * @param {object} opts
	 * @param {string} opts.dir - 队列文件根目录
	 * @param {string} opts.id - 队列标识，字符集受限，防路径穿越
	 * @param {number} [opts.memBudget=8MB] - 内存持有字节数上限
	 * @param {number} [opts.diskCap=1GB] - 磁盘+内存总字节数硬上限（含 `\n`）
	 * @param {(reason: string, size: number) => void} [opts.onDrop] - 拒入队时的回调
	 * @param {{ warn?: Function, info?: Function, error?: Function }} [opts.logger=console]
	 */
	constructor(opts) {
		const {
			dir,
			id,
			memBudget = DEFAULT_MEM_BUDGET,
			diskCap = DEFAULT_DISK_CAP,
			onDrop,
			logger = console,
		} = opts ?? {};

		if (!dir || typeof dir !== 'string') throw new TypeError('dir is required');
		if (!id || typeof id !== 'string') throw new TypeError('id is required');
		if (id === '.' || id === '..' || !ID_RE.test(id)) {
			throw new TypeError('id contains invalid characters');
		}

		this.dir = dir;
		this.id = id;
		this.memBudget = memBudget;
		this.diskCap = diskCap;
		this.onDrop = onDrop;
		this.logger = logger;

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

			// admission：按物理占用（mem + 已写文件总字节，含 \n）判定，保证 diskCap 是真正的硬上限。
			// 用 writtenBytes（不减 readOffset）的含义：文件前缀已读但未被 __dropFile 回收前仍算占用。
			// 代价：持续背压下消费者还没追到写端时新消息可能被 drop，直到完全 drain 触发 __dropFile 重置。
			if (this.memBytes + this.writtenBytes + size + 1 > this.diskCap) {
				this.__dispatchDrop('disk-cap', size);
				return false;
			}

			// 内存路径：未溢出且 admission 通过（考虑 overhead；首条无论多大都收）
			if (!this.spilled) {
				const pendingCount = this.memQueue.length - this.head;
				const cost = this.memBytes + pendingCount * ENTRY_OVERHEAD + size + ENTRY_OVERHEAD;
				if (pendingCount === 0 || cost <= this.memBudget) {
					this.memQueue.push(jsonStr);
					this.memBytes += size;
					this.__wakeOne();
					return true;
				}
			}

			// 溢出路径：FS 已破直接 drop，不再尝试 reopen
			if (this.fsBroken) {
				this.__dispatchDrop('fs-error', size);
				return false;
			}

			if (!this.spilled) {
				await this.__openWriteStream();
				if (this.writeErr) {
					this.__dispatchDrop('fs-error', size);
					return false;
				}
				this.spilled = true;
			}

			try {
				await this.__writeLine(jsonStr + '\n');
				this.writtenBytes += size + 1;
				this.__wakeOne();
				return true;
			} catch (err) {
				this.logger?.warn?.('fbq.enqueue fs-error', err);
				this.__dispatchDrop('fs-error', size);
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
		});
	}

	/**
	 * 停写、关 FD、删文件、结束所有迭代器。幂等。
	 */
	async destroy() {
		return await this.mutex.withLock(async () => {
			if (this.destroyed) return;
			this.destroyed = true;

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

	__dispatchDrop(reason, size) {
		try {
			this.onDrop?.(reason, size);
		} catch (err) {
			/* c8 ignore next 2 -- onDrop throwing is caller's bug */
			this.logger?.warn?.('fbq.onDrop threw', err);
		}
		this.logger?.warn?.('fbq.drop', { reason, size });
	}

	async __openWriteStream() {
		this.writeErr = null;
		try {
			// 目录 0o700 / 文件 0o600：JSONL 里可能包含用户消息、文件 payload 等敏感内容，
			// 只允许队列进程所属用户访问；同仓 atomic-write.js 已是同一策略。
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

	// mutex 内调用：FS 错误粘性降级
	async __handleFsError(_err) {
		if (this.destroyed || this.fsBroken) return;
		this.fsBroken = true;
		await this.__closeWriteStream();
		try {
			await fs.rm(this.filePath, { force: true });
		} catch (err) {
			/* c8 ignore next 2 -- rm with force rarely fails */
			this.logger?.warn?.('fbq.handleFsError rm error', err);
		}
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
			/* c8 ignore next 3 -- stat 在正常持有期间不会失败 */
			this.logger?.warn?.('fbq.refill stat error', err);
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

		const pendingCount = this.memQueue.length - this.head;
		const baseCost = this.memBytes + pendingCount * ENTRY_OVERHEAD;

		const stream = createReadStream(this.filePath, {
			start: this.readOffset,
			end: actualEnd - 1,
		});
		const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

		try {
			for await (const line of rl) {
				const sz = Buffer.byteLength(line, 'utf8');
				// overhead 一致性：admission 侧已用 overhead，refill 侧同步考虑
				const newLinesCost = newLines.length * ENTRY_OVERHEAD;
				if (newLines.length > 0 && baseCost + cumPayload + newLinesCost + sz + ENTRY_OVERHEAD > this.memBudget) {
					stoppedAtEof = false;
					break;
				}
				newLines.push(line);
				cumBytes += sz + 1;
				cumPayload += sz;
			}
		} catch (err) {
			/* c8 ignore next 4 -- read 错误罕见，保守退出 */
			this.logger?.warn?.('fbq.refill read error', err);
			rl.close();
			stream.destroy();
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
	}
}

export { FileBackedQueue };
