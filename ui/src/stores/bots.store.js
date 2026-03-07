import { defineStore } from 'pinia';

import { listBots } from '../services/bots.api.js';

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
				return;
			}
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
		},
		async loadBots() {
			this.loading = true;
			try {
				const bots = await listBots();
				this.items = bots;
				console.debug('[bots] loaded %d bot(s)', bots.length);
				return bots;
			}
			finally {
				this.loading = false;
			}
		},
	},
});
