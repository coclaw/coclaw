import { createReassembler } from './dc-chunking.js';
import { RpcSendQueue, DC_LOW_WATER_MARK } from './rpc-send-queue.js';
import { remoteLog } from '../remote-log.js';

// 单个 session 内 file DC 历史快照的容量上限（满后按 FIFO 淘汰最老条目）。
// 用于诊断 dump：过大会撑爆 remoteLog 单帧，20 足以覆盖典型多文件传输会话。
const FILE_CHANNEL_HISTORY_LIMIT = 20;

// Failed session 保留 24 小时，支持 Capacitor 长时间后台恢复后 ICE restart。
// 超时后 session 被回收释放 IPC listeners 和 Go 侧资源。
const FAILED_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Session 总数上限（活跃 + failed）。溢出时淘汰最旧的 failed session。
// 20 足以覆盖多 UI 实例（浏览器多标签 + 移动端）的典型场景。
const MAX_SESSIONS = 20;

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
	 */
	constructor({ onSend, onRequest, onFileRpc, onFileChannel, logger, PeerConnection, impl }) {
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
		this.__rtcTag = impl ? `[coclaw/rtc:${impl}]` : '[coclaw/rtc]';
		/** @type {Map<string, { pc: object, rpcChannel: object|null, rpcSendQueue: RpcSendQueue|null, fileChannels: Set, remoteMaxMessageSize: number, nextMsgId: number }>} */
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
		// 清理 failed TTL 定时器
		if (session.__failedTimer) {
			clearTimeout(session.__failedTimer);
			session.__failedTimer = null;
		}
		this.__sessions.delete(connId);
		// 先 detach 事件，防止 pc.close() 异步触发 onconnectionstatechange 删除新 session
		session.pc.onconnectionstatechange = null;
		session.pc.onicecandidate = null;
		if ('onselectedcandidatepairchange' in session.pc) {
			session.pc.onselectedcandidatepairchange = null;
		}
		await session.pc.close();
		this.__remoteLog(`rtc.closed conn=${connId}`);
		this.logger.info?.(`${this.__rtcTag} [${connId}] closed`);
	}

	/** 关闭所有 PeerConnection */
	async closeAll() {
		const closing = [...this.__sessions.keys()].map((id) => this.closeByConnId(id));
		await Promise.all(closing);
	}

	/** 向所有已打开的 rpcChannel 广播（大消息自动分片，经由 RpcSendQueue 流控） */
	broadcast(payload) {
		const jsonStr = JSON.stringify(payload);
		for (const [connId, session] of this.__sessions) {
			const q = session.rpcSendQueue;
			if (q && session.rpcChannel?.readyState === 'open') {
				try {
					q.send(jsonStr);
				} catch (err) {
					// buildChunks 抛（maxMessageSize 配置错）等罕见情况
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
				// 仅已验证支持 ICE restart 的 impl 放行，其余立即 reject 让 UI 走 rebuild
				if (this.__impl !== 'pion') {
					this.__remoteLog(`rtc.ice-restart-unsupported conn=${connId} impl=${this.__impl}`);
					this.logger.info?.(`${this.__rtcTag} ICE restart rejected: impl=${this.__impl} not verified`);
					this.__onSend({
						type: 'rtc:restart-rejected',
						toConnId: connId,
						payload: { reason: 'impl_unsupported' },
					});
					return; // TTL timer 保持不变（reject 是同步的，不影响 timer 正常工作）
				}
				// 暂停 failed TTL timer：pion restart 涉及异步协商，期间不应被回收
				if (existing.__failedTimer) {
					clearTimeout(existing.__failedTimer);
					existing.__failedTimer = null;
				}
				this.__remoteLog(`rtc.ice-restart conn=${connId}`);
				this.logger.info?.(`${this.__rtcTag} ICE restart offer from ${connId}, renegotiating`);
				try {
					await existing.pc.setRemoteDescription({ type: 'offer', sdp: msg.payload.sdp });
					const answer = await existing.pc.createAnswer();
					await existing.pc.setLocalDescription(answer);
					this.__onSend({
						type: 'rtc:answer',
						toConnId: connId,
						payload: { sdp: answer.sdp },
					});
					this.logger.info?.(`${this.__rtcTag} ICE restart answer sent to ${connId}`);
					return;
				} catch (err) {
					// ICE restart 协商失败 → reject，不 fall through
					this.__remoteLog(`rtc.ice-restart-failed conn=${connId}`);
					this.logger.warn?.(`${this.__rtcTag} ICE restart failed for ${connId}: ${err?.message}`);
					this.__onSend({
						type: 'rtc:restart-rejected',
						toConnId: connId,
						payload: { reason: 'restart_failed' },
					});
					await this.closeByConnId(connId).catch((closeErr) => {
						/* c8 ignore next -- closeByConnId 内部已 try/catch，此路径极难触发 */
						this.logger.warn?.(`${this.__rtcTag} closeByConnId failed after restart rejection for ${connId}: ${closeErr?.message}`);
					});
					return;
				}
			}
			// 无 session → reject（plugin 可能已重启）
			this.__remoteLog(`rtc.ice-restart-no-session conn=${connId}`);
			this.logger.warn?.(`${this.__rtcTag} ICE restart from ${connId} but no session, rejecting`);
			this.__onSend({
				type: 'rtc:restart-rejected',
				toConnId: connId,
				payload: { reason: 'no_session' },
			});
			return;
		}

		this.__remoteLog(`rtc.offer conn=${connId}`);
		this.logger.info?.(`${this.__rtcTag} offer received from ${connId}, creating answer`);

		// 同一 connId 重复 offer → 先关闭旧连接
		if (this.__sessions.has(connId)) {
			await this.closeByConnId(connId);
		}

		// session 总数限制：溢出时淘汰最旧的 failed session
		if (this.__sessions.size >= MAX_SESSIONS) {
			this.__evictOldestFailed();
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
		this.__remoteLog(`rtc.ice-config conn=${connId} stun=${stunUrl} turn=${turnUrl}`);

		const pc = new this.__PeerConnection({ iceServers });

		// 分片阈值 = min(远端能接收, 本地能发送)
		// 远端：从 offer SDP 的 a=max-message-size 解析（缺失则 RFC 8841 默认 65536）
		// 本地：pc.maxMessageSize（pion 为 65536，ndc/werift 无此属性则不限制）
		const mmsMatch = msg.payload.sdp?.match(/a=max-message-size:(\d+)/);
		const remoteMMS = mmsMatch ? parseInt(mmsMatch[1], 10) : 65536;
		const localMMS = pc.maxMessageSize ?? remoteMMS;
		const remoteMaxMessageSize = Math.min(remoteMMS, localMMS);

		const session = { pc, rpcChannel: null, rpcSendQueue: null, fileChannels: new Set(), remoteMaxMessageSize, nextMsgId: 1 };
		this.__sessions.set(connId, session);

		// ICE candidate → 发给 UI，并统计各类型 candidate 数量
		const candidateCounts = { host: 0, srflx: 0, relay: 0 };
		pc.onicecandidate = ({ candidate }) => {
			if (!candidate) {
				// gathering 完成，输出汇总
				this.__remoteLog(`rtc.ice-gathered conn=${connId} host=${candidateCounts.host} srflx=${candidateCounts.srflx} relay=${candidateCounts.relay}`);
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
			this.__remoteLog(`rtc.state conn=${connId} ${state}`);
			this.logger.info?.(`${this.__rtcTag} [${connId}] connectionState: ${state}`);

			// 校验 pc 归属：旧 PC 的异步回调可能在新 session 已建立后触发
			const cur = this.__sessions.get(connId);
			if (!cur || cur.pc !== pc) return;

			// 离开 failed 状态时清理 TTL timer（ICE restart 恢复、自然关闭等）
			if (state !== 'failed' && cur.__failedTimer) {
				clearTimeout(cur.__failedTimer);
				cur.__failedTimer = null;
			}

			if (state === 'connected') {
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
						this.closeByConnId(connId).catch(() => {});
					}, FAILED_SESSION_TTL_MS);
					cur.__failedTimer.unref?.();
				} else if (state === 'closed') {
					// 自然进入 closed 时也需通过 closeByConnId 释放 IPC listeners 和 Go 资源
					this.closeByConnId(connId).catch(() => {});
				}
			}
		};

		// pion: 选中的 candidate pair 通过独立事件上报
		if ('onselectedcandidatepairchange' in pc) {
			pc.onselectedcandidatepairchange = () => {
				const pair = pc.selectedCandidatePair;
				if (pair) {
					this.__logNominatedPair(connId, pair);
				}
			};
		}

		// 监听 UI 创建的 DataChannel
		pc.ondatachannel = ({ channel }) => {
			this.__remoteLog(`dc.received conn=${connId} label=${channel.label}`);
			this.logger.info?.(`${this.__rtcTag} [${connId}] DataChannel "${channel.label}" received`);
			if (channel.label === 'rpc') {
				session.rpcChannel = channel;
				this.__setupDataChannel(connId, channel);
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
			this.__remoteLog(`rtc.answer conn=${connId}`);
			this.logger.info?.(`${this.__rtcTag} answer sent to ${connId}`);
		} catch (err) {
			// SDP 协商失败 → 清理已入 Map 的 session，避免泄漏
			const cur = this.__sessions.get(connId);
			if (cur && cur.pc === pc) {
				if (cur.__failedTimer) {
					clearTimeout(cur.__failedTimer);
					cur.__failedTimer = null;
				}
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
		try {
			await session.pc.addIceCandidate(msg.payload);
			this.__logDebug(`[${connId}] ICE candidate added`);
		} catch (err) {
			this.__logDebug(`[${connId}] addIceCandidate failed: ${err?.message}`);
		}
	}

	__setupDataChannel(connId, dc) {
		// rpc DC 发送流控：每条 rpc DC 绑定一个 RpcSendQueue，广播与 files RPC 响应均经此出口
		const session = this.__sessions.get(connId);
		if (session && dc.label === 'rpc') {
			if ('bufferedAmountLowThreshold' in dc) {
				dc.bufferedAmountLowThreshold = DC_LOW_WATER_MARK;
			}
			session.rpcSendQueue = new RpcSendQueue({
				dc,
				maxMessageSize: session.remoteMaxMessageSize,
				getNextMsgId: () => session.nextMsgId++,
				logger: this.logger,
				tag: `conn=${connId}`,
			});
			dc.onbufferedamountlow = () => {
				session.rpcSendQueue?.onBufferedAmountLow();
			};
		}

		const reassembler = createReassembler((jsonStr) => {
			const payload = JSON.parse(jsonStr);
			// DC 探测：立即回复，不走 gateway
			// 故意绕过 RpcSendQueue：probe-ack 仅用于测量传输层（SCTP/DTLS）健康，
			// 走 queue 会把应用层积压压力错误地映射到"DC 不通"上。
			if (payload.type === 'probe') {
				try { dc.send(JSON.stringify({ type: 'probe-ack' })); }
				catch { /* DC 已关闭，忽略 */ }
				return;
			}
			if (payload.type === 'req') {
				// coclaw.files.* 方法本地处理，不转发 gateway
				if (payload.method?.startsWith('coclaw.files.') && this.__onFileRpc) {
					const sess = this.__sessions.get(connId);
					const sendFn = (response) => {
						try {
							sess?.rpcSendQueue?.send(JSON.stringify(response));
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
			this.__remoteLog(`dc.open conn=${connId} label=${dc.label}`);
			this.logger.info?.(`${this.__rtcTag} [${connId}] DataChannel "${dc.label}" opened`);
		};
		dc.onclose = () => {
			this.__remoteLog(`dc.closed conn=${connId} label=${dc.label}`);
			this.logger.info?.(`${this.__rtcTag} [${connId}] DataChannel "${dc.label}" closed`);
			reassembler.reset();
			const sess = this.__sessions.get(connId);
			if (sess && dc.label === 'rpc') {
				sess.rpcSendQueue?.close();
				sess.rpcSendQueue = null;
				sess.rpcChannel = null;
			}
		};
		dc.onerror = (err) => {
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
	}

	/**
	 * 失败/断连时输出 session 诊断快照：rpc/file DC readyState、session 总数。
	 * 用于定位"PC 假活但 DC 已死"或"PC 已断但 DC 仍在传"的异常现象。
	 */
	__dumpSessionState(connId, session, state) {
		const rpcState = session.rpcChannel?.readyState ?? 'none';
		const fileSummary = session.fileChannels.size === 0
			? 'none'
			/* c8 ignore next -- ?? fallback for missing readyState */
			: [...session.fileChannels].map((dc) => `${dc.label}=${dc.readyState ?? '?'}`).join(',');
		this.__remoteLog(`rtc.dump conn=${connId} state=${state} sessions=${this.__sessions.size} rpc=${rpcState} fileCount=${session.fileChannels.size} files=[${fileSummary}]`);
		this.logger.info?.(`${this.__rtcTag} [${connId}] dump state=${state} rpc=${rpcState} fileCount=${session.fileChannels.size} files=${fileSummary}`);
	}

	__logNominatedPair(connId, pair) {
		const localInfo = `${pair.local?.type ?? '?'} ${pair.local?.address ?? pair.local?.host ?? '?'}:${pair.local?.port ?? '?'}`;
		const remoteInfo = `${pair.remote?.type ?? '?'} ${pair.remote?.address ?? pair.remote?.host ?? '?'}:${pair.remote?.port ?? '?'}`;
		this.__remoteLog(`rtc.ice-nominated conn=${connId} local=${localInfo} remote=${remoteInfo}`);
		this.logger.info?.(`${this.__rtcTag} [${connId}] ICE nominated: local=${localInfo} remote=${remoteInfo}`);
	}

	__remoteLog(msg) {
		remoteLog(this.__impl ? `${msg} rtc=${this.__impl}` : msg);
	}

	/** 淘汰最旧的 failed session（Map 迭代序 ≈ 创建时间序），用于 queue length 限制 */
	__evictOldestFailed() {
		for (const [connId, session] of this.__sessions) {
			if (session.pc.connectionState === 'failed') {
				this.__remoteLog(`rtc.session-evicted conn=${connId} sessions=${this.__sessions.size}`);
				this.logger.info?.(`${this.__rtcTag} [${connId}] session evicted (limit ${MAX_SESSIONS}), closing`);
				this.closeByConnId(connId).catch(() => {});
				return true;
			}
		}
		this.logger.warn?.(`${this.__rtcTag} session limit (${MAX_SESSIONS}) reached, no failed sessions to evict`);
		return false;
	}

	__logDebug(message) {
		if (typeof this.logger?.debug === 'function') {
			this.logger.debug(`${this.__rtcTag} ${message}`);
		}
	}
}

export { FAILED_SESSION_TTL_MS, MAX_SESSIONS };
