/**
 * 文件回退队列：内存优先，超过预算后追加写入 JSONL 文件。
 * 业务无关纯工具：存储任意字符串（调用方需保证不含裸 `\n`，否则行分隔语义被破坏）。
 *
 * 行为约定详见 docs/rpc-dc-file-queue.md。
 * - FIFO、单一生产者／消费者；多消费者时每条只交付给其中一个。
 * - 构造时清理目录残留（不跨生命周期复用）。
 * - 消费侧：`for await (const item of queue) { ... }`；`destroy()` 让迭代结束。
 */

import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, rmSync } from 'node:fs';
import nodePath from 'node:path';
import readline from 'node:readline';

import { createMutex } from './mutex.js';

const DEFAULT_MEM_BUDGET = 8 * 1024 * 1024;
const DEFAULT_DISK_CAP = 1024 * 1024 * 1024;

class FileBackedQueue {
	/**
	 * @param {object} opts
	 * @param {string} opts.dir - 队列文件根目录
	 * @param {string} opts.id - 队列标识（用于子目录命名）
	 * @param {number} [opts.memBudget=8MB] - 内存持有字节数上限
	 * @param {number} [opts.diskCap=1GB] - 磁盘+内存总字节数硬上限
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

		this.dir = dir;
		this.id = id;
		this.memBudget = memBudget;
		this.diskCap = diskCap;
		this.onDrop = onDrop;
		this.logger = logger;

		this.subdir = nodePath.join(dir, id);
		this.filePath = nodePath.join(this.subdir, 'queue.jsonl');

		this.memQueue = [];
		this.memBytes = 0;
		this.diskBytes = 0;       // 磁盘上未消费的 payload 字节（不含分隔 \n）
		this.writtenBytes = 0;    // 已写入文件的累计字节（含 \n）
		this.readOffset = 0;      // 下次 refill 的起始偏移
		this.spilled = false;
		this.destroyed = false;
		this.writeStream = null;
		this.writeErr = null;
		this.waiters = [];
		this.mutex = createMutex();

		// 防御性清理：不跨生命周期复用旧数据
		try {
			rmSync(this.subdir, { recursive: true, force: true });
		} catch (err) {
			/* c8 ignore next 2 -- rmSync with force rarely fails on posix */
			this.logger?.warn?.('fbq.construct cleanup error', err);
		}
	}

	/**
	 * 入队一条字符串。
	 * @param {string} jsonStr
	 * @returns {Promise<boolean>} accepted（true）/ dropped（false）
	 */
	async enqueue(jsonStr) {
		return await this.mutex.withLock(async () => {
			if (this.destroyed) return false;
			if (typeof jsonStr !== 'string') throw new TypeError('jsonStr must be a string');

			const size = Buffer.byteLength(jsonStr, 'utf8');

			if (this.memBytes + this.diskBytes + size > this.diskCap) {
				this.__dispatchDrop('disk-cap', size);
				return false;
			}

			// 内存路径：未溢出且加上新条目仍在预算内
			if (!this.spilled && this.memBytes + size <= this.memBudget) {
				this.memQueue.push(jsonStr);
				this.memBytes += size;
				this.__wakeOne();
				return true;
			}

			// 溢出路径：lazy 打开写流
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
				this.diskBytes += size;
				this.writtenBytes += size + 1;
				this.__wakeOne();
				return true;
			} catch (err) {
				this.logger?.warn?.('fbq.enqueue fs-error', err);
				this.__dispatchDrop('fs-error', size);
				return false;
			}
		});
	}

	/**
	 * @returns {{ memCount: number, memBytes: number, diskBytes: number, spilled: boolean }}
	 */
	stats() {
		return {
			memCount: this.memQueue.length,
			memBytes: this.memBytes,
			diskBytes: this.diskBytes,
			spilled: this.spilled,
		};
	}

	/**
	 * 清空数据但保留实例可用。
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
			this.memBytes = 0;
			this.diskBytes = 0;
			this.writtenBytes = 0;
			this.readOffset = 0;
			this.spilled = false;
			this.writeErr = null;
		});
	}

	/**
	 * 停写、关 FD、删目录、结束所有迭代器。幂等。
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
				await fs.rm(this.subdir, { recursive: true, force: true });
			} catch (err) {
				/* c8 ignore next 2 -- rm with force rarely fails */
				this.logger?.warn?.('fbq.destroy rm error', err);
			}

			this.memQueue = [];
			this.memBytes = 0;
			this.diskBytes = 0;
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
				if (this.memQueue.length === 0 && this.spilled && !this.destroyed) {
					await this.__refillImpl();
				}
				if (this.memQueue.length > 0) {
					const item = this.memQueue.shift();
					this.memBytes -= Buffer.byteLength(item, 'utf8');
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
			await fs.mkdir(this.subdir, { recursive: true });
		} catch (err) {
			this.writeErr = err;
			return;
		}
		this.writeStream = createWriteStream(this.filePath, { flags: 'a' });
		this.writeStream.on('error', (err) => {
			this.writeErr = err;
			this.logger?.warn?.('fbq.writeStream error', err);
		});
	}

	async __writeLine(str) {
		if (this.writeErr) throw this.writeErr;
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

		const stream = createReadStream(this.filePath, {
			start: this.readOffset,
			end: actualEnd - 1,
		});
		const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

		try {
			for await (const line of rl) {
				const sz = Buffer.byteLength(line, 'utf8');
				if (newLines.length > 0 && this.memBytes + cumPayload + sz > this.memBudget) {
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
		this.diskBytes -= cumPayload;

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
		this.diskBytes = 0;
		this.writeErr = null;
	}
}

export { FileBackedQueue };
