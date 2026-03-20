import { defineStore } from 'pinia';

import { listBots } from '../services/bots.api.js';
import { useBotConnections } from '../services/bot-connection-manager.js';
import { useAgentsStore } from './agents.store.js';
import { useSessionsStore } from './sessions.store.js';
import { useTopicsStore } from './topics.store.js';
import { checkPluginVersion } from '../utils/plugin-version.js';

// 跟踪已注册 state 监听的 botId，避免重复注册
const _awaitingConnIds = new Set();

/** @internal 仅供测试重置 */
export function __resetAwaitingConnIds() { _awaitingConnIds.clear(); }

export const useBotsStore = defineStore('bots', {
	state: () => ({
		items: [],
		loading: false,
		/** loadBots 至少成功完成过一次 */
		fetched: false,
		/** 各 bot 插件版本是否满足最低要求 (botId → boolean) */
		pluginVersionOk: {},
	}),
	actions: {
		setBots(items) {
			this.items = Array.isArray(items) ? items : [];
		},
		addOrUpdateBot(bot) {
			if (!bot?.id) {
				return;
			}
			console.debug('[bots] upsert id=%s', bot.id);
			const id = String(bot.id);
			const index = this.items.findIndex((item) => String(item.id) === id);
			if (index >= 0) {
				this.items[index] = {
					...this.items[index],
					...bot,
				};
			}
			else {
				this.items = [
					{
						id,
						name: bot.name ?? null,
						online: Boolean(bot.online),
						lastSeenAt: bot.lastSeenAt ?? null,
						createdAt: bot.createdAt ?? null,
						updatedAt: bot.updatedAt ?? null,
					},
					...this.items,
				];
			}
			// 确保新 bot 有连接，并注册就绪回调加载 agents/sessions/topics
			const manager = useBotConnections();
			manager.connect(id);
			this.__listenForReady([id], manager);
		},
		updateBotOnline(botId, online) {
			const id = String(botId);
			const index = this.items.findIndex((item) => String(item.id) === id);
			if (index >= 0) {
				const prev = this.items[index].online;
				const next = Boolean(online);
				if (prev !== next) {
					console.debug('[bots] online %s→%s id=%s', prev, next, id);
				}
				this.items[index] = { ...this.items[index], online: next };
			}
		},
		removeBotById(botId) {
			console.debug('[bots] remove id=%s', botId);
			const id = String(botId ?? '');
			this.items = this.items.filter((item) => String(item.id) !== id);
			// 断开对应连接并清理关联 session
			useBotConnections().disconnect(id);
			useSessionsStore().removeSessionsByBotId(id);
		},
		async loadBots() {
			this.loading = true;
			try {
				const bots = await listBots();
				// 归一化 bot.id 为 string，确保全局 === 比较一致
				this.items = bots.map((b) => ({ ...b, id: String(b.id) }));
				this.fetched = true;
				console.debug('[bots] loaded %d bot(s)', bots.length);
				// 同步连接：为所有已绑定 bot 建立 WS
				const botIds = bots.map((b) => String(b.id));
				const manager = useBotConnections();
				manager.syncConnections(botIds);
				// WS 连接就绪后自动触发 session 加载
				this.__listenForReady(botIds, manager);
				return this.items;
			}
			finally {
				this.loading = false;
			}
		},
		/**
		 * 为尚未就绪的 WS 连接注册一次性 state 监听，
		 * 连接变为 connected 时触发 loadAllSessions
		 */
		__listenForReady(botIds, manager) {
			const fire = async (id, conn) => {
				// 静默检查插件版本，记录结果但不阻断
				const versionOk = await checkPluginVersion(conn);
				this.pluginVersionOk = { ...this.pluginVersionOk, [id]: versionOk };
				if (!versionOk) {
					console.warn('[bots] plugin version outdated for botId=%s', id);
				}
				await useAgentsStore().loadAgents(id);
				useSessionsStore().loadAllSessions();
				useTopicsStore().loadAllTopics();
			};
			const catchFire = (id, conn) => {
				fire(id, conn).catch((err) => {
					console.warn('[bots] fire failed for botId=%s: %s', id, err?.message);
				});
			};
			for (const id of botIds) {
				const conn = manager.get(id);
				if (!conn) continue;
				if (conn.state === 'connected') {
					console.debug('[bots] conn already ready botId=%s → loadAgents', id);
					catchFire(id, conn);
					continue;
				}
				if (_awaitingConnIds.has(id)) continue;
				_awaitingConnIds.add(id);
				const onState = (state) => {
					if (state === 'connected') {
						conn.off('state', onState);
						_awaitingConnIds.delete(id);
						console.debug('[bots] conn ready botId=%s → loadAgents', id);
						catchFire(id, conn);
					}
				};
				conn.on('state', onState);
			}
		},
	},
});
