/**
 * rpc DataChannel 发送流控队列
 *
 * 针对 plugin 侧 rpc DC 的应用层流控：与 UI 侧 `webrtc-connection.js` 语义对齐，
 * 但因插件运行在 gateway 进程内，必须对队列大小设硬/软上限，避免 OOM。
 *
 * 使用方式：每条 rpc DC 一个实例，绑定到 session.rpcSendQueue。
 * - send(jsonStr)：同步入口，fire-and-forget；返回 accepted/dropped
 * - onBufferedAmountLow()：由 DC `bufferedamountlow` 事件转调，触发 drain
 * - close()：DC 关闭时调用，清空队列并汇总 drop 统计
 *
 * 不做：Promise 送达保证；单条消息硬上限内的背压；自动重试。
 */

import { buildChunks } from './dc-chunking.js';
import { remoteLog } from '../remote-log.js';

/** 高水位：`dc.bufferedAmount >= HIGH` 时暂停 fast-path / drain */
export const DC_HIGH_WATER_MARK = 1024 * 1024;       // 1 MB
/** 低水位：设置 `dc.bufferedAmountLowThreshold`，触发 `bufferedamountlow` 事件 */
export const DC_LOW_WATER_MARK = 256 * 1024;         // 256 KB
/** 应用层队列软上限：`queueBytes >= MAX_QUEUE_BYTES` 时新消息被 drop */
export const MAX_QUEUE_BYTES = 10 * 1024 * 1024;     // 10 MB
/** 单条消息硬上限（对齐 dc-chunking.js MAX_REASSEMBLY_BYTES，接收端重组不了也无意义） */
export const MAX_SINGLE_MSG_BYTES = 50 * 1024 * 1024; // 50 MB

export class RpcSendQueue {
	/**
	 * @param {object} opts
	 * @param {object} opts.dc - DataChannel 实例（需支持 send / bufferedAmount / readyState）
	 * @param {number} opts.maxMessageSize - 对端 SDP 声明的 a=max-message-size
	 * @param {() => number} opts.getNextMsgId - 分片 msgId 生成器
	 * @param {object} [opts.logger] - pino 风格 logger
	 * @param {string} [opts.tag] - 诊断 tag（通常是 connId）
	 */
	constructor({ dc, maxMessageSize, getNextMsgId, logger, tag }) {
		if (!dc) throw new Error('RpcSendQueue: dc is required');
		this.dc = dc;
		this.maxMessageSize = maxMessageSize;
		this.getNextMsgId = getNextMsgId;
		this.logger = logger ?? console;
		this.tag = tag ?? '';

		/** @type {Buffer[]} chunks 或 Buffer 化的 string 消息 */
		this.queue = [];
		this.queueBytes = 0;
		this.closed = false;

		// drop 统计（累计到 close 时汇总）
		this.droppedCount = 0;
		this.droppedBytes = 0;
		// 队列"满"状态：仅 queue-full drop 触发 true；drain 下降到 < MAX 翻回 false
		// single-msg-oversize drop 不影响此状态（它是应用 bug 性质，不代表队列压力）
		this.queueOverflowActive = false;
	}

	/**
	 * 同步发送一条 JSON 字符串。
	 * @param {string} jsonStr
	 * @returns {boolean} true=accepted（至少已入队或已直发），false=dropped
	 */
	send(jsonStr) {
		if (this.closed || this.dc.readyState !== 'open') return false;

		const chunks = buildChunks(jsonStr, this.maxMessageSize, this.getNextMsgId);
		const totalBytes = chunks
			? chunks.reduce((n, c) => n + c.length, 0)
			: Buffer.byteLength(jsonStr, 'utf8');

		// 硬上限：单条超限
		if (totalBytes > MAX_SINGLE_MSG_BYTES) {
			this.droppedCount += 1;
			this.droppedBytes += totalBytes;
			this.logger.warn?.(`[rpc-queue${this.__tagSuffix()}] drop reason=single-msg-oversize size=${totalBytes} cap=${MAX_SINGLE_MSG_BYTES}`);
			return false;
		}

		// 软上限：队列已积压到 MAX（允许之前单条溢出，但新消息从此开始拒绝）
		if (this.queueBytes >= MAX_QUEUE_BYTES) {
			this.droppedCount += 1;
			this.droppedBytes += totalBytes;
			this.logger.warn?.(`[rpc-queue${this.__tagSuffix()}] drop reason=queue-full size=${totalBytes} queueBytes=${this.queueBytes}`);
			if (!this.queueOverflowActive) {
				this.queueOverflowActive = true;
				remoteLog(`rpc-queue.overflow-start${this.__tagSuffix()} queueBytes=${this.queueBytes}`);
			}
			return false;
		}

		// 不分片：单条 string 或 Buffer 直接处理
		if (!chunks) {
			if (this.queue.length === 0
				&& this.dc.readyState === 'open'
				&& this.dc.bufferedAmount < DC_HIGH_WATER_MARK) {
				try {
					this.dc.send(jsonStr);
					return true;
				} catch (err) {
					this.logger.warn?.(`[rpc-queue${this.__tagSuffix()}] fast-path send failed: ${err?.message}`);
					return false;
				}
			}
			const buf = Buffer.from(jsonStr, 'utf8');
			this.queue.push(buf);
			this.queueBytes += buf.length;
			return true;
		}

		// 分片：fast-path 尝试同步直发尽可能多的 chunk
		// 循环条件与 __drain 一致：DC 仍 open 且 bufferedAmount 未顶到 HIGH
		let i = 0;
		if (this.queue.length === 0) {
			while (i < chunks.length
				&& this.dc.readyState === 'open'
				&& this.dc.bufferedAmount < DC_HIGH_WATER_MARK) {
				try {
					this.dc.send(chunks[i]);
					i += 1;
				} catch (err) {
					this.logger.warn?.(`[rpc-queue${this.__tagSuffix()}] fast-path send failed at chunk ${i}/${chunks.length}: ${err?.message}`);
					return false;
				}
			}
		}
		// 剩余 chunk 原子性入队（保证同一消息分片连续，不被其他消息插入）
		for (; i < chunks.length; i += 1) {
			this.queue.push(chunks[i]);
			this.queueBytes += chunks[i].length;
		}
		return true;
	}

	/** 由外部 `dc.onbufferedamountlow` 事件触发 */
	onBufferedAmountLow() {
		this.__drain();
	}

	/**
	 * 关闭队列：清空待发送 chunks，汇总并 remoteLog drop 统计。幂等。
	 */
	close() {
		if (this.closed) return;
		this.closed = true;
		const residual = this.queue.length;
		const residualBytes = this.queueBytes;
		this.queue.length = 0;
		this.queueBytes = 0;
		this.queueOverflowActive = false;
		if (this.droppedCount > 0 || residual > 0) {
			remoteLog(`rpc-queue.close${this.__tagSuffix()} dropped=${this.droppedCount} droppedBytes=${this.droppedBytes} residualChunks=${residual} residualBytes=${residualBytes}`);
		}
	}

	/** @private 排队持续发送直至 HIGH 水位或队列空 */
	__drain() {
		if (this.closed) return;
		const dc = this.dc;
		while (this.queue.length > 0
			&& dc.readyState === 'open'
			&& dc.bufferedAmount < DC_HIGH_WATER_MARK) {
			const chunk = this.queue[0];
			try {
				dc.send(chunk);
			} catch (err) {
				this.logger.warn?.(`[rpc-queue${this.__tagSuffix()}] drain send failed: ${err?.message}`);
				return; // 保留队列，等 onclose 统一清理
			}
			this.queue.shift();
			this.queueBytes -= chunk.length;
			// 满 → 未满 状态转换
			if (this.queueOverflowActive && this.queueBytes < MAX_QUEUE_BYTES) {
				this.queueOverflowActive = false;
				remoteLog(`rpc-queue.overflow-end${this.__tagSuffix()} dropped=${this.droppedCount} droppedBytes=${this.droppedBytes}`);
			}
		}
	}

	/** @private */
	__tagSuffix() {
		return this.tag ? ` ${this.tag}` : '';
	}
}
