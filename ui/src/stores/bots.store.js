import { defineStore } from 'pinia';

import { useBotConnections } from '../services/bot-connection-manager.js';
import { useSignalingConnection } from '../services/signaling-connection.js';
import { useAgentRunsStore } from './agent-runs.store.js';
import { useAgentsStore } from './agents.store.js';
import { useSessionsStore } from './sessions.store.js';
import { useDashboardStore } from './dashboard.store.js';
import { useTopicsStore } from './topics.store.js';
import { BRIEF_DISCONNECT_MS } from '../services/bot-connection.js';
import { checkPluginVersion } from '../utils/plugin-version.js';
import { initRtc, closeRtcForBot } from '../services/webrtc-connection.js';

// 跟踪已桥接的 conn 实例（botId → BotConnection），避免重复注册
const _bridgedConns = new Map();
/** __ensureRtc 并发防护（botId → true） */
const _rtcInitInProgress = new Map();

const RTC_BUILD_MAX_RETRIES = 3;
/** werift consent 过期时限 — 超过此时长 PC 必定已死，无需 probe */
const CONSENT_EXPIRY_MS = 30_000;
/** DC probe 超时 */
const DC_PROBE_TIMEOUT_MS = 3_000;

/** @internal 仅供测试重置 */
export function __resetBotStoreInternals() {
	_bridgedConns.clear();
	_rtcInitInProgress.clear();
}
// 保留旧名兼容测试导入
export { __resetBotStoreInternals as __resetAwaitingConnIds };

/**
 * 创建 per-bot 聚合状态对象
 * @param {object} bot - 基础 bot 信息
 * @returns {object}
 */
function createBotState(bot) {
	return {
		// 基础信息（HTTP 源）
		id: String(bot.id),
		name: bot.name ?? null,
		online: Boolean(bot.online),
		lastSeenAt: bot.lastSeenAt ?? null,
		createdAt: bot.createdAt ?? null,
		updatedAt: bot.updatedAt ?? null,
		// RTC 生命周期
		rtcPhase: 'idle', // 'idle' | 'building' | 'ready' | 'recovering' | 'failed'
		lastAliveAt: 0,
		disconnectedAt: 0,
		// 初始化标记（首次 vs 重连）
		initialized: false,
		// 插件状态（运行时写入）
		pluginVersionOk: null,
		pluginInfo: null,
		rtcTransportInfo: null,
		dcReady: false,
	};
}

export const useBotsStore = defineStore('bots', {
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
		setBots(items) {
			const arr = Array.isArray(items) ? items : [];
			const newById = {};
			for (const bot of arr) {
				const id = String(bot.id ?? '');
				if (!id) continue;
				newById[id] = this.byId[id]
					? { ...this.byId[id], ...bot, id }
					: createBotState(bot);
			}
			this.byId = newById;
		},
		addOrUpdateBot(bot) {
			if (!bot?.id) return;
			const id = String(bot.id);
			console.debug('[bots] upsert id=%s', id);
			if (this.byId[id]) {
				// 更新已有 bot（保留运行时状态）
				const existing = this.byId[id];
				for (const [k, v] of Object.entries(bot)) {
					if (k === 'id') continue;
					existing[k] = v;
				}
			} else {
				this.byId[id] = createBotState(bot);
			}
			const manager = useBotConnections();
			manager.connect(id);
			this.__bridgeConn(id);
		},
		updateBotOnline(botId, online) {
			const id = String(botId);
			const bot = this.byId[id];
			if (!bot) return;
			const prev = bot.online;
			const next = Boolean(online);
			if (prev !== next) {
				console.debug('[bots] online %s→%s id=%s', prev, next, id);
			}
			bot.online = next;
			if (!next) {
				useAgentsStore().removeByBot(id);
				// bot 离线 → 立即清除 DC 状态，避免 applySnapshot preserveOnline 误判
				bot.dcReady = false;
				bot.rtcPhase = 'idle';
			} else if (!bot.initialized) {
				// bot 上线且未初始化 → fullInit（ensureConnected 内部处理 WS）
				bot.initialized = true;
				const conn = useBotConnections().get(id);
				if (conn) {
					const attempt = bot.__initAttempt = (bot.__initAttempt || 0) + 1;
					this.__fullInit(id, conn).catch((err) => {
						if (bot.__initAttempt === attempt) bot.initialized = false;
						console.warn('[bots] fullInit failed for botId=%s: %s', id, err?.message);
					});
				}
			} else if (prev === false) {
				// bot offline→online → 恢复 RTC + 刷新
				useDashboardStore().loadDashboard(id).catch(() => {});
				this.__ensureRtc(id).catch(() => {});
			}
		},
		removeBotById(botId) {
			console.debug('[bots] remove id=%s', botId);
			const id = String(botId ?? '');
			closeRtcForBot(id);
			useBotConnections().disconnect(id);
			useSessionsStore().removeSessionsByBotId(id);
			useAgentRunsStore().removeByBot(id);
			_bridgedConns.delete(id);
			delete this.byId[id];
		},
		/**
		 * 应用 SSE 推送的全量 bot 快照
		 * @param {object[]} items - server 推送的 bot 列表
		 */
		applySnapshot(items) {
			const arr = Array.isArray(items) ? items : [];
			const newById = {};
			for (const b of arr) {
				const id = String(b.id ?? '');
				if (!id) continue;
				const existing = this.byId[id];
				if (existing) {
					const preserveOnline = existing.dcReady;
					Object.assign(existing, b, { id });
					if (preserveOnline) existing.online = true;
					newById[id] = existing;
				} else {
					newById[id] = createBotState({ ...b, id });
				}
			}
			// 清理快照中不再存在的 bot（RTC、sessions、agentRuns）
			for (const oldId of Object.keys(this.byId)) {
				if (!newById[oldId]) {
					closeRtcForBot(oldId);
					useAgentsStore().removeByBot(oldId);
					useSessionsStore().removeSessionsByBotId(oldId);
					useAgentRunsStore().removeByBot(oldId);
					_bridgedConns.delete(oldId);
				}
			}
			this.byId = newById;
			this.fetched = true;
			console.debug('[bots] snapshot applied %d bot(s)', arr.length);

			const botIds = arr.map((b) => String(b.id));
			const manager = useBotConnections();
			manager.syncConnections(botIds);
			for (const id of botIds) {
				this.__bridgeConn(id);
			}
			// server 重启后 RTC 内部重建可能已耗尽 → rtcPhase='failed'
			// 新快照到达时为这些 bot 重新尝试
			for (const id of botIds) {
				const bot = this.byId[id];
				if (bot?.online && bot.initialized && bot.rtcPhase === 'failed') {
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

			// 前台恢复 / 网络切换 → DC probe 探测存活性
			sigConn.on('foreground-resume', ({ elapsed }) => {
				for (const id of Object.keys(this.byId)) {
					this.__checkAndRecover(id, elapsed);
				}
			});
		},

		/**
		 * 桥接 DC 事件（每个 conn 实例只注册一次）
		 */
		__bridgeConn(botId) {
			const conn = useBotConnections().get(botId);
			if (!conn) return;
			if (_bridgedConns.get(botId) === conn) return;
			_bridgedConns.set(botId, conn);

			// event:agent DC 事件桥接
			conn.on('event:agent', (payload) => {
				useAgentRunsStore().__dispatch(payload);
			});

			// 确保全局信令桥接已注册
			this.__bridgeSignaling();

			// 新 bot + online + 未初始化 → 启动 fullInit
			// ensureConnected() 内部透明处理 WS 可用性（等待 WS 就绪）
			const bot = this.byId[botId];
			if (bot && bot.online && !bot.initialized) {
				bot.initialized = true;
				const attempt = bot.__initAttempt = (bot.__initAttempt || 0) + 1;
				this.__fullInit(botId, conn).catch((err) => {
					if (bot.__initAttempt === attempt) bot.initialized = false;
					console.warn('[bots] fullInit failed for botId=%s: %s', botId, err?.message);
				});
			}
		},

		/** 构建 RTC 回调（store 侧状态同步） */
		__rtcCallbacks(botId) {
			return {
				onRtcStateChange: (state, transportInfo) => {
					const bot = this.byId[botId];
					if (!bot) return;
					if (transportInfo) bot.rtcTransportInfo = transportInfo;
					if (state === 'connected') {
						// 被动恢复成功：DC 已就绪但 store 未主动发起
						const conn = useBotConnections().get(botId);
						if (conn?.rtc?.isReady && !bot.dcReady) {
							bot.dcReady = true;
							bot.rtcPhase = 'ready';
							this.__refreshIfStale(botId);
						}
					} else if (state === 'failed' || state === 'closed') {
						bot.dcReady = false;
						bot.disconnectedAt = Date.now();
						bot.rtcPhase = 'failed';
					}
				},
			};
		},

		/** 数据刷新（RTC 恢复后，断连间隔较长时触发） */
		__refreshIfStale(id) {
			const bot = this.byId[id];
			if (!bot?.initialized || bot.disconnectedAt <= 0) return;
			const gap = Date.now() - bot.disconnectedAt;
			bot.disconnectedAt = 0;
			if (gap < BRIEF_DISCONNECT_MS) return;
			console.debug('[bots] reconnect gap=%dms → refresh stores botId=%s', gap, id);
			useAgentsStore().loadAgents(id).catch(() => {});
			useSessionsStore().loadAllSessions().catch(() => {});
			useTopicsStore().loadAllTopics().catch(() => {});
			useDashboardStore().loadDashboard(id).catch(() => {});
		},

		/**
		 * 统一 RTC 建立/恢复入口。
		 * 触发点：bot offline→online、__bridgeConn 首次初始化、probe 失败。
		 * @param {string} id - botId
		 * @param {object} [opts]
		 * @param {boolean} [opts.forceRebuild] - 跳过 connected 检查，强制 rebuild
		 */
		async __ensureRtc(id, { forceRebuild = false } = {}) {
			if (_rtcInitInProgress.get(id)) return;
			_rtcInitInProgress.set(id, true);

			const conn = useBotConnections().get(id);
			if (!conn) { _rtcInitInProgress.delete(id); return; }

			try {
				const rtc = conn.rtc;
				// RTC 已连接且健康（非强制 rebuild）→ 确保 dcReady
				if (!forceRebuild && rtc && rtc.state === 'connected') {
					const bot = this.byId[id];
					if (bot && rtc.isReady) {
						bot.dcReady = true;
						bot.rtcPhase = 'ready';
					}
					return;
				}

				// 设置阶段：已就绪/强制重建 → recovering；否则 → building
				const bot = this.byId[id];
				if (bot) {
					bot.rtcPhase = (bot.rtcPhase === 'ready' || forceRebuild)
						? 'recovering' : 'building';
				}

				// 释放旧 RTC → rebuild
				closeRtcForBot(id);
				conn.clearRtc();

				let result = 'failed';
				let bailedOut = false;
				for (let i = 0; i < RTC_BUILD_MAX_RETRIES; i++) {
					if (!this.byId[id] || !this.byId[id].online) {
						console.debug('[bots] ensureRtc: bail-out (bot removed or offline) botId=%s', id);
						bailedOut = true;
						break;
					}
					result = await initRtc(id, conn, this.__rtcCallbacks(id));
					if (result === 'rtc') break;
					console.debug('[bots] ensureRtc: build attempt %d/%d failed botId=%s', i + 1, RTC_BUILD_MAX_RETRIES, id);
				}

				if (result === 'rtc') {
					const bot = this.byId[id];
					if (bot) {
						bot.dcReady = true;
						bot.rtcPhase = 'ready';
					}
					this.__refreshIfStale(id);
				} else if (bailedOut) {
					const bot = this.byId[id];
					if (bot) bot.rtcPhase = 'idle';
				} else {
					const bot = this.byId[id];
					if (bot) bot.rtcPhase = 'failed';
					console.warn('[bots] ensureRtc: all attempts exhausted, bot unreachable botId=%s', id);
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
			const bot = this.byId[id];
			if (!bot?.online) throw new Error('Bot is offline');

			// 等待 RTC 建立（DC 是唯一的 RPC 通道）
			await this.__ensureRtc(id);
			if (!conn.rtc?.isReady) throw new Error('RTC not available');
			if (bot) bot.dcReady = true;

			// DC 就绪，后续 RPC 走 DataChannel
			const info = await checkPluginVersion(conn);
			if (bot) {
				bot.pluginVersionOk = info.ok;
				bot.pluginInfo = { version: info.version, clawVersion: info.clawVersion };
			}
			if (!info.ok) {
				console.warn('[bots] plugin version %s for botId=%s', info.version ? 'outdated' : 'check failed (bot may be offline)', id);
				if (!info.version) throw new Error('Bot is offline');
			}
			await useAgentsStore().loadAgents(id);
			useSessionsStore().loadAllSessions();
			useTopicsStore().loadAllTopics();
			useDashboardStore().loadDashboard(id).catch(() => {});
		},

		/**
		 * DC 健康检查 + 恢复（前台恢复 / 网络切换时调用）
		 * @param {string} id - botId
		 * @param {number} elapsed - 距上次 WS 存活消息的时长
		 */
		async __checkAndRecover(id, elapsed) {
			try {
				if (_rtcInitInProgress.get(id)) return; // rebuild 进行中，跳过
				const bot = this.byId[id];
				if (!bot?.dcReady) return; // 无活跃 DC，由其它路径处理
				const conn = useBotConnections().get(id);
				const rtc = conn?.rtc;
				if (!rtc) return;

				// PC 已 failed/closed → 直接 rebuild
				if (rtc.state === 'failed' || rtc.state === 'closed') {
					bot.rtcPhase = 'recovering';
					this.__ensureRtc(id).catch(() => {});
					return;
				}
				// elapsed > 30s → werift consent 已过期，直接 rebuild
				if (elapsed > CONSENT_EXPIRY_MS) {
					bot.rtcPhase = 'recovering';
					this.__ensureRtc(id, { forceRebuild: true }).catch(() => {});
					return;
				}
				// probe DC 探测存活性
				const alive = await rtc.probe(DC_PROBE_TIMEOUT_MS);
				if (!alive && this.byId[id]) {
					this.byId[id].rtcPhase = 'recovering';
					this.__ensureRtc(id, { forceRebuild: true }).catch(() => {});
				}
			} catch (err) {
				console.warn('[bots] checkAndRecover failed botId=%s: %s', id, err?.message);
			}
		},
	},
});

/**
 * 获取就绪的 BotConnection（链式容错）
 * dcReady=false、bot 不存在、conn 不存在 → 均返回 null
 * @param {string} botId
 * @returns {import('../services/bot-connection.js').BotConnection | null}
 */
export function getReadyConn(botId) {
	const id = String(botId);
	const store = useBotsStore();
	if (!store.byId[id]?.dcReady) return null;
	return useBotConnections().get(id) ?? null;
}
