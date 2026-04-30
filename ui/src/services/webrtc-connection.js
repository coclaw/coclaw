/**
 * WebRTC DataChannel 连接管理（UI 侧）
 * DataChannel 是唯一的业务 RPC 通道，WS 仅用于信令和保活哨兵。
 *
 * 连接恢复策略（restart-first, rebuild-fallback）：
 * - disconnected → 等待 ICE 自动恢复（短暂网络抖动自愈），5s 超时后发起 ICE restart
 * - ICE restart → 仅重新协商 ICE 层，DTLS/SCTP/DataChannel 完整保留
 *   → pending RPC 不丢失，文件传输断点续传
 * - restart 被 reject（plugin 已销毁 PC）或连续失败 → 上报 failed，由外层 rebuild
 * - 前台恢复 / 网络切换 → 主动触发 ICE restart
 *
 * 详见 docs/designs/ice-restart-recovery.md
 */
import { httpClient } from './http.js';
import { buildChunks, createReassembler } from '../utils/dc-chunking.js';
import { useSignalingConnection } from './signaling-connection.js';
import { remoteLog } from './remote-log.js';

/** disconnected 状态超时：超过此时间仍未恢复则升级到 ICE restart（ICE 自愈通常 1-3s） */
const DISCONNECTED_TIMEOUT_MS = 5_000;

// --- 前台恢复场景下的 disconnected 容忍 ---
// __onAppBackground 已清 __disconnectedTimer，前台恢复时按后台驻留时长 re-arm。
// 注：长后台（分钟级）场景下 consent 早已连续失败、PC 通常已升到 failed，会走
// onconnectionstatechange 的 failed 分支立即 restart，不经此 timer；因此无需再分"长后台"档。
/** 短后台阈值（与 claws.store.js SHORT_BACKGROUND_MS 语义对齐，各自独立定义）：
 *  < 此时长视为同一条网络会话，NAT binding 仍在，沿用 5s 自愈窗口 */
const SHORT_BACKGROUND_MS = 25_000;
/** 长于短后台阈值后回前台的 disconnected 容忍：主要用于让浏览器/WebView
 *  从挂起恢复后完成内部状态同步，不再指望 ICE 自愈 */
const DISCONNECTED_TIMEOUT_RESUME_MS = 1_500;

/** ICE restart 总时间预算：超过后放弃 restart → failed → store rebuild。
 *  3 分钟取值：弱网下 90s 不一定能凑出可用 candidate pair；底层 WebRTC（pion / 浏览器内置）
 *  在 ICE 这层够靠谱，让 restart 多探一会儿（含 STUN/TURN 重协商、relay fallback）通常比
 *  转 rebuild 更对症——rebuild 在同等链路条件下也未必更快（多一轮 DTLS+SCTP 握手）。 */
const ICE_RESTART_TIMEOUT_MS = 180_000;
/** ICE restart 安全网定时器间隔（覆盖 connectionState:failed 未触发的极端场景）。
 *  15s 取值：正常 offer→answer 往返应在 1-3s 完成；15s 仍远高于该水位，
 *  同时把 answer 丢失场景下的最坏恢复延迟压到 15s 内。 */
const ICE_RESTART_SAFETY_MS = 15_000;
/** ICE restart stats 轮询间隔：覆盖"旧 pair 还活着、connectionState 从未跳变"的场景 */
const ICE_RESTART_STATS_POLL_MS = 500;

/**
 * 从 SDP 文本中提取 a=ice-ufrag 行的值。
 * ICE spec 强制 ufrag 必填，因此 localDescription.sdp 是跨浏览器稳定的 ufrag 来源，
 * 用于当 RTCIceCandidateStats.usernameFragment 未暴露时（部分 Safari/Firefox 版本）的兜底。
 */
function parseIceUfragFromSdp(sdp) {
	if (!sdp) return null;
	const m = sdp.match(/^a=ice-ufrag:(\S+)/m);
	return m ? m[1] : null;
}

/** DC 应用层保活：间隔（probe 完成后到下一次 probe 发起） */
const DC_KEEPALIVE_INTERVAL_MS = 30_000;
/** DC 应用层保活：单次 probe 超时（拥塞场景由活动宽限兜底，此处只管正常检测） */
const DC_KEEPALIVE_TIMEOUT_MS = 10_000;
/** DC 应用层保活：活动宽限期（probe 超时期间有 DC 数据活动则视为 SCTP 拥塞而非死亡） */
const DC_ACTIVITY_GRACE_MS = 20_000;

/** 发送流控：高水位（暂停发送），远低于浏览器 16MB 上限 */
const DC_HIGH_WATER_MARK = 1024 * 1024;
/** 发送流控：低水位（恢复发送），对应 bufferedAmountLowThreshold */
const DC_LOW_WATER_MARK = 256 * 1024;

/** @type {Map<string, WebRtcConnection>} clawId → WebRtcConnection */
const rtcInstances = new Map();

// 解析 HMAC turnCreds username 中的过期时间戳（Unix 秒）；解析失败返回 null。
// 仅供 ICE restart 时计算 credRemain 诊断字段使用，不参与凭证验证。
export function parseCredExpireAt(username) {
	if (typeof username !== 'string') return null;
	const ts = Number(username.split(':')[0]);
	return Number.isFinite(ts) ? ts : null;
}

const RTC_TRANSPORT_TIMEOUT_MS = 15_000;

/**
 * 为指定 claw 初始化 RTC 连接
 * WS 每次连通时调用；内含防重入守卫
 * @param {string} clawId
 * @param {import('./claw-connection.js').ClawConnection} clawConn
 * @param {object} [callbacks]
 * @param {(state: string, transportInfo: object|null) => void} [callbacks.onRtcStateChange] - RTC 状态变更
 * @returns {Promise<'rtc'|'failed'>}
 */
export function initRtc(clawId, clawConn, callbacks = {}) {
	const existing = rtcInstances.get(clawId);
	if (existing && existing.state !== 'closed' && existing.state !== 'failed') {
		return Promise.resolve(existing.isReady ? 'rtc' : 'pending');
	}
	if (existing) existing.close();

	const rtc = new WebRtcConnection(clawId, clawConn);
	rtcInstances.set(clawId, rtc);

	return new Promise((resolveTransport) => {
		let settled = false;
		function settle(result) {
			if (settled) return false;
			settled = true;
			resolveTransport(result);
			return true;
		}

		// 15 秒内 DataChannel open → 'rtc'，否则 → 'failed'
		const fallbackTimer = setTimeout(() => {
			if (!settle('failed')) return;
			console.warn('[rtc] RTC 建连超时 clawId=%s', clawId);
			rtc.close();
			rtcInstances.delete(clawId);
			clawConn.clearRtc();
		}, RTC_TRANSPORT_TIMEOUT_MS);

		rtc.onReady = () => {
			if (!settle('rtc')) return;
			clearTimeout(fallbackTimer);
			clawConn.setRtc(rtc);
		};

		// 状态变更 → 通知调用方
		rtc.onStateChange = () => {
			callbacks.onRtcStateChange?.(rtc.state, rtc.transportInfo);

			// 'failed'（所有恢复尝试耗尽）与 'closed'（外部 close：closeRtcForClaw /
			// closeAllRtcInstances / clawConn.disconnect）都终结 init：
			// 清 fallbackTimer、从 Map 删、让 clawConn 释放对 rtc 的引用、settle 为 'failed'
			// 若不覆盖 'closed'，外部 close 后 fallbackTimer 仍会 15s 后 fire，
			// 其闭包里的 `rtcInstances.delete(clawId)` 会误删下一用户同 clawId 的新 rtc 条目
			if (rtc.state === 'failed' || rtc.state === 'closed') {
				clearTimeout(fallbackTimer);
				rtcInstances.delete(clawId);
				clawConn.clearRtc();
				settle('failed');
			}
		};

		httpClient.get('/api/v1/turn/creds')
			.then((resp) => {
				// TURN HTTP 在途期间，外部可能已通过 fallbackTimer/closeRtcForClaw 等
				// 路径关掉 rtc 并把 Map 条目清掉。此时再调 rtc.connect 会用旧 clawConn
				// 重建 PC、发出 'rtc:offer'，留下游离 PC，因此守住：已 settled 或已被
				// 替换 / 移除的 rtc 一律不再触发 connect
				if (settled || rtcInstances.get(clawId) !== rtc) return;
				return rtc.connect(resp.data);
			})
			.catch((err) => {
				if (!settle('failed')) return;
				clearTimeout(fallbackTimer);
				console.warn('[rtc] init failed clawId=%s: %s', clawId, err?.message);
				rtc.close();
				rtcInstances.delete(clawId);
				clawConn.clearRtc();
			});
	});
}

/** @deprecated 使用 initRtc 代替 */
export const initRtcAndSelectTransport = initRtc;
/** @deprecated 使用 initRtc 代替 */
export const initRtcForClaw = initRtc;

/** 关闭指定 claw 的 WebRTC 连接 */
export function closeRtcForClaw(clawId) {
	const rtc = rtcInstances.get(clawId);
	if (rtc) {
		rtc.close();
		rtcInstances.delete(clawId);
	}
}

/**
 * 关闭并清空所有 RTC 实例（logout 场景用）。
 * 场景：未完成 init 的 rtc 仍在 rtcInstances 中挂着 fallbackTimer + clawConn 闭包引用。
 * clawConnection.disconnect() 只能处理已 setRtc 的活跃 rtc，碰不到初始化中的漏网之鱼。
 * 若不清理，15s 内同 clawId 重登会复用旧 rtc Promise，onReady 闭包指向已废弃的 clawConn。
 */
export function closeAllRtcInstances() {
	for (const rtc of rtcInstances.values()) {
		try { rtc.close(); }
		catch (err) { console.debug('[rtc] closeAll rtc.close failed: %s', err?.message); }
	}
	rtcInstances.clear();
}

/** 仅供测试：重置所有实例（与 closeAllRtcInstances 共享语义，保留别名以兼容既有测试） */
export const __resetRtcInstances = closeAllRtcInstances;

/** 仅供测试：获取实例 */
export function __getRtcInstance(clawId) {
	return rtcInstances.get(clawId);
}

export class WebRtcConnection {
	/**
	 * @param {string} clawId
	 * @param {import('./claw-connection.js').ClawConnection} clawConn - 关联的 DC 连接
	 * @param {object} [opts]
	 * @param {function} [opts.PeerConnection] - 可替换的 RTCPeerConnection 构造函数（测试用）
	 */
	constructor(clawId, clawConn, opts = {}) {
		this.clawId = clawId;
		this.__clawConn = clawConn;
		this.__PeerConnection = opts.PeerConnection ?? globalThis.RTCPeerConnection;
		this.__pc = null;
		this.__rpcChannel = null;
		this.__state = 'idle';
		/**
		 * close() 计数器：每次 close() 自增。供 __buildPeerConnection 跨 await 检测
		 * "build 期间是否被外部 close 打断"——比靠 state==='closed' 判断更精确，
		 * 因为允许从 'closed' 起步重新 connect（合法场景）。
		 */
		this.__closeEpoch = 0;
		this.__candidateType = null;
		/** @type {{ localType: string, localProtocol: string, remoteType: string, remoteProtocol: string, relayProtocol: string|null }|null} */
		this.__transportInfo = null;
		this.__onRtcMsg = null;
		/** @type {{ data: string, resolve: Function, reject: Function }[]} */
		this.__sendQueue = [];
		/** @type {object[]} answer 到达前暂存的远端 ICE candidates */
		this.__pendingCandidates = [];
		this.__remoteDescSet = false;
		/** 分片 msgId 自增计数器 */
		this.__nextMsgId = 1;
		/** @type {{ feed: Function, reset: Function }|null} */
		this.__reassembler = null;
		/** DC probe 状态 */
		this.__probeResolve = null;
		this.__probeTimer = null;
		this.__probePromise = null;
		/** disconnected 状态超时定时器 */
		this.__disconnectedTimer = null;
		/** APP 进入后台的时间戳（ms epoch），0 = 未进过后台或已处理完；
		 *  前台恢复时据此按后台时长选择 disconnected timer 长度（短后台 5s / 长后台 1.5s） */
		this.__backgroundAt = 0;
		/** DC 应用层保活 */
		this.__lastDcActivityAt = 0;
		this.__keepaliveTimer = null;
		this.__keepaliveGen = 0;
		this.__onAppBackground = null;
		this.__onAppForeground = null;
		/** ICE restart 状态 */
		this.__restartTimer = null;
		this.__restartPollTimer = null;
		this.__restartAttemptCount = 0;
		this.__restartStartTime = 0;
		this.__restartInFlight = false;
		/** 本轮 ICE restart 最近一次 offer 发出时间戳；answer 到达时据此计算 RTT */
		this.__restartOfferSentAt = 0;
		/** pre-restart selected pair 的 local ufrag 快照；stats 轮询据此判"是否走上新路径" */
		this.__restartUfragSnap = null;
		/** restart 代次（每次 __clearRestartState 递增）；用于拦截跨 epoch 的 snap.then 迟到 */
		this.__restartEpoch = 0;
		/** 本 epoch 内 ufrag 缺失日志是否已打；避免每次 poll 都刷日志 */
		this.__restartUfragMissingLogged = false;
		/** pauseRestart 标志：下次 __attemptRestart 视为 first trigger（重采 snap、重 dumpStats） */
		this.__restartPaused = false;
		/** TURN 凭证过期时间戳（Unix 秒），用于 ICE restart 日志诊断 */
		this.__credExpireAt = null;
		/** 本地 ICE candidate 按 typ 分类计数（诊断用），gathering 完成时输出汇总 */
		this.__iceCandCounts = { host: 0, srflx: 0, relay: 0, prflx: 0 };
		/** @type {function|null} 状态变更回调（供外部同步 store） */
		this.onStateChange = null;
		/** @type {function|null} DataChannel 可用回调（通知外部传输选择） */
		this.onReady = null;
	}

	/** @private 重置本地 candidate 类型计数器 */
	__resetIceCandCounts() {
		this.__iceCandCounts.host = 0;
		this.__iceCandCounts.srflx = 0;
		this.__iceCandCounts.relay = 0;
		this.__iceCandCounts.prflx = 0;
	}

	/** @returns {'idle' | 'connecting' | 'connected' | 'restarting' | 'failed' | 'closed'} */
	get state() { return this.__state; }
	get candidateType() { return this.__candidateType; }
	get transportInfo() { return this.__transportInfo; }
	/** ICE restart 是否被 pauseRestart 冻结（外部判断是否需要 online_resume 触发 unstick） */
	get restartPaused() { return this.__restartPaused; }

	/** 发起 WebRTC 连接 */
	async connect(turnCreds) {
		if (this.__state !== 'idle' && this.__state !== 'closed' && this.__state !== 'failed') return;
		await this.__buildPeerConnection(turnCreds);
	}

	/**
	 * 关闭连接并释放所有资源。
	 * - 默认 asFailed=false：主动关闭（如 claw 移除、rebuild 前清理），state → 'closed'
	 * - asFailed=true：因恢复失败而终结（4 处 restart 失败入口），state → 'failed'
	 *   语义上仍表示"此 PC 已死"，store 据此退避重试 rebuild
	 * 幂等：二次调用不重发 rtc:closed 信令，__pc 已为 null 时直接跳过 close
	 */
	close({ asFailed = false } = {}) {
		this.__closeEpoch++;
		this.__stopKeepalive();
		this.__clearRestartState();
		this.__unregisterAppLifecycle();
		this.__clearDisconnectedTimer();
		this.__backgroundAt = 0;
		this.__settleProbe(false);
		this.__removeRtcListener();
		this.__rejectSendQueue(asFailed ? 'rtc failed' : 'connection closed');
		if (this.__pc) {
			useSignalingConnection().sendSignaling(this.clawId, 'rtc:closed');
			// __rpcChannel = null 必须早于 pc.close()。`pc.close()` 在浏览器中会同步 fire
			// `dc.onclose`，原顺序（pc.close → __pc=null → __rpcChannel=null）会让重入的
			// onclose 看到 `__rpcChannel === dc` 仍 true + `state === 'connected'` 仍 true →
			// 二次 close({asFailed:true}) → 第二次 sendSignaling('rtc:closed') + state 短暂
			// 转 'failed' 再被外层覆盖回 'closed'。提前清空 __rpcChannel 让同步重入 short-circuit。
			// 由于此后 dc.onclose 不再调 `__rejectAllPending`，需要在此处兜底 reject pending RPC，
			// 避免 close 路径下挂起请求永远等不到响应。
			this.__rpcChannel = null;
			this.__rejectClawConnPending(asFailed ? 'rtc failed' : 'connection closed');
			const pc = this.__pc;
			this.__pc = null;
			pc.close();
		} else {
			// __pc 不存在分支也保持幂等：清 __rpcChannel + reject pending（即使绝大多数情况下
			// 此时已为空，避免依赖外部调用顺序）
			this.__rpcChannel = null;
			this.__rejectClawConnPending(asFailed ? 'rtc failed' : 'connection closed');
		}
		this.__setState(asFailed ? 'failed' : 'closed');
	}

	/**
	 * @private 调 clawConn.__rejectAllPending（容忍 mock 不实现该方法）。
	 * 生产代码下 ClawConnection 必有此方法；此处的容错主要为旧测试 mock 兼容。
	 * @param {string} message
	 */
	__rejectClawConnPending(message) {
		const fn = this.__clawConn?.__rejectAllPending;
		if (typeof fn === 'function') fn.call(this.__clawConn, message, 'DC_CLOSED');
	}

	/**
	 * 通过 DataChannel 发送 JSON（带流控 + 自动分片）
	 * @param {object} payload
	 * @returns {Promise<void>} resolve 表示数据已提交到 DC 发送缓冲区
	 */
	send(payload) {
		const dc = this.__rpcChannel;
		if (!dc || dc.readyState !== 'open') {
			const method = payload?.method ?? '?';
			this.__log('warn', `send: DC not open, method=${method} state=${dc?.readyState ?? 'null'}`);
			return Promise.reject(new Error('DataChannel not open'));
		}
		const jsonStr = JSON.stringify(payload);

		// pre-check：是否需要分片
		const maxSize = this.__pc?.sctp?.maxMessageSize ?? 65536;
		const chunks = buildChunks(jsonStr, maxSize, () => this.__nextMsgId++);

		if (!chunks) {
			return this.__enqueueSend(jsonStr);
		}

		console.debug('[WebRTC] send: chunking %d bytes → %d chunks (maxMsgSize=%d)', new TextEncoder().encode(jsonStr).byteLength, chunks.length, maxSize);
		return this.__enqueueSendMulti(chunks);
	}

	/**
	 * @private 入队单条消息（string 或 ArrayBuffer）
	 * @param {string|ArrayBuffer} data
	 * @returns {Promise<void>}
	 */
	__enqueueSend(data) {
		const dc = this.__rpcChannel;
		// 快路径：队列为空且缓冲区未满 → 直接发送
		if (this.__sendQueue.length === 0 && dc.bufferedAmount < DC_HIGH_WATER_MARK) {
			try {
				dc.send(data);
				return Promise.resolve();
			} catch (err) {
				// try-catch 安全网：DC 仍存活则尝试分片（未来扩大 maxMessageSize 时兜底）
				if (typeof data === 'string' && dc.readyState === 'open') {
					this.__log('warn', `dc.send threw but DC still open, retrying with chunking: ${err?.message}`);
					const chunks = buildChunks(data, Math.floor((this.__pc?.sctp?.maxMessageSize ?? 65536) / 2), () => this.__nextMsgId++);
					if (chunks) return this.__enqueueSendMulti(chunks);
				}
				this.__log('warn', `dc.send failed: ${err?.message} dcState=${dc.readyState}`);
				return Promise.reject(err);
			}
		}
		return new Promise((resolve, reject) => {
			this.__sendQueue.push({ data, resolve, reject });
		});
	}

	/**
	 * @private 将多个 chunk 同步入队（保证连续性）
	 * @param {ArrayBuffer[]} chunks
	 * @returns {Promise<void>}
	 */
	__enqueueSendMulti(chunks) {
		const dc = this.__rpcChannel;
		// 尝试快路径发送尽可能多的 chunk
		let i = 0;
		if (this.__sendQueue.length === 0) {
			while (i < chunks.length && dc.bufferedAmount < DC_HIGH_WATER_MARK) {
				try {
					dc.send(chunks[i]);
					i++;
				} catch (err) {
					this.__log('warn', `dc.sendMulti failed at chunk ${i}/${chunks.length}: ${err?.message}`);
					return Promise.reject(err);
				}
			}
		}
		if (i >= chunks.length) return Promise.resolve();

		// 剩余 chunk 入队，最后一个 chunk 的 promise 作为整体 resolve
		return new Promise((resolve, reject) => {
			for (; i < chunks.length; i++) {
				const isLast = i === chunks.length - 1;
				this.__sendQueue.push({
					data: chunks[i],
					resolve: isLast ? resolve : () => {},
					reject,
				});
			}
		});
	}

	/** DataChannel 是否可用 */
	get isReady() {
		return this.__rpcChannel?.readyState === 'open';
	}

	/**
	 * 创建自定义 DataChannel（供文件传输等场景使用）
	 * @param {string} label - 通道名称（如 'file:<transferId>'）
	 * @param {RTCDataChannelInit} [opts] - DataChannel 配置
	 * @returns {RTCDataChannel|null} 创建的 DC，PC 不可用时返回 null
	 */
	createDataChannel(label, opts) {
		// restarting 不拒：ICE restart 保留 SCTP/DTLS，新 DC 会先停在 connecting、
		// 等 ICE 切完 UDP 通路后自己 open（与现有 DC 在 restart 期间存活同构）。
		// 若此处误拒会把前台恢复瞬间并发触发的文件下载立即拍死成 RTC_NOT_READY。
		if (!this.__pc || this.__state === 'closed' || this.__state === 'failed') return null;
		const dc = this.__pc.createDataChannel(label, opts);
		// binary 帧以 ArrayBuffer 形式到达（规范默认为 'blob'，部分浏览器实现也不一致）。
		// 必须在 dc 打开前设置：一是确保第一条 binary 到来时账本能正确计字节；
		// 二是避免 Blob 构造的异步性让最后一条 message 被 onclose 抢先派发。
		dc.binaryType = 'arraybuffer';
		// 追踪 file DC 的数据活动，证明 SCTP 存活（用于保活宽限判断）
		// message: 入向数据；bufferedamountlow: 出向数据真实进入网络（上传场景下唯一的活动信号）
		dc.addEventListener('message', () => { this.__lastDcActivityAt = Date.now(); });
		dc.addEventListener('bufferedamountlow', () => { this.__lastDcActivityAt = Date.now(); });
		return dc;
	}

	/**
	 * 通过 DC 发送探测消息验证连接是否存活
	 * @param {number} [timeoutMs=3000] - 超时毫秒数
	 * @returns {Promise<boolean>} true=连接存活
	 */
	probe(timeoutMs = 3000) {
		// 已有 probe 进行中 → 复用其 promise
		if (this.__probePromise) return this.__probePromise;
		const dc = this.__rpcChannel;
		if (!dc || dc.readyState !== 'open') return Promise.resolve(false);
		this.__probePromise = new Promise((resolve) => {
			this.__probeResolve = resolve;
			this.__probeTimer = setTimeout(() => this.__settleProbe(false), timeoutMs);
			try {
				dc.send(JSON.stringify({ type: 'probe' }));
			} catch {
				this.__settleProbe(false);
			}
		});
		return this.__probePromise;
	}

	/** @private 结算 probe（统一出口：超时/ack/send 失败/close） */
	__settleProbe(result) {
		if (this.__probeTimer) {
			clearTimeout(this.__probeTimer);
			this.__probeTimer = null;
		}
		const resolve = this.__probeResolve;
		this.__probeResolve = null;
		this.__probePromise = null;
		resolve?.(result);
	}

	// --- 内部：建连 ---

	/** @private */
	async __buildPeerConnection(turnCreds) {
		// 清理旧 PC（rebuild 场景）；同步清 restart 状态，保证 snap/epoch 与 PC 对齐
		// （正常路径 close() 已前置清过，这里是防御性 invariant：任何 rebuild 入口都不会
		// 让旧 PC 的 ufrag snap 被新 PC 的 poll 误用）
		if (this.__pc) {
			this.__pc.onicecandidate = null;
			this.__pc.onconnectionstatechange = null;
			this.__pc.close();
			this.__pc = null;
			this.__rpcChannel = null;
			this.__clearRestartState();
		}

		// 跨 await close 防护用 epoch 快照：build 期间任何 close() 调用都会让 __closeEpoch 递增；
		// 三个 await 后比对 epoch 是否变化 → 变化即视为 build 被外部打断，立即 abort。
		// 不能仅靠 `state==='closed'` 判断：从 'closed' 起步 connect 是合法场景（rebuild），
		// 此时初始 state 就是 'closed'，跨 await 后没收到 close 也仍是 'closed'。
		const buildEpoch = this.__closeEpoch;

		// 确保信令 WS 可用（rebuild 场景下 WS 可能已断开）；ensureConnected 内部自带新鲜度兜底
		await useSignalingConnection().ensureConnected();
		if (this.__closeEpoch !== buildEpoch) {
			this.__log('info', 'connect aborted: closed during ensureConnected');
			return;
		}

		this.__remoteDescSet = false;
		this.__pendingCandidates = [];
		this.__candidateType = null;
		this.__transportInfo = null;
		this.__credExpireAt = parseCredExpireAt(turnCreds?.username);
		this.__resetIceCandCounts();
		this.__setState('connecting');

		const iceServers = this.__buildIceServers(turnCreds);
		const pc = new this.__PeerConnection({ iceServers });
		this.__pc = pc;

		this.__setupPcEvents(pc);
		this.__ensureRtcListener();

		// 创建 rpc DataChannel（UI 是主叫方）
		const dc = pc.createDataChannel('rpc', { ordered: true });
		this.__rpcChannel = dc;
		this.__setupDataChannelEvents(dc);

		// 创建并发送 offer。
		// createOffer / setLocalDescription 在 closed pc 上会抛 InvalidStateError；
		// 跨 await close 时 try/catch 吃掉异常 + 守卫 __closeEpoch：避免把"已 close 后清理产生的
		// late reject"当成真实建连失败穿透到 initRtc 的 .then(rtc.connect).catch（initRtc 会
		// settle('failed') 并 clearRtc → 重复触发 store 退避）。
		let offer;
		try {
			offer = await pc.createOffer();
		} catch (err) {
			if (this.__closeEpoch !== buildEpoch || this.__pc !== pc) {
				this.__log('info', `connect aborted: closed during createOffer (${err?.message ?? 'err'})`);
				return;
			}
			throw err;
		}
		if (this.__closeEpoch !== buildEpoch || this.__pc !== pc) {
			this.__log('info', 'connect aborted: closed/replaced during createOffer');
			return;
		}
		try {
			await pc.setLocalDescription(offer);
		} catch (err) {
			if (this.__closeEpoch !== buildEpoch || this.__pc !== pc) {
				this.__log('info', `connect aborted: closed during setLocalDescription (${err?.message ?? 'err'})`);
				return;
			}
			throw err;
		}
		if (this.__closeEpoch !== buildEpoch || this.__pc !== pc) {
			this.__log('info', 'connect aborted: closed/replaced during setLocalDescription');
			return;
		}
		useSignalingConnection().sendSignaling(this.clawId, 'rtc:offer', { sdp: offer.sdp });
		this.__log('info', `offer sent for claw ${this.clawId}`);
	}

	/** @private */
	__buildIceServers(turnCreds) {
		const iceServers = [];
		if (turnCreds) {
			for (const url of turnCreds.urls) {
				const s = { urls: url };
				if (url.startsWith('turn:') || url.startsWith('turns:')) {
					s.username = turnCreds.username;
					s.credential = turnCreds.credential;
				}
				iceServers.push(s);
			}
		}
		return iceServers;
	}

	/** @private */
	__setupPcEvents(pc) {
		// ICE candidate → 通过信令 WS 发给 Plugin；同时按类型计数，gathering 完成时打印汇总
		pc.onicecandidate = (event) => {
			if (!event.candidate) {
				const c = this.__iceCandCounts;
				this.__log('info', `iceGathered host=${c.host} srflx=${c.srflx} relay=${c.relay} prflx=${c.prflx}`);
				return;
			}
			const typMatch = event.candidate.candidate?.match(/typ (\w+)/);
			const typ = typMatch?.[1];
			if (typ && this.__iceCandCounts[typ] !== undefined) this.__iceCandCounts[typ]++;
			useSignalingConnection().sendSignaling(this.clawId, 'rtc:ice', event.candidate.toJSON());
		};

		// ICE candidate gathering 过程出错（TURN 认证失败、STUN 超时等）→ 告警
		// 不同浏览器对此事件的支持度不同；赋值本身对老内核无副作用。
		pc.onicecandidateerror = (event) => {
			if (this.__pc !== pc) return;
			const url = event?.url ?? '?';
			const hostCandidate = event?.hostCandidate ?? event?.address ?? '?';
			const port = event?.port ?? '?';
			const code = event?.errorCode ?? '?';
			const text = event?.errorText ?? '';
			this.__log('warn', `iceCandErr url=${url} host=${hostCandidate} port=${port} code=${code} text=${text}`);
		};

		// ICE agent 状态（independent from connectionState；能看到 checking→connected 的真实跳转）
		pc.oniceconnectionstatechange = () => {
			if (this.__pc !== pc) return;
			this.__log('info', `iceState: ${pc.iceConnectionState}`);
		};

		// ICE gathering 阶段（new/gathering/complete）
		pc.onicegatheringstatechange = () => {
			if (this.__pc !== pc) return;
			const g = pc.iceGatheringState;
			// 每次进入 gathering（含 restart）→ 重置候选计数器
			if (g === 'gathering') this.__resetIceCandCounts();
			this.__log('info', `iceGather: ${g}`);
		};

		// 信令状态机（have-local-offer / stable / have-remote-offer 等）
		pc.onsignalingstatechange = () => {
			if (this.__pc !== pc) return;
			this.__log('info', `sigState: ${pc.signalingState}`);
		};

		// 连接状态变更
		pc.onconnectionstatechange = () => {
			if (this.__pc !== pc) return; // 防止旧 PC 回调
			const s = pc.connectionState;
			this.__log('info', `connectionState: ${s}`);

			if (s === 'connected') {
				this.__clearDisconnectedTimer();
				const wasRestarting = this.__state === 'restarting';
				if (wasRestarting) {
					this.__log('info', 'ICE restart succeeded via=event');
					this.__clearRestartState();
				}
				this.__setState('connected');
				this.__startKeepalive(); // 幂等；restart 成功后恢复保活（dc.onopen 不再触发）
				this.__resolveCandidateType(pc);
				// restart 成功后 2s 再 dump 一次 stats，验证通告 connected 后是否真的有数据流
				if (wasRestarting) {
					setTimeout(() => {
						if (this.__pc === pc && this.__state === 'connected') {
							this.__dumpStats('post-restart-success');
						}
					}, 2000);
				}
			} else if (s === 'disconnected') {
				// restarting 中的 disconnected 是中间状态，忽略
				if (this.__state === 'restarting') return;
				// 短暂网络抖动，等待 ICE 自动恢复；设超时兜底
				this.__log('info', 'ICE disconnected, waiting for auto-recovery...');
				this.__startDisconnectedTimer();
			} else if (s === 'failed') {
				this.__clearDisconnectedTimer();
				// restarting 中的 failed 表示本次 ICE check 失败，立即触发下次尝试（无需等 timer）
				if (this.__state === 'restarting') {
					this.__log('info', 'ICE check failed during restart, retrying immediately');
					this.__attemptRestart('ice_check_failed');
					return;
				}
				this.__onIceFailed();
			} else if (s === 'closed') {
				this.__clearDisconnectedTimer();
				this.__clearRestartState();
				this.__setState('closed');
			}
		};
	}

	/** @private */
	__setupDataChannelEvents(dc) {
		dc.bufferedAmountLowThreshold = DC_LOW_WATER_MARK;
		dc.binaryType = 'arraybuffer'; // 确保二进制消息以 ArrayBuffer 形式到达
		dc.addEventListener('bufferedamountlow', () => {
			this.__drainSendQueue();
		});

		this.__reassembler = createReassembler((jsonStr) => {
			try {
				const payload = JSON.parse(jsonStr);
				if (payload.type === 'probe-ack') {
					this.__settleProbe(true);
					return;
				}
				// plugin 主动探针：立即回 ack（绕过发送队列，与 probe-ack 对称处理）
				// 用于诊断"pion 报告 connected 但 DC 实际不通"的场景
				if (payload.type === 'plugin-probe') {
					try { dc.send(JSON.stringify({ type: 'plugin-probe-ack', id: payload.id })); }
					catch (err) { this.__log('warn', `plugin-probe-ack send failed: ${err?.message}`); }
					this.__log('info', `plugin-probe echoed id=${payload.id}`);
					return;
				}
				this.__clawConn.__onRtcMessage(payload);
			} catch (err) {
				console.warn('[rtc] DataChannel 消息解析失败:', err);
			}
		});

		dc.onopen = () => {
			if (this.__rpcChannel !== dc) return; // PC 已被替换或 close()，忽略旧 DC 事件
			this.__lastDcActivityAt = Date.now();
			this.__log('info', 'DataChannel "rpc" opened');
			useSignalingConnection().sendSignaling(this.clawId, 'rtc:ready');
			this.onReady?.();
			this.__startKeepalive();
		};
		dc.onclose = () => {
			this.__log('info', 'DataChannel "rpc" closed');
			this.__reassembler?.reset();
			if (this.__rpcChannel === dc) {
				this.__rpcChannel = null;
				this.__rejectSendQueue('DataChannel closed');
				// 已发出的 pending RPC 永远收不到响应，立即 reject
				this.__clawConn.__rejectAllPending('DataChannel closed', 'DC_CLOSED');
				// DC 意外关闭（SCTP 已断）：
				// - restarting 时：restart 无法挽救（ICE 层就算恢复，SCTP session 已失效）
				// - connected 时：对端 close DC 或 SCTP 故障，PC 已不可用
				// 两种情况都走 close({asFailed:true})，让 onRtcStateChange('failed') 把
				// store.dcReady 同步为 false，并让 __scheduleRetry 接管 rebuild。
				// closed / failed 态下不重复 close（幂等）。
				if (this.__state === 'restarting' || this.__state === 'connected') {
					this.__log('warn', `DC closed unexpectedly, SCTP lost (state=${this.__state})`);
					this.close({ asFailed: true });
				}
			}
		};
		dc.onerror = (event) => {
			this.__log('warn', `DataChannel "rpc" error: ${event?.error?.message ?? event?.message ?? 'unknown'}`);
		};
		dc.onmessage = (event) => {
			this.__lastDcActivityAt = Date.now();
			try {
				this.__reassembler?.feed(event.data);
			} catch (err) {
				console.warn('[rtc] DataChannel 消息错误:', err);
			}
		};
	}

	/** @private 缓冲区降到低水位时排出队列 */
	__drainSendQueue() {
		const dc = this.__rpcChannel;
		while (this.__sendQueue.length > 0) {
			if (!dc || dc.readyState !== 'open') {
				this.__log('warn', `drainSendQueue: DC not open, rejecting ${this.__sendQueue.length} queued msgs`);
				this.__rejectSendQueue('DataChannel closed');
				return;
			}
			if (dc.bufferedAmount >= DC_HIGH_WATER_MARK) return;
			const item = this.__sendQueue.shift();
			try {
				dc.send(item.data);
				item.resolve();
			}
			catch (err) {
				this.__log('warn', `drainSendQueue: dc.send failed, rejecting ${this.__sendQueue.length} remaining: ${err?.message}`);
				item.reject(err);
				// send 异常通常意味着通道不可用，reject 剩余队列
				this.__rejectSendQueue('DataChannel send failed');
				return;
			}
		}
	}

	/** @private reject 队列中所有待发送消息 */
	__rejectSendQueue(msg) {
		const queue = this.__sendQueue.splice(0);
		if (queue.length) {
			this.__log('warn', `rejectSendQueue: ${queue.length} msgs rejected reason=${msg}`);
		}
		for (const { reject } of queue) {
			reject(new Error(msg));
		}
	}

	/**
	 * @private 启动 disconnected 状态超时定时器
	 * @param {number} [timeoutMs=DISCONNECTED_TIMEOUT_MS] - 覆盖默认超时（前台恢复路径用）
	 */
	__startDisconnectedTimer(timeoutMs = DISCONNECTED_TIMEOUT_MS) {
		this.__clearDisconnectedTimer();
		this.__disconnectedTimer = setTimeout(() => {
			this.__disconnectedTimer = null;
			if (this.__pc?.connectionState === 'disconnected') {
				this.__log('warn', `ICE disconnected timeout (${timeoutMs}ms), escalating to recovery`);
				this.__onIceFailed();
			}
		}, timeoutMs);
	}

	/** @private 清除 disconnected 超时定时器 */
	__clearDisconnectedTimer() {
		if (this.__disconnectedTimer) {
			clearTimeout(this.__disconnectedTimer);
			this.__disconnectedTimer = null;
		}
	}

	// --- 内部：DC 应用层保活 ---
	// ICE consent refresh 仅验证 DTLS 传输路径，无法感知 SCTP 层断裂。
	// 大文件经 TURN relay 传输时可能导致 SCTP 静默死亡（ICE 仍报告 connected）。
	// 此定时保活通过 probe/probe-ack 检测端到端 DC 可达性，失败时关闭 PC 触发重建。

	/** @private 启动保活定时器（幂等） */
	__startKeepalive() {
		if (this.__keepaliveTimer) return;
		const gen = ++this.__keepaliveGen;
		this.__scheduleKeepalive(gen);
		this.__registerAppLifecycle();
	}

	/** @private 调度下一次保活 probe */
	__scheduleKeepalive(gen) {
		this.__keepaliveTimer = setTimeout(() => this.__doKeepalive(gen), DC_KEEPALIVE_INTERVAL_MS);
	}

	/** @private 执行一次保活 probe，失败则关闭连接 */
	async __doKeepalive(gen) {
		this.__keepaliveTimer = null;
		if (gen !== this.__keepaliveGen) return;
		// restarting 时跳过 probe（DC 可能暂时不通，由 restart 流程处理）
		if (this.__state === 'restarting') return;
		const alive = await this.probe(DC_KEEPALIVE_TIMEOUT_MS);
		if (gen !== this.__keepaliveGen) return;
		if (!alive && this.__state === 'connected') {
			// 近期有 DC 数据活动（含 file DC）→ SCTP 存活，只是拥塞，跳过本次
			const elapsed = Date.now() - this.__lastDcActivityAt;
			if (elapsed < DC_ACTIVITY_GRACE_MS) {
				this.__log('debug', `keepalive probe timeout but DC active ${elapsed}ms ago, skipping close`);
				this.__scheduleKeepalive(gen);
				return;
			}
			remoteLog(`dc.keepalive-failed claw=${this.clawId}`);
			this.__log('warn', 'DC keepalive probe failed, triggering ICE recovery');
			this.__onIceFailed();
			return;
		}
		// 仍健康 → 调度下一轮
		if (this.__state === 'connected' && this.__rpcChannel?.readyState === 'open') {
			this.__scheduleKeepalive(gen);
		}
	}

	/** @private 停止保活定时器，让残留回调失效 */
	__stopKeepalive() {
		if (this.__keepaliveTimer) {
			clearTimeout(this.__keepaliveTimer);
			this.__keepaliveTimer = null;
		}
		this.__keepaliveGen++;
	}

	/** @private 注册 Capacitor app 前后台事件（幂等） */
	__registerAppLifecycle() {
		if (this.__onAppBackground) return;
		this.__onAppBackground = () => {
			this.__stopKeepalive();
			// 后台时停止 restart 周期重试（前台恢复后由 store nudge 触发）
			this.__stopRestartTimer();
			// stats 轮询同样在后台停；前台 nudge 进入 __attemptRestart 时按 snap 存在与否恢复
			this.__stopRestartPoll();
			// 后台期间不启动主动恢复：清 disconnected timer，避免 fire 后 setLocalDescription
			// 换掉 ICE creds 导致原 pair 自愈机会被剥夺，且后台 offer 可能发不出
			this.__clearDisconnectedTimer();
			// 记录进入后台时刻，前台恢复时按驻留时长决定新 disconnected timer 长度
			this.__backgroundAt = Date.now();
		};
		this.__onAppForeground = () => {
			const bgAt = this.__backgroundAt;
			// Math.max 保护：系统时钟回跳（NTP 校准）导致 Date.now() < bgAt 时归零
			const bgDuration = bgAt ? Math.max(0, Date.now() - bgAt) : 0;
			this.__backgroundAt = 0;
			// pauseRestart 冻结期间（门控关：claw.offline 或 sig_offline）不 re-arm
			// disconnected timer / keepalive——等 resumeRecovery 或 triggerRestart('online_resume')
			// 显式解锁后再启动。否则 probe 失败会走到 __onIceFailed，虽然 restart offer 会被 paused
			// gate drop，但 probe RPC 白发 + 破坏"门控关着时预算冻结"语义
			if (this.__restartPaused) return;
			// PC 仍处于 disconnected 时按后台时长 re-arm timer；restart 进行中不干预
			if (this.__pc?.connectionState === 'disconnected' && this.__state !== 'restarting') {
				const timeoutMs = bgDuration < SHORT_BACKGROUND_MS
					? DISCONNECTED_TIMEOUT_MS
					: DISCONNECTED_TIMEOUT_RESUME_MS;
				this.__log('info', `foreground disconnected re-arm bgDur=${bgDuration}ms timeout=${timeoutMs}ms`);
				this.__startDisconnectedTimer(timeoutMs);
			}
			// 保留：连接仍健康则恢复保活
			if (this.__state === 'connected' && this.__rpcChannel?.readyState === 'open') {
				this.__startKeepalive();
			}
		};
		window.addEventListener('app:background', this.__onAppBackground);
		window.addEventListener('app:foreground', this.__onAppForeground);
	}

	/** @private 注销 Capacitor app 前后台事件 */
	__unregisterAppLifecycle() {
		if (this.__onAppBackground) {
			window.removeEventListener('app:background', this.__onAppBackground);
			this.__onAppBackground = null;
		}
		if (this.__onAppForeground) {
			window.removeEventListener('app:foreground', this.__onAppForeground);
			this.__onAppForeground = null;
		}
	}

	/** @private 获取并记录实际 ICE candidate 类型及传输详情 */
	__resolveCandidateType(pc) {
		pc.getStats().then((report) => {
			if (this.__pc !== pc) return; // PC 已被替换（rebuild），丢弃过期结果
			for (const stat of report.values()) {
				if (stat.type !== 'candidate-pair' || !stat.nominated) continue;

				let local = null;
				let remote = null;
				for (const s of report.values()) {
					if (s.type === 'local-candidate' && s.id === stat.localCandidateId) local = s;
					if (s.type === 'remote-candidate' && s.id === stat.remoteCandidateId) remote = s;
					if (local && remote) break;
				}
				if (!local) return;

				this.__candidateType = local.candidateType;
				const info = {
					localType: local.candidateType ?? 'unknown',
					localProtocol: local.protocol ?? 'unknown',
					remoteType: remote?.candidateType ?? 'unknown',
					remoteProtocol: remote?.protocol ?? 'unknown',
					relayProtocol: local.relayProtocol ?? null,
				};
				this.__transportInfo = info;

				const isRelay = local.candidateType === 'relay';
				const label = isRelay ? 'TURN' : 'P2P';
				const proto = isRelay
					? `relayProtocol=${info.relayProtocol ?? '?'}`
					: `protocol=${info.localProtocol}`;
				this.__log('info',
					`ICE connected: local=${info.localType}/${info.localProtocol}, ` +
					`remote=${info.remoteType}/${info.remoteProtocol} (${label}, ${proto})`);

				if (this.onStateChange) this.onStateChange(this.__state);
				return;
			}
		}).catch(() => {});
	}

	/**
	 * @private 汇总 getStats 关键诊断字段到一行 remoteLog。
	 * 不抛异常；getStats 失败或 PC 已替换时静默跳过（只记录一条 error 日志）。
	 * @param {string} reason - 本次 dump 的触发原因（供日志分类）
	 */
	async __dumpStats(reason) {
		const pc = this.__pc;
		if (!pc || typeof pc.getStats !== 'function') return;
		let report;
		try {
			report = await pc.getStats();
		} catch (err) {
			this.__log('warn', `stats.${reason} getStats failed: ${err?.message ?? err}`);
			return;
		}
		if (this.__pc !== pc) return; // PC 已被替换

		let pair = null;
		let transport = null;
		let rpcStat = null;
		for (const stat of report.values()) {
			if (stat.type === 'candidate-pair') {
				// 优先 nominated，其次 succeeded
				if (stat.nominated) pair = stat;
				else if (!pair && stat.state === 'succeeded') pair = stat;
			} else if (stat.type === 'transport') {
				// 优选带 selectedCandidatePairId 的那个；否则第一个
				if (!transport || stat.selectedCandidatePairId) transport = stat;
			} else if (stat.type === 'data-channel' && stat.label === 'rpc') {
				rpcStat = stat;
			}
		}

		let local = null;
		let remote = null;
		if (pair) {
			for (const s of report.values()) {
				if (s.type === 'local-candidate' && s.id === pair.localCandidateId) local = s;
				if (s.type === 'remote-candidate' && s.id === pair.remoteCandidateId) remote = s;
				if (local && remote) break;
			}
		}

		const pairDesc = pair
			? `pair=[${local?.candidateType ?? '?'}/${local?.protocol ?? '?'}`
				+ `>${remote?.candidateType ?? '?'}/${remote?.protocol ?? '?'}`
				+ ` state=${pair.state ?? '?'} nom=${pair.nominated ? 1 : 0}`
				+ ` bs=${pair.bytesSent ?? 0} br=${pair.bytesReceived ?? 0}`
				+ ` rtt=${pair.currentRoundTripTime ?? '?'}`
				+ ` req=${pair.requestsSent ?? 0} resp=${pair.responsesReceived ?? 0}]`
			: 'pair=none';

		const dtlsDesc = transport
			? `tp=[dtls=${transport.dtlsState ?? '?'} ice=${transport.iceState ?? '?'}`
				+ ` bs=${transport.bytesSent ?? 0} br=${transport.bytesReceived ?? 0}]`
			: 'tp=none';

		const dc = this.__rpcChannel;
		const dcDesc = rpcStat
			? `dc=[state=${rpcStat.state ?? dc?.readyState ?? 'none'}`
				+ ` ms=${rpcStat.messagesSent ?? 0} mr=${rpcStat.messagesReceived ?? 0}`
				+ ` bs=${rpcStat.bytesSent ?? 0} br=${rpcStat.bytesReceived ?? 0}`
				+ ` buf=${dc?.bufferedAmount ?? 0}]`
			: `dc=[state=${dc?.readyState ?? 'none'} buf=${dc?.bufferedAmount ?? 0}]`;

		this.__log('info', `stats.${reason} ${pairDesc} ${dtlsDesc} ${dcDesc}`);
	}

	// --- 内部：恢复 ---

	/** @private ICE failed → 尝试 ICE restart，失败后上报 failed 由外层 rebuild */
	__onIceFailed() {
		this.__attemptRestart('ice_failed');
	}

	// --- ICE restart ---

	/**
	 * @private 发起 ICE restart offer
	 * @param {string} reason - 触发原因（日志用）
	 */
	async __attemptRestart(reason) {
		if (!this.__pc || this.__state === 'closed') return;

		// paused 态（claw offline 或 sig offline 任一路径）仅接受显式 'online_resume' 原因的解冻调用；
		// keepalive→__onIceFailed / pc oniceconnectionstatechange=failed /
		// periodic timer / nudge 等自动路径一律 drop，防止 offline 期间空烧预算+发 offer
		const isExplicitResume = reason === 'online_resume';
		if (this.__restartPaused && !isExplicitResume) {
			this.__log('debug', `restart attempt dropped while paused reason=${reason}`);
			return;
		}
		// 从 pauseRestart 恢复：当作全新一轮 restart，重采 snap/重 dumpStats/重置预算
		const resumingFromPause = this.__restartPaused;
		if (resumingFromPause) this.__restartPaused = false;

		// epoch 捕获提前到函数入口：覆盖所有后续 await（ensureConnected / createOffer /
		// setLocalDescription）——若期间 pauseRestart/__clearRestartState 递增 epoch，
		// await 迟到的 resolve 统一凭 epoch guard 早退，不越过 pause 屏障发 offer。
		const epochAtEntry = this.__restartEpoch;

		// 首次进入 restarting 前打一条"为什么走到这里"的快照，便于定位"UI 以为自己还 connected"的假设
		const firstTriggerThisEpoch = resumingFromPause || this.__state !== 'restarting';
		if (firstTriggerThisEpoch) {
			const pc = this.__pc;
			const dc = this.__rpcChannel;
			const idleAgo = this.__lastDcActivityAt ? Date.now() - this.__lastDcActivityAt : null;
			this.__log('info',
				`restart.trigger reason=${reason}`
				+ ` connState=${pc.connectionState ?? '?'}`
				+ ` iceState=${pc.iceConnectionState ?? '?'}`
				+ ` sigState=${pc.signalingState ?? '?'}`
				+ ` dc=[state=${dc?.readyState ?? 'none'} buf=${dc?.bufferedAmount ?? 0}]`
				+ ` dcIdleAgo=${idleAgo == null ? 'never' : idleAgo}`
				+ ` attempt=${this.__restartAttemptCount}`);
			// fire-and-forget：stats 快照异步到达即可，不阻塞 restart 流程
			this.__dumpStats('pre-restart').catch(() => {});
			// 采集当前 selected pair 的 local ufrag → stats 轮询用它判"新路径"
			// 异步获取；epoch 捕获用于识别"跨 epoch 迟到"——旧 epoch 的 snap 即使在
			// 新 epoch 的 restarting 窗口里到达，也不应覆盖新 epoch 的 snap/poll 基准，
			// 否则会把旧 epoch 的 ufrag 当基准比较当前连接，导致新 restart 窗内的中间
			// 状态被误判为成功。
			const pcAtSnap = this.__pc;
			const epochAtSnap = this.__restartEpoch;
			this.__snapshotSelectedUfrag(pcAtSnap).then((snap) => {
				if (this.__restartEpoch !== epochAtSnap) return; // 已进入下一 epoch
				if (this.__pc !== pcAtSnap || this.__state !== 'restarting') return;
				if (!snap) {
					// 读不到基准就不开启 stats 路径，避免误报；退化为仅事件路径。
					// 语义上：若 pre-restart 根本没有 nominated+succeeded pair，说明 PC 已处于
					// failed/checking/closed 等非"旧 pair 健康"状态——本次 stats 路径想解决的
					// "旧 pair 还活着就 restart"前提本就不成立，事件路径（必然经过
					// checking→connected）即可覆盖。本 epoch 内不再补采。
					this.__log('info', 'ICE restart: no ufrag snap, stats-poll disabled');
					return;
				}
				this.__restartUfragSnap = snap;
				// 仅当 restart timer 仍在跑（即：未被 app:background 暂停）时启动 poll；
				// 若处于后台暂停态，只存 snap，等 foreground nudge 时由 __attemptRestart
				// 的恢复分支（__restartUfragSnap && !__restartPollTimer）启动 poll
				if (this.__restartTimer) {
					this.__startRestartPoll(pcAtSnap);
				}
			}).catch(() => {});
		}

		// 同步进入 restarting（先于 async createOffer，确保状态立即可观测）
		if (this.__state !== 'restarting') {
			this.__stopKeepalive();
			this.__setState('restarting');
		}
		// 首次进入时记录起始时间
		if (!this.__restartStartTime) {
			this.__restartStartTime = Date.now();
		}

		// 时间预算耗尽 → 放弃 restart
		if (Date.now() - this.__restartStartTime >= ICE_RESTART_TIMEOUT_MS) {
			this.__log('warn', `ICE restart timed out after ${ICE_RESTART_TIMEOUT_MS}ms (${this.__restartAttemptCount} attempts)`);
			// 立刻停 poll/timer，防止 500ms dumpStats 窗内 poll tick 迟到判成功后又被 close 覆盖
			this.__stopRestartPoll();
			this.__stopRestartTimer();
			// close 前抓一次 stats，但用 500ms 超时兜底：
			// 病态场景下 pc.getStats() 可能长时间不 resolve（正是本次调查目标），
			// 若直接 await 会阻塞 close() → state 卡在 restarting → store 无法 rebuild。
			await Promise.race([
				this.__dumpStats('restart-timeout'),
				new Promise((r) => setTimeout(r, 500)),
			]);
			// 500ms 窗内已完成的在途 poll tick 可能已把 state 切到 connected（且清过 restart
			// 状态）；此时不应再 close({asFailed:true}) 把合法的 connected 覆盖成 failed
			if (this.__state !== 'restarting') return;
			this.close({ asFailed: true });
			return;
		}

		// 安全网定时器（覆盖 connectionState:failed 未触发的极端场景）
		if (!this.__restartTimer) {
			this.__startRestartTimer();
		}
		// 恢复 stats 轮询：snap 已采但 poll 被 background 停过 → 重启（nudge/periodic 路径）
		if (this.__restartUfragSnap && !this.__restartPollTimer && this.__pc) {
			this.__startRestartPoll(this.__pc);
		}

		// 信令 WS 健康检查：始终 await ensureConnected，让其内部的 lastAliveAt 陈旧检查
		// （signaling-connection.js: HB_TIMEOUT_MS → forceReconnect）有机会触发。
		// __sendRaw / sendSignaling 不做陈旧检查——typeChanged 切网窗口里 WS state 仍 'connected'
		// 但已死掉时，跳过此调用会把 rtc:offer 直接丢进死 WS。
		// WS 健康路径在 ensureConnected 内部基本零成本（一次分支判断即返回）。
		const sig = useSignalingConnection();
		this.__log('debug', `ICE restart: ensureConnected check reason=${reason}`);
		try {
			await sig.ensureConnected();
		} catch {
			// 起点是 pauseRestart 冻结态 → 本次 online_resume 实际失败，回滚到 pause 原状
			// 否则后续自动路径（__onIceFailed/keepalive 等）会通过门控，时间预算到期会被误 close asFailed。
			// state 维持 'restarting' 与 pauseRestart 从 restarting 源态 pause 后的稳态等价——
			// 下轮 __resumeOnline 遍历会按 restarting+paused 分派 triggerRestart('online_resume')
			if (resumingFromPause && this.__restartEpoch === epochAtEntry && this.__state === 'restarting') {
				this.__restartPaused = true;
				this.__restartStartTime = 0; // 下次 online_resume 按"新一轮"起算
				// 停本次 online_resume 入口起的 timer/poll，彻底对齐 pauseRestart 的停机语义
				this.__stopRestartTimer();
				this.__stopRestartPoll();
				this.__log('info', 'ICE restart: ensureConnected failed, revert to paused');
			} else {
				this.__log('info', 'ICE restart: ensureConnected failed, will retry');
			}
			return;
		}
		// 等待期间状态可能已变更（close / 其他路径已恢复 / 超时 / pauseRestart 冻结）
		if (this.__restartEpoch !== epochAtEntry) return;
		if (!this.__pc || this.__state !== 'restarting') return;

		// 防止并发：timer 和 immediate retry 可能在 await 间隙同时触发
		if (this.__restartInFlight) return;

		// restart 重新协商 → 重置候选缓冲，确保新 candidates 等待 restart answer 后再添加
		this.__remoteDescSet = false;
		this.__pendingCandidates = [];

		this.__restartInFlight = true;
		try {
			const offer = await this.__pc.createOffer({ iceRestart: true });
			if (!this.__pc || this.__state === 'closed' || this.__state === 'failed') return;
			if (this.__restartEpoch !== epochAtEntry) return;
			await this.__pc.setLocalDescription(offer);
			if (!this.__pc || this.__state === 'closed' || this.__state === 'failed') return;
			if (this.__restartEpoch !== epochAtEntry) return;
			// 只在确定要真正发 offer 时才累加 attempt，避免 epoch 换代导致虚涨
			this.__restartAttemptCount++;
			this.__restartOfferSentAt = Date.now();
			sig.sendSignaling(this.clawId, 'rtc:offer', { sdp: offer.sdp, iceRestart: true });
			const credRemain = this.__credExpireAt != null ? this.__credExpireAt - Math.floor(Date.now() / 1000) : null;
			this.__log('info', `ICE restart offer sent, reason=${reason} attempt=${this.__restartAttemptCount} credRemain=${credRemain ?? 'none'}`);
		} catch (err) {
			if (this.__state === 'closed' || this.__state === 'failed') return;
			// 若 await 期间被 pauseRestart 冻结或 epoch 已换代（__clearRestartState），
			// 本次 reject 属于旧 epoch 的尾声——不应 close，保留 PC 等显式 resume
			if (this.__restartPaused || this.__restartEpoch !== epochAtEntry) {
				this.__log('debug', `ICE restart reject dropped (paused/epoch) reason=${err?.message ?? '?'}`);
				return;
			}
			this.__log('warn', `ICE restart createOffer failed: ${err?.message}`);
			this.close({ asFailed: true });
		} finally {
			this.__restartInFlight = false;
		}
	}

	/**
	 * 外部触发：store 在 restarting 状态调用，立即重试
	 * （如 network:online / app:foreground 事件触发的恢复路径）
	 */
	nudgeRestart() {
		if (this.__state !== 'restarting') return;
		this.__attemptRestart('nudge');
	}

	/**
	 * 外部触发：store 主动发起 ICE restart（如 WiFi→蜂窝）
	 * @param {string} reason
	 */
	triggerRestart(reason) {
		if (this.__state === 'restarting' || this.__state === 'connected') {
			this.__attemptRestart(reason);
		}
	}

	/**
	 * 外部触发：暂停所有 UI 主动恢复动作，保留 PC。
	 * 由两条路径共用：`__handleClawGoOffline`（SSE 告知 plugin 离线）和
	 * `__freezeAllClawsForSigOffline`（信令 WS 不通时遍历所有 claw）。
	 *
	 * 涵盖两种源状态：
	 * - `restarting`：停 restart timer/poll、清预算字段
	 * - `connected`：停 keepalive、清 disconnected timer，避免 probe 失败或
	 *   disconnected 超时经 __onIceFailed 偷偷升级成新的 restart 周期
	 *
	 * 共同动作：
	 * - 递增 __restartEpoch，让所有在途 await（ensureConnected / createOffer /
	 *   setLocalDescription / snap.then / poll tick）回到 __attemptRestart 时
	 *   凭 epoch guard 即刻退出
	 * - 置 __restartPaused=true：后续任何非 'online_resume' 原因进入
	 *   __attemptRestart 都会在入口被 drop；同时 __onSignaling 入口 drop 迟到的
	 *   rtc:answer / rtc:ice / rtc:restart-rejected，避免被动应用旧 restart 的信令
	 *   让 ICE 跑通或 PC 被关，反把 paused 清掉
	 *
	 * idle/connecting/failed/closed 状态下为 no-op（无主动恢复可停）。
	 * __state 不变；resume 由 store 按状态分派：
	 * - connected → resumeRecovery()
	 * - restarting → triggerRestart('online_resume')
	 */
	pauseRestart() {
		if (this.__state !== 'restarting' && this.__state !== 'connected') return;
		this.__stopKeepalive();
		this.__clearDisconnectedTimer();
		this.__stopRestartTimer();
		this.__stopRestartPoll();
		this.__restartStartTime = 0;
		this.__restartAttemptCount = 0;
		this.__restartOfferSentAt = 0;
		this.__restartUfragSnap = null;
		this.__restartUfragMissingLogged = false;
		this.__restartEpoch++;
		this.__restartPaused = true;
		this.__log('info', `recovery paused state=${this.__state}`);
	}

	/**
	 * 外部触发：claw 从 offline 恢复 online，且 PC 当时仍在 connected（未进入 restarting）。
	 * 仅清 __restartPaused 并恢复 keepalive；不发起 ICE restart（PC 本身仍健康）。
	 * restarting+paused 的 resume 路径由 triggerRestart('online_resume') 接管。
	 *
	 * 失配修正：paused 期间底层 `pc.connectionState` 已经 failed/disconnected 的场景——
	 * `__onIceFailed` 触发 `__attemptRestart` 会在 paused gate (L975) 被 drop，且 UI 层
	 * `__state` 仍为 connected（__setState 没走）。此时若仅清 paused + startKeepalive，
	 * 实际路径已死，要等下一轮 probe/keepalive 超时（30-40s）才被动触发 restart。
	 * 在 resume 入口读 pc.connectionState，failed/disconnected 直接升级为
	 * triggerRestart('online_resume')（paused gate 白名单 reason）立即发 ICE restart offer。
	 *
	 * 非 paused 或 PC 状态非 connected 时为 no-op（调用方负责走正确分支）。
	 *
	 * connected + PC 健康 路径：不再仅 `__startKeepalive()`（那要等完整 30s 周期首次 probe），
	 * 而是调 `__probeNow()` 立即发一次 probe。场景：网络刚恢复时 SCTP 可能已死
	 * 但 pc.connectionState 尚未翻 failed/disconnected（浏览器靠 ICE 自身心跳判定，秒到十几秒级），
	 * 此时仅重启 keepalive 要等 30s 间隔 + 10s 超时才能发现 ≈ 30-40s 黑洞；
	 * 立即 probe 把窗口压到 ~1-3s（probe 超时由 DC_KEEPALIVE_TIMEOUT_MS 决定），
	 * 失败复用 `__doKeepalive` 的 activity-grace / `__onIceFailed` 路径，不新增分派规则。
	 */
	resumeRecovery() {
		if (!this.__restartPaused) return;
		// 升级仅限 connected+paused 场景——这是 resumeRecovery 的设计合约（见 JSDoc）。
		// restarting+paused 由调用方显式走 triggerRestart('online_resume')，
		// resumeRecovery 不自动升级以避免无调用者时的意外行为，保持 API 语义稳定
		if (this.__state === 'connected') {
			const pcState = this.__pc?.connectionState;
			if (pcState === 'failed' || pcState === 'disconnected') {
				this.__log('info', `resumeRecovery upgrade to ice-restart pc=${pcState}`);
				remoteLog(`rtc.resumeUpgradeRestart claw=${this.clawId} pc=${pcState}`);
				// triggerRestart → __attemptRestart('online_resume') 自身会清 __restartPaused
				this.triggerRestart('online_resume');
				return;
			}
		}
		this.__restartPaused = false;
		if (this.__state === 'connected' && this.__rpcChannel?.readyState === 'open') {
			this.__probeNow();
		}
		this.__log('info', `recovery resumed state=${this.__state}`);
	}

	/**
	 * @private 立即启动一次保活 probe（替代 `__startKeepalive` 等完整 30s 周期），
	 * 用于 resumeRecovery 入口——SCTP 已死但 PC 未翻 failed 的场景下能把黑洞从 30-40s 压到 ~1-3s。
	 * 清掉已有 keepalive 定时器（若有）、bump gen 防回调串扰，然后立即调 `__doKeepalive`，
	 * 它的内部会按 probe 结果 schedule 下一轮或走 `__onIceFailed`。
	 */
	__probeNow() {
		if (this.__keepaliveTimer) {
			clearTimeout(this.__keepaliveTimer);
			this.__keepaliveTimer = null;
		}
		// activity-grace 绕过：短 pause（< DC_ACTIVITY_GRACE_MS=20s）场景下，pause 期间 DC 入向事件
		// 停摆 → __lastDcActivityAt 停在 pause 前最后一次活动的时间戳；resume 立即 probe 超时时
		// elapsed = pause 时长 + probe 超时 ≈ 15s < 20s grace → __doKeepalive 会跳过 __onIceFailed
		// 走 schedule 下一轮，"把黑洞压到 ~1-3s" 的意图被抵消退化到 ~45s。
		// 显式清零让 grace 失效一次，probe 失败直接升级 __onIceFailed。
		// 对拥塞保护无误伤：真拥塞不会进 pause 态（pauseRestart 仅由 offline/sig-offline 路径调用）。
		this.__lastDcActivityAt = 0;
		const gen = ++this.__keepaliveGen;
		this.__registerAppLifecycle();
		// __doKeepalive 是 async 但同步返回 Promise：不 await（resumeRecovery 同步语义）；
		// probe 结果由 __doKeepalive 内部自行分派（schedule 下轮 / onIceFailed）
		this.__doKeepalive(gen);
	}

	/** @private 清除 restart 状态（成功/失败/close 时调用） */
	__clearRestartState() {
		this.__stopRestartTimer();
		this.__stopRestartPoll();
		this.__restartAttemptCount = 0;
		this.__restartStartTime = 0;
		this.__restartOfferSentAt = 0;
		this.__restartUfragSnap = null;
		this.__restartUfragMissingLogged = false;
		this.__restartPaused = false;
		// 递增 epoch → 让跨 epoch 的 snap.then / poll tick 失效
		this.__restartEpoch++;
	}

	/** @private 启动 restart 周期重试定时器 */
	__startRestartTimer() {
		this.__stopRestartTimer();
		this.__restartTimer = setInterval(() => {
			if (this.__state !== 'restarting') {
				this.__stopRestartTimer();
				return;
			}
			this.__attemptRestart('periodic');
		}, ICE_RESTART_SAFETY_MS);
	}

	/** @private 停止 restart 周期重试定时器 */
	__stopRestartTimer() {
		if (this.__restartTimer) {
			clearInterval(this.__restartTimer);
			this.__restartTimer = null;
		}
	}

	/**
	 * @private 读取 pc 当前 selected pair 的 local candidate ufrag
	 *
	 * ICE spec 强保证每次 restart 使用新的 ufrag/pwd，因此 pre-restart ufrag
	 * 可作为"新路径已生效"的可靠基准。
	 *
	 * 优先从 getStats 的 local-candidate.usernameFragment 读；若浏览器未暴露
	 * 该字段（部分 Safari/老 Firefox），退回 pc.localDescription.sdp 的
	 * a=ice-ufrag（SDP spec 必填，跨浏览器稳定）。SDP 解析是**同步**的，
	 * 先于 await 执行；调用点 __attemptRestart 在 createOffer 之前发起 snap，
	 * 因此此处捕获到的 localDescription 一定是 restart 前的旧 SDP。
	 * @param {RTCPeerConnection} pc
	 * @returns {Promise<string|null>}
	 */
	async __snapshotSelectedUfrag(pc) {
		if (!pc || typeof pc.getStats !== 'function') return null;
		// 同步捕获旧 SDP 的 ufrag（在 getStats await 之前）
		const sdpUfrag = parseIceUfragFromSdp(pc.localDescription?.sdp);
		let report;
		try {
			report = await pc.getStats();
		} catch {
			return sdpUfrag;
		}
		if (this.__pc !== pc) return null;
		let pair = null;
		for (const stat of report.values()) {
			if (stat.type === 'candidate-pair' && stat.nominated && stat.state === 'succeeded') {
				pair = stat;
				break;
			}
		}
		if (pair) {
			for (const stat of report.values()) {
				if (stat.type === 'local-candidate' && stat.id === pair.localCandidateId) {
					if (stat.usernameFragment) return stat.usernameFragment;
					break;
				}
			}
		}
		// getStats 未暴露 usernameFragment（或无 pair）→ SDP 兜底
		return sdpUfrag;
	}

	/**
	 * @private 启动 stats 轮询：事件路径的并行兜底
	 *
	 * 覆盖"旧 pair 还活着 → restart 瞬间完成 → connectionState 从未跳变"的场景：
	 * 此时 oniceconnectionstatechange / onconnectionstatechange 均不触发，仅靠
	 * getStats 观察到新 pair 被 nominate 才能判定成功。
	 * @param {RTCPeerConnection} pc
	 */
	__startRestartPoll(pc) {
		this.__stopRestartPoll();
		this.__restartPollTimer = setInterval(() => {
			if (this.__pc !== pc || this.__state !== 'restarting') {
				this.__stopRestartPoll();
				return;
			}
			this.__checkRestartViaStats(pc).catch(() => {});
		}, ICE_RESTART_STATS_POLL_MS);
	}

	/** @private 停止 restart stats 轮询 */
	__stopRestartPoll() {
		if (this.__restartPollTimer) {
			clearInterval(this.__restartPollTimer);
			this.__restartPollTimer = null;
		}
	}

	/**
	 * @private 读一次 getStats，若出现 nominated+succeeded 且 ufrag 已变则判定成功
	 * @param {RTCPeerConnection} pc
	 */
	async __checkRestartViaStats(pc) {
		const snap = this.__restartUfragSnap;
		if (!snap) return;
		// 与 snap.then 对称的跨 epoch 护栏：await 期间另一路径若赢下当前 restart
		// 并立即 triggerRestart 进入下一 epoch，本 tick 局部 snap 就变成"上一
		// epoch 的旧 ufrag"，对新 epoch 做比较是错判。epoch guard 使其静默早退。
		const epochAtEntry = this.__restartEpoch;
		let report;
		try {
			report = await pc.getStats();
		} catch {
			return;
		}
		if (this.__restartEpoch !== epochAtEntry) return;
		if (this.__pc !== pc || this.__state !== 'restarting') return;
		// 聚合所有 nominated+succeeded pair 的 localCandidateId：migration 窗口内
		// 浏览器可能同时报告旧+新两个 pair 都满足条件，"首个命中即 break"会卡在
		// 旧 pair 导致永不判成功。正确做法是只要**任一** nominated pair 的 local
		// ufrag ≠ snap 即视为新路径生效。
		const nominatedLocalIds = new Set();
		for (const stat of report.values()) {
			if (stat.type === 'candidate-pair' && stat.nominated && stat.state === 'succeeded') {
				nominatedLocalIds.add(stat.localCandidateId);
			}
		}
		if (nominatedLocalIds.size === 0) return;
		let resolvedAny = false;
		let newUfrag = null;
		for (const stat of report.values()) {
			if (stat.type === 'local-candidate' && nominatedLocalIds.has(stat.id)) {
				const u = stat.usernameFragment ?? null;
				if (u) {
					resolvedAny = true;
					if (u !== snap) { newUfrag = u; break; }
				}
			}
		}
		if (!resolvedAny) {
			// getStats 未暴露任何 usernameFragment（Safari/老 Firefox）→ SDP 兜底。
			// 该时刻 pc.localDescription 可能是：(a) restart 的新 offer（已 setLocalDescription）
			// → 新 ufrag，与 snap 不等 → 判成功；(b) 仍是 restart 前的旧 SDP（createOffer/
			// setLocalDescription 尚未完成）→ 与 snap 相等 → 静默等下一 tick。不会误报。
			const sdpUfrag = parseIceUfragFromSdp(pc.localDescription?.sdp);
			if (!sdpUfrag) {
				// usernameFragment 和 SDP ufrag 都读不到——SDP spec 要求 ufrag 必填，
				// 此分支理论上不应发生；留 warn 便于现场排查
				if (!this.__restartUfragMissingLogged) {
					this.__restartUfragMissingLogged = true;
					this.__log('warn', 'ICE restart stats-poll: usernameFragment and SDP ufrag unavailable, event path only');
				}
				return;
			}
			if (sdpUfrag === snap) return;
			newUfrag = sdpUfrag;
		}
		if (!newUfrag) return;
		// 新路径已选中且生效 → 与事件路径对齐的状态转移
		this.__log('info', 'ICE restart succeeded via=stats');
		this.__clearDisconnectedTimer();
		this.__clearRestartState();
		this.__setState('connected');
		this.__startKeepalive();
		this.__resolveCandidateType(pc);
		setTimeout(() => {
			if (this.__pc === pc && this.__state === 'connected') {
				this.__dumpStats('post-restart-success');
			}
		}, 2000);
	}

	// --- 内部：信令 ---

	/** @private */
	__onSignaling(msg) {
		// paused 期间 restart 相关的迟到信令（answer / ice / reject）一律 drop。
		// 冻结恢复预算的语义要求"不做 active 恢复"：
		// - answer/ice 被处理后，底层 ICE 可能跑通 → onconnectionstatechange('connected')
		//   会走 __clearRestartState 把 __restartPaused 清掉
		// - reject 被处理会直接 close PC + 清 __restartPaused
		// resume 由 resumeRecovery / triggerRestart('online_resume') 显式接手，届时
		// __restartPaused 已被清，新一代信令自然不受此门控影响。
		if (this.__restartPaused) {
			this.__log('debug', `signaling dropped (paused) type=${msg?.type}`);
			return;
		}
		if (msg.type === 'rtc:answer') {
			const pcAtAnswer = this.__pc;
			const wasRestarting = this.__state === 'restarting';
			if (wasRestarting && this.__restartOfferSentAt > 0) {
				const rtt = Date.now() - this.__restartOfferSentAt;
				this.__log('info', `ICE restart answer received, offerRtt=${rtt}ms attempt=${this.__restartAttemptCount}`);
				remoteLog(`rtc.restartAnswer claw=${this.clawId} rtt=${rtt}ms attempt=${this.__restartAttemptCount}`);
				this.__restartOfferSentAt = 0;
			} else {
				this.__log('info', 'answer received, setting remote description');
			}
			pcAtAnswer?.setRemoteDescription({ type: 'answer', sdp: msg.payload.sdp })
				.then(() => {
					// guard：await 期间若被 pauseRestart 冻结或 PC 已被 close 替换，
					// 此处 resolve 是迟到信号，不能写 __remoteDescSet 也不能 drain pendingCandidates
					if (this.__pc !== pcAtAnswer || this.__restartPaused) {
						this.__log('debug', 'rtc:answer setRemoteDescription resolved after pause/rebuild, dropping');
						return;
					}
					this.__remoteDescSet = true;
					// 排空 answer 到达前暂存的 ICE candidates
					const pending = this.__pendingCandidates.splice(0);
					for (const c of pending) {
						this.__pc?.addIceCandidate(c).catch(() => {});
					}
					// restart 应用 answer 后 3s dump 一次 stats：验证新 pair 是否真的在传数据
					if (wasRestarting) {
						setTimeout(() => {
							if (this.__pc === pcAtAnswer) this.__dumpStats('post-answer');
						}, 3000);
					}
				})
				.catch((err) => {
					this.__log('warn', `setRemoteDescription failed: ${err?.message}`);
				});
		} else if (msg.type === 'rtc:ice') {
			if (!this.__remoteDescSet) {
				this.__pendingCandidates.push(msg.payload);
			} else {
				this.__pc?.addIceCandidate(msg.payload).catch(() => {});
			}
		} else if (msg.type === 'rtc:restart-rejected') {
			const reason = msg.payload?.reason ?? 'unknown';
			// connId 按 claw 复用、不按 restart 代际；rebuild 后新 PC 的 listener 仍会收到
			// 旧 restart 的 reject。必须校验"我现在还在 restarting 态"才接受，否则迟到的旧
			// reject 会误杀新 PC，触发多余 failed→rebuild 循环
			if (this.__state !== 'restarting') {
				this.__log('info', `ICE restart-rejected ignored (stale) state=${this.__state} reason=${reason}`);
				remoteLog(`rtc.restartRejectedStale claw=${this.clawId} state=${this.__state} reason=${reason}`);
				return;
			}
			this.__log('warn', `ICE restart rejected by plugin: ${reason}`);
			this.close({ asFailed: true });
		}
	}

	/** @private 确保 rtc 事件监听已注册（幂等） */
	__ensureRtcListener() {
		if (this.__onRtcMsg) return;
		this.__onRtcMsg = ({ clawId, type, payload }) => {
			if (clawId !== this.clawId) return; // 按 clawId 过滤
			this.__onSignaling({ type, payload });
		};
		useSignalingConnection().on('rtc', this.__onRtcMsg);
	}

	/** @private 移除 rtc 事件监听 */
	__removeRtcListener() {
		if (this.__onRtcMsg) {
			useSignalingConnection().off('rtc', this.__onRtcMsg);
			this.__onRtcMsg = null;
		}
	}

	// --- 内部：状态与日志 ---

	/** @private */
	__setState(s) {
		if (this.__state === s) return;
		this.__state = s;
		if (this.onStateChange) this.onStateChange(s);
	}

	/** @private */
	__log(level, msg) {
		console[level]?.(`[WebRTC] ${msg}`);
		// 仅推送 warn + 关键 info（连接状态变更、DC 开关、offer）
		if (level === 'warn' || level === 'info') {
			remoteLog(`rtc.${level} claw=${this.clawId} ${msg}`);
		}
	}
}
