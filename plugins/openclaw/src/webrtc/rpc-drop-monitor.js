/**
 * rpc DC 发送链路的"丢弃监视器"——独立模块，与队列容器解耦。
 *
 * 职责：承接 MemoryQueue / FileBackedQueue 的 onDrop 事件，做边沿状态机日志、
 * 累计计数、关闭汇总。容器（队列）只负责数据缓冲，不知道日志策略；监视器只
 * 知道事件，不知道队列内部结构。两者通过 onDrop(reason, size, err?) 契约对接。
 *
 * 设计要点：
 * - 工厂函数 + 闭包，不是 class（与项目其它工具模块一致）
 * - 6 个内部状态标量（dropCount / dropBytes / overflowActive / spillActive / fsBroken / lastReason）
 *   + 1 个 idempotent flag（summarized）跟踪状态
 * - logger / remoteLog 调用一律 try/catch 包裹，自身抛不传染调用方
 * - maybeEmitOverflowEnd 反抖动（候选 A）：仅当 memCount===0 && writtenBytes===0 才翻转
 *   B-stage1 阶段 writtenBytes 恒 0（MemoryQueue），等价 memCount===0
 *   B-stage2 切 FBQ 时同一行代码自然抗"刚出列又写盘"的抖动
 *
 * 日志格式约定（与现行 MemoryQueue 内嵌日志保持一致；唯一漂移点是
 * overflow-start 的 queueBytes token：现行取 memBytes，本模块取被拒消息 size，
 * 因为监视器不持队列深度——属可接受漂移）：
 *
 *   warn / remoteLog: rpc-queue.overflow-start conn=X queueBytes=N            (queue-full)
 *   warn / remoteLog: rpc-queue.disk-cap-start  conn=X size=N memBytes=M
 *                                               writtenBytes=W diskCap=D     (disk-cap)
 *   warn / remoteLog: rpc-queue.fs-broken       conn=X errno=X msg=          (fs-error，sticky)
 *   warn:             [rpc-queue conn=X] oversize size=N                     (每条独立)
 *   info / remoteLog: rpc-queue.overflow-end    conn=X dropped=N droppedBytes=M
 *   info / remoteLog: rpc-queue.spill-start     conn=X                       (FBQ 文件创建)
 *   info / remoteLog: rpc-queue.spill-end       conn=X drainedBytes=N        (FBQ 文件 drain 删除)
 *   warn / remoteLog: rpc-queue.close           conn=X dropped=N droppedBytes=M
 *                                               residualChunks=K residualBytes=L
 *                                               residualDiskBytes=X residualWrittenBytes=Y
 *                                               fsBroken=bool spillActive=bool lastReason=str
 *                                                                            (anomaly-only；本地 log 与 remoteLog 同字段)
 *
 * spill-start / spill-end 是文件级状态翻转信号：边沿触发，FBQ 在 spilled false→true / true→false
 * 时通过 onSpillStart / onSpillEnd 钩子回调。与 disk-cap-start 是不同维度的事件——
 * disk-cap-start 表示 admission 拒收（队列总占用顶到阈值），spill-start 表示物理文件被创建。
 * MemoryQueue 不调这两个钩子，纯内存路径下不会有 spill 信号。
 *
 * close 日志含两组 disk token（residualDiskBytes/residualWrittenBytes）是为 FBQ 阶段
 * 诊断完整性预留——MemoryQueue 路径下它们恒 0；FBQ 路径下承载磁盘残留信息。
 */

import { remoteLog } from '../remote-log.js';

/**
 * @param {object} opts
 * @param {string} opts.connId - 连接 ID，用于日志 conn=${connId} token
 * @param {{ warn?: Function, info?: Function, error?: Function }} opts.logger
 * @returns {{
 *   onDrop: (reason: string, size: number, err?: { code?: string, message?: string, memBytes?: number, writtenBytes?: number, diskCap?: number }) => void,
 *   onSpillStart: () => void,
 *   onSpillEnd: (drainedBytes: number) => void,
 *   maybeEmitOverflowEnd: (stats: { memCount: number, writtenBytes: number }) => void,
 *   summarize: (residualStats?: { memCount?: number, memBytes?: number, diskBytes?: number, writtenBytes?: number, fsBroken?: boolean }) => void,
 *   getStats: () => { dropCount: number, dropBytes: number, overflowActive: boolean, fsBroken: boolean, lastReason: string|null, spillActive: boolean },
 * }}
 */
export function createRpcDropMonitor({ connId, logger }) {
	let dropCount = 0;
	let dropBytes = 0;
	let overflowActive = false;
	let spillActive = false; // 文件层翻转标志：FBQ 物理文件存在时 true，drain 删除时 false
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
				// 把 mem/written/cap 三个分量都带上：disk-cap 不是"文件满了"语义，
				// 是 mem+writtenBytes 总占用顶到 diskCap 阈值，分量让运维能直接看到谁顶到 cap。
				const memBytes = err?.memBytes ?? 0;
				const writtenBytes = err?.writtenBytes ?? 0;
				const diskCap = err?.diskCap ?? 0;
				safeWarn(`disk-cap-start size=${size} memBytes=${memBytes} writtenBytes=${writtenBytes} diskCap=${diskCap}`);
				safeRemoteLog(`rpc-queue.disk-cap-start conn=${connId} size=${size} memBytes=${memBytes} writtenBytes=${writtenBytes} diskCap=${diskCap}`);
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

	// 文件创建：FBQ spilled 翻转 false→true 时调一次。边沿触发，幂等（重复 active 不重 emit）。
	function onSpillStart() {
		if (spillActive) return;
		spillActive = true;
		safeInfo('spill-start');
		safeRemoteLog(`rpc-queue.spill-start conn=${connId}`);
	}

	// 文件删除（drain 完成）：FBQ spilled 翻转 true→false 时调一次。drainedBytes = __dropFile 前的 writtenBytes。
	// 故障删档（__handleFsError 内的 fs.rm）由 fs-broken 信号承载，不复用此钩子。
	function onSpillEnd(drainedBytes) {
		if (!spillActive) return;
		spillActive = false;
		safeInfo(`spill-end drainedBytes=${drainedBytes}`);
		safeRemoteLog(`rpc-queue.spill-end conn=${connId} drainedBytes=${drainedBytes}`);
	}

	function maybeEmitOverflowEnd(stats) {
		if (!overflowActive) return;
		if (!stats) return; // 防御：调用方应传 queue.stats()，但 stats 为 null/undefined 时安全跳过
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
		const residualDiskBytes = residualStats?.diskBytes ?? 0;
		const residualWrittenBytes = residualStats?.writtenBytes ?? 0;
		// 队列实际 fsBroken 状态：FBQ 经异步路径（writeStream emit error / refill stat err / bypass overshoot 全程仅 mem）可让 fsBroken=true 而 monitor 从未收到 onDrop('fs-error')。
		// 这里用 residualStats.fsBroken 兜住，让 close 日志反映队列真实降级状态，避免运维侧只能从内部 fsBroken 标量看到"没坏"的假象。
		const residualFsBroken = residualStats?.fsBroken === true;
		const effectiveFsBroken = fsBroken || residualFsBroken;
		// spillActive 也作为 anomaly 信号：destroy 时 spill 文件没 drain 完（onSpillEnd 没触发）
		// 通常会让 residualWrittenBytes/residualDiskBytes>0 间接触发 close 日志，但显式纳入
		// spillActive 避免日后 stats 路径漂移（如延迟清空）让"以 spill 状态结束"静默
		const hasAnomaly = overflowActive || spillActive || effectiveFsBroken || dropCount > 0
			|| residualChunks > 0 || residualDiskBytes > 0 || residualWrittenBytes > 0;
		if (hasAnomaly) {
			// 字段表（顺序与 remoteLog 完全一致，便于 server / 本地 log 对齐 grep）
			const fields = `dropped=${dropCount} droppedBytes=${dropBytes}`
				+ ` residualChunks=${residualChunks} residualBytes=${residualBytes}`
				+ ` residualDiskBytes=${residualDiskBytes} residualWrittenBytes=${residualWrittenBytes}`
				+ ` fsBroken=${effectiveFsBroken} spillActive=${spillActive}`
				+ ` lastReason=${lastReason ?? 'none'}`;
			// 本地 log 镜像：close 是 session 收尾的异常汇总，开发者主要看本地 log 排查。
			// 与 overflow-start/disk-cap-start/fs-broken 同级别用 warn——只有 anomaly 时才发。
			safeWarn(`close ${fields}`);
			safeRemoteLog(`rpc-queue.close conn=${connId} ${fields}`);
		}
		overflowActive = false;
	}

	function getStats() {
		return {
			dropCount,
			dropBytes,
			overflowActive,
			spillActive,
			fsBroken,
			lastReason,
		};
	}

	return { onDrop, onSpillStart, onSpillEnd, maybeEmitOverflowEnd, summarize, getStats };
}
