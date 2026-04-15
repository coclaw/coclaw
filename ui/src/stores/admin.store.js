import { defineStore } from 'pinia';

import {
	fetchAdminDashboard,
	fetchAdminClaws,
	fetchAdminUsers,
} from '../services/admin.api.js';

/**
 * @typedef {{
 *   items: object[],
 *   nextCursor: string|null,
 *   loading: boolean,
 *   search: string,
 *   error: string|null,
 * }} ListState
 */

function emptyList() {
	return { items: [], nextCursor: null, loading: false, search: '', error: null };
}

export const useAdminStore = defineStore('admin', {
	state: () => ({
		/** @type {object|null} dashboard 聚合数据 */
		dashboard: null,
		dashboardLoading: false,
		dashboardError: null,
		/** @type {ListState} */
		claws: emptyList(),
		/** @type {ListState} */
		users: emptyList(),
	}),

	actions: {
		async fetchDashboard() {
			this.dashboardLoading = true;
			this.dashboardError = null;
			try {
				this.dashboard = await fetchAdminDashboard();
			}
			catch (err) {
				this.dashboardError = err?.response?.data?.message ?? err?.message ?? 'load failed';
				throw err;
			}
			finally {
				this.dashboardLoading = false;
			}
		},

		/**
		 * 拉取实例列表（重置模式：替换 items 和 cursor）。
		 * @param {{ cursor?: string, search?: string, limit?: number }} [opts]
		 */
		async fetchClaws(opts = {}) {
			const search = opts.search ?? this.claws.search;
			this.claws.loading = true;
			this.claws.error = null;
			try {
				const res = await fetchAdminClaws({
					cursor: opts.cursor,
					limit: opts.limit,
					search: search || undefined,
				});
				this.claws.items = res.items;
				this.claws.nextCursor = res.nextCursor;
				this.claws.search = search;
			}
			catch (err) {
				this.claws.error = err?.response?.data?.message ?? err?.message ?? 'load failed';
				throw err;
			}
			finally {
				this.claws.loading = false;
			}
		},

		/** 加载下一页（追加到 items）。nextCursor 为空或正在加载时直接返回。 */
		async fetchMoreClaws(opts = {}) {
			if (this.claws.loading || !this.claws.nextCursor) return;
			this.claws.loading = true;
			this.claws.error = null;
			try {
				const res = await fetchAdminClaws({
					cursor: this.claws.nextCursor,
					limit: opts.limit,
					search: this.claws.search || undefined,
				});
				this.claws.items.push(...res.items);
				this.claws.nextCursor = res.nextCursor;
			}
			catch (err) {
				this.claws.error = err?.response?.data?.message ?? err?.message ?? 'load failed';
				throw err;
			}
			finally {
				this.claws.loading = false;
			}
		},

		resetClaws() {
			this.claws = emptyList();
		},

		async fetchUsers(opts = {}) {
			const search = opts.search ?? this.users.search;
			this.users.loading = true;
			this.users.error = null;
			try {
				const res = await fetchAdminUsers({
					cursor: opts.cursor,
					limit: opts.limit,
					search: search || undefined,
				});
				this.users.items = res.items;
				this.users.nextCursor = res.nextCursor;
				this.users.search = search;
			}
			catch (err) {
				this.users.error = err?.response?.data?.message ?? err?.message ?? 'load failed';
				throw err;
			}
			finally {
				this.users.loading = false;
			}
		},

		async fetchMoreUsers(opts = {}) {
			if (this.users.loading || !this.users.nextCursor) return;
			this.users.loading = true;
			this.users.error = null;
			try {
				const res = await fetchAdminUsers({
					cursor: this.users.nextCursor,
					limit: opts.limit,
					search: this.users.search || undefined,
				});
				this.users.items.push(...res.items);
				this.users.nextCursor = res.nextCursor;
			}
			catch (err) {
				this.users.error = err?.response?.data?.message ?? err?.message ?? 'load failed';
				throw err;
			}
			finally {
				this.users.loading = false;
			}
		},

		resetUsers() {
			this.users = emptyList();
		},

		/** SSE snapshot：标记列表中命中的 claw 为 online，其余为 offline */
		applyOnlineSnapshot(onlineIds) {
			const set = new Set((onlineIds ?? []).map(String));
			for (const c of this.claws.items) {
				c.online = set.has(String(c.id));
			}
		},

		/** SSE statusChanged：更新对应 claw 的在线状态 */
		updateClawStatus(clawId, online) {
			const id = String(clawId);
			for (const c of this.claws.items) {
				if (String(c.id) === id) {
					c.online = !!online;
					break;
				}
			}
		},

		/** SSE infoUpdated：部分字段覆盖对应 claw */
		updateClawInfo(clawId, patch = {}) {
			const id = String(clawId);
			for (const c of this.claws.items) {
				if (String(c.id) === id) {
					for (const [k, v] of Object.entries(patch)) {
						if (v !== undefined) c[k] = v;
					}
					break;
				}
			}
		},
	},
});
