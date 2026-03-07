import { defineStore } from 'pinia';

import { createGatewayRpcClient } from '../services/gateway.ws.js';
import { useBotsStore } from './bots.store.js';

// 模块级变量，避免被 Pinia reactive 代理包裹
let _loadingPromise = null;

export const useSessionsStore = defineStore('sessions', {
	state: () => ({
		items: [],
		loading: false,
	}),
	actions: {
		setSessions(items) {
			this.items = Array.isArray(items) ? items : [];
		},
		removeSessionsByBotId(botId) {
			const id = String(botId ?? '');
			this.items = this.items.filter((s) => String(s.botId) !== id);
		},
		async loadAllSessions() {
			// 已有加载中的请求，合流等待
			if (_loadingPromise) {
				return _loadingPromise;
			}
			const botsStore = useBotsStore();
			const bots = botsStore.items ?? [];
			if (!bots.length) {
				this.items = [];
				return;
			}
			const onlineBots = bots.filter((b) => b.online);
			if (!onlineBots.length) {
				this.items = [];
				return;
			}
			this.loading = true;
			_loadingPromise = this.__doLoadAll(onlineBots, bots.length);
			try {
				await _loadingPromise;
			}
			finally {
				_loadingPromise = null;
				this.loading = false;
			}
		},
		async __doLoadAll(onlineBots, totalCount) {
			const results = await Promise.allSettled(
				onlineBots.map((bot) => this.__fetchSessionsForBot(bot.id)),
			);
			// 合并去重（以 sessionId 为 key，后者不覆盖先者）
			const seen = new Set();
			const merged = [];
			for (const r of results) {
				if (r.status !== 'fulfilled') {
					console.warn('[sessions] bot sessions fetch failed:', r.reason);
					continue;
				}
				for (const item of r.value) {
					if (!seen.has(item.sessionId)) {
						seen.add(item.sessionId);
						merged.push(item);
					}
				}
			}
			this.items = merged;
			console.debug('[sessions] loadAll: %d bot(s), merged %d session(s)', totalCount, merged.length);
		},
		async __fetchSessionsForBot(botId) {
			let client;
			try {
				client = await createGatewayRpcClient({ botId });
				const result = await client.request('nativeui.sessions.listAll', {
					agentId: 'main',
					limit: 200,
					cursor: 0,
				});
				console.log('[sessions] listAll raw response (botId=%s):', botId, result);
				const items = Array.isArray(result?.items) ? result.items : [];
				return items.map((item) => ({
					sessionId: item.sessionId,
					sessionKey: item.sessionKey ?? null,
					title: item.title ?? null,
					derivedTitle: item.derivedTitle ?? null,
					indexed: Boolean(item.indexed),
					botId,
				}));
			}
			finally {
				client?.close?.();
			}
		},
	},
});
