/**
 * rpc DC 发送链路的"丢弃监视器"——独立模块，与队列容器解耦。
 *
 * 职责：承接 MemoryQueue / FileBackedQueue 的 onDrop 事件，做边沿状态机日志、
 * 累计计数、关闭汇总。容器（队列）只负责数据缓冲，不知道日志策略；监视器只
 * 知道事件，不知道队列内部结构。两者通过 onDrop(reason, size, err?) 契约对接。
 *
 * 设计要点：
 * - 工厂函数 + 闭包，不是 class（与项目其它工具模块一致）
 * - 5 个内部标量 + 1 个 idempotent flag 跟踪状态
 * - logger / remoteLog 调用一律 try/catch 包裹，自身抛不传染调用方
 * - maybeEmitOverflowEnd 反抖动（候选 A）：仅当 memCount===0 && writtenBytes===0 才翻转
 *   B-stage1 阶段 writtenBytes 恒 0（MemoryQueue），等价 memCount===0
 *   B-stage2 切 FBQ 时同一行代码自然抗"刚出列又写盘"的抖动
 *
 * 日志格式约定（与现行 MemoryQueue 内嵌日志保持一致；唯一漂移点是
 * overflow-start 的 queueBytes token：现行取 memBytes，本模块取被拒消息 size，
 * 因为监视器不持队列深度——属可接受漂移）：
 *
 *   warn / remoteLog: rpc-queue.overflow-start conn=X queueBytes=N  (queue-full)
 *   warn / remoteLog: rpc-queue.disk-cap-start  conn=X size=N        (disk-cap)
 *   warn / remoteLog: rpc-queue.fs-broken       conn=X errno=X msg=  (fs-error，sticky)
 *   warn:             [rpc-queue conn=X] oversize size=N             (每条独立)
 *   info / remoteLog: rpc-queue.overflow-end    conn=X dropped=N droppedBytes=M
 *   remoteLog:        rpc-queue.close           conn=X dropped=N droppedBytes=M residualChunks=K residualBytes=L fsBroken=bool lastReason=str
 */

import { remoteLog } from '../remote-log.js';

/**
 * @param {object} opts
 * @param {string} opts.connId - 连接 ID，用于日志 conn=${connId} token
 * @param {{ warn?: Function, info?: Function, error?: Function }} opts.logger
 * @returns {{
 *   onDrop: (reason: string, size: number, err?: { code?: string, message?: string }) => void,
 *   maybeEmitOverflowEnd: (stats: { memCount: number, writtenBytes: number }) => void,
 *   summarize: (residualStats?: { memCount?: number, memBytes?: number }) => void,
 *   getStats: () => { dropCount: number, dropBytes: number, overflowActive: boolean, fsBroken: boolean, lastReason: string|null },
 * }}
 */
export function createRpcDropMonitor({ connId, logger }) {
	let dropCount = 0;
	let dropBytes = 0;
	let overflowActive = false;
	let fsBroken = false; // sticky：一旦 true 不复位
	let lastReason = null;
	let summarized = false; // summarize 幂等 flag

	const tag = `[rpc-queue conn=${connId}]`;

	function safeWarn(msg) {
		try { logger?.warn?.(`${tag} ${msg}`); }
		catch { /* logger 自身坏了也不能让 onDrop 抛 */ }
	}

	function safeInfo(msg) {
		try { logger?.info?.(`${tag} ${msg}`); }
		catch { /* 同上 */ }
	}

	function safeRemoteLog(text) {
		try { remoteLog(text); }
		catch { /* remoteLog 当前同步路径不抛；防御性兜底 */ }
	}

	function onDrop(reason, size, err) {
		dropCount += 1;
		dropBytes += size;
		lastReason = reason;

		if (reason === 'queue-full') {
			if (!overflowActive) {
				overflowActive = true;
				safeWarn(`overflow-start queueBytes=${size}`);
				safeRemoteLog(`rpc-queue.overflow-start conn=${connId} queueBytes=${size}`);
			}
			// 持续期间静默
			return;
		}
		if (reason === 'disk-cap') {
			if (!overflowActive) {
				overflowActive = true;
				safeWarn(`disk-cap-start size=${size}`);
				safeRemoteLog(`rpc-queue.disk-cap-start conn=${connId} size=${size}`);
			}
			return;
		}
		if (reason === 'fs-error') {
			if (!fsBroken) {
				fsBroken = true;
				const errno = err?.code ?? 'UNKNOWN';
				const errMsg = err?.message ?? '';
				safeWarn(`fs-broken errno=${errno} msg=${errMsg}`);
				safeRemoteLog(`rpc-queue.fs-broken conn=${connId} errno=${errno} msg=${errMsg}`);
			}
			return;
		}
		if (reason === 'oversize') {
			// 每次独立 warn，不改 overflowActive
			safeWarn(`oversize size=${size}`);
			return;
		}
		// 未知 reason：仅累加，无 log（防御性）
	}

	function maybeEmitOverflowEnd(stats) {
		if (!overflowActive) return;
		if (stats.memCount === 0 && stats.writtenBytes === 0) {
			overflowActive = false;
			safeInfo(`overflow-end dropped=${dropCount} droppedBytes=${dropBytes}`);
			safeRemoteLog(`rpc-queue.overflow-end conn=${connId} dropped=${dropCount} droppedBytes=${dropBytes}`);
		}
	}

	function summarize(residualStats) {
		if (summarized) return;
		summarized = true;

		const residualChunks = residualStats?.memCount ?? 0;
		const residualBytes = residualStats?.memBytes ?? 0;
		const hasAnomaly = overflowActive || fsBroken || dropCount > 0 || residualChunks > 0;
		if (hasAnomaly) {
			safeRemoteLog(
				`rpc-queue.close conn=${connId} dropped=${dropCount} droppedBytes=${dropBytes}`
				+ ` residualChunks=${residualChunks} residualBytes=${residualBytes}`
				+ ` fsBroken=${fsBroken} lastReason=${lastReason ?? 'none'}`,
			);
		}
		overflowActive = false;
	}

	function getStats() {
		return {
			dropCount,
			dropBytes,
			overflowActive,
			fsBroken,
			lastReason,
		};
	}

	return { onDrop, maybeEmitOverflowEnd, summarize, getStats };
}
