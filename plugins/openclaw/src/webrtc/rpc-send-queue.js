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
 *
 * 契约（重要，修改 send/__drain/onBufferedAmountLow 时务必维持）：
 * send/__drain/onBufferedAmountLow 必须是「总函数」——任何分支都不得抛异常给调用方。
 * 这是上游（webrtc-peer 的 broadcast/sendTo/files sendFn）能去掉 try/catch 的前提。
 * 队列内部所有外部调用（buildChunks、dc.send、logger.*、remoteLog 等）都必须就地保护，
 * 失败转化为 dropped 计数 / 静默吞掉，返回 false。日志输出统一走 __safeWarn / __safeInfo /
 * __safeRemoteLog，避免外部传入的 logger 实现自身抛异常时破坏契约。
 * 入参防御：jsonStr 必须是 string；非 string 直接 drop，避免 Buffer.byteLength 抛 TypeError。
 * 仅构造器允许抛（参数校验，初始化期），运行期入口都不允许。
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

		// 队列元素显式记录原始类型：drain 出口按 isString=true → string 帧，false → binary 帧。
		// 早期实现统一存 Buffer，导致 string 帧被对端当分片残片静默丢弃
		/** @type {{data: string|Buffer, isString: boolean, bytes: number}[]} */
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

		// 入参防御：契约要求 jsonStr 是 string；非 string 直接 drop（避免 Buffer.byteLength 抛 TypeError）
		if (typeof jsonStr !== 'string') {
			this.droppedCount += 1;
			this.__safeWarn(`drop reason=non-string-input type=${typeof jsonStr}`);
			return false;
		}

		// 诊断日志：打印每次入队的事件，跟踪 gateway 还会推哪些事件
		// 需要时临时打开，平时保持注释避免日志噪音
		// this.__safeInfo(`send-payload ${jsonStr}`);

		// payload 字节：UTF-8 实际字节数，与对端 reassembly 上限同口径
		const payloadBytes = Buffer.byteLength(jsonStr, 'utf8');

		// 分片：异常需在 send 内吃掉，避免抛回 gateway 主循环（plugin 硬约束）
		let chunks;
		try {
			chunks = buildChunks(jsonStr, this.maxMessageSize, this.getNextMsgId);
		} catch (err) {
			this.droppedCount += 1;
			this.droppedBytes += payloadBytes;
			const errMsg = err?.message ?? String(err);
			this.__safeWarn(`drop reason=build-chunks-failed size=${payloadBytes} maxMessageSize=${this.maxMessageSize} err=${errMsg}`);
			this.__safeRemoteLog(`rpc-queue.build-chunks-failed${this.__tagSuffix()} size=${payloadBytes} maxMessageSize=${this.maxMessageSize} err=${errMsg}`);
			return false;
		}

		// 帧字节：含 5 字节 header 的实际网络字节，用于队列核算
		const frameBytes = chunks
			? chunks.reduce((n, c) => n + c.length, 0)
			: payloadBytes;

		// 硬上限：单条超限——按 payload 字节判断，对齐对端 reassembly payload 上限
		// （帧字节因 header 累计可能在 payload 恰好不超时被误判 drop）
		if (payloadBytes > MAX_SINGLE_MSG_BYTES) {
			this.droppedCount += 1;
			this.droppedBytes += frameBytes;
			this.__safeWarn(`drop reason=single-msg-oversize size=${payloadBytes} cap=${MAX_SINGLE_MSG_BYTES}`);
			return false;
		}

		// 软上限：队列已积压到 MAX（允许之前单条溢出，但新消息从此开始拒绝）
		// 白名单豁免：agent run 类 RPC 响应（顶层 type=res + payload.runId 顶层存在）
		// 即使队列已满也强行入队，避免 UI 端因 phase-2 res 被 drop 而无法收到 run 终态。
		// 仍受 50MB 单条硬上限约束（接收端重组上限，超过也无意义）。
		if (this.queueBytes >= MAX_QUEUE_BYTES && !isAgentRunResponse(jsonStr)) {
			this.droppedCount += 1;
			this.droppedBytes += frameBytes;
			// 仅状态翻转点打 log（warn + remoteLog 各一次）；overflow 持续期间所有 drop 静默累加，
			// 避免 UI 离线 + ICE 失败导致 DC 永远不 drain 时的日志刷屏
			if (!this.queueOverflowActive) {
				this.queueOverflowActive = true;
				this.__safeWarn(`overflow-start queueBytes=${this.queueBytes}`);
				this.__safeRemoteLog(`rpc-queue.overflow-start${this.__tagSuffix()} queueBytes=${this.queueBytes}`);
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
					this.__safeWarn(`fast-path send failed: ${err?.message}`);
					return false;
				}
			}
			const bytes = Buffer.byteLength(jsonStr, 'utf8');
			this.queue.push({ data: jsonStr, isString: true, bytes });
			this.queueBytes += bytes;
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
					this.__safeWarn(`fast-path send failed at chunk ${i}/${chunks.length}: ${err?.message}`);
					return false;
				}
			}
		}
		// 剩余 chunk 原子性入队（保证同一消息分片连续，不被其他消息插入）
		for (; i < chunks.length; i += 1) {
			this.queue.push({ data: chunks[i], isString: false, bytes: chunks[i].length });
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
			this.__safeRemoteLog(`rpc-queue.close${this.__tagSuffix()} dropped=${this.droppedCount} droppedBytes=${this.droppedBytes} residualChunks=${residual} residualBytes=${residualBytes}`);
		}
	}

	/** @private 排队持续发送直至 HIGH 水位或队列空 */
	__drain() {
		if (this.closed) return;
		const dc = this.dc;
		while (this.queue.length > 0
			&& dc.readyState === 'open'
			&& dc.bufferedAmount < DC_HIGH_WATER_MARK) {
			const item = this.queue[0];
			try {
				dc.send(item.data);
			} catch (err) {
				this.__safeWarn(`drain send failed: ${err?.message}`);
				return; // 保留队列，等 onclose 统一清理
			}
			this.queue.shift();
			this.queueBytes -= item.bytes;
			// 满 → 未满 状态转换：打一条带累计数的 log，与 overflow-start 对称
			if (this.queueOverflowActive && this.queueBytes < MAX_QUEUE_BYTES) {
				this.queueOverflowActive = false;
				this.__safeInfo(`overflow-end dropped=${this.droppedCount} droppedBytes=${this.droppedBytes}`);
				this.__safeRemoteLog(`rpc-queue.overflow-end${this.__tagSuffix()} dropped=${this.droppedCount} droppedBytes=${this.droppedBytes}`);
			}
		}
	}

	/** @private */
	__tagSuffix() {
		return this.tag ? ` ${this.tag}` : '';
	}

	/**
	 * @private logger.warn 安全包装：吃掉 logger 自身抛的异常，保护 send/__drain 的 no-throw 契约
	 * @param {string} msg
	 */
	__safeWarn(msg) {
		try { this.logger.warn?.(`[rpc-queue${this.__tagSuffix()}] ${msg}`); } catch { /* logger 自身坏了也不能让 send 抛 */ }
	}

	/** @private 同 __safeWarn，info 级别 */
	__safeInfo(msg) {
		try { this.logger.info?.(`[rpc-queue${this.__tagSuffix()}] ${msg}`); } catch { /* logger 自身坏了也不能让 send 抛 */ }
	}

	/** @private remoteLog 安全包装：吃掉 remoteLog 自身抛的异常 */
	__safeRemoteLog(text) {
		try { remoteLog(text); } catch { /* remoteLog 通道坏了也不能让 send 抛 */ }
	}
}

/**
 * 判断一条 JSON 字符串是否为带 runId 的 RPC 响应（用于队列满时白名单豁免）。
 *
 * 命中条件（仅看顶层）：`type === 'res'` 且 `payload.runId` 为 truthy。
 * 设计取舍：硬编码识别、不维护方法白名单表。该条件主要为覆盖 OpenClaw `agent` 二阶段 res
 * 与 `agent.wait` 全部分支（accepted/ok/error/timeout/race/dedupe）；同时也会顺带豁免
 * `chat.send` 等其他顶层带 `runId` 的响应——这类 rsp 极小，加白无副作用。
 * 解析失败或不命中按非白名单处理。
 *
 * @param {string} jsonStr - 待发送的 RPC 帧 JSON 字符串
 * @returns {boolean} 命中白名单返回 true；解析失败或不命中返回 false
 */
function isAgentRunResponse(jsonStr) {
	try {
		const parsed = JSON.parse(jsonStr);
		return parsed?.type === 'res' && Boolean(parsed?.payload?.runId);
	} catch {
		return false;
	}
}
