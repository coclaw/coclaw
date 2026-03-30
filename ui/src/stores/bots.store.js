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
import { initRtc, closeRtcForBot } from '../services/webrtc-connection.js';

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
		// 插件状态（运行时写入）
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
		/**
		 * 应用 SSE 推送的全量 bot 快照（替代 loadBots 作为主要数据源）
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
					const preserveOnline = existing.connState === 'connected';
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
		},
		/**
		 * 通过 HTTP 全量获取 bot 列表。
		 * 注：UI 主流程已通过 SSE bot.snapshot 获取 bot 列表，此方法作为后备保留。
		 */
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

			conn.on('bot-unbound', () => {
				console.debug('[bots] bot-unbound via WS botId=%s', botId);
				this.removeBotById(botId);
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
				console.debug('[bots] ws reconnected botId=%s → re-establish RTC', id);
				// 单次 RTC 尝试：initRtc 内部有幂等守卫（RTC 仍健康则 no-op）
				// 不使用 __ensureRtc（3 轮重试过重，会在 tab 切换等场景造成长时间阻塞）
				initRtc(id, conn, this.__rtcCallbacks(id)).then((result) => {
					if (result !== 'rtc') return;
					if (conn.disconnectedAt > 0) {
						const gap = Date.now() - conn.disconnectedAt;
						if (gap >= BRIEF_DISCONNECT_MS) {
							console.debug('[bots] reconnect gap=%dms ≥ %dms → refresh stores botId=%s', gap, BRIEF_DISCONNECT_MS, id);
							useAgentsStore().loadAgents(id).catch(() => {});
							useSessionsStore().loadAllSessions().catch(() => {});
							useTopicsStore().loadAllTopics().catch(() => {});
							useDashboardStore().loadDashboard(id).catch(() => {});
						}
					}
				}).catch(() => {});
			}
		},

		/**
		 * 统一 RTC 建立/恢复入口。
		 * 触发点：bot offline→online、WS 重连且 bot 在线。
		 * 流程：ICE restart(5s) → close → build(retries)。
		 */
		async __ensureRtc(id) {
			if (_rtcInitInProgress.get(id)) return;
			_rtcInitInProgress.set(id, true);

			const conn = useBotConnections().get(id);
			if (!conn) { _rtcInitInProgress.delete(id); return; }

			try {
				const rtc = conn.rtc;
				// RTC 已连接且健康 → 无需操作
				if (rtc && rtc.state === 'connected') return;
				// 已有 RTC 但未关闭（disconnected 等）→ 尝试 ICE restart 快速恢复
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

				let result = 'failed';
				for (let i = 0; i < RTC_BUILD_MAX_RETRIES; i++) {
					if (!this.byId[id] || conn.state !== 'connected') {
						console.debug('[bots] ensureRtc: bail-out (bot removed or WS disconnected) botId=%s', id);
						break;
					}
					result = await initRtc(id, conn, this.__rtcCallbacks(id));
					if (result === 'rtc') break;
					console.debug('[bots] ensureRtc: build attempt %d/%d failed botId=%s', i + 1, RTC_BUILD_MAX_RETRIES, id);
				}

				if (result !== 'rtc') {
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
	},
});
