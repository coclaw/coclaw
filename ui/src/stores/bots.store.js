import { defineStore } from 'pinia';

import { listBots } from '../services/bots.api.js';
import { useBotConnections } from '../services/bot-connection-manager.js';
import { useAgentRunsStore } from './agent-runs.store.js';
import { useAgentsStore } from './agents.store.js';
import { useSessionsStore } from './sessions.store.js';
import { useDashboardStore } from './dashboard.store.js';
import { useTopicsStore } from './topics.store.js';
import { BRIEF_DISCONNECT_MS } from '../services/bot-connection.js';
import { checkPluginVersion } from '../utils/plugin-version.js';
import { initRtcAndSelectTransport, closeRtcForBot } from '../services/webrtc-connection.js';

// 跟踪已桥接的 conn 实例（botId → BotConnection），避免重复注册
const _bridgedConns = new Map();
/** __ensureRtc 并发防护（botId → true） */
const _rtcInitInProgress = new Map();

const RTC_BUILD_MAX_RETRIES = 3;

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
		// 连接状态（桥接写入）
		connState: 'disconnected',
		lastAliveAt: 0,
		disconnectedAt: 0,
		// 初始化标记（首次 vs 重连）
		initialized: false,
		// 传输与插件（运行时写入）
		transportMode: null,
		pluginVersionOk: null,
		pluginInfo: null,
		rtcState: null,
		rtcTransportInfo: null,
	};
}

export const useBotsStore = defineStore('bots', {
	state: () => ({
		byId: {},
		loading: false,
		/** loadBots 至少成功完成过一次 */
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
			} else if (!bot.initialized && bot.connState === 'connected') {
				// bot 上线但初始化未成功（隧道建立前 __fullInit 失败）→ 重试
				this.__onBotConnected(id);
			} else if (prev === false && bot.connState === 'connected') {
				// bot 从离线恢复在线 → 刷新 dashboard + 建立/恢复 RTC
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
		async loadBots() {
			this.loading = true;
			try {
				const bots = await listBots();
				const newById = {};
				for (const b of bots) {
					const id = String(b.id);
					const existing = this.byId[id];
					if (existing) {
						// 保留运行时状态（connState、initialized 等），更新基础信息
						// 若 WS 实际已连接，不让 HTTP 快照的 online 覆盖本地值
						const preserveOnline = existing.connState === 'connected';
						Object.assign(existing, b, { id });
						if (preserveOnline) existing.online = true;
						newById[id] = existing;
					} else {
						newById[id] = createBotState({ ...b, id });
					}
				}
				this.byId = newById;
				this.fetched = true;
				console.debug('[bots] loaded %d bot(s)', bots.length);

				const botIds = bots.map((b) => String(b.id));
				const manager = useBotConnections();
				manager.syncConnections(botIds);

				for (const id of botIds) {
					this.__bridgeConn(id);
				}
				return this.items;
			} finally {
				this.loading = false;
			}
		},

		/**
		 * 桥接 conn state → byId[botId]（每个 conn 实例只注册一次）
		 */
		__bridgeConn(botId) {
			const conn = useBotConnections().get(botId);
			if (!conn) return;
			if (_bridgedConns.get(botId) === conn) return;
			_bridgedConns.set(botId, conn);

			conn.on('session-expired', () => {
				console.warn('[bots] session-expired from botId=%s', botId);
				window.dispatchEvent(new CustomEvent('auth:session-expired'));
			});

			// event:agent 集中桥接（阶段三）
			conn.on('event:agent', (payload) => {
				useAgentRunsStore().__dispatch(payload);
			});

			conn.on('state', (s) => {
				const bot = this.byId[botId];
				if (!bot) return;
				const prev = bot.connState;
				bot.connState = s;
				if (s === 'disconnected') {
					bot.disconnectedAt = conn.disconnectedAt;
				}
				// connected 转换 → 触发初始化/重连
				if (s === 'connected' && prev !== 'connected') {
					this.__onBotConnected(botId);
				}
			});

			// lastAliveAt 实时同步（每收到 WS 消息时更新）
			conn.__onAlive = (ts) => {
				const bot = this.byId[botId];
				if (bot) bot.lastAliveAt = ts;
			};

			// 同步当前状态（conn 可能已经 connected）
			const bot = this.byId[botId];
			if (bot && conn.state !== bot.connState) {
				const prev = bot.connState;
				bot.connState = conn.state;
				if (conn.state === 'connected') {
					bot.lastAliveAt = conn.lastAliveAt || Date.now();
					if (prev !== 'connected') {
						this.__onBotConnected(botId);
					}
				}
			}
		},

		/** 构建 RTC 回调（store 侧状态同步） */
		__rtcCallbacks(botId) {
			return {
				onTransportMode: (mode) => {
					const bot = this.byId[botId];
					if (bot) bot.transportMode = mode;
				},
				onRtcStateChange: (state, transportInfo) => {
					const bot = this.byId[botId];
					if (!bot) return;
					bot.rtcState = state;
					if (transportInfo) bot.rtcTransportInfo = transportInfo;
				},
			};
		},

		/**
		 * bot 连接就绪：首次 → 完整初始化；重连 → 传输选择 + 按断连时长刷新
		 */
		__onBotConnected(id) {
			const bot = this.byId[id];
			if (!bot) return;
			const conn = useBotConnections().get(id);
			if (!conn) return;

			if (!bot.initialized) {
				console.debug('[bots] conn ready botId=%s → full init', id);
				bot.initialized = true;
				const attempt = bot.__initAttempt = (bot.__initAttempt || 0) + 1;
				this.__fullInit(id, conn).catch((err) => {
					if (bot.__initAttempt === attempt) bot.initialized = false;
					console.warn('[bots] fullInit failed for botId=%s: %s', id, err?.message);
				});
			} else {
				console.debug('[bots] ws reconnected botId=%s → re-select transport', id);
				// WS 重连后无条件重建 RTC：旧 RTC 在断连期间必然失效，
				// 且 loadBots 的 preserveOnline 可能绕过 updateBotOnline 设 online=true，
				// 导致后续 SSE online 推送成 no-op，__ensureRtc 不再被触发
				this.__ensureRtc(id).catch(() => {});
				if (conn.disconnectedAt > 0) {
					const gap = Date.now() - conn.disconnectedAt;
					if (gap >= BRIEF_DISCONNECT_MS) {
						console.debug('[bots] reconnect gap=%dms ≥ %dms → refresh stores botId=%s', gap, BRIEF_DISCONNECT_MS, id);
						this.loadBots().catch(() => {});
						useAgentsStore().loadAgents(id).catch(() => {});
						useSessionsStore().loadAllSessions().catch(() => {});
						useTopicsStore().loadAllTopics().catch(() => {});
						useDashboardStore().loadDashboard(id).catch(() => {});
					}
				}
			}
		},

		/**
		 * 统一 RTC 建立/恢复入口。
		 * 触发点：bot offline→online、WS 重连且 bot 在线。
		 * 流程：ICE restart(5s) → close → build(retries) → WS fallback。
		 */
		async __ensureRtc(id) {
			if (_rtcInitInProgress.get(id)) return;
			_rtcInitInProgress.set(id, true);

			const conn = useBotConnections().get(id);
			if (!conn) { _rtcInitInProgress.delete(id); return; }

			try {
				// 已有 RTC 且未关闭 → 尝试 ICE restart 快速恢复
				const rtc = conn.rtc;
				if (rtc && rtc.state !== 'closed' && rtc.state !== 'failed') {
					console.debug('[bots] ensureRtc: attempting ICE restart botId=%s', id);
					const ok = await rtc.attemptIceRestart(5000);
					if (ok) {
						console.debug('[bots] ensureRtc: ICE restart succeeded botId=%s', id);
						return;
					}
					console.debug('[bots] ensureRtc: ICE restart failed, will rebuild botId=%s', id);
				}

				// 释放旧 RTC
				closeRtcForBot(id);
				conn.clearRtc();

				// build with retries（中间轮次不设 transportMode='ws'，由最终结果决定）
				let result = 'ws';
				for (let i = 0; i < RTC_BUILD_MAX_RETRIES; i++) {
					// bail-out：bot 被删除或 WS 已断连时立即退出，避免阻塞后续恢复
					if (!this.byId[id] || conn.state !== 'connected') {
						console.debug('[bots] ensureRtc: bail-out (bot removed or WS disconnected) botId=%s', id);
						break;
					}
					const isLastAttempt = i === RTC_BUILD_MAX_RETRIES - 1;
					result = await initRtcAndSelectTransport(
						id, conn, this.__rtcCallbacks(id),
						{ skipWsFallback: !isLastAttempt },
					);
					if (result === 'rtc') break;
					console.debug('[bots] ensureRtc: build attempt %d/%d failed botId=%s', i + 1, RTC_BUILD_MAX_RETRIES, id);
				}

				if (result !== 'rtc') {
					console.debug('[bots] ensureRtc: all attempts exhausted, WS fallback botId=%s', id);
				}
			} finally {
				_rtcInitInProgress.delete(id);
			}
		},

		/**
		 * 首次连接初始化：版本检查 + 传输选择 + 数据加载
		 */
		async __fullInit(id, conn) {
			const bot = this.byId[id];
			// RTC 仅在 bot 在线时尝试（bridge 就绪才能转发 rtc:offer）
			if (bot?.online) {
				this.__ensureRtc(id).catch(() => {});
			}
			const info = await checkPluginVersion(conn);
			if (bot) {
				bot.pluginVersionOk = info.ok;
				bot.pluginInfo = { version: info.version, clawVersion: info.clawVersion };
			}
			if (!info.ok) {
				console.warn('[bots] plugin version %s for botId=%s', info.version ? 'outdated' : 'check failed (bot may be offline)', id);
			}
			await useAgentsStore().loadAgents(id);
			useSessionsStore().loadAllSessions();
			useTopicsStore().loadAllTopics();
			useDashboardStore().loadDashboard(id).catch(() => {});
		},
	},
});
