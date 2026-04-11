/**
 * WebRTC DataChannel 连接管理（UI 侧）
 * DataChannel 是唯一的业务 RPC 通道，WS 仅用于信令和保活哨兵。
 *
 * 连接恢复策略：
 * - disconnected → 等待 ICE 自动恢复（短暂网络抖动自愈），10s 超时后升级
 * - failed → 上报 failed 状态，由外层 bots.store 退避重试（每次重新获取 TURN 凭证）
 * - 前台恢复 / 网络切换 → DC probe 探测存活性，超时则 rebuild
 *
 * 注：ICE restart 已移除 — werift 的实现不完整且可能产生僵尸连接
 * 详见 docs/study/webrtc-connection-research.md
 */
import { httpClient } from './http.js';
import { buildChunks, createReassembler } from '../utils/dc-chunking.js';
import { useSignalingConnection } from './signaling-connection.js';
import { remoteLog } from './remote-log.js';

/** disconnected 状态超时：超过此时间仍未恢复则升级到 failed 恢复链（ICE 自愈通常 1-3s） */
const DISCONNECTED_TIMEOUT_MS = 5_000;

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

			// state === 'failed' 仅在所有恢复尝试耗尽后才被设置
			if (rtc.state === 'failed') {
				clearTimeout(fallbackTimer);
				clawConn.clearRtc();
				settle('failed');
			}
		};

		httpClient.get('/api/v1/turn/creds')
			.then((resp) => rtc.connect(resp.data))
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

/** 仅供测试：重置所有实例 */
export function __resetRtcInstances() {
	for (const rtc of rtcInstances.values()) rtc.close();
	rtcInstances.clear();
}

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
		/** DC 应用层保活 */
		this.__lastDcActivityAt = 0;
		this.__keepaliveTimer = null;
		this.__keepaliveGen = 0;
		this.__onAppBackground = null;
		this.__onAppForeground = null;
		/** @type {function|null} 状态变更回调（供外部同步 store） */
		this.onStateChange = null;
		/** @type {function|null} DataChannel 可用回调（通知外部传输选择） */
		this.onReady = null;
	}

	/** @returns {'idle' | 'connecting' | 'connected' | 'failed' | 'closed'} */
	get state() { return this.__state; }
	get candidateType() { return this.__candidateType; }
	get transportInfo() { return this.__transportInfo; }

	/** 发起 WebRTC 连接 */
	async connect(turnCreds) {
		if (this.__state !== 'idle' && this.__state !== 'closed' && this.__state !== 'failed') return;
		await this.__buildPeerConnection(turnCreds);
	}

	/** 关闭连接（主动关闭，不再自动恢复） */
	close() {
		this.__stopKeepalive();
		this.__unregisterAppLifecycle();
		this.__clearDisconnectedTimer();
		this.__settleProbe(false);
		this.__removeRtcListener();
		this.__rejectSendQueue('connection closed');
		if (this.__pc) {
			useSignalingConnection().sendSignaling(this.clawId, 'rtc:closed');
			this.__pc.close();
			this.__pc = null;
		}
		this.__rpcChannel = null;
		this.__setState('closed');
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
		if (!this.__pc || this.__state === 'closed' || this.__state === 'failed') return null;
		const dc = this.__pc.createDataChannel(label, opts);
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
		// 清理旧 PC（rebuild 场景）
		if (this.__pc) {
			this.__pc.onicecandidate = null;
			this.__pc.onconnectionstatechange = null;
			this.__pc.close();
			this.__pc = null;
			this.__rpcChannel = null;
		}

		// 确保信令 WS 可用（rebuild 场景下 WS 可能已断开）
		await useSignalingConnection().ensureConnected({ verify: true });

		this.__remoteDescSet = false;
		this.__pendingCandidates = [];
		this.__candidateType = null;
		this.__transportInfo = null;
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

		// 创建并发送 offer
		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
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
		// ICE candidate → 通过信令 WS 发给 Plugin
		pc.onicecandidate = (event) => {
			if (!event.candidate) return;
			useSignalingConnection().sendSignaling(this.clawId, 'rtc:ice', event.candidate.toJSON());
		};

		// 连接状态变更
		pc.onconnectionstatechange = () => {
			if (this.__pc !== pc) return; // 防止旧 PC 回调
			const s = pc.connectionState;
			this.__log('info', `connectionState: ${s}`);

			if (s === 'connected') {
				this.__clearDisconnectedTimer();
				this.__setState('connected');
				this.__resolveCandidateType(pc);
			} else if (s === 'disconnected') {
				// 短暂网络抖动，等待 ICE 自动恢复；设超时兜底防止永远卡住
				this.__log('info', 'ICE disconnected, waiting for auto-recovery...');
				this.__startDisconnectedTimer();
			} else if (s === 'failed') {
				this.__clearDisconnectedTimer();
				this.__onIceFailed();
			} else if (s === 'closed') {
				this.__clearDisconnectedTimer();
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

	/** @private 启动 disconnected 状态超时定时器 */
	__startDisconnectedTimer() {
		this.__clearDisconnectedTimer();
		this.__disconnectedTimer = setTimeout(() => {
			this.__disconnectedTimer = null;
			if (this.__pc?.connectionState === 'disconnected') {
				this.__log('warn', `ICE disconnected timeout (${DISCONNECTED_TIMEOUT_MS}ms), escalating to recovery`);
				this.__onIceFailed();
			}
		}, DISCONNECTED_TIMEOUT_MS);
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
			this.__log('warn', 'DC keepalive probe failed, closing connection');
			this.close();
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
		this.__onAppBackground = () => this.__stopKeepalive();
		this.__onAppForeground = () => {
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

	// --- 内部：恢复 ---

	/** @private ICE failed → 上报 failed，由外层退避重试（每次获取 fresh TURN 凭证） */
	__onIceFailed() {
		this.__log('warn', 'ICE failed, delegating recovery to outer backoff');
		this.__setState('failed');
	}

	// --- 内部：信令 ---

	/** @private */
	__onSignaling(msg) {
		if (msg.type === 'rtc:answer') {
			this.__log('info', 'answer received, setting remote description');
			this.__pc?.setRemoteDescription({ type: 'answer', sdp: msg.payload.sdp })
				.then(() => {
					this.__remoteDescSet = true;
					// 排空 answer 到达前暂存的 ICE candidates
					const pending = this.__pendingCandidates.splice(0);
					for (const c of pending) {
						this.__pc?.addIceCandidate(c).catch(() => {});
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
