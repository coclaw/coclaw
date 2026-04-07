/**
 * ChatStore 工厂 — 为每个 chat/topic 创建独立的 Pinia store 实例
 * 职责：单个 session/topic 的消息列表、发送、streaming、agent 事件处理
 *
 * agent run 的后台生命周期由 agentRunsStore 管理，本 store 仅负责 UI 视图状态。
 * 实例管理（创建/缓存/淘汰）由 chatStoreManager 负责。
 */
import { defineStore } from 'pinia';

import { useClawConnections } from '../services/claw-connection-manager.js';
import { postFile } from '../services/file-transfer.js';
import { chatFilesDir, topicFilesDir, buildAttachmentBlock } from '../utils/file-helper.js';
import { wrapOcMessages } from '../utils/message-normalize.js';
import { useAgentRunsStore } from './agent-runs.store.js';
import { getReadyConn } from './get-ready-conn.js';

const MSG_PAGE_SIZE = 50;

/** DC/WS 断连相关的错误码 */
const DISCONNECT_CODES = new Set(['WS_CLOSED', 'DC_NOT_READY', 'DC_CLOSED', 'RTC_SEND_FAILED', 'RTC_LOST', 'CONNECT_TIMEOUT']);
function isDisconnectError(err) { return DISCONNECT_CODES.has(err?.code); }


/**
 * 创建 ChatStore 实例
 * @param {string} storeKey - 如 'session:1:main' 或 'topic:uuid'
 * @param {object} [opts]
 * @param {string} [opts.clawId]
 * @param {string} [opts.agentId]
 * @returns {object} Pinia store 实例
 */
export function createChatStore(storeKey, opts = {}) {
	const topicMode = storeKey.startsWith('topic:');
	const clawId = String(opts.clawId || '');
	const agentId = opts.agentId || 'main';
	const sessionId = topicMode ? storeKey.slice('topic:'.length) : '';
	const chatSessionKey = topicMode ? '' : `agent:${agentId}:main`;
	const topicAgentId = topicMode ? agentId : '';

	const useStore = defineStore(`chat-${storeKey}`, {
		state: () => ({
			// Identity（创建后不变）
			clawId,
			topicMode,
			chatSessionKey,
			sessionId,
			topicAgentId,

			// Messages
			messages: [],
			/** chat 当前 session 的 sessionId（从 chat.history 获取，用于历史上翻） */
			currentSessionId: null,

			// UI state
			loading: false,
			sending: false,
			errorText: '',
			streamingRunId: null,
			resetting: false,

			// 消息分页加载
			hasMoreMessages: false,
			messagesLoading: false,
			__loadedMsgLimit: MSG_PAGE_SIZE,

			// 历史懒加载（session 模式）
			/** @type {{ sessionId: string, archivedAt: number }[]} */
			historySessionIds: [],
			/** @type {{ sessionId: string, archivedAt: number, messages: object[] }[]} */
			historySegments: [],
			historyLoading: false,
			historyExhausted: topicMode,
			__historyLoadedCount: 0,

			// 附件上传状态
			uploadingFiles: false,
			/** @type {Object<string, { status: string, progress: number }>|null} 按文件 id 索引 */
			fileUploadState: null,
			__uploadHandle: null,

			// 内部状态
			__initialized: false,
			__messagesLoaded: false,
			__agentSettled: false,
			__streamingTimer: null,
			__accepted: false,
			__cancelReject: null,
			__retried: false,

			// 斜杠命令
			__slashCommandRunId: null,
			__slashCommandType: null,
			__chatEventHandler: null,
			__slashCommandTimer: null,
			__slashCommandResolve: null,
			__slashCommandReject: null,
			__silentLoadPromise: null,
			__loadPromise: null,
			__historyListPromise: null,
		}),
		getters: {
			currentSessionKey() {
				if (this.topicMode) return '';
				return this.chatSessionKey;
			},
			isMainSession() {
				return /^agent:[^:]+:main$/.test(this.chatSessionKey);
			},
			/** 当前对话的 runKey（用于在 agentRunsStore 中查询活跃 run） */
			runKey() {
				return this.topicMode ? this.sessionId : this.chatSessionKey;
			},
			/** 合并服务端消息 + 活跃 run 的流式消息（按锚点定位插入位置） */
			allMessages() {
				const runsStore = useAgentRunsStore();
				const run = runsStore.getActiveRun(this.runKey);
				if (!run || !run.streamingMsgs.length) return this.messages;

				if (!run.anchorMsgId) {
					return [...this.messages, ...run.streamingMsgs];
				}
				let anchorIdx = -1;
				for (let i = this.messages.length - 1; i >= 0; i--) {
					if (this.messages[i].id === run.anchorMsgId) { anchorIdx = i; break; }
				}
				if (anchorIdx === -1) {
					// 锚点被翻页截断或 reload 后消失，追加到末尾
					return [...this.messages, ...run.streamingMsgs];
				}
				return [
					...this.messages.slice(0, anchorIdx + 1),
					...run.streamingMsgs,
					...this.messages.slice(anchorIdx + 1),
				];
			},
			/** 是否正在发送（含后台 run 仍在执行的情况） */
			isSending() {
				if (this.sending) return true;
				return useAgentRunsStore().isRunning(this.runKey);
			},
			/** 是否有不可中断的本地操作（发送、上传、reset） */
			busy() {
				return this.sending || this.uploadingFiles || this.resetting;
			},
		},
		actions: {
			/**
			 * 激活 store：首次进入加载数据，重新进入静默刷新
			 * @param {object} [opts]
			 * @param {boolean} [opts.skipLoad] - 跳过消息加载（新建 topic 时使用）
			 */
			async activate({ skipLoad = false } = {}) {
				if (!this.__initialized) {
					this.__initialized = true;
					if (!this.clawId || skipLoad) return;

					const conn = getReadyConn(this.clawId);
					if (!conn) {
						console.debug('[chat] activate: connection not ready, waiting for connReady');
						this.loading = true;
						return;
					}

					await this.loadMessages();
					if (!this.topicMode) this.__loadChatHistory();
					return;
				}

				// 重新进入：有活跃 run → allMessages 自动合并；无活跃 run → 静默刷新
				if (this.isSending) {
					console.debug('[chat] activate re-entry: skip reload (sending/running)');
				} else {
					console.debug('[chat] activate re-entry: silent reload');
					this.loadMessages({ silent: true });
				}
			},

			/**
			 * 加载当前 session 的消息
			 * @param {object} [opts]
			 * @param {boolean} [opts.silent] - 静默刷新，不设 loading 状态
			 */
			async loadMessages({ silent = false, limit: limitOverride } = {}) {
				// 飞行中守卫：复用已有请求，防止 activate() + connReady watcher 同时触发
				if (silent && this.__silentLoadPromise) {
					console.debug('[chat] loadMessages: silent in-flight guard hit, reusing promise');
					return this.__silentLoadPromise;
				}
				if (!silent && this.__loadPromise) {
					console.debug('[chat] loadMessages: in-flight guard hit, reusing promise');
					return this.__loadPromise;
				}

				if (this.topicMode) {
					const p = this.__loadTopicMessages({ silent });
					if (silent) {
						this.__silentLoadPromise = p;
						p.finally(() => { this.__silentLoadPromise = null; });
					} else {
						this.__loadPromise = p;
						p.finally(() => { this.__loadPromise = null; });
					}
					return p;
				}
				if (!this.chatSessionKey) {
					this.messages = [];
					this.errorText = '';
					this.loading = false;
					this.__messagesLoaded = true;
					return false;
				}
				const conn = getReadyConn(this.clawId);
				if (!conn) {
					console.debug('[chat] loadMessages: connection not ready clawId=%s', this.clawId);
					if (!silent) this.loading = true;
					return false;
				}
				console.debug('[chat] loadMessages sessionKey=%s clawId=%s', this.chatSessionKey, this.clawId);
				if (!silent) {
					this.loading = true;
					this.errorText = '';
				}
				const doLoad = async () => {
					// 标记加载中，防止 settling fallback 过早清理 streaming 消息（#193）
					useAgentRunsStore().markLoadInFlight(this.runKey);
					try {
						// 通过 OC 原生 sessions.get 加载当前 session 最近 N 条消息
						const limit = limitOverride || MSG_PAGE_SIZE;
						const result = await conn.request('sessions.get', {
							key: this.chatSessionKey,
							limit,
						}, { timeout: 120_000 });
						const flatMsgs = Array.isArray(result?.messages) ? result.messages : [];
						// 薄包装为 JSONL 行级结构（补 type + id）
						const serverMsgs = wrapOcMessages(flatMsgs);
						// 保留乐观消息（sendMessage 与 loadMessages 可能并发执行）
						const localMsgs = this.messages.filter((m) => m._local);
						this.messages = localMsgs.length ? [...serverMsgs, ...localMsgs] : serverMsgs;
						this.__loadedMsgLimit = limit;
						// sessions.get 返回 .slice(-limit)，若返回数 == limit 说明可能还有更多
						this.hasMoreMessages = flatMsgs.length >= limit;
						this.loading = false;
						this.__messagesLoaded = true;
						console.debug('[chat] loadMessages ok count=%d hasMore=%s', this.messages.length, this.hasMoreMessages);

						// 重连后 reconcile：检查并 settle 僵尸 run / 完成 settling 过渡
						this.__reconcileRunAfterLoad(this.messages);

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
						this.loading = false;
						useAgentRunsStore().clearLoadInFlight(this.runKey);
					}
				};
				const p = doLoad();
				if (silent) {
					this.__silentLoadPromise = p;
					p.finally(() => { this.__silentLoadPromise = null; });
				} else {
					this.__loadPromise = p;
					p.finally(() => { this.__loadPromise = null; });
				}
				return p;
			},

			/**
			 * 加载更早的消息（向上滚动时触发）
			 * @returns {Promise<boolean>} 是否成功加载了新消息
			 */
			async loadOlderMessages() {
				if (!this.hasMoreMessages || this.messagesLoading) return false;
				if (this.topicMode || !this.chatSessionKey) return false;

				const conn = getReadyConn(this.clawId);
				if (!conn) return false;

				this.messagesLoading = true;
				try {
					const newLimit = this.__loadedMsgLimit + MSG_PAGE_SIZE;
					const result = await conn.request('sessions.get', {
						key: this.chatSessionKey,
						limit: newLimit,
					}, { timeout: 120_000 });
					const flatMsgs = Array.isArray(result?.messages) ? result.messages : [];
					const wrapped = wrapOcMessages(flatMsgs);

					// 仅保留 streaming 中的 claw 占位；用户乐观消息已被服务端持久化
					const localMsgs = this.messages.filter((m) => m._local && m._streaming);
					const prevNonLocalCount = this.messages.length - localMsgs.length;

					this.messages = [...wrapped, ...localMsgs];
					this.__loadedMsgLimit = newLimit;
					this.hasMoreMessages = flatMsgs.length >= newLimit;

					const loaded = wrapped.length > prevNonLocalCount;
					console.debug('[chat] loadOlderMessages limit=%d count=%d new=%d hasMore=%s',
						newLimit, wrapped.length, wrapped.length - prevNonLocalCount, this.hasMoreMessages);
					return loaded;
				}
				catch (err) {
					console.warn('[chat] loadOlderMessages failed:', err?.message);
					return false;
				}
				finally {
					this.messagesLoading = false;
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
					this.__messagesLoaded = true;
					return false;
				}
				const conn = getReadyConn(this.clawId);
				if (!conn) {
					if (!silent) this.loading = true;
					return false;
				}
				const prevCount = this.messages.length;
				console.debug('[chat] loadTopicMessages topicId=%s clawId=%s prevMsgCount=%d silent=%s', this.sessionId, this.clawId, prevCount, silent);
				if (!silent) {
					this.loading = true;
					this.errorText = '';
				}
				// 标记加载中，防止 settling fallback 过早清理 streaming 消息（#193）
				useAgentRunsStore().markLoadInFlight(this.runKey);
				try {
					const result = await conn.request('coclaw.sessions.getById', {
						sessionId: this.sessionId,
						agentId: this.topicAgentId || 'main',
					}, { timeout: 120_000 });
					const msgs = Array.isArray(result?.messages) ? result.messages : [];
					console.debug('[chat] loadTopicMessages ok count=%d (was %d)', msgs.length, prevCount);
					// 保留乐观消息（sendMessage 与 loadMessages 可能并发执行）
					const localMsgs = this.messages.filter((m) => m._local);
					this.messages = localMsgs.length ? [...msgs, ...localMsgs] : msgs;
					this.__messagesLoaded = true;

					// 重连后 reconcile
					this.__reconcileRunAfterLoad(this.messages);

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
					useAgentRunsStore().clearLoadInFlight(this.runKey);
				}
			},

			/**
			 * 发送消息
			 * @param {string} text
			 * @param {object[]} files - 来自 ChatInput 的文件对象
			 * @returns {Promise<{ accepted: boolean }>}
			 * @throws {Error} 发送失败时抛出
			 */
			async sendMessage(text, files = [], { __idempotencyKey, onFileUploaded } = {}) {
				if (this.sending) return { accepted: false };
				if (!this.topicMode && !this.chatSessionKey) return { accepted: false };
				if (this.topicMode && !this.sessionId) return { accepted: false };

				const conn = useClawConnections().get(this.clawId);
				if (!conn) {
					throw new Error('Claw not connected');
				}

				console.debug('[chat] sendMessage sessionId=%s topicMode=%s files=%d', this.sessionId, this.topicMode, files?.length ?? 0);
				this.sending = true;
				this.streamingRunId = null;
				this.__agentSettled = false;
				this.__accepted = false;

				const hasFiles = files?.length > 0;
				const rtcAvailable = hasFiles && !!conn.rtc?.isReady;
				if (hasFiles) {
					console.debug('[chat] rtcAvailable=%s rtc=%s isReady=%s',
						rtcAvailable, !!conn.rtc, conn.rtc?.isReady);
				}

				const idempotencyKey = __idempotencyKey || crypto.randomUUID();

				try {
					// 阶段1：文件上传（先于乐观消息创建）
					let finalMessage;

					if (hasFiles && rtcAvailable) {
						finalMessage = await this.__uploadFilesSequentially(conn, text, files, onFileUploaded);
					} else if (hasFiles) {
						const err = new Error('File transfer requires RTC connection');
						err.code = 'RTC_UNAVAILABLE';
						throw err;
					} else {
						finalMessage = { text };
					}

					// 阶段2：创建 pending 乐观消息（文件上传完成后）
					const optimisticUser = {
						type: 'message',
						id: `__local_user_${Date.now()}`,
						_local: true,
						_pending: true,
						message: { role: 'user', content: text, timestamp: Date.now() },
					};
					if (hasFiles) {
						// 从文件 blob 创建新 URL 用于 accepted 后渲染（upload 阶段已 revoke 原 URL）
						optimisticUser._attachments = files.map((f) => ({
							name: f.name, size: f.bytes, type: f.file?.type,
							isImg: f.isImg || false,
							isVoice: f.isVoice || false,
							durationMs: f.durationMs || null,
							url: (f.isVoice || f.isImg) && f.file ? URL.createObjectURL(f.file) : null,
						}));
					}
					const optimisticClaw = {
						type: 'message',
						id: `__local_claw_${Date.now()}`,
						_local: true,
						_pending: true,
						_streaming: true,
						_startTime: Date.now(),
						message: { role: 'assistant', content: '', stopReason: null },
					};
					this.messages = [...this.messages, optimisticUser, optimisticClaw];

					const agentParams = {
						message: finalMessage.text,
						deliver: false,
						idempotencyKey,
					};
					// 组装 extraSystemPrompt（每次都携带文件渲染能力提示）
					{
						const prompts = [
							'当你需要向用户展示文件时，可在回复中使用 coclaw-file: 协议引用文件：',
							'- 图片：![描述](coclaw-file:文件路径)',
							'- 其他文件：[文件名](coclaw-file:文件路径)',
							'路径为相对于工作目录的相对路径。',
						];
						if (finalMessage.voicePaths?.length) {
							prompts.push('');
							prompts.push('用户通过语音输入发送了以下音频文件，请先转录再回复：');
							prompts.push(...finalMessage.voicePaths.map((p) => `- ${p}`));
						}
						agentParams.extraSystemPrompt = prompts.join('\n');
					}

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

					// pre-acceptance 超时（用户可主动取消）
					this.__streamingTimer = setTimeout(() => {
						if (!this.__accepted) {
							this.__agentSettled = true;
							this.__cleanupStreaming();
							this.sending = false;
							const err = new Error('pre-acceptance timeout');
							err.code = 'PRE_ACCEPTANCE_TIMEOUT';
							timeoutReject(err);
						}
					}, 180_000);

					const runsStore = useAgentRunsStore();
					const runKey = this.runKey;

					const final = await Promise.race([
						conn.request('agent', agentParams, {
							timeout: 0, // agent 长任务，不设请求超时，由外层 pre/post-acceptance timer 管理
							onAccepted: (payload) => {
								const runId = payload?.runId ?? null;
								console.debug('[chat] agent accepted runId=%s', runId);
								this.__accepted = true;
								this.streamingRunId = runId;
								// 切换到 post-acceptance 30min 超时
								if (this.__streamingTimer) clearTimeout(this.__streamingTimer);
								this.__streamingTimer = setTimeout(() => {
									this.__agentSettled = true;
									this.sending = false;
									runsStore.settle(runKey);
									this.__reconcileMessages();
									const err = new Error('post-acceptance timeout');
									err.code = 'POST_ACCEPTANCE_TIMEOUT';
									timeoutReject(err);
								}, 30 * 60_000);
								// 清除 pending 标记并移入 agentRunsStore
								const localMsgs = this.messages.filter((m) => m._local);
								for (const m of localMsgs) m._pending = false;
								const lastServerMsg = this.messages.filter((m) => !m._local).at(-1);
								this.messages = this.messages.filter((m) => !m._local);
								runsStore.register(runId, {
									clawId: this.clawId,
									runKey,
									topicMode: this.topicMode,
									conn,
									streamingMsgs: localMsgs,
									anchorMsgId: lastServerMsg?.id ?? null,
								});
							},
							onUnknownStatus: (status, payload) => {
								console.error('[chat] unknown agent rpc status=%s', status, payload);
							},
						}),
						timeoutPromise,
						cancelPromise,
					]);

					// 终态到达（RPC resolved）
					this.__cancelReject = null;
					if (this.__streamingTimer) {
						clearTimeout(this.__streamingTimer);
						this.__streamingTimer = null;
					}
					this.sending = false;

					if (!this.__accepted && final?.status !== 'ok') {
						this.__removeLocalEntries();
						return { accepted: false };
					}
					// run 的清理交给 __settleWithTransition + completeSettle 流程：
					// lifecycle:end → settling 状态 → loadMessages 成功后 completeSettle 清理
					// 此处不主动 settle，避免在 loadMessages 完成前清除 streamingMsgs 导致消息闪烁
					await this.__reconcileMessages();
					return { accepted: true };
				}
				catch (err) {
					// Promise.race 已 settle，cancelPromise 不再需要；立即清理防止孤儿 rejection
					this.__cancelReject = null;
					// lifecycle:end 已完成清理，WS 关闭尾巴错误忽略
					if (this.__agentSettled && isDisconnectError(err)) {
						return { accepted: this.__accepted };
					}
					// 文件上传被取消（cancelSend 在上传阶段触发）：视同用户取消
					if (err?.code === 'CANCELLED' && !this.__accepted) {
						this.sending = false;
						this.fileUploadState = null;
						this.__removeLocalEntries();
						return { accepted: false };
					}
					// 用户主动取消：不抛错；根据是否已 accepted 决定是否让调用方恢复输入
					if (err?.code === 'USER_CANCELLED') {
						// 注：cleanup() 触发的取消不 settle run（让后台继续执行）；
						// cancelSend() 触发的取消已在 cancelSend 内主动 settle
						this.sending = false;
						if (this.__streamingTimer) {
							clearTimeout(this.__streamingTimer);
							this.__streamingTimer = null;
						}
						if (!this.__accepted) {
							this.__removeLocalEntries();
						}
						return { accepted: this.__accepted };
					}
					// 已 accepted 但 agent 尚未完成时断连：reconcile 会在连接恢复后由 __refreshIfStale 触发
					if (isDisconnectError(err) && this.__accepted && !this.__agentSettled) {
						console.debug('[chat] dc closed after accepted, will reconcile on reconnect');
						if (this.__streamingTimer) {
							clearTimeout(this.__streamingTimer);
							this.__streamingTimer = null;
						}
						this.sending = false;
						this.__reconcileMessages().catch(() => {});
						return { accepted: true };
					}
					// 断连且尚未 accepted：自动重试一次（内层 request() 会等待连接恢复）
					if (isDisconnectError(err) && !this.__accepted && !this.__retried) {
						console.debug('[chat] dc closed before accepted, retrying sendMessage');
						this.__cleanupStreaming();
						this.sending = false;
						this.__retried = true;
						try {
							return await this.sendMessage(text, files, { __idempotencyKey: idempotencyKey, onFileUploaded });
						} catch (e) {
							console.debug('[chat] retry sendMessage failed:', e?.message);
							throw e;
						} finally {
							this.__retried = false;
						}
					}
					if (this.__accepted) {
						// 已被服务端接受，保留消息并从服务端拉取真实状态
						if (this.__streamingTimer) {
							clearTimeout(this.__streamingTimer);
							this.__streamingTimer = null;
						}
						this.sending = false;
						// settle 交给 reconcileAfterLoad 的双条件判定
						this.__reconcileMessages();
					}
					else {
						this.__cleanupStreaming();
						this.sending = false;
					}
					this.fileUploadState = null;
					throw err;
				}
			},

			/**
			 * 新建聊天（重置 main session）
			 * @returns {Promise<string | null>} 新 sessionId，失败返回 null
			 */
			async resetChat() {
				if (this.resetting) return null;
				const conn = useClawConnections().get(this.clawId);
				if (!conn) {
					throw new Error('Claw not connected');
				}
				this.resetting = true;
				try {
					const agentId = this.__resolveAgentId();
					console.debug('[chat] resetChat agentId=%s sessionId=%s', agentId, this.sessionId);
					const result = await conn.request('sessions.reset', {
						key: `agent:${agentId}:main`,
						reason: 'new',
					}, { timeout: 600_000 });
					const newId = result?.entry?.sessionId;
					if (!newId) throw new Error('Failed to resolve new session');
					return newId;
				}
				finally {
					this.resetting = false;
				}
			},

			/** 取消发送（用户主动取消，同时 settle run） */
			cancelSend() {
				// 取消进行中的文件上传
				if (this.__uploadHandle) {
					this.__uploadHandle.cancel();
					this.__uploadHandle = null;
				}
				this.uploadingFiles = false;
				this.fileUploadState = null;
				// 通过 reject cancel promise 让 sendMessage 立即 settle
				if (this.__cancelReject) {
					const err = new Error('user cancelled');
					err.code = 'USER_CANCELLED';
					this.__cancelReject(err);
					this.__cancelReject = null;
				}
				if (this.__accepted) {
					// 已被服务端接受，settle run 并从服务端拉取真实状态
					useAgentRunsStore().settle(this.runKey);
					if (this.__streamingTimer) {
						clearTimeout(this.__streamingTimer);
						this.__streamingTimer = null;
					}
					this.sending = false;
					this.__reconcileMessages();
				}
				else {
					this.__cleanupStreaming();
					this.sending = false;
				}
			},

			/**
			 * 发送斜杠命令（通过 chat.send RPC）
			 * @param {string} command - 如 '/compact'、'/new'、'/help'
			 */
			async sendSlashCommand(command) {
				const conn = getReadyConn(this.clawId);
				if (!conn || this.sending) return;

				this.sending = true;

				// 乐观追加 user message
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

				let settleResolve, settleReject;
				const settlePromise = new Promise((resolve, reject) => {
					settleResolve = resolve;
					settleReject = reject;
				});
				this.__slashCommandResolve = settleResolve;
				this.__slashCommandReject = settleReject;

				// /new、/reset、/compact 等重量级命令需要更长超时
				const heavyCmd = /^\/(new|reset|compact)\b/i.test(command);
				const slashTimeout = heavyCmd ? 600_000 : 300_000;

				this.__slashCommandTimer = setTimeout(() => {
					const reject = this.__slashCommandReject;
					this.__cleanupSlashCommand(conn);
					this.__removeLocalMessages();
					if (reject) {
						const err = new Error('slash command timeout');
						err.code = 'SLASH_CMD_TIMEOUT';
						reject(err);
					}
				}, slashTimeout);

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
						const prevSessionId = this.currentSessionId;
						const prevMessages = this.messages.filter(m => !m._local);

						this.loadMessages({ silent: true }).then(() => {
							if (prevSessionId && this.currentSessionId !== prevSessionId && prevMessages.length > 0) {
								if (!this.historySegments.some(s => s.sessionId === prevSessionId)) {
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
				for (const m of this.messages) {
					if (!m._local || !m._attachments) continue;
					for (const att of m._attachments) {
						if (att.url) URL.revokeObjectURL(att.url);
					}
				}
				this.messages = this.messages.filter((m) => !m._local);
			},

			/**
			 * WS 重连时 reconcile 挂起的 slash command
			 * event:chat 可能在断连期间丢失，此时 resolve（非 reject），由 loadMessages 恢复正确状态
			 */
			__reconcileSlashCommand() {
				if (!this.__slashCommandRunId) return;
				console.debug('[chat] reconnected with pending slash cmd → settle');
				const resolve = this.__slashCommandResolve;
				this.__cleanupSlashCommand(this.__getConnection());
				this.__removeLocalMessages();
				if (resolve) resolve();
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

			/**
			 * 页面离开时清理发送状态（不销毁数据，store 持续存活）
			 */
			cleanup() {
				// 取消进行中的文件上传
				if (this.__uploadHandle) {
					this.__uploadHandle.cancel();
					this.__uploadHandle = null;
				}
				this.uploadingFiles = false;
				this.fileUploadState = null;
				// 让挂起的 sendMessage promise 立即 settle（run 本身继续后台执行）
				if (this.__cancelReject) {
					const err = new Error('user cancelled');
					err.code = 'USER_CANCELLED';
					this.__cancelReject(err);
					this.__cancelReject = null;
				}
				if (this.__streamingTimer) {
					clearTimeout(this.__streamingTimer);
					this.__streamingTimer = null;
				}
				// 清理斜杠命令状态
				this.__cleanupSlashCommand(this.__getConnection());
			},

			/**
			 * 实例被淘汰时的完整清理（由 chatStoreManager.dispose 调用）
			 */
			dispose() {
				console.debug('[chat] dispose topicMode=%s runKey=%s', this.topicMode, this.runKey);
				this.cleanup();
			},

			// --- 历史懒加载 ---

			/**
			 * 加载 chat 的孤儿 session 列表（进入 chat 时调用，fire-and-forget）
			 */
			async __loadChatHistory() {
				if (this.topicMode || !this.chatSessionKey) return;
				if (this.__historyListPromise) return this.__historyListPromise;
				const conn = getReadyConn(this.clawId);
				if (!conn) return;
				const p = (async () => {
					try {
						const agentId = this.__resolveAgentId();
						const result = await conn.request('coclaw.chatHistory.list', {
							agentId,
							sessionKey: this.chatSessionKey,
						}, { timeout: 60_000 });
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
					finally {
						this.__historyListPromise = null;
					}
				})();
				this.__historyListPromise = p;
				return p;
			},

			/**
			 * 加载下一个历史 session 的消息（滚动到顶时触发）
			 * @returns {Promise<boolean>} 是否成功加载
			 */
			async loadNextHistorySession() {
				if (this.topicMode || this.historyExhausted || this.historyLoading) return false;

				// historySessionIds 尚未初始化时不能判定 exhausted
				if (this.historySessionIds.length === 0 && !this.__messagesLoaded) {
					return false;
				}

				// 跳过已在 segments 中的 session
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
					const conn = getReadyConn(this.clawId);
					if (!conn) return false;

					const agentId = this.__resolveAgentId();
					const result = await conn.request('coclaw.sessions.getById', {
						sessionId: entry.sessionId,
						agentId,
					}, { timeout: 120_000 });
					const msgs = Array.isArray(result?.messages) ? result.messages : [];
					console.debug('[chat] loadNextHistory: loaded %d messages for session %s', msgs.length, entry.sessionId);

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

			// --- 内部辅助 ---

			/**
			 * 通过 POST 上传附件并构建最终消息文本
			 * @param {object} conn - ClawConnection
			 * @param {string} text - 用户原始文本
			 * @param {object[]} files - ChatInput 的文件对象数组
			 * @returns {Promise<{ text: string, voicePaths: string[] }>}
			 */
			async __uploadFilesSequentially(conn, text, files, onFileUploaded) {
				const agentId = this.__resolveAgentId();
				const dir = this.topicMode
					? topicFilesDir(this.sessionId)
					: chatFilesDir(this.chatSessionKey);

				const validFiles = files.filter((f) => f.file);
				this.uploadingFiles = true;
				this.fileUploadState = Object.fromEntries(
					validFiles.map((f) => [f.id, { status: 'pending', progress: 0 }]),
				);
				const uploaded = []; // { path, name, size }
				const voicePaths = [];

				try {
					for (const f of validFiles) {
						// remotePath 优化：已上传的跳过
						if (f.remotePath) {
							uploaded.push({ path: f.remotePath, name: f.name, size: f.bytes });
							if (f.isVoice) voicePaths.push(f.remotePath);
							this.fileUploadState = { ...this.fileUploadState, [f.id]: { status: 'done', progress: 1 } };
							onFileUploaded?.(f);
							continue;
						}

						this.fileUploadState = { ...this.fileUploadState, [f.id]: { status: 'uploading', progress: 0 } };
						const handle = postFile(conn, agentId, dir, f.name, f.file);
						this.__uploadHandle = handle;

						let lastProgressAt = 0;
						handle.onProgress = (sent, total) => {
							if (!this.fileUploadState?.[f.id]) return;
							const now = Date.now();
							// 节流：≥100ms 间隔或传输完成时才更新
							if (now - lastProgressAt < 100 && sent < total) return;
							lastProgressAt = now;
							this.fileUploadState = { ...this.fileUploadState, [f.id]: { status: 'uploading', progress: total > 0 ? sent / total : 0 } };
						};

						const result = await handle.promise;
						f.remotePath = result.path;
						this.fileUploadState = { ...this.fileUploadState, [f.id]: { status: 'done', progress: 1 } };
						uploaded.push({ path: result.path, name: f.name, size: f.bytes });
						if (f.isVoice) voicePaths.push(result.path);
						console.debug('[chat] uploaded %s → %s', f.name, result.path);
						onFileUploaded?.(f);
					}
				} catch (err) {
					// 标记当前文件失败
					const failingId = validFiles.find((vf) => this.fileUploadState?.[vf.id]?.status === 'uploading')?.id;
					if (failingId) {
						this.fileUploadState = { ...this.fileUploadState, [failingId]: { status: 'failed', progress: 0 } };
					}
					throw err;
				} finally {
					this.__uploadHandle = null;
					this.uploadingFiles = false;
				}

				this.fileUploadState = null;
				const block = buildAttachmentBlock(uploaded);
				const finalText = block
					? (text ? `${text}\n\n${block}` : block)
					: text;
				return { text: finalText, voicePaths };
			},

			__resolveAgentId() {
				if (this.topicMode) return this.topicAgentId || 'main';
				if (!this.chatSessionKey) return 'main';
				const parts = this.chatSessionKey.split(':');
				return parts.length >= 2 ? parts[1] : 'main';
			},

			__getConnection() {
				if (!this.clawId) return null;
				return useClawConnections().get(this.clawId) ?? null;
			},

			async __reconcileMessages() {
				const conn = getReadyConn(this.clawId);
				if (!conn) return false;

				try {
					await this.loadMessages({ silent: true });
					return true;
				}
				catch (err) {
					console.warn('[chat] reconcile failed:', err);
					return false;
				}
			},

			/**
			 * loadMessages 成功后：检查并处理 agentRunsStore 中的活跃/settling run
			 * @param {object[]} serverMessages
			 */
			__reconcileRunAfterLoad(serverMessages) {
				const runsStore = useAgentRunsStore();
				// 完成 settling 过渡（lifecycle:end 已到达，等待 loadMessages 替换数据）
				runsStore.completeSettle(this.runKey);
				// 去除乐观 user 消息——仅当 server 已包含对应消息时才 strip
				runsStore.stripLocalUserMsgs(this.runKey, serverMessages);
				// sendMessage 流程执行中跳过僵尸检测——避免过早 settle 活跃 run
				// 注：使用 this.sending 而非 this.isSending，因为 isSending 包含 isRunning，
				// 而僵尸 run 正是 sending=false 但 isRunning=true 的场景
				if (this.sending) return;
				// 检查僵尸 run（断连期间完成，lifecycle:end 丢失）
				runsStore.reconcileAfterLoad(this.runKey, serverMessages);
			},

			__cleanupStreaming() {
				if (this.__streamingTimer) {
					clearTimeout(this.__streamingTimer);
					this.__streamingTimer = null;
				}
				this.streamingRunId = null;
				this.__removeLocalEntries();
			},

			__removeLocalEntries() {
				if (this.messages.some((e) => e._local)) {
					// 释放乐观消息中的 blob URL（语音附件播放地址）
					for (const e of this.messages) {
						if (!e._local || !e._attachments) continue;
						for (const att of e._attachments) {
							if (att.url) URL.revokeObjectURL(att.url);
						}
					}
					this.messages = this.messages.filter((e) => !e._local);
				}
			},

		},
	});

	return useStore();
}
