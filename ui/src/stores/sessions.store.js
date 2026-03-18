import { defineStore } from 'pinia';

import { useBotConnections } from '../services/bot-connection-manager.js';
import { useAgentsStore } from './agents.store.js';
import { useBotsStore } from './bots.store.js';

// 模块级变量，避免被 Pinia reactive 代理包裹
let _loadingPromise = null;

export const useSessionsStore = defineStore('sessions', {
	state: () => ({
		/** @type {{ sessionId: string, sessionKey: string, botId: string, agentId: string }[]} */
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
				console.debug('[sessions] loadAll: coalesced with pending request');
				return _loadingPromise;
			}
			const botsStore = useBotsStore();
			const bots = botsStore.items ?? [];
			if (!bots.length) {
				console.debug('[sessions] loadAll: skipped (no bots)');
				this.items = [];
				return;
			}
			// 筛选有已连接 WS 的 bot
			const manager = useBotConnections();
			const connectedBots = bots.filter((b) => {
				const conn = manager.get(b.id);
				return conn && conn.state === 'connected';
			});
			if (!connectedBots.length) {
				console.debug('[sessions] loadAll: skipped (no connected bots, total=%d)', bots.length);
				this.items = [];
				return;
			}
			this.loading = true;
			_loadingPromise = this.__doLoadAll(connectedBots);
			try {
				await _loadingPromise;
			}
			finally {
				_loadingPromise = null;
				this.loading = false;
			}
		},
		async __doLoadAll(connectedBots) {
			const results = await Promise.allSettled(
				connectedBots.map((bot) => this.__fetchSessionsForBot(bot.id)),
			);
			// 合并去重（以 botId:sessionKey 为 key）
			const seen = new Set();
			const merged = [];
			for (const r of results) {
				if (r.status !== 'fulfilled') {
					console.warn('[sessions] bot sessions fetch failed:', r.reason);
					continue;
				}
				for (const item of r.value) {
					const key = `${item.botId}:${item.sessionKey}`;
					if (!seen.has(key)) {
						seen.add(key);
						merged.push(item);
					}
				}
			}
			this.items = merged;
			console.debug('[sessions] loadAll: merged %d session(s)', merged.length);
		},
		async __fetchSessionsForBot(botId) {
			const conn = useBotConnections().get(String(botId));
			if (!conn || conn.state !== 'connected') return [];

			const agentsStore = useAgentsStore();
			const agents = agentsStore.getAgentsByBot(botId);
			// 若 agentsStore 未加载完成，fallback 到 ['main']
			const agentIds = agents.length ? agents.map((a) => a.id) : ['main'];

			const results = await Promise.allSettled(
				agentIds.map(async (agentId) => {
					const sessionKey = `agent:${agentId}:main`;
					const hist = await conn.request('chat.history', {
						sessionKey,
						limit: 1,
					});
					return {
						sessionId: hist?.sessionId ?? '',
						sessionKey,
						botId: String(botId),
						agentId,
					};
				}),
			);

			const items = [];
			for (const r of results) {
				if (r.status !== 'fulfilled' || !r.value.sessionId) continue;
				items.push(r.value);
			}
			return items;
		},
	},
});
