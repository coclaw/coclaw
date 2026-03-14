import { defineStore } from 'pinia';

import { listBots } from '../services/bots.api.js';
import { useBotConnections } from '../services/bot-connection-manager.js';
import { useAgentsStore } from './agents.store.js';
import { useSessionsStore } from './sessions.store.js';

// 跟踪已注册 state 监听的 botId，避免重复注册
const _awaitingConnIds = new Set();

export const useBotsStore = defineStore('bots', {
	state: () => ({
		items: [],
		loading: false,
		/** loadBots 至少成功完成过一次 */
		fetched: false,
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
			// 确保新 bot 有连接
			useBotConnections().connect(id);
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
				this.items = bots;
				this.fetched = true;
				console.debug('[bots] loaded %d bot(s)', bots.length);
				// 同步连接：为所有已绑定 bot 建立 WS
				const botIds = bots.map((b) => String(b.id));
				const manager = useBotConnections();
				manager.syncConnections(botIds);
				// WS 连接就绪后自动触发 session 加载
				this.__listenForReady(botIds, manager);
				return bots;
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
			for (const id of botIds) {
				if (_awaitingConnIds.has(id)) continue;
				const conn = manager.get(id);
				if (!conn || conn.state === 'connected') continue;
				_awaitingConnIds.add(id);
				const onState = (state) => {
					if (state === 'connected') {
						conn.off('state', onState);
						_awaitingConnIds.delete(id);
						console.debug('[bots] conn ready botId=%s → loadAgents+loadAllSessions', id);
						useAgentsStore().loadAgents(id).then(() => {
							useSessionsStore().loadAllSessions();
						});
					}
				};
				conn.on('state', onState);
			}
		},
	},
});
