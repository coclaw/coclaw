import { randomUUID } from 'node:crypto';

import { createReassembler } from './dc-chunking.js';
import { MemoryQueue } from '../utils/memory-queue.js';
import { FileBackedQueue } from '../utils/file-backed-queue.js';
import { RpcDcSender, DC_LOW_WATER_MARK, MAX_SINGLE_MSG_BYTES } from './rpc-dc-sender.js';
import { createRpcDropMonitor } from './rpc-drop-monitor.js';
import { isAgentRunResponse } from './agent-run-response.js';
import { remoteLog } from '../remote-log.js';

// rpc DC 发送队列实现选择（B-stage2 B9b）。
// - 'fbq'：FileBackedQueue（当前生产默认）—— 长时间后台 / ICE 恢复等慢消化场景溢出到磁盘
// - 'mem'：MemoryQueue —— 不碰 fs，溢出即 drop（紧急回退用，0.20.1~0.20.2 期间临时启用）
// 当 'fbq' 但 queueDir 不可用（bridge 启动期 plan-2 prep 失败）时自动降级到 'mem'，避免阻塞 webrtc 装配。
// 单点常量；构造时可通过 `rpcQueueImpl` opt 覆盖（测试用）。紧急回退到 'mem' 只需翻这一行。
const RPC_QUEUE_IMPL = 'fbq';

// FBQ 装配兜底：bridge 启动期 measureDiskCap 失败 → __diskCap=null → 这里兜底 1GB
const ONE_GB = 1024 * 1024 * 1024;
const RPC_QUEUE_MEM_BUDGET = 10 * 1024 * 1024;

// 单个 session 内 file DC 历史快照的容量上限（满后按 FIFO 淘汰最老条目）。
// 用于诊断 dump：过大会撑爆 remoteLog 单帧，20 足以覆盖典型多文件传输会话。
const FILE_CHANNEL_HISTORY_LIMIT = 20;

// Failed session 保留 12 小时，支持 Capacitor 后台恢复后 ICE restart。
// 超时后 session 被回收释放 IPC listeners 和 Go 侧资源。
const FAILED_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// Session 总数上限（活跃 + failed）。溢出时淘汰最旧的 failed session。
// 10 足以覆盖多 UI 实例（浏览器多标签 + 移动端）的典型场景。
const MAX_SESSIONS = 10;

/**
 * 管理多个 WebRTC PeerConnection（以 connId 为粒度）。
 * Plugin 作为被叫方：收到 UI 的 offer → 回复 answer。
 */
export class WebRtcPeer {
	/**
	 * @param {object} opts
	 * @param {function} opts.onSend - 将信令消息交给 RealtimeBridge 发送
	 * @param {function} [opts.onRequest] - DataChannel 收到 req 消息时的回调 (payload, connId) => void
	 * @param {function} [opts.onFileRpc] - rpc DC 上 coclaw.files.* 请求的回调 (payload, sendFn, connId) => void
	 * @param {function} [opts.onFileChannel] - file:<transferId> DataChannel 的回调 (dc, connId) => void
	 * @param {object} [opts.logger] - pino 风格 logger
	 * @param {function} opts.PeerConnection - RTCPeerConnection 构造函数（由 ndc-preloader 提供）
	 * @param {string} [opts.impl] - WebRTC 实现标识（pion / ndc / werift）
	 * @param {() => (number|null)} [opts.getDiskCap] - 启动期测得的 diskCap 字节数；prep 失败返 null。
	 *   FBQ 装配时取（兜底 1GB）；MemoryQueue 装配不消费。
	 * @param {string} [opts.queueDir] - rpc DC 队列文件目录（FBQ 模式所需）；空 / 非字符串时降级到 MemoryQueue
	 * @param {'fbq'|'mem'} [opts.rpcQueueImpl] - rpc 队列实现选择，默认取模块级 RPC_QUEUE_IMPL；
	 *   测试用——生产路径走默认即可
	 */
	constructor({ onSend, onRequest, onFileRpc, onFileChannel, logger, PeerConnection, impl, getDiskCap, queueDir, rpcQueueImpl }) {
		if (!PeerConnection) {
			throw new Error('PeerConnection constructor is required');
		}
		this.__onSend = onSend;
		this.__onRequest = onRequest;
		this.__onFileRpc = onFileRpc;
		this.__onFileChannel = onFileChannel;
		this.logger = logger ?? console;
		this.__PeerConnection = PeerConnection;
		this.__impl = impl ?? null;
		// 非函数（含 undefined / null / 字符串等）一律收编为 null，调用时再做 null 兜底
		this.__getDiskCap = typeof getDiskCap === 'function' ? getDiskCap : null;
		// FBQ 文件根目录；非字符串 / 空字符串 → null → 装配时自动降级到 MemoryQueue
		this.__queueDir = typeof queueDir === 'string' && queueDir.length > 0 ? queueDir : null;
		// 队列实现选择：测试可显式覆盖；非 'fbq'/'mem' 一律收编为模块默认，避免误用
		this.__rpcQueueImpl = (rpcQueueImpl === 'fbq' || rpcQueueImpl === 'mem') ? rpcQueueImpl : RPC_QUEUE_IMPL;
		this.__rtcTag = impl ? `[coclaw/rtc:${impl}]` : '[coclaw/rtc]';
		/** @type {Map<string, { pc: object, connId: string, rpcChannel: object|null, rpcQueue: MemoryQueue|null, rpcDcSender: RpcDcSender|null, rpcConsumeLoop: Promise<void>|null, rpcDropMonitor: object|null, fileChannels: Set, remoteMaxMessageSize: number, nextMsgId: number }>} */
		this.__sessions = new Map();
		// per-connId 信令串行化队列：把外线 ws 信令处理改成"按 connId 维护 FIFO 队列"，
		// 消息按到达顺序串行处理。替换原 offerMutex 方案——后者的 await prev 微任务跳板
		// 会让 setRemoteDescription 的 IPC 字节序被推到紧随而至的 ICE 候选之后，导致冷
		// 启动时部分 ICE 候选撞"remote description is not set"被 pion 丢弃。
		//
		// 队列与 sessions 生命周期完全解耦：closeByConnId / closeAll / failed-TTL 等 session
		// 清理路径不动 __signalingQueues；唯一删除路径是 drain 跑空后自删 entry，下条同
		// connId 消息进来再按需重建。
		/** @type {Map<string, { queue: Array<{ msg: object, doneCb: () => void }>, running: boolean }>} */
		this.__signalingQueues = new Map();
		// 关停门禁：closeAll 入口立即置 true，后续 drain / __handleOffer 在 await 边界看到
		// __stopping 即放弃后续动作，避免在 plugin 关停期间继续新建/响应 PC。
		this.__stopping = false;
	}

	/**
	 * 处理来自 Server 转发的信令消息。
	 *
	 * 入队即调度，每条消息附带 doneCb；caller `await handleSignaling(msg)` 会等本条 msg
	 * 真正 drain 完毕（含错误被 drain 内 catch 转 remoteLog 的情形）才回。错误不再冒到
	 * 调用方——`rtc.signaling-error` remoteLog 是单一来源，由 drain 的 per-item catch 输出。
	 *
	 * 同 connId 的多条消息严格 FIFO；不同 connId 互不阻塞（每个 connId 自己一条 drain
	 * 微任务链）。冷启动 1 offer + 5 ICE 并发投递时，drain 保证 SRD 完整跑完后再发 ICE
	 * 的 addIceCandidate，避免 pion 端"remote description is not set"丢候选。
	 */
	async handleSignaling(msg) {
		const connId = msg?.fromConnId ?? msg?.toConnId;
		if (!connId) return;
		return new Promise((resolve) => {
			this.__enqueueSignaling(connId, msg, resolve);
		});
	}

	__enqueueSignaling(connId, msg, doneCb) {
		let state = this.__signalingQueues.get(connId);
		if (!state) {
			state = { queue: [], running: false };
			this.__signalingQueues.set(connId, state);
		}
		state.queue.push({ msg, doneCb });
		// fire-and-forget 触发 drain；running flag 保证只有第一条入队的 caller 启动真实 drain，
		// 后续入队的 caller 走 push + 由当前 drain 顺序消化。drain 自身用 try/finally 兜底，
		// per-item 诊断调用也都包了 try/catch；这里再加一层 .catch() 兜 unhandled rejection
		// 的极冷防御——CoClaw plugin 强约束要求"不许带垮 gateway"。
		this.__drainSignaling(connId, state).catch((err) => {
			/* c8 ignore start -- drain 内部 try/finally + per-item try/catch 已覆盖；此 catch 仅极冷防御 */
			try {
				this.logger.error?.(`${this.__rtcTag} __drainSignaling unhandled error conn=${connId}: ${err?.message ?? err}`);
			} catch {
				/* swallow */
			}
			/* c8 ignore stop */
		});
	}

	async __drainSignaling(connId, state) {
		if (state.running) return;
		// 同步置位：入口到首次 await 之间不能让步，否则同 tick 内多次 enqueue 会双开 drain。
		state.running = true;
		try {
			while (state.queue.length > 0) {
				// 关停门禁：closeAll 已置位时，剩余信令全部丢弃但仍 fire 每条 doneCb，
				// 防止 caller `await handleSignaling` 悬挂（队列在 finally 内删除 entry）。
				if (this.__stopping) {
					for (const item of state.queue) {
						/* c8 ignore next 2 -- doneCb 是构造时塞入的 Promise resolver，理论上不抛；try 仅极冷防御 */
						try { item.doneCb?.(); } catch { /* swallow */ }
					}
					state.queue.length = 0;
					break;
				}
				const item = state.queue.shift();
				try {
					await this.__handleSignalingMsg(item.msg);
				} catch (err) {
					// 单条信令出错不打断 drain；与 realtime-bridge 原 outer catch 的诊断格式对齐。
					// 诊断调用各自 try/catch：若 logger / remoteLog 自身抛错（极冷），不能让异常
					// 冒出 per-item catch 阻断后续 doneCb fire（CoClaw plugin "不许带垮 gateway"
					// 强约束 + 防止 caller `await handleSignaling` 永挂）。
					const t = item.msg?.type ?? 'unknown';
					/* c8 ignore next 2 -- 诊断 wrap 是极冷防御，注入的 logger 不抛 */
					try { this.logger.warn?.(`${this.__rtcTag} signaling error type=${t} conn=${connId}: ${err?.message}`); } catch { /* swallow */ }
					/* c8 ignore next 2 -- 同上 */
					try { this.__remoteLog(`rtc.signaling-error type=${t} conn=${connId} msg=${err?.message}`); } catch { /* swallow */ }
				} finally {
					// 始终 fire doneCb（即便 await 抛错或 logger 自身抛错），caller 不悬挂。
					/* c8 ignore next 2 -- 同上，doneCb 是 Promise resolver；try 仅极冷防御 */
					try { item.doneCb?.(); } catch { /* swallow */ }
				}
			}
		} finally {
			state.running = false;
			if (state.queue.length === 0) {
				// 同 connId 旧 entry 可能在 drain 期间被替换；仅当 map 仍指向本 state 时才删，
				// 避免误删新 entry。
				if (this.__signalingQueues.get(connId) === state) {
					this.__signalingQueues.delete(connId);
				}
				/* c8 ignore start -- 防御性兜底；正常控制流 while 退出时 queue.length 必为 0 */
			} else {
				// 契约违反：while 条件按 length>0 进，__stopping 分支 break 前会 length=0，
				// 正常退出意味着 queue 已空——理论不可达。不主动重启 drain（running 已落 false，
				// 下条 enqueue 自然 kick off 消化残留），保留 entry 以便后续 drain 继续处理。
				this.logger.error?.(`${this.__rtcTag} __drainSignaling exited with non-empty queue conn=${connId} len=${state.queue.length}`);
				this.__remoteLog(`drain.contract-violation conn=${connId} len=${state.queue.length}`);
			}
			/* c8 ignore stop */
		}
	}

	/** 单条信令的 type→handler 分发（drain 内部调用，外部测试可直接复用 handleSignaling） */
	async __handleSignalingMsg(msg) {
		const connId = msg.fromConnId ?? msg.toConnId;
		if (msg.type === 'rtc:offer') {
			await this.__handleOffer(msg);
		} else if (msg.type === 'rtc:ice') {
			await this.__handleIce(msg);
		} else if (msg.type === 'rtc:ready' || msg.type === 'rtc:closed') {
			this.__logDebug(`${msg.type} from ${connId}`);
			if (msg.type === 'rtc:closed') {
				const session = this.__sessions.get(connId);
				if (session) await this.closeByConnId(connId, session);
			}
		}
	}

	/**
	 * 关闭指定 session：身份守卫确保 connId 仍指向 expectedSession 时才动手，
	 * 否则 no-op（session 已被同步段五件事原子替换 / 旧 close 已完成 / 等）。
	 * @param {string} connId
	 * @param {object} expectedSession - 调用方持有的 session 引用；nullish 视为 no-op。
	 */
	async closeByConnId(connId, expectedSession) {
		if (!expectedSession) return;
		if (this.__sessions.get(connId) !== expectedSession) return;
		const session = expectedSession;
		// 同步段顺序：先 delete map，再 detach handler + clear timer，最后进入 fire-and-forget
		// 兼容的异步收尾（sender/queue/pc.close）。三步同步、彼此间无 await，外部异步观察者
		// （并发 offer / pc.close 滞后回调）看到的是整段原子切换，故 delete 提前不改变原有两条
		// 保证：(1) pc.close 期间的滞后回调不会误改新 session（detach 仍在 pc.close 之前）；
		// (2) sessions.get(connId) 删表后立即返回 undefined，并发 offer 走替换路径而非误以为
		// "close 还在跑"。delete 必须排在任何可能抛错的同步步骤之前：closeAll drain 用
		// per-session catch 吞掉单个 reject，若 detach/clear 在 delete 前抛错，session 会残留在
		// 表里让 while-drain 死循环、拖挂 gateway——delete 先行使这条不变量无条件成立。
		this.__sessions.delete(connId);
		this.__detachPcHandlers(session);
		this.__clearSessionSyncState(session);
		await this.__finalizeSessionAsync(session);
		this.__remoteLog(`rtc.closed conn=${connId}`);
		this.logger.info?.(`${this.__rtcTag} [${connId}] closed`);
	}

	/**
	 * 关闭所有 PeerConnection。每轮快照表内当前所有 session 并发关闭，
	 * 表非空就继续 drain——若 closeAll await Promise.all 期间另一条 message handler
	 * 已过 sock guard 并落地新 session（auth-close / stop 窄缝），下一轮把它收掉，
	 * 结构性消除"快照漏掉新 session"的 race，不必依赖 12h failed-TTL 兜底。
	 *
	 * 终止条件：调用方（realtime-bridge auth-close / stop）已先关 server WS，
	 * 不会再有新 rtc:offer 涌入，drain 至多一两轮就达表空。
	 */
	async closeAll() {
		// 关停门禁：drain 与 __handleOffer 看到 __stopping 后立刻放弃后续动作，
		// 配合 while-drain 兜底"snapshot 漏掉新 session"竞态。__stopping 一旦置 true
		// 不再重置——本插件 closeAll 调用方（auth-close / 析构）均紧跟 webrtcPeer = null，
		// 下次复用会建新实例从 false 起。
		this.__stopping = true;
		while (this.__sessions.size > 0) {
			// per-session catch：单个 closeByConnId reject 不能中断其余 session 的清理，也不能
			// 打断 while-drain 兜底循环。session 在 closeByConnId 首个 await 前已同步从 Map 删除，
			// 故失败的 session 不会被下一轮重复处理、也不会无限循环。失败降级为 warn 诊断而非
			// 静默全吞，保留定位线索。
			const closing = [...this.__sessions.values()].map((s) =>
				this.closeByConnId(s.connId, s).catch((err) => {
					this.logger.warn?.(`${this.__rtcTag} [${s.connId}] closeByConnId failed during closeAll: ${err?.message ?? err}`);
				}),
			);
			await Promise.all(closing);
		}
	}

	/**
	 * 同步 detach PC 上 6 个 handler。防止 pc.close 异步触发的滞后回调
	 * 通过 sessions.get(connId) 误访问已被替换/正在替换的新 session。
	 */
	__detachPcHandlers(session) {
		session.pc.onconnectionstatechange = null;
		session.pc.onicecandidate = null;
		session.pc.ondatachannel = null;
		if ('onselectedcandidatepairchange' in session.pc) {
			session.pc.onselectedcandidatepairchange = null;
		}
		if ('oniceconnectionstatechange' in session.pc) {
			session.pc.oniceconnectionstatechange = null;
		}
		if ('onicegatheringstatechange' in session.pc) {
			session.pc.onicegatheringstatechange = null;
		}
	}

	/** 同步清 session 上的 timer 与 in-flight 标志，避免 close 后还在 fire 副作用。 */
	__clearSessionSyncState(session) {
		if (session.__failedTimer) {
			clearTimeout(session.__failedTimer);
			session.__failedTimer = null;
		}
		if (session.__pluginProbeSchedTimer) {
			clearTimeout(session.__pluginProbeSchedTimer);
			session.__pluginProbeSchedTimer = null;
		}
		if (session.__pluginProbeTimer) {
			clearTimeout(session.__pluginProbeTimer);
			session.__pluginProbeTimer = null;
			session.__pluginProbeInFlight = null;
		}
	}

	/**
	 * 异步收尾：rpc 链路 destroy + monitor summarize + pc.close。可作为 fire-and-forget 跑
	 * （同步段非 ICE 重发替换旧 session 时），也作为 closeByConnId 的 await 末段。
	 * 调用前必须已完成 __detachPcHandlers + __clearSessionSyncState + sessions.delete，否则
	 * 滞后回调可能踩新 session。
	 */
	async __finalizeSessionAsync(session) {
		if (session.rpcDcSender || session.rpcQueue) {
			session.rpcDcSender?.close();
			const monRef = session.rpcDropMonitor;
			await session.rpcQueue?.destroy((residual) => { monRef?.summarize(residual); });
			if (session.rpcConsumeLoop) await session.rpcConsumeLoop.catch(() => {});
			session.rpcDcSender = null;
			session.rpcQueue = null;
			session.rpcConsumeLoop = null;
			session.rpcDropMonitor = null;
			session.rpcChannel = null;
		}
		await session.pc.close();
	}

	/**
	 * 向所有已打开的 rpcChannel 广播（大消息自动分片，经由 FBQ/MemoryQueue + RpcDcSender 流控）。
	 * @param {object} payload - 完整的 JSON 帧
	 * @param {string} [rawStr] - 已序列化字符串旁路：非空字符串且不含字面 \n/\r 时直接透传，
	 *                            跳过 stringify；含换行或类型不符时回退到 JSON.stringify(payload)。
	 *                            用于 gateway WS → DC 转发链路，省掉对大 payload（如 agent.run.event
	 *                            含大 tool_result / compaction summary）的主线程重复序列化阻塞。
	 */
	broadcast(payload, rawStr) {
		const jsonStr = this.__resolveJsonStr(payload, rawStr, 'broadcast');
		if (jsonStr === null) return;
		for (const session of this.__sessions.values()) {
			const q = session.rpcQueue;
			if (q && session.rpcChannel?.readyState === 'open') {
				// fire-and-forget：admission 决策返回 boolean Promise，broadcast 不关心结果；
				// 内部异常（mutex 等极冷路径）catch 防 unhandled rejection
				q.enqueue(jsonStr).catch((err) => {
					/* c8 ignore next -- enqueue 仅在 mutex 异常等极冷路径 reject；类型校验已由调用方完成 */
					this.__logDebug(`broadcast enqueue error: ${err?.message}`);
				});
			}
		}
	}

	/**
	 * 向指定 connId 的 rpc DC 单播一个 JSON 帧（不走 server 中转）。
	 * 若 session/DC 未就绪或被发送队列拒收（队列满等）返回 false，由调用方决定是否重试。
	 *
	 * 阶段 1 改造：enqueue 是 async（mutex 内 admission 决策），sendTo 也变 async；调用方
	 * 已在 async 上下文（realtime-bridge.js 的 ws.message handler），增加 `await` 即可。
	 *
	 * @param {string} connId
	 * @param {object} payload - 完整的 JSON 帧（通常是 { type: 'event', event, payload }）
	 * @param {string} [rawStr] - 已序列化字符串旁路：语义同 broadcast 的 rawStr 参数
	 * @returns {Promise<boolean>} true=已入队发送；false=session 不存在 / DC 未 open / payload 不可序列化 / 发送队列拒收
	 */
	async sendTo(connId, payload, rawStr) {
		const session = this.__sessions.get(connId);
		if (!session) return false;
		const q = session.rpcQueue;
		if (!q || session.rpcChannel?.readyState !== 'open') return false;
		const jsonStr = this.__resolveJsonStr(payload, rawStr, `[${connId}] sendTo`);
		if (jsonStr === null) return false;
		try {
			return await q.enqueue(jsonStr);
		} catch (err) {
			/* c8 ignore next 3 -- enqueue 仅在 mutex 异常等极冷路径 reject；与 broadcast/file sendFn 对称 */
			this.__logDebug(`[${connId}] sendTo enqueue error: ${err?.message}`);
			return false;
		}
	}

	/**
	 * 把 (payload, rawStr) 归一为可入队的 JSON 字符串。
	 * 直通条件：rawStr 为非空字符串且不含字面 \n/\r。
	 * 回退路径：含换行或类型不符时走 JSON.stringify(payload)；并对 stringify 抛 / 返非字符串做防御。
	 *
	 * 为何排除字面换行：rpcQueue 的 FBQ 实现在溢出到磁盘时按 JSONL 格式（rec + '\n'）追加，
	 * 用 readline 回填——若入队字符串内含字面 \n/\r 会切坏 spill 文件。旧 stringify 路径输出
	 * 紧凑无换行天然满足；新 raw 直通必须保持同等强度的入队不变量。
	 *
	 * @param {object} payload
	 * @param {string} [rawStr]
	 * @param {string} tag - 日志前缀（broadcast / [connId] sendTo）
	 * @returns {string | null} 可入队的 JSON 字符串；null 表示丢弃（stringify 抛 / 返非字符串）
	 */
	__resolveJsonStr(payload, rawStr, tag) {
		if (typeof rawStr === 'string' && rawStr.length > 0) {
			if (!rawStr.includes('\n') && !rawStr.includes('\r')) {
				return rawStr;
			}
			// 含换行 → 走 stringify 重做归一化（保 FBQ JSONL 行约束）
			this.__logDebug(`${tag} rawStr fallback: contains newline`);
		}
		try {
			const jsonStr = JSON.stringify(payload);
			// payload 是 undefined/symbol 时 stringify 返回 undefined
			if (typeof jsonStr !== 'string') return null;
			return jsonStr;
		} catch (err) {
			// 循环引用 / BigInt 等导致 stringify 抛——记日志后整条丢弃，不冒到 gateway
			this.__logDebug(`${tag} stringify failed: ${err?.message}`);
			return null;
		}
	}

	async __handleOffer(msg) {
		// 关停门禁：closeAll 已置 __stopping 后任何 offer 都不再创建 session 或回 answer，
		// 与 drain 顶端的 __stopping 检查互为冗余（drain 抢先一步，但 __handleOffer 入口
		// 这条是"今天每条无害不代表明天加副作用还无害"的稳健补丁）。
		if (this.__stopping) return;

		const connId = msg.fromConnId;
		const isIceRestart = !!msg.payload?.iceRestart;

		// no-session ICE restart：立即 reject，不建 session。
		if (isIceRestart && !this.__sessions.has(connId)) {
			const credRemain = this.__credRemainSec(msg.turnCreds);
			const credRemainStr = credRemain ?? 'none';
			this.__remoteLog(`rtc.ice-restart-no-session conn=${connId} credRemain=${credRemainStr}`);
			this.logger.warn?.(`${this.__rtcTag} ICE restart from ${connId} but no session, rejecting`);
			this.__onSend({
				type: 'rtc:restart-rejected',
				toConnId: connId,
				payload: { reason: 'no_session' },
			});
			return;
		}

		let session;
		if (isIceRestart) {
			// ICE restart：复用现有 session
			session = this.__sessions.get(connId);
		} else {
			// 非 ICE：必要时同步替换旧 session。五件事原子（JS 单线程保证不与并发 offer 交错）：
			// (a) detach 旧 PC handler  (b) clear 旧 session 同步状态  (c) sessions.delete
			// (d) 触发 fire-and-forget 异步收尾（闭包持旧 session 引用，不按 connId 查表）
			// (e) 建新 session + wire handler + sessions.set —— 由 __createSession 完成
			const oldSession = this.__sessions.get(connId);
			if (oldSession) {
				this.__detachPcHandlers(oldSession);
				this.__clearSessionSyncState(oldSession);
				this.__sessions.delete(connId);
				this.__finalizeSessionAsync(oldSession).catch((err) => {
					/* c8 ignore next 2 -- finalize 内 pc.close 在生产路径稳定；防 unhandled rejection */
					this.logger.warn?.(`${this.__rtcTag} [${connId}] background finalize failed: ${err?.message ?? err}`);
				});
				this.__remoteLog(`rtc.closed conn=${connId}`);
				this.logger.info?.(`${this.__rtcTag} [${connId}] closed`);
			}
			if (this.__sessions.size >= MAX_SESSIONS) {
				this.__evictOldestFailed();
			}
			session = this.__createSession(msg, connId);
		}

		// SDP 协商：原 __handleOfferLocked 主体直接嵌入，删除 offerMutex.withLock 包裹。
		// per-connId FIFO drain 已保证同 connId 信令串行；mutex.withLock 的 await prev
		// microtask 让步即是冷启动 ICE 候选撞 SRD 未设的根因，移除后顺序恢复："offer→ICE→ICE..."
		// 的 ws 到达顺序在 pion-ipc 端被原样保留。
		//
		// 三段 await 间的身份重核仍保留：可在 await 中途删 session 的路径只剩"不走信令
		// 队列"那几条——connectionState=closed/failed-TTL 同步触发 closeByConnId、
		// closeAll 外线调用、闭包别处直接调 closeByConnId。rtc:closed 现在走 FIFO drain，
		// 不会在同 connId 三段 await 间插入；最多排在 offer 后面、offer 完成发出 answer
		// 后才被处理（UI 端 setRemoteDescription 已 try/catch，stale answer 无回归）。
		// 命中身份重核即丢弃后续动作，不发 stale rtc:answer。
		const credRemain = this.__credRemainSec(msg.turnCreds);
		const credRemainStr = credRemain ?? 'none';

		if (isIceRestart) {
			// 仅已验证支持 ICE restart 的 impl 放行，其余立即 reject 让 UI 走 rebuild
			if (this.__impl !== 'pion') {
				this.__remoteLog(`rtc.ice-restart-unsupported conn=${connId} impl=${this.__impl} credRemain=${credRemainStr}`);
				this.logger.info?.(`${this.__rtcTag} ICE restart rejected: impl=${this.__impl} not verified`);
				this.__onSend({
					type: 'rtc:restart-rejected',
					toConnId: connId,
					payload: { reason: 'impl_unsupported' },
				});
				return; // TTL timer 保持不变（reject 是同步的，不影响 timer 正常工作）
			}
			// 暂停 failed TTL timer：pion restart 涉及异步协商，期间不应被回收
			if (session.__failedTimer) {
				clearTimeout(session.__failedTimer);
				session.__failedTimer = null;
			}
			this.__remoteLog(`rtc.ice-restart conn=${connId} credRemain=${credRemainStr}`);
			this.logger.info?.(`${this.__rtcTag} ICE restart offer from ${connId}, renegotiating`);
			try {
				await session.pc.setRemoteDescription({ type: 'offer', sdp: msg.payload.sdp });
				// 身份重核：能在三连 await 中间删 session 的路径都不走信令队列——
				// connectionState=closed/failed-TTL 同步触发 closeByConnId、closeAll 外线调用、
				// 闭包别处直调 closeByConnId。命中即丢弃后续动作，不发 stale rtc:answer。
				// logger.info 仅本地诊断，不上 remoteLog（closeByConnId 触发方自带 rtc.closed /
				// rtc.state 等远程日志，server 端能从那侧还原"PC 哪一刻死了"）。
				if (this.__sessions.get(connId) !== session) {
					this.logger.info?.(`${this.__rtcTag} [${connId}] ICE restart aborted: session changed after setRemoteDescription`);
					return;
				}
				// 重协商 SDP 可能变更 a=max-message-size，同步刷新 sender 分片阈值；
				// queue 存的是完整字符串（buildChunks 在 sender.send 内同步完成），
				// 已开始分片的当前消息用旧 size，下一条消息用新 size
				const newMMS = this.__resolveMaxMessageSize(session.pc, msg.payload.sdp);
				if (newMMS !== session.remoteMaxMessageSize) {
					session.remoteMaxMessageSize = newMMS;
					if (session.rpcDcSender) session.rpcDcSender.maxMessageSize = newMMS;
				}
				const answer = await session.pc.createAnswer();
				if (this.__sessions.get(connId) !== session) {
					this.logger.info?.(`${this.__rtcTag} [${connId}] ICE restart aborted: session changed after createAnswer`);
					return;
				}
				await session.pc.setLocalDescription(answer);
				if (this.__sessions.get(connId) !== session) {
					this.logger.info?.(`${this.__rtcTag} [${connId}] ICE restart aborted: session changed after setLocalDescription`);
					return;
				}
				this.__onSend({
					type: 'rtc:answer',
					toConnId: connId,
					payload: { sdp: answer.sdp },
				});
				this.__remoteLog(`rtc.restart-answer-sent conn=${connId}`);
				this.logger.info?.(`${this.__rtcTag} ICE restart answer sent to ${connId}`);
				return;
			} catch (err) {
				// 身份重核：session 已被中途关掉时 catch 收到的 err 是"PC 已 close"残响，
				// 不应再发 stale restart-rejected（用户会看到误报失败），也不重复调 closeByConnId
				// （session 已删，再调是 no-op 但徒增 rtc.closed 日志噪声）。
				if (this.__sessions.get(connId) !== session) {
					this.logger.info?.(`${this.__rtcTag} [${connId}] ICE restart error after session change (suppressed): ${err?.message}`);
					return;
				}
				// ICE restart 协商失败 → reject，不 fall through
				this.__remoteLog(`rtc.ice-restart-failed conn=${connId} credRemain=${credRemainStr}`);
				this.logger.warn?.(`${this.__rtcTag} ICE restart failed for ${connId}: ${err?.message}`);
				this.__onSend({
					type: 'rtc:restart-rejected',
					toConnId: connId,
					payload: { reason: 'restart_failed' },
				});
				await this.closeByConnId(connId, session).catch((closeErr) => {
					/* c8 ignore next -- closeByConnId 内部已 try/catch，此路径极难触发 */
					this.logger.warn?.(`${this.__rtcTag} closeByConnId failed after restart rejection for ${connId}: ${closeErr?.message}`);
				});
				return;
			}
		}

		// 首次 offer：session 已由 sync gate 建好（含 wire 全部 PC handler 与 sessions.set），
		// 锁内只跑 SDP 协商三段 await。每段后做身份重核：pion-ipc 不在 pc.close 时 reject
		// in-flight 请求，过期 setRemoteDescription / createAnswer / setLocalDescription 可能
		// 正常 resolve，身份重核拦截"已被替换的 session 发出 stale answer"。
		this.__remoteLog(`rtc.offer conn=${connId}`);
		this.logger.info?.(`${this.__rtcTag} offer received from ${connId}, creating answer`);
		try {
			await session.pc.setRemoteDescription({ type: 'offer', sdp: msg.payload.sdp });
			if (this.__sessions.get(connId) !== session) {
				this.logger.info?.(`${this.__rtcTag} [${connId}] first offer aborted: session changed after setRemoteDescription`);
				return;
			}
			const answer = await session.pc.createAnswer();
			if (this.__sessions.get(connId) !== session) {
				this.logger.info?.(`${this.__rtcTag} [${connId}] first offer aborted: session changed after createAnswer`);
				return;
			}
			await session.pc.setLocalDescription(answer);
			if (this.__sessions.get(connId) !== session) {
				this.logger.info?.(`${this.__rtcTag} [${connId}] first offer aborted: session changed after setLocalDescription`);
				return;
			}
			this.__onSend({
				type: 'rtc:answer',
				toConnId: connId,
				payload: { sdp: answer.sdp },
			});
			this.__remoteLog(`rtc.answer conn=${connId}`);
			this.logger.info?.(`${this.__rtcTag} answer sent to ${connId}`);
		} catch (err) {
			// 身份重核：session 已被替换/外部 close 时 err 是 PC 残响，suppress；
			// 由替换方 / close 方负责清理，不重复抛错到上游（避免误报"首次连接失败"）。
			if (this.__sessions.get(connId) !== session) {
				this.logger.info?.(`${this.__rtcTag} [${connId}] first offer error after session change (suppressed): ${err?.message}`);
				return;
			}
			// 自家 session 仍在表里：走 closeByConnId 集中清理（detach + timer 清理 + pc.close + 日志）
			await this.closeByConnId(connId, session).catch(() => { /* c8 ignore next -- 极冷防御 */ });
			throw err;
		}
	}

	/**
	 * 同步建新 session：构造 PC、wire 全部 PC handler、sessions.set。
	 * 在 sync gate 内调用，调用前应已完成对旧 session 的同步替换（如有）。
	 * 异常会传播到 __handleOffer，由 handleSignaling 调用方处理。
	 */
	__createSession(msg, connId) {
		// 从 Server 注入的 turnCreds 构建 iceServers
		// werift 的 urls 必须是单个 string，每个 URL 独立一个对象
		const iceServers = [];
		if (msg.turnCreds) {
			const { urls, username, credential } = msg.turnCreds;
			// 防御：urls 必须是 string 数组；非数组（含 undefined / 单 string）跳过，
			// 避免 for-of undefined 抛错或单 string 被字符级迭代成无效 iceServers
			if (Array.isArray(urls)) {
				for (const url of urls) {
					if (typeof url !== 'string') continue;
					const server = { urls: url };
					if (url.startsWith('turn:') || url.startsWith('turns:')) {
						server.username = username;
						server.credential = credential;
					}
					iceServers.push(server);
				}
			} else {
				this.logger.warn?.(`${this.__rtcTag} ignored malformed turnCreds.urls (expected string[], got ${typeof urls})`);
			}
		}

		// 记录 ICE 服务器配置（脱敏，不含 credential）
		const stunUrl = iceServers.find((s) => s.urls?.startsWith('stun:'))?.urls ?? 'none';
		const turnUrl = iceServers.find((s) => s.urls?.startsWith('turn:'))?.urls ?? 'none';
		this.__remoteLog(`rtc.ice-config conn=${connId} stun=${stunUrl} turn=${turnUrl}`);

		// settings 仅对 pion 生效（werift 路径不吃 settings 字段，大概率静默忽略）：
		// - sctpRtoMax: 收紧 SCTP RTO 退避上限到 10s，让 APK 后台唤醒的深度退避窗口
		//   落在 UI 的 15s 超时内。
		// - interfaceFilter.denyPrefixes: 排除 Docker default bridge `docker0`，
		//   避免它的 host IP 与对端同段 IP 形成伪 ICE pair（绕开 STUN srflx，让 ICE
		//   误以为 P2P 成功）。默认清单极保守——只列容器/VM/Pod 任意视角都不可见、
		//   且 docker daemon 写死小写命名的一条；拒绝纳入的其它项（含曾经短暂入选的
		//   `'br-'`）见 docs/webrtc-ice-if-filter.md。
		const pcConfig = { iceServers };
		if (this.__impl === 'pion') {
			pcConfig.settings = {
				sctpRtoMax: 10000,
				interfaceFilter: {
					denyPrefixes: ['docker0'],
				},
			};
		}
		const pc = new this.__PeerConnection(pcConfig);

		const remoteMaxMessageSize = this.__resolveMaxMessageSize(pc, msg.payload.sdp);

		const session = {
			pc,
			connId,
			rpcChannel: null,
			rpcQueue: null,
			rpcDcSender: null,
			rpcConsumeLoop: null,
			rpcDropMonitor: null,
			fileChannels: new Set(),
			remoteMaxMessageSize,
			nextMsgId: 1,
		};
		this.__sessions.set(connId, session);

		// ICE candidate → 发给 UI，并统计各类型 candidate 数量
		// gather complete 时一并输出 host 候选的 IP:port 列表（诊断 docker/vbridge 误 gather）
		const candidateCounts = { host: 0, srflx: 0, relay: 0 };
		const hostAddrs = [];
		let gatheringEmitted = false;
		const flushGatherDiag = () => {
			if (gatheringEmitted) return;
			gatheringEmitted = true;
			const hostInfo = hostAddrs.length ? ` hosts=${hostAddrs.join(',')}` : '';
			this.__remoteLog(`rtc.ice-gathered conn=${connId} host=${candidateCounts.host} srflx=${candidateCounts.srflx} relay=${candidateCounts.relay}${hostInfo}`);
			candidateCounts.host = 0;
			candidateCounts.srflx = 0;
			candidateCounts.relay = 0;
			hostAddrs.length = 0;
		};
		pc.onicecandidate = ({ candidate }) => {
			// pc identity guard：旧 PC 在 closeByConnId 之后微任务里仍可能投递 onicecandidate
			// （属性置 null 不阻止已 dispatch 的回调）；此时 connId 可能已被新 session 复用，
			// 旧 candidate 不应转发给 UI，否则 UI 会把旧 PC 的 candidate 加到新 PC 上
			const cur = this.__sessions.get(connId);
			if (!cur || cur.pc !== pc) return;
			if (!candidate) {
				// 浏览器路径：gathering 完成通过 null candidate 通知
				flushGatherDiag();
				return;
			}
			// 从 candidate 字符串中提取类型（typ host / typ srflx / typ relay）
			const typMatch = candidate.candidate?.match(/typ (\w+)/);
			if (typMatch && candidateCounts[typMatch[1]] !== undefined) {
				candidateCounts[typMatch[1]]++;
			}
			// host 候选记录 addr:port，用于观察 pion 是否把 docker0 / br-* / loopback 等接口当成 host
			// candidate 格式: "candidate:<foundation> <comp> <proto> <prio> <ADDR> <PORT> typ host ..."
			if (typMatch?.[1] === 'host') {
				const parts = candidate.candidate.split(' ');
				if (parts.length >= 6) {
					hostAddrs.push(`${parts[4]}:${parts[5]}`);
				}
			}
			this.__onSend({
				type: 'rtc:ice',
				toConnId: connId,
				payload: {
					candidate: candidate.candidate,
					sdpMid: candidate.sdpMid,
					sdpMLineIndex: candidate.sdpMLineIndex,
				},
			});
		};
		// pion-node 不会在 gather complete 时 fire onicecandidate(null)，用 icegatheringstatechange 兜底。
		// gathering→ 重置 flag 支持 ICE restart；complete→ flush 汇总
		if ('onicegatheringstatechange' in pc) {
			pc.onicegatheringstatechange = () => {
				// pc identity guard：与其他 handler 对称，旧 PC 微任务迟到不污染新 session 的 gather diag
				const cur = this.__sessions.get(connId);
				if (!cur || cur.pc !== pc) return;
				const state = pc.iceGatheringState;
				if (state === 'gathering') {
					gatheringEmitted = false;
				} else if (state === 'complete') {
					flushGatherDiag();
				}
			};
		}

		// ICE agent 状态（pion 暴露的独立事件）：能看到 checking / connected / failed 等纯 ICE 侧跳转，
		// 与复合 connectionState 互补。对诊断"pion 说 connected 但 UI 看不到数据"非常关键。
		// 仅在 pion-node 实现中可用；其他实现赋值是 no-op。
		if ('oniceconnectionstatechange' in pc) {
			pc.oniceconnectionstatechange = () => {
				const cur = this.__sessions.get(connId);
				if (!cur || cur.pc !== pc) return;
				this.__remoteLog(`rtc.iceState conn=${connId} ${pc.iceConnectionState ?? '?'}`);
			};
		}

		// 连接状态变更（校验 pc 归属，防止旧 PC 异步回调删除新 session）
		pc.onconnectionstatechange = () => {
			const state = pc.connectionState;
			// 校验 pc 归属：旧 PC 的异步回调可能在新 session 已建立后触发
			const cur = this.__sessions.get(connId);
			if (!cur || cur.pc !== pc) return;

			this.__remoteLog(`rtc.state conn=${connId} ${state}`);
			this.logger.info?.(`${this.__rtcTag} [${connId}] connectionState: ${state}`);

			// 离开 failed 状态时清理 TTL timer（ICE restart 恢复、自然关闭等）
			if (state !== 'failed' && cur.__failedTimer) {
				clearTimeout(cur.__failedTimer);
				cur.__failedTimer = null;
			}

			if (state === 'connected') {
				const prevDumpState = cur.__lastDumpState;
				// 重置 dump 去重水位（disconnected → connected → disconnected 仍能再 dump）
				cur.__lastDumpState = null;
				// werift: iceTransports[0].connection.nominated
				const nominated = pc.iceTransports?.[0]?.connection?.nominated;
				if (nominated) {
					const localC = nominated.localCandidate;
					const remoteC = nominated.remoteCandidate;
					const localInfo = `${localC?.type ?? '?'} ${localC?.host ?? '?'}:${localC?.port ?? '?'}`;
					const remoteInfo = `${remoteC?.type ?? '?'} ${remoteC?.host ?? '?'}:${remoteC?.port ?? '?'}`;
					this.__remoteLog(`rtc.ice-nominated conn=${connId} local=${localInfo} remote=${remoteInfo}`);
					this.logger.info?.(`${this.__rtcTag} [${connId}] ICE nominated: local=${localInfo} remote=${remoteInfo}`);
				}
				// pion: pair 通过独立的 selectedcandidatepairchange 事件上报
				// ICE restart 恢复（disconnected/failed → connected）时做诊断动作：
				// - dump 当前 session DC 状态，对照"UI 看不到 connected 时 plugin 侧看到什么"
				// - 发一次 plugin-probe，实测 DC 是否双向可用
				// 只对 pion 生效：werift/ndc 为兼容路径，不涉及本次调查的病态场景。
				if (this.__impl === 'pion' && (prevDumpState === 'disconnected' || prevDumpState === 'failed')) {
					this.__dumpSessionState(connId, cur, 'connected');
					// 挂到 session 上，使 closeByConnId 能在 500ms 窗口内取消；
					// 否则 session 被替换（同 connId 新 offer）时会对着新 session 误发探针。
					if (cur.__pluginProbeSchedTimer) clearTimeout(cur.__pluginProbeSchedTimer);
					cur.__pluginProbeSchedTimer = setTimeout(() => {
						cur.__pluginProbeSchedTimer = null;
						this.__sendPluginProbe(connId);
					}, 500);
					// unref() 避免定时器阻塞 gateway 进程退出（gateway 由其他连接保活）。
					cur.__pluginProbeSchedTimer.unref?.();
				}
			} else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
				// 诊断 dump：失败/断连/关闭时输出当前 PC 上 DC 状态，定位"PC 假活/DC 死"现象
				// - closed 由 closeByConnId 接管清理，dump 收敛诊断噪声
				// - disconnected 可能反复触发，去重避免噪声
				if (state !== 'closed' && cur.__lastDumpState !== state) {
					cur.__lastDumpState = state;
					this.__dumpSessionState(connId, cur, state);
				}
				if (state === 'failed') {
					// 启动 TTL 定时器：超时后回收 session 释放 IPC listeners 和 Go 侧资源。
					// unref() 确保定时器不阻止进程退出（gateway 由其他连接保活）。
					if (cur.__failedTimer) clearTimeout(cur.__failedTimer);
					cur.__failedTimer = setTimeout(() => {
						this.__remoteLog(`rtc.session-expired conn=${connId} ttl=${FAILED_SESSION_TTL_MS / 1000}s`);
						this.logger.info?.(`${this.__rtcTag} [${connId}] session TTL expired, closing`);
						this.closeByConnId(connId, cur).catch(() => {});
					}, FAILED_SESSION_TTL_MS);
					cur.__failedTimer.unref?.();
				} else if (state === 'closed') {
					// 自然进入 closed 时也需通过 closeByConnId 释放 IPC listeners 和 Go 资源
					this.closeByConnId(connId, cur).catch(() => {});
				}
			}
		};

		// pion: 选中的 candidate pair 通过独立事件上报
		if ('onselectedcandidatepairchange' in pc) {
			pc.onselectedcandidatepairchange = () => {
				// pc identity guard：旧 PC 的迟到回调会用旧 pc.selectedCandidatePair 数据
				// + 闭包 connId 拼出"旧 pair + 新 connId"的混合日志，并往 UI 转发过时 transport
				const cur = this.__sessions.get(connId);
				if (!cur || cur.pc !== pc) return;
				const pair = pc.selectedCandidatePair;
				if (pair) {
					this.__logNominatedPair(connId, pair);
				}
				// ICE restart 或初次选中都会触发；让出一次 CPU 后再单播 transport 信息。
				// 签名去重保证 pair 不变时不会重复发送。
				queueMicrotask(() => { this.__sendPeerTransport(connId).catch(() => {}); });
			};
		}

		// 监听 UI 创建的 DataChannel
		pc.ondatachannel = ({ channel }) => {
			// pc identity guard：旧 PC 在 closeByConnId 之后微任务里仍可能投递 ondatachannel
			// （属性置 null 不阻止已 dispatch 的回调）；此时 connId 可能已被新 session 复用，
			// 旧 channel 必须被忽略，否则会进 __setupDataChannel 把旧 dc 装到新 session
			const cur = this.__sessions.get(connId);
			if (!cur || cur.pc !== pc) return;
			this.__remoteLog(`dc.received conn=${connId} label=${channel.label}`);
			this.logger.info?.(`${this.__rtcTag} [${connId}] DataChannel "${channel.label}" received`);
			if (channel.label === 'rpc') {
				// rpcChannel 在 sync 路径赋值，作为 setup 内身份重核的依据；setup 本身改 async
				// 后变 fire-and-forget（WebRTC 实现的 ondatachannel 是 sync 回调，不能 await）
				session.rpcChannel = channel;
				this.__setupDataChannel(connId, channel).catch((err) => {
					/* c8 ignore next 2 -- setup 内部已经 try/catch 所有 await；此处仅防御性兜底 */
					this.logger.warn?.(`${this.__rtcTag} [${connId}] __setupDataChannel error: ${err?.message}`);
				});
			} else if (channel.label.startsWith('file:')) {
				// 跟踪 file DC 用于诊断 dump：保留全量历史以便排查"传输到一半挂掉"场景，
				// 但用 FIFO 上限避免长会话内无界增长
				if (session.fileChannels.size >= FILE_CHANNEL_HISTORY_LIMIT) {
					const oldest = session.fileChannels.values().next().value;
					session.fileChannels.delete(oldest);
				}
				session.fileChannels.add(channel);
				this.__onFileChannel?.(channel, connId);
			}
		};

		return session;
	}

	async __handleIce(msg) {
		const connId = msg.fromConnId;
		const session = this.__sessions.get(connId);
		if (!session) {
			this.__logDebug(`ICE candidate from ${connId} but no session`);
			return;
		}
		try {
			await session.pc.addIceCandidate(msg.payload);
			this.__logDebug(`[${connId}] ICE candidate added`);
		} catch (err) {
			this.__logDebug(`[${connId}] addIceCandidate failed: ${err?.message}`);
		}
	}

	async __setupDataChannel(connId, dc) {
		// rpc DC 发送流控：Queue（FileBackedQueue 默认 / MemoryQueue 降级；admission + bypass 白名单）
		// + rpc-drop-monitor（边沿日志 / 累计 / 汇总）+ RpcDcSender（分片 + 背压），通过消费循环串起来。
		// 广播 / sendTo / files sendFn 都向 queue.enqueue，sender 从 queue 拉。
		const session = this.__sessions.get(connId);

		// === 同步部分（首个 await 前）：wire dc handlers ===
		// reassembler / dc.onopen / dc.onclose / dc.onerror / dc.onmessage 必须在 async fn 的
		// 同步部分 wire 完成；ondatachannel 是 WebRTC 实现的 sync 回调，调方调用后立即可能 dispatch
		// 消息，handler 不能等 init 完才挂。stale dc 上的事件由 handler 内身份守卫吸收。
		const reassembler = createReassembler((jsonStr) => {
			const payload = JSON.parse(jsonStr);
			// identity guard：与 dc.onclose 的 identity guard 对称。
			// DC 重建后旧 dc 的 message event 仍可能在 microtask 队列里派发；若不核身份，旧请求会
			// 注入 __onRequest 或 enqueue 到新 rpcQueue。session 已删除时（rpcChannel===null 或
			// sess undefined）也按 stale 处理，避免向已清空的 session 注入消息。
			const sess = this.__sessions.get(connId);
			// 身份守卫故意放在派发处（而非 dc.onmessage 入口）：reassembler 每 dc 独立、陈旧 chunk 派发前
			// 无害，放此处可挡住所有通向派发的路径（含未来 reassembler 定时刷新等非 onmessage 旁路）。
			if (!sess || sess.rpcChannel !== dc) {
				return;
			}
			// DC 探测：立即回复，不走 gateway
			// 故意绕过 MemoryQueue + RpcDcSender：probe-ack 仅用于测量传输层（SCTP/DTLS）健康，
			// 走 queue 会把应用层积压压力错误地映射到"DC 不通"上。
			if (payload.type === 'probe') {
				try { dc.send(JSON.stringify({ type: 'probe-ack' })); }
				catch { /* DC 已关闭，忽略 */ }
				return;
			}
			// 来自 UI 的 plugin-probe 回复：验证 plugin → UI 方向确实传达并被回传
			if (payload.type === 'plugin-probe-ack') {
				this.__handlePluginProbeAck(connId, payload.id);
				return;
			}
			if (payload.type === 'req') {
				// coclaw.files.* 方法本地处理，不转发 gateway
				if (payload.method?.startsWith('coclaw.files.') && this.__onFileRpc) {
					const sendFn = (response) => {
						let jsonStr;
						try {
							jsonStr = JSON.stringify(response);
						} catch (err) {
							this.__logDebug(`[${connId}] file sendFn stringify failed: ${err?.message}`);
							return;
						}
						if (typeof jsonStr !== 'string') return;
						// fire-and-forget：files sendFn 历史是 sync void 接口，保留语义；
						// admission 决策内部消化，失败由 overflow 状态机/close 汇总统一上报
						sess?.rpcQueue?.enqueue(jsonStr).catch((err) => {
							/* c8 ignore next -- enqueue 仅在 mutex 异常等极冷路径 reject */
							this.__logDebug(`[${connId}] file sendFn enqueue error: ${err?.message}`);
						});
					};
					this.__onFileRpc(payload, sendFn, connId);
				} else {
					this.__onRequest?.(payload, connId);
				}
			} else {
				this.__logDebug(`[${connId}] unknown DC message type: ${payload.type}`);
			}
		}, { logger: this.logger });

		dc.onopen = () => {
			// 陈旧通道早返回：旧 dc 的迟到 onopen 不应对新 session 误报 transport
			const sess = this.__sessions.get(connId);
			if (!sess || sess.rpcChannel !== dc) return;
			this.__remoteLog(`dc.open conn=${connId} label=${dc.label}`);
			this.logger.info?.(`${this.__rtcTag} [${connId}] DataChannel "${dc.label}" opened`);
			// rpc DC 建立后，把本端 transport 信息单播给 UI。
			// queueMicrotask 让出一次 CPU：确保 pion 侧 selectedCandidatePair setter 已 assign，
			// 同时避免在 onopen 同步栈里触发可能的重入。
			if (dc.label === 'rpc') {
				queueMicrotask(() => { this.__sendPeerTransport(connId).catch(() => {}); });
			}
		};
		dc.onclose = () => {
			this.__remoteLog(`dc.closed conn=${connId} label=${dc.label}`);
			this.logger.info?.(`${this.__rtcTag} [${connId}] DataChannel "${dc.label}" closed`);
			reassembler.reset();
			const sess = this.__sessions.get(connId);
			// identity guard：仅当 sess.rpcChannel 仍是这个 dc 时才清三件套。
			// 同 session 重建（UI 重建 rpc DC）后，旧 dc 的 onclose 可能滞后到达，此时
			// session 已挂上新三件套；若不核身份，旧 dc 的 onclose 会瞬间杀死新链路
			if (sess && dc.label === 'rpc' && sess.rpcChannel === dc) {
				// dc.onclose 是 sync 回调，不能 await consumeLoop。仅触发 close + destroy；
				// consumeLoop 通过 sender.close → SENDER_CLOSED → break + queue.destroy → done 自然退出。
				// summarize 走 destroy 的 onBeforeClear 钩子：mutex 内拿原子残留快照，规避同步读
				// stats 看不到 in-flight broadcast 的 race（monitor 内 summarized flag 保证幂等，
				// consumeLoop finally 触发的二次 summarize 是 no-op）。
				// monRef 闭包捕获是关键：dc.onclose sync 段会立即清 sess.rpcDropMonitor 字段，
				// 但 destroy 是 fire-and-forget，回调在 mutex 异步内才 fire 时字段已 null。
				sess.rpcDcSender?.close();
				const monRef = sess.rpcDropMonitor;
				sess.rpcQueue?.destroy((residual) => { monRef?.summarize(residual); }).catch((err) => {
					/* c8 ignore next 2 -- destroy 在生产路径稳定（mutex 内异常极冷），仅诊断兜底 */
					this.logger.warn?.(`${this.__rtcTag} [${connId}] rpc queue destroy failed in dc.onclose: ${err?.message ?? err}`);
				});
				sess.rpcDcSender = null;
				sess.rpcQueue = null;
				sess.rpcConsumeLoop = null;
				sess.rpcDropMonitor = null;
				sess.rpcChannel = null;
			}
		};
		dc.onerror = (err) => {
			// 陈旧通道早返回：旧 dc 的迟到 onerror 不打进新 session 上下文
			const sess = this.__sessions.get(connId);
			if (!sess || sess.rpcChannel !== dc) return;
			this.__remoteLog(`dc.error conn=${connId} label=${dc.label}`);
			/* c8 ignore next -- ?./?? fallback */
			this.logger.warn?.(`${this.__rtcTag} [${connId}] DataChannel "${dc.label}" error: ${String(err?.message ?? err)}`);
		};
		dc.onmessage = (event) => {
			try {
				reassembler.feed(event.data);
			} catch (err) {
				this.logger.warn?.(`${this.__rtcTag} [${connId}] DC message error: ${err.message}`);
			}
		};

		if (!session || dc.label !== 'rpc') return;

		// === 异步部分：rpc 三件套（队列 / 发送器 / 消费循环）+ monitor + 身份守卫 ===
		// 罕见：session 已有旧三件套（UI 重建 rpc DC 等）。先 await close + destroy 旧实例
		// 再造新实例，避免新旧 queue/sender 在同一 session 上并存。summarize 走 destroy 的
		// onBeforeClear 钩子，确保拿到原子残留快照（in-flight enqueue 已落地）。
		//
		// race 闭合：先**同步**捕获旧引用 + 把四个字段置 null，再 await 旧实例 destroy。
		// 否则 sync ondatachannel 已把 rpcChannel 切到新 dc（readyState='open'），但 rpcQueue
		// 等字段保留到 await destroy 完成；这窗口里 broadcast / sendTo 看到 "rpcQueue=旧 +
		// rpcChannel=新 dc open" 会把消息塞进即将销毁的旧 queue。sync nullify 后窗口里 broadcast
		// 看到 rpcQueue=null 跳过（与"通道未就绪"等价）。
		if (session.rpcDcSender || session.rpcQueue) {
			const oldSender = session.rpcDcSender;
			const oldQueue = session.rpcQueue;
			const oldLoop = session.rpcConsumeLoop;
			const oldMonitor = session.rpcDropMonitor;
			session.rpcDcSender = null;
			session.rpcQueue = null;
			session.rpcConsumeLoop = null;
			session.rpcDropMonitor = null;
			oldSender?.close();
			if (oldQueue) await oldQueue.destroy((residual) => { oldMonitor?.summarize(residual); });
			if (oldLoop) await oldLoop.catch(() => { /* c8 ignore next -- 极冷防御 */ });
		}
		// 创建 monitor。必须在 new Queue 之前——Queue 的 onDrop 接 monitor.onDrop。
		// monitor 是局部变量，stale 路径下函数返回后自然 GC，不挂 session 字段（无 drop 可汇总）。
		const monitor = createRpcDropMonitor({ connId, logger: this.logger });

		// queue 实例选择（B-stage2 B9b）：默认取模块级 RPC_QUEUE_IMPL（当前 'fbq'）；
		// 'fbq' 模式下若 queueDir 不可用则降级到 mem，避免阻塞装配。
		// 同 connId race 隔离（决策 4）：FBQ id 加唯一后缀 ${connId}-${ts}-${nonce}，
		// 让新旧实例文件名物理不同，destroy/init 期间互不踩踏。MemoryQueue 不碰 fs，无此需求。
		// connId 字符集契约：FBQ / MemoryQueue 共用 `^[A-Za-z0-9._-]+$` 校验。
		// 上游 server 分配 connId 形如 `c_<digits>` 符合契约；若 server 引入特殊字符，
		// queue 构造抛 TypeError，由 __setupDataChannel 的 .catch 兜底 warn。
		// 完整契约 / 违反后果 / 修复方向见 docs/connid-contract.md
		const useFbq = this.__rpcQueueImpl === 'fbq' && !!this.__queueDir;
		const fbqFallback = !useFbq && this.__rpcQueueImpl === 'fbq';
		const queue = useFbq
			? new FileBackedQueue({
				id: `${connId}-${Date.now()}-${randomUUID().slice(0, 8)}`,
				dir: this.__queueDir,
				memBudget: RPC_QUEUE_MEM_BUDGET,
				// diskCap 是 mem + 已写文件累计字节（writtenBytes）的总占用阈值，不是单纯文件 size
				// 上限——因此文件实际峰值约为 diskCap - memBudget；详见 docs/rpc-dc-file-queue.md
				diskCap: this.__getDiskCap?.() ?? ONE_GB,
				maxMessageBytes: MAX_SINGLE_MSG_BYTES,
				bypassAdmission: isAgentRunResponse,
				onDrop: monitor.onDrop,
				onSpillStart: monitor.onSpillStart,
				onSpillEnd: monitor.onSpillEnd,
				logger: this.logger,
			})
			: new MemoryQueue({
				id: connId,
				maxMessageBytes: MAX_SINGLE_MSG_BYTES,
				bypassAdmission: isAgentRunResponse,
				onDrop: monitor.onDrop,
				logger: this.logger,
				tag: `conn=${connId}`,
			});
		// FBQ.init 承担 fs 残留清理（含同 connId 唯一后缀文件，不会撞旧实例）；MemoryQueue.init 是 no-op。
		// await 期间可能发生 closeByConnId / 同 connId 二次 ondatachannel，因此后面必须身份重核才能赋字段。
		await queue.init();
		// 故意不为同 connId 并发 setup 引入 rpcSetupInProgress 协调锁：双 loop / 泄漏被下方身份重核
		// + 段首 teardown 结构性挡死（rpcChannel 在 ondatachannel 同步路径单调前移：先到者被后到
		// teardown 收割，后到者 dc 已非 rpcChannel 则自毁返回）；即便分析有误，孤儿也只是空转 idle
		// 任务 + 少量内存（无 producer → 无 spill → 无 FD），无崩溃 / 丢数据。
		// 身份重核：init 期间 session 可能被 closeByConnId 从 Map 删除，或被同 connId 二次
		// ondatachannel 把 rpcChannel 替换成新 dc。任一不再成立都视为 stale，destroy queue 后
		// 直接退出，绝不污染 session 三件套字段。monitor 自然 GC，无需 summarize（无 drop）。
		const sessAfter = this.__sessions.get(connId);
		if (sessAfter !== session || session.rpcChannel !== dc) {
			await queue.destroy();
			return;
		}
		// 装配成功后日志：让运维侧看到该 session 实际跑哪种 queue（特别是 fbq 降级到 mem 的场景）。
		// 放在 stale 守卫之后——只对真正生效的 session 打 log，避免 stale 装配虚报一次。
		// 单 session 只打一次，频率与连接频率挂钩——符合 remoteLog 红线（不高频）。
		const queueImpl = useFbq ? 'fbq' : 'mem';
		this.logger.info?.(`${this.__rtcTag} [${connId}] rpc queue impl=${queueImpl}${fbqFallback ? ' (fallback: queueDir unavailable)' : ''}`);
		this.__remoteLog(`rtc.queue-impl conn=${connId} impl=${queueImpl}${fbqFallback ? ' fallback=queue-dir-null' : ''}`);
		if ('bufferedAmountLowThreshold' in dc) {
			dc.bufferedAmountLowThreshold = DC_LOW_WATER_MARK;
		}
		const sender = new RpcDcSender({
			dc,
			maxMessageSize: session.remoteMaxMessageSize,
			getNextMsgId: () => session.nextMsgId++,
			logger: this.logger,
			tag: `conn=${connId}`,
		});
		session.rpcQueue = queue;
		session.rpcDcSender = sender;
		session.rpcDropMonitor = monitor;
		// 闭包捕获本次 sender 局部引用，而不是读 session.rpcDcSender 字段。
		// 同 session rebuild 后字段会指向新 sender，旧 dc 的 BAL 滞后事件若读字段
		// 会错唤醒新 sender；捕获局部引用后旧 dc 触发 BAL 调的是已 close 的旧 sender，
		// onBufferedAmountLow 在 splice 空 waiter 数组上无副作用
		dc.onbufferedamountlow = () => {
			sender.onBufferedAmountLow();
		};
		// 起消费循环：从 queue 拉一条 → await sender.send()。sender close 时循环 break。
		// finally 兜底关闭：覆盖 dc.send 中途抛错 / 异常退出场景——dc.onclose 不一定会及时
		// 触发清理（如 readyState 短暂 open 但 send 失败），主动 close+destroy 避免 queue/sender
		// 残留导致后续 broadcast 入队后无人消费。两个 close/destroy 都幂等。
		// monitor.summarize 也是幂等的——dc.onclose 同步路径可能已先调过一次。
		session.rpcConsumeLoop = (async () => {
			try {
				for await (const str of queue) {
					try {
						await sender.send(str);
						// 出列即过 monitor 检查"满→未满"翻转。stats 浅读 + 5 标量比对，O(1)。
						// monitor 内部 logger/remoteLog 已 safe wrap，不会抛。
						monitor.maybeEmitOverflowEnd(queue.stats());
					} catch (err) {
						if (err.code === 'SENDER_CLOSED') break;
						// safe-wrap：logger.warn 自身抛不能让消费循环挂掉
						try { this.logger.warn?.(`${this.__rtcTag} [${connId}] rpc-dc.send-failed code=${err.code} size=${str.length}`); }
						/* c8 ignore next -- logger 自身抛是极冷防御路径 */
						catch { /* swallow */ }
					}
				}
			} finally {
				sender.close();
				// summarize 走 destroy 的 onBeforeClear 钩子：在 mutex 内拿原子残留快照。
				// 与 dc.onclose / closeByConnId 的二次 summarize 由 monitor 的 summarized flag 兜底幂等。
				await queue.destroy((residual) => { monitor.summarize(residual); }).catch(() => {});
				// 防御性清字段：若 loop 因 sender 内部错误自行退出（dc.onclose / closeByConnId
				// 都不是触发方），字段会暂留非 null 直到 dc.onclose 最终到达。期间 producer
				// 看到非 null 会以为通道活着——虽然 enqueue 安全返 false，但减少误导窗口。
				// 身份比对避免误清"dc.onclose 已先清掉、并被新一轮 setup 装入新实例"的字段。
				if (session.rpcQueue === queue) {
					session.rpcQueue = null;
					session.rpcDcSender = null;
					session.rpcConsumeLoop = null;
					session.rpcDropMonitor = null;
				}
			}
		})();
		// unhandled rejection 防御：循环 promise 自身极少抛（仅 iterator 实现 bug），但
		// 一旦逃逸为 unhandled rejection 会让 plugin/gateway 进程退出
		session.rpcConsumeLoop.catch(() => {});
	}

	/**
	 * 失败/断连时输出 session 诊断快照：rpc/file DC readyState、session 总数。
	 * 用于定位"PC 假活但 DC 已死"或"PC 已断但 DC 仍在传"的异常现象。
	 */
	__dumpSessionState(connId, session, state) {
		const rpcState = session.rpcChannel?.readyState ?? 'none';
		const fileSummary = this.__summarizeFileChannels(session.fileChannels);
		const q = session.rpcQueue;
		const queueInfo = q
			? (() => {
				const s = q.stats();
				// memCount 沿用历史 token 名 queueLen（不改名）；queue.stats() 6 个字段（含 4 个
				// 磁盘字段，MemoryQueue 路径下恒 0/false）+ monitor.getStats() 提供 dropCount/dropBytes。
				// 输出文本 8 token 字节级保持与现行格式一致。
				// monitor 与 queue 在 setupDataChannel 末尾同 tick 装载，q 真值时 monitor 必定也存在；
				// `?? { ... }` 是防御性兜底，结构上不可达。
				/* c8 ignore next -- monitor 与 queue 同 tick 装载，?? fallback 不可达 */
				const m = session.rpcDropMonitor?.getStats() ?? { dropCount: 0, dropBytes: 0 };
				return `queueLen=${s.memCount} queueBytes=${s.memBytes} diskBytes=${s.diskBytes} writtenBytes=${s.writtenBytes} spilled=${s.spilled} fsBroken=${s.fsBroken} dropped=${m.dropCount} droppedBytes=${m.dropBytes}`;
			})()
			: 'queue=none';
		this.__remoteLog(`rtc.dump conn=${connId} state=${state} sessions=${this.__sessions.size} rpc=${rpcState} ${queueInfo} fileCount=${session.fileChannels.size} files=[${fileSummary}]`);
		this.logger.info?.(`${this.__rtcTag} [${connId}] dump state=${state} rpc=${rpcState} ${queueInfo} fileCount=${session.fileChannels.size} files=${fileSummary}`);
		// 仅 pion 路径追加 SCTP 采样：cwnd 是否塌回 1×MTU + bytesSent 增量是否 ~0
		// 是判定"是否陷入深度 RTO 退避"的关键。fire-and-forget + 内部 try/catch
		// 双保险，不阻塞 dump 主流程；rtc.sctp 独立一行避免污染既有 rtc.dump 格式。
		if (this.__impl === 'pion' && typeof session.pc.getSctpStats === 'function') {
			this.__dumpSctpStats(connId, session, state).catch(() => {});
		}
	}

	/**
	 * 按 readyState 聚合 file DC。closed 态只给计数，非 closed 态附带 label —
	 * 长会话内已关闭的 DC 会累积到 FIFO 上限，全量拼 label 会让 dump 膨胀，
	 * 而断连时真正有诊断价值的是"还没关干净"的 DC。
	 */
	__summarizeFileChannels(fileChannels) {
		if (fileChannels.size === 0) return 'none';
		const byState = new Map();
		for (const dc of fileChannels) {
			/* c8 ignore next -- ?? fallback for missing readyState */
			const st = dc.readyState ?? '?';
			if (!byState.has(st)) byState.set(st, []);
			byState.get(st).push(dc.label);
		}
		const parts = [];
		for (const [st, labels] of byState) {
			if (st === 'closed') parts.push(`closed:${labels.length}`);
			else parts.push(`${st}:${labels.length}(${labels.join(',')})`);
		}
		return parts.join(' ');
	}

	async __dumpSctpStats(connId, session, state) {
		try {
			const stats = await session.pc.getSctpStats();
			if (!stats) {
				this.__remoteLog(`rtc.sctp conn=${connId} state=${state} sctp=none`);
				return;
			}
			this.__remoteLog(
				`rtc.sctp conn=${connId} state=${state} cwnd=${stats.congestionWindow} srtt=${Math.round(stats.srttMs)}ms sent=${stats.bytesSent} recv=${stats.bytesReceived} mtu=${stats.mtu}`,
			);
		} catch (err) {
			this.__remoteLog(`rtc.sctp conn=${connId} state=${state} error=${err.message}`);
			this.logger.warn?.(`${this.__rtcTag} [${connId}] getSctpStats error: ${err.message}`);
		}
	}

	/**
	 * 分片阈值 = min(远端能接收, 本地能发送)
	 * 远端：从 SDP 的 a=max-message-size 解析（缺失则 RFC 8841 默认 65536）
	 * 本地：pc.maxMessageSize（pion 为 65536，ndc/werift 无此属性则不限制）
	 */
	__resolveMaxMessageSize(pc, sdp) {
		const mmsMatch = sdp?.match(/a=max-message-size:(\d+)/);
		const remoteMMS = mmsMatch ? parseInt(mmsMatch[1], 10) : 65536;
		const localMMS = pc.maxMessageSize ?? remoteMMS;
		return Math.min(remoteMMS, localMMS);
	}

	__logNominatedPair(connId, pair) {
		const l = pair.local, r = pair.remote;
		const lProto = (l?.protocol ?? '?').toLowerCase();
		const rProto = (r?.protocol ?? '?').toLowerCase();
		const lRelay = l?.relayProtocol ? `(${String(l.relayProtocol).toLowerCase()})` : '';
		const localInfo = `${l?.type ?? '?'}/${lProto}${lRelay} ${l?.address ?? l?.host ?? '?'}:${l?.port ?? '?'}`;
		const remoteInfo = `${r?.type ?? '?'}/${rProto} ${r?.address ?? r?.host ?? '?'}:${r?.port ?? '?'}`;
		this.__remoteLog(`rtc.ice-nominated conn=${connId} local=${localInfo} remote=${remoteInfo}`);
		this.logger.info?.(`${this.__rtcTag} [${connId}] ICE nominated: local=${localInfo} remote=${remoteInfo}`);
	}

	/**
	 * 把当前 session 本端 candidate 的 transport 信息（type/protocol/relayProtocol）
	 * 通过 coclaw.rtc.peerTransport 事件单播给对应 UI。已内置签名去重，
	 * 同一签名不会重复发送；发送失败（DC 未 open）时回滚签名允许后续重试。
	 *
	 * @param {string} connId
	 */
	async __sendPeerTransport(connId) {
		const session = this.__sessions.get(connId);
		if (!session) return;
		const local = session.pc?.selectedCandidatePair?.local;
		if (!local) return; // nominated pair 尚未产生
		const payload = {
			candidateType: local.type ?? 'unknown',
			protocol: String(local.protocol ?? 'udp').toLowerCase(),
			relayProtocol: local.relayProtocol
				? String(local.relayProtocol).toLowerCase()
				: null,
		};
		const sig = `${payload.candidateType}|${payload.protocol}|${payload.relayProtocol ?? ''}`;
		if (session.__lastPeerTransportSig === sig) return;
		session.__lastPeerTransportSig = sig;
		// sendTo 阶段 1 改 async：await admission 决策结果
		const ok = await this.sendTo(connId, {
			type: 'event',
			event: 'coclaw.rtc.peerTransport',
			payload,
		});
		if (!ok) {
			// DC 尚未 open / 队列拒收：回滚签名以便 dc.onopen 再次触发时重发
			session.__lastPeerTransportSig = null;
			return;
		}
		this.__remoteLog(`rtc.peer-transport conn=${connId} type=${payload.candidateType} proto=${payload.protocol} relay=${payload.relayProtocol ?? '-'}`);
	}

	/**
	 * 主动探针：在 rpc DC 上发一个 plugin-probe，期待 UI 回 plugin-probe-ack。
	 * 用于区分"pion 报告 connected 但 UI 其实没收到数据"与"UI 真的收到了但没记录事件"。
	 * 绕过 MemoryQueue + RpcDcSender（与 probe-ack 对称），仅测量传输层，不受应用层积压影响。
	 * 同一 session 同时只保留一条 in-flight 探针；超时仅打日志，不影响业务恢复。
	 */
	__sendPluginProbe(connId) {
		const session = this.__sessions.get(connId);
		if (!session) return;
		const dc = session.rpcChannel;
		if (!dc || dc.readyState !== 'open') return;
		// 已有 in-flight 则跳过（避免重复）
		if (session.__pluginProbeInFlight) return;

		const id = (session.__pluginProbeIdSeq = (session.__pluginProbeIdSeq ?? 0) + 1);
		const startMs = Date.now();
		const timer = setTimeout(() => {
			if (session.__pluginProbeInFlight?.id === id) {
				session.__pluginProbeInFlight = null;
				session.__pluginProbeTimer = null;
				this.__remoteLog(`rtc.plugin-probe conn=${connId} id=${id} timeout`);
			}
		}, 5000);
		timer.unref?.();
		session.__pluginProbeInFlight = { id, startMs };
		session.__pluginProbeTimer = timer;

		try {
			dc.send(JSON.stringify({ type: 'plugin-probe', id }));
			this.__remoteLog(`rtc.plugin-probe conn=${connId} id=${id} sent`);
		} catch (err) {
			clearTimeout(timer);
			session.__pluginProbeInFlight = null;
			session.__pluginProbeTimer = null;
			this.__remoteLog(`rtc.plugin-probe conn=${connId} id=${id} send-failed msg=${err?.message ?? err}`);
		}
	}

	/** 收到 UI 的 plugin-probe-ack：计算 RTT 并释放 in-flight 槽位 */
	__handlePluginProbeAck(connId, id) {
		const session = this.__sessions.get(connId);
		if (!session) return;
		const inFlight = session.__pluginProbeInFlight;
		if (!inFlight || inFlight.id !== id) return; // 过期 ack，忽略
		const rtt = Date.now() - inFlight.startMs;
		if (session.__pluginProbeTimer) {
			clearTimeout(session.__pluginProbeTimer);
			session.__pluginProbeTimer = null;
		}
		session.__pluginProbeInFlight = null;
		this.__remoteLog(`rtc.plugin-probe conn=${connId} id=${id} acked rtt=${rtt}`);
	}

	__remoteLog(msg) {
		remoteLog(this.__impl ? `${msg} rtc=${this.__impl}` : msg);
	}

	// 解析 HMAC turnCreds 中的剩余秒数（username 形如 "<expireAt>:<userId>"）；
	// 负值表示已过期；解析失败或 turnCreds 缺失返回 null。仅用于 ICE restart 日志诊断。
	__credRemainSec(turnCreds) {
		const username = turnCreds?.username;
		if (typeof username !== 'string') return null;
		const expireAt = Number(username.split(':')[0]);
		if (!Number.isFinite(expireAt)) return null;
		return expireAt - Math.floor(Date.now() / 1000);
	}

	/** 淘汰最旧的 failed session（Map 迭代序 ≈ 创建时间序），用于 queue length 限制 */
	__evictOldestFailed() {
		for (const [connId, session] of this.__sessions) {
			if (session.pc.connectionState === 'failed') {
				this.__remoteLog(`rtc.session-evicted conn=${connId} sessions=${this.__sessions.size}`);
				this.logger.info?.(`${this.__rtcTag} [${connId}] session evicted (limit ${MAX_SESSIONS}), closing`);
				this.closeByConnId(connId, session).catch(() => {});
				return true;
			}
		}
		this.logger.warn?.(`${this.__rtcTag} session limit (${MAX_SESSIONS}) reached, no failed sessions to evict`);
		return false;
	}

	__logDebug(message) {
		if (typeof this.logger?.debug !== 'function') return;
		try { this.logger.debug(`${this.__rtcTag} ${message}`); }
		catch { /* 上层（broadcast / sendTo / sendFn 等的 stringify catch）依赖 __logDebug 不抛 */ }
	}
}

export { FAILED_SESSION_TTL_MS, MAX_SESSIONS };
