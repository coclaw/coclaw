/**
 * 聊天 Store — 从 ChatPage 中剥离的通信/消息管理逻辑
 * 职责：当前 session 的消息列表、发送、streaming、agent 事件处理
 * 支持两种模式：session 模式（main session）和 topic 模式（独立话题）
 */
import { defineStore } from 'pinia';

import { useBotConnections } from '../services/bot-connection-manager.js';
import { fileToBase64 } from '../utils/file-helper.js';
import { wrapOcMessages } from '../utils/message-normalize.js';

export const useChatStore = defineStore('chat', {
	state: () => ({
		sessionId: '',
		botId: '',
		messages: [],
		/** chat 模式下的 sessionKey（如 agent:main:main） */
		chatSessionKey: '',
		/** chat 当前 session 的 sessionId（从 chat.history 获取，用于历史上翻） */
		currentSessionId: null,
		loading: false,
		sending: false,
		errorText: '',
		streamingRunId: null,
		resetting: false,
		// topic 模式标志
		topicMode: false,
		topicAgentId: '',
		// 历史懒加载
		/** @type {{ sessionId: string, archivedAt: number }[]} */
		historySessionIds: [],
		/** @type {{ sessionId: string, archivedAt: number, messages: object[] }[]} */
		historySegments: [],
		historyLoading: false,
		historyExhausted: false,
		// 内部标志，不暴露到模板
		__historyLoadedCount: 0,
		__agentSettled: false,
		__streamingTimer: null,
		__accepted: false,
		__cancelReject: null,
		__retried: false,
		// 斜杠命令状态
		__slashCommandRunId: null,
		__slashCommandType: null,
		__chatEventHandler: null,
		__slashCommandTimer: null,
		__slashCommandResolve: null,
		__slashCommandReject: null,
	}),
	getters: {
		currentSessionKey() {
			if (this.topicMode) return '';
			return this.chatSessionKey;
		},
		isMainSession() {
			return /^agent:[^:]+:main$/.test(this.chatSessionKey);
		},
	},
	actions: {
		/**
		 * 激活指定 bot 的指定 agent 的 main session
		 * @param {string} botId
		 * @param {string} agentId
		 * @param {object} [opts]
		 * @param {boolean} [opts.force] - 强制重新激活
		 */
		async activateSession(botId, agentId, { force = false } = {}) {
			const bid = String(botId || '').trim();
			const aid = String(agentId || 'main').trim();
			const sessionKey = `agent:${aid}:main`;

			if (!force && bid === this.botId && sessionKey === this.chatSessionKey && !this.topicMode) return;

			console.debug('[chat] activateSession botId=%s agentId=%s force=%s', bid, aid, force);
			this.__cleanupStreaming();
			this.botId = bid;
			this.chatSessionKey = sessionKey;
			this.sessionId = '';
			this.messages = [];
			this.errorText = '';
			this.sending = false;
			this.topicMode = false;
			this.topicAgentId = '';
			this.currentSessionId = null;
			this.historySessionIds = [];
			this.historySegments = [];
			this.historyLoading = false;
			this.historyExhausted = false;
			this.__historyLoadedCount = 0;

			if (!bid) return;

			// botId 对应的连接尚未就绪 → 保持 loading，等待 retry
			const conn = this.__getConnection();
			if (!conn || conn.state !== 'connected') {
				console.debug('[chat] activateSession: connection not ready, stay loading');
				this.loading = true;
				return;
			}

			await this.loadMessages();
			this.__loadChatHistory();
		},

		/**
		 * 激活（切换到）指定 topic
		 * @param {string} topicId
		 * @param {object} opts
		 * @param {string} opts.botId
		 * @param {string} opts.agentId
		 * @param {boolean} [opts.skipLoad] - 跳过消息加载（新建 topic 时使用）
		 */
		async activateTopic(topicId, { botId, agentId, skipLoad = false } = {}) {
			if (topicId === this.sessionId && this.topicMode) {
				console.debug('[chat] activateTopic: skip (same id=%s)', topicId);
				return;
			}
			console.debug('[chat] activateTopic id=%s botId=%s agentId=%s', topicId, botId, agentId);
			this.__cleanupStreaming();
			this.sessionId = topicId;
			this.messages = [];
			this.errorText = '';
			this.sending = false;
			this.topicMode = true;
			this.topicAgentId = agentId || 'main';
			this.botId = String(botId || '');
			this.chatSessionKey = '';
			this.currentSessionId = null;
			// topic 无历史上翻
			this.historySessionIds = [];
			this.historySegments = [];
			this.historyLoading = false;
			this.historyExhausted = true;
			this.__historyLoadedCount = 0;
			if (skipLoad) {
				this.loading = false;
				return;
			}
			if (!this.botId) {
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
			if (this.topicMode) {
				return this.__loadTopicMessages({ silent });
			}
			if (!this.chatSessionKey) {
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
			console.debug('[chat] loadMessages sessionKey=%s botId=%s', this.chatSessionKey, this.botId);
			if (!silent) {
				this.loading = true;
				this.errorText = '';
			}
			try {
				// 通过 OC 原生 sessions.get 加载当前 session 消息
				const result = await conn.request('sessions.get', {
					key: this.chatSessionKey,
					limit: 500,
				});
				const flatMsgs = Array.isArray(result?.messages) ? result.messages : [];
				// 薄包装为 JSONL 行级结构（补 type + id）
				this.messages = wrapOcMessages(flatMsgs);
				// 先解除 loading，使消息 DOM 在同一微任务内渲染，
				// 确保 chatStore.messages watcher 触发的 scrollToBottom $nextTick 能看到可见的消息区域
				this.loading = false;
				console.debug('[chat] loadMessages ok count=%d', this.messages.length);

				// 获取当前 sessionId（用于历史上翻）
				const hist = await conn.request('chat.history', {
					sessionKey: this.chatSessionKey,
					limit: 1,
				});
				this.currentSessionId = hist?.sessionId ?? null;

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
				this.loading = false; // 错误/异常时兜底
			}
		},

		/**
		 * topic 模式下加载消息（使用 coclaw.sessions.getById）
		 * @param {object} opts
		 * @param {boolean} opts.silent
		 */
		async __loadTopicMessages({ silent = false } = {}) {
			if (!this.sessionId) {
				this.messages = [];
				this.errorText = '';
				this.loading = false;
				return false;
			}
			const conn = this.__getConnection();
			if (!conn) {
				if (!silent) this.errorText = 'Bot not connected';
				this.loading = false;
				return false;
			}
			if (conn.state !== 'connected') {
				if (!silent) this.loading = true;
				return false;
			}
			const prevCount = this.messages.length;
			console.debug('[chat] loadTopicMessages topicId=%s botId=%s prevMsgCount=%d silent=%s', this.sessionId, this.botId, prevCount, silent);
			if (!silent) {
				this.loading = true;
				this.errorText = '';
			}
			try {
				const result = await conn.request('coclaw.sessions.getById', {
					sessionId: this.sessionId,
					agentId: this.topicAgentId || 'main',
				});
				const msgs = Array.isArray(result?.messages) ? result.messages : [];
				console.debug('[chat] loadTopicMessages ok count=%d (was %d)', msgs.length, prevCount);
				this.messages = msgs;
				return true;
			}
			catch (err) {
				console.debug('[chat] loadTopicMessages failed: %s', err?.message);
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
			if (this.sending) return { accepted: false };
			if (!this.topicMode && !this.chatSessionKey) return { accepted: false };
			if (this.topicMode && !this.sessionId) return { accepted: false };

			const conn = this.__getConnection();
			if (!conn || conn.state !== 'connected') {
				throw new Error('Bot not connected');
			}

			console.debug('[chat] sendMessage sessionId=%s topicMode=%s files=%d', this.sessionId, this.topicMode, files?.length ?? 0);
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

			try {
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

				// chat 模式用 sessionKey，topic 模式用 sessionId
				if (this.topicMode) {
					agentParams.sessionId = this.sessionId;
				} else {
					agentParams.sessionKey = this.chatSessionKey;
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
							// 切换到 post-acceptance 30min 超时（agent 处理可能较久）
							if (this.__streamingTimer) clearTimeout(this.__streamingTimer);
							this.__streamingTimer = setTimeout(() => {
								this.__agentSettled = true;
								this.__cleanupStreaming();
								this.sending = false;
								const err = new Error('post-acceptance timeout');
								err.code = 'POST_ACCEPTANCE_TIMEOUT';
								timeoutReject(err);
							}, 30 * 60_000);
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
				// 已 accepted 但 agent 尚未完成时 WS 断连：保留乐观消息，等重连后 reconcile
				if (err?.code === 'WS_CLOSED' && this.__accepted && !this.__agentSettled) {
					console.debug('[chat] ws closed after accepted, waiting for reconnect to reconcile');
					this.__cleanupTimersAndListeners();
					this.sending = false;
					const reconn = this.__getConnection();
					if (reconn) {
						const reconnected = await new Promise((resolve) => {
							const timeout = setTimeout(() => { reconn.off('state', onState); resolve(false); }, 15_000);
							const onState = (state) => {
								if (state === 'connected') {
									clearTimeout(timeout);
									reconn.off('state', onState);
									resolve(true);
								}
							};
							if (reconn.state === 'connected') { clearTimeout(timeout); resolve(true); }
							else reconn.on('state', onState);
						});
						if (reconnected) {
							console.debug('[chat] reconnected after accepted, reconciling messages');
							await this.__reconcileMessages();
						}
					}
					return { accepted: true };
				}
				// 断连且尚未 accepted：等待重连后自动重试一次
				if (err?.code === 'WS_CLOSED' && !this.__accepted && !this.__retried) {
					console.debug('[chat] ws closed before accepted, waiting for reconnect to retry');
					this.__cleanupStreaming();
					this.sending = false;
					const reconn = this.__getConnection();
					if (reconn) {
						const reconnected = await new Promise((resolve) => {
							const timeout = setTimeout(() => { reconn.off('state', onState); resolve(false); }, 15_000);
							const onState = (state) => {
								if (state === 'connected') {
									clearTimeout(timeout);
									reconn.off('state', onState);
									resolve(true);
								}
							};
							if (reconn.state === 'connected') { clearTimeout(timeout); resolve(true); }
							else reconn.on('state', onState);
						});
						if (reconnected) {
							console.debug('[chat] reconnected, retrying sendMessage');
							this.__retried = true;
							try {
								return await this.sendMessage(text, files);
							}
							finally {
								this.__retried = false;
							}
						}
					}
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
				// 从 chatSessionKey 解析 agentId
				const agentId = this.__resolveAgentId();
				console.debug('[chat] resetChat agentId=%s sessionId=%s', agentId, this.sessionId);
				const result = await conn.request('sessions.reset', {
					key: `agent:${agentId}:main`,
					reason: 'new',
				});
				const newId = result?.entry?.sessionId;
				if (!newId) throw new Error('Failed to resolve new session');
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

		/**
		 * 发送斜杠命令（通过 chat.send RPC）
		 * Promise 在 event:chat final/error 或超时时 settle，调用方可 await + catch
		 * @param {string} command - 如 '/compact'、'/new'、'/help'
		 */
		async sendSlashCommand(command) {
			const conn = this.__getConnection();
			if (!conn || conn.state !== 'connected' || this.sending) return;

			this.sending = true;

			// 乐观追加 user message（命令完成后 loadMessages 会整体替换）
			this.messages = [...this.messages, {
				type: 'message',
				id: `__local_user_${Date.now()}`,
				_local: true,
				message: { role: 'user', content: command, timestamp: Date.now() },
			}];

			const idempotencyKey = crypto.randomUUID();
			this.__slashCommandRunId = idempotencyKey;
			this.__slashCommandType = command;

			const handler = (evt) => this.__onChatEvent(evt);
			conn.on('event:chat', handler);
			this.__chatEventHandler = handler;

			// 完成/超时 Promise（让调用方 await 到命令结束）
			let settleResolve, settleReject;
			const settlePromise = new Promise((resolve, reject) => {
				settleResolve = resolve;
				settleReject = reject;
			});
			this.__slashCommandResolve = settleResolve;
			this.__slashCommandReject = settleReject;

			this.__slashCommandTimer = setTimeout(() => {
				const reject = this.__slashCommandReject;
				this.__cleanupSlashCommand(conn);
				this.__removeLocalMessages();
				if (reject) {
					const err = new Error('slash command timeout');
					err.code = 'SLASH_CMD_TIMEOUT';
					reject(err);
				}
			}, 30_000);

			try {
				await conn.request('chat.send', {
					sessionKey: this.chatSessionKey,
					message: command,
					idempotencyKey,
				});
			}
			catch (err) {
				const reject = this.__slashCommandReject;
				this.__cleanupSlashCommand(conn);
				this.__removeLocalMessages();
				if (reject) reject(err);
				else throw err;
				// 等待 settlePromise reject 传播
				return settlePromise;
			}

			return settlePromise;
		},

		/** 处理 event:chat 事件（斜杠命令响应） */
		__onChatEvent(evt) {
			if (evt.runId !== this.__slashCommandRunId) return;
			const conn = this.__getConnection();
			const cmd = this.__slashCommandType;
			const resolve = this.__slashCommandResolve;
			const reject = this.__slashCommandReject;

			if (evt.state === 'final') {
				this.__cleanupSlashCommand(conn);
				if (/^\/(new|reset)\b/i.test(cmd)) {
					// 保存旧 session 状态（loadMessages 会替换 messages 和 currentSessionId）
					const prevSessionId = this.currentSessionId;
					const prevMessages = this.messages.filter(m => !m._local);

					this.loadMessages({ silent: true }).then(() => {
						// currentSessionId 变化 = 确实发生了 session 轮换
						if (prevSessionId && this.currentSessionId !== prevSessionId && prevMessages.length > 0) {
							if (!this.historySegments.some(s => s.sessionId === prevSessionId)) {
								// 追加到末尾（最近的孤儿紧邻当前 session）
								this.historySegments = [
									...this.historySegments,
									{ sessionId: prevSessionId, archivedAt: Date.now(), messages: prevMessages },
								];
							}
						}
						resolve?.();
					});
					return;
				}
				else if (/^\/compact\b/i.test(cmd)) {
					this.loadMessages({ silent: true });
				}
				else if (evt.message) {
					// /help 等：本地追加结果消息
					this.messages = [...this.messages, {
						type: 'message',
						id: `chat-${evt.runId}`,
						message: evt.message,
					}];
				}
				resolve?.();
			}
			else if (evt.state === 'error') {
				this.__cleanupSlashCommand(conn);
				this.__removeLocalMessages();
				const err = new Error(evt.errorMessage || 'slash command failed');
				err.code = 'SLASH_CMD_ERROR';
				reject?.(err);
			}
		},

		/** 移除本地乐观消息（错误/超时回退） */
		__removeLocalMessages() {
			this.messages = this.messages.filter((m) => !m._local);
		},

		/** 清理斜杠命令状态 */
		__cleanupSlashCommand(conn) {
			this.sending = false;
			if (this.__slashCommandTimer) {
				clearTimeout(this.__slashCommandTimer);
				this.__slashCommandTimer = null;
			}
			if (conn && this.__chatEventHandler) {
				conn.off('event:chat', this.__chatEventHandler);
			}
			this.__chatEventHandler = null;
			this.__slashCommandRunId = null;
			this.__slashCommandType = null;
			this.__slashCommandResolve = null;
			this.__slashCommandReject = null;
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
			// 清理斜杠命令状态
			this.__cleanupSlashCommand(this.__getConnection());
			this.sessionId = '';
			this.botId = '';
			this.messages = [];
			this.chatSessionKey = '';
			this.currentSessionId = null;
			this.errorText = '';
			this.sending = false;
			this.resetting = false;
			this.topicMode = false;
			this.topicAgentId = '';
			this.historySessionIds = [];
			this.historySegments = [];
			this.historyLoading = false;
			this.historyExhausted = false;
			this.__historyLoadedCount = 0;
		},

		// --- 历史懒加载 ---

		/**
		 * 加载 chat 的孤儿 session 列表（进入 chat 时调用，fire-and-forget）
		 */
		async __loadChatHistory() {
			if (this.topicMode || !this.chatSessionKey) return;
			const conn = this.__getConnection();
			if (!conn || conn.state !== 'connected') return;
			try {
				const agentId = this.__resolveAgentId();
				const result = await conn.request('coclaw.chatHistory.list', {
					agentId,
					sessionKey: this.chatSessionKey,
				});
				this.historySessionIds = Array.isArray(result?.history) ? result.history : [];
				this.historyExhausted = this.historySessionIds.length === 0;
				this.__historyLoadedCount = 0;
				console.debug('[chat] loadChatHistory: %d orphan sessions, exhausted=%s',
					this.historySessionIds.length, this.historyExhausted);
			}
			catch (err) {
				console.warn('[chat] loadChatHistory failed:', err?.message);
				this.historySessionIds = [];
				this.historyExhausted = true;
			}
		},

		/**
		 * 加载下一个历史 session 的消息（滚动到顶时触发）
		 * @returns {Promise<boolean>} 是否成功加载
		 */
		async loadNextHistorySession() {
			if (this.topicMode || this.historyExhausted || this.historyLoading) return false;

			// 跳过已在 segments 中的 session（/new 后 historySessionIds 刷新，旧 segments 可能仍在）
			while (this.__historyLoadedCount < this.historySessionIds.length) {
				const candidate = this.historySessionIds[this.__historyLoadedCount];
				if (this.historySegments.some((s) => s.sessionId === candidate.sessionId)) {
					this.__historyLoadedCount++;
				} else {
					break;
				}
			}

			if (this.__historyLoadedCount >= this.historySessionIds.length) {
				this.historyExhausted = true;
				return false;
			}

			this.historyLoading = true;
			try {
				const entry = this.historySessionIds[this.__historyLoadedCount];
				console.debug('[chat] loadNextHistory: loading session %d/%d id=%s',
					this.__historyLoadedCount + 1, this.historySessionIds.length, entry.sessionId);
				const conn = this.__getConnection();
				if (!conn || conn.state !== 'connected') return false;

				const agentId = this.__resolveAgentId();
				const result = await conn.request('coclaw.sessions.getById', {
					sessionId: entry.sessionId,
					agentId,
				});
				const msgs = Array.isArray(result?.messages) ? result.messages : [];
				console.debug('[chat] loadNextHistory: loaded %d messages for session %s', msgs.length, entry.sessionId);

				// Prepend（新加载的更旧的 session 放到数组前面）
				this.historySegments = [
					{ sessionId: entry.sessionId, archivedAt: entry.archivedAt, messages: msgs },
					...this.historySegments,
				];
				this.__historyLoadedCount++;

				if (this.__historyLoadedCount >= this.historySessionIds.length) {
					this.historyExhausted = true;
				}
				return true;
			}
			catch (err) {
				console.warn('[chat] loadNextHistorySession failed:', err?.message);
				// 跳过失败的 session，避免反复重试
				this.__historyLoadedCount++;
				if (this.__historyLoadedCount >= this.historySessionIds.length) {
					this.historyExhausted = true;
				}
				return false;
			}
			finally {
				this.historyLoading = false;
			}
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
				else if (data?.phase === 'result') {
					// 网关可能剥离 data.result（verbose !== full），兜底空字符串
					const raw = data.result;
					const text = raw != null
						? (typeof raw === 'string' ? raw : JSON.stringify(raw))
						: '';
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
					this.__cleanupTimersAndListeners();
					this.__clearStreamingFlags();
					this.sending = false;
					this.__reconcileMessages();
				}
			}
		},

		// --- 内部辅助 ---

		/**
		 * 从 chatSessionKey 解析 agentId
		 */
		__resolveAgentId() {
			if (this.topicMode) return this.topicAgentId || 'main';
			if (!this.chatSessionKey) return 'main';
			const parts = this.chatSessionKey.split(':');
			return parts.length >= 2 ? parts[1] : 'main';
		},

		__getConnection() {
			if (!this.botId) return null;
			return useBotConnections().get(this.botId) ?? null;
		},

		async __reconcileMessages() {
			const conn = this.__getConnection();
			if (!conn || conn.state !== 'connected') return false;

			try {
				await this.loadMessages({ silent: true });
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
