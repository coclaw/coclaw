import { defineStore } from 'pinia';

import { useBotConnections } from '../services/bot-connection-manager.js';
import { useBotsStore } from './bots.store.js';

/** 校验 URL 是否可直接用于 <img src>（data URI 或 http(s) URL） */
function isRenderableUrl(url) {
	if (!url || typeof url !== 'string') return false;
	return /^(data:|https?:\/\/)/.test(url);
}

export const useAgentsStore = defineStore('agents', {
	state: () => ({
		/** @type {Object<string, { agents: object[], defaultId: string, loading: boolean, fetched: boolean }>} */
		byBot: {},
	}),
	getters: {
		/**
		 * 获取指定 bot 的 agent 列表
		 * @returns {function(string): object[]}
		 */
		getAgentsByBot() {
			return (botId) => this.byBot[botId]?.agents ?? [];
		},
		/**
		 * 获取指定 bot 的单个 agent
		 * @returns {function(string, string): object|undefined}
		 */
		getAgent() {
			return (botId, agentId) => this.byBot[botId]?.agents?.find((a) => a.id === agentId);
		},
		/**
		 * 获取 agent 的统一展示信息（name/avatarUrl/emoji），经完整 fallback 链处理
		 * @returns {function(string, string): { name: string, avatarUrl: string|null, emoji: string|null }}
		 */
		getAgentDisplay() {
			return (botId, agentId) => {
				const entry = this.byBot[botId];
				const agent = entry?.agents?.find((a) => a.id === agentId);
				const ri = agent?.resolvedIdentity;
				const id = agent?.identity;
				const isDefault = agentId === (entry?.defaultId || 'main');
				const botsStore = useBotsStore();
				const bot = botsStore.items.find((b) => String(b.id) === String(botId));
				const botName = bot?.name || null;

				// name fallback: resolvedIdentity.name → identity.name → botName(仅默认agent) → agent.name → agentId
				const name = ri?.name
					|| id?.name
					|| (isDefault ? botName : null)
					|| agent?.name
					|| agentId
					|| 'Agent';

				// avatarUrl: 仅 agents.list 的 identity.avatarUrl（gateway 已转 data URI），校验可渲染性
				const rawUrl = id?.avatarUrl;
				const avatarUrl = isRenderableUrl(rawUrl) ? rawUrl : null;

				// emoji: resolvedIdentity.emoji → identity.emoji
				const emoji = ri?.emoji || id?.emoji || null;

				return { name, avatarUrl, emoji };
			};
		},
		/**
		 * 从 sessionKey 解析 agentId
		 * @returns {function(string): string|null}
		 */
		parseAgentId() {
			return (sessionKey) => sessionKey?.match(/^agent:([^:]+):/)?.[1] ?? null;
		},
		/**
		 * 扁平列表：所有 bot 的所有 agent，附带 botId/botName/botOnline
		 * @returns {object[]}
		 */
		allAgentItems() {
			const botsStore = useBotsStore();
			const result = [];
			for (const bot of botsStore.items) {
				const entry = this.byBot[bot.id];
				const agents = entry?.agents ?? [];
				for (const agent of agents) {
					result.push({
						...agent,
						botId: bot.id,
						botName: bot.name || 'OpenClaw',
						botOnline: Boolean(bot.online),
					});
				}
			}
			return result;
		},
	},
	actions: {
		/**
		 * 加载指定 bot 的 agent 列表
		 * @param {string} botId
		 */
		async loadAgents(botId) {
			const id = String(botId);
			const conn = useBotConnections().get(id);
			if (!conn || conn.state !== 'connected') {
				console.debug('[agents] loadAgents skipped: no connected WS for botId=%s', id);
				return;
			}

			// 初始化 entry（key 统一为 string）
			if (!this.byBot[id]) {
				this.byBot[id] = { agents: [], defaultId: 'main', loading: false, fetched: false };
			}
			const entry = this.byBot[id];
			entry.loading = true;

			try {
				const result = await conn.request('agents.list', {});
				const agents = Array.isArray(result?.agents) ? result.agents : [];
				entry.defaultId = result?.defaultId || 'main';

				// 对每个 agent 调 agent.identity.get 补充完整 identity
				const enriched = await Promise.all(
					agents.map(async (agent) => {
						try {
							const ident = await conn.request('agent.identity.get', { agentId: agent.id });
							return { ...agent, resolvedIdentity: ident ?? null };
						}
						catch (err) {
							console.debug('[agents] agent.identity.get failed agentId=%s: %s', agent.id, err?.message);
							return { ...agent, resolvedIdentity: null };
						}
					}),
				);
				entry.agents = enriched;
				entry.fetched = true;
				console.debug('[agents] loaded %d agent(s) for botId=%s defaultId=%s', agents.length, id, entry.defaultId);
			}
			catch (err) {
				console.warn('[agents] loadAgents failed for botId=%s:', id, err?.message);
			}
			finally {
				entry.loading = false;
			}
		},

		/**
		 * 为所有在线 bot 加载 agents
		 */
		async loadAllAgents() {
			const botsStore = useBotsStore();
			const manager = useBotConnections();
			const promises = [];
			for (const bot of botsStore.items) {
				const conn = manager.get(String(bot.id));
				if (conn && conn.state === 'connected') {
					promises.push(this.loadAgents(String(bot.id)));
				}
			}
			await Promise.allSettled(promises);
		},

		/**
		 * 移除指定 bot 的 agent 数据
		 * @param {string} botId
		 */
		removeByBot(botId) {
			delete this.byBot[botId];
		},
	},
});
