import { chunkAndSend, createReassembler } from './dc-chunking.js';
import { remoteLog } from '../remote-log.js';

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
	 */
	constructor({ onSend, onRequest, onFileRpc, onFileChannel, logger, PeerConnection }) {
		if (!PeerConnection) {
			throw new Error('PeerConnection constructor is required');
		}
		this.__onSend = onSend;
		this.__onRequest = onRequest;
		this.__onFileRpc = onFileRpc;
		this.__onFileChannel = onFileChannel;
		this.logger = logger ?? console;
		this.__PeerConnection = PeerConnection;
		/** @type {Map<string, { pc: object, rpcChannel: object|null, remoteMaxMessageSize: number, nextMsgId: number }>} */
		this.__sessions = new Map();
	}

	/** 处理来自 Server 转发的信令消息 */
	async handleSignaling(msg) {
		const connId = msg.fromConnId ?? msg.toConnId;
		if (msg.type === 'rtc:offer') {
			await this.__handleOffer(msg);
		} else if (msg.type === 'rtc:ice') {
			await this.__handleIce(msg);
		} else if (msg.type === 'rtc:ready' || msg.type === 'rtc:closed') {
			this.__logDebug(`${msg.type} from ${connId}`);
			if (msg.type === 'rtc:closed') {
				await this.closeByConnId(connId);
			}
		}
	}

	/** 关闭指定 connId 的 PeerConnection */
	async closeByConnId(connId) {
		const session = this.__sessions.get(connId);
		if (!session) return;
		this.__sessions.delete(connId);
		// 先 detach 事件，防止 pc.close() 异步触发 onconnectionstatechange 删除新 session
		session.pc.onconnectionstatechange = null;
		session.pc.onicecandidate = null;
		await session.pc.close();
		remoteLog(`rtc.closed conn=${connId}`);
		this.logger.info?.(`[coclaw/rtc] [${connId}] closed`);
	}

	/** 关闭所有 PeerConnection */
	async closeAll() {
		const closing = [...this.__sessions.keys()].map((id) => this.closeByConnId(id));
		await Promise.all(closing);
	}

	/** 向所有已打开的 rpcChannel 广播（大消息自动分片） */
	broadcast(payload) {
		const jsonStr = JSON.stringify(payload);
		for (const [connId, session] of this.__sessions) {
			const dc = session.rpcChannel;
			if (dc?.readyState === 'open') {
				try {
					chunkAndSend(dc, jsonStr, session.remoteMaxMessageSize, () => session.nextMsgId++, this.logger);
				} catch (err) {
					this.__logDebug(`[${connId}] broadcast send failed: ${err.message}`);
				}
			}
		}
	}

	async __handleOffer(msg) {
		const connId = msg.fromConnId;
		const isIceRestart = !!msg.payload?.iceRestart;

		// ICE restart：在现有 PC 上重新协商，保持 DTLS session
		if (isIceRestart) {
			const existing = this.__sessions.get(connId);
			if (existing) {
				remoteLog(`rtc.ice-restart conn=${connId}`);
				this.logger.info?.(`[coclaw/rtc] ICE restart offer from ${connId}, renegotiating`);
				try {
					await existing.pc.setRemoteDescription({ type: 'offer', sdp: msg.payload.sdp });
					const answer = await existing.pc.createAnswer();
					await existing.pc.setLocalDescription(answer);
					this.__onSend({
						type: 'rtc:answer',
						toConnId: connId,
						payload: { sdp: answer.sdp },
					});
					this.logger.info?.(`[coclaw/rtc] ICE restart answer sent to ${connId}`);
					return;
				} catch (err) {
					// ICE restart 协商失败 → 回退到 full rebuild
					remoteLog(`rtc.ice-restart-failed conn=${connId}`);
					this.logger.warn?.(`[coclaw/rtc] ICE restart failed for ${connId}, falling back to rebuild: ${err?.message}`);
					await this.closeByConnId(connId);
				}
			}
			// 无现有 session 或 ICE restart 失败 → 按 full rebuild 继续
		}

		remoteLog(`rtc.offer conn=${connId}`);
		this.logger.info?.(`[coclaw/rtc] offer received from ${connId}, creating answer`);

		// 同一 connId 重复 offer → 先关闭旧连接
		if (this.__sessions.has(connId)) {
			await this.closeByConnId(connId);
		}

		// 从 Server 注入的 turnCreds 构建 iceServers
		// werift 的 urls 必须是单个 string，每个 URL 独立一个对象
		const iceServers = [];
		if (msg.turnCreds) {
			const { urls, username, credential } = msg.turnCreds;
			for (const url of urls) {
				const server = { urls: url };
				if (url.startsWith('turn:') || url.startsWith('turns:')) {
					server.username = username;
					server.credential = credential;
				}
				iceServers.push(server);
			}
		}

		// 记录 ICE 服务器配置（脱敏，不含 credential）
		const stunUrl = iceServers.find((s) => s.urls?.startsWith('stun:'))?.urls ?? 'none';
		const turnUrl = iceServers.find((s) => s.urls?.startsWith('turn:'))?.urls ?? 'none';
		remoteLog(`rtc.ice-config conn=${connId} stun=${stunUrl} turn=${turnUrl}`);

		const pc = new this.__PeerConnection({ iceServers });

		// 从 SDP 解析对端 maxMessageSize（用于分片决策）
		const mmsMatch = msg.payload.sdp?.match(/a=max-message-size:(\d+)/);
		const remoteMaxMessageSize = mmsMatch ? parseInt(mmsMatch[1], 10) : 65536;

		const session = { pc, rpcChannel: null, remoteMaxMessageSize, nextMsgId: 1 };
		this.__sessions.set(connId, session);

		// ICE candidate → 发给 UI，并统计各类型 candidate 数量
		const candidateCounts = { host: 0, srflx: 0, relay: 0 };
		pc.onicecandidate = ({ candidate }) => {
			if (!candidate) {
				// gathering 完成，输出汇总
				remoteLog(`rtc.ice-gathered conn=${connId} host=${candidateCounts.host} srflx=${candidateCounts.srflx} relay=${candidateCounts.relay}`);
				return;
			}
			// 从 candidate 字符串中提取类型（typ host / typ srflx / typ relay）
			const typMatch = candidate.candidate?.match(/typ (\w+)/);
			if (typMatch && candidateCounts[typMatch[1]] !== undefined) {
				candidateCounts[typMatch[1]]++;
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

		// 连接状态变更（校验 pc 归属，防止旧 PC 异步回调删除新 session）
		pc.onconnectionstatechange = () => {
			const state = pc.connectionState;
			remoteLog(`rtc.state conn=${connId} ${state}`);
			this.logger.info?.(`[coclaw/rtc] [${connId}] connectionState: ${state}`);
			if (state === 'connected') {
				const nominated = pc.iceTransports?.[0]?.connection?.nominated;
				if (nominated) {
					const localC = nominated.localCandidate;
					const remoteC = nominated.remoteCandidate;
					const localInfo = `${localC?.type ?? '?'} ${localC?.host ?? '?'}:${localC?.port ?? '?'}`;
					const remoteInfo = `${remoteC?.type ?? '?'} ${remoteC?.host ?? '?'}:${remoteC?.port ?? '?'}`;
					remoteLog(`rtc.ice-nominated conn=${connId} local=${localInfo} remote=${remoteInfo}`);
					this.logger.info?.(`[coclaw/rtc] [${connId}] ICE nominated: local=${localInfo} remote=${remoteInfo}`);
				}
			} else if (state === 'failed' || state === 'closed') {
				const cur = this.__sessions.get(connId);
				if (cur && cur.pc === pc) {
					this.__sessions.delete(connId);
				}
			}
		};

		// 监听 UI 创建的 DataChannel
		pc.ondatachannel = ({ channel }) => {
			remoteLog(`dc.received conn=${connId} label=${channel.label}`);
			this.logger.info?.(`[coclaw/rtc] [${connId}] DataChannel "${channel.label}" received`);
			if (channel.label === 'rpc') {
				session.rpcChannel = channel;
				this.__setupDataChannel(connId, channel);
			} else if (channel.label.startsWith('file:')) {
				this.__onFileChannel?.(channel, connId);
			}
		};

		// offer → answer
		try {
			await pc.setRemoteDescription({ type: 'offer', sdp: msg.payload.sdp });
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);

			this.__onSend({
				type: 'rtc:answer',
				toConnId: connId,
				payload: { sdp: answer.sdp },
			});
			remoteLog(`rtc.answer conn=${connId}`);
			this.logger.info?.(`[coclaw/rtc] answer sent to ${connId}`);
		} catch (err) {
			// SDP 协商失败 → 清理已入 Map 的 session，避免泄漏
			const cur = this.__sessions.get(connId);
			if (cur && cur.pc === pc) {
				this.__sessions.delete(connId);
			}
			await pc.close().catch(() => {});
			throw err;
		}
	}

	async __handleIce(msg) {
		const connId = msg.fromConnId;
		const session = this.__sessions.get(connId);
		if (!session) {
			this.__logDebug(`ICE candidate from ${connId} but no session`);
			return;
		}
		await session.pc.addIceCandidate(msg.payload);
		this.__logDebug(`[${connId}] ICE candidate added`);
	}

	__setupDataChannel(connId, dc) {
		const reassembler = createReassembler((jsonStr) => {
			const payload = JSON.parse(jsonStr);
			// DC 探测：立即回复，不走 gateway
			if (payload.type === 'probe') {
				try { dc.send(JSON.stringify({ type: 'probe-ack' })); }
				catch { /* DC 已关闭，忽略 */ }
				return;
			}
			if (payload.type === 'req') {
				// coclaw.files.* 方法本地处理，不转发 gateway
				if (payload.method?.startsWith('coclaw.files.') && this.__onFileRpc) {
					const session = this.__sessions.get(connId);
					const sendFn = (response) => {
						try {
							chunkAndSend(
								dc, JSON.stringify(response),
								session?.remoteMaxMessageSize ?? 65536,
								() => session.nextMsgId++,
								this.logger,
							);
						} catch (err) {
							this.__logDebug(`[${connId}] sendFn failed: ${err.message}`);
						}
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
			remoteLog(`dc.open conn=${connId} label=${dc.label}`);
			this.logger.info?.(`[coclaw/rtc] [${connId}] DataChannel "${dc.label}" opened`);
		};
		dc.onclose = () => {
			remoteLog(`dc.closed conn=${connId} label=${dc.label}`);
			this.logger.info?.(`[coclaw/rtc] [${connId}] DataChannel "${dc.label}" closed`);
			reassembler.reset();
			const session = this.__sessions.get(connId);
			if (session && dc.label === 'rpc') session.rpcChannel = null;
		};
		dc.onerror = (err) => {
			remoteLog(`dc.error conn=${connId} label=${dc.label}`);
			/* c8 ignore next -- ?./?? fallback */
			this.logger.warn?.(`[coclaw/rtc] [${connId}] DataChannel "${dc.label}" error: ${String(err?.message ?? err)}`);
		};
		dc.onmessage = (event) => {
			try {
				reassembler.feed(event.data);
			} catch (err) {
				this.logger.warn?.(`[coclaw/rtc] [${connId}] DC message error: ${err.message}`);
			}
		};
	}

	__logDebug(message) {
		if (typeof this.logger?.debug === 'function') {
			this.logger.debug(`[coclaw/rtc] ${message}`);
		}
	}
}
