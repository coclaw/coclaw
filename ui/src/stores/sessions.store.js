import { defineStore } from 'pinia';

import { useAgentsStore } from './agents.store.js';
import { useClawsStore } from './claws.store.js';
import { getReadyConn } from './get-ready-conn.js';

// 模块级变量，避免被 Pinia reactive 代理包裹
let _loadingPromise = null;

/** 重置模块级状态（logout / 测试） */
export function __resetSessionsInternals() {
	_loadingPromise = null;
}

export const useSessionsStore = defineStore('sessions', {
	state: () => ({
		/** @type {{ sessionId: string, sessionKey: string, clawId: string, agentId: string }[]} */
		items: [],
		loading: false,
	}),
	actions: {
		setSessions(items) {
			this.items = Array.isArray(items) ? items : [];
		},
		removeSessionsByClawId(clawId) {
			const id = String(clawId ?? '');
			this.items = this.items.filter((s) => String(s.clawId) !== id);
		},
		async loadAllSessions() {
			// 已有加载中的请求，合流等待
			if (_loadingPromise) {
				console.debug('[sessions] loadAll: coalesced with pending request');
				return _loadingPromise;
			}
			const clawsStore = useClawsStore();
			const claws = clawsStore.items ?? [];
			if (!claws.length) {
				console.debug('[sessions] loadAll: skipped (no claws)');
				this.items = [];
				return;
			}
			const connectedClaws = claws.filter((b) => getReadyConn(b.id));
			if (!connectedClaws.length) {
				console.debug('[sessions] loadAll: skipped (no connected claws, total=%d)', claws.length);
				return;
			}
			this.loading = true;
			_loadingPromise = this.__doLoadAll(connectedClaws);
			try {
				await _loadingPromise;
			}
			finally {
				_loadingPromise = null;
				this.loading = false;
			}
		},
		async __doLoadAll(connectedClaws) {
			const queriedClawIds = new Set(connectedClaws.map((b) => String(b.id)));
			const clawsStore = useClawsStore();
			const results = await Promise.allSettled(
				connectedClaws.map((claw) => this.__fetchSessionsForClaw(claw.id)),
			);
			// fetch 失败的 claw：从 queriedClawIds 移除，保留其旧 sessions
			for (let i = 0; i < results.length; i++) {
				if (results[i].status !== 'fulfilled') {
					const failedId = String(connectedClaws[i].id);
					queriedClawIds.delete(failedId);
					console.warn('[sessions] claw sessions fetch failed clawId=%s:', failedId, results[i].reason);
				}
			}
			// 增量合并：保留未查询 claw 的已有 sessions，替换已查询 claw 的
			const seen = new Set();
			const merged = [];
			for (const item of this.items) {
				const bid = String(item.clawId);
				// 跳过本次查询范围内的（用新结果替换）和已不存在的 claw
				if (queriedClawIds.has(bid) || !clawsStore.byId[bid]) continue;
				const key = `${bid}:${item.sessionKey}`;
				if (!seen.has(key)) {
					seen.add(key);
					merged.push(item);
				}
			}
			for (const r of results) {
				if (r.status !== 'fulfilled') continue;
				for (const item of r.value) {
					const key = `${item.clawId}:${item.sessionKey}`;
					if (!seen.has(key)) {
						seen.add(key);
						merged.push(item);
					}
				}
			}
			this.items = merged;
			console.debug('[sessions] loadAll: merged %d session(s) (queried %d claw(s))', merged.length, queriedClawIds.size);
		},
		async __fetchSessionsForClaw(clawId) {
			const conn = getReadyConn(clawId);
			if (!conn) return [];

			const agentsStore = useAgentsStore();
			const agents = agentsStore.getAgentsByClaw(clawId);
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
						clawId: String(clawId),
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
