import { randomBytes } from 'node:crypto';

const DEFAULT_EPOCH = Date.parse('2020-01-01T00:00:00.000Z');
const DEFAULT_WORKER_BITS = 10;
const DEFAULT_SEQ_BITS = 12;
const DEFAULT_TIME_SLICE_MS = 1;
const MAX_TIME_SLICE_MS = 1000;
const DEFAULT_MAX_DRIFT_MS = 5000;

/**
 * 校验是否为非负整数。
 * @param {unknown} value - 待校验值
 * @param {string} name - 参数名
 */
function assertNonNegativeInt(value, name) {
	if (!Number.isInteger(value) || value < 0) {
		throw new TypeError(`${name} must be a non-negative integer`);
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
	 * @param {number} [options.maxDriftMs] - 允许的最大时间漂移（毫秒）
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
			maxDriftMs = DEFAULT_MAX_DRIFT_MS,
			nowFn = Date.now,
			randSeqFn = null,
		} = options;

		assertNonNegativeInt(epoch, 'epoch');
		assertNonNegativeInt(workerBits, 'workerBits');
		assertNonNegativeInt(seqBits, 'seqBits');
		assertNonNegativeInt(workerId, 'workerId');
		assertNonNegativeInt(timeSliceMs, 'timeSliceMs');
		assertNonNegativeInt(seqRandomBits, 'seqRandomBits');
		assertNonNegativeInt(maxDriftMs, 'maxDriftMs');

		if (timeSliceMs === 0 || timeSliceMs > MAX_TIME_SLICE_MS) {
			throw new RangeError(`timeSliceMs must be between 1 and ${MAX_TIME_SLICE_MS}`);
		}

		if (seqRandomBits > seqBits) {
			throw new RangeError('seqRandomBits must not exceed seqBits');
		}

		if (typeof nowFn !== 'function') {
			throw new TypeError('nowFn must be a function');
		}

		if (randSeqFn !== null && typeof randSeqFn !== 'function') {
			throw new TypeError('randSeqFn must be a function');
		}

		const workerBitsBig = BigInt(workerBits);
		const seqBitsBig = BigInt(seqBits);
		const maxWorkerId = workerBits === 0 ? 0n : (1n << workerBitsBig) - 1n;
		const workerIdBig = BigInt(workerId);

		if (workerBits === 0 && workerId !== 0) {
			throw new RangeError('workerId must be 0 when workerBits is 0');
		}

		if (workerIdBig > maxWorkerId) {
			throw new RangeError(`workerId out of range, max is ${maxWorkerId.toString()}`);
		}

		this.epoch = epoch;
		this.workerBits = workerBits;
		this.seqBits = seqBits;
		this.workerId = workerId;
		this.workerIdBig = workerIdBig;
		this.timeSliceMs = timeSliceMs;
		this.seqRandomBits = seqRandomBits;
		this.maxDriftTicks = BigInt(Math.ceil(maxDriftMs / timeSliceMs));
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
		const tick = this.#nowTick();

		// 前置校验：物理时间异常
		if (tick < 0n) {
			throw new RangeError('Current time is before epoch');
		}

		if (this.lastTick === null || tick > this.lastTick) {
			// 物理时间正常推进，重置逻辑时钟
			this.#resetTickState(tick);
		} else {
			// 物理时间落后于逻辑时钟（同一时间片 / 时钟回拨 / 预借未追平）
			if (this.nextSeq > this.seqMax) {
				// seq 耗尽 → 预借下一个时间片，seq 从 0 开始
				this.lastTick += 1n;
				this.nextSeq = 0n;
			}

			// 统一校验：NTP 回拨或预借累积，偏差超出阈值则立即熔断
			const drift = this.lastTick - tick;
			if (drift > this.maxDriftTicks) {
				throw new Error(
					`Time slice drift exceeded limit: drift=${drift.toString()} ticks, max=${this.maxDriftTicks.toString()} ticks`
				);
			}
		}

		const seq = this.nextSeq;
		this.nextSeq += 1n;

		return (this.lastTick << this.timeShift) | (this.workerIdBig << this.workerShift) | seq;
	}

	#resetTickState(tick) {
		this.lastTick = tick;
		this.nextSeq = this.#nextRandSeqStart();
	}

	#nowTick() {
		const nowMs = this.nowFn();
		if (!Number.isFinite(nowMs)) {
			throw new TypeError('nowFn must return a finite number');
		}
		return BigInt(Math.floor((nowMs - this.epoch) / this.timeSliceMs));
	}

	#nextRandSeqStart() {
		// 提前短路，避免后续多余的 null 判断
		if (this.seqRandomBits === 0) {
			return 0n;
		}

		if (this.randSeqFn === null) {
			return randomBits(this.seqRandomBits);
		}

		const raw = this.randSeqFn(this.seqRandomSize);
		const value = BigInt(raw);
		if (value < 0n || value >= this.seqRandomSize) {
			throw new RangeError('randSeqFn return value out of seqRandomBits range');
		}
		return value;
	}
}
