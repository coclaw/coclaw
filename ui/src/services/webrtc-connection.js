/**
 * WebRTC DataChannel 连接管理（UI 侧）
 * Phase 2：业务 RPC 通信切换到 DataChannel，WS 作为兜底
 *
 * 连接恢复策略（§7.2）：
 * - disconnected → 等待 ICE 自动恢复（短暂网络抖动自愈）
 * - failed → ICE restart（iceRestart: true），不重建 PeerConnection
 * - ICE restart 也失败 → 关闭 PeerConnection，全新重建
 */
import { httpClient } from './http.js';
import { buildChunks, createReassembler } from '../utils/dc-chunking.js';

const MAX_ICE_RESTARTS = 2;
const MAX_FULL_REBUILDS = 3;

/** 发送流控：高水位（暂停发送），远低于浏览器 16MB 上限 */
const DC_HIGH_WATER_MARK = 1024 * 1024;
/** 发送流控：低水位（恢复发送），对应 bufferedAmountLowThreshold */
const DC_LOW_WATER_MARK = 256 * 1024;

/** @type {Map<string, WebRtcConnection>} botId → WebRtcConnection */
const rtcInstances = new Map();

/** 预加载 botsStore 引用，避免每次状态变更时 dynamic import */
let _botsStoreRef = null;
async function getBotsStore() {
	if (!_botsStoreRef) {
		const mod = await import('../stores/bots.store.js');
		_botsStoreRef = mod.useBotsStore;
	}
	return _botsStoreRef();
}

const RTC_TRANSPORT_TIMEOUT_MS = 15_000;

/**
 * 为指定 bot 初始化 RTC 并执行传输选择
 * WS 每次连通时调用；内含防重入守卫
 * 返回的 Promise 在传输模式确定后（'rtc' 或 'ws'）resolve
 * @param {string} botId
 * @param {import('./bot-connection.js').BotConnection} botConn
 * @returns {Promise<void>}
 */
export function initRtcAndSelectTransport(botId, botConn) {
	const existing = rtcInstances.get(botId);
	if (existing && existing.state !== 'closed' && existing.state !== 'failed') {
		return Promise.resolve();
	}
	if (existing) existing.close();

	const rtc = new WebRtcConnection(botId, botConn);
	rtcInstances.set(botId, rtc);

	/** 同步传输模式到 store */
	function syncTransportMode(mode) {
		botConn.setTransportMode(mode);
		getBotsStore().then((store) => {
			const bot = store.byId[botId];
			if (bot) bot.transportMode = mode;
		}).catch(() => {});
	}

	return new Promise((resolveTransport) => {
		let settled = false;
		function settle() {
			if (settled) return false;
			settled = true;
			resolveTransport();
			return true;
		}

		// 传输选择：15 秒内 DataChannel open → RTC，否则 → WS
		const fallbackTimer = setTimeout(() => {
			if (!settle()) return;
			console.warn('[rtc] RTC 建连超时，降级到 WS botId=%s', botId);
			rtc.close();
			rtcInstances.delete(botId);
			botConn.clearRtc();
			syncTransportMode('ws');
		}, RTC_TRANSPORT_TIMEOUT_MS);

		rtc.onReady = () => {
			if (!settle()) return;
			clearTimeout(fallbackTimer);
			botConn.setRtc(rtc);
			syncTransportMode('rtc');
		};

		// 状态变更 → 同步到 botsStore + 不可恢复时降级
		rtc.onStateChange = () => {
			getBotsStore().then((store) => {
				const bot = store.byId[botId];
				if (!bot) return;
				bot.rtcState = rtc.state;
				if (rtc.transportInfo) {
					bot.rtcTransportInfo = rtc.transportInfo;
				}
			}).catch(() => {});

			// state === 'failed' 仅在所有恢复尝试耗尽后才被设置
			if (rtc.state === 'failed') {
				botConn.clearRtc();
				syncTransportMode('ws');
			}
		};

		httpClient.get('/api/v1/turn/creds')
			.then((resp) => rtc.connect(resp.data))
			.catch((err) => {
				if (!settle()) return;
				clearTimeout(fallbackTimer);
				console.warn('[rtc] init failed, 降级到 WS botId=%s: %s', botId, err?.message);
				rtc.close();
				rtcInstances.delete(botId);
				botConn.clearRtc();
				syncTransportMode('ws');
			});
	});
}

/**
 * @deprecated 使用 initRtcAndSelectTransport 代替
 */
export const initRtcForBot = initRtcAndSelectTransport;

/** 关闭指定 bot 的 WebRTC 连接 */
export function closeRtcForBot(botId) {
	const rtc = rtcInstances.get(botId);
	if (rtc) {
		rtc.close();
		rtcInstances.delete(botId);
	}
}

/** 仅供测试：重置所有实例 */
export function __resetRtcInstances() {
	for (const rtc of rtcInstances.values()) rtc.close();
	rtcInstances.clear();
	_botsStoreRef = null;
}

/** 仅供测试：获取实例 */
export function __getRtcInstance(botId) {
	return rtcInstances.get(botId);
}

export class WebRtcConnection {
	/**
	 * @param {string} botId
	 * @param {import('./bot-connection.js').BotConnection} botConn - 关联的 WS 连接
	 * @param {object} [opts]
	 * @param {function} [opts.PeerConnection] - 可替换的 RTCPeerConnection 构造函数（测试用）
	 */
	constructor(botId, botConn, opts = {}) {
		this.botId = botId;
		this.__botConn = botConn;
		this.__PeerConnection = opts.PeerConnection ?? globalThis.RTCPeerConnection;
		this.__pc = null;
		this.__rpcChannel = null;
		this.__state = 'idle';
		this.__candidateType = null;
		/** @type {{ localType: string, localProtocol: string, remoteType: string, remoteProtocol: string, relayProtocol: string|null }|null} */
		this.__transportInfo = null;
		this.__onRtcMsg = null;
		this.__turnCreds = null;
		this.__iceRestartCount = 0;
		this.__rebuildCount = 0;
		/** @type {{ data: string, resolve: Function, reject: Function }[]} */
		this.__sendQueue = [];
		/** @type {object[]} answer 到达前暂存的远端 ICE candidates */
		this.__pendingCandidates = [];
		this.__remoteDescSet = false;
		/** 分片 msgId 自增计数器 */
		this.__nextMsgId = 1;
		/** @type {{ feed: Function, reset: Function }|null} */
		this.__reassembler = null;
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
		this.__turnCreds = turnCreds;
		this.__iceRestartCount = 0;
		this.__rebuildCount = 0;
		await this.__buildPeerConnection(turnCreds, false);
	}

	/** 关闭连接（主动关闭，不再自动恢复） */
	close() {
		this.__removeRtcListener();
		this.__rejectSendQueue('connection closed');
		if (this.__pc) {
			this.__botConn.sendRaw({ type: 'rtc:closed' });
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
					console.warn('[WebRTC] dc.send threw but DC still open, retrying with chunking:', err?.message);
					const chunks = buildChunks(data, Math.floor((this.__pc?.sctp?.maxMessageSize ?? 65536) / 2), () => this.__nextMsgId++);
					if (chunks) return this.__enqueueSendMulti(chunks);
				}
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
		return this.__pc.createDataChannel(label, opts);
	}

	/**
	 * 前台恢复时主动 ICE restart（仅在 PC 处于 disconnected 时触发）
	 * ICE restart 是安全的：旧连接保持可用直到新路径建立
	 * @returns {boolean} 是否触发了 restart
	 */
	tryIceRestart() {
		const pc = this.__pc;
		if (!pc || pc.connectionState !== 'disconnected') return false;
		this.__log('info', 'proactive ICE restart on foreground resume');
		this.__iceRestartCount++;
		this.__doIceRestart();
		return true;
	}

	// --- 内部：建连 ---

	/** @private */
	async __buildPeerConnection(turnCreds, isRebuild) {
		// 清理旧 PC（rebuild 场景）
		if (this.__pc) {
			this.__pc.onicecandidate = null;
			this.__pc.onconnectionstatechange = null;
			this.__pc.close();
			this.__pc = null;
			this.__rpcChannel = null;
		}

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
		this.__botConn.sendRaw({
			type: 'rtc:offer',
			payload: { sdp: offer.sdp },
		});
		this.__log('info', `offer sent for bot ${this.botId}${isRebuild ? ' (rebuild)' : ''}`);
	}

	/** @private */
	__buildIceServers(turnCreds) {
		const iceServers = [];
		if (turnCreds) {
			for (const url of turnCreds.urls) {
				const s = { urls: url };
				if (url.startsWith('turn:')) {
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
		// ICE candidate → 通过 WS 发给 Plugin
		pc.onicecandidate = (event) => {
			if (!event.candidate) return;
			this.__botConn.sendRaw({
				type: 'rtc:ice',
				payload: event.candidate.toJSON(),
			});
		};

		// 连接状态变更
		pc.onconnectionstatechange = () => {
			if (this.__pc !== pc) return; // 防止旧 PC 回调
			const s = pc.connectionState;
			this.__log('info', `connectionState: ${s}`);

			if (s === 'connected') {
				this.__iceRestartCount = 0; // 连接成功，重置 ICE restart 计数
				this.__setState('connected');
				this.__resolveCandidateType(pc);
			} else if (s === 'disconnected') {
				// 短暂网络抖动，等待 ICE 自动恢复，仅日志
				this.__log('info', 'ICE disconnected, waiting for auto-recovery...');
			} else if (s === 'failed') {
				this.__onIceFailed();
			} else if (s === 'closed') {
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
				this.__botConn.__onRtcMessage(payload);
			} catch (err) {
				console.warn('[rtc] DataChannel 消息解析失败:', err);
			}
		});

		dc.onopen = () => {
			this.__log('info', 'DataChannel "rpc" opened');
			this.__botConn.sendRaw({ type: 'rtc:ready' });
			this.onReady?.();
		};
		dc.onclose = () => {
			this.__log('info', 'DataChannel "rpc" closed');
			this.__reassembler?.reset();
			if (this.__rpcChannel === dc) {
				this.__rpcChannel = null;
				this.__rejectSendQueue('DataChannel closed');
			}
		};
		dc.onmessage = (event) => {
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
		for (const { reject } of queue) {
			reject(new Error(msg));
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

	/** @private ICE failed 时的恢复策略 */
	__onIceFailed() {
		if (this.__iceRestartCount < MAX_ICE_RESTARTS) {
			this.__iceRestartCount++;
			this.__log('info', `ICE failed, attempting ICE restart (${this.__iceRestartCount}/${MAX_ICE_RESTARTS})`);
			this.__doIceRestart();
		} else if (this.__rebuildCount < MAX_FULL_REBUILDS) {
			this.__rebuildCount++;
			this.__log('info', `ICE restart exhausted, full rebuild (${this.__rebuildCount}/${MAX_FULL_REBUILDS})`);
			this.__doFullRebuild();
		} else {
			this.__log('warn', 'all recovery attempts exhausted, giving up');
			this.__setState('failed');
		}
	}

	/** @private ICE restart：不重建 PeerConnection，仅重新协商路径 */
	async __doIceRestart() {
		const pc = this.__pc;
		if (!pc) return;
		try {
			const offer = await pc.createOffer({ iceRestart: true });
			await pc.setLocalDescription(offer);
			this.__botConn.sendRaw({
				type: 'rtc:offer',
				payload: { sdp: offer.sdp, iceRestart: true },
			});
			this.__log('info', 'ICE restart offer sent');
		}
		catch (err) {
			this.__log('warn', `ICE restart offer failed: ${err?.message}`);
			// ICE restart 失败，尝试 full rebuild
			if (this.__rebuildCount < MAX_FULL_REBUILDS) {
				this.__rebuildCount++;
				this.__doFullRebuild();
			} else {
				this.__setState('failed');
			}
		}
	}

	/** @private 全新重建 PeerConnection */
	async __doFullRebuild() {
		try {
			await this.__buildPeerConnection(this.__turnCreds, true);
		}
		catch (err) {
			this.__log('warn', `full rebuild failed: ${err?.message}`);
			this.__setState('failed');
		}
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
		this.__onRtcMsg = (msg) => this.__onSignaling(msg);
		this.__botConn.on('rtc', this.__onRtcMsg);
	}

	/** @private 移除 rtc 事件监听 */
	__removeRtcListener() {
		if (this.__onRtcMsg) {
			this.__botConn.off('rtc', this.__onRtcMsg);
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
	}
}
