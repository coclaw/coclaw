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
		},

		/**
		 * 注册全局信令 WS 事件桥接（仅注册一次）
		 */
		__bridgeSignaling() {
			if (this.__signalingBridged) return;
			this.__signalingBridged = true;
			const sigConn = useSignalingConnection();

			// 信令 WS 状态 → 同步到所有 bot 的 connState
			sigConn.on('state', (s) => {
				for (const [id, bot] of Object.entries(this.byId)) {
					const prev = bot.connState;
					bot.connState = s;
					if (s === 'disconnected') {
						bot.disconnectedAt = Date.now();
						bot.dcReady = false;
					}
					if (s === 'connected' && prev !== 'connected') {
						this.__onBotConnected(id);
					}
				}
			});

			// 前台恢复 → 触发 ICE restart 检查
			sigConn.on('foreground-resume', () => {
				for (const id of Object.keys(this.byId)) {
					const conn = useBotConnections().get(id);
					if (conn?.rtc?.tryIceRestart()) {
						console.debug('[bots] foreground-resume → ICE restart botId=%s', id);
					}
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

			// 同步当前信令 WS 状态到新 bot
			const bot = this.byId[botId];
			const sigState = useSignalingConnection().state;
			if (bot && sigState !== bot.connState) {
				const prev = bot.connState;
				bot.connState = sigState;
				if (sigState === 'connected' && prev !== 'connected') {
					this.__onBotConnected(botId);
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
					if (state === 'failed' || state === 'closed') bot.dcReady = false;
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
				console.debug('[bots] signaling reconnected botId=%s → ensureRtc', id);
				const disconnectedAt = bot.disconnectedAt;
				this.__ensureRtc(id).then(() => {
					const bot = this.byId[id];
					if (!bot || disconnectedAt <= 0) return;
					const gap = Date.now() - disconnectedAt;
					if (gap >= BRIEF_DISCONNECT_MS) {
						console.debug('[bots] reconnect gap=%dms ≥ %dms → refresh stores botId=%s', gap, BRIEF_DISCONNECT_MS, id);
						useAgentsStore().loadAgents(id).catch(() => {});
						useSessionsStore().loadAllSessions().catch(() => {});
						useTopicsStore().loadAllTopics().catch(() => {});
						useDashboardStore().loadDashboard(id).catch(() => {});
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
				// RTC 已连接且健康 → 确保 dcReady 正确
				if (rtc && rtc.state === 'connected') {
					const bot = this.byId[id];
					if (bot && rtc.isReady) bot.dcReady = true;
					return;
				}
				// 已有 RTC 但未关闭（disconnected 等）→ 尝试 ICE restart 快速恢复
				if (rtc && rtc.state !== 'closed' && rtc.state !== 'failed') {
					console.debug('[bots] ensureRtc: attempting ICE restart botId=%s', id);
					const ok = await rtc.attemptIceRestart(5000);
					if (ok) {
						console.debug('[bots] ensureRtc: ICE restart succeeded botId=%s', id);
						const bot = this.byId[id];
						if (bot) bot.dcReady = true;
						return;
					}
					console.debug('[bots] ensureRtc: ICE restart failed, will rebuild botId=%s', id);
				}

				// 释放旧 RTC
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
					if (bot) bot.dcReady = true;
				} else if (!bailedOut) {
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
