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
import { useAgentRunsStore, POST_ACCEPT_TIMEOUT_MS } from './agent-runs.store.js';
import { getReadyConn } from './get-ready-conn.js';
import { remoteLog } from '../services/remote-log.js';

const MSG_PAGE_SIZE = 50;

/** cancelSend accepted 分支的 tick 重试间隔（ms） */
const CANCEL_TICK_MS = 500;

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
			__streamingTimer: null,
			__accepted: false,
			__cancelReject: null,
			__retried: false,

			/**
			 * 取消协调状态：accepted 后用户点 STOP 时建立，直到 run 结束或 RPC 达成终态清除。
			 * 存在期间 isCancelling=true，UI 将 STOP 按钮禁用以防重复触发。
			 * @type {{ sid: string, promise: Promise<object>, resolve: Function, tickTimer: ReturnType<typeof setTimeout>|null, tickSeq: number } | null}
			 */
			__cancelling: null,

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
				// topic 模式：sessionId 是 uuid，天然全局唯一
				// chat 模式：chatSessionKey 不含 clawId，多 claw 共用同名 agent 会碰撞，必须加 clawId 前缀
				if (this.topicMode) return this.sessionId;
				return `${this.clawId}::${this.chatSessionKey}`;
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
			/** 取消协调任务是否正在进行（用户点 STOP 后到 run 结束前） */
			isCancelling() {
				return !!this.__cancelling;
			},
			/**
			 * 是否有 loadMessages 正在进行（silent 或非 silent 任一路径）
			 * 用于 refresh 按钮展示"后台也在刷"的状态反馈
			 */
			isLoadingMessages() {
				return !!(this.__silentLoadPromise || this.__loadPromise);
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

				// 用户发起新 send → 旧的 cancel 协调意图已被用户自身超越（"算了，继续聊"）。
				// 必须同步丢弃 __cancelling，否则 chat 模式下同 sessionId 的新 run 会被
				// 残留 tick 的 abort RPC 命中并误杀（空窗期结束后 ACTIVE_EMBEDDED_RUNS 会
				// 命中新 run 的 handle）。__clearCancelling 会清 tickTimer 并把 pending
				// coordination promise 以 superseded 终态结掉，调用方 .then 仍能正常 settle。
				this.__clearCancelling('superseded');

				console.debug('[chat] sendMessage sessionId=%s topicMode=%s files=%d', this.sessionId, this.topicMode, files?.length ?? 0);
				this.sending = true;
				this.streamingRunId = null;
				this.__accepted = false;

				const hasFiles = files?.length > 0;
				const idempotencyKey = __idempotencyKey || crypto.randomUUID();

				try {
					// 阶段1：文件上传（先于乐观消息创建）
					const finalMessage = hasFiles
						? await this.__uploadFilesSequentially(conn, text, files, onFileUploaded)
						: { text };

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
							prompts.push('用户通过语音发送了以下音频文件，音频内容即为用户的实际消息输入。');
							prompts.push('请转录后直接根据内容回复——若结合对话上下文能明确用户意图，直接处理，无需复述转录结果或向用户确认；');
							prompts.push('仅当转录质量差或意图确实无法判断时，才简要说明并请用户澄清。');
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

					// 计算锚点 + optimistic 子集（runAgent 内 register 时使用）
					const lastServerMsg = this.messages.filter((m) => !m._local).at(-1);
					const anchorMsgId = lastServerMsg?.id ?? null;
					const optimisticMsgs = [optimisticUser, optimisticClaw];

					// 超时 / 取消 reject 句柄
					let timeoutReject;
					const timeoutPromise = new Promise((_, reject) => { timeoutReject = reject; });
					const cancelPromise = new Promise((_, reject) => { this.__cancelReject = reject; });

					// pre-acceptance 超时（accepted 之前；accepted 后由 agent-runs.store 内 24h 内存释放保险接管）
					this.__streamingTimer = setTimeout(() => {
						if (!this.__accepted) {
							this.__cleanupStreaming();
							this.sending = false;
							const err = new Error('pre-acceptance timeout');
							err.code = 'PRE_ACCEPTANCE_TIMEOUT';
							timeoutReject(err);
						}
					}, 180_000);

					const runsStore = useAgentRunsStore();
					const runKey = this.runKey;

					// 发起 agent run（内部封装两阶段 RPC + watcher 四路结束信号）
					const runPromise = runsStore.runAgent({
						conn,
						clawId: this.clawId,
						runKey,
						topicMode: this.topicMode,
						agentParams,
						optimisticMsgs,
						anchorMsgId,
						onAccepted: (payload) => {
							const runId = payload?.runId ?? null;
							console.debug('[chat] agent accepted runId=%s', runId);
							this.__accepted = true;
							this.streamingRunId = runId;
							// 清 pre-acceptance timer；post-accept 由 agent-runs.store 内的 24h 兜底接管
							if (this.__streamingTimer) clearTimeout(this.__streamingTimer);
							this.__streamingTimer = null;
							// 移走乐观 _local 条目（streamingMsgs 已由 register 接管显示）
							const localMsgs = this.messages.filter((m) => m._local);
							for (const m of localMsgs) m._pending = false;
							this.messages = this.messages.filter((m) => !m._local);
						},
					});

					// 独立挂钩：accepted 后 endRun 信号到达 → loadMessages + dropRun。
					// cancel 路径下 cancelPromise 已 reject，但 runPromise 仍在等真实终态，此 then 接管收尾。
					// dropRun 带 res.runId：loadMessages 期间用户若发新消息 register 同 runKey 的新 run，
					// 旧挂钩的 dropRun 校验 runId 不匹配即跳过，避免误清新 run。
					runPromise.then(async (res) => {
						if (res?.accepted) {
							await this.loadMessages({ silent: true });
							runsStore.dropRun(runKey, res.runId);
						}
					}).catch((e) => {
						console.debug('[chat] runPromise rejected (handled by outer catch):', e?.message);
					});

					const final = await Promise.race([runPromise, timeoutPromise, cancelPromise]);

					// 终态到达
					this.__cancelReject = null;
					if (this.__streamingTimer) {
						clearTimeout(this.__streamingTimer);
						this.__streamingTimer = null;
					}
					this.sending = false;

					if (!this.__accepted) {
						// 未 accepted（罕见：runAgent 直接返回 norun）
						this.__removeLocalEntries();
						return { accepted: false };
					}
					// final.endReason 内部保留（用于 debug/未来扩展），不对外暴露
					console.debug('[chat] sendMessage done endReason=%s', final?.endReason);
					return { accepted: true };
				}
				catch (err) {
					this.__cancelReject = null;

					// 文件上传被取消（cancelSend 在上传阶段触发）：视同用户取消
					if (err?.code === 'CANCELLED' && !this.__accepted) {
						this.sending = false;
						this.fileUploadState = null;
						this.__removeLocalEntries();
						return { accepted: false };
					}
					// 用户主动取消
					if (err?.code === 'USER_CANCELLED') {
						this.sending = false;
						if (this.__streamingTimer) {
							clearTimeout(this.__streamingTimer);
							this.__streamingTimer = null;
						}
						if (!this.__accepted) {
							this.__removeLocalEntries();
						}
						// accepted 后取消：runPromise.then 接管 loadMessages + dropRun
						return { accepted: this.__accepted };
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
					// pre-acceptance 其它错误：清理并抛
					this.__cleanupStreaming();
					this.sending = false;
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

			/**
			 * 用户主动取消
			 *
			 * 未 accepted（pre-acceptance）：reject 原 RPC，sendMessage 的 USER_CANCELLED 分支清理乐观消息。
			 *
			 * 已 accepted（post-acceptance）：服务端 run 仍在继续执行。
			 *   不 reject 原 RPC、不立即 reload，仅将 run 置为 settling（保留 streamingMsgs）。
			 *   建立 __cancelling 协调状态，按 CANCEL_TICK_MS 间隔发 coclaw.agent.abort RPC
			 *   重试直到：
			 *     - RPC 返回 ok=true（immediate hit）
			 *     - RPC 返回 not-supported（侧门缺失，静默降级）
			 *     - run 自然结束（isRunning 变 false，lifecycle:end / completion / reconcile 驱动）
			 *   期间 isCancelling=true，UI 禁用 STOP 按钮防止重复触发；无 TTL——协调生命期等于 run 生命期。
			 *
			 * @returns {Promise<object> | null} accepted 分支且有可用 sid/conn 时返回协调 promise，
			 *   resolve 为：
			 *     - `{ ok: true, aborted: 'immediate' }` RPC 成功 abort
			 *     - `{ ok: false, reason: 'not-supported' }` 侧门缺失
			 *     - `{ ok: false, reason: 'run-ended' }` run 已自然结束
			 *     - `{ ok: false, reason: 'superseded' }` 用户发起了新的 send，
			 *       旧取消意图被自身行为超越（chatStore.__clearCancelling('superseded')）
			 *   其它情况（未 accepted / sid 不可知 / conn 不可用）返回 null，调用方降级处理
			 */
			cancelSend() {
				console.info('[chat] cancelSend enter accepted=%s sending=%s runKey=%s',
					this.__accepted, this.sending, this.runKey);

				// 取消进行中的文件上传（pre-acceptance 路径）
				if (this.__uploadHandle) {
					this.__uploadHandle.cancel();
					this.__uploadHandle = null;
				}
				this.uploadingFiles = false;
				this.fileUploadState = null;

				if (this.__accepted) {
					// 幂等：协调已在进行，直接返回已有 promise（按钮禁用下不会触发，保留防御性）
					if (this.__cancelling) {
						console.debug('[chat] cancelSend: already cancelling sid=%s, reuse promise', this.__cancelling.sid);
						return this.__cancelling.promise;
					}
					const runsStore = useAgentRunsStore();
					// 守卫：若 run 已被标记 cancelled 但没有 __cancelling（历史残留），同样跳过
					const activeRun = runsStore.getActiveRun(this.runKey);
					if (activeRun?.cancelled) {
						console.debug('[chat] cancelSend skip: already cancelled runKey=%s', this.runKey);
						return null;
					}
					// 不 reject cancelPromise，让原 agent() RPC 自然 resolve；显式 nullify 槽位，
					// 避免后续 cleanup() 在同一窗口误触发无意义 reject
					this.__cancelReject = null;
					runsStore.settleWithTransitionByKey(this.runKey);
					if (this.__streamingTimer) {
						clearTimeout(this.__streamingTimer);
						this.__streamingTimer = null;
					}
					this.sending = false;
					// 请求插件真正 abort 服务端 run；sessionId 来源：topic 模式 this.sessionId；
					// chat 模式 this.currentSessionId（可能为 null，此时降级为阶段 1 行为）
					const sid = this.sessionId || this.currentSessionId;
					if (!sid) {
						console.info('[chat] cancelSend skip abort RPC: sid unavailable (sessionId=%s currentSessionId=%s)',
							this.sessionId, this.currentSessionId);
						return null;
					}
					const conn = this.__getConnection();
					if (!conn) {
						console.info('[chat] cancelSend skip abort RPC: conn unavailable clawId=%s', this.clawId);
						return null;
					}
					return this.__startCancelCoordination(sid, conn);
				}
				else {
					console.debug('[chat] cancelSend pre-acceptance branch hasCancelReject=%s',
						!!this.__cancelReject);
					if (this.__cancelReject) {
						const err = new Error('user cancelled');
						err.code = 'USER_CANCELLED';
						this.__cancelReject(err);
						this.__cancelReject = null;
					}
					this.__cleanupStreaming();
					this.sending = false;
					return null;
				}
			},

			/**
			 * 终止 cancel 协调任务（不再 tick，promise 以给定原因 resolve）
			 *
			 * 用途：
			 * - `sendMessage` / `sendSlashCommand` 开头（reason='superseded'）——用户发起新交互，
			 *   旧取消意图已被自身行为超越；必须立刻停 tick 以免残留 abort RPC 误杀新 run
			 *   （详见 sendMessage 处注释）。
			 *
			 * `cleanup()` 走自己的路径（同步 null 化 + 让 promise 悬挂，靠页面卸载丢引用）——
			 * 不调本函数，以保持原设计的"无 unhandled 风险"语义。
			 *
			 * @param {'superseded'} reason
			 */
			__clearCancelling(reason) {
				if (!this.__cancelling) return;
				const r = this.__cancelling.resolve;
				if (this.__cancelling.tickTimer) {
					clearTimeout(this.__cancelling.tickTimer);
				}
				this.__cancelling = null;
				r({ ok: false, reason });
			},

			/**
			 * 建立并驱动 cancel 协调任务（accepted 分支的 tick 重试循环）
			 * @param {string} sid - sessionId（用于 abort RPC + 标识协调任务）
			 * @param {object} conn - ClawConnection 实例，已由调用方确保存在
			 * @returns {Promise<object>}
			 */
			__startCancelCoordination(sid, conn) {
				let resolveFn;
				const promise = new Promise((r) => { resolveFn = r; });
				const runKey = this.runKey;
				// 唯一 id（Symbol，原始值经 Pinia reactive 解引用后仍 ===）。
				// 防御：若 await 期间发生 __clearCancelling('superseded') + 新 cancelSend2 →
				// `this.__cancelling` 被替换为新对象；老 tick 用 id 比对发现不再属于自己即退出，
				// 不会污染新 coordination 的 tickSeq / tickTimer / resolve。
				// 注：不能用 `this.__cancelling === me` 因 Pinia reactive 把 me 包成 Proxy，
				// proxy !== 原对象。
				const myId = Symbol('cancel');
				const me = { sid, promise, resolve: resolveFn, tickTimer: null, tickSeq: 0, id: myId };
				this.__cancelling = me;
				remoteLog(`cancel.start sid=${sid}`);

				const isMine = () => this.__cancelling?.id === myId;

				const cleanup = () => {
					if (me.tickTimer) clearTimeout(me.tickTimer);
					if (isMine()) this.__cancelling = null;
				};

				const tick = async () => {
					// 协调已被清除 / 替换 → 立即退出
					if (!isMine()) return;
					const runsStore = useAgentRunsStore();
					if (!runsStore.isRunning(runKey)) {
						console.info('[chat] cancelSend done: run-ended sid=%s', sid);
						remoteLog(`cancel.run-ended sid=${sid}`);
						cleanup();
						resolveFn({ ok: false, reason: 'run-ended' });
						return;
					}
					me.tickSeq += 1;
					let result;
					try {
						result = await conn.request('coclaw.agent.abort', { sessionId: sid });
					} catch (err) {
						// WS 闪断 / 其它 RPC 错误：继续重试，由 run-ended/immediate 路径终止
						if (!isMine()) return;
						console.debug('[chat] cancelSend rpc err sid=%s %s retry in %dms',
							sid, err?.message ?? err, CANCEL_TICK_MS);
						me.tickTimer = setTimeout(tick, CANCEL_TICK_MS);
						return;
					}
					if (!isMine()) return; // cleared / superseded during in-flight
					if (result?.ok) {
						console.info('[chat] cancelSend done: immediate sid=%s ticks=%d', sid, me.tickSeq);
						remoteLog(`cancel.immediate sid=${sid} ticks=${me.tickSeq}`);
						cleanup();
						resolveFn({ ok: true, aborted: 'immediate' });
						return;
					}
					if (result?.reason === 'not-supported') {
						console.info('[chat] cancelSend done: not-supported sid=%s', sid);
						remoteLog(`cancel.not-supported sid=${sid}`);
						cleanup();
						resolveFn({ ok: false, reason: 'not-supported' });
						return;
					}
					// not-found / abort-threw / 其它：继续重试，等空窗期结束或 run 自然结束
					console.debug('[chat] cancelSend miss sid=%s reason=%s retry in %dms',
						sid, result?.reason, CANCEL_TICK_MS);
					me.tickTimer = setTimeout(tick, CANCEL_TICK_MS);
				};

				tick();
				return promise;
			},

			/**
			 * 发送斜杠命令（通过 chat.send RPC）
			 * @param {string} command - 如 '/compact'、'/new'、'/help'
			 */
			async sendSlashCommand(command) {
				if (this.sending) return;
				// 与 sendMessage 对齐：用 wait-mode 取 conn，让 conn.request() 内部 waitReady() 排队
				// 离线 / DC 重建期点击斜杠命令不会被静默丢弃，连接恢复后照常执行
				const conn = useClawConnections().get(this.clawId);
				if (!conn) return;

				// 与 sendMessage 对齐：发起新交互 → 丢弃旧的 cancel 协调，
				// 防止残留 tick 误 abort 新的 chat.send / embedded run
				this.__clearCancelling('superseded');

				this.sending = true;

				// 乐观追加 user message：_pending=true → ChatMsgItem 渲染 spinner 占位、不显示命令文本
				// 与 sendMessage 的设计一致：服务端 accepted 前不展示用户消息正文
				this.messages = [...this.messages, {
					type: 'message',
					id: `__local_user_${Date.now()}`,
					_local: true,
					_pending: true,
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

				// 按命令代价分档超时：
				// - /compact 触发服务端 LLM compaction，可跑很久 → 与 agent run 对齐（24h）
				// - /new、/reset 走 sessions.reset，重量级但很快（~秒级） → 10min
				// - 其它（/help 等）→ 5min
				const isLlmCmd = /^\/compact\b/i.test(command);
				const isHeavyCmd = /^\/(new|reset)\b/i.test(command);
				const slashTimeout = isLlmCmd ? POST_ACCEPT_TIMEOUT_MS : (isHeavyCmd ? 600_000 : 300_000);

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
					// chat.send 已成功送达并返回 runId（语义等价于 agent() 的 onAccepted）
					// → 清 _pending 让本地 user 消息显示出真实命令文本
					let changed = false;
					for (const m of this.messages) {
						if (m._local && m._pending && m.message?.role === 'user') {
							m._pending = false;
							changed = true;
						}
					}
					if (changed) this.messages = [...this.messages];
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
					// 快照本次 slash 的本地占位 id：__cleanupSlashCommand 把 sending 置 false 后，
					// 用户可在 loadMessages 异步期间发起 sendMessage，新添的 _local 若被下方 .then
					// 一锅端，会破坏 sendMessage 的 streamingMsgs 流程。
					const slashLocalIds = this.messages.filter((m) => m._local).map((m) => m.id);
					const removeSlashLocals = () => {
						if (!slashLocalIds.length) return;
						const idSet = new Set(slashLocalIds);
						for (const m of this.messages) {
							if (!idSet.has(m.id) || !m._attachments) continue;
							for (const att of m._attachments) {
								if (att.url) URL.revokeObjectURL(att.url);
							}
						}
						this.messages = this.messages.filter((m) => !idSet.has(m.id));
					};
					this.__cleanupSlashCommand(conn);
					// OpenClaw 不把 /new、/reset、/compact 持久化为 user message（见 commands-compact.ts:71、session.ts:354 拦截点）
					// → final 后统一移除本地乐观占位，避免残留错位到新会话或与 server 历史重复
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
							removeSlashLocals();
							resolve?.();
						});
						return;
					}
					else if (/^\/compact\b/i.test(cmd)) {
						// resolve 放进 .then 保持和 /new|/reset 分支对称——
						// 让 sendSlashCommand 的 caller 的 await 在占位清理完成后才返回
						this.loadMessages({ silent: true }).then(() => {
							removeSlashLocals();
							resolve?.();
						});
						return;
					}
					else if (evt.message) {
						removeSlashLocals();
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
				// 若正在 cancel 协调（用户点 STOP 后到 run 结束前），停止 tick 重试：
				// 原 tick 下一次运行时会因 __cancelling=null 立即 return；resolve 留作未决，
				// 调用方（ChatPage）随页面卸载丢弃 promise 引用，无 unhandled 风险
				if (this.__cancelling) {
					clearTimeout(this.__cancelling.tickTimer);
					this.__cancelling = null;
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
			 * loadMessages 成功后：去除已被服务端持久化的乐观 user 消息
			 * @param {object[]} serverMessages
			 */
			__reconcileRunAfterLoad(serverMessages) {
				useAgentRunsStore().stripLocalUserMsgs(this.runKey, serverMessages);
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
