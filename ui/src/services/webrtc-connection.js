/**
 * WebRTC DataChannel 连接管理（UI 侧）
 * Phase 1：仅建连验证，不承载业务数据
 *
 * 连接恢复策略（§7.2）：
 * - disconnected → 等待 ICE 自动恢复（短暂网络抖动自愈）
 * - failed → ICE restart（iceRestart: true），不重建 PeerConnection
 * - ICE restart 也失败 → 关闭 PeerConnection，全新重建
 */
import { httpClient } from './http.js';

const MAX_ICE_RESTARTS = 2;
const MAX_FULL_REBUILDS = 3;

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

/**
 * 为指定 bot 发起 WebRTC 连接
 * @param {string} botId
 * @param {import('./bot-connection.js').BotConnection} botConn
 */
export async function initRtcForBot(botId, botConn) {
	const existing = rtcInstances.get(botId);
	if (existing && existing.state !== 'closed' && existing.state !== 'failed') return;
	if (existing) existing.close();

	const rtc = new WebRtcConnection(botId, botConn);
	rtcInstances.set(botId, rtc);

	// 状态变更 → 同步到 botsStore
	rtc.onStateChange = () => {
		getBotsStore().then((store) => {
			store.rtcStates = { ...store.rtcStates, [botId]: rtc.state };
			if (rtc.candidateType) {
				store.rtcCandidateTypes = { ...store.rtcCandidateTypes, [botId]: rtc.candidateType };
			}
		}).catch(() => {});
	};

	try {
		const resp = await httpClient.get('/api/v1/turn/creds');
		await rtc.connect(resp.data);
	}
	catch (err) {
		console.warn('[WebRTC] init failed for bot %s: %s', botId, err?.message);
		rtc.close();
		rtcInstances.delete(botId);
	}
}

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
		this.__onRtcMsg = null;
		this.__turnCreds = null;
		this.__iceRestartCount = 0;
		this.__rebuildCount = 0;
		/** @type {function|null} 状态变更回调（供外部同步 store） */
		this.onStateChange = null;
	}

	/** @returns {'idle' | 'connecting' | 'connected' | 'failed' | 'closed'} */
	get state() { return this.__state; }
	get candidateType() { return this.__candidateType; }

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
		if (this.__pc) {
			this.__botConn.sendRaw({ type: 'rtc:closed' });
			this.__pc.close();
			this.__pc = null;
		}
		this.__rpcChannel = null;
		this.__setState('closed');
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
		dc.onopen = () => {
			this.__log('info', 'DataChannel "rpc" opened');
			this.__botConn.sendRaw({ type: 'rtc:ready' });
		};
		dc.onclose = () => {
			this.__log('info', 'DataChannel "rpc" closed');
			if (this.__rpcChannel === dc) this.__rpcChannel = null;
		};
		dc.onmessage = (event) => {
			// Phase 1：仅简要日志，丢弃
			this.__log('debug', `rpc msg (discarded): ${String(event.data).slice(0, 80)}`);
		};
	}

	/** @private 获取并记录实际 ICE candidate 类型 */
	__resolveCandidateType(pc) {
		pc.getStats().then((report) => {
			for (const stat of report.values()) {
				if (stat.type === 'candidate-pair' && stat.nominated) {
					for (const s2 of report.values()) {
						if (s2.type === 'local-candidate' && s2.id === stat.localCandidateId) {
							this.__candidateType = s2.candidateType;
							const label = s2.candidateType === 'relay' ? 'TURN' : 'P2P';
							this.__log('info', `ICE connected via ${s2.candidateType} (${label})`);
							// 通知外部更新 candidateType
							if (this.onStateChange) this.onStateChange(this.__state);
							return;
						}
					}
				}
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
				payload: { sdp: offer.sdp },
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
			this.__pc?.setRemoteDescription({ type: 'answer', sdp: msg.payload.sdp });
		} else if (msg.type === 'rtc:ice') {
			this.__pc?.addIceCandidate(msg.payload).catch(() => {});
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
