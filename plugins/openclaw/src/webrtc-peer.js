import { RTCPeerConnection as WeriftRTCPeerConnection } from 'werift';

/**
 * 管理多个 WebRTC PeerConnection（以 connId 为粒度）。
 * Plugin 作为被叫方：收到 UI 的 offer → 回复 answer。
 */
export class WebRtcPeer {
	/**
	 * @param {object} opts
	 * @param {function} opts.onSend - 将信令消息交给 RealtimeBridge 发送
	 * @param {function} [opts.onRequest] - DataChannel 收到 req 消息时的回调 (payload, connId) => void
	 * @param {function} [opts.onFileRpc] - rpc DC 上 coclaw.file.* 请求的回调 (payload, sendFn, connId) => void
	 * @param {function} [opts.onFileChannel] - file:<transferId> DataChannel 的回调 (dc, connId) => void
	 * @param {object} [opts.logger] - pino 风格 logger
	 * @param {function} [opts.PeerConnection] - 可替换的构造函数（测试用）
	 */
	constructor({ onSend, onRequest, onFileRpc, onFileChannel, logger, PeerConnection }) {
		this.__onSend = onSend;
		this.__onRequest = onRequest;
		this.__onFileRpc = onFileRpc;
		this.__onFileChannel = onFileChannel;
		this.logger = logger ?? console;
		this.__PeerConnection = PeerConnection ?? WeriftRTCPeerConnection;
		/** @type {Map<string, { pc: object, rpcChannel: object|null }>} */
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
		this.logger.info?.(`[coclaw/rtc] [${connId}] closed`);
	}

	/** 关闭所有 PeerConnection */
	async closeAll() {
		const closing = [...this.__sessions.keys()].map((id) => this.closeByConnId(id));
		await Promise.all(closing);
	}

	/** 向所有已打开的 rpcChannel 广播 */
	broadcast(payload) {
		const data = JSON.stringify(payload);
		for (const [connId, session] of this.__sessions) {
			const dc = session.rpcChannel;
			if (dc?.readyState === 'open') {
				try { dc.send(data); }
				catch (err) { this.__logDebug(`[${connId}] broadcast send failed: ${err.message}`); }
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
					this.logger.warn?.(`[coclaw/rtc] ICE restart failed for ${connId}, falling back to rebuild: ${err?.message}`);
					await this.closeByConnId(connId);
				}
			}
			// 无现有 session 或 ICE restart 失败 → 按 full rebuild 继续
		}

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
				if (url.startsWith('turn:')) {
					server.username = username;
					server.credential = credential;
				}
				iceServers.push(server);
			}
		}

		const pc = new this.__PeerConnection({ iceServers });
		const session = { pc, rpcChannel: null };
		this.__sessions.set(connId, session);

		// ICE candidate → 发给 UI
		pc.onicecandidate = ({ candidate }) => {
			if (!candidate) return;
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
			this.logger.info?.(`[coclaw/rtc] [${connId}] connectionState: ${state}`);
			if (state === 'connected') {
				const nominated = pc.iceTransports?.[0]?.connection?.nominated;
				if (nominated) {
					const type = nominated.localCandidate?.type ?? 'unknown';
					this.logger.info?.(`[coclaw/rtc] [${connId}] ICE connected via ${type}`);
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
		dc.onopen = () => {
			this.logger.info?.(`[coclaw/rtc] [${connId}] DataChannel "${dc.label}" opened`);
		};
		dc.onclose = () => {
			this.logger.info?.(`[coclaw/rtc] [${connId}] DataChannel "${dc.label}" closed`);
			const session = this.__sessions.get(connId);
			if (session && dc.label === 'rpc') session.rpcChannel = null;
		};
		dc.onmessage = (event) => {
			try {
				const raw = typeof event.data === 'string' ? event.data : event.data.toString();
				const payload = JSON.parse(raw);
				if (payload.type === 'req') {
					// coclaw.file.* 方法本地处理，不转发 gateway
					if (payload.method?.startsWith('coclaw.file.') && this.__onFileRpc) {
						const sendFn = (response) => {
							try { dc.send(JSON.stringify(response)); }
							catch { /* DC 可能已关闭 */ }
						};
						this.__onFileRpc(payload, sendFn, connId);
					} else {
						this.__onRequest?.(payload, connId);
					}
				} else {
					this.__logDebug(`[${connId}] unknown DC message type: ${payload.type}`);
				}
			} catch (err) {
				this.logger.warn?.(`[coclaw/rtc] [${connId}] DC message parse failed: ${err.message}`);
			}
		};
	}

	__logDebug(message) {
		if (typeof this.logger?.debug === 'function') {
			this.logger.debug(`[coclaw/rtc] ${message}`);
		}
	}
}
