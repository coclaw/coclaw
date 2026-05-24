import { defineStore } from 'pinia';

import { useClawConnections } from '../services/claw-connection-manager.js';
import { BRIEF_DISCONNECT_MS } from '../services/claw-connection.js';
import { initRtc, closeRtcForClaw } from '../services/webrtc-connection.js';
import { remoteLog } from '../services/remote-log.js';
import { useSignalingConnection } from '../services/signaling-connection.js';
import { useAgentRunsStore } from './agent-runs.store.js';

// notify / i18n 钩子：由启动期通过 __registerNotifyHooks 注入实际实现
// （store 不直接 import use-notify / i18n，避免 @nuxt/ui 桶口的 #imports 把测试链路拖炸）
const _notifyHooks = {
	notify: () => {}, // 默认 no-op
	t: (key) => key, // 默认回显 key
};
/** @param {Partial<typeof _notifyHooks>} hooks */
export function __registerNotifyHooks(hooks) {
	Object.assign(_notifyHooks, hooks);
}

// claw 生命周期回调（由 claw-lifecycle.js 注册，避免静态循环依赖）
const _lifecycle = {
	cleanupClawResources: () => {},
	syncDashboardOffline: () => {},
	syncDashboardOnline: () => {},
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
 * typeChanged restart 记账集合（per-claw）。
 *
 * `network:online(typeChanged=true)` 时若某 claw**无法立刻 ICE restart**
 * （sig offline / claw offline / `connected+paused` / 未 initialized 等），
 * 将其 id 加入此集合——标记"下次恢复时必须 triggerRestart 而非 resumeRecovery"（旧 ICE 路径已因 IP 变化失效）。
 *
 * 消费：`__resumeOnline` 入口用 `delete(id)` 的返回值作为 `forceRestartOnConnected` 信号。
 * 覆盖三条漏网路径（对应 boolean 版本无法处理的场景）：
 * 1. sig 在线 + claw offline + typeChanged → claw 回 online 时消费
 * 2. sig offline + typeChanged + sig resume 但 claw 仍 offline → claw 回 online 时消费
 * 3. 多 claw 同时离线时，boolean 只能服务一把；Set 每个 claw 独立管
 *
 * 清理：`__resetClawStoreInternals`（logout）/ `removeClawById`。
 */
const _pendingTypeChangedRestartClaws = new Set();

/**
 * RTC 重连预算：5 分钟时间窗口 + 失败后 10s 冷却（首轮免冷却）
 * - 第一次失败开窗（windowStartAt = now），首轮 build 立即起（delay = 0），让"刚进入循环"的
 *   恢复路径不被节流拖慢——10s 是给"重复失败"用的减震，不是给首次恢复用的等待
 * - 窗口内后续失败仍按 RETRY_COOLDOWN_MS 节流，避免快速失败循环耗资源
 * - 窗口超时 → 标 unreachable，停手等用户手动重试 / SSE 恢复
 * - DC ready / 外部 reset（offline / sig offline / network online / manual / snapshot rescue）均立即清窗
 *
 * 实际中 SSE 快照、用户操作、前台恢复等外部事件也会触发重连，
 * 窗口重试仅作为兜底机制。
 */
/** DC probe 超时 */
const DC_PROBE_TIMEOUT_MS = 3_000;
/**
 * 短后台阈值：后台时长 < 此值时跳过 probe，信任 ICE 自恢复。
 * OS 给 app 约 5s 收尾，30s consent 超时 → 25s 以内挂起不超过 20s，
 * ICE 层仍有 ~10s 裕量自恢复（约 2 次 consent check 机会）。
 */
const SHORT_BACKGROUND_MS = 25_000;
/** 重连预算窗口：5 分钟内可不限次试，窗口外标 unreachable */
export const RETRY_WINDOW_MS = 5 * 60 * 1000;
/** 失败后固定冷却（避开 plugin 端 worker 残留与信令积压） */
export const RETRY_COOLDOWN_MS = 10_000;
/** 重试状态（clawId → { windowStartAt: number, timer: number|null }） */
const _rtcRetryState = new Map();
/** 运行时字段（server snapshot / SSE 事件不应覆盖） */
const RUNTIME_FIELDS = new Set([
	'dcReady', 'rtcPhase', 'lastAliveAt', 'disconnectedAt',
	'initialized', 'pluginInfo', 'rtcTransportInfo',
	'rtcPeerTransportInfo',
	'retryCount', 'retryNextAt',
]);
/**
 * 必须走专用入口的字段（拒绝 `addOrUpdateClaw` 等旁路覆盖）。
 *
 * `online` 是 server 侧 presence，UI 侧必须走 `updateClawOnline`（SSE `claw.status` 事件）
 * 或 `applySnapshot` 的 diff 入口触发 gate 副作用（pause/resume/retry 清理）。
 * 这里把 `online` 纳入黑名单，防御性禁止 `addOrUpdateClaw`（`claw.bound` / `claw.nameUpdated`）
 * 旁路覆盖 online——当前 server payload 不带 online 属于隐式契约，此条保证契约被外部改动时
 * 也不会静默绕过 gate。注意**不放进 `RUNTIME_FIELDS`**：`applySnapshot` 的 Phase 2 保留
 * 运行时状态时，online 必须由 snapshot 覆盖才能让 Phase 3 的 true↔false diff 生效。
 */
const GATED_FIELDS = new Set(['online']);

/**
 * 校验 claw id：接受非空 string / 非 NaN number；拒绝 null/undefined/空串/对象/
 * 数组/Symbol/boolean，以及 String() 会产生 ghost id 的 "null"/"undefined"/
 * "[object Object]" 字面量、纯空白串。
 *
 * 通过则返回规范化的 string id，否则返回 null。
 * 由 `addOrUpdateClaw` 与 `applySnapshot` 共用，保证两条入口对 malformed id 的过滤
 * 一致——否则 SSE 增量更新会绕过 snapshot 的过滤建出 ghost 连接。
 *
 * @param {*} raw - 原始 id 值
 * @returns {string|null} 规范化的 string id 或 null
 */
function __validateClawId(raw) {
	if (raw == null || raw === '') return null;
	if (typeof raw !== 'string' && typeof raw !== 'number') return null;
	if (typeof raw === 'number' && !Number.isFinite(raw)) return null;
	const s = String(raw).trim();
	if (s === '' || s === 'null' || s === 'undefined' || s === '[object Object]') return null;
	return s;
}

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
	_pendingTypeChangedRestartClaws.clear();
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

/** @internal 仅供测试访问内部 module-level 状态 */
export const __test__ = {
	_probeInProgress,
};

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
		// 插件信息（来自 plugin 主动推送的 coclaw.info.updated 事件）
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
		/**
		 * 测试脚手架：直接覆盖 byId（绕过 fetched gate / 生命周期副作用）。
		 * 不要在生产代码中使用——会导致 sig/online gate 错位。
		 * @internal Test-only.
		 */
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
			// 弱 id 校验拦截：`!claw?.id` 让 `{id: {}}` / `{id: 'null'}` / `{id: '[object Object]'}`
			// 等通过真值检查，再经 `String()` 进 byId 创建 ghost 连接（与 applySnapshot 同源）。
			// 复用 `__validateClawId` 与 snapshot 入口保持一致。
			const id = __validateClawId(claw?.id);
			if (!id) {
				if (claw?.id !== undefined && claw?.id !== null && claw?.id !== '') {
					console.warn('[claws] addOrUpdateClaw dropped malformed id=%o', claw?.id);
					remoteLog(`claw.upsertMalformed id=${typeof claw?.id}`);
				}
				return;
			}
			console.debug('[claws] upsert id=%s', id);
			remoteLog(`claw.upsert claw=${id}`);
			if (this.byId[id]) {
				// 更新已有 claw（保留运行时状态，跳过 server 不应覆盖的字段）
				const existing = this.byId[id];
				for (const [k, v] of Object.entries(claw)) {
					if (k === 'id' || RUNTIME_FIELDS.has(k) || GATED_FIELDS.has(k)) continue;
					existing[k] = v;
				}
			} else {
				// 用 trim 后的 id 入 createClawState，避免 state.id 留下原始空白与 byId 键不一致
				this.byId[id] = createClawState({ ...claw, id });
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
				// __fullInit 会建全新 ICE 路径，typeChanged 记账无意义 → 主动清 Set 条目
				//（与 __resumeAllClawsForSigOnline 的 !initialized 分支对称）
				_pendingTypeChangedRestartClaws.delete(id);
				// 顺序：先取 conn、判存在、再置 initialized=true、最后 fire __fullInit。
				// 若 conn 未 bridge（bridge 通常随 addOrUpdateClaw/applySnapshot 先行，但 SSE 时序
				// 不保证），过去先置 initialized=true 再判空会在 conn 缺失时卡死 initialized=true
				// + dcReady=false + 永不再 fullInit（与 Phase 3 rescue 同源）；对齐另两处
				// rescue 分支（applySnapshot Phase 3 L362 / __resumeAllClawsForSigOnline L623）。
				const conn = useClawConnections().get(id);
				if (conn) {
					claw.initialized = true;
					const attempt = claw.__initAttempt = (claw.__initAttempt || 0) + 1;
					this.__fullInit(id, conn).catch((err) => {
						if (claw.__initAttempt === attempt) claw.initialized = false;
						console.warn('[claws] fullInit failed for clawId=%s: %s', id, err?.message);
					});
				}
			} else if (prev === false) {
				// claw offline→online → 按 PC 状态分派恢复路径（restart / rebuild / noop）
				this.__resumeOnline(id);
			} else if (claw.rtcPhase === 'failed') {
				// 同值 online + rtcPhase=failed：rescue 路径（与 applySnapshot Phase 3 对称）
				// 用例：服务端推 claw.status SSE 同值，但本地 RTC 已死，snapshot 节流间隔大时
				// 此分支是唯一兜底入口
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
			_pendingTypeChangedRestartClaws.delete(id);
			// 清 probe guard，避免 remove 后立即 re-add 同 id 时新 claw 被旧 probe guard 阻塞、
			// 旧 probe 迟到 resolve 写到 stale claw 对象
			_probeInProgress.delete(id);
			// 同步清 _rtcInitInProgress：与 _probeInProgress 对称——否则 remove + 立即 re-add 同 id 时，
			// 新 claw 的 __ensureRtc 入口会被旧 lock 早退拦死（旧 await initRtc 即便 resolve 也写不进新 claw）
			_rtcInitInProgress.delete(id);
			delete this.byId[id];
		},
		/**
		 * 应用 SSE 推送的全量 claw 快照
		 * @param {object[]} items - server 推送的 claw 列表
		 */
		applySnapshot(items) {
			const arr = Array.isArray(items) ? items : [];
			// 过滤 malformed id 并捕获 trim 后规范化 id：复用 `__validateClawId` 与
			// `addOrUpdateClaw` 入口保持一致。server 合约不发 ghost id，仅为 proxy 篡改 /
			// 序列化错误兜底——不过滤会被送进 syncConnections 建 ghost 连接，烧 ICE/TURN 预算 + 脏列表。
			// 用 (b, id) pair 避免后续 `String(b.id)` 漏 trim，与 addOrUpdateClaw 路径对带空白 id 的归一化保持一致。
			const validPairs = [];
			for (const b of arr) {
				const id = __validateClawId(b?.id);
				if (id !== null) validPairs.push({ b, id });
			}
			const dropped = arr.length - validPairs.length;
			if (dropped > 0) {
				console.warn('[claws] snapshot dropped %d malformed id item(s)', dropped);
				remoteLog(`claw.snapshotMalformed dropped=${dropped} received=${arr.length}`);
			}
			const newById = {};
			// Phase 1: 快照 apply 前先记录每个已有 claw 的 online 值，供 Phase 3 diff
			const prevOnlineMap = new Map();
			for (const { b, id } of validPairs) {
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
					_pendingTypeChangedRestartClaws.delete(oldId);
					// 与 removeClawById 对称：清 probe guard，避免快照剔除→再添加同 id 时残留
					_probeInProgress.delete(oldId);
					// 同步清 _rtcInitInProgress：与 _probeInProgress 对称
					_rtcInitInProgress.delete(oldId);
				}
			}
			const prevFetched = this.fetched;
			this.byId = newById;
			this.fetched = true;
			console.debug('[claws] snapshot applied %d claw(s)', validPairs.length);
			remoteLog(`claw.snapshot count=${arr.length}`);

			// fetched=false→true 的边沿补扫：sig 已 offline 但首次 snapshot 之前
			// __freezeAllClawsForSigOffline 因 `!fetched` 早退（noop），现在 fetched 翻 true，
			// 但 _sigOffline 仍 true——既不再 freeze 也不暂停已建的 RTC，
			// 留下"sig 已死 + RTC 仍活"的窗口。这里显式补 freeze 一次。
			if (prevFetched === false && _sigOffline) {
				remoteLog(`claw.sigOfflineCatchup count=${Object.keys(this.byId).length}`);
				this.__freezeAllClawsForSigOffline();
			}

			const clawIds = validPairs.map(({ id }) => id);
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
				if (!claw?.initialized) {
					// snapshot 漏初始化补救：一个已桥接的 claw 若首次桥接时 online=false
					// 或 __fullInit 失败回滚了 initialized=false，下次 snapshot 时
					// `__bridgeConn` 因 `_bridgedConns` 已记录而短路（§bridgeConn），不再 fire fullInit；
					// 而本循环原 `!initialized continue` 又跳过 Phase 3 分派——两边夹住，
					// claw 卡在 online=true + initialized=false + dcReady=false 永不恢复。
					// 此处显式补救（逻辑复刻 `__resumeAllClawsForSigOnline` 的 !initialized 分支）。
					// 双 gate 防风暴：
					// - `_rtcInitInProgress`：前次 rescue 的 `__ensureRtc` 还在飞，重 fire 只会空转
					//   并多打一条 `claw.fullInit` remoteLog，跳过
					// - `_rtcRetryState`：`__ensureRtc` 失败已进入 __scheduleRetry 的窗口重试，
					//   重 fire 会绕过冷却节流（新 fullInit 再包 __ensureRtc → 立即再 build），
					//   跳过让 retry timer 自然接管
					if (claw?.online && !_rtcInitInProgress.get(id) && !_rtcRetryState.has(id)) {
						// sig offline 期间 __fullInit → __ensureRtc 的 sig gate (L820-823)
						// 在 `_rtcInitInProgress.set` 之前早退，锁从不置位；每次 snapshot 都会
						// 重跑 rescue → 刷一轮 `claw.fullInit` / `snapshot rescue fullInit ok` 日志。
						// sig 恢复时 `__resumeAllClawsForSigOnline` 的 !initialized 分支会兜底
						// 补跑 __fullInit，此处直接跳过即可（对称 __resumeAllClawsForSigOnline 的做法）
						if (_sigOffline) continue;
						_pendingTypeChangedRestartClaws.delete(id);
						const conn = useClawConnections().get(id);
						if (!conn) continue; // 未 bridge：等后续 __bridgeConn 接手
						claw.initialized = true;
						const attempt = claw.__initAttempt = (claw.__initAttempt || 0) + 1;
						this.__fullInit(id, conn).catch((err) => {
							if (claw.__initAttempt === attempt) claw.initialized = false;
							console.warn('[claws] fullInit (snapshot rescue) failed for clawId=%s: %s', id, err?.message);
						});
					}
					continue;
				}
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

			// event:coclaw.info.updated — plugin 主动推送的实例信息（含版本号）
			// patch 语义：仅更新 payload 中实际出现的字段，缺失字段保留原值
			conn.on('event:coclaw.info.updated', (payload) => {
				const claw = this.byId[id];
				if (!claw) return;
				if (!claw.pluginInfo) claw.pluginInfo = {};
				if (payload?.name !== undefined) claw.pluginInfo.name = payload.name;
				if (payload?.hostName !== undefined) claw.pluginInfo.hostName = payload.hostName;
				if (payload?.pluginVersion !== undefined) claw.pluginInfo.version = payload.pluginVersion;
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
			// 循环、__scheduleRetry、__handleNetworkOnline、__checkAndRecover）
			// 同样 gate claw.online 和 _sigOffline：门控关着时不烧恢复预算。
			// 详见通信模型 §5.5 和 §5.5.1。
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
			if (!this.fetched) return;
			let resumedCount = 0;
			// 诊断：本次 sig-resume 里因 typeChanged 记账被升级为 triggerRestart 的 claw 数。
			// 仅在 initialized 分支（真正调 __resumeOnline 消费 Set）里计数，避免
			// !initialized 分支的主动清理造成 force_restart 虚增。
			let forceRestartCount = 0;
			for (const id of Object.keys(this.byId)) {
				const claw = this.byId[id];
				if (!claw?.online) continue;
				if (!claw.initialized) {
					// 首启竞态补救：SSE snapshot 先到、sig 未连上时 __fullInit 被 sig gate
					// 拦过（__ensureRtc 入口早退 → 抛 'RTC not available' → catch 回滚
					// initialized=false）。sig 恢复时在此补跑（逻辑复刻 updateClawOnline 的
					// !initialized 分支）。
					// 说明：!initialized 的 claw 即将通过 __fullInit 建全新 ICE 路径，
					// 无论 Set 是否含它都不必 forceRestart（全新路径天然"强 restart"），
					// 但为正确清理 Set 条目，主动 delete。
					_pendingTypeChangedRestartClaws.delete(id);
					const conn = useClawConnections().get(id);
					if (!conn) continue; // conn 未 bridged：本次跳过，等 __bridgeConn 就绪后由后续路径接手
					claw.initialized = true;
					const attempt = claw.__initAttempt = (claw.__initAttempt || 0) + 1;
					this.__fullInit(id, conn).catch((err) => {
						if (claw.__initAttempt === attempt) claw.initialized = false;
						console.warn('[claws] fullInit (sig resume) failed for clawId=%s: %s', id, err?.message);
					});
				} else {
					if (_pendingTypeChangedRestartClaws.has(id)) forceRestartCount++;
					// __resumeOnline 内部会消费 Set 条目（若命中则自动升级为 triggerRestart）
					this.__resumeOnline(id);
				}
				resumedCount++;
			}
			if (resumedCount > 0) {
				remoteLog(`claw.sigOnline resumed count=${resumedCount} duration=${duration}ms force_restart=${forceRestartCount}`);
			}
		},

		/**
		 * claw 转入 online：按 PC 当前状态分派恢复路径；业务数据仅在 rebuild 后刷新。
		 *
		 * refresh 规则（唯一触发场景是 PC rebuild）：
		 * - rebuild 路径（rtc 不存在 / `failed` / `closed` / `idle` / `connecting`）
		 *   → `_pendingForceRefreshOnRebuild.add(id)`，`__ensureRtc` 成功后消费并 force refresh。
		 *   理由：rebuild 建的是全新 PC + 全新 SCTP，plugin 侧旧 DC 发送 buffer 的 rpc msg 会丢，
		 *   且 plugin 可能换端，必须主动刷数据
		 * - DC 延续路径（`connected` / `restarting`）→ **不刷**。PC 没 rebuild、SCTP 延续时，
		 *   plugin 侧缓冲的 rpc msg 会随 ICE 恢复自然送达 UI，主动 refresh 是冗余流量
		 *
		 * 分派动作：
		 * - `restarting` + paused → `triggerRestart('online_resume')`（复用 PC + 新 180s 预算）
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
		 * @param {boolean} [opts.forceRestartOnConnected=false] - connected+paused 时强制 triggerRestart 而非 resumeRecovery；
		 *   典型来源是 `_pendingTypeChangedRestartClaws` 消费（内部自动完成），外部调用者一般不传
		 */
		__resumeOnline(id, { forceRestartOnConnected = false } = {}) {
			// 两把锁协调核心：sig 不通时不做任何恢复动作（等 sig 回来时由
			// __resumeAllClawsForSigOnline 遍历重调；或由 claw online 事件再次触发）
			if (_sigOffline) return;
			// dashboard 展示层同步回 online=true，与 __handleClawGoOffline 的 syncDashboardOffline 对称。
			// 仅同步展示字段，不刷聚合数据——DC 延续场景（connected/restarting）下 plugin 侧缓冲会自然送达，
			// rebuild 成功路径由 `_pendingForceRefreshOnRebuild` consume 点的 refreshClawResources 统一刷（含 dashboard）。
			// 此处用意：防止 DC 延续时 ManageClawsPage 等处长期显示"已离线"（因为 refreshClawResources 不会被触发）。
			_lifecycle.syncDashboardOnline(id);
			const conn = useClawConnections().get(id);
			if (!conn) return;
			// typeChanged per-claw 记账查询（不消费）：命中则升级到 triggerRestart('online_resume')。
			// 消费延后到真正 fire restart 的分支——避免 connected+!paused / restarting+!paused 等
			// fall-through 路径上 Set 被早消费但 typeChanged 信号被无声吞掉（旧 ICE 路径失效未替换）。
			// conn 缺失场景由 G-04 保证 Set 条目保留：lookup 不消费天然满足。
			forceRestartOnConnected = forceRestartOnConnected || _pendingTypeChangedRestartClaws.has(id);
			this.__clearRetry(id);
			const rtc = conn.rtc;
			// refresh 仅在 rebuild 场景触发：全新 PC + 全新 SCTP 会丢 plugin 侧 DC 发送 buffer，
			// 且 plugin 可能换端，必须主动刷。DC 延续场景（connected / restarting）plugin 缓冲
			// 的 rpc msg 会随 ICE 恢复自然送达，不需要主动 refresh（冗余流量）
			const dcContinuous = rtc?.state === 'connected' || rtc?.state === 'restarting';
			if (!dcContinuous) {
				_pendingForceRefreshOnRebuild.add(id);
			}

			if (rtc?.state === 'restarting') {
				if (rtc.restartPaused) {
					// 仅当 PC 处于 pauseRestart 冻结态时才 unstick；
					// 若已在正常 restart 循环中（非冻结），不重复 triggerRestart 避免 attemptCount 虚涨/重发 offer
					rtc.triggerRestart('online_resume');
					// 真 fire restart：消费 Set 条目（满足 typeChanged 信号）
					_pendingTypeChangedRestartClaws.delete(id);
				} else if (forceRestartOnConnected) {
					// restarting+!paused 已在正常 restart 循环；新 ICE 路径会建在当前网络上，
					// 信任正在跑的 restart 即可——主动消费 Set 条目避免后续重复 fire。
					// （__handleNetworkOnline 的 restarting+!paused 分支已 nudgeRestart + delete 过；
					// 此处看到 entry 概率很低，但保险起见兜底清掉）
					_pendingTypeChangedRestartClaws.delete(id);
				}
				return;
			}
			if (rtc?.state === 'connected' && rtc.restartPaused) {
				if (forceRestartOnConnected) {
					// 网络类型变化 + sig 回来：旧 ICE 路径必然失效，走 restart 不走轻量 resume
					// 镜像 restarting+paused 路径，早退不 fall through
					rtc.triggerRestart('online_resume');
					_pendingTypeChangedRestartClaws.delete(id);
					return;
				}
				// connected 态从 pause 冻结恢复：仅清 paused 标志 + 重启 keepalive，
				// 不触发 ICE restart（PC 本身仍健康）
				rtc.resumeRecovery();
				// resumeRecovery 可能因 pc.connectionState='failed'/'disconnected' 升级到
				// triggerRestart('online_resume') → __attemptRestart 同步 setState('restarting')。
				// 若此时 fall through 到 L724 __ensureRtc，__ensureRtc 的 early-return 只认
				// rtc.state==='connected'，会把刚启动的 restart PC 当非 connected 关掉重 rebuild，
				// 白烧 ICE/TURN 预算、延迟恢复。升级后走正常 restart 循环，不需要 __ensureRtc
				if (rtc.state === 'restarting') return;
			}
			// connected + !paused + forceRestartOnConnected：升级为 triggerRestart('online_resume')。
			// 不升级会 fall through 到 __ensureRtc 的 connected 早退 → typeChanged 信号被无声吞掉。
			// 必须放在 fall through 到 __ensureRtc 之前。
			if (rtc?.state === 'connected' && forceRestartOnConnected) {
				rtc.triggerRestart('online_resume');
				_pendingTypeChangedRestartClaws.delete(id);
				return;
			}
			// dashboard 不在此处单独加载：与 agents/sessions/topics 保持对称——
			// DC 延续（connected/restarting）场景下 plugin 侧缓冲会自然送达，不需要刷；
			// rebuild 成功场景由 `_pendingForceRefreshOnRebuild` consume 点的 refreshClawResources 统一刷（已含 dashboard）
			this.__ensureRtc(id).catch(() => {});
		},

		/** 构建 RTC 回调（store 侧状态同步） */
		__rtcCallbacks(clawId) {
			return {
				// ICE restart 180s 预算耗尽、即将 PC rebuild 时触发一次。
				// 仅当该 claw 上仍有未结束的 agent run 时才 notify——否则连接断了再连上用户无感，
				// 弹提示反而是无意义打扰；rtc.unrecoverable remoteLog 已独立打过，分析侧不丢信号
				onRtcUnrecoverable: () => {
					const claw = this.byId[clawId];
					if (!claw) return;
					const runs = useAgentRunsStore().runs;
					let activeCount = 0;
					for (const r of Object.values(runs)) {
						if (r.clawId === clawId && !r.ended) activeCount++;
					}
					if (activeCount === 0) return;
					const clawName = claw.name || clawId;
					_notifyHooks.notify({
						title: _notifyHooks.t('notify.rtcUnrecoverable', { clawName, n: activeCount }),
					});
				},
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
						// plugin 侧 transport 信息失效；新连接建立后 plugin 会重新推送
						claw.rtcPeerTransportInfo = null;
						// _rtcInitInProgress=true：本次 close/fail 由 __ensureRtc 主动 init 触发
						// （入口 closeRtcForClaw 同步回调，或 await 期间被外部 close）。
						// 此时 phase 由 init 入口（'building'/'recovering'）和收尾路径（'ready'/'failed'）
						// 独占管理，回调不写 phase 也不排重试，避免 rebuild 中途 phase 被同步回调
						// 写回 'failed' 导致 spinner 误熄、UI 短暂闪 unreachable warning。
						if (!_rtcInitInProgress.get(clawId)) {
							claw.rtcPhase = 'failed';
							this.__scheduleRetry(clawId);
						}
					}
				},
			};
		},

		/**
		 * 数据刷新（RTC 恢复后触发）
		 *
		 * 两种调用语义：
		 * - 默认（`force=false`）：RTC 层面断连恢复后的"顺便刷"——
		 *   看 `disconnectedAt` gap：< BRIEF_DISCONNECT_MS 跳过（浏览器短暂切后台 / 网络闪断
		 *   不值得全量刷），>= gap 门槛才刷。由 `onRtcStateChange('connected')` /
		 *   `__ensureRtc` rebuild 成功路径调用。
		 * - 强制（`force=true`）：rebuild 后的"必须刷"——跳过 gap 检查，只要 initialized 就刷。
		 *   由 `__ensureRtc` 成功路径 consume `_pendingForceRefreshOnRebuild` 标记时调用
		 *   （标记由 `__resumeOnline` rebuild 分支 add）。
		 *   语义：rebuild 建全新 SCTP，plugin 侧旧 DC buffer 的 rpc msg 丢失 + plugin 可能换端，
		 *   UI 数据必刷。DC 延续场景不走此路径（msg 会随 ICE 恢复自然送达）。
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
			// pluginInfo 由 plugin 主动推送的 coclaw.info.updated 事件维护，不在此处主动拉取
			// refreshClawResources 现已 async（topics/dashboard 即时并发，sessions 等 loadAgents）；
			// 内部各 load 已自带 .catch，外层 promise 实际不会 reject——这里 .catch 仅作 unhandled-rejection
			// 兜底；真触发说明某层防御漏了，warn 一行带上 clawId 留诊断信号
			_lifecycle.refreshClawResources(id).catch((err) => {
				console.warn('[claws] refreshClawResources unexpected reject clawId=%s:', id, err);
			});
		},

		/**
		 * 统一 RTC 建立/恢复入口。
		 * 触发点：claw offline→online、__bridgeConn 首次初始化、probe 失败。
		 *
		 * post-await bail reason 集（rebuild 循环内 await initRtc 解决后判定）：
		 * - `removed`：claw 被删（this.byId[id] 缺失）
		 * - `offline`：claw 翻 offline（此分支显式置 rtcPhase='failed'，让后续 online→true 走 rebuild）
		 * - `sig_offline`：sig 掉线（rtcPhase / disconnectedAt snapshot+restore，
		 *   避免 sig 是环境故障却被误标 unreachable / 污染 gap-aware refresh）
		 * - `replaced`：同 id remove + re-add 致 byId[id] 实例换新（cur !== clawAtStart）；
		 *   仅纯回收旧 conn 的 rtc，不读写新 claw 任何字段，不消费 _pendingForceRefreshOnRebuild
		 *   （新 claw 入 Set 由其自身 ensureRtc 消费）
		 *
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
			// post-await 用：识别 await initRtc 期间发生的 remove + re-add 同 id 场景
			// （新 claw 实例换新；旧 await 的成功结果不能写到新 claw 上）
			const clawAtStart = this.byId[id];

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

				// 单次 build：失败由 __scheduleRetry 按固定冷却节奏接力（见 retry window 模型）。
				// 这里不再背靠背烧多次 attempt——背靠背 build 中间无冷却，是过去 offer 风暴的源头之一。
				let result = 'failed';
				let bailedOut = false;
				let bailReason = null;
				if (!this.byId[id]) {
					console.debug('[claws] ensureRtc: bail-out (claw removed) clawId=%s', id);
					bailedOut = true;
					bailReason = 'removed';
				} else if (!this.byId[id].online) {
					console.debug('[claws] ensureRtc: bail-out (claw offline pre-build) clawId=%s', id);
					bailedOut = true;
					bailReason = 'offline';
				} else if (_sigOffline) {
					console.debug('[claws] ensureRtc: bail-out (sig offline pre-build) clawId=%s', id);
					bailedOut = true;
					bailReason = 'sig_offline';
				} else {
					result = await initRtc(id, conn, this.__rtcCallbacks(id));
					// post-await gate recheck：initRtc 期间 gate 可能翻转
					// （offline handler 在此期间只能调 `conn.rtc?.pauseRestart()`，但
					// initRtc 尚未 resolve 时 `conn.rtc=null`，pauseRestart 空转），
					// 不补一次 recheck 则成功建成的 RTC 会越过关着的门，违反"门控关着预算冻结"。
					// 失败路径同样要 recheck：build 失败 + 门翻转应走 bail（保持原"内层多轮循环
					// 第二轮检查闸门 break"的语义），避免误把环境故障当 build 失败排重试或污染 phase。
					const cur = this.byId[id];
					let postBailReason = null;
					if (!cur) postBailReason = 'removed';
					else if (cur !== clawAtStart) postBailReason = 'replaced';
					else if (!cur.online) postBailReason = 'offline';
					else if (_sigOffline) postBailReason = 'sig_offline';
					if (postBailReason) {
						console.debug('[claws] ensureRtc: post-await bail-out (%s) clawId=%s', postBailReason, id);
						if (result === 'rtc') {
							// 成功后门翻转：必须 close 已建出的 rtc。
							// `closeRtcForClaw` 同步调 `rtc.close()` → `__setState('closed')` →
							// 触发 `__rtcCallbacks.onRtcStateChange('closed')`：因 `_rtcInitInProgress=true`
							// 命中 gate，回调不写 `rtcPhase`、不排重试，仅写 `dcReady=false` +
							// `disconnectedAt=Date.now()` + 清 peerTransport。
							// - offline bail：phase 由下方 bail 分支显式写 'failed'（online→true 走 rebuild）
							// - sig_offline bail：disconnectedAt 仍需 snapshot + restore，避免 sig 恢复后
							//   gap-aware refresh 因虚假的 stamp 误判短断跳过刷新。rtcPhase 因 gate 已不被
							//   覆盖，restore 退化为 no-op，但保留以表达"不污染 phase"意图
							// - removed bail：cur=null，不受影响
							// - replaced bail：cur 是**新** claw 对象，不应被旧 await 的成功结果污染——
							//   既不读 prevRtcPhase 也不显式 restore，仅纯回收旧 conn.rtc
							if (postBailReason === 'replaced') {
								closeRtcForClaw(id);
								conn.clearRtc();
							} else {
								const prevRtcPhase = cur?.rtcPhase;
								const prevDisconnectedAt = cur?.disconnectedAt;
								closeRtcForClaw(id);
								conn.clearRtc();
								if (postBailReason === 'sig_offline' && cur) {
									cur.rtcPhase = prevRtcPhase;
									cur.disconnectedAt = prevDisconnectedAt;
								}
							}
						}
						// 失败 + 门翻转：rtc 没建起来，无需再 close。phase 留给下方 bail 分支按 reason 处理：
						// - sig_offline：bail 分支不改 phase，entry 写入的 'recovering'/'building' 保持
						// - offline：bail 分支显式写 'failed'
						// - removed/replaced：不动 store
						bailedOut = true;
						bailReason = postBailReason;
						result = 'failed'; // 走 bailedOut 分支，不进入成功分支
					} else if (result !== 'rtc') {
						console.debug('[claws] ensureRtc: build failed clawId=%s', id);
					}
				}

				if (result === 'rtc') {
					const claw = this.byId[id];
					if (claw) {
						claw.dcReady = true;
						claw.rtcPhase = 'ready';
					}
					this.__clearRetry(id);
					// rebuild 建出的是全新 ICE 路径 → typeChanged 记账条目无意义，主动清
					// （与 `__resumeAllClawsForSigOnline` / `updateClawOnline` 的 !initialized
					// 分支对称：新路径天然"强 restart"，不需要后续 __resumeOnline 虚发）
					_pendingTypeChangedRestartClaws.delete(id);
					// 如果 __resumeOnline 在 rebuild 分支登记了强制刷新，consume 标记并 force；
					// 否则沿用默认 gap-aware refresh（纯 RTC 断又恢复，非 presence 事件）
					const forceRefresh = _pendingForceRefreshOnRebuild.delete(id);
					this.__refreshIfStale(id, { force: forceRefresh });
					remoteLog(`claw.rtcReady claw=${id}${forceRefresh ? ' force_refresh=1' : ''}`);
				} else if (bailedOut) {
					// claw 被删除 → 无对象可写 phase；claw 翻 offline → 显式 phase=failed
					// 让后续 online→true 走 rebuild 分支（而非 triggerRestart）。
					// bailReason='sig_offline' / 'removed' / 'replaced' 不改 rtcPhase：sig 是环境故障，
					// sig 回来时走 resume 路径；replaced 下 byId[id] 是新 claw，旧 ensureRtc 不应污染它。
					if (bailReason === 'offline') {
						const claw = this.byId[id];
						if (claw) claw.rtcPhase = 'failed';
					}
					// bail = 本次 rebuild 意图作废，与成功分支对称清 pending force-refresh 标记。
					// 不清会导致后续由非 __resumeOnline 路径（timer/manualRetry/foreground）触发的
					// __ensureRtc 成功分支 consume 残留条目，对 DC 延续的健康 PC 误 force_refresh。
					// 例外：'replaced' 场景下 byId[id] 是**新** claw 对象，可能已通过自身的
					// __resumeOnline 入 Set，旧 ensureRtc 不应代它消费——只清旧 claw 的语义责任由
					// removeClawById 完成。
					if (bailReason !== 'replaced') {
						_pendingForceRefreshOnRebuild.delete(id);
					}
					remoteLog(`claw.rtcBailOut claw=${id} reason=${bailReason}`);
				} else {
					const claw = this.byId[id];
					if (claw) claw.rtcPhase = 'failed';
					console.warn('[claws] ensureRtc: build failed, scheduling retry clawId=%s', id);
					remoteLog(`claw.rtcFailed claw=${id}`);
					this.__scheduleRetry(id);
				}
			} finally {
				_rtcInitInProgress.delete(id);
			}
		},

		/**
		 * 首次连接初始化：建立 RTC → 拉一次 pluginInfo 作启动兜底 → 数据加载
		 * 所有业务 RPC 通过 DC 发送，因此必须先等 RTC 就绪。
		 * pluginInfo 来源有两条互补路径：
		 *   - 主动拉取（本函数 fire-and-forget）：UI 启动时确保拿到 plugin 信息快照（覆盖事件晚到/错过场景）
		 *   - 事件推送（coclaw.info.updated）：plugin 主动通知信息变更（增量）
		 */
		async __fullInit(id, conn) {
			remoteLog(`claw.fullInit claw=${id}`);
			const claw = this.byId[id];
			// race: claw 在 init 过程中被移除（调用方 catch 会回退 initialized）
			if (!claw) throw new Error('Claw removed during init');

			// 等待 RTC 建立（DC 是唯一的 RPC 通道）。
			// dcReady 由 RTC 状态机写（`__ensureRtc` 成功路径 + `onRtcStateChange('connected')`），
			// 本函数不旁路写 dcReady——保持 "仅 RTC 状态机写 dcReady" 的 presence/DC 解耦原则。
			await this.__ensureRtc(id);
			if (!conn.rtc?.isReady) throw new Error('RTC not available');

			this.__loadPluginInfo(id);

			await _lifecycle.initClawResources(id);
		},

		/**
		 * 拉取一次 plugin 实例信息写入 store，fire-and-forget 模式。
		 *
		 * 仅做信息拉取，**不做版本判断**——失败时不写、不动 pluginInfo 现有值，
		 * 不抛错也不影响 UI 任何拦截/初始化行为。这与 plugin 主动推送的
		 * `coclaw.info.updated` 事件互补：事件覆盖运行时变更，本函数覆盖启动兜底。
		 *
		 * 失败原因（任意一种都不可作为"插件不可用"结论）：
		 *   - 通道抖动 / RPC 超时 / DC 暂时不通
		 *   - 老版本插件未实现该方法
		 *   - 对端 plugin 在响应前重启
		 * @param {string} id - clawId
		 */
		__loadPluginInfo(id) {
			const conn = useClawConnections().get(id);
			if (!conn) return;
			conn.request('coclaw.info', {})
				.then((info) => {
					const claw = this.byId[id];
					if (!claw) return;
					// patch 语义：只覆盖响应中实际出现的字段
					const next = { ...(claw.pluginInfo || {}) };
					if (info?.version !== undefined) next.version = info.version;
					if (info?.clawVersion !== undefined) next.clawVersion = info.clawVersion;
					if (info?.name !== undefined) next.name = info.name;
					if (info?.hostName !== undefined) next.hostName = info.hostName;
					claw.pluginInfo = next;
				})
				.catch((err) => {
					// 拉取失败时**不动** pluginInfo——已有值（来自事件推送或上次拉取）继续保留
					console.debug('[claws] loadPluginInfo failed clawId=%s: %s', id, err?.message);
				});
		},

		/**
		 * 安排重试（__ensureRtc 失败或被动失败后调用）
		 *
		 * 窗口模型：第一次进入开窗 windowStartAt=now；窗口内后续失败排
		 * RETRY_COOLDOWN_MS 后再 build；窗口超时后停手等用户手动重试。
		 *
		 * 首轮免冷却：状态表里没条目即"首次进入循环"——立即起 build（delay=0）。
		 * 状态表会在 build 成功 / 外部 reset / 窗口超时 时清空，因此每次重新进入
		 * 循环都会享受这次免冷却。冷却仅作用于"建完又挂"的循环失败场景。
		 *
		 * 边界：窗口剩余 < RETRY_COOLDOWN_MS 时仍按 cooldown 排定 timer，
		 * 该 timer fire 时已过期 ≤ cooldown，对应 __ensureRtc 失败后下一轮
		 * __scheduleRetry 命中 unreachable 分支退出。最坏情况是窗口过期后
		 * 多发起 1 次 build，可接受。
		 */
		__scheduleRetry(id) {
			const claw = this.byId[id];
			if (!claw) return;
			// sig gate：WS 不通时排重试无意义，sig 回来时由 resume 路径重试
			if (_sigOffline) return;
			// online gate：offline 时不排队重试，online 回来由 __resumeOnline 分派
			if (!claw.online) return;
			const now = Date.now();
			let state = _rtcRetryState.get(id);
			const isFirstInLoop = !state;
			if (!state) {
				state = { windowStartAt: now, timer: null };
				_rtcRetryState.set(id, state);
			}
			const elapsed = now - state.windowStartAt;
			if (elapsed >= RETRY_WINDOW_MS) {
				console.warn('[claws] retry window exhausted (%dms) clawId=%s', RETRY_WINDOW_MS, id);
				remoteLog(`claw.retryExhausted claw=${id} window=${RETRY_WINDOW_MS}ms`);
				clearTimeout(state.timer);
				_rtcRetryState.delete(id);
				claw.retryCount = 0;
				claw.retryNextAt = 0;
				return;
			}
			clearTimeout(state.timer);
			// 首轮 delay=0：进入循环时立即恢复，不被减震节流拖慢
			const delay = isFirstInLoop ? 0 : RETRY_COOLDOWN_MS;
			const remaining = Math.max(0, RETRY_WINDOW_MS - elapsed);
			claw.retryCount = (claw.retryCount || 0) + 1;
			claw.retryNextAt = now + delay;
			console.debug('[claws] scheduling retry in %dms (window remaining %dms) clawId=%s',
				delay, remaining, id);
			remoteLog(`claw.retryScheduled claw=${id} delay=${delay}ms window_remaining=${remaining}ms`);
			state.timer = setTimeout(() => {
				state.timer = null;
				if (!this.byId[id] || this.byId[id]?.rtcPhase !== 'failed') {
					this.__clearRetry(id);
					// claw 被删 / 外部路径已恢复 RTC：本轮重试不再跑 __ensureRtc，
					// 悬挂的 pending force-refresh 标记显式清掉，避免极端时序下的永久残留
					_pendingForceRefreshOnRebuild.delete(id);
					return;
				}
				this.__ensureRtc(id).catch(() => {});
			}, delay);
		},

		/** 清除重试窗口（成功 / claw 离线 / 外部事件重置时调用） */
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
		 * - rtc=null + (rtcPhase='failed' 或 !dcReady) → rebuild（退避中抢时机 rebuild，避免空等下一个退避 fire 在失效路径上消耗）
		 * - 其余（idle/connecting）→ 跳过（ICE 有自检测能力）
		 *
		 * 注：rtc.state 枚举为 idle/connecting/connected/restarting/failed/closed，
		 * 不会是 'disconnected'（PC 底层 connectionState 是 disconnected 时 rtc.state 仍为 connected，
		 * 由 WebRtcConnection 内部的 __disconnectedTimer 自行升级，store 层不再匹配 disconnected 分支）。
		 * @param {boolean} typeChanged
		 */
		__handleNetworkOnline(typeChanged) {
			// typeChanged 记账（per-claw）：对本次调用**不会**被下方循环立刻 triggerRestart
			// 的 claw 全部打标——下次它们走 __resumeOnline 时（不管是 claw-online 还是
			// sig-online 路径），自动升级为 triggerRestart（旧 ICE 路径已失效）。
			// 必须在 sig gate `return` 之前，才能覆盖 "sig offline + typeChanged" 场景。
			if (typeChanged) {
				for (const id of Object.keys(this.byId)) {
					const claw = this.byId[id];
					if (!claw) continue;
					const conn = useClawConnections().get(id);
					const rtc = conn?.rtc;
					// 仅"sig 通 + claw online + initialized + connected + 未 paused"的 claw
					// 会被下方循环 L991 的 `triggerRestart('network_type_changed')` 立刻处理；
					// 其余一律打标（包括 offline / sig offline / paused / restarting / failed /
					// 未 initialized / rtc=null 等）。
					const willHandleNow = !_sigOffline
						&& claw.online
						&& claw.initialized
						&& rtc?.state === 'connected'
						&& !rtc.restartPaused;
					if (!willHandleNow) _pendingTypeChangedRestartClaws.add(id);
				}
			}
			// sig gate：WS 不通时 restart/rebuild 均发不出去（typeChanged 已在上方记账完毕）。
			if (_sigOffline) return;
			for (const id of Object.keys(this.byId)) {
				if (_rtcInitInProgress.get(id)) continue;
				const claw = this.byId[id];
				if (!claw?.initialized) continue;
				// online gate：offline 的 claw 不在此参与恢复（online 回来由 __resumeOnline 分派）
				if (!claw.online) continue;
				const conn = useClawConnections().get(id);
				const rtc = conn?.rtc;
				if (!rtc) {
					// rtc=null 但 rtcPhase='failed' / dcReady=false：rebuild 退避重试中
					// （或 clearRtc 后尚未重建）。network:online 是立即 rebuild 的好时机，
					// 否则要等下一次退避 fire，典型场景（WiFi↔蜂窝）那次 retry 用的是失效 ICE
					// 路径、必然失败——多等一个退避周期毫无意义。
					if (claw.rtcPhase === 'failed' || !claw.dcReady) {
						remoteLog(`claw.recover claw=${id} reason=rtc_null source=network:online`);
						_pendingTypeChangedRestartClaws.delete(id);
						claw.rtcPhase = 'recovering';
						this.__clearRetry(id);
						this.__ensureRtc(id).catch(() => {});
					}
					continue;
				}

				if (rtc.state === 'restarting') {
					if (rtc.restartPaused) {
						// paused+restarting：nudge → __attemptRestart('nudge') 在 L975 被 drop
						// （非 online_resume）→ 若此时 delete Set 则 restart 没发 + 信号永久丢。
						// 保留 Set 条目，让后续 __resumeOnline 消费时升级为
						// triggerRestart('online_resume')（paused 穿透白名单唯一成员）。
						// 与下方 connected+paused 分支对称。
						remoteLog(`claw.typeChanged claw=${id} paused_restarting defer_to_resume`);
						continue;
					}
					// 非 paused：当场 nudge 继续 restart 循环 → 新 ICE 路径自然建在当前网络上
					// → typeChanged 记账条目变陈旧，主动清理避免下次 __resumeOnline 虚发
					_pendingTypeChangedRestartClaws.delete(id);
					rtc.nudgeRestart();
					continue;
				}
				if (rtc.state === 'connected' && typeChanged) {
					if (rtc.restartPaused) {
						// paused 态下 __attemptRestart 只接受 reason='online_resume'，
						// `network_type_changed` 会被 drop → 若此处发 triggerRestart 则 restart 没发
						// 且本次若同时清 Set，信号将永久丢失。
						// 正确做法：保留 Set 条目，让后续 __resumeOnline 消费时升级为 'online_resume'
						// triggerRestart（paused 穿透白名单唯一成员），由 resume 路径完成真正的 restart。
						remoteLog(`claw.typeChanged claw=${id} paused defer_to_resume`);
						continue;
					}
					remoteLog(`claw.recover claw=${id} reason=network_type_changed source=network:online`);
					// 非 paused 态：triggerRestart 会被 __attemptRestart 正常处理 → 新 ICE 路径建成后
					// Set 条目即陈旧，主动清避免下次 __resumeOnline 虚发 online_resume triggerRestart。
					// （非 paused+connected 预循环 willHandleNow=true 本来就不入 Set，此 delete
					// 对这条子路径是 no-op；但若预循环与主循环之间 pause 状态翻转过，delete 仍生效。）
					_pendingTypeChangedRestartClaws.delete(id);
					rtc.triggerRestart('network_type_changed');
					continue;
				}
				if (rtc.state === 'failed' || rtc.state === 'closed') {
					remoteLog(`claw.recover claw=${id} reason=rtc_${rtc.state} source=network:online`);
					// 本次调用启动 rebuild → 全新 ICE 路径 → 清陈旧条目
					_pendingTypeChangedRestartClaws.delete(id);
					claw.rtcPhase = 'recovering';
					this.__clearRetry(id);
					this.__ensureRtc(id).catch(() => {});
				}
			}
		},

		/**
		 * DC 健康检查 + 恢复（前台恢复时调用，network:online 和短后台已在上层过滤）
		 *
		 * 决策基于 PC 自身状态和 DC probe；入口 gate `_sigOffline`：WS 不通时 probe / restart
		 * 都发不出，恢复交给 sig 回来后的 resume 路径（见 §5.5.1）。
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
				// probe 等待期间 sig / online gate 可能翻转：
				// - sig_offline：__ensureRtc 入口 sig gate 拦下重建，但 triggerRestart 直接走 rtc 层
				//   没有 sig gate，会把 signaling 发给已死 WS
				// - claw offline：ensureRtc 有 online gate 兜底，但写 rtcPhase='recovering' / 调
				//   triggerRestart 仍是无意义动作；统一在此早退保持各 gate 语义对称
				if (_sigOffline || !this.byId[id]?.online) {
					remoteLog(`claw.recover claw=${id} bail=${_sigOffline ? 'sig_offline' : 'offline'}_post_probe source=${source}`);
					return;
				}

				// probe 失败 → 二次确认 PC 状态。
				// 如果 PC 仍为 connected，说明 ICE 层认为链路健康，
				// 可能是 plugin 繁忙（如大文件写入）导致 probe-ack 延迟，不 rebuild。
				const rtcAfter = conn?.rtc;
				if (rtcAfter && rtcAfter.state === 'connected') {
					remoteLog(`claw.recover claw=${id} reason=probe_timeout_pc_connected action=skip`);
					return;
				}
				// PC 在 probe 期间变 failed/closed → triggerRestart 会哑火，必须直接 rebuild（与 pre-probe 路径对称）
				if (rtcAfter && (rtcAfter.state === 'failed' || rtcAfter.state === 'closed')) {
					remoteLog(`claw.recover claw=${id} reason=probe_failed_pc_${rtcAfter.state} action=rebuild source=${source}`);
					claw.rtcPhase = 'recovering';
					this.__clearRetry(id);
					this.__ensureRtc(id).catch(() => {});
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

