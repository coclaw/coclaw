import { randomBytes } from 'node:crypto';

const DEFAULT_EPOCH = Date.parse('2000-01-01T00:00:00.000Z');
const DEFAULT_WORKER_BITS = 10;
const DEFAULT_SEQ_BITS = 12;
const DEFAULT_TIME_SLICE_MS = 1;
const MAX_TIME_SLICE_MS = 1000;

/**
 * 校验是否为非负整数。
 * @param {unknown} value - 待校验值
 * @param {string} name - 参数名
 */
function assertNonNegativeInt(value, name) {
	if (!Number.isInteger(value) || value < 0) {
		throw new TypeError(`${name} 必须是非负整数`);
	}
}

/**
 * 使用随机字节生成指定 bit 位宽的无符号整数。
 * @param {number} bits - 位宽
 * @returns {bigint}
 */
function randomBits(bits) {
	if (bits === 0) {
		return 0n;
	}

	const size = Math.ceil(bits / 8);
	const raw = randomBytes(size);
	const rawHex = raw.toString('hex');
	const value = BigInt(`0x${rawHex}`);
	const mask = (1n << BigInt(bits)) - 1n;
	return value & mask;
}

export class Snowflake {
	static standard = new Snowflake();

	/**
	 * 以标准配置生成 ID。
	 * @returns {bigint}
	 */
	static genId() {
		return Snowflake.standard.nextId();
	}

	/**
	 * @param {object} [options] - 配置项
	 * @param {number} [options.epoch] - 基准时间（毫秒时间戳）
	 * @param {number} [options.workerBits] - worker 位数
	 * @param {number} [options.seqBits] - 序列位数
	 * @param {number} [options.workerId] - worker 编号
	 * @param {number} [options.timeSliceMs] - 时间片时长（毫秒）
	 * @param {number} [options.seqRandomBits] - 随机 seq 起始值位数
	 * @param {() => number} [options.nowFn] - 当前时间函数（毫秒）
	 * @param {(max: bigint) => bigint|number} [options.randSeqFn] - 自定义随机 seq 函数
	 */
	constructor(options = {}) {
		const {
			epoch = DEFAULT_EPOCH,
			workerBits = DEFAULT_WORKER_BITS,
			seqBits = DEFAULT_SEQ_BITS,
			workerId = 0,
			timeSliceMs = DEFAULT_TIME_SLICE_MS,
			seqRandomBits = 0,
			nowFn = Date.now,
			randSeqFn = null,
		} = options;

		assertNonNegativeInt(epoch, 'epoch');
		assertNonNegativeInt(workerBits, 'workerBits');
		assertNonNegativeInt(seqBits, 'seqBits');
		assertNonNegativeInt(workerId, 'workerId');
		assertNonNegativeInt(timeSliceMs, 'timeSliceMs');
		assertNonNegativeInt(seqRandomBits, 'seqRandomBits');

		if (timeSliceMs === 0 || timeSliceMs > MAX_TIME_SLICE_MS) {
			throw new RangeError(`timeSliceMs 必须在 1 到 ${MAX_TIME_SLICE_MS} 之间`);
		}

		if (seqRandomBits > seqBits) {
			throw new RangeError('seqRandomBits 不可超过 seqBits');
		}

		if (typeof nowFn !== 'function') {
			throw new TypeError('nowFn 必须是函数');
		}

		if (randSeqFn !== null && typeof randSeqFn !== 'function') {
			throw new TypeError('randSeqFn 必须是函数');
		}

		const workerBitsBig = BigInt(workerBits);
		const seqBitsBig = BigInt(seqBits);
		const maxWorkerId = workerBits === 0 ? 0n : (1n << workerBitsBig) - 1n;
		const workerIdBig = BigInt(workerId);

		if (workerBits === 0 && workerId !== 0) {
			throw new RangeError('workerBits 为 0 时，workerId 必须为 0');
		}

		if (workerIdBig > maxWorkerId) {
			throw new RangeError(`workerId 超出范围，最大值为 ${maxWorkerId.toString()}`);
		}

		this.epoch = epoch;
		this.workerBits = workerBits;
		this.seqBits = seqBits;
		this.workerId = workerId;
		this.workerIdBig = workerIdBig;
		this.timeSliceMs = timeSliceMs;
		this.seqRandomBits = seqRandomBits;
		this.nowFn = nowFn;
		this.randSeqFn = randSeqFn;

		this.seqSize = 1n << seqBitsBig;
		this.seqMax = this.seqSize - 1n;
		this.seqRandomSize = 1n << BigInt(seqRandomBits);
		this.workerShift = seqBitsBig;
		this.timeShift = workerBitsBig + seqBitsBig;

		this.lastTick = null;
		this.nextSeq = 0n;
	}

	/**
	 * 生成下一个 ID。
	 * @returns {bigint}
	 */
	nextId() {
		let tick = this.#nowTick();

		if (this.lastTick !== null && tick < this.lastTick) {
			const diff = this.lastTick - tick;
			throw new Error(`检测到时钟回拨: ${diff.toString()} 个时间片`);
		}

		if (this.lastTick === null || tick > this.lastTick) {
			this.#resetTickState(tick);
		} else if (this.nextSeq > this.seqMax) {
			tick = this.#waitNextTick(this.lastTick);
			this.#resetTickState(tick);
		}

		const seq = this.nextSeq;
		this.nextSeq += 1n;

		if (tick < 0n) {
			throw new RangeError('当前时间早于 epoch');
		}

		return (tick << this.timeShift) | (this.workerIdBig << this.workerShift) | seq;
	}

	#resetTickState(tick) {
		this.lastTick = tick;
		this.nextSeq = this.#nextRandSeqStart();
	}

	#waitNextTick(lastTick) {
		let tick = this.#nowTick();
		while (tick <= lastTick) {
			tick = this.#nowTick();
		}
		return tick;
	}

	#nowTick() {
		const nowMs = this.nowFn();
		if (!Number.isFinite(nowMs)) {
			throw new TypeError('nowFn 返回值必须是有限数字');
		}
		return BigInt(Math.floor((nowMs - this.epoch) / this.timeSliceMs));
	}

	#nextRandSeqStart() {
		if (this.randSeqFn === null) {
			return randomBits(this.seqRandomBits);
		}

		if (this.seqRandomBits === 0) {
			return 0n;
		}

		const raw = this.randSeqFn(this.seqRandomSize);
		const value = BigInt(raw);
		if (value < 0n || value >= this.seqRandomSize) {
			throw new RangeError('randSeqFn 返回值超出 seqRandomBits 范围');
		}
		return value;
	}
}
