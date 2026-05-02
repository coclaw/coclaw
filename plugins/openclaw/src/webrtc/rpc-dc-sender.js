/**
 * rpc DataChannel 紧贴发送器（async 阻塞式）
 *
 * 阶段 1 从原 `RpcSendQueue` 中拆出：仅保留 DC 紧贴部分——分片（buildChunks）、bufferedAmount
 * 背压、错误协议。不再持有任何缓冲队列；容器层（admission / overflow / drop 统计）由
 * `MemoryQueue` 承担。
 *
 * 调用形态：典型与 MemoryQueue + for-await 联用。
 * ```js
 * for await (const str of queue) {
 *   try { await sender.send(str); }
 *   catch (err) {
 *     if (err.code === 'SENDER_CLOSED') break;
 *     logger.warn?.(`rpc-dc.send-failed code=${err.code} size=${str.length}`);
 *   }
 * }
 * ```
 *
 * 错误协议（统一抛错，no silent return）：
 * - `SENDER_CLOSED` —— sender 关闭 / DC 非 open / dc.send 抛
 * - `MESSAGE_OVERSIZED` —— 单条 payload > 50 MB
 * - `BUILD_CHUNKS_FAILED` —— buildChunks 抛（如 maxMessageSize 太小）
 *
 * 背压：bufferedAmount >= HIGH 时 await `bufferedamountlow` 事件再继续；close 期间内部 waiter
 * 全部 reject(SENDER_CLOSED)。
 *
 * `maxMessageSize` 公开字段：ICE restart 后由调用方热更新（PC 重建会重置实例，无需此字段；
 * 同 connId 的 ICE restart 不重建 sender，仅热更）。
 */

import { buildChunks } from './dc-chunking.js';
import { remoteLog } from '../remote-log.js';

/** 高水位：`dc.bufferedAmount >= HIGH` 时 send 阻塞等 BAL */
export const DC_HIGH_WATER_MARK = 1024 * 1024;       // 1 MB
/** 低水位：用于 `dc.bufferedAmountLowThreshold`，触发 `bufferedamountlow` 事件 */
export const DC_LOW_WATER_MARK = 256 * 1024;         // 256 KB
/** 单条 payload 硬上限：对齐 dc-chunking.js MAX_REASSEMBLY_BYTES */
export const MAX_SINGLE_MSG_BYTES = 50 * 1024 * 1024; // 50 MB

class RpcDcSender {
	/**
	 * @param {object} opts
	 * @param {object} opts.dc - DataChannel 实例（需支持 send / bufferedAmount / readyState）
	 * @param {number} opts.maxMessageSize - 对端 SDP 声明的 a=max-message-size（公开字段，可热更新）
	 * @param {() => number} opts.getNextMsgId - 分片 msgId 生成器
	 * @param {{ warn?: Function, info?: Function, error?: Function }} [opts.logger=console]
	 * @param {string} [opts.tag] - 日志前缀（如 connId）
	 */
	constructor({ dc, maxMessageSize, getNextMsgId, logger, tag } = {}) {
		if (!dc) throw new Error('RpcDcSender: dc is required');
		this.dc = dc;
		this.maxMessageSize = maxMessageSize;
		this.getNextMsgId = getNextMsgId;
		this.logger = logger ?? console;
		this.tag = tag ?? '';
		this.closed = false;
		/** @type {{ resolve: () => void, reject: (err: Error) => void }[]} */
		this.balWaiters = [];
	}

	/**
	 * 发送一条 JSON 字符串。Async 阻塞式：bufferedAmount 顶到 HIGH 时 await BAL 再继续。
	 * 失败均抛出带 `code` 的 Error；调用方按 code 处理。
	 *
	 * @param {string} jsonStr
	 * @returns {Promise<void>}
	 * @throws {Error & { code: 'SENDER_CLOSED' | 'MESSAGE_OVERSIZED' | 'BUILD_CHUNKS_FAILED' }}
	 */
	async send(jsonStr) {
		this.__assertOpen();

		const payloadBytes = Buffer.byteLength(jsonStr, 'utf8');

		if (payloadBytes > MAX_SINGLE_MSG_BYTES) {
			this.__safeWarn(`drop reason=single-msg-oversize size=${payloadBytes} cap=${MAX_SINGLE_MSG_BYTES}`);
			throw makeErr('MESSAGE_OVERSIZED', `payload exceeds ${MAX_SINGLE_MSG_BYTES} bytes (size=${payloadBytes})`);
		}

		let chunks;
		try {
			chunks = buildChunks(jsonStr, this.maxMessageSize, this.getNextMsgId);
		} catch (err) {
			const errMsg = err?.message ?? String(err);
			this.__safeWarn(`drop reason=build-chunks-failed size=${payloadBytes} maxMessageSize=${this.maxMessageSize} err=${errMsg}`);
			this.__safeRemoteLog(`rpc-dc-sender.build-chunks-failed${this.__tagSuffix()} size=${payloadBytes} maxMessageSize=${this.maxMessageSize} err=${errMsg}`);
			const wrap = makeErr('BUILD_CHUNKS_FAILED', `buildChunks failed: ${errMsg}`);
			wrap.cause = err;
			throw wrap;
		}

		if (!chunks) {
			// 不分片：单条 string 整体发送
			await this.__sendOne(jsonStr);
			return;
		}
		// 分片路径：逐 chunk 阻塞发送，保证同消息的 chunk 连续
		for (const chunk of chunks) {
			await this.__sendOne(chunk);
		}
	}

	/** 由外部 `dc.onbufferedamountlow` 事件触发，唤醒所有等 BAL 的 waiter */
	onBufferedAmountLow() {
		const toWake = this.balWaiters.splice(0);
		for (const w of toWake) w.resolve();
	}

	/**
	 * 关闭发送器：reject 所有 pending waiter（带 SENDER_CLOSED）。幂等。
	 * 阻塞中的 send 会在下一刻抛 SENDER_CLOSED；后续 send 调用立即抛。
	 */
	close() {
		if (this.closed) return;
		this.closed = true;
		const toReject = this.balWaiters.splice(0);
		for (const w of toReject) {
			w.reject(makeErr('SENDER_CLOSED', 'sender closed'));
		}
	}

	async __sendOne(payload) {
		await this.__waitForRoom();
		// BAL 与 close 的窄缝：BAL 触发时 onBufferedAmountLow 已 splice 走 waiter 并 resolve；
		// 若紧接着 close() 介入，splice 看到空数组、无 waiter 可 reject，唤醒后的 continuation
		// 仍会跑到这里。重检 closed 以保 "closed 后不再写 dc" 的不变量；readyState 变化交由
		// dc.send 抛 InvalidStateError 时下面 catch 捕获兜底。
		if (this.closed) {
			throw makeErr('SENDER_CLOSED', 'sender closed during BAL wait');
		}
		try {
			this.dc.send(payload);
		} catch (err) {
			this.__safeWarn(`dc.send failed: ${err?.message}`);
			const wrap = makeErr('SENDER_CLOSED', `dc.send failed: ${err?.message}`);
			wrap.cause = err;
			throw wrap;
		}
	}

	async __waitForRoom() {
		// 立刻检查 closed/readyState
		if (this.closed || this.dc.readyState !== 'open') {
			throw makeErr('SENDER_CLOSED', 'sender closed or dc not open');
		}
		if (this.dc.bufferedAmount < DC_HIGH_WATER_MARK) return;
		// 阻塞等 onBufferedAmountLow 唤醒（或 close reject）
		return await new Promise((resolve, reject) => {
			this.balWaiters.push({ resolve, reject });
		});
	}

	__assertOpen() {
		if (this.closed || this.dc.readyState !== 'open') {
			throw makeErr('SENDER_CLOSED', 'sender closed or dc not open');
		}
	}

	__tagSuffix() {
		return this.tag ? ` ${this.tag}` : '';
	}

	__safeWarn(msg) {
		try { this.logger.warn?.(`[rpc-dc-sender${this.__tagSuffix()}] ${msg}`); } catch { /* logger 自身坏了不能让 send 抛非协议错 */ }
	}

	__safeRemoteLog(text) {
		try { remoteLog(text); } catch { /* 防御性兜底 */ }
	}
}

function makeErr(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

export { RpcDcSender };
