import { defineStore } from 'pinia';

import { listBots } from '../services/bots.api.js';
import { useBotConnections } from '../services/bot-connection-manager.js';
import { useSessionsStore } from './sessions.store.js';

export const useBotsStore = defineStore('bots', {
	state: () => ({
		items: [],
		loading: false,
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
				this.items[index] = { ...this.items[index], online: Boolean(online) };
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
				console.debug('[bots] loaded %d bot(s)', bots.length);
				// 同步连接：为所有已绑定 bot 建立 WS
				const botIds = bots.map((b) => String(b.id));
				useBotConnections().syncConnections(botIds);
				return bots;
			}
			finally {
				this.loading = false;
			}
		},
	},
});
