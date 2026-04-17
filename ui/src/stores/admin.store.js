import { defineStore } from 'pinia';

import {
	fetchAdminDashboard,
	fetchAdminClaws,
	fetchAdminUsers,
} from '../services/admin.api.js';
import { connectAdminStream } from '../services/admin-stream.js';

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
		/** @type {object|null} dashboard 聚合数据（弱实时） */
		dashboard: null,
		dashboardLoading: false,
		dashboardError: null,
		/** @type {ListState} */
		claws: emptyList(),
		/** @type {ListState} */
		users: emptyList(),
		/**
		 * 在线 claw id 集合（SSE 唯一事实源，强实时）。
		 * 更新时整体替换以触发 Vue 响应式。
		 * @type {Set<string>}
		 */
		onlineClawIds: new Set(),
		/** SSE snapshot 是否已到达 —— 用于模板显示占位符避免首屏闪 0 */
		hasOnlineSnapshot: false,
		/** 连接引用计数 */
		__streamRefs: 0,
		/** connectAdminStream 返回的句柄 */
		__streamHandle: null,
	}),

	getters: {
		/** 当前在线 claw 总数 */
		onlineClawCount: (state) => state.onlineClawIds.size,
		/** 指定 claw 是否在线 */
		isClawOnline: (state) => (id) => state.onlineClawIds.has(String(id)),
	},

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

		/**
		 * 启动 SSE 订阅（引用计数，从 0 升到 1 时真正建连）。
		 * 由 AdminLayout.mounted 调用；多个调用方互不干扰。
		 */
		startStream() {
			this.__streamRefs += 1;
			if (this.__streamRefs > 1) return;
			this.__streamHandle = connectAdminStream({
				onSnapshot: (ids) => this.applyOnlineSnapshot(ids),
				onStatusChanged: ({ clawId, online }) => this.updateClawStatus(clawId, online),
				onInfoUpdated: ({ clawId, ...patch }) => this.updateClawInfo(clawId, patch),
			});
		},

		/**
		 * 停止 SSE 订阅（引用计数归零时真正断连，并清空在线集合）。
		 * 由 AdminLayout.beforeUnmount 调用。
		 */
		stopStream() {
			if (this.__streamRefs === 0) return;
			this.__streamRefs -= 1;
			if (this.__streamRefs > 0) return;
			if (this.__streamHandle) {
				this.__streamHandle.close();
				this.__streamHandle = null;
			}
			this.onlineClawIds = new Set();
			this.hasOnlineSnapshot = false;
		},

		/** SSE snapshot：替换 onlineClawIds，并同步列表 items[].online */
		applyOnlineSnapshot(onlineIds) {
			this.onlineClawIds = new Set((onlineIds ?? []).map(String));
			this.hasOnlineSnapshot = true;
			for (const c of this.claws.items) {
				c.online = this.onlineClawIds.has(String(c.id));
			}
		},

		/** SSE statusChanged：更新 onlineClawIds 成员 + 同步对应列表项 */
		updateClawStatus(clawId, online) {
			const id = String(clawId);
			const next = new Set(this.onlineClawIds);
			if (online) next.add(id);
			else next.delete(id);
			this.onlineClawIds = next;
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
