/**
 * 聊天 Store — 从 ChatPage 中剥离的通信/消息管理逻辑
 * 职责：当前 session 的消息列表、发送、streaming、agent 事件处理
 */
import { defineStore } from 'pinia';

import { useBotConnections } from '../services/bot-connection-manager.js';
import { fileToBase64 } from '../utils/file-helper.js';
import { useSessionsStore } from './sessions.store.js';
import { useBotsStore } from './bots.store.js';

export const useChatStore = defineStore('chat', {
	state: () => ({
		sessionId: '',
		botId: '',
		messages: [],
		/** @type {Object<string, string>} sessionId → sessionKey */
		sessionKeyById: {},
		loading: false,
		sending: false,
		errorText: '',
		streamingRunId: null,
		resetting: false,
		// 内部标志，不暴露到模板
		__agentSettled: false,
		__streamingTimer: null,
		__accepted: false,
		__cancelReject: null,
	}),
	getters: {
		currentSessionKey() {
			return this.sessionKeyById[this.sessionId] ?? '';
		},
		isMainSession() {
			return this.currentSessionKey === 'agent:main:main';
		},
	},
	actions: {
		/**
		 * 激活（切换到）指定 session，加载消息
		 * @param {string} sessionId
		 * @param {object} [opts]
		 * @param {boolean} [opts.force] - 强制重新激活（跳过 id 去重）
		 */
		async activateSession(sessionId, { force = false } = {}) {
			const id = typeof sessionId === 'string' ? sessionId.trim() : '';
			if (!force && id === this.sessionId) return;
			console.debug('[chat] activateSession id=%s force=%s', id, force);
			// 切换前清理上一个 session 的 streaming
			this.__cleanupStreaming();
			this.sessionId = id;
			this.messages = [];
			this.errorText = '';
			this.sending = false;
			// 解析 botId
			this.botId = this.__resolveBotId(id);
			console.debug('[chat] resolved botId=%s for session=%s', this.botId, id);
			if (!id) return;
			// botId 尚未解析（bots 未就绪）→ 保持 loading，等待 retry
			if (!this.botId) {
				console.debug('[chat] activateSession: awaiting bots, stay loading');
				this.loading = true;
				return;
			}
			await this.loadMessages();
		},

		/**
		 * 加载当前 session 的消息
		 * @param {object} [opts]
		 * @param {boolean} [opts.silent] - 静默刷新，不设 loading 状态
		 */
		async loadMessages({ silent = false } = {}) {
			if (!this.sessionId) {
				this.messages = [];
				this.errorText = '';
				this.loading = false;
				return false;
			}
			const conn = this.__getConnection();
			if (!conn) {
				console.debug('[chat] loadMessages: no connection for botId=%s', this.botId);
				if (!silent) this.errorText = 'Bot not connected';
				this.loading = false;
				return false;
			}
			// 连接存在但尚未就绪 → 保持 loading，等待 retry
			if (conn.state !== 'connected') {
				console.debug('[chat] loadMessages: connection not ready state=%s botId=%s', conn.state, this.botId);
				if (!silent) this.loading = true;
				return false;
			}
			console.debug('[chat] loadMessages sessionId=%s botId=%s', this.sessionId, this.botId);
			if (!silent) {
				this.loading = true;
				this.errorText = '';
			}
			try {
				// 获取 session 列表以构建 sessionKeyById
				const list = await conn.request('nativeui.sessions.listAll', {
					agentId: 'main', limit: 200, cursor: 0,
				});
				const items = Array.isArray(list?.items) ? list.items : [];
				this.sessionKeyById = Object.fromEntries(
					items
						.filter((i) => i.sessionKey && i.indexed !== false)
						.map((i) => [i.sessionId, i.sessionKey]),
				);

				// 获取消息
				const result = await conn.request('nativeui.sessions.get', {
					agentId: 'main',
					sessionId: this.sessionId,
					limit: 500,
					cursor: 0,
				});
				this.messages = Array.isArray(result?.messages) ? result.messages : [];
				console.debug('[chat] loadMessages ok count=%d', this.messages.length);
				return true;
			}
			catch (err) {
				console.debug('[chat] loadMessages failed: %s', err?.message);
				if (!silent) {
					this.messages = [];
					this.errorText = err?.message || 'Failed to load messages';
				}
				return false;
			}
			finally {
				this.loading = false;
			}
		},

		/**
		 * 发送消息
		 * @param {string} text
		 * @param {object[]} files - 来自 ChatInput 的文件对象
		 * @returns {Promise<{ accepted: boolean }>}
		 * @throws {Error} 发送失败时抛出
		 */
		async sendMessage(text, files = []) {
			if (!this.sessionId || this.sending) return { accepted: false };

			const conn = this.__getConnection();
			if (!conn || conn.state !== 'connected') {
				throw new Error('Bot not connected');
			}

			console.debug('[chat] sendMessage sessionId=%s files=%d', this.sessionId, files?.length ?? 0);
			this.sending = true;
			this.streamingRunId = null;
			this.__agentSettled = false;
			this.__accepted = false;

			// 追加乐观 user 消息
			const imgFiles = files?.filter((f) => f.isImg && f.file) ?? [];
			let content = text;
			if (imgFiles.length) {
				const blocks = [];
				if (text) blocks.push({ type: 'text', text });
				for (const f of imgFiles) {
					const base64 = await fileToBase64(f.file);
					blocks.push({ type: 'image', data: base64, mimeType: f.file.type || 'image/png' });
				}
				content = blocks;
			}
			this.messages = [...this.messages, {
				type: 'message',
				id: `__local_user_${Date.now()}`,
				_local: true,
				message: { role: 'user', content, timestamp: Date.now() },
			}];

			// 追加 streaming bot 条目
			this.messages = [...this.messages, {
				type: 'message',
				id: `__local_bot_${Date.now()}`,
				_local: true,
				_streaming: true,
				_startTime: Date.now(),
				message: { role: 'assistant', content: '', stopReason: null },
			}];

			let sessionKey = this.sessionKeyById[this.sessionId];

			try {
				// 轮转检测
				if (sessionKey) {
					const rotated = await this.__detectRotation(conn, sessionKey);
					if (rotated) sessionKey = null;
				}

				// 注册 agent 事件
				conn.on('event:agent', this.__onAgentEvent);

				// 构建附件
				const attachments = [];
				for (const f of files) {
					if (!f.file) continue;
					const base64 = await fileToBase64(f.file);
					attachments.push({
						type: f.isImg ? 'image' : f.isVoice ? 'audio' : 'file',
						mimeType: f.file.type || 'application/octet-stream',
						fileName: f.name,
						content: base64,
					});
				}

				const idempotencyKey = crypto.randomUUID();
				const safeText = (!text && attachments.length) ? '\u{1F449}' : text;
				const agentParams = {
					message: safeText,
					deliver: false,
					idempotencyKey,
				};
				if (attachments.length) agentParams.attachments = attachments;
				if (sessionKey) {
					agentParams.sessionKey = sessionKey;
				}
				else {
					agentParams.sessionId = this.sessionId;
				}

				// 超时 / 取消 reject 句柄
				let timeoutReject;
				const timeoutPromise = new Promise((_, reject) => { timeoutReject = reject; });
				const cancelPromise = new Promise((_, reject) => { this.__cancelReject = reject; });

				// pre-acceptance 30s 超时
				this.__streamingTimer = setTimeout(() => {
					if (!this.__accepted) {
						this.__agentSettled = true;
						this.__cleanupStreaming();
						this.sending = false;
						const err = new Error('pre-acceptance timeout');
						err.code = 'PRE_ACCEPTANCE_TIMEOUT';
						timeoutReject(err);
					}
				}, 30_000);

				const final = await Promise.race([
					conn.request('agent', agentParams, {
						onAccepted: (payload) => {
							console.debug('[chat] agent accepted runId=%s', payload?.runId);
							this.__accepted = true;
							this.streamingRunId = payload?.runId ?? null;
							// 切换到 post-acceptance 120s 超时
							if (this.__streamingTimer) clearTimeout(this.__streamingTimer);
							this.__streamingTimer = setTimeout(() => {
								this.__agentSettled = true;
								this.__cleanupStreaming();
								this.sending = false;
								const err = new Error('post-acceptance timeout');
								err.code = 'POST_ACCEPTANCE_TIMEOUT';
								timeoutReject(err);
							}, 120_000);
						},
						onUnknownStatus: (status, payload) => {
							console.error('[chat] unknown agent rpc status=%s', status, payload);
						},
					}),
					timeoutPromise,
					cancelPromise,
				]);

				// 终态到达
				this.__cancelReject = null;
				this.__clearStreamingFlags();
				this.__cleanupTimersAndListeners();
				this.sending = false;

				if (!this.__accepted && final?.status !== 'ok') {
					this.__removeLocalEntries();
					return { accepted: false };
				}
				await this.__reconcileMessages();
				return { accepted: true };
			}
			catch (err) {
				// lifecycle:end 已完成清理，WS 关闭尾巴错误忽略
				if (this.__agentSettled && err?.code === 'WS_CLOSED') {
					return { accepted: this.__accepted };
				}
				// 用户主动取消：不抛错；根据是否已 accepted 决定是否让调用方恢复输入
				if (err?.code === 'USER_CANCELLED') {
					return { accepted: this.__accepted };
				}
				this.__cleanupStreaming();
				this.sending = false;
				throw err;
			}
		},

		/**
		 * 新建聊天（重置 main session）
		 * @returns {Promise<string | null>} 新 sessionId，失败返回 null
		 */
		async resetChat() {
			const conn = this.__getConnection();
			if (!conn || conn.state !== 'connected') {
				throw new Error('Bot not connected');
			}
			this.resetting = true;
			try {
				const result = await conn.request('sessions.reset', {
					key: 'agent:main:main',
					reason: 'new',
				});
				const newId = result?.entry?.sessionId;
				if (!newId) throw new Error('Failed to resolve new session');
				await useSessionsStore().loadAllSessions();
				return newId;
			}
			finally {
				this.resetting = false;
			}
		},

		/** 取消发送 */
		cancelSend() {
			// 通过 reject cancel promise 让 sendMessage 立即 settle
			if (this.__cancelReject) {
				const err = new Error('user cancelled');
				err.code = 'USER_CANCELLED';
				this.__cancelReject(err);
				this.__cancelReject = null;
			}
			this.__cleanupStreaming();
			this.sending = false;
		},

		/** 清理全部状态（离开页面/bot 解绑时） */
		cleanup() {
			// 同 cancelSend：让挂起的 sendMessage 立即 settle
			if (this.__cancelReject) {
				const err = new Error('user cancelled');
				err.code = 'USER_CANCELLED';
				this.__cancelReject(err);
				this.__cancelReject = null;
			}
			this.__cleanupStreaming();
			this.sessionId = '';
			this.botId = '';
			this.messages = [];
			this.sessionKeyById = {};
			this.errorText = '';
			this.sending = false;
			this.resetting = false;
		},

		// --- agent 事件处理（内部方法，通过箭头函数绑定 this） ---

		/**
		 * 处理 agent 流式事件
		 * 注意：此方法作为事件回调使用，需绑定 this
		 * @param {object} payload
		 */
		__onAgentEvent(payload) {
			const match = this.streamingRunId && payload?.runId === this.streamingRunId;
			if (!match) return;

			const { stream, data } = payload;
			console.debug('[chat] agent event stream=%s phase=%s', stream, data?.phase ?? '-');

			if (stream === 'assistant' && data?.text != null) {
				const entry = this.__findStreamingBotEntry();
				if (entry) {
					const content = this.__ensureContentArray(entry);
					const nonText = content.filter((b) => b.type !== 'text');
					entry.message.content = [...nonText, { type: 'text', text: data.text }];
					entry.message.stopReason = 'stop';
					this.messages = [...this.messages];
				}
			}
			else if (stream === 'tool') {
				if (data?.phase === 'start') {
					const entry = this.__findStreamingBotEntry();
					if (entry) {
						const content = this.__ensureContentArray(entry);
						content.push({ type: 'toolCall', name: data.name ?? 'unknown' });
						entry.message.stopReason = 'toolUse';
						this.messages = [...this.messages];
					}
				}
				else if (data?.phase === 'result' && data.result != null) {
					const text = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
					const startTime = this.__findStreamingBotEntry()?._startTime;
					this.messages = [...this.messages,
						{
							type: 'message',
							id: `__local_tr_${Date.now()}`,
							_local: true,
							_streaming: true,
							message: { role: 'toolResult', content: text },
						},
						{
							type: 'message',
							id: `__local_bot_${Date.now() + 1}`,
							_local: true,
							_streaming: true,
							_startTime: startTime,
							message: { role: 'assistant', content: '', stopReason: null },
						},
					];
				}
			}
			else if (stream === 'thinking' && data?.text != null) {
				const entry = this.__findStreamingBotEntry();
				if (entry) {
					const content = this.__ensureContentArray(entry);
					const lastIdx = content.length - 1;
					if (lastIdx >= 0 && content[lastIdx].type === 'thinking') {
						content[lastIdx] = { type: 'thinking', thinking: data.text };
					}
					else {
						content.push({ type: 'thinking', thinking: data.text });
					}
					this.messages = [...this.messages];
				}
			}
			else if (stream === 'lifecycle') {
				if (data?.phase === 'end') {
					console.debug('[chat] agent lifecycle:end runId=%s', this.streamingRunId);
					this.__agentSettled = true;
					this.sending = false;
					this.__cleanupTimersAndListeners();
					this.__clearStreamingFlags();
					this.__reconcileMessages();
				}
				else if (data?.phase === 'error') {
					console.debug('[chat] agent lifecycle:error runId=%s', this.streamingRunId);
					this.__agentSettled = true;
					this.__cleanupStreaming();
					this.sending = false;
					// 错误信息由调用方通过 catch 或 store state 处理
				}
			}
		},

		// --- 内部辅助 ---

		__resolveBotId(sessionId) {
			if (!sessionId) return '';
			const session = useSessionsStore().items.find((s) => s.sessionId === sessionId);
			if (session?.botId) return String(session.botId);
			// 回退到第一个在线 bot
			const bots = useBotsStore().items;
			const online = bots.find((b) => b.online);
			return online ? String(online.id) : (bots[0] ? String(bots[0].id) : '');
		},

		__getConnection() {
			if (!this.botId) return null;
			return useBotConnections().get(this.botId) ?? null;
		},

		async __detectRotation(conn, sessionKey) {
			try {
				const hist = await conn.request('chat.history', { sessionKey, limit: 1 });
				const remoteId = hist?.sessionId ?? null;
				if (remoteId && remoteId !== this.sessionId) {
					delete this.sessionKeyById[this.sessionId];
					useSessionsStore().loadAllSessions();
					return true;
				}
			}
			catch (err) {
				console.warn('[chat] rotation check failed:', err);
			}
			return false;
		},

		async __reconcileMessages() {
			const conn = this.__getConnection();
			if (!conn || conn.state !== 'connected') return false;
			try {
				const list = await conn.request('nativeui.sessions.listAll', {
					agentId: 'main', limit: 200, cursor: 0,
				});
				const items = Array.isArray(list?.items) ? list.items : [];
				this.sessionKeyById = Object.fromEntries(
					items.filter((i) => i.sessionKey && i.indexed !== false)
						.map((i) => [i.sessionId, i.sessionKey]),
				);
				useSessionsStore().loadAllSessions();
				return true;
			}
			catch (err) {
				console.warn('[chat] reconcile failed:', err);
				return false;
			}
		},

		__cleanupStreaming() {
			this.__cleanupTimersAndListeners();
			this.__removeLocalEntries();
		},

		__cleanupTimersAndListeners() {
			if (this.__streamingTimer) {
				clearTimeout(this.__streamingTimer);
				this.__streamingTimer = null;
			}
			this.streamingRunId = null;
			// 从连接中移除事件监听
			const conn = this.__getConnection();
			if (conn) {
				conn.off('event:agent', this.__onAgentEvent);
			}
		},

		__removeLocalEntries() {
			if (this.messages.some((e) => e._local)) {
				this.messages = this.messages.filter((e) => !e._local);
			}
		},

		__clearStreamingFlags() {
			let changed = false;
			for (const entry of this.messages) {
				if (entry._streaming) {
					entry._streaming = false;
					changed = true;
				}
			}
			if (changed) this.messages = [...this.messages];
		},

		__findStreamingBotEntry() {
			for (let i = this.messages.length - 1; i >= 0; i--) {
				const e = this.messages[i];
				if (e._streaming && e.message?.role === 'assistant') return e;
			}
			return null;
		},

		__ensureContentArray(entry) {
			const c = entry.message.content;
			if (Array.isArray(c)) return c;
			entry.message.content = (c && typeof c === 'string') ? [{ type: 'text', text: c }] : [];
			return entry.message.content;
		},
	},
});
