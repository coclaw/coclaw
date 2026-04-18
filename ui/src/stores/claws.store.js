import { defineStore } from 'pinia';

import { useClawConnections } from '../services/claw-connection-manager.js';
import { useSignalingConnection } from '../services/signaling-connection.js';
import { BRIEF_DISCONNECT_MS } from '../services/claw-connection.js';
import { checkPluginVersion } from '../utils/plugin-version.js';
import { initRtc, closeRtcForClaw } from '../services/webrtc-connection.js';
import { remoteLog } from '../services/remote-log.js';

// claw 生命周期回调（由 claw-lifecycle.js 注册，避免静态循环依赖）
const _lifecycle = {
	cleanupClawResources: () => {},
	syncDashboardOffline: () => {},
	loadDashboardForClaw: () => {},
	initClawResources: async () => {},
	refreshClawResources: () => {},
	dispatchAgentEvent: () => {},
};
/** @param {Partial<typeof _lifecycle>} hooks */
export function __registerClawLifecycleHooks(hooks) {
	Object.assign(_lifecycle, hooks);
}

// 跟踪已桥接的 conn 实例（clawId → ClawConnection），避免重复注册
const _bridgedConns = new Map();
/** __ensureRtc 并发防护（clawId → true） */
const _rtcInitInProgress = new Map();
/** __checkAndRecover probe 并发防护（clawId → true） */
const _probeInProgress = new Map();
/** app 进入后台的时间戳（用于前台恢复时判断后台时长） */
let _backgroundAt = 0;

/**
 * 两层重试结构：
 * - 内层：__ensureRtc 每次调用内部循环 RTC_BUILD_MAX_RETRIES 次 initRtc
 * - 外层：__scheduleRetry 指数退避，最多 MAX_BACKOFF_RETRIES 轮
 * 理论最大 initRtc 调用次数 = 3 × 5 = 15。
 * 实际中 SSE 快照、用户操作、前台恢复等外部事件也会触发重连，
 * 退避重试仅作为兜底机制。
 */
const RTC_BUILD_MAX_RETRIES = 3;
/** DC probe 超时 */
const DC_PROBE_TIMEOUT_MS = 3_000;
/**
 * 短后台阈值：后台时长 < 此值时跳过 probe，信任 ICE 自恢复。
 * OS 给 app 约 5s 收尾，30s consent 超时 → 25s 以内挂起不超过 20s，
 * ICE 层仍有 ~10s 裕量自恢复（约 2 次 consent check 机会）。
 */
const SHORT_BACKGROUND_MS = 25_000;
/** 退避重试：初始间隔 */
const RETRY_BACKOFF_BASE_MS = 3_000;
/** 退避重试：最大间隔 */
const RETRY_BACKOFF_MAX_MS = 120_000;
/** 退避重试：最大次数（兜底性质，外部事件通常更早触发重连） */
export const MAX_BACKOFF_RETRIES = 5;
/** 退避重试状态（clawId → { count: number, timer: number|null }） */
const _rtcRetryState = new Map();
/** 运行时字段（server snapshot / SSE 事件不应覆盖） */
const RUNTIME_FIELDS = new Set([
	'dcReady', 'rtcPhase', 'lastAliveAt', 'disconnectedAt',
	'initialized', 'pluginVersionOk', 'pluginInfo', 'rtcTransportInfo',
	'rtcPeerTransportInfo',
	'retryCount', 'retryNextAt',
]);

/** 重置模块级状态（logout / 测试） */
export function __resetClawStoreInternals() {
	_bridgedConns.clear();
	_rtcInitInProgress.clear();
	_probeInProgress.clear();
	for (const state of _rtcRetryState.values()) clearTimeout(state.timer);
	_rtcRetryState.clear();
	_backgroundAt = 0;
}
// 保留旧名兼容测试导入
export { __resetClawStoreInternals as __resetAwaitingConnIds };

/**
 * 创建 per-claw 聚合状态对象
 * @param {object} claw - 基础 claw 信息
 * @returns {object}
 */
function createClawState(claw) {
	return {
		// 基础信息（HTTP 源）
		id: String(claw.id),
		name: claw.name ?? null,
		online: Boolean(claw.online),
		lastSeenAt: claw.lastSeenAt ?? null,
		createdAt: claw.createdAt ?? null,
		updatedAt: claw.updatedAt ?? null,
		// RTC 生命周期
		rtcPhase: 'idle', // 'idle' | 'building' | 'ready' | 'restarting' | 'recovering' | 'failed'
		lastAliveAt: 0,
		disconnectedAt: 0,
		// 初始化标记（首次 vs 重连）
		initialized: false,
		// 插件状态（运行时写入）
		pluginVersionOk: null,
		pluginInfo: null,
		rtcTransportInfo: null,
		// plugin 本端 transport（含 relayProtocol），通过 coclaw.rtc.peerTransport 事件更新
		rtcPeerTransportInfo: null,
		dcReady: false,
		// 退避重试（UI 可读）
		retryCount: 0,
		retryNextAt: 0, // timestamp (ms)，0 = 无计划
	};
}

export const useClawsStore = defineStore('claws', {
	state: () => ({
		byId: {},
		/** applySnapshot 至少成功完成过一次 */
		fetched: false,
	}),
	getters: {
		/** 列表视图（供列表渲染和遍历用） */
		items: (state) => Object.values(state.byId),
	},
	actions: {
		setClaws(items) {
			const arr = Array.isArray(items) ? items : [];
			const newById = {};
			for (const claw of arr) {
				const id = String(claw.id ?? '');
				if (!id) continue;
				newById[id] = this.byId[id]
					? { ...this.byId[id], ...claw, id }
					: createClawState(claw);
			}
			this.byId = newById;
		},
		addOrUpdateClaw(claw) {
			if (!claw?.id) return;
			const id = String(claw.id);
			console.debug('[claws] upsert id=%s', id);
			remoteLog(`claw.upsert claw=${id}`);
			if (this.byId[id]) {
				// 更新已有 claw（保留运行时状态，跳过 server 不应覆盖的字段）
				const existing = this.byId[id];
				for (const [k, v] of Object.entries(claw)) {
					if (k === 'id' || RUNTIME_FIELDS.has(k)) continue;
					existing[k] = v;
				}
			} else {
				this.byId[id] = createClawState(claw);
			}
			const manager = useClawConnections();
			manager.connect(id);
			this.__bridgeConn(id);
		},
		updateClawOnline(clawId, online) {
			const id = String(clawId);
			const claw = this.byId[id];
			if (!claw) return;
			const prev = claw.online;
			const next = Boolean(online);
			if (prev !== next) {
				console.debug('[claws] online %s→%s id=%s', prev, next, id);
				remoteLog(`claw.online ${prev}→${next} claw=${id}`);
			}
			claw.online = next;
			if (!next) {
				// agents / dashboard 缓存保留：离线时不清除，重连后由对应 load 替换
				_lifecycle.syncDashboardOffline(id);
				// SSE presence 仅是展示信号，不毒化 DC 状态（详见通信模型 §5.5）。
				// 轻触发 DC 自检：若 DC 健在，probe 会成功无副作用；若 DC 实际已坏，
				// 能在秒级拉起 ICE restart / rebuild，避免等浏览器 consent 超时（~20-35s）。
				this.__checkAndRecover(id, 'sse_offline').catch(() => {});
			} else if (!claw.initialized) {
				// claw 上线且未初始化 → fullInit（ensureConnected 内部处理 WS）
				claw.initialized = true;
				const conn = useClawConnections().get(id);
				if (conn) {
					const attempt = claw.__initAttempt = (claw.__initAttempt || 0) + 1;
					this.__fullInit(id, conn).catch((err) => {
						if (claw.__initAttempt === attempt) claw.initialized = false;
						console.warn('[claws] fullInit failed for clawId=%s: %s', id, err?.message);
					});
				}
			} else if (prev === false) {
				// claw offline→online → 恢复 RTC（外部事件，重置退避）
				// RTC 就绪后刷新 dashboard（覆盖 DC 未断 + DC 重建两种场景）
				this.__clearRetry(id);
				this.__ensureRtc(id)
					.then(() => _lifecycle.loadDashboardForClaw(id))
					.catch(() => {});
			}
		},
		removeClawById(clawId) {
			console.debug('[claws] remove id=%s', clawId);
			remoteLog(`claw.removed claw=${clawId}`);
			const id = String(clawId ?? '');
			closeRtcForClaw(id);
			useClawConnections().disconnect(id);
			_lifecycle.cleanupClawResources(id);
			this.__clearRetry(id);
			_bridgedConns.delete(id);
			delete this.byId[id];
		},
		/**
		 * 应用 SSE 推送的全量 claw 快照
		 * @param {object[]} items - server 推送的 claw 列表
		 */
		applySnapshot(items) {
			const arr = Array.isArray(items) ? items : [];
			const newById = {};
			for (const b of arr) {
				const id = String(b.id ?? '');
				if (!id) continue;
				const existing = this.byId[id];
				if (existing) {
					// 保留运行时状态（server snapshot 不应覆盖这些字段）
					const runtime = {};
					for (const k of RUNTIME_FIELDS) runtime[k] = existing[k];
					Object.assign(existing, b, { id }, runtime);
					newById[id] = existing;
				} else {
					newById[id] = createClawState({ ...b, id });
				}
			}
			// 清理快照中不再存在的 claw（RTC、sessions、agentRuns）
			for (const oldId of Object.keys(this.byId)) {
				if (!newById[oldId]) {
					closeRtcForClaw(oldId);
					_lifecycle.cleanupClawResources(oldId);
					this.__clearRetry(oldId);
					_bridgedConns.delete(oldId);
				}
			}
			this.byId = newById;
			this.fetched = true;
			console.debug('[claws] snapshot applied %d claw(s)', arr.length);
			remoteLog(`claw.snapshot count=${arr.length}`);

			const clawIds = arr.map((b) => String(b.id));
			const manager = useClawConnections();
			manager.syncConnections(clawIds);
			for (const id of clawIds) {
				this.__bridgeConn(id);
			}
			// server 重启后 RTC 内部重建可能已耗尽 → rtcPhase='failed'
			// 新快照到达时为这些 claw 重新尝试（持续维护 gate 不看 online）
			for (const id of clawIds) {
				const claw = this.byId[id];
				if (claw?.initialized && claw.rtcPhase === 'failed') {
					this.__clearRetry(id); // 外部事件，重置退避
					this.__ensureRtc(id).catch(() => {});
				}
			}
		},

		/**
		 * 注册全局信令事件桥接（仅注册一次）
		 * WS state 事件不消费——WS 仅是信令通道，其断连不影响 DC 可用性
		 */
		__bridgeSignaling() {
			if (this.__signalingBridged) return;
			this.__signalingBridged = true;
			const sigConn = useSignalingConnection();

			// 记录进入后台时间戳（用于前台恢复时判断后台时长）
			if (typeof window !== 'undefined') {
				window.addEventListener('app:background', () => { _backgroundAt = Date.now(); });
			}

			// RTC 恢复决策完全基于 PC 自身状态，不依赖 WS 指标。
			// network:online 分级处理（restart-first）：
			//   - restarting → nudge（立即重试 restart offer）
			//   - connected + typeChanged → triggerRestart（主动 ICE restart）
			//   - failed/closed → rebuild（restart 失败后的 fallback）
			//   - 其余 → 跳过（ICE 有自检测能力）
			// app:foreground 走 probe 路径（OS 挂起导致 ICE 回调积压，PC 状态不可信）。
			sigConn.on('foreground-resume', ({ source, typeChanged }) => {
				if (source === 'network:online') {
					this.__handleNetworkOnline(typeChanged);
					return;
				}
				// 短后台（<25s）：ICE 自恢复能力充足，无需 probe
				if (source === 'app:foreground' && _backgroundAt > 0) {
					const bgDuration = Date.now() - _backgroundAt;
					if (bgDuration < SHORT_BACKGROUND_MS) {
						remoteLog(`claw.skipProbe bgDuration=${bgDuration}ms`);
						return;
					}
				}
				for (const id of Object.keys(this.byId)) {
					this.__checkAndRecover(id, source);
				}
			});
		},

		/**
		 * 桥接 DC 事件（每个 conn 实例只注册一次）
		 */
		__bridgeConn(clawId) {
			const conn = useClawConnections().get(clawId);
			if (!conn) return;
			if (_bridgedConns.get(clawId) === conn) return;
			_bridgedConns.set(clawId, conn);

			const id = String(clawId);

			// 注入连接就绪等待所需的回调
			conn.__onGetRtcPhase = () => this.byId[id]?.rtcPhase ?? 'idle';
			conn.__onTriggerReconnect = () => {
				this.__clearRetry(id);
				this.__ensureRtc(id).catch(() => {});
			};

			// event:agent DC 事件桥接
			conn.on('event:agent', (payload) => {
				_lifecycle.dispatchAgentEvent(payload);
			});

			// event:coclaw.info.updated — claw 实例名变更（来自 plugin 广播）
			conn.on('event:coclaw.info.updated', (payload) => {
				const claw = this.byId[id];
				if (!claw) return;
				if (!claw.pluginInfo) claw.pluginInfo = {};
				if (payload?.name !== undefined) claw.pluginInfo.name = payload.name;
				if (payload?.hostName !== undefined) claw.pluginInfo.hostName = payload.hostName;
			});

			// event:coclaw.rtc.peerTransport — plugin 本端 ICE candidate 信息（含 relayProtocol）
			// 用于展示双端中继协议（浏览器↔coturn↔plugin）。与 rtcTransportInfo 字段分离，
			// 避免被 webrtc-connection.js 的 getStats 轮询整体 replace 覆盖。
			conn.on('event:coclaw.rtc.peerTransport', (payload) => {
				const claw = this.byId[id];
				if (!claw || !payload) return;
				claw.rtcPeerTransportInfo = {
					candidateType: payload.candidateType ?? 'unknown',
					protocol: String(payload.protocol ?? 'udp').toLowerCase(),
					relayProtocol: payload.relayProtocol
						? String(payload.relayProtocol).toLowerCase()
						: null,
				};
			});

			// 确保全局信令桥接已注册
			this.__bridgeSignaling();

			// 新 claw + online + 未初始化 → 启动 fullInit
			// 首次 init 用 SSE presence 作启动先验：建连成本不低（ICE gathering、
			// TURN 协商、一轮 signaling），明确离线时不白跑。持续维护（__ensureRtc
			// 循环、__scheduleRetry、__handleNetworkOnline）则不看 online，由 PC
			// 自身状态驱动。详见通信模型 §5.5。
			const claw = this.byId[clawId];
			if (claw && claw.online && !claw.initialized) {
				claw.initialized = true;
				const attempt = claw.__initAttempt = (claw.__initAttempt || 0) + 1;
				this.__fullInit(clawId, conn).catch((err) => {
					if (claw.__initAttempt === attempt) claw.initialized = false;
					console.warn('[claws] fullInit failed for clawId=%s: %s', clawId, err?.message);
				});
			}
		},

		/** 构建 RTC 回调（store 侧状态同步） */
		__rtcCallbacks(clawId) {
			return {
				onRtcStateChange: (state, transportInfo) => {
					const claw = this.byId[clawId];
					if (!claw) return;
					if (transportInfo) claw.rtcTransportInfo = transportInfo;
					if (state === 'connected') {
						const conn = useClawConnections().get(clawId);
						if (conn?.rtc?.isReady) {
							const wasDisconnected = !claw.dcReady;
							claw.dcReady = true;
							claw.rtcPhase = 'ready';
							if (wasDisconnected) this.__refreshIfStale(clawId);
						}
					} else if (state === 'restarting') {
						claw.rtcPhase = 'restarting';
						claw.disconnectedAt = claw.disconnectedAt || Date.now();
					} else if (state === 'failed' || state === 'closed') {
						claw.dcReady = false;
						claw.disconnectedAt = Date.now();
						claw.rtcPhase = 'failed';
						// plugin 侧 transport 信息失效；新连接建立后 plugin 会重新推送
						claw.rtcPeerTransportInfo = null;
						// 被动失败（非 __ensureRtc 主动管理）→ 启动退避重试
						if (!_rtcInitInProgress.get(clawId)) {
							this.__scheduleRetry(clawId);
						}
					}
				},
			};
		},

		/** 数据刷新（RTC 恢复后，断连间隔较长时触发） */
		__refreshIfStale(id) {
			const claw = this.byId[id];
			if (!claw?.initialized || claw.disconnectedAt <= 0) return;
			const gap = Date.now() - claw.disconnectedAt;
			claw.disconnectedAt = 0;
			if (gap < BRIEF_DISCONNECT_MS) return;
			console.debug('[claws] reconnect gap=%dms → refresh stores clawId=%s', gap, id);
			// 刷新 pluginInfo（含 claw name）
			const conn = useClawConnections().get(id);
			if (conn) {
				checkPluginVersion(conn).then((info) => {
					const b = this.byId[id];
					if (b) {
						b.pluginVersionOk = info.ok;
						b.pluginInfo = { version: info.version, clawVersion: info.clawVersion, name: info.name, hostName: info.hostName };
					}
				}).catch(() => {});
			}
			_lifecycle.refreshClawResources(id);
		},

		/**
		 * 统一 RTC 建立/恢复入口。
		 * 触发点：claw offline→online、__bridgeConn 首次初始化、probe 失败。
		 * @param {string} id - clawId
		 * @param {object} [opts]
		 * @param {boolean} [opts.forceRebuild] - 跳过 connected 检查，强制 rebuild
		 */
		async __ensureRtc(id, { forceRebuild = false } = {}) {
			if (_rtcInitInProgress.get(id)) return;
			_rtcInitInProgress.set(id, true);

			const conn = useClawConnections().get(id);
			if (!conn) { _rtcInitInProgress.delete(id); return; }

			try {
				const rtc = conn.rtc;
				// RTC 已连接且健康（非强制 rebuild）→ 确保 dcReady
				if (!forceRebuild && rtc && rtc.state === 'connected') {
					const claw = this.byId[id];
					if (claw && rtc.isReady) {
						claw.dcReady = true;
						claw.rtcPhase = 'ready';
					}
					return;
				}

				// 设置阶段：已就绪/强制重建 → recovering；否则 → building
				const claw = this.byId[id];
				if (claw) {
					claw.rtcPhase = (claw.rtcPhase === 'ready' || forceRebuild)
						? 'recovering' : 'building';
				}

				// 释放旧 RTC → rebuild
				closeRtcForClaw(id);
				conn.clearRtc();

				let result = 'failed';
				let bailedOut = false;
				for (let i = 0; i < RTC_BUILD_MAX_RETRIES; i++) {
					if (!this.byId[id]) {
						console.debug('[claws] ensureRtc: bail-out (claw removed) clawId=%s', id);
						bailedOut = true;
						break;
					}
					result = await initRtc(id, conn, this.__rtcCallbacks(id));
					if (result === 'rtc') break;
					console.debug('[claws] ensureRtc: build attempt %d/%d failed clawId=%s', i + 1, RTC_BUILD_MAX_RETRIES, id);
				}

				if (result === 'rtc') {
					const claw = this.byId[id];
					if (claw) {
						claw.dcReady = true;
						claw.rtcPhase = 'ready';
					}
					this.__clearRetry(id);
					this.__refreshIfStale(id);
					remoteLog(`claw.rtcReady claw=${id}`);
				} else if (bailedOut) {
					// bail-out 唯一触发条件是 this.byId[id] 已被删除，无对象可写 phase
					remoteLog(`claw.rtcBailOut claw=${id}`);
				} else {
					const claw = this.byId[id];
					if (claw) claw.rtcPhase = 'failed';
					console.warn('[claws] ensureRtc: all attempts exhausted, claw unreachable clawId=%s', id);
					remoteLog(`claw.rtcFailed claw=${id} retries=${RTC_BUILD_MAX_RETRIES}`);
					this.__scheduleRetry(id);
				}
			} finally {
				_rtcInitInProgress.delete(id);
			}
		},

		/**
		 * 首次连接初始化：建立 RTC → 版本检查 → 数据加载
		 * 所有业务 RPC 通过 DC 发送，因此必须先等 RTC 就绪
		 */
		async __fullInit(id, conn) {
			remoteLog(`claw.fullInit claw=${id}`);
			const claw = this.byId[id];
			// race: claw 在 init 过程中被移除（调用方 catch 会回退 initialized）
			if (!claw) throw new Error('Claw removed during init');

			// 等待 RTC 建立（DC 是唯一的 RPC 通道）
			await this.__ensureRtc(id);
			if (!conn.rtc?.isReady) throw new Error('RTC not available');
			if (claw) claw.dcReady = true;

			// DC 就绪，后续 RPC 走 DataChannel
			const info = await checkPluginVersion(conn);
			if (claw) {
				claw.pluginVersionOk = info.ok;
				claw.pluginInfo = { version: info.version, clawVersion: info.clawVersion, name: info.name, hostName: info.hostName };
			}
			remoteLog(`claw.pluginVersion claw=${id} ok=${info.ok} v=${info.version || '?'}`);
			if (!info.ok) {
				console.warn('[claws] plugin version %s for clawId=%s', info.version ? 'outdated' : 'check failed (claw may be offline)', id);
				if (!info.version) throw new Error('Claw is offline');
			}
			await _lifecycle.initClawResources(id);
		},

		/** 安排退避重试（__ensureRtc 失败或被动失败后调用） */
		__scheduleRetry(id) {
			const claw = this.byId[id];
			if (!claw) return;
			let state = _rtcRetryState.get(id);
			if (!state) {
				state = { count: 0, timer: null };
				_rtcRetryState.set(id, state);
			}
			state.count++;
			if (state.count > MAX_BACKOFF_RETRIES) {
				console.warn('[claws] backoff retries exhausted (%d) clawId=%s', MAX_BACKOFF_RETRIES, id);
				remoteLog(`claw.retryExhausted claw=${id} max=${MAX_BACKOFF_RETRIES}`);
				_rtcRetryState.delete(id);
				if (claw) { claw.retryCount = 0; claw.retryNextAt = 0; }
				return;
			}
			const delay = Math.min(
				RETRY_BACKOFF_BASE_MS * 2 ** (state.count - 1),
				RETRY_BACKOFF_MAX_MS,
			);
			clearTimeout(state.timer);
			if (claw) { claw.retryCount = state.count; claw.retryNextAt = Date.now() + delay; }
			console.debug('[claws] scheduling backoff retry %d/%d in %dms clawId=%s',
				state.count, MAX_BACKOFF_RETRIES, delay, id);
			remoteLog(`claw.retryScheduled claw=${id} attempt=${state.count}/${MAX_BACKOFF_RETRIES} delay=${delay}ms`);
			state.timer = setTimeout(() => {
				state.timer = null;
				if (!this.byId[id] || this.byId[id]?.rtcPhase !== 'failed') {
					this.__clearRetry(id);
					return;
				}
				this.__ensureRtc(id).catch(() => {});
			}, delay);
		},

		/** 清除退避重试（成功 / claw 离线 / 外部事件重置时调用） */
		__clearRetry(id) {
			const state = _rtcRetryState.get(id);
			if (!state) return;
			clearTimeout(state.timer);
			_rtcRetryState.delete(id);
			const claw = this.byId[id];
			if (claw) { claw.retryCount = 0; claw.retryNextAt = 0; }
		},

		/**
		 * network:online 分级处理（restart-first）。
		 * - restarting → nudge（立即重试 restart offer）
		 * - connected + typeChanged → triggerRestart（WiFi↔cellular，主动 restart）
		 * - failed/closed → rebuild（restart 已失败，走 fallback）
		 * - 其余 → 跳过（ICE 有自检测能力）
		 * @param {boolean} typeChanged
		 */
		__handleNetworkOnline(typeChanged) {
			for (const id of Object.keys(this.byId)) {
				if (_rtcInitInProgress.get(id)) continue;
				const claw = this.byId[id];
				if (!claw?.initialized) continue;
				const conn = useClawConnections().get(id);
				const rtc = conn?.rtc;
				if (!rtc) continue;

				if (rtc.state === 'restarting') {
					rtc.nudgeRestart();
					continue;
				}
				if (rtc.state === 'connected' && typeChanged) {
					remoteLog(`claw.recover claw=${id} reason=network_type_changed source=network:online`);
					rtc.triggerRestart('network_type_changed');
					continue;
				}
				if (rtc.state === 'failed' || rtc.state === 'closed') {
					remoteLog(`claw.recover claw=${id} reason=rtc_${rtc.state} source=network:online`);
					claw.rtcPhase = 'recovering';
					this.__clearRetry(id);
					this.__ensureRtc(id).catch(() => {});
				}
			}
		},

		/**
		 * DC 健康检查 + 恢复（前台恢复时调用，network:online 和短后台已在上层过滤）
		 *
		 * 决策完全基于 PC 自身状态和 DC probe，不依赖 WS 指标。
		 * probe 失败后二次确认 PC.connectionState，避免因 plugin 繁忙
		 * （如大文件写入阻塞 event loop）导致的误判。
		 *
		 * 契约：此函数永不抛异常——所有路径由 try/catch 兜底。调用方可安全 fire-and-forget。
		 * 若未来扩展此函数，新增代码必须置于 try 块内以维持该契约。
		 *
		 * @param {string} id - clawId
		 * @param {string} [source] - 触发来源
		 */
		async __checkAndRecover(id, source) {
			try {
				if (_rtcInitInProgress.get(id)) return;
				if (_probeInProgress.get(id)) return;
				const claw = this.byId[id];
				if (!claw?.dcReady) return;
				const conn = useClawConnections().get(id);
				const rtc = conn?.rtc;
				if (!rtc) return;

				// restarting → nudge 立即重试
				if (rtc.state === 'restarting') {
					rtc.nudgeRestart();
					return;
				}

				// PC 已明确不可用 → 直接 rebuild（restart 已失败）
				if (rtc.state === 'failed' || rtc.state === 'closed') {
					remoteLog(`claw.recover claw=${id} reason=rtc_${rtc.state} source=${source}`);
					claw.rtcPhase = 'recovering';
					this.__clearRetry(id);
					this.__ensureRtc(id).catch(() => {});
					return;
				}

				// PC disconnected → ICE 正在自恢复，不干预。
				// WebRtcConnection 内部 5s 超时后升级到 ICE restart，
				// 届时由 __rtcCallbacks.onRtcStateChange 同步 rtcPhase。
				if (rtc.state === 'disconnected') {
					remoteLog(`claw.recover claw=${id} reason=rtc_disconnected source=${source} action=wait_ice`);
					return;
				}

				// PC connected → probe DC 验证端到端可达性
				_probeInProgress.set(id, true);
				let alive;
				try {
					alive = await rtc.probe(DC_PROBE_TIMEOUT_MS);
				} finally {
					_probeInProgress.delete(id);
				}
				if (alive || !this.byId[id]) return;

				// probe 失败 → 二次确认 PC 状态。
				// 如果 PC 仍为 connected，说明 ICE 层认为链路健康，
				// 可能是 plugin 繁忙（如大文件写入）导致 probe-ack 延迟，不 rebuild。
				const rtcAfter = conn?.rtc;
				if (rtcAfter && rtcAfter.state === 'connected') {
					remoteLog(`claw.recover claw=${id} reason=probe_timeout_pc_connected action=skip`);
					return;
				}

				// PC 在 probe 等待期间已变为非 connected → 触发 ICE restart
				remoteLog(`claw.recover claw=${id} reason=probe_failed pc=${rtcAfter?.state ?? 'null'}`);
				if (rtcAfter) rtcAfter.triggerRestart('probe_failed');
			} catch (err) {
				console.warn('[claws] checkAndRecover failed clawId=%s: %s', id, err?.message);
			}
		},
	},
});

