import { defineStore } from 'pinia';

import { useClawsStore } from './claws.store.js';
import { getReadyConn } from './get-ready-conn.js';

/** per-claw 飞行中请求合并，防止重连路径 + MainList watcher 同时触发时重复请求 */
const _loadingByClaw = new Map();

/** 校验 URL 是否可直接用于 <img src>（data URI 或 http(s) URL） */
function isRenderableUrl(url) {
	if (!url || typeof url !== 'string') return false;
	return /^(data:|https?:\/\/)/.test(url);
}

export const useAgentsStore = defineStore('agents', {
	state: () => ({
		/** @type {Object<string, { agents: object[], defaultId: string, loading: boolean, fetched: boolean }>} */
		byClaw: {},
	}),
	getters: {
		/**
		 * 获取指定 claw 的 agent 列表
		 * @returns {function(string): object[]}
		 */
		getAgentsByClaw() {
			return (clawId) => this.byClaw[clawId]?.agents ?? [];
		},
		/**
		 * 获取指定 claw 的单个 agent
		 * @returns {function(string, string): object|undefined}
		 */
		getAgent() {
			return (clawId, agentId) => this.byClaw[clawId]?.agents?.find((a) => a.id === agentId);
		},
		/**
		 * 获取 agent 的统一展示信息（name/avatarUrl/emoji），经完整 fallback 链处理
		 * @returns {function(string, string): { name: string, avatarUrl: string|null, emoji: string|null }}
		 */
		getAgentDisplay() {
			return (clawId, agentId) => {
				const entry = this.byClaw[clawId];
				const agent = entry?.agents?.find((a) => a.id === agentId);
				const ri = agent?.resolvedIdentity;
				const id = agent?.identity;
				const isDefault = agentId === (entry?.defaultId || 'main');
				const clawsStore = useClawsStore();
				const claw = clawsStore.byId[String(clawId)];
				const clawName = claw?.name || null;

				// 排除无信息量的名称（gateway 默认 "Assistant" 或与 agentId 相同的占位值）
				const pick = (v) => (v && v !== 'Assistant' && v !== agentId) ? v : null;
				// 按权威性 fallback：identity.get > identity(config) > name(config) > clawName(仅默认) > agentId
				const name = pick(ri?.name)
					|| pick(id?.name)
					|| pick(agent?.name)
					|| (isDefault ? pick(clawName) : null)
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
		 * 扁平列表：所有 claw 的所有 agent，附带 clawId/clawName/clawOnline
		 * @returns {object[]}
		 */
		allAgentItems() {
			const clawsStore = useClawsStore();
			const result = [];
			for (const claw of clawsStore.items) {
				const entry = this.byClaw[claw.id];
				const agents = entry?.agents ?? [];
				for (const agent of agents) {
					result.push({
						...agent,
						clawId: claw.id,
						clawName: claw.name || 'OpenClaw',
						clawOnline: Boolean(claw.online),
					});
				}
			}
			return result;
		},
	},
	actions: {
		/**
		 * 加载指定 claw 的 agent 列表
		 * @param {string} clawId
		 */
		async loadAgents(clawId) {
			const id = String(clawId);

			// 飞行中守卫：同一 claw 的并发调用复用已有 promise
			if (_loadingByClaw.has(id)) {
				console.debug('[agents] loadAgents in-flight guard hit for clawId=%s', id);
				return _loadingByClaw.get(id);
			}

			const conn = getReadyConn(id);
			if (!conn) {
				console.debug('[agents] loadAgents skipped: DC not ready for clawId=%s', id);
				return;
			}

			// 初始化 entry（key 统一为 string）
			if (!this.byClaw[id]) {
				this.byClaw[id] = { agents: [], defaultId: 'main', loading: false, fetched: false };
			}
			const entry = this.byClaw[id];
			entry.loading = true;

			const p = (async () => {
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
					console.debug('[agents] loaded %d agent(s) for clawId=%s defaultId=%s', agents.length, id, entry.defaultId);
				}
				catch (err) {
					console.warn('[agents] loadAgents failed for clawId=%s:', id, err?.message);
				}
				finally {
					entry.loading = false;
				}
			})();
			_loadingByClaw.set(id, p);
			p.finally(() => _loadingByClaw.delete(id));
			return p;
		},

		/**
		 * 为所有在线 claw 加载 agents
		 */
		async loadAllAgents() {
			const clawsStore = useClawsStore();
			const promises = [];
			for (const claw of clawsStore.items) {
				if (getReadyConn(claw.id)) {
					promises.push(this.loadAgents(String(claw.id)));
				}
			}
			await Promise.allSettled(promises);
		},

		/**
		 * 移除指定 claw 的 agent 数据
		 * @param {string} clawId
		 */
		removeByClaw(clawId) {
			delete this.byClaw[clawId];
		},
	},
});
