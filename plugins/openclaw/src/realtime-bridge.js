import nodePath from 'node:path';
import { WebSocket as WsWebSocket } from 'ws';

import { getClawConfig } from './claw-config.js';
import { pluginDir } from './claw-paths.js';
import { clearConfig, getBindingsPath, readConfig } from './config.js';
import { cleanupResiduals as defaultCleanupResiduals, measureDiskCap as defaultMeasureDiskCap } from './rpc-queue-startup.js';
import { getHostName, readSettings } from './settings.js';
import {
	loadOrCreateDeviceIdentity,
	signDevicePayload,
	publicKeyRawBase64Url,
	buildDeviceAuthPayloadV3,
} from './device-identity.js';
import { getRuntime } from './runtime.js';
import { setSender as setRemoteLogSender, remoteLog } from './remote-log.js';
import { getPluginVersion } from './plugin-version.js';
import { getPlatformInfoLine } from './platform-info.js';
import { RunEventRoutes, DEFAULT_TTL_MS as RUN_EVENT_DEFAULT_TTL_MS, DEFAULT_SCAN_MS as RUN_EVENT_DEFAULT_SCAN_MS } from './rpc-routing/run-event-routes.js';

const DEFAULT_GATEWAY_WS_URL = `ws://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT || '18789'}`;
const RECONNECT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const SERVER_HB_PING_MS = 25_000;
const SERVER_HB_TIMEOUT_MS = 45_000;
const SERVER_HB_MAX_MISS = 3; // 连续 3 次无响应才断连（~135s）。上游主线程 spike 实测最坏 ~89.5s（issue #75069），余量 ~1.5x
// gateway 握手失败的指数退避表：每个元素是"上一次失败"之后、"下一次尝试"之前的等待时间。
// 最多 5 次重试（加上首次尝试共 6 次），全部失败后进入 gave-up 终态，不再自动尝试。
const GATEWAY_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 20_000, 20_000];
// v3 握手失败时，只有错误消息匹配此正则才回退到不带 device 的 legacy 握手。
// 严格限定在"签名/设备/scope/协议"相关错误，避免对网络/内部错误做无意义的降级尝试。
const GATEWAY_HANDSHAKE_FALLBACK_PATTERN = /signature|device|scope|protocol/i;

// agent run 期间用的 event loop lag 探针参数：每 200ms 测一次主线程漂移，>100ms 视为 spike。
// 上限 60s 兜底，正常会在 phase-2 终态时主动停。用于持续观测 OpenClaw gateway 主线程被同步代码阻塞。
const LAG_PROBE_PERIOD_MS = 200;
const LAG_PROBE_THRESHOLD_MS = 100;
const LAG_PROBE_MAX_DURATION_MS = 60_000;

// UI 转发 RPC 路由表条目的最大存活时间（24h）。
// 选 24h 的理由：agent run 极端可达数小时甚至更久；正常 RPC 在终态触达前已自然清除；
// 24h 足够覆盖几乎所有真实场景，且条目内存压力可忽略（百量级 × 几十字节）。
const DC_REQ_TTL_MS = 24 * 60 * 60 * 1000;
// 整表周期扫描间隔（1h）。条目存留误差 0~1h，对内存压力毫无影响。
const DC_REQ_SCAN_MS = 60 * 60 * 1000;

/**
 * 判断一个出方向 res payload 是否表示 agent RPC 进入 phase-2 终态。
 * 终态 = res 帧 + status !== 'accepted'。OpenClaw 上游可能下发的终态 status：
 * - status='ok'：成功
 * - status='error'：执行失败
 * - status='timeout'：上游 agent.wait 等待 runId 终态超时（含 dedupe 命中的 timeout 快照）
 * - 参数校验失败：ok=false 且无 status（协议文档"特殊情况"）
 * 仅做兜底分类，不再追求枚举完备——上游若新增其他 non-accepted status，原样作为 reason 返回。
 *
 * @param {object} payload - 待判断的消息
 * @returns {string | null} 终态时返回 lag.summary 的 reason 字符串，否则 null
 */
export function classifyAgentLagStop(payload) {
	if (payload?.type !== 'res' || typeof payload?.id !== 'string') return null;
	const status = payload?.payload?.status;
	if (status === 'accepted') return null;
	return status ?? (payload.ok === false ? 'error' : 'ok');
}

/**
 * 判断一个 res 帧是否为终态（不会再有后续同 id 帧跟随）。
 * 与 OpenClaw 上游 gateway/client.ts 的 `expectFinal && status === "accepted"` 判据严格镜像：
 * 仅当 payload.status==='accepted' 时为中间态，其他一切（含无 status 字段）均为终态。
 * 见 docs/designs/dc-rpc-response-unicast.md §2.8。
 *
 * @param {object} frame - 待判断的 gateway res 帧
 * @returns {boolean}
 */
export function isFinalResMsg(frame) {
	return frame?.type === 'res' && frame?.payload?.status !== 'accepted';
}

function toServerWsUrl(baseUrl, token) {
	const url = new URL(baseUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = '/api/v1/claws/stream';
	url.searchParams.set('token', token);
	return url.toString();
}

// 脱敏 URL 中的 token 参数，用于日志输出
function maskUrlToken(url) {
	return url.replace(/([?&]token=)[^&]+/, '$1***');
}

// 仅在未注入 resolveGatewayAuthToken 时使用，依赖 runtime / 环境变量
export function defaultResolveGatewayAuthToken() {
	const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
	if (envToken) {
		return envToken;
	}
	try {
		const cfg = getClawConfig();
		const token = cfg?.gateway?.auth?.token;
		return typeof token === 'string' && token.trim() ? token.trim() : '';
	}
	catch (err) {
		console.warn?.(`[coclaw] resolve gateway auth token failed: ${String(err?.message ?? err)}`);
		return '';
	}
}

/**
 * WebSocket 桥接器：CoClaw server ↔ OpenClaw gateway
 *
 * 所有连接状态封装在实例内部，便于生命周期管理和测试。
 */
export class RealtimeBridge {
	/**
	 * @param {object} [deps] - 可注入依赖（测试用）
	 * @param {Function} [deps.WebSocket] - WebSocket 构造函数
	 * @param {Function} [deps.readConfig] - 读取绑定配置
	 * @param {Function} [deps.clearConfig] - 清除绑定配置
	 * @param {Function} [deps.getBindingsPath] - 获取绑定文件路径
	 * @param {Function} [deps.resolveGatewayAuthToken] - 获取 gateway 认证 token
	 * @param {Function} [deps.loadDeviceIdentity] - 加载设备身份
	 * @param {number} [deps.gatewayReadyTimeoutMs] - __waitGatewayReady 默认超时（测试可注入短值）
	 * @param {number} [deps.dcReqTtlMs] - UI 转发 RPC 路由表条目 TTL（测试可注入短值）
	 * @param {number} [deps.dcReqScanMs] - UI 转发 RPC 路由表周期扫描间隔（测试可注入短值）
	 * @param {number} [deps.runEventRoutesTtlMs] - runId → connId 路由表条目 TTL（测试可注入短值）
	 * @param {number} [deps.runEventRoutesScanMs] - runId → connId 路由表周期扫描间隔（测试可注入短值）
	 */
	constructor(deps = {}) {
		this.__readConfig = deps.readConfig ?? readConfig;
		this.__clearConfig = deps.clearConfig ?? clearConfig;
		this.__getBindingsPath = deps.getBindingsPath ?? getBindingsPath;
		this.__resolveGatewayAuthToken = deps.resolveGatewayAuthToken ?? defaultResolveGatewayAuthToken;
		this.__loadDeviceIdentity = deps.loadDeviceIdentity ?? loadOrCreateDeviceIdentity;
		this.__preloadPion = deps.preloadPion ?? null;
		this.__preloadNdc = deps.preloadNdc ?? null;
		this.__WebSocket = deps.WebSocket; // undefined=使用 ws 包, null=禁用（测试用）, 其他=自定义实现
		this.__gatewayReadyTimeoutMs = deps.gatewayReadyTimeoutMs ?? 1500;
		this.__dcReqTtlMs = deps.dcReqTtlMs ?? DC_REQ_TTL_MS;
		this.__dcReqScanMs = deps.dcReqScanMs ?? DC_REQ_SCAN_MS;
		this.__runEventRoutesTtlMs = deps.runEventRoutesTtlMs ?? RUN_EVENT_DEFAULT_TTL_MS;
		this.__runEventRoutesScanMs = deps.runEventRoutesScanMs ?? RUN_EVENT_DEFAULT_SCAN_MS;
		// rpc-queues/ 启动期预热钩子（B-stage1 plan-2）。仅供测试覆盖错误分支注入；生产路径走默认。
		this.__cleanupRpcQueueResiduals = deps.cleanupRpcQueueResiduals ?? defaultCleanupResiduals;
		this.__measureRpcQueueDiskCap = deps.measureRpcQueueDiskCap ?? defaultMeasureDiskCap;

		this.serverWs = null;
		this.gatewayWs = null;
		this.reconnectTimer = null;
		this.connectTimer = null;
		this.started = false;
		this.gatewayReady = false;
		this.gatewayConnectReqId = null;
		this.gatewayRpcSeq = 0;
		this.gatewayPendingRequests = new Map();
		this.logger = console;
		this.pluginConfig = {};
		this.intentionallyClosed = false;
		this.serverHbInterval = null;
		this.serverHbTimer = null;
		this.__serverHbMissCount = 0;
		this.__deviceIdentity = null;
		this.webrtcPeer = null;
		this.__webrtcPeerReady = null;
		this.__fileHandler = null;
		this.__ndcPreloadResult = null;
		this.__ndcCleanup = null;
		// gateway 握手重试状态（刷屏治理 + 兼容性回退）
		this.__gatewayAttempts = 0;          // 已失败的连续握手次数（握手成功时归零）
		this.__gatewayRetryTimer = null;     // 下一次尝试的 setTimeout 句柄
		this.__gatewayGaveUp = false;        // 重试次数耗尽 → 终态，不再自动尝试
		this.__gatewayLegacyMode = false;    // 学到"本 gateway 不接受带 device 的 v3"
		this.__gatewayLastReason = null;     // 最近一次失败原因（用于 gave-up 上报）
		// agent RPC 进 in-flight 时建探针、phase-2 终态时移除：id -> { interval, timeout, stats }
		this.__agentLagProbes = new Map();
		// UI 转发 RPC 路由表：reqId -> { connId, expireAt }
		// 用于 res 帧按发起方单播；查不到时回退广播兜底（兼容旧 UI / 撞号 / 上游新增中间态字符串等）
		this.__dcPendingRequests = new Map();
		this.__dcPendingScanTimer = null;
		// runId → connId 路由表：用于 event:agent 帧按发起方单播。
		// 实例延迟到 start() 真 logger 到位时再 new；stop() destroy 后置 null。
		this.__runEventRoutes = null;
		// rpc DC 文件回退队列的磁盘容量（B-stage1 plan-2 探测，B9b 在装配 FBQ 时取）
		this.__diskCap = null;
		// rpc DC 文件回退队列根目录（B-stage1 plan-2 已 cleanupResiduals 过；B9b 装配 FBQ 时取）。
		// prep 失败时 null → webrtc-peer 装配点自动降级到 MemoryQueue
		this.__queueDir = null;
	}

	__resolveWebSocket() {
		return this.__WebSocket === undefined ? WsWebSocket : this.__WebSocket;
	}

	__logDebug(message) {
		if (typeof this.logger?.debug === 'function') {
			this.logger.debug(`[coclaw] ${message}`);
		}
	}

	__startServerHeartbeat(sock) {
		this.__clearServerHeartbeat();
		this.__serverHbMissCount = 0;
		this.serverHbInterval = setInterval(() => {
			if (sock.readyState === 1) {
				try { sock.send(JSON.stringify({ type: 'ping' })); } catch {}
			}
		}, SERVER_HB_PING_MS);
		this.serverHbInterval.unref?.();
		this.__resetServerHbTimeout(sock);
	}

	__resetServerHbTimeout(sock) {
		this.__serverHbMissCount = 0;
		if (this.serverHbTimer) clearTimeout(this.serverHbTimer);
		this.serverHbTimer = setTimeout(() => {
			this.__onServerHbMiss(sock);
		}, SERVER_HB_TIMEOUT_MS);
		this.serverHbTimer.unref?.();
	}

	__onServerHbMiss(sock) {
		this.__serverHbMissCount++;
		if (this.__serverHbMissCount < SERVER_HB_MAX_MISS) {
			this.__logDebug(
				`server heartbeat miss ${this.__serverHbMissCount}/${SERVER_HB_MAX_MISS}, will retry`
			);
			// 补发 ping，继续等下一轮
			if (sock.readyState === 1) {
				try { sock.send(JSON.stringify({ type: 'ping' })); } catch {}
			}
			this.serverHbTimer = setTimeout(() => {
				this.__onServerHbMiss(sock);
			}, SERVER_HB_TIMEOUT_MS);
			this.serverHbTimer.unref?.();
			return;
		}
		remoteLog(`ws.hb-timeout peer=server misses=${this.__serverHbMissCount}`);
		this.logger.warn?.(
			`[coclaw] server ws heartbeat timeout after ${this.__serverHbMissCount} consecutive misses (~${this.__serverHbMissCount * SERVER_HB_TIMEOUT_MS / 1000}s), closing`
		);
		try { sock.close(4000, 'heartbeat_timeout'); } catch {}
	}

	__clearServerHeartbeat() {
		if (this.serverHbInterval) { clearInterval(this.serverHbInterval); this.serverHbInterval = null; }
		if (this.serverHbTimer) { clearTimeout(this.serverHbTimer); this.serverHbTimer = null; }
	}

	__resolveGatewayWsUrl() {
		return process.env.COCLAW_GATEWAY_WS_URL ?? DEFAULT_GATEWAY_WS_URL;
	}

	async __clearTokenLocal(unboundClawId) {
		const cfg = await this.__readConfig();
		if (!cfg?.token) {
			return;
		}
		// 只清除匹配的 claw，避免新绑定被误清
		if (unboundClawId && cfg.clawId && cfg.clawId !== unboundClawId) {
			return;
		}
		await this.__clearConfig();
	}

	__closeGatewayWs() {
		// 仅由显式销毁路径（stop / refresh）调用：职责单一——关闭当前 gateway WS 实例 +
		// 结算未完成的 gateway RPC。retry timer / attempts 由 stop() 复位；lag probes 由 stop()
		// 显式 __clearAllLagProbes 兜底（ws close 事件异步触发，期间 gatewayWs 已被这里置 null，
		// 走 stale guard 早返不再清理）；P2P 路由表（__dcPendingRequests / __runEventRoutes）
		// 已不再随内线翻转清理，stop() 会显式 clear / destroy。
		if (!this.gatewayWs) {
			return;
		}
		try {
			this.gatewayWs.__closedByPlugin = true;
			this.gatewayWs.close(1000, 'local-close');
		}
		/* c8 ignore next */
		catch {}
		this.gatewayWs = null;
		this.gatewayReady = false;
		this.gatewayConnectReqId = null;
		/* c8 ignore next 3 -- 仅在有未完成 RPC 请求时 gateway 关闭时触发 */
		for (const [, settle] of this.gatewayPendingRequests) {
			settle({ ok: false, error: 'gateway_closed' });
		}
		this.gatewayPendingRequests.clear();
	}

	/** 懒加载 WebRtcPeer（promise 锁防并发重复创建） */
	/* c8 ignore start -- 仅通过 WebRTC 路径触发，集成测试覆盖 */
	async __initWebrtcPeer() {
		const PeerConnection = this.__ndcPreloadResult?.PeerConnection;
		if (!PeerConnection) {
			remoteLog('rtc.unavailable reason=no-webrtc-impl');
			throw new Error('No WebRTC implementation available');
		}

		const { WebRtcPeer } = await import('./webrtc/webrtc-peer.js');
		const { createFileHandler } = await import('./file-manager/handler.js');
		this.__fileHandler = createFileHandler({
			resolveWorkspace: (agentId) => this.__resolveWorkspace(agentId),
			logger: this.logger,
		});
		this.__fileHandler.scheduleTmpCleanup(() => this.__listAgentWorkspaces());
		this.webrtcPeer = new WebRtcPeer({
			onSend: (msg) => this.__forwardToServer(msg),
			onRequest: (dcPayload, connId) => {
				this.__handleGatewayRequestFromDc(dcPayload, connId)
					.catch((err) => this.logger.warn?.(`[coclaw] dc request handler error: ${err?.message}`));
			},
			onFileRpc: (payload, sendFn) => {
				this.__fileHandler.handleRpcRequest(payload, sendFn)
					.catch((err) => this.logger.warn?.(`[coclaw/file] rpc error: ${err.message}`));
			},
			onFileChannel: (dc, connId) => {
				this.__fileHandler.handleFileChannel(dc, connId);
			},
			PeerConnection,
			impl: this.__ndcPreloadResult?.impl,
			logger: this.logger,
			// B9b：webrtc-peer 装配 FBQ 时取 disk 容量 + 队列根目录；
			// __queueDir 为 null 时（plan-2 prep 失败）自动降级到 MemoryQueue
			getDiskCap: () => this.__diskCap,
			queueDir: this.__queueDir,
		});
	}
	/* c8 ignore stop */

	__forwardToServer(payload) {
		if (!this.serverWs || this.serverWs.readyState !== 1) {
			// WS 断窗口期 onSend 调用：webrtcPeer 异步回调（trickle ICE candidate、SDP 应答等）
			// 本身没有 queue/rollback 机制，丢失对 plugin 端 PC 状态机不致命——UI 端 sig.state
			// 恢复后会主动触发新一轮 ICE restart，重发完整 candidate set 与 SDP。仅记本地 log
			// 便于事后排查；TODO 跟进完整方案（queue / rollback connId）。
			this.logger.warn?.(`[coclaw] forward dropped: ws not ready (type=${payload?.type ?? 'unknown'})`);
			return;
		}
		try {
			this.serverWs.send(JSON.stringify(payload));
		}
		catch (e) {
			this.logger.warn?.(`[coclaw] forward send failed (type=${payload?.type ?? 'unknown'}): ${e?.message ?? e}`);
		}
	}

	__nextGatewayReqId(prefix = 'coclaw-rpc') {
		this.gatewayRpcSeq += 1;
		return `${prefix}-${Date.now()}-${this.gatewayRpcSeq}`;
	}

	async __gatewayRpc(method, params = {}, options = {}) {
		const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;
		const ready = await this.__waitGatewayReady(timeoutMs);
		/* c8 ignore next 3 -- waitGatewayReady 返回 false 后的防御检查 */
		if (!ready || !this.gatewayWs || this.gatewayWs.readyState !== 1 || !this.gatewayReady) {
			return { ok: false, error: 'gateway_not_ready' };
		}
		const ws = this.gatewayWs;
		const id = this.__nextGatewayReqId('coclaw-gw');
		return await new Promise((resolve) => {
			let finished = false;
			const settle = (result) => {
				/* c8 ignore next 3 -- 防御并发 settle */
				if (finished) {
					return;
				}
				finished = true;
				clearTimeout(timer);
				this.gatewayPendingRequests.delete(id);
				resolve(result);
			};
			this.gatewayPendingRequests.set(id, settle);
			const timer = setTimeout(() => settle({ ok: false, error: 'timeout' }), timeoutMs);
			timer.unref?.();
			try {
				ws.send(JSON.stringify({
					type: 'req',
					id,
					method,
					params,
				}));
			}
			/* c8 ignore next 3 -- ws.send 极少抛出 */
			catch {
				settle({ ok: false, error: 'send_failed' });
			}
		});
	}

	/**
	 * 两阶段 agent RPC：发送请求后等待 accepted 再等待最终响应。
	 * agent() RPC 返回两次响应（同一 id）：
	 *   1. { status: "accepted", runId }
	 *   2. 终态帧，status 取值见 classifyAgentLagStop 注释（ok/error/timeout/参数校验失败）；
	 *      其中 status='ok' 时附带 result.payloads，其余分支可能没有 result。
	 *
	 * @param {string} method - RPC 方法名（通常为 'agent'）
	 * @param {object} params - RPC 参数
	 * @param {object} [options]
	 * @param {number} [options.timeoutMs=60000] - 总超时（含两阶段）
	 * @param {number} [options.acceptTimeoutMs=10000] - 等待 accepted 的超时
	 * @returns {Promise<{ok: boolean, response?: object, error?: string}>}
	 */
	async __gatewayAgentRpc(method, params = {}, options = {}) {
		const totalTimeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 60_000;
		const acceptTimeoutMs = Number.isFinite(options.acceptTimeoutMs) ? options.acceptTimeoutMs : 10_000;
		const ready = await this.__waitGatewayReady(acceptTimeoutMs);
		/* c8 ignore next 3 -- waitGatewayReady 返回 false 后的防御检查 */
		if (!ready || !this.gatewayWs || this.gatewayWs.readyState !== 1 || !this.gatewayReady) {
			return { ok: false, error: 'gateway_not_ready' };
		}
		const ws = this.gatewayWs;
		const id = this.__nextGatewayReqId('coclaw-agent');
		return await new Promise((resolve) => {
			let settled = false;
			let accepted = false;
			let totalTimer = null;
			let acceptTimer = null;
			const finish = (result) => {
				if (settled) return;
				settled = true;
				if (totalTimer) clearTimeout(totalTimer);
				if (acceptTimer) clearTimeout(acceptTimer);
				this.gatewayPendingRequests.delete(id);
				resolve(result);
			};
			// 两阶段 settle：第一次 accepted 不 resolve，第二次才 resolve
			const settle = (result) => {
				if (settled) return;
				// 错误响应：直接结束
				if (!result.ok) {
					finish(result);
					return;
				}
				const status = result.response?.payload?.status;
				if (!accepted && status === 'accepted') {
					// 第一阶段：已接受，切换到总超时
					accepted = true;
					if (acceptTimer) clearTimeout(acceptTimer);
					return;
				}
				// 第二阶段或非 accepted 响应：最终结果
				finish(result);
			};
			this.gatewayPendingRequests.set(id, settle);
			// 总超时
			totalTimer = setTimeout(() => finish({ ok: false, error: 'timeout' }), totalTimeoutMs);
			totalTimer.unref?.();
			// accepted 超时（仅等第一阶段）
			acceptTimer = setTimeout(() => {
				if (!accepted) finish({ ok: false, error: 'accept_timeout' });
			}, acceptTimeoutMs);
			acceptTimer.unref?.();
			try {
				ws.send(JSON.stringify({ type: 'req', id, method, params }));
			}
			/* c8 ignore next 3 -- ws.send 极少抛出 */
			catch {
				finish({ ok: false, error: 'send_failed' });
			}
		});
	}

	/**
	 * 确保指定 agent 的主 session 存在（sessions.resolve + 条件 sessions.reset）
	 * @param {string} [agentId] - agent ID，默认 'main'
	 * @returns {Promise<{ok: boolean, state?: string, error?: string}>}
	 */
	async ensureAgentSession(agentId) {
		const aid = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : 'main';
		const key = `agent:${aid}:main`;
		const resolved = await this.__gatewayRpc('sessions.resolve', { key }, { timeoutMs: 2000 });
		if (resolved?.ok === true) {
			this.__logDebug(`ensure agent session: ready agentId=${aid}`);
			return { ok: true, state: 'ready' };
		}
		// 仅当网关真实响应 "不存在" 时才创建；超时/网关未就绪等瞬态错误不触发 reset
		if (!resolved?.response) {
			return { ok: false, error: resolved?.error ?? 'resolve_transient_failure' };
		}
		// session key 不存在，通过 sessions.reset 创建
		const reset = await this.__gatewayRpc('sessions.reset', { key, reason: 'new' }, { timeoutMs: 2500 });
		if (reset?.ok !== true) {
			return { ok: false, error: reset?.error ?? 'sessions_reset_failed' };
		}
		this.__logDebug(`ensure agent session: created agentId=${aid}`);
		return { ok: true, state: 'created' };
	}

	async __ensureAllAgentSessions() {
		try {
			const listResult = await this.__gatewayRpc('agents.list', {}, { timeoutMs: 3000 });
			let agentIds = ['main'];
			if (listResult?.ok === true && Array.isArray(listResult?.response?.payload?.agents)) {
				const ids = listResult.response.payload.agents
					.map((a) => a?.id)
					.filter((id) => typeof id === 'string' && id.trim());
				if (ids.length > 0) agentIds = ids;
			}
			else {
				this.logger.warn?.(`[coclaw] agents.list failed, falling back to main: ${listResult?.error ?? 'unknown'}`);
			}
			const results = await Promise.allSettled(
				agentIds.map((id) => this.ensureAgentSession(id)),
			);
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				if (r.status === 'fulfilled' && r.value?.ok) continue;
				const err = r.status === 'fulfilled' ? r.value?.error : String(r.reason);
				this.logger.warn?.(`[coclaw] ensure agent session failed: agentId=${agentIds[i]} error=${err ?? 'unknown'}`);
			}
		}
		/* c8 ignore next 3 -- 防御性兜底，__gatewayRpc 内部已有完整错误处理 */
		catch (err) {
			this.logger.warn?.(`[coclaw] ensureAllAgentSessions unexpected error: ${String(err?.message ?? err)}`);
		}
	}

	/** 推送实例信息（name/hostName/pluginVersion/agentModels）到 server 和已连接的 UI */
	async __pushInstanceInfo() {
		try {
			const settings = await readSettings();
			const name = settings.name ?? null;
			const hostName = getHostName();
			const pluginVersion = await getPluginVersion();
			const agentModels = await this.__collectAgentModels();
			broadcastPluginEvent('coclaw.info.updated', {
				name,
				hostName,
				pluginVersion,
				agentModels,
			});
		}
		catch (err) {
			/* c8 ignore next 2 -- 防御性兜底 */
			this.logger.warn?.(`[coclaw] pushInstanceInfo failed: ${String(err?.message ?? err)}`);
		}
	}

	/**
	 * 采集 agent × 有效主模型列表，用于 coclaw.info.updated 上报
	 * @returns {Promise<Array<{id: string, name: string, model: string|null}>|null>} 采集失败返回 null
	 */
	async __collectAgentModels() {
		try {
			const result = await this.__gatewayRpc('agents.list', {}, { timeoutMs: 3000 });
			if (result?.ok !== true) return null;
			const agents = result?.response?.payload?.agents;
			if (!Array.isArray(agents)) return null;
			return agents.map((a) => ({
				id: a?.id,
				name: a?.name ?? a?.id,
				model: a?.model?.primary ?? null,
			}));
		}
		catch {
			// 防御性兜底：__gatewayRpc 正常会以 { ok:false } 返回，此分支覆盖调用栈意外抛错
			return null;
		}
	}

	/* c8 ignore start -- 仅通过 WebRTC 路径调用，依赖 gateway 连接，集成测试覆盖 */
	/**
	 * 通过 gateway RPC 获取指定 agent 的 workspace 绝对路径
	 * @param {string} agentId
	 * @returns {Promise<string>}
	 */
	async __resolveWorkspace(agentId) {
		const result = await this.__gatewayRpc('agents.files.list', { agentId }, { timeoutMs: 5000 });
		if (!result?.ok) {
			const err = new Error(result?.error ?? 'Failed to resolve workspace');
			err.code = 'AGENT_DENIED';
			throw err;
		}
		const workspace = result?.response?.payload?.workspace;
		if (!workspace) {
			const err = new Error(`No workspace for agent: ${agentId}`);
			err.code = 'AGENT_DENIED';
			throw err;
		}
		return workspace;
	}

	/**
	 * 列出所有 agent 的 workspace 路径（供临时文件清理使用）
	 * @returns {Promise<string[]>}
	 */
	async __listAgentWorkspaces() {
		const listResult = await this.__gatewayRpc('agents.list', {}, { timeoutMs: 3000 });
		let agentIds = ['main'];
		if (listResult?.ok === true && Array.isArray(listResult?.response?.payload?.agents)) {
			const ids = listResult.response.payload.agents
				.map((a) => a?.id)
				.filter((id) => typeof id === 'string' && id.trim());
			if (ids.length > 0) agentIds = ids;
		}
		const workspaces = [];
		for (const id of agentIds) {
			try {
				const ws = await this.__resolveWorkspace(id);
				workspaces.push(ws);
			} catch (err) {
				this.__logDebug(`workspace resolve failed for agent=${id}: ${err?.message}`);
			}
		}
		return workspaces;
	}

	/* c8 ignore stop */

	__ensureDeviceIdentity() {
		if (!this.__deviceIdentity) {
			this.__deviceIdentity = this.__loadDeviceIdentity();
		}
		return this.__deviceIdentity;
	}

	__buildDeviceField(nonce, authToken) {
		const identity = this.__ensureDeviceIdentity();
		const clientId = 'gateway-client';
		const clientMode = 'backend';
		const role = 'operator';
		const scopes = ['operator.admin'];
		const signedAtMs = Date.now();
		const payload = buildDeviceAuthPayloadV3({
			deviceId: identity.deviceId,
			clientId,
			clientMode,
			role,
			scopes,
			signedAtMs,
			token: authToken ?? '',
			nonce: nonce ?? '',
			platform: process.platform,
			deviceFamily: '',
		});
		const signature = signDevicePayload(identity.privateKeyPem, payload);
		return {
			id: identity.deviceId,
			publicKey: publicKeyRawBase64Url(identity.publicKeyPem),
			signature,
			signedAt: signedAtMs,
			nonce: nonce ?? '',
		};
	}

	__sendGatewayConnectRequest(ws, nonce, { legacy = false } = {}) {
		// 用 rpcSeq 保证 ID 唯一，避免 v3→legacy 同毫秒内两次调用产生相同 id
		this.gatewayRpcSeq += 1;
		this.gatewayConnectReqId = `coclaw-connect-${Date.now()}-${this.gatewayRpcSeq}`;
		this.logger.info?.(`[coclaw] gateway connect request -> id=${this.gatewayConnectReqId} legacy=${legacy}`);
		try {
			const authToken = this.__resolveGatewayAuthToken();
			const params = {
				minProtocol: 3,
				maxProtocol: 3,
				client: {
					id: 'gateway-client',
					version: this.__pluginVersion ?? 'unknown',
					platform: process.platform,
					mode: 'backend',
				},
				caps: ['tool-events'],
				role: 'operator',
				scopes: ['operator.admin'],
				auth: authToken ? { token: authToken } : undefined,
			};
			// legacy 回退仅省略 device 字段；其他字段保持与 v3 一致。
			// 当 gateway 不支持/不接受 device 字段时，auth.token 足以完成旧版握手。
			if (!legacy) {
				params.device = this.__buildDeviceField(nonce, authToken);
			}
			ws.send(JSON.stringify({
				type: 'req',
				id: this.gatewayConnectReqId,
				method: 'connect',
				params,
			}));
		}
		catch (err) {
			this.logger.warn?.(`[coclaw] gateway connect request failed: ${String(err?.message ?? err)}`);
			this.gatewayConnectReqId = null;
		}
	}

	/**
	 * 握手失败一次：累加计数；未耗尽则按退避表调度下次尝试，耗尽则进入 gave-up 终态。
	 * 调度 / 尝试 / 终态 guard 由 __ensureGatewayConnection 一致执行。
	 * @param {string} reason - 本次失败原因，用于 gave-up 时汇总上报
	 */
	__onGatewayAttemptFailed(reason) {
		if (!this.started || this.__gatewayGaveUp || this.__gatewayRetryTimer) {
			return;
		}
		this.__gatewayLastReason = reason;
		this.__gatewayAttempts += 1;
		if (this.__gatewayAttempts > GATEWAY_RETRY_DELAYS_MS.length) {
			this.__gatewayGaveUp = true;
			remoteLog(`gateway.handshake.gave-up attempts=${this.__gatewayAttempts} lastReason=${reason}`);
			this.logger.warn?.(`[coclaw] gateway handshake gave up after ${this.__gatewayAttempts} attempts (last reason: ${reason})`);
			return;
		}
		const delay = GATEWAY_RETRY_DELAYS_MS[this.__gatewayAttempts - 1];
		this.__gatewayRetryTimer = setTimeout(() => {
			this.__gatewayRetryTimer = null;
			this.__ensureGatewayConnection();
		}, delay);
		this.__gatewayRetryTimer.unref?.();
	}

	__ensureGatewayConnection() {
		// 停机守卫：防止 stop() 之后某个已进入调度队列的 retry timer callback 再触发新 WS
		if (!this.started) {
			return;
		}
		// 刷屏治理：已进入终态 / 已调度下次尝试 → 不启动新 WS。
		// 这两个 guard 保证在 __waitGatewayReady 或 server WS 重连的连续触发下
		// 只会按退避表节奏新建连接。
		if (this.__gatewayGaveUp || this.__gatewayRetryTimer) {
			return;
		}
		// 外/内/P2P 三条线各自独立：内线（plugin↔本机 gateway）的建连节奏不再看外线脸色。
		// 外线断不影响这里启动，外线即便没起来也允许内线先跑（DC RPC 仍能通过 P2P 直达）。
		if (this.gatewayWs) {
			return;
		}
		const WebSocketCtor = this.__resolveWebSocket();
		/* c8 ignore next 3 -- WebSocketCtor=null 仅测试注入下出现，生产路径 ws 库总能解析 */
		if (!WebSocketCtor) {
			return;
		}
		const ws = new WebSocketCtor(this.__resolveGatewayWsUrl());
		this.gatewayWs = ws;
		this.gatewayReady = false;
		this.gatewayConnectReqId = null;

		// per-WS 闭包状态，只在本条 WS 的生命周期内有效。
		let connectFailReported = false;   // 已经打过 ws.connect-failed；close 时抑制重复的 ws.disconnected
		let pendingLegacyAttempted = false; // 本 WS 已尝试过 legacy 握手，避免重复降级
		let wasReady = false;               // 本 WS 曾经握手成功（区分"握手失败"与"成功后断开"）
		let lastChallengeNonce = '';        // 最近一次 challenge 的 nonce，legacy 回退时复用

		// 注意：listener 用 sync wrapper + IIFE.catch 形式，避免 async listener 抛出的
		// promise 变 unhandledRejection 击穿 gateway 进程。await sendTo / settle / broadcast
		// 等路径若抛错必须在此兜底。
		ws.addEventListener('message', (event) => {
			(async () => {
				// stale guard：与 server sock open/message 已加的 guard 对称。
				// 旧 gateway ws 关闭后若仍有迟到的 message（connect.challenge / res / event），
				// 处理路径会写 this.gatewayConnectReqId / this.gatewayReady / 转发 res 等共享状态，
				// 污染当前 ws 的握手或路由
				if (this.gatewayWs !== ws) {
					return;
				}
				let payload = null;
				try {
					payload = JSON.parse(String(event.data ?? '{}'));
				}
				catch {
					return;
				}
				if (!payload || typeof payload !== 'object') {
					return;
				}
				if (payload.type === 'event' && payload.event === 'connect.challenge') {
					const nonce = payload?.payload?.nonce ?? '';
					lastChallengeNonce = nonce;
					this.logger.info?.(`[coclaw] gateway event <- connect.challenge legacyMode=${this.__gatewayLegacyMode}`);
					// 已经学到此 gateway 是 legacy（上一条 WS 回退过）→ 直接发 legacy 握手
					if (this.__gatewayLegacyMode) {
						pendingLegacyAttempted = true;
						this.__sendGatewayConnectRequest(ws, nonce, { legacy: true });
					}
					else {
						this.__sendGatewayConnectRequest(ws, nonce);
					}
					return;
				}
				if (payload.type === 'res' && this.gatewayConnectReqId && payload.id === this.gatewayConnectReqId) {
					if (payload.ok === true) {
						this.gatewayReady = true;
						wasReady = true;
						this.__gatewayAttempts = 0; // 成功握手 → 重置失败计数，让后续瞬态断开有完整重试预算
						remoteLog('ws.connected peer=gateway');
						this.logger.info?.(`[coclaw] gateway connect ok <- id=${payload.id}`);
						this.gatewayConnectReqId = null;
						this.__ensureSessionsPromise = this.__ensureAllAgentSessions();
						this.__pushInstanceInfo();
					}
					else {
						const reason = payload?.error?.message ?? 'unknown';
						// v3 → legacy 同 WS 回退：仅在签名/协议相关错误、且本 WS 尚未尝试 legacy 时触发
						const shouldFallback =
						!pendingLegacyAttempted
						&& !this.__gatewayLegacyMode
						&& GATEWAY_HANDSHAKE_FALLBACK_PATTERN.test(reason);
						if (shouldFallback) {
							pendingLegacyAttempted = true;
							this.__gatewayLegacyMode = true;
							// v3 的失败原因已由这条 remoteLog 单独上报，不写入 __gatewayLastReason；
							// 后者保持"最后一次真正失败的原因"语义，供 gave-up 时使用。
							remoteLog(`gateway.handshake.fallback v3→legacy reason=${reason}`);
							this.logger.info?.(`[coclaw] gateway v3 handshake failed (${reason}), falling back to legacy`);
							this.__sendGatewayConnectRequest(ws, lastChallengeNonce, { legacy: true });
							return;
						}
						this.gatewayReady = false;
						this.gatewayConnectReqId = null;
						connectFailReported = true;
						this.__gatewayLastReason = reason;
						remoteLog(`ws.connect-failed peer=gateway msg=${reason}`);
						this.logger.warn?.(`[coclaw] gateway connect failed: ${reason}`);
						try {
							ws.__closedByPlugin = true;
							ws.close(1008, 'gateway_connect_failed');
						}
						/* c8 ignore next */
						catch {}
					}
					return;
				}
				if (payload.type === 'res' && typeof payload.id === 'string') {
					const settle = this.gatewayPendingRequests.get(payload.id);
					if (settle) {
						settle({
							ok: payload.ok === true,
							response: payload,
							error: payload?.error?.message ?? payload?.error?.code,
						});
						return;
					}
				}
				/* c8 ignore next 3 -- connect 完成前的消息过滤 */
				if (!this.gatewayReady) {
					return;
				}
				if (payload.type === 'res' || payload.type === 'event') {
				// (a) 过滤 gateway 的管理层广播事件，这些对 WebChat / plugin 客户端无意义：
				// - health: 全量状态快照（~3KB, ~60s 一次 + RPC 触发），给 Admin UI 的监控仪表盘用
				// - tick: gateway WS 保活心跳（30s 一次），UI 隔着 DC 不需要，DC 自己有 probe 机制
				// 不转发可避免后台时 rpc DC 队列被灌满。上游支持按需订阅前先在插件侧拦截。
					if (payload.type === 'event'
					&& (payload.event === 'health' || payload.event === 'tick')) {
						return;
					}
					// (b) agent RPC 进入 phase-2 终态时停 lag 探针（必须放在 (c) 单播分支之前，
					// 避免命中后探针不停导致 60s 兜底 + 噪声日志）
					const lagReason = classifyAgentLagStop(payload);
					if (lagReason !== null) {
						this.__stopLagProbe(payload.id, lagReason);
					}
					// (c) UI 转发 RPC 的 res 单播：按 reqId 查路由表，命中则定向 sendTo
					if (payload.type === 'res' && typeof payload.id === 'string') {
						const info = this.__dcPendingRequests.get(payload.id);
						if (info) {
							// runId 路由表维护：accepted 时 add（首发优先），非 accepted 时 remove。
							// 写入要求 reqId 表命中以拿 connId；删除嵌在 reqId 命中分支内——
							// 因 reqId 表 miss 意味着写入也未发生过（设计上等价 no-op），
							// 极端错位（reqId 表先 TTL 过期、runId 表条目仍存）由 24h TTL 兜底。
							const runId = payload.payload?.runId;
							if (typeof runId === 'string' && runId) {
								if (payload.payload?.status === 'accepted') {
									this.__runEventRoutes?.add(runId, info.connId, payload.id);
									this.logger.debug?.(`[coclaw/run-event-route] add runId=${runId} connId=${info.connId} reqId=${payload.id}`);
								}
								else {
									this.__runEventRoutes?.remove(runId, payload.id);
									this.logger.debug?.(`[coclaw/run-event-route] remove runId=${runId} reqId=${payload.id}`);
								}
							}
							// 终态才清条目；accepted 类中间态保留等下一帧
							if (isFinalResMsg(payload)) {
								this.__dcPendingRequests.delete(payload.id);
								this.logger.debug?.(`[coclaw/rpc-res-route] remove reqId=${payload.id} reason=final-res`);
							}
							/* c8 ignore next -- TODO: 2026-05-20 后删除 */
							this.logger.debug?.(`[coclaw/rpc-res-route] hit, reqId=${payload.id} → connId=${info.connId}`);
							// sendTo 阶段 1 改为 async（admission 决策 await）；外层 listener 已是 async
							const delivered = await this.webrtcPeer?.sendTo(info.connId, payload);
							if (!delivered) {
							// PC 已断 / DC 未 open / 队列拒收：本地 log 丢弃，不退回广播
								this.__logDebug(
									`dc res undeliverable: id=${payload.id} connId=${info.connId}`
								);
							}
							return;
						}
						/* c8 ignore next -- TODO: 2026-05-20 后删除 */
						this.logger.debug?.(`[coclaw/rpc-res-route] miss, broadcast, reqId=${payload.id}`);
					}
					// (c2) agent event 按 runId 单播：命中即送达，不退兜底广播；miss 走 (d) 兜底
					if (payload.type === 'event' && payload.event === 'agent') {
						const runId = payload.payload?.runId;
						if (typeof runId === 'string' && runId) {
							const connId = this.__runEventRoutes?.lookup(runId);
							if (connId !== undefined) {
								/* c8 ignore next -- TODO: 2026-05-20 后删除 */
								this.logger.debug?.(`[coclaw/run-event-route] hit, runId=${runId} → connId=${connId}`);
								// sendTo 失败不打 log（PC 状态翻转日志已足够，drop 是正确语义）
								await this.webrtcPeer?.sendTo(connId, payload);
								return;
							}
						}
						/* c8 ignore next -- TODO: 2026-05-20 后删除 */
						this.logger.debug?.(`[coclaw/run-event-route] miss, broadcast, runId=${runId ?? '<missing>'}`);
					}
					// (d) 兜底广播：覆盖 event 类型 / 映射未命中场景
					this.webrtcPeer?.broadcast(payload);
				}
			})().catch((err) => {
				this.logger.warn?.(`[coclaw] gateway ws message handler error: ${err?.message ?? err}`);
			});
		});

		ws.addEventListener('open', () => {
			this.logger.info?.('[coclaw] gateway ws open, waiting for connect.challenge');
		});
		ws.addEventListener('close', (ev) => {
			// 区分本端 plugin 主动关闭与对端 OpenClaw gateway 关闭：日志/远程上报用不同事件名，
			// 避免读 log 时把"plugin 自己关"误读成"对端断开"（reason 字段全在我们自定义）；
			// server 仍可从 remoteLog 频次发现 local-close 循环异常。
			const closedByPlugin = ws.__closedByPlugin === true;
			// 握手失败路径已经打过 ws.connect-failed，这里抑制重复的远程上报；
			// 其它分支（成功后掉线 / 握手中异常断开 / plugin 主动关闭）按原样上报。per-WS log 用
			// 闭包局部 connectFailReported，无需身份校验
			if (!connectFailReported) {
				if (closedByPlugin) {
					remoteLog(`ws.local-close peer=gateway reason=${ev?.reason ?? 'n/a'}`);
				}
				else {
					remoteLog(`ws.disconnected peer=gateway code=${ev?.code ?? '?'} reason=${ev?.reason ?? 'n/a'}`);
				}
			}
			if (closedByPlugin) {
				this.logger.info?.(`[coclaw] gateway ws closed by plugin (reason=${ev?.reason ?? 'n/a'})`);
			}
			else {
				this.logger.info?.(`[coclaw] gateway ws closed by peer (code=${ev?.code ?? '?'} reason=${ev?.reason ?? 'n/a'})`);
			}
			// stale guard：旧 ws 的迟到 close 不应清新 ws 的 lag probes / pending requests / DC 路由 /
			// 也不应触发新一轮重试调度。非当前 ws → 直接早返，仅留 per-WS 日志。
			if (this.gatewayWs !== ws) {
				return;
			}
			// gateway WS 一断，正在跑的 agent RPC 不会再有 phase-2 res，主动结算所有 lag 探针，
			// 避免它们空跑到 60s 兜底，期间还会持续打 spike 噪声。
			this.__clearAllLagProbes();
			this.gatewayWs = null;
			this.gatewayReady = false;
			this.gatewayConnectReqId = null;
			/* c8 ignore next 3 -- gateway 意外断开时结算未完成 RPC，避免等超时 */
			for (const [, settle] of this.gatewayPendingRequests) {
				settle({ ok: false, error: 'gateway_closed' });
			}
			this.gatewayPendingRequests.clear();
			// P2P 路由表（__dcPendingRequests / __runEventRoutes）不在这里清：
			// 内线翻转不应级联影响 P2P。已发出去的 RPC 在 UI 侧 30/60s 超时兜底；
			// 路由表条目由 start() 启动的周期扫描器（24h TTL）回收，stop() 时显式 clear。
			// 调度下一次尝试：仅在 bridge 仍活着、未 gave-up 时；不再看外线脸色（外/内独立重试）。
			if (this.started && !this.__gatewayGaveUp
				&& (wasReady || connectFailReported)) {
				if (wasReady) {
					// 之前握成功过，视为瞬态掉线 → 重置计数，让新一轮拿到完整重试预算
					this.__gatewayAttempts = 0;
				}
				this.__onGatewayAttemptFailed(
					/* c8 ignore next -- connectFailReported 路径必然已设 __gatewayLastReason */
					wasReady ? 'disconnected' : (this.__gatewayLastReason ?? 'connect-failed')
				);
			}
		});
		ws.addEventListener('error', (err) => {
			/* c8 ignore next -- ?./?? fallback */
			remoteLog(`ws.error peer=gateway msg=${String(err?.message ?? err)}`);
			this.logger.warn?.(`[coclaw] gateway ws error: ${String(err?.message ?? err)}`);
			// 防御 ws 库在某些错误下只 emit error 不跟随 close 的情况：主动关闭让 close handler
			// 接管清理和重试调度，避免 gatewayWs 引用卡在僵尸状态阻塞后续 __ensureGatewayConnection。
			try {
				ws.__closedByPlugin = true;
				ws.close(1011, 'ws_error');
			}
			/* c8 ignore next */
			catch {}
		});
	}

	async __waitGatewayReady(timeoutMs = this.__gatewayReadyTimeoutMs) {
		this.__ensureGatewayConnection();
		if (this.gatewayWs && this.gatewayWs.readyState === 1 && this.gatewayReady) {
			return true;
		}
		const ws = this.gatewayWs;
		/* c8 ignore next 3 -- serverWs 为 null 时 ensureGatewayConnection 不创建 gatewayWs */
		if (!ws) {
			return false;
		}
		return await new Promise((resolve) => {
			let done = false;
			const finish = (ok) => {
				/* c8 ignore next 3 -- 防御并发 finish */
				if (done) {
					return;
				}
				done = true;
				clearTimeout(timer);
				clearInterval(poller);
				ws.removeEventListener?.('error', onError);
				ws.removeEventListener?.('close', onClose);
				resolve(ok);
			};
			/* c8 ignore next */
			const onError = () => finish(false);
			const onClose = () => finish(false);
			/* c8 ignore next 10 -- 轮询检测 gateway ready，时序依赖难以在单测中精确触发 */
			const poller = setInterval(() => {
				if (this.gatewayWs !== ws) {
					finish(false);
					return;
				}
				if (this.gatewayReady && ws.readyState === 1) {
					finish(true);
				}
			}, 25);
			poller.unref?.();
			const timer = setTimeout(() => finish(false), timeoutMs);
			timer.unref?.();
			ws.addEventListener('error', onError);
			ws.addEventListener('close', onClose);
		});
	}

	async __handleGatewayRequestFromDc(payload, connId) {
		// 入口校验：peer 可能发出残缺 / 类型错误的帧；不应向 gateway 转发 id/method 缺失的请求
		const hasValidId = typeof payload?.id === 'string' && payload.id.length > 0;
		const hasValidMethod = typeof payload?.method === 'string' && payload.method.length > 0;
		if (!hasValidId || !hasValidMethod) {
			this.logger.warn?.(
				`[coclaw] dc gateway req invalid: id=${typeof payload?.id} method=${typeof payload?.method}`,
			);
			// 有合法 id 时回 INVALID_REQUEST 让发起方尽快放弃等待；id 不合法时只能 drop
			if (hasValidId) {
				this.webrtcPeer?.broadcast({
					type: 'res',
					id: payload.id,
					ok: false,
					error: { code: 'INVALID_REQUEST', message: 'missing or invalid id/method' },
				});
			}
			return;
		}
		const ready = await this.__waitGatewayReady();
		if (!ready || !this.gatewayWs || this.gatewayWs.readyState !== 1) {
			// OFFLINE 路径在写映射前触发，无脏映射；保留广播语义（属系统状态公告）
			this.__logDebug(`gateway req drop (offline): id=${payload.id} method=${payload.method}`);
			this.webrtcPeer?.broadcast({
				type: 'res',
				id: payload.id,
				ok: false,
				error: {
					code: 'GATEWAY_OFFLINE',
					message: 'Gateway is offline',
				},
			});
			return;
		}
		// 撞号检测：UUID 全唯一时极小概率，但旧 UI 跨 tab 或 UI bug 可能触发。
		// 删旧条目让旧响应未来走广播兜底，不主动回错给旧发起方（可能已断）
		const id = payload.id;
		if (typeof id === 'string' && this.__dcPendingRequests.has(id)) {
			this.logger.warn?.(`[coclaw] duplicate dc reqId, dropping previous mapping: id=${id}`);
			this.__dcPendingRequests.delete(id);
		}
		// 写映射：必须在 ready 通过后、send 之前；缺 connId 时退化为旧广播行为
		if (typeof id === 'string' && connId) {
			this.__dcPendingRequests.set(id, {
				connId,
				expireAt: Date.now() + this.__dcReqTtlMs,
			});
			this.logger.debug?.(`[coclaw/rpc-res-route] add reqId=${id} connId=${connId}`);
		}
		try {
			this.__logDebug(`gateway req -> id=${id} method=${payload.method}`);
			this.gatewayWs.send(JSON.stringify({
				type: 'req',
				id,
				method: payload.method,
				params: payload.params ?? {},
			}));
			// 仅 agent RPC 启动 lag 探针（覆盖发送 → phase-2 终态全程）。
			if (payload.method === 'agent') {
				this.__startLagProbe(id);
			}
		}
		catch {
			// SEND_FAILED：撤回映射后广播错误响应
			if (typeof id === 'string') {
				const removed = this.__dcPendingRequests.delete(id);
				if (removed) {
					this.logger.debug?.(`[coclaw/rpc-res-route] remove reqId=${id} reason=send-failed`);
				}
			}
			this.webrtcPeer?.broadcast({
				type: 'res',
				id,
				ok: false,
				error: {
					code: 'GATEWAY_SEND_FAILED',
					message: 'Failed to send request to gateway',
				},
			});
		}
	}

	__clearConnectTimer() {
		if (!this.connectTimer) {
			return;
		}
		clearTimeout(this.connectTimer);
		this.connectTimer = null;
	}

	// agent run 期间监测 gateway 主线程是否被同步代码阻塞。
	// 设计动机：上游 OpenClaw 同步路径上有重活（详见 docs/openclaw-upstream-issues.md），
	// 修复前作为持续诊断信号保留——主线程一旦被同步阻塞，agent send 路径会出现几十秒的卡顿。
	//
	// 异常隔离：插件运行在 gateway 进程内，timer 回调任何同步抛出都会让进程崩溃
	// （CLAUDE.md 第 123 行明确禁止全局异常兜底），因此 interval/timeout 回调都用 try/catch 局部包裹。
	__startLagProbe(id) {
		if (this.__agentLagProbes.has(id)) return;
		let lastTick = Date.now();
		const stats = { ticks: 0, max: 0, sumOver: 0, over: 0, startedAt: lastTick };
		const interval = setInterval(() => {
			try {
				const now = Date.now();
				const lag = now - lastTick - LAG_PROBE_PERIOD_MS;
				lastTick = now;
				stats.ticks += 1;
				if (lag > stats.max) stats.max = lag;
				if (lag > LAG_PROBE_THRESHOLD_MS) {
					stats.over += 1;
					stats.sumOver += lag;
					this.logger.warn?.(`[coclaw] lag.spike id=${id} +${lag}ms`);
				}
			}
			catch {
				// 探针自身异常静默吞掉，避免拖垮 gateway。
			}
		}, LAG_PROBE_PERIOD_MS);
		interval.unref?.();
		const timeout = setTimeout(() => this.__stopLagProbe(id, 'timeout'), LAG_PROBE_MAX_DURATION_MS);
		timeout.unref?.();
		this.__agentLagProbes.set(id, { interval, timeout, stats });
		// lag.start 日志即便抛异常也不能影响调用方（在 __handleGatewayRequestFromDc 的 try/catch 内，
		// 抛出会被误判为 send 失败 → 错发 GATEWAY_SEND_FAILED）。
		try { this.logger.info?.(`[coclaw] lag.start id=${id}`); }
		catch { /* 诊断日志失败不影响主流程 */ }
	}

	__stopLagProbe(id, reason) {
		const probe = this.__agentLagProbes.get(id);
		if (!probe) return;
		clearInterval(probe.interval);
		clearTimeout(probe.timeout);
		this.__agentLagProbes.delete(id);
		try {
			const stats = probe.stats;
			const dur = Date.now() - stats.startedAt;
			this.logger.info?.(`[coclaw] lag.summary id=${id} reason=${reason} dur=${dur}ms ticks=${stats.ticks} max=${stats.max}ms over100=${stats.over} sumOver=${stats.sumOver}ms`);
		}
		catch {
			// summary 输出失败不应阻断后续 RPC 广播——清理已完成，吞掉异常即可。
		}
	}

	__clearAllLagProbes() {
		const ids = Array.from(this.__agentLagProbes.keys());
		for (const id of ids) {
			this.__stopLagProbe(id, 'cleanup');
		}
	}

	__scheduleReconnect() {
		if (!this.started || this.reconnectTimer) {
			return;
		}
		remoteLog(`ws.reconnecting peer=server delay=${RECONNECT_MS}ms`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.__connectIfNeeded().catch((err) => {
				/* c8 ignore next -- 防御性兜底，__connectIfNeeded 内部已有完整错误处理 */
				this.logger.warn?.(`[coclaw] reconnect failed: ${err?.message}`);
			});
		}, RECONNECT_MS);
		this.reconnectTimer.unref?.();
	}

	async __connectIfNeeded() {
		/* c8 ignore next 3 -- 仅从 start/reconnect 内部调用，条件不满足时的防御 */
		if (!this.started || this.serverWs) {
			return;
		}

		const bindingsPath = this.__getBindingsPath();
		const cfg = await this.__readConfig();
		if (!cfg?.token) {
			this.logger.warn?.(`[coclaw] realtime bridge skip connect: missing token in ${bindingsPath}`);
			return;
		}

		const baseUrl = cfg.serverUrl;
		if (!baseUrl) {
			this.logger.warn?.(`[coclaw] realtime bridge skip connect: missing serverUrl in ${bindingsPath}`);
			return;
		}
		const target = toServerWsUrl(baseUrl, cfg.token);
		const WebSocketCtor = this.__resolveWebSocket();
		if (!WebSocketCtor) {
			this.logger.warn?.('[coclaw] WebSocket not available, skip realtime bridge');
			return;
		}

		const maskedTarget = maskUrlToken(target);
		this.logger.info?.(`[coclaw] realtime bridge connecting: ${maskedTarget} (cfg: ${bindingsPath})`);
		this.intentionallyClosed = false;
		const sock = new WebSocketCtor(target);
		this.serverWs = sock;
		this.__clearConnectTimer();
		this.connectTimer = setTimeout(() => {
			/* c8 ignore next 3 -- 防御 stale timer 回调 */
			if (this.serverWs !== sock || this.intentionallyClosed) {
				return;
			}
			this.logger.warn?.(`[coclaw] realtime bridge connect timeout, will retry: ${maskedTarget}`);
			remoteLog('ws.connect-timeout peer=server');
			this.serverWs = null;
			// 外线超时不级联关内线/清 P2P 路由：三条线各自独立。
			this.__scheduleReconnect();
			try { sock.close(4000, 'connect_timeout'); }
			/* c8 ignore next */
			catch {}
		}, CONNECT_TIMEOUT_MS);
		this.connectTimer.unref?.();

		sock.addEventListener('open', () => {
			// 旧 sock 迟到的 open 不应接管当前会话：避免在 reconnect 后旧 sock 再注入 sender / 重置心跳，
			// 对称于 close handler 的 sock !== this.serverWs guard
			if (this.serverWs !== sock || this.intentionallyClosed) {
				return;
			}
			this.__clearConnectTimer();
			this.logger.info?.(`[coclaw] realtime bridge connected: ${maskedTarget}`);
			remoteLog('ws.connected peer=server');
			// 顺序很重要：先注入 sender 再 remoteLog 环境信息——这样环境信息能随当前 sock
			// 立即 flush；同时 sender 内部仅做 sock.send（不回调 remoteLog），无循环依赖。
			setRemoteLogSender((msg) => {
				if (sock.readyState === 1) sock.send(JSON.stringify(msg));
			});
			// ws 重连后补发环境信息：server 重启重连后能立即看到当前 claw 的运行环境与 webrtc 选型。
			// __buildEnvLine 内部所有读取均为缓存值，无 native syscall。
			remoteLog(this.__buildEnvLine());
			this.__startServerHeartbeat(sock);
			// 三线独立后内线可能先于外线就绪：那次 push 因外线未 open 在 server 路径被 drop，
			// 故外线 open 时若内线已 ready 补推一次。门控 gatewayReady 是因为 agentModels 依赖
			// 内线 agents.list RPC，内线没就绪发出去字段不全会污染 admin 仪表盘。
			if (this.gatewayReady) {
				this.__pushInstanceInfo();
			}
		});

		sock.addEventListener('message', async (event) => {
			// 旧 sock 迟到的 message 不应重置当前 sock 的心跳节奏；同 open 路径处理
			if (this.serverWs !== sock || this.intentionallyClosed) {
				return;
			}
			this.__resetServerHbTimeout(sock);
			try {
				const payload = JSON.parse(String(event.data ?? '{}'));
				if (payload?.type === 'claw.unbound') {
					remoteLog('ws.claw-unbound');
					await this.__clearTokenLocal(payload.clawId);
					try { sock.close(4001, 'claw_unbound'); }
					/* c8 ignore next */
					catch {}
					return;
				}
				if (payload?.type?.startsWith('rtc:')) {
					try {
						if (!this.__webrtcPeerReady) {
							this.__webrtcPeerReady = this.__initWebrtcPeer().catch((err) => {
								this.__webrtcPeerReady = null;
								throw err;
							});
						}
						await this.__webrtcPeerReady;
						await this.webrtcPeer.handleSignaling(payload);
					} catch (err) {
						this.logger.warn?.(`[coclaw/rtc] signaling error (or werift not found): ${err?.message}`);
						remoteLog(`rtc.signaling-error msg=${err?.message}`);
					}
					return;
				}
			}
			catch (err) {
				this.logger.warn?.(`[coclaw] realtime message parse failed: ${String(err?.message ?? err)}`);
			}
		});

		sock.addEventListener('close', async (event) => {
			// 若 serverWs 已指向新实例（如 refresh 后），跳过旧 sock 的清理。
			// __clearServerHeartbeat / __clearConnectTimer 都是 per-bridge 全局单槽，
			// 旧 sock close 若跑在 guard 前会清掉新 sock 的 heartbeat
			if (this.serverWs !== null && this.serverWs !== sock) {
				return;
			}
			this.__clearServerHeartbeat();
			this.__clearConnectTimer();
			setRemoteLogSender(null);
			const wasIntentional = this.intentionallyClosed;
			this.serverWs = null;
			this.intentionallyClosed = false;
			// 外线 close 不再级联关内线/清 P2P 路由：内线（plugin↔本机 gateway）与 P2P
			// 与外线（plugin↔远端 server）解耦，各自独立维护生命周期。auth-close 分支
			// （下方）是唯一允许级联 PC/fileHandler/token 的路径，因为 plugin 已失资格。

			// auth-close (4001/4003) 语义是 plugin 失去服务资格，必须连同 PC/fileHandler 一起清；
			// 其它 close code（含 4000 心跳超时、1006 abnormal、1011 等）视为信令通道瞬态不通，
			// 保留 webrtcPeer / fileHandler 实例供重连后复用，避免雪崩式 PC 重建。
			const isAuthClose = event?.code === 4001 || event?.code === 4003;
			if (isAuthClose) {
				if (this.webrtcPeer) {
					try { await this.webrtcPeer.closeAll(); }
					/* c8 ignore next 3 -- 防御性兜底，werift close 异常时不可崩溃 gateway */
					catch (e) { this.logger.warn?.(`[coclaw/rtc] closeAll failed: ${e?.message}`); }
					this.webrtcPeer = null;
					this.__webrtcPeerReady = null;
				}
				if (this.__fileHandler) {
					this.__fileHandler.cancelCleanup();
					this.__fileHandler = null;
				}
				remoteLog(`ws.auth-close peer=server code=${event.code}`);
				this.logger.warn?.(`[coclaw] server ws auth-close (code=${event.code}), clearing local token`);
				try {
					await this.__clearTokenLocal();
				}
				/* c8 ignore next 3 -- 防御性兜底，磁盘 I/O 异常时不可崩溃 gateway */
				catch (e) {
					this.logger.error?.('[coclaw] clearTokenLocal failed on auth-close', e);
				}
				return;
			}

			if (!wasIntentional) {
				const sessionCount = this.webrtcPeer?.__sessions?.size ?? 0;
				remoteLog(`ws.disconnected peer=server code=${event?.code ?? 'unknown'} reason=${event?.reason ?? 'n/a'} keep-pc=true sessions=${sessionCount}`);
				this.logger.warn?.(`[coclaw] realtime bridge closed (${event?.code ?? 'unknown'}: ${event?.reason ?? 'n/a'}), will retry in ${RECONNECT_MS}ms (keep-pc, sessions=${sessionCount})`);
				this.__scheduleReconnect();
			}
		});

		sock.addEventListener('error', (err) => {
			if (this.serverWs !== sock || this.intentionallyClosed) {
				return;
			}
			this.__clearServerHeartbeat();
			this.__clearConnectTimer();
			setRemoteLogSender(null);
			remoteLog(`ws.error peer=server msg=${String(err?.message ?? err)}`);
			/* c8 ignore next -- ?./?? fallback */
			this.logger.warn?.(`[coclaw] realtime bridge error, will retry in ${RECONNECT_MS}ms: ${String(err?.message ?? err)}`);
			this.serverWs = null;
			// 外线 error 不级联关内线/清 P2P 路由：三条线各自独立。
			this.__scheduleReconnect();
			try { sock.close(4000, 'connect_error'); }
			/* c8 ignore next */
			catch {}
		});
	}

	/* c8 ignore start -- WebRTC preload 涉及 native/Go 进程，集成测试覆盖 */
	async __preloadWebrtc() {
		// 版本预热并行启动
		const versionPromise = getPluginVersion()
			.then((v) => { this.__pluginVersion = v; })
			.catch(() => { this.__pluginVersion = 'unknown'; });

		// 1. 尝试 pion（最高优先级）
		const preloadPionFn = this.__preloadPion
			?? (await import('./webrtc/pion-preloader.js')).preloadPion;
		const pionResult = await preloadPionFn({ logger: this.logger }).catch((err) => {
			this.logger.warn?.(`[coclaw] pion preload unexpected failure: ${err?.message}`);
			return null;
		});
		if (pionResult?.PeerConnection) {
			await versionPromise;
			return pionResult;
		}

		// 2. 回退到 ndc/werift
		const preloadNdcFn = this.__preloadNdc
			?? (await import('./webrtc/ndc-preloader.js')).preloadNdc;
		const [ndcResult] = await Promise.all([
			preloadNdcFn().catch((err) => {
				this.logger.warn?.(`[coclaw] ndc preload unexpected failure: ${err?.message}`);
				return { PeerConnection: null, cleanup: null, impl: 'none' };
			}),
			versionPromise,
		]);
		return ndcResult;
	}
	/* c8 ignore stop */

	async start({ logger, pluginConfig } = {}) {
		/* c8 ignore next 2 -- ?? fallback：测试始终注入 logger/pluginConfig */
		this.logger = logger ?? console;
		this.pluginConfig = pluginConfig ?? {};
		this.started = true;
		// rpc DC 文件回退队列的启动期预热（B-stage1 plan-2）：清残留 *.jsonl + 探测磁盘容量。
		// 远早于第一条 rpc DC 建立（dump 设计）；__diskCap 暂存供 B-stage2 切 FBQ 时取用。
		// 整块包 try/catch：模块自身不抛，但仍可能进入 catch 的路径——pluginDir() 同步抛
		// （runtime 未注入 / nodePath.join 参数异常 / 测试注入的 stub 抛错）。任何路径都不能把
		// bridge.start 卡死。
		// 10s timeout 兜底：cleanup/measure 内部已永不抛（仅 warn + fallback），但 fs hang
		// 场景（NFS / 网络挂载 / 磁盘卡）下 fs.promises 调用不返回，整段会卡死；超时让 catch
		// 兜底降级到 MemoryQueue，bridge 至少能起来。
		// race 闭合：prep 改成纯返回值，timeout 赢时 catch 显式赋 null；不在 IIFE 内部 mutate
		// `this.__diskCap`，避免后台 prep 晚到把降级状态又覆盖回非 null。
		try {
			const queueDir = nodePath.join(pluginDir(), 'rpc-queues');
			const prepPromise = (async () => {
				await this.__cleanupRpcQueueResiduals(queueDir, { logger: this.logger });
				const diskCap = await this.__measureRpcQueueDiskCap(queueDir, { logger: this.logger });
				return { queueDir, diskCap };
			})();
			let timeoutId;
			const timeoutPromise = new Promise((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error('rpc-queues startup prep timeout (10s)')), 10000);
				timeoutId.unref?.();
			});
			let result;
			try {
				result = await Promise.race([prepPromise, timeoutPromise]);
			}
			finally {
				clearTimeout(timeoutId);
			}
			// race 赢后才赋字段：保证 __diskCap / __queueDir 同时一致
			this.__diskCap = result.diskCap;
			this.__queueDir = result.queueDir;
		}
		catch (err) {
			/* c8 ignore next -- ?./?? fallback：err 总是 Error，logger.warn 总存在 */
			this.logger.warn?.(`[coclaw] rpc-queues startup prep failed (skipped): ${err?.message ?? err}`);
			this.__diskCap = null;
			this.__queueDir = null;
		}
		// race 守卫：cleanup/measure 期间若 stop() 已执行，不应再启动 native WebRTC 进程。
		// preload 后还有一道 started 检查兜底（含 pion cleanup），这里先挡住一次无意义的 preload。
		if (!this.started) return;
		// 先完成 WebRTC 实现加载，再建立连接，避免 UI 发来 offer 时 RTC 包未就绪
		// 优先级：pion → ndc → werift → none
		const preloadResult = await this.__preloadWebrtc();
		// 竞态保护：若 preload 期间 stop() 已执行，不再赋值，直接返回。
		if (!this.started) {
			// pion 进程需要关闭
			if (preloadResult.impl === 'pion' && preloadResult.cleanup) {
				preloadResult.cleanup().catch(() => {});
			}
			return;
		}
		this.__ndcPreloadResult = preloadResult;
		this.__ndcCleanup = preloadResult.cleanup;
		const implLabel = preloadResult.impl === 'ndc' ? 'node-datachannel(ndc)' : preloadResult.impl;
		this.__implLabel = implLabel; // 缓存供 ws.open 时发送
		// 启动信息只本地 log；远程发送统一由 ws.open 触发，避免重复
		this.logger.info?.(`[coclaw] WebRTC impl: ${implLabel}`);
		this.logger.info?.(`[coclaw] ${this.__buildEnvLine()}`);
		remoteLog('bridge.started');
		// 启动 UI 转发 RPC 路由表周期扫描：1h 间隔扫描 24h 过期条目，避免长程 RPC 残留。
		// try/catch 兜底：插件运行在 gateway 进程内，timer 回调任何同步抛出都会让进程崩溃
		// （CLAUDE.md 禁止全局异常兜底），与 __startLagProbe 的实现保持一致。
		this.__dcPendingScanTimer = setInterval(() => {
			try {
				const now = Date.now();
				let cleaned = 0;
				for (const [id, info] of this.__dcPendingRequests) {
					if (info.expireAt <= now) {
						this.__dcPendingRequests.delete(id);
						cleaned++;
					}
				}
				if (cleaned > 0) {
					this.logger.warn?.(`[coclaw] dc pending entries expired: count=${cleaned}`);
				}
			}
			/* c8 ignore next 3 -- 防御性兜底，正常路径下 Map ops + logger.warn 不抛 */
			catch {
				// 扫描器自身异常静默吞掉，避免拖垮 gateway。
			}
		}, this.__dcReqScanMs);
		this.__dcPendingScanTimer.unref?.();
		// 启动 runId → connId 路由表（agent event 单播）。延迟到 start 才 new，确保拿到真 logger。
		this.__runEventRoutes = new RunEventRoutes({
			logger: this.logger,
			ttlMs: this.__runEventRoutesTtlMs,
			scanMs: this.__runEventRoutesScanMs,
		});
		this.__runEventRoutes.init();
		// 外线（plugin↔远端 server）先发起 connectIfNeeded：仅创建 WebSocket 即返回，不阻塞内线。
		await this.__connectIfNeeded();
		// 三条线各自独立启动：内线（plugin↔本机 gateway）由 start() 主动触发，
		// 不再依附于外线 open。即便外线建连失败/未配置 token，内线仍能起来支撑 DC RPC。
		this.__ensureGatewayConnection();
	}

	/**
	 * 组装一条覆盖最基础环境信息的 log 行：
	 *   coclaw.env impl=<...> plugin=<ver> openclaw=<ver> platform=<...> ... mem=<...>
	 *
	 * 字段值均为已缓存的轻量同步读取，无 native syscall；不调用 remoteLog，无循环依赖。
	 */
	__buildEnvLine() {
		const rt = getRuntime();
		const openclawVer = (rt?.version && rt.version !== 'unknown') ? rt.version : 'unknown';
		const impl = this.__implLabel ?? 'pending';
		const plugin = this.__pluginVersion ?? 'unknown';
		return `coclaw.env impl=${impl} plugin=${plugin} openclaw=${openclawVer} ${getPlatformInfoLine()}`;
	}

	async refresh() {
		await this.stop();
		await this.start({
			logger: this.logger,
			pluginConfig: this.pluginConfig,
		});
	}

	async stop() {
		this.started = false;
		setRemoteLogSender(null);
		this.__clearServerHeartbeat();
		this.__clearConnectTimer();
		// stop() / refresh() 兜底回收 lag 探针的 timer，防 unref 仍残留。
		// 顺序依赖：必须早于下方 __closeGatewayWs；后者会立刻把 gatewayWs 置 null，
		// 异步触发的 close 事件会被 stale guard 早返而无法走到 __clearAllLagProbes。
		this.__clearAllLagProbes();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		// 清理 gateway 重试状态：refresh()（stop+start 同一实例）后应以全新状态启动
		if (this.__gatewayRetryTimer) {
			clearTimeout(this.__gatewayRetryTimer);
			this.__gatewayRetryTimer = null;
		}
		this.__gatewayAttempts = 0;
		this.__gatewayGaveUp = false;
		this.__gatewayLegacyMode = false;
		this.__gatewayLastReason = null;
		// 停止 UI 转发 RPC 路由表的周期扫描
		if (this.__dcPendingScanTimer) {
			clearInterval(this.__dcPendingScanTimer);
			this.__dcPendingScanTimer = null;
		}
		// 销毁 runId 路由表（停 timer + clear + 标 destroyed）；refresh 时会重建
		if (this.__runEventRoutes) {
			this.__runEventRoutes.destroy();
			this.__runEventRoutes = null;
		}
		// stop / refresh 是显式销毁路径：P2P 路由表不再随内线翻转清理（动作 5），
		// 但显式销毁时必须清干净，避免 refresh 后留下指向旧 connId 的孤儿条目。
		this.__dcPendingRequests.clear();
		this.__closeGatewayWs();
		if (this.webrtcPeer) {
			await this.webrtcPeer.closeAll().catch(() => {});
			this.webrtcPeer = null;
			this.__webrtcPeerReady = null;
		}
		// pion: 关闭 Go 进程（异步，快速）
		// ndc: 不调用 cleanup()——同步 join native threads 耗时 10s+，进程退出时 OS 回收
		const impl = this.__ndcPreloadResult?.impl;
		if (impl === 'pion' && this.__ndcCleanup) {
			await this.__ndcCleanup().catch(() => {});
		}
		this.__ndcCleanup = null;
		this.__ndcPreloadResult = null;
		if (this.__fileHandler) {
			this.__fileHandler.cancelCleanup();
			this.__fileHandler = null;
		}
		const sock = this.serverWs;
		if (sock) {
			this.intentionallyClosed = true;
			this.serverWs = null;
			// 等待 WebSocket 真正关闭，避免残留连接收到 claw.unbound 等消息
			/* c8 ignore next -- readyState === 3 时跳过 */
			if (sock.readyState === 3) return;
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, 3000);
				timer.unref?.();
				sock.addEventListener('close', () => {
					clearTimeout(timer);
					resolve();
				}, { once: true });
				try { sock.close(1000, 'stopped'); }
				/* c8 ignore next */
				catch { clearTimeout(timer); resolve(); }
			});
		}
	}
}

// --- 单例便捷 API（供 index.js 使用）---
// 仅暴露 restartRealtimeBridge / stopRealtimeBridge 两个操作：
//   restart(opts) — 无论当前状态，确保 bridge 以给定 opts 运行（幂等）
//   stop()        — 停止并销毁 singleton
// 调用方无需感知 singleton 是否为 null，选"要运行"或"要停止"即可。

let singleton = null;

/**
 * 确保 bridge 运行：已有实例则 stop 后重建，无则直接创建。opts 必传。
 * @param {{ logger, pluginConfig }} opts
 */
export async function restartRealtimeBridge(opts) {
	if (singleton) {
		await singleton.stop();
		singleton = null;
	}
	const deps = opts?.__deps; // 仅测试用
	singleton = new RealtimeBridge(deps);
	await singleton.start(opts);
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.forceCleanup] - 调用 ndc cleanup() 释放 native TSFN（仅测试用）。
 *   生产环境不调用：cleanup() 会 join native threads（无活跃 PC 时通常 sub-second，
 *   但 worst-case 阻塞 10s），且 gateway 通过 process.exit() 退出无需依赖事件循环排空。
 */
export async function stopRealtimeBridge({ forceCleanup = false } = {}) {
	if (!singleton) {
		return;
	}
	// pion 的 cleanup 已在 stop() 内处理（fast async），此处 forceCleanup 仅用于 ndc
	const impl = singleton.__ndcPreloadResult?.impl;
	const cleanupFn = (forceCleanup && impl !== 'pion') ? singleton.__ndcCleanup : null;
	await singleton.stop();
	singleton = null; // 置 null 后须通过 restartRealtimeBridge 重建
	/* c8 ignore next 3 -- forceCleanup 仅 ndc 测试清理 TSFN，pion binary 存在时走 pion 路径不触发 */
	if (typeof cleanupFn === 'function') {
		try { cleanupFn(); } catch { /* cleanup 失败不影响 stop 结果 */ }
	}
}

export async function waitForSessionsReady() {
	if (!singleton?.__ensureSessionsPromise) return;
	await singleton.__ensureSessionsPromise;
}

export async function ensureAgentSession(agentId) {
	if (!singleton) {
		return { ok: false, error: 'bridge_not_started' };
	}
	return singleton.ensureAgentSession(agentId);
}

/**
 * 通过 gateway WS 发起两阶段 agent RPC（供标题生成等场景使用）
 * @param {string} method
 * @param {object} params
 * @param {object} [options]
 * @returns {Promise<{ok: boolean, response?: object, error?: string}>}
 */
export async function gatewayAgentRpc(method, params, options) {
	if (!singleton) {
		return { ok: false, error: 'bridge_not_started' };
	}
	return singleton.__gatewayAgentRpc(method, params, options);
}

/**
 * 广播插件自发事件（推送到 server + 广播到所有 UI DC）
 * @param {string} event - 事件名（如 'coclaw.info.updated'）
 * @param {object} [payload]
 */
export function broadcastPluginEvent(event, payload) {
	if (!singleton) return;
	const frame = { type: 'event', event, payload };
	singleton.__forwardToServer(frame);
	singleton.webrtcPeer?.broadcast(frame); /* c8 ignore -- ?. fallback */
}
