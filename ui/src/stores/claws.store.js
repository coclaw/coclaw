import { defineStore } from 'pinia';

import { useClawConnections } from '../services/claw-connection-manager.js';
import { BRIEF_DISCONNECT_MS } from '../services/claw-connection.js';
import { checkPluginVersion } from '../utils/plugin-version.js';
import { initRtc, closeRtcForClaw } from '../services/webrtc-connection.js';
import { remoteLog } from '../services/remote-log.js';
import { useSignalingConnection } from '../services/signaling-connection.js';

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
/**
 * 等待 rebuild 真正完成后触发 force refresh 的 clawId 集合。
 *
 * 背景：`__resumeOnline` 在 rebuild 分支（rtc null / failed / closed / idle / connecting）
 * 下不能立即 force refresh——loader 的 `getReadyConn` 会被 `dcReady=false` gate 全 skip。
 * 必须等 rebuild 真正完成（`__ensureRtc` 内部写 dcReady=true）后再 force refresh。
 *
 * 但 `__ensureRtc` 入口有 `_rtcInitInProgress` 早退守卫，`.then` 可能在 in-progress
 * rebuild 完成前触发；且退避重试链下 rebuild 可能跨多次 `__ensureRtc` 调用才最终成功。
 * 单凭 `.then` 时机不足以可靠捕获"rebuild 真正完成"事件。
 *
 * 解法：`__resumeOnline` 在 rebuild 分支 add id 到 Set；任何 `__ensureRtc` 成功路径
 * 都 consume 这个标记（若存在则 delete + force=true 调 `__refreshIfStale`）。
 * `removeClawById` 负责清理。
 */
const _pendingForceRefreshOnRebuild = new Set();
/** app 进入后台的时间戳（用于前台恢复时判断后台时长） */
let _backgroundAt = 0;
/** 生命周期事件 window handler 引用（用于测试场景下清理旧 store 的注册） */
let _lifecycleHandlers = null;
/**
 * 生命周期 window 监听器是否已挂载。
 * 必须用模块级变量（非 store 实例字段），否则 logout 时 `$reset()` 只清 state，
 * 这个标记会残留在 store 实例上，重新登录时 `__bridgeLifecycle` 直接短路返回，
 * 监听器永不再挂，`app:foreground` / `network:online` 驱动的 RTC 恢复全部失效。
 */
let _lifecycleBridged = false;
/**
 * 信令 WS 不通时的冻结闸（与 claw.online 并列的第二把锁）。
 * 为 true 时所有 RTC 主动恢复动作（restart / rebuild / retry 调度）被阻断。
 * 判据：`sig.state !== 'connected'`（connecting 也算——`__sendRaw` 需要 readyState=1）。
 * 必须 module-level：logout 时 $reset() 不清模块变量，清理由 __resetClawStoreInternals 负责。
 */
let _sigOffline = false;
/** 进入 sig offline 的时间戳，用于 resume 时输出冻结时长（生产诊断 WS 闪断 vs 长时间失联） */
let _sigOfflineAt = 0;
/**
 * typeChanged restart 记账标记（模块级布尔）。
 * sig 不通时 `network:online(typeChanged=true)` 无法发 offer；记下此标记，
 * sig 恢复时在 `__resumeAllClawsForSigOnline` 里升级恢复策略：
 * `connected+paused` 的 claw 从 `resumeRecovery()` 改为 `triggerRestart('online_resume')`。
 * 整轮 sig down/up 里最多一次 typeChanged → per-claw Set 无必要。
 */
let _pendingTypeChangedRestart = false;

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
	_pendingForceRefreshOnRebuild.clear();
	_backgroundAt = 0;
	_sigOffline = false;
	_sigOfflineAt = 0;
	_pendingTypeChangedRestart = false;
	if (_lifecycleHandlers && typeof window !== 'undefined') {
		window.removeEventListener('app:background', _lifecycleHandlers.bg);
		window.removeEventListener('network:online', _lifecycleHandlers.net);
		window.removeEventListener('app:foreground', _lifecycleHandlers.fg);
		if (_lifecycleHandlers.sigState) {
			try { useSignalingConnection().off('state', _lifecycleHandlers.sigState); }
			catch (err) { console.debug('[claws] reset sig off failed: %s', err?.message); }
		}
	}
	_lifecycleHandlers = null;
	_lifecycleBridged = false;
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
		/**
		 * 至少一个 online claw 正在 RTC 建立/恢复中。
		 * 覆盖 building / recovering / restarting，以及 failed 且排着退避重试的 claw。
		 * 仅统计 online claw——离线 claw 的 RTC 状态用户不关心。
		 */
		isConnectingRtc: (state) => {
			const active = new Set(['building', 'recovering', 'restarting']);
			for (const c of Object.values(state.byId)) {
				if (!c.online) continue;
				if (active.has(c.rtcPhase)) return true;
				if (c.rtcPhase === 'failed' && c.retryNextAt > 0) return true;
			}
			return false;
		},
		/**
		 * 重试已耗尽、仍不可达的 online claw 列表。
		 * 语义：rtcPhase='failed' 且 retryNextAt=0 表示系统已放弃退避重试，
		 * 只能靠 network:online / SSE 快照 / 用户手动点击来唤醒。
		 */
		unreachableClaws: (state) => Object.values(state.byId)
			.filter((c) => c.online && c.rtcPhase === 'failed' && c.retryNextAt === 0),
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
				// claw offline：暂停所有 RTC 主动恢复动作，PC 保留，退避定时器清零。
				// agents / dashboard 缓存保留：离线时不清除，重连后由对应 load 替换。
				this.__handleClawGoOffline(id);
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
				// claw offline→online → 按 PC 状态分派恢复路径（restart / rebuild / noop）
				this.__resumeOnline(id);
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
			_pendingForceRefreshOnRebuild.delete(id);
			delete this.byId[id];
		},
		/**
		 * 应用 SSE 推送的全量 claw 快照
		 * @param {object[]} items - server 推送的 claw 列表
		 */
		applySnapshot(items) {
			const arr = Array.isArray(items) ? items : [];
			const newById = {};
			// Phase 1: 快照 apply 前先记录每个已有 claw 的 online 值，供 Phase 3 diff
			const prevOnlineMap = new Map();
			for (const b of arr) {
				const id = String(b.id ?? '');
				if (!id) continue;
				const existing = this.byId[id];
				if (existing) {
					prevOnlineMap.set(id, existing.online);
					// Phase 2: 保留运行时状态（server snapshot 不应覆盖这些字段）
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
					_pendingForceRefreshOnRebuild.delete(oldId);
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
			// Phase 3: 按 online 转换 + failed 兜底分派动作（覆盖 SSE 断连重连场景）
			// - online true→false：走 __handleClawGoOffline 暂停恢复
			// - online false→true 且已 initialized：走 __resumeOnline 按 PC 状态分派
			// - online 未变但 rtcPhase='failed'：server 重启导致 RTC 内部重试耗尽，也走 resume
			const toResume = new Set();
			for (const id of clawIds) {
				const claw = this.byId[id];
				if (!claw?.initialized) continue;
				const prev = prevOnlineMap.get(id);
				if (prev === true && claw.online === false) {
					this.__handleClawGoOffline(id);
				} else if (prev === false && claw.online === true) {
					toResume.add(id);
				} else if (claw.online && claw.rtcPhase === 'failed') {
					toResume.add(id);
				}
			}
			for (const id of toResume) this.__resumeOnline(id);
		},

		/**
		 * 注册全局生命周期事件桥接（仅注册一次）
		 *
		 * 监听 window 事件 + 信令 WS state。RTC 恢复决策主要基于 PC 自身状态，
		 * sig state 仅作为"主动恢复动作"的全局闸（与 claw.online 并列的第二把锁）：
		 * - network:online 分级处理（restart-first）：见 __handleNetworkOnline。
		 * - app:foreground 走 probe 路径（OS 挂起导致 ICE 回调积压，PC 状态不可信）；
		 *   短后台（<25s）信任 ICE 自恢复。
		 * - sig.state 翻转：非 connected → 冻结所有 claw 的预算和退避；
		 *   connected 回来 → 按 claw online 分派恢复（详见 §5.5.1）。
		 *
		 * 测试场景下 pinia 会为每个用例创建新 store 实例：此处若检测到已有注册
		 * （来自前一实例），先移除再重新注册，避免多 store 共存时的事件分发污染。
		 */
		__bridgeLifecycle() {
			if (_lifecycleBridged) return;
			_lifecycleBridged = true;
			if (typeof window === 'undefined') return;

			if (_lifecycleHandlers) {
				window.removeEventListener('app:background', _lifecycleHandlers.bg);
				window.removeEventListener('network:online', _lifecycleHandlers.net);
				window.removeEventListener('app:foreground', _lifecycleHandlers.fg);
				if (_lifecycleHandlers.sigState) {
					try { useSignalingConnection().off('state', _lifecycleHandlers.sigState); }
					catch (err) { console.debug('[claws] bridge sig off (prev) failed: %s', err?.message); }
				}
			}

			const bg = () => { _backgroundAt = Date.now(); };
			const net = (e) => {
				const typeChanged = Boolean(e?.detail?.typeChanged);
				this.__handleNetworkOnline(typeChanged);
			};
			const fg = () => {
				// 短后台（<25s）：ICE 自恢复能力充足，无需 probe
				if (_backgroundAt > 0) {
					const bgDuration = Date.now() - _backgroundAt;
					if (bgDuration < SHORT_BACKGROUND_MS) {
						remoteLog(`claw.skipProbe bgDuration=${bgDuration}ms`);
						return;
					}
				}
				for (const id of Object.keys(this.byId)) {
					this.__checkAndRecover(id, 'app:foreground');
				}
			};
			const sigState = (newState) => {
				// 幂等去重：forceReconnect 会同步派发 disconnected→connecting 两次；
				// 仅在 _sigOffline 真翻转时才触发 freeze / resume
				const shouldBeOffline = newState !== 'connected';
				if (shouldBeOffline === _sigOffline) return;
				_sigOffline = shouldBeOffline;
				try {
					if (shouldBeOffline) {
						_sigOfflineAt = Date.now();
						this.__freezeAllClawsForSigOffline();
					} else {
						const duration = _sigOfflineAt > 0 ? Date.now() - _sigOfflineAt : 0;
						_sigOfflineAt = 0;
						this.__resumeAllClawsForSigOnline(duration);
					}
				} catch (err) {
					console.warn('[claws] sig state handler failed state=%s: %s', newState, err?.message);
					remoteLog(`claw.sigHandlerError state=${newState} msg=${err?.message ?? 'unknown'}`);
				}
			};

			_lifecycleHandlers = { bg, net, fg, sigState };
			window.addEventListener('app:background', bg);
			window.addEventListener('network:online', net);
			window.addEventListener('app:foreground', fg);

			// sig listener + 初态同步。sig.on 仅在状态**变更**时派发，不重放历史——
			// 订阅瞬间 listener 不会被触发，需主动读 sig.state 兜底初态。
			// 注：`on` 与 `sig.state` 之间同步代码无机会让 listener fire，所以此刻
			// `_sigOffline` 必然仍为 module-level 初值（或刚被 __resetClawStoreInternals 清零）。
			try {
				const sig = useSignalingConnection();
				sig.on('state', sigState);
				if (sig.state !== 'connected') {
					_sigOffline = true;
					_sigOfflineAt = Date.now();
					this.__freezeAllClawsForSigOffline();
				}
			} catch (err) {
				console.debug('[claws] bridge sig on failed: %s', err?.message);
			}
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

			// 确保全局生命周期桥接已注册
			this.__bridgeLifecycle();

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

		/**
		 * claw 转入 offline：暂停所有 RTC 主动恢复动作，PC/DC 生命周期不被 presence 污染。
		 *
		 * - `syncDashboardOffline`：dashboard 展示层同步为 offline（仅展示字段）
		 * - `__clearRetry`：取消排队中的退避重试定时器（offline 下 rebuild 也打不通）
		 * - `pauseRestart`：暂停所有 UI 主动恢复动作（无论 rtc.state）
		 *   - state='restarting'：停 restart timer/poll、清预算、epoch++
		 *   - state='connected'：停 keepalive、清 disconnected timer、epoch++（防止
		 *     keepalive probe 失败升级为 __onIceFailed → 空烧 restart 预算）
		 *
		 * **不动 `dcReady` / `rtcPhase` / `disconnectedAt`**：这些字段由 RTC 状态机
		 * （`onRtcStateChange` / `dc.onclose` / `__ensureRtc`）按真实 DC 状态维护。
		 * presence 写入它们会违背"两条通路独立"的通信模型（详见 §5.5 和 1ef6782）。
		 * 数据刷新由 `__resumeOnline` 入口显式 force refresh 触发，不依赖 dcReady 翻转。
		 *
		 * 触发点：`updateClawOnline(id, false)`、`applySnapshot` 检测到 online true→false。
		 */
		__handleClawGoOffline(id) {
			_lifecycle.syncDashboardOffline(id);
			this.__clearRetry(id);
			const conn = useClawConnections().get(id);
			if (conn?.rtc) {
				conn.rtc.pauseRestart();
			}
		},

		/**
		 * 信令 WS 不通：冻结所有 claw 的 ICE restart / rebuild 预算。
		 *
		 * 与 `__handleClawGoOffline` 的关键差异：
		 * - 不调 `syncDashboardOffline`——sig 不通时 claw presence 可能仍 online，
		 *   dashboard 不应联动成 offline
		 * - 不改 `claw.online` / `dcReady` / `rtcPhase` / `disconnectedAt`——sig 是环境故障，
		 *   不污染 presence 与 DC 生命周期维度（两把锁正交）
		 *
		 * 触发点：`__bridgeLifecycle` 的 sigState handler 在 sig.state 由 connected 翻非 connected 时调用。
		 */
		__freezeAllClawsForSigOffline() {
			// logout 时 $reset 把 fetched 清为 false：此时 sig.disconnect 的 state 事件
			// 可能仍触发本函数，但 byId 即将被清、listener 也将被卸——日志和遍历都是噪音
			if (!this.fetched) return;
			const ids = Object.keys(this.byId);
			if (ids.length === 0) return;
			remoteLog(`claw.sigOffline freezing count=${ids.length}`);
			for (const id of ids) {
				this.__clearRetry(id);
				const conn = useClawConnections().get(id);
				if (conn?.rtc) conn.rtc.pauseRestart();
			}
		},

		/**
		 * 信令 WS 恢复：按 claw.online 分派恢复动作。
		 *
		 * 仅对 `claw.online === true` 的 claw 调 `__resumeOnline`；offline claw 不动
		 * （等 SSE 推 online 时由 `updateClawOnline` / `applySnapshot` 路径接手）。
		 * `__resumeOnline` 入口 sig gate 保证 sig 已通才执行（两把锁协调核心）。
		 *
		 * 触发点：sigState handler 在 sig.state 由非 connected 翻 connected 时调用。
		 * @param {number} [duration] - sig offline 持续毫秒（sigState handler 计算后传入）
		 */
		__resumeAllClawsForSigOnline(duration = 0) {
			// 无论是否早退都消费清零，避免"sig up 时 fetched=false 不消费 → 未来某次 sig up
			// 时陈旧标记误升级为 triggerRestart"的 stale-signal 风险
			const forceRestart = _pendingTypeChangedRestart;
			_pendingTypeChangedRestart = false;
			if (!this.fetched) return;
			let resumedCount = 0;
			for (const id of Object.keys(this.byId)) {
				const claw = this.byId[id];
				if (!claw?.online) continue;
				if (!claw.initialized) {
					// 首启竞态补救：SSE snapshot 先到、sig 未连上时 __fullInit 被 sig gate
					// 拦过（__ensureRtc 入口早退 → 抛 'RTC not available' → catch 回滚
					// initialized=false）。sig 恢复时在此补跑（逻辑复刻 updateClawOnline 的
					// !initialized 分支）。
					const conn = useClawConnections().get(id);
					if (!conn) continue; // conn 未 bridged：本次跳过，等 __bridgeConn 就绪后由后续路径接手
					claw.initialized = true;
					const attempt = claw.__initAttempt = (claw.__initAttempt || 0) + 1;
					this.__fullInit(id, conn).catch((err) => {
						if (claw.__initAttempt === attempt) claw.initialized = false;
						console.warn('[claws] fullInit (sig resume) failed for clawId=%s: %s', id, err?.message);
					});
				} else {
					this.__resumeOnline(id, { forceRestartOnConnected: forceRestart });
				}
				resumedCount++;
			}
			if (resumedCount > 0) {
				remoteLog(`claw.sigOnline resumed count=${resumedCount} duration=${duration}ms force_restart=${forceRestart ? 1 : 0}`);
			}
		},

		/**
		 * claw 转入 online：按 PC 当前状态分派恢复路径 + 强制刷新业务数据。
		 *
		 * plugin 离线过（不管多短），UI 数据一定可能 stale——offline→online 事件本身
		 * 就是 refresh 的触发信号，不依赖 `dcReady` 翻转（presence 与 DC 生命周期解耦）。
		 *
		 * refresh 时机按 rtc.state 分派（关键）：
		 * - `connected` / `restarting` → **立即** force refresh：DC 预期可用（SCTP 多能跨 restart 存活），
		 *   loader 的 `getReadyConn` 不会被 dcReady gate 挡住
		 * - rebuild 路径（rtc 不存在 / `failed` / `closed` / `idle` / `connecting`）→ **延后**到 rebuild 成功后
		 *   force refresh：rebuild 前 dcReady=false，loader 会被 `getReadyConn` gate 全部 skip，
		 *   立即 refresh 是 no-op。必须等 `__ensureRtc` 里写 dcReady=true 后再刷
		 *
		 * 分派动作：
		 * - `restarting` + paused → `triggerRestart('online_resume')`（复用 PC + 新 90s 预算）
		 * - `restarting` + 非 paused → 已在正常 restart 循环，不重入
		 * - `connected` + paused → `resumeRecovery`（清 paused + 重启 keepalive；不发 ICE restart）
		 *   - 例外：`forceRestartOnConnected=true`（如 typeChanged 记账命中）→ 升级为
		 *     `triggerRestart('online_resume')`，因为旧 ICE 路径必已失效（WiFi↔蜂窝 IP 变）
		 * - 其余 → `__ensureRtc`（connected 早退 / rebuild）
		 *
		 * 触发点：`updateClawOnline(id, true)` prev=false、`applySnapshot` 检测到 online false→true
		 * 或持续 online 但 `rtcPhase='failed'`（server 重启兜底）、`__resumeAllClawsForSigOnline`。
		 *
		 * @param {string} id - clawId
		 * @param {object} [opts]
		 * @param {boolean} [opts.forceRestartOnConnected=false] - connected+paused 时强制 triggerRestart 而非 resumeRecovery
		 */
		__resumeOnline(id, { forceRestartOnConnected = false } = {}) {
			// 两把锁协调核心：sig 不通时不做任何恢复动作（等 sig 回来时由
			// __resumeAllClawsForSigOnline 遍历重调；或由 claw online 事件再次触发）
			if (_sigOffline) return;
			const conn = useClawConnections().get(id);
			if (!conn) return;
			this.__clearRetry(id);
			const rtc = conn.rtc;
			// 区分 DC 预期可用（立即刷）vs 需要 rebuild（延后刷）
			const canRefreshNow = rtc?.state === 'connected' || rtc?.state === 'restarting';
			if (canRefreshNow) {
				this.__refreshIfStale(id, { force: true });
			} else {
				// rebuild 路径：dcReady=false 时 loader 会被 getReadyConn gate skip，
				// 立即 force refresh 是 no-op。打标记，让任意一次 __ensureRtc 真正成功
				// （无论当前 call 还是退避链中的 call）时自动触发 force refresh。
				_pendingForceRefreshOnRebuild.add(id);
			}

			if (rtc?.state === 'restarting') {
				// 仅当 PC 处于 pauseRestart 冻结态时才 unstick；
				// 若已在正常 restart 循环中（非冻结），不重复 triggerRestart 避免 attemptCount 虚涨/重发 offer
				if (rtc.restartPaused) {
					rtc.triggerRestart('online_resume');
				}
				return;
			}
			if (rtc?.state === 'connected' && rtc.restartPaused) {
				if (forceRestartOnConnected) {
					// 网络类型变化 + sig 回来：旧 ICE 路径必然失效，走 restart 不走轻量 resume
					// 镜像 restarting+paused 路径，早退不 fall through
					rtc.triggerRestart('online_resume');
					return;
				}
				// connected 态从 pause 冻结恢复：仅清 paused 标志 + 重启 keepalive，
				// 不触发 ICE restart（PC 本身仍健康）
				rtc.resumeRecovery();
			}
			this.__ensureRtc(id)
				.then(() => _lifecycle.loadDashboardForClaw(id))
				.catch(() => {});
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
							if (wasDisconnected) {
								// dcReady 真翻转（如 rebuild / ICE restart 后 DC 首次就绪）
								// → 走 __refreshIfStale：内部按 gap 判断是否触发刷新，并清 disconnectedAt
								this.__refreshIfStale(clawId);
							} else {
								// ICE restart 成功但 DC 全程未断（SCTP 存活）：wasDisconnected=false，
								// 不刷数据（presence 未翻转；短 RTC 抖动不值得全量刷）。但 disconnectedAt
								// 是 onRtcStateChange('restarting') stamp 的，必须在这里清零，
								// 否则会在多次 restart 间累积最旧 stamp，污染后续 gap 判断。
								claw.disconnectedAt = 0;
							}
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

		/**
		 * 数据刷新（RTC 恢复后或 plugin presence 恢复后触发）
		 *
		 * 两种调用语义：
		 * - 默认（`force=false`）：RTC 层面断连恢复后的"顺便刷"——
		 *   看 `disconnectedAt` gap：< BRIEF_DISCONNECT_MS 跳过（浏览器短暂切后台 / 网络闪断
		 *   不值得全量刷），>= gap 门槛才刷。由 `onRtcStateChange('connected')` /
		 *   `__ensureRtc` rebuild 成功路径调用。
		 * - 强制（`force=true`）：plugin presence 变化后的"必须刷"——
		 *   跳过 gap 检查，只要 initialized 就刷。由 `__resumeOnline` 调用。
		 *   语义：plugin 真的离线过（不管多短），UI 数据一定 stale，不赌概率。
		 *
		 * 两种情况都会清 `disconnectedAt = 0`（避免后续重复触发）。
		 * @param {string} id - clawId
		 * @param {object} [opts]
		 * @param {boolean} [opts.force] - 跳过 BRIEF_DISCONNECT_MS 门槛
		 */
		__refreshIfStale(id, { force = false } = {}) {
			const claw = this.byId[id];
			if (!claw?.initialized) return;
			if (!force && claw.disconnectedAt <= 0) return;
			const gap = claw.disconnectedAt > 0 ? Date.now() - claw.disconnectedAt : 0;
			claw.disconnectedAt = 0;
			if (!force && gap < BRIEF_DISCONNECT_MS) return;
			console.debug('[claws] reconnect%s gap=%dms → refresh stores clawId=%s',
				force ? ' (force)' : '', gap, id);
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
			// sig gate：WS 不通时发不出 signaling，rebuild 必然卡死；sig 回来时由
			// __resumeAllClawsForSigOnline 遍历重试
			if (_sigOffline) return;
			// online gate：plugin 离线时 rebuild 必然失败，不浪费 ICE gathering / TURN 预算
			if (!this.byId[id]?.online) return;
			_rtcInitInProgress.set(id, true);

			const conn = useClawConnections().get(id);
			if (!conn) { _rtcInitInProgress.delete(id); return; }

			try {
				const rtc = conn.rtc;
				// RTC 已连接且健康（非强制 rebuild）→ 兜底同步 store 视图（dcReady / rtcPhase）。
				// wasDisconnected=true 表示 store 视图落后于真实 DC 状态
				// （onRtcStateChange 尚未 fire 或因某种竞态漏 fire 的 bug-correction 场景），
				// 视为 dcReady 隐式翻转，触发 __refreshIfStale 兜底刷业务数据。
				// connected-throughout-offline 场景下 dcReady 全程为 true，wasDisconnected=false，
				// 此分支不刷（由 __resumeOnline 入口的 force refresh 负责刷新）。
				if (!forceRebuild && rtc && rtc.state === 'connected') {
					const claw = this.byId[id];
					if (claw && rtc.isReady) {
						const wasDisconnected = !claw.dcReady;
						claw.dcReady = true;
						claw.rtcPhase = 'ready';
						if (wasDisconnected) this.__refreshIfStale(id);
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
				let bailReason = null;
				for (let i = 0; i < RTC_BUILD_MAX_RETRIES; i++) {
					if (!this.byId[id]) {
						console.debug('[claws] ensureRtc: bail-out (claw removed) clawId=%s', id);
						bailedOut = true;
						bailReason = 'removed';
						break;
					}
					// 中途翻 offline：立即停止继续烧 attempts
					if (!this.byId[id].online) {
						console.debug('[claws] ensureRtc: bail-out (claw offline mid-build) clawId=%s', id);
						bailedOut = true;
						bailReason = 'offline';
						break;
					}
					// 中途 sig 掉线：停止继续烧 attempts，sig 回来时由 resume 路径重试
					if (_sigOffline) {
						console.debug('[claws] ensureRtc: bail-out (sig offline mid-build) clawId=%s', id);
						bailedOut = true;
						bailReason = 'sig_offline';
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
					// 如果 __resumeOnline 在 rebuild 分支登记了强制刷新，consume 标记并 force；
					// 否则沿用默认 gap-aware refresh（纯 RTC 断又恢复，非 presence 事件）
					const forceRefresh = _pendingForceRefreshOnRebuild.delete(id);
					this.__refreshIfStale(id, { force: forceRefresh });
					remoteLog(`claw.rtcReady claw=${id}${forceRefresh ? ' force_refresh=1' : ''}`);
				} else if (bailedOut) {
					// claw 被删除 → 无对象可写 phase；claw 翻 offline → 显式 phase=failed
					// 让后续 online→true 走 rebuild 分支（而非 triggerRestart）。
					// bailReason='sig_offline' / 'removed' 不改 rtcPhase：sig 是环境故障，
					// sig 回来时走 resume 路径，不应被标成 unreachable（触发 banner/retry UI）
					if (bailReason === 'offline') {
						const claw = this.byId[id];
						if (claw) claw.rtcPhase = 'failed';
					}
					remoteLog(`claw.rtcBailOut claw=${id} reason=${bailReason}`);
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
			// sig gate：WS 不通时排退避无意义，sig 回来时由 resume 路径重试
			if (_sigOffline) return;
			// online gate：offline 时不排队退避，online 回来由 __resumeOnline 分派
			if (!claw.online) return;
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
					// claw 被删 / 外部路径已恢复 RTC：本轮退避不再跑 __ensureRtc，
					// 悬挂的 pending force-refresh 标记显式清掉，避免极端时序下的永久残留
					_pendingForceRefreshOnRebuild.delete(id);
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
		 * 用户主动触发：对所有退避已耗尽的不可达 online claw 发起重连。
		 * 语义与 SSE 新快照 / network:online 的 failed 恢复路径一致：
		 * 清退避状态 + 重新走 __ensureRtc（__ensureRtc 同步把 rtcPhase
		 * 置为 building/recovering，UI 图标会立即从告警切回转圈）。
		 *
		 * 并发安全：__ensureRtc 内部有 _rtcInitInProgress 守卫，连点无副作用。
		 * 目标已过滤 online=false 的 claw，不会无谓尝试已知离线的 claw。
		 */
		manualRetryUnreachable() {
			const targets = this.unreachableClaws;
			if (targets.length === 0) return;
			const ids = targets.map((c) => c.id);
			remoteLog(`claw.manualRetry count=${ids.length} ids=${ids.join(',')}`);
			for (const id of ids) {
				this.__clearRetry(id);
				this.__ensureRtc(id).catch(() => {});
			}
		},

		/**
		 * network:online 分级处理（restart-first）。
		 * - restarting → nudge（立即重试 restart offer）
		 * - connected + typeChanged → triggerRestart（WiFi↔cellular，主动 restart）
		 * - failed/closed → rebuild（restart 已失败，走 fallback）
		 * - 其余（idle/connecting）→ 跳过（ICE 有自检测能力）
		 *
		 * 注：rtc.state 枚举为 idle/connecting/connected/restarting/failed/closed，
		 * 不会是 'disconnected'（PC 底层 connectionState 是 disconnected 时 rtc.state 仍为 connected，
		 * 由 WebRtcConnection 内部的 __disconnectedTimer 自行升级，store 层不再匹配 disconnected 分支）。
		 * @param {boolean} typeChanged
		 */
		__handleNetworkOnline(typeChanged) {
			// sig gate：WS 不通时 restart/rebuild 均发不出去；但 typeChanged 必须记下来，
			// sig 恢复时由 __resumeAllClawsForSigOnline 升级恢复策略（connected+paused
			// 从 resumeRecovery 改为 triggerRestart('online_resume')）。
			if (_sigOffline) {
				if (typeChanged) _pendingTypeChangedRestart = true;
				return;
			}
			for (const id of Object.keys(this.byId)) {
				if (_rtcInitInProgress.get(id)) continue;
				const claw = this.byId[id];
				if (!claw?.initialized) continue;
				// online gate：offline 的 claw 不在此参与恢复（online 回来由 __resumeOnline 分派）
				if (!claw.online) continue;
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
				// sig gate：WS 不通时 probe 无意义（restart 也发不出），恢复交给 resume 路径
				if (_sigOffline) return;
				// online gate：offline 时不 probe、不 restart，恢复交给 __resumeOnline
				if (!claw.online) return;
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

				// PC connected → probe DC 验证端到端可达性
				// 注：rtc.state 只能是 idle/connecting/connected/restarting/failed/closed；
				// PC 底层 disconnected 时 rtc.state 仍为 connected，由 WebRtcConnection
				// 内部的 __disconnectedTimer 自行升级，store 层不再干预。
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

