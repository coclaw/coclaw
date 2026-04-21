import { createReassembler } from './dc-chunking.js';
import { RpcSendQueue, DC_LOW_WATER_MARK } from './rpc-send-queue.js';
import { remoteLog } from '../remote-log.js';

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
		// 清理 plugin-probe 定时器（避免 session 已关闭仍触发 timeout 日志，
		// 或 500ms 调度窗口内 session 被替换时对着新 session 误发探针）
		if (session.__pluginProbeSchedTimer) {
			clearTimeout(session.__pluginProbeSchedTimer);
			session.__pluginProbeSchedTimer = null;
		}
		if (session.__pluginProbeTimer) {
			clearTimeout(session.__pluginProbeTimer);
			session.__pluginProbeTimer = null;
			session.__pluginProbeInFlight = null;
		}
		this.__sessions.delete(connId);
		// 显式关闭 rpc 发送队列：dc.onclose 路径中 `sessions.get(connId)` 已返回 undefined 而短路，
		// 此处不主动 close 会丢失 drop 汇总 remoteLog 诊断
		if (session.rpcSendQueue) {
			session.rpcSendQueue.close();
			session.rpcSendQueue = null;
			session.rpcChannel = null;
		}
		// 先 detach 事件，防止 pc.close() 异步触发 onconnectionstatechange 删除新 session
		session.pc.onconnectionstatechange = null;
		session.pc.onicecandidate = null;
		if ('onselectedcandidatepairchange' in session.pc) {
			session.pc.onselectedcandidatepairchange = null;
		}
		if ('oniceconnectionstatechange' in session.pc) {
			session.pc.oniceconnectionstatechange = null;
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

	/**
	 * 向指定 connId 的 rpc DC 单播一个 JSON 帧（不走 server 中转）。
	 * 若 session/DC 未就绪返回 false，由调用方决定是否重试。
	 * @param {string} connId
	 * @param {object} payload - 完整的 JSON 帧（通常是 { type: 'event', event, payload }）
	 * @returns {boolean} true=已入队发送，false=未能发送（session 不存在 / DC 未 open）
	 */
	sendTo(connId, payload) {
		const session = this.__sessions.get(connId);
		if (!session) return false;
		const q = session.rpcSendQueue;
		if (!q || session.rpcChannel?.readyState !== 'open') return false;
		try {
			q.send(JSON.stringify(payload));
			return true;
		} catch (err) {
			this.__logDebug(`[${connId}] sendTo failed: ${err.message}`);
			return false;
		}
	}

	async __handleOffer(msg) {
		const connId = msg.fromConnId;
		const isIceRestart = !!msg.payload?.iceRestart;
		const credRemain = this.__credRemainSec(msg.turnCreds);
		const credRemainStr = credRemain ?? 'none';

		// ICE restart：在现有 PC 上重新协商，保持 DTLS session
		if (isIceRestart) {
			const existing = this.__sessions.get(connId);
			if (existing) {
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
				if (existing.__failedTimer) {
					clearTimeout(existing.__failedTimer);
					existing.__failedTimer = null;
				}
				this.__remoteLog(`rtc.ice-restart conn=${connId} credRemain=${credRemainStr}`);
				this.logger.info?.(`${this.__rtcTag} ICE restart offer from ${connId}, renegotiating`);
				try {
					await existing.pc.setRemoteDescription({ type: 'offer', sdp: msg.payload.sdp });
					// 重协商 SDP 可能变更 a=max-message-size，同步刷新 queue 分片阈值；
					// queue 中已入队的 chunks 按旧值分片保留，新消息用新值
					const newMMS = this.__resolveMaxMessageSize(existing.pc, msg.payload.sdp);
					if (newMMS !== existing.remoteMaxMessageSize) {
						existing.remoteMaxMessageSize = newMMS;
						if (existing.rpcSendQueue) existing.rpcSendQueue.maxMessageSize = newMMS;
					}
					const answer = await existing.pc.createAnswer();
					await existing.pc.setLocalDescription(answer);
					this.__onSend({
						type: 'rtc:answer',
						toConnId: connId,
						payload: { sdp: answer.sdp },
					});
					this.__remoteLog(`rtc.restart-answer-sent conn=${connId}`);
					this.logger.info?.(`${this.__rtcTag} ICE restart answer sent to ${connId}`);
					return;
				} catch (err) {
					// ICE restart 协商失败 → reject，不 fall through
					this.__remoteLog(`rtc.ice-restart-failed conn=${connId} credRemain=${credRemainStr}`);
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
			this.__remoteLog(`rtc.ice-restart-no-session conn=${connId} credRemain=${credRemainStr}`);
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

		// settings 仅对 pion 生效：werift 路径不吃 settings 字段（大概率静默忽略，
		// 但按 __impl 分层更干净）。只收紧 pion 的 SCTP RTO 退避上限到 10s，
		// 让 APK 后台唤醒后的深度退避窗口能落在 UI 的 15s 超时内。
		const pcConfig = { iceServers };
		if (this.__impl === 'pion') {
			pcConfig.settings = { sctpRtoMax: 10000 };
		}
		const pc = new this.__PeerConnection(pcConfig);

		const remoteMaxMessageSize = this.__resolveMaxMessageSize(pc, msg.payload.sdp);

		const session = { pc, rpcChannel: null, rpcSendQueue: null, fileChannels: new Set(), remoteMaxMessageSize, nextMsgId: 1 };
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
				// ICE restart 或初次选中都会触发；让出一次 CPU 后再单播 transport 信息。
				// 签名去重保证 pair 不变时不会重复发送。
				queueMicrotask(() => this.__sendPeerTransport(connId));
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
			// 来自 UI 的 plugin-probe 回复：验证 plugin → UI 方向确实传达并被回传
			if (payload.type === 'plugin-probe-ack') {
				this.__handlePluginProbeAck(connId, payload.id);
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
			// rpc DC 建立后，把本端 transport 信息单播给 UI。
			// queueMicrotask 让出一次 CPU：确保 pion 侧 selectedCandidatePair setter 已 assign，
			// 同时避免在 onopen 同步栈里触发可能的重入。
			if (dc.label === 'rpc') {
				queueMicrotask(() => this.__sendPeerTransport(connId));
			}
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
		const q = session.rpcSendQueue;
		const queueInfo = q
			? `queueLen=${q.queue.length} queueBytes=${q.queueBytes} dropped=${q.droppedCount}`
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
	__sendPeerTransport(connId) {
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
		const ok = this.sendTo(connId, {
			type: 'event',
			event: 'coclaw.rtc.peerTransport',
			payload,
		});
		if (!ok) {
			// DC 尚未 open，回滚签名以便 dc.onopen 再次触发时重发
			session.__lastPeerTransportSig = null;
			return;
		}
		this.__remoteLog(`rtc.peer-transport conn=${connId} type=${payload.candidateType} proto=${payload.protocol} relay=${payload.relayProtocol ?? '-'}`);
	}

	/**
	 * 主动探针：在 rpc DC 上发一个 plugin-probe，期待 UI 回 plugin-probe-ack。
	 * 用于区分"pion 报告 connected 但 UI 其实没收到数据"与"UI 真的收到了但没记录事件"。
	 * 绕过 RpcSendQueue（与 probe-ack 对称），仅测量传输层，不受应用层积压影响。
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
