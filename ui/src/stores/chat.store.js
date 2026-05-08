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
import { useSessionsStore } from './sessions.store.js';
import { getReadyConn } from './get-ready-conn.js';
import { getSharedNotifier } from './notify-hook-bridge.js';
import { remoteLog } from '../services/remote-log.js';
import { i18n } from '../i18n/index.js';

const MSG_PAGE_SIZE = 50;

/** cancelSend accepted 分支的 tick 重试间隔（ms） */
const CANCEL_TICK_MS = 500;

/** DC/WS 断连相关的错误码 */
const DISCONNECT_CODES = new Set(['WS_CLOSED', 'DC_NOT_READY', 'DC_CLOSED', 'RTC_SEND_FAILED', 'RTC_LOST', 'CONNECT_TIMEOUT']);
function isDisconnectError(err) { return DISCONNECT_CODES.has(err?.code); }

/**
 * 创建 ChatStore 实例
 * @param {string} storeKey - 如 'session:1:main' / 'topic:uuid' / 'new-topic:1:main'
 * @param {object} [opts]
 * @param {string} [opts.clawId]
 * @param {string} [opts.agentId]
 * @returns {object} Pinia store 实例
 */
export function createChatStore(storeKey, opts = {}) {
	const topicMode = storeKey.startsWith('topic:');
	const newTopicMode = storeKey.startsWith('new-topic:');
	const clawId = String(opts.clawId || '');
	const agentId = opts.agentId || 'main';
	const sessionId = topicMode ? storeKey.slice('topic:'.length) : '';
	// new-topic 模式不参与 chat sessionKey / agent run 体系（activate 短路、不发 RPC）。
	// chatSessionKey 留空避免 getter / __loadChatHistory 等路径误把它当成普通 chat。
	const chatSessionKey = topicMode || newTopicMode ? '' : `agent:${agentId}:main`;
	const topicAgentId = topicMode ? agentId : '';

	const useStore = defineStore(`chat-${storeKey}`, {
		state: () => ({
			// Identity（创建后不变）
			clawId,
			topicMode,
			newTopicMode,
			chatSessionKey,
			sessionId,
			topicAgentId,

			// 输入区附件（per-chat/topic 隔离，避免共享 ChatInput 实例时跨上下文串台）
			/** @type {Array<{ id: string, isImg: boolean, isVoice: boolean, label: string, name: string, ext: string, bytes: number, file: File|Blob, url: string|null }>} */
			inputFiles: [],

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
			/**
			 * onAccepted 翻 __accepted=true 的瞬间记录的墙钟时间（ms）。
			 * cancel 协调每 tick 用 `Date.now() - __acceptedAt` 实算 runDuration 透传给 plugin
			 * 启发式判定，不要用其它派生量估算（避免 setTimeout 调度漂移失真）。
			 * 仅 sendMessage 入口复位为 0；`cleanup()` 不复位（页面 unmount 时若后台还有 run
			 * 在跑，未来恢复时仍需此基准——目前虽未利用此点，先保持保守）。
			 * @type {number}
			 */
			__acceptedAt: 0,
			__cancelReject: null,
			__retried: false,

			/**
			 * pre-accept 取消意图：已发出 agent 请求但尚未收到 accepted 时用户点了 STOP。
			 * 不立即清理 UI 也不 reject sendMessage，保留气泡并让按钮转"取消中"。
			 * onAccepted 到达后在 sendMessage 的 onAccepted 回调里转交 accepted 分支启动真取消。
			 * 发送因超时/断连/error 终止时，在 catch/retry/cleanup 中清零。
			 * @type {boolean}
			 */
			__pendingCancelIntent: false,

			/**
			 * 取消协调状态：accepted 后用户点 STOP 时建立，直到 run 结束或 RPC 达成终态清除。
			 * 存在期间 isCancelling=true，UI 将 STOP 按钮禁用以防重复触发。
			 * `startedAt` 用于每 tick 实算 abortDuration 透传给 plugin 启发判定。
			 * @type {{ sid: string, promise: Promise<object>, resolve: Function, tickTimer: ReturnType<typeof setTimeout>|null, tickSeq: number, startedAt: number } | null}
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
			/**
			 * 取消协调任务是否正在进行（含 pre-accept 挂起意图 + accepted 后协调两阶段）。
			 *
			 * 兜底：协调任务以 immediate hit 方式提前 cleanup 后 __cancelling 已置 null，但服务端
			 * run 真终态信号尚未到达（run.cancelled=true && !run.ended）时，按钮仍应保持 disable
			 * + loader icon。这一兜底跟"是否还要继续发 abort RPC"是两个维度——协调 promise
			 * 可以早于 run 真 ended 提前 resolve，UI 的"取消中"展示由此 getter 兜底。
			 *
			 * 注：getActiveRun 在 dropRun 之后返回 null，新一轮 run register 之后返回新 run（cancelled=false），
			 * 都会让此分支自然翻 false，不会跨 run 误判。
			 */
			isCancelling() {
				if (this.__cancelling || this.__pendingCancelIntent) return true;
				const run = useAgentRunsStore().getActiveRun(this.runKey);
				return !!(run?.cancelled && !run?.ended);
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
					// new-topic 模式：无消息、无 sessionKey，不触发任何 RPC，标记已加载即可。
					// promote 后会建立新的 topic store 接管，本 store 仅承载 inputFiles。
					if (this.newTopicMode) {
						this.__messagesLoaded = true;
						return;
					}
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
			 * @param {() => void} [opts.onMessagesPersisted] - sessions.get 成功 + this.messages 落地
			 *   后立即同步触发；用于让 __awaitPersistAndDrop 在主数据已就位时立刻 dropRun，
			 *   不等之后阻塞的辅助 RPC（chat.history 慢 reject / 60s timeout 的事故路径下，
			 *   这是双气泡可见窗口 vs 单 RTT 窗口的差别）
			 * @param {boolean} [opts.force] - 绕过飞行守卫，独立跑一次 doLoad。__awaitPersistAndDrop
			 *   专用：终态触发的载入必须拿到与本次 run 状态对齐的 fresh sessions.get，
			 *   不能复用其他来源（activate / connReady / onRefresh）可能 stale 的快照——
			 *   否则 hook 同步触发 dropRun 时基于 stale messages 删 streamingMsgs，
			 *   会让本次 run 的回复整段消失（直到下次 reload 自愈）。force 路径不参与
			 *   `__silentLoadPromise` / `__loadPromise` 体系
			 */
			async loadMessages({ silent = false, limit: limitOverride, onMessagesPersisted, force = false } = {}) {
				// 飞行中守卫：复用已有请求，防止 activate() + connReady watcher 同时触发。
				// force 路径不参与守卫——它需要拿与触发方 run 状态对齐的快照。
				if (!force) {
					if (silent && this.__silentLoadPromise) {
						console.debug('[chat] loadMessages: silent in-flight guard hit, reusing promise');
						return this.__silentLoadPromise;
					}
					if (!silent && this.__loadPromise) {
						console.debug('[chat] loadMessages: in-flight guard hit, reusing promise');
						return this.__loadPromise;
					}
				}

				if (this.topicMode) {
					const p = this.__loadTopicMessages({ silent });
					// force 路径在 topic 模式下也独立、不参与守卫体系，与 chat 模式语义保持一致
					if (!force) {
						if (silent) {
							this.__silentLoadPromise = p;
							p.finally(() => { this.__silentLoadPromise = null; });
						} else {
							this.__loadPromise = p;
							p.finally(() => { this.__loadPromise = null; });
						}
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
						console.debug('[chat] loadMessages raw messages sessionKey=%s count=%d %o',
							this.chatSessionKey, flatMsgs.length, flatMsgs);
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

						// 主数据（this.messages）已就位 → 同步触发 hook，让上游
						// __awaitPersistAndDrop 立刻 dropRun。**不能等 chat.history**：
						// DC 抖动事故路径下它可能长时间挂起（最长 60s timeout），那段窗口内
						// streamingMsgs 与 server 持久化消息并存会被 allMessages 合并成
						// 双气泡（"思考中" + "已思考" 同时存在）。hook 同步抛错仅 warn，
						// 不污染 ok 返回值。
						if (onMessagesPersisted) {
							try { onMessagesPersisted(); }
							catch (hookErr) {
								console.warn('[chat] onMessagesPersisted hook err:', hookErr?.message);
							}
						}

						// 兜底清孤儿占位：覆盖 RTC 真断后 __awaitPersistAndDrop 链上
						// fast-fail（getReadyConn null）+ PC 重建后 connReady watcher 触发
						// 的 silent reload 不传 hook 这条路径——run.ended=true 但 dropRun
						// 没人调，streamingMsgs 永久 orphan。__cleanupRun 已删 entry 时
						// dropRun 内 runKeyIndex 早返回，重复调安全（idempotent）。
						// 用 expectedRunId 防误清：loadMessages 期间用户发新消息 register
						// 抢占老 run，新 run.ended=false → if 不成立；万一极端竞态命中，
						// dropRun 内 runId !== expectedRunId 二次校验也会拦下。
						// partial reply 让位风险（plugin 未落库时 dropRun 直接清空内容）
						// 见 TODO.md "X4 课题"，此为单独课题处理。
						const runsStore = useAgentRunsStore();
						const orphanRun = runsStore.getActiveRun(this.runKey);
						if (orphanRun?.ended) {
							runsStore.dropRun(this.runKey, orphanRun.runId);
						}

						// 获取当前 sessionId（仅用于历史上翻定位）。这是辅助性 RPC，
						// DC 抖动等非致命错误下失败时保留 currentSessionId 旧值即可，
						// 不影响 ok 返回。
						try {
							const hist = await conn.request('chat.history', {
								sessionKey: this.chatSessionKey,
								limit: 1,
							}, { timeout: 60_000 });
							this.currentSessionId = hist?.sessionId ?? null;
						}
						catch (histErr) {
							console.warn('[chat] chat.history failed (non-fatal): %s', histErr?.message);
						}

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
				if (!force) {
					if (silent) {
						this.__silentLoadPromise = p;
						p.finally(() => { this.__silentLoadPromise = null; });
					} else {
						this.__loadPromise = p;
						p.finally(() => { this.__loadPromise = null; });
					}
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
					console.debug('[chat] loadOlderMessages raw messages sessionKey=%s count=%d %o',
						this.chatSessionKey, flatMsgs.length, flatMsgs);
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
					console.debug('[chat] loadTopicMessages raw messages topicId=%s count=%d %o',
						this.sessionId, msgs.length, msgs);
					// 保留乐观消息（sendMessage 与 loadMessages 可能并发执行）
					const localMsgs = this.messages.filter((m) => m._local);
					this.messages = localMsgs.length ? [...msgs, ...localMsgs] : msgs;
					this.__messagesLoaded = true;

					// 重连后 reconcile
					this.__reconcileRunAfterLoad(this.messages);

					// 兜底清孤儿占位（同主分支 loadMessages，topic 模式下 hook 不触发，
					// 全靠这条兜底覆盖 RTC 真断后 ended run 的 streamingMsgs 释放）。
					const runsStore = useAgentRunsStore();
					const orphanRun = runsStore.getActiveRun(this.runKey);
					if (orphanRun?.ended) {
						runsStore.dropRun(this.runKey, orphanRun.runId);
					}

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
				this.__acceptedAt = 0;

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
							'- 图片：![描述](<coclaw-file:文件路径>)',
							'- 其他文件：[文件名](<coclaw-file:文件路径>)',
							'URL 必须用尖括号 < > 包裹，否则文件名中的半角括号、空格等字符会破坏解析。',
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

					// pre-acceptance 闭包级失效标记：超时后置 true，让迟到的 onAccepted（runAgent
					// 内部 conn.request timeout=0 永不超时，server 真返回 accepted 时仍会触发回调）
					// 不再有任何副作用——否则会留下"幻影 bump"和被错误覆盖的 sending/__accepted 状态
					let preAcceptInvalidated = false;

					// pre-acceptance 超时（accepted 之前；accepted 后由 agent-runs.store 内 24h 内存释放保险接管）
					this.__streamingTimer = setTimeout(() => {
						if (!this.__accepted) {
							preAcceptInvalidated = true;
							this.__cleanupStreaming();
							this.sending = false;
							const err = new Error('pre-acceptance timeout');
							err.code = 'PRE_ACCEPTANCE_TIMEOUT';
							timeoutReject(err);
						}
					}, 180_000);

					const runsStore = useAgentRunsStore();
					const runKey = this.runKey;

					// 发起 agent run（内部封装两阶段 RPC + watcher 三路终态信号 rpc/wait/failed）
					const runPromise = runsStore.runAgent({
						conn,
						clawId: this.clawId,
						runKey,
						topicMode: this.topicMode,
						agentParams,
						optimisticMsgs,
						anchorMsgId,
						onAccepted: (payload) => {
							// 本次 send 已被 pre-accept 超时作废，迟到的 accepted 不应再有任何副作用
							if (preAcceptInvalidated) {
								console.debug('[chat] late onAccepted after pre-accept timeout, ignoring');
								return;
							}
							const runId = payload?.runId ?? null;
							console.debug('[chat] agent accepted runId=%s', runId);
							this.__accepted = true;
							this.__acceptedAt = Date.now();
							this.streamingRunId = runId;
							// 本地"乐观活动"标记：服务端已 accept run → 让 MainList agent 列表立刻浮顶
							// （不等下一次 sessions.list）。放在 onAccepted 而非 sendMessage 入口，避免
							// pre-acceptance 失败时留下"幻影 bump"——chat 实际没跑但 agent 在列表里浮顶。
							// 已点 STOP（__pendingCancelIntent）的也不 bump：用户决定取消 → 不留浮顶痕迹。
							// 仅 chat 模式（topic 不在 agent 列表里）。
							if (!this.topicMode && !this.__pendingCancelIntent) {
								useSessionsStore().bumpActivity(this.clawId, this.__resolveAgentId());
							}
							// 清 pre-acceptance timer；post-accept 由 agent-runs.store 内的 24h 兜底接管
							if (this.__streamingTimer) clearTimeout(this.__streamingTimer);
							this.__streamingTimer = null;
							// 移走乐观 _local 条目（streamingMsgs 已由 register 接管显示）
							const localMsgs = this.messages.filter((m) => m._local);
							for (const m of localMsgs) m._pending = false;
							this.messages = this.messages.filter((m) => !m._local);
							// pre-accept 期间用户已点 STOP → 立刻转交 accepted 分支启动真取消
							if (this.__pendingCancelIntent) {
								this.__pendingCancelIntent = false;
								remoteLog(`cancel.handoff runKey=${runKey}`);
								console.info('[chat] cancel intent → handoff to accepted branch runKey=%s', runKey);
								this.cancelSend();
							}
						},
					});

					// 独立挂钩：accepted 后 endRun 信号到达 → loadMessages + dropRun。
					// cancel 路径下 cancelPromise 已 reject，但 runPromise 仍在等真实终态，此 then 接管收尾。
					// dropRun 带 res.runId：loadMessages 期间用户若发新消息 register 同 runKey 的新 run，
					// 旧挂钩的 dropRun 校验 runId 不匹配即跳过，避免误清新 run。
					// "等持久化"已收拢到源头 agent-runs.store 的 rpc grace 窗口，下游 await + drop 即可。
					runPromise.then(async (res) => {
						if (res?.accepted) {
							await this.__awaitPersistAndDrop(res, runKey, runsStore);
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
					// 失败终态（accepted 后 RPC reject / 上游下发 ok=true+status='error'/'timeout'）
					// 透出给调用方（ChatPage）做用户级 notify。endReason 'failed'/'rpc-timeout'
					// 携带 errorMessage（OpenClaw 原始错误文案）；其它 endReason 不携带。
					console.debug('[chat] sendMessage done endReason=%s', final?.endReason);
					return {
						accepted: true,
						endReason: final?.endReason ?? null,
						errorMessage: final?.errorMessage ?? null,
					};
				}
				catch (err) {
					this.__cancelReject = null;
					// 发送已经以某种形式终结，任何挂起的取消意图都失去意义
					this.__pendingCancelIntent = false;

					// 文件上传被取消（cancelSend 在上传阶段触发）：视同用户取消
					if (err?.code === 'ERR_CANCELED' && !this.__accepted) {
						remoteLog(`agent.run.upload-cancelled runKey=${this.runKey}`);
						this.sending = false;
						this.fileUploadState = null;
						this.__removeLocalEntries();
						return { accepted: false };
					}
					// 用户主动取消
					if (err?.code === 'USER_CANCELLED') {
						remoteLog(`agent.run.send-cancelled runKey=${this.runKey} accepted=${this.__accepted}`);
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
						remoteLog(`agent.run.send-retry runKey=${this.runKey} code=${err?.code}`);
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
					// pre-acceptance 其它错误（PRE_ACCEPTANCE_TIMEOUT、retry 也失败的 isDisconnectError、
					// 未知错误）：清理并抛。注意 PRE_ACCEPTANCE_TIMEOUT 是本层 180s 看门狗触发，
					// 此时 runAgent 内的主 RPC（timeout=0）仍在后台挂着，
					// 不会立刻触发 agent-runs.store 的 agent.run.preaccept-failed，所以这条 log 必须留
					remoteLog(`agent.run.send-failed runKey=${this.runKey} code=${err?.code ?? 'unknown'} msg=${err?.message ?? ''}`);
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
			 * pre-accept：按是否仍在上传再分两种情况：
			 *   - **仍在上传**：中断上传 handle，sendMessage 会通过 CANCELLED 错误路径清理乐观消息
			 *     并以 `{ accepted: false }` 结束。
			 *   - **上传已完成、agent RPC 在飞**：不立即清 UI，也不 reject sendMessage，而是挂起
			 *     `__pendingCancelIntent = true`。保留气泡 + 让按钮转"取消中"。等 onAccepted 到达
			 *     后在 sendMessage 的 onAccepted 回调里立刻转交 accepted 分支启动真取消。
			 *
			 * 已 accepted（post-acceptance）：服务端 run 仍在继续执行。
			 *   不 reject 原 RPC、不立即 reload，仅将 run 置为 settling（保留 streamingMsgs）。
			 *   建立 __cancelling 协调状态，按 CANCEL_TICK_MS 间隔发 coclaw.agent.abort RPC
			 *   重试直到：
			 *     - RPC 返回 ok=true（immediate hit）
			 *     - RPC 返回 'gone'（plugin 启发判定 run 已结束 → 主动 settleByCancel + 弹 info toast）
			 *     - RPC 返回 'not-supported'（侧门缺失 → 主动 settleByCancel + 弹 warning toast）
			 *     - run 自然结束（isRunning 变 false，rpc/wait/failed 等真终态信号驱动）
			 *   期间 isCancelling=true，UI 禁用 STOP 按钮 + 换 loader icon；无 TTL——协调生命期 ≡ run 生命期。
			 *   设计意图：用户取消后按钮不消失也不可点，直到 run 真正 ended——这一契约由 isCancelling
			 *   getter 的"cancelled && !ended"兜底承担，与协调 promise 是否已 resolve 解耦。
			 *
			 * @returns {Promise<object> | null} accepted 分支且有可用 sid/conn 时返回协调 promise，
			 *   resolve 为：
			 *     - `{ ok: true, aborted: 'immediate' }` RPC 成功 abort
			 *     - `{ ok: false, reason: 'gone' }` plugin 启发判定 run 大概率已结束
			 *       （UI 已主动 settleByCancel 收尾本地 run；后台真实状态未知，可能仍在跑）
			 *     - `{ ok: false, reason: 'not-supported' }` 侧门缺失
			 *       （UI 已主动 settleByCancel 收尾本地 run；OpenClaw 接口已变更）
			 *     - `{ ok: false, reason: 'run-ended' }` run 已自然结束
			 *     - `{ ok: false, reason: 'superseded' }` 用户发起了新的 send，
			 *       旧取消意图被自身行为超越（chatStore.__clearCancelling('superseded')）
			 *   其它情况（pre-accept / sid 不可知 / conn 不可用）返回 null，调用方降级处理
			 */
			cancelSend() {
				console.info('[chat] cancelSend enter accepted=%s sending=%s runKey=%s pendingIntent=%s',
					this.__accepted, this.sending, this.runKey, this.__pendingCancelIntent);

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

				// pre-accept：仍在上传 → 中断上传 handle
				if (this.__uploadHandle) {
					console.debug('[chat] cancelSend: abort upload');
					this.__uploadHandle.cancel();
					this.__uploadHandle = null;
					this.uploadingFiles = false;
					this.fileUploadState = null;
					// 上传 await 会抛 CANCELLED，由 sendMessage catch 清理本地 + 返回 { accepted: false }
					// 此处不动 __cancelReject / __streamingTimer / sending，避免与 catch 竞态
					return null;
				}

				// pre-accept：上传已完成或无文件，agent RPC 在飞等 accepted → 挂起取消意图
				if (this.__pendingCancelIntent) {
					console.debug('[chat] cancelSend: intent already pending');
					return null;
				}
				this.__pendingCancelIntent = true;
				remoteLog(`cancel.intent runKey=${this.runKey}`);
				console.info('[chat] cancelSend: pending intent runKey=%s', this.runKey);
				return null;
			},

			/**
			 * 终止 cancel 协调任务（不再 tick，promise 以给定原因 resolve）。
			 * 同时清掉 pre-accept 挂起意图——两者都是"旧取消意图"，用户的新交互应当一并超越。
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
				this.__pendingCancelIntent = false;
				if (!this.__cancelling) return;
				const r = this.__cancelling.resolve;
				if (this.__cancelling.tickTimer) {
					clearTimeout(this.__cancelling.tickTimer);
				}
				this.__cancelling = null;
				r({ ok: false, reason });
			},

			/**
			 * 建立并驱动 cancel 协调任务（accepted 分支的 tick 重试循环）。tick 入参附带
			 * `runDuration` / `abortDuration`（墙钟差，ms）供 plugin 启发判定。终态分支：
			 * `immediate` / `gone` / `not-supported` / `run-ended` / `superseded`。详见 `cancelSend` JSDoc。
			 * `gone` / `not-supported` 走 store 内部 getSharedNotifier 弹 toast（让 handoff 路径也能 toast）。
			 * @param {string} sid - sessionId（用于 abort RPC + 标识协调任务）
			 * @param {object} conn - ClawConnection 实例，已由调用方确保存在
			 * @returns {Promise<object>}
			 */
			__startCancelCoordination(sid, conn) {
				let resolveFn;
				const promise = new Promise((r) => { resolveFn = r; });
				const runKey = this.runKey;
				// runDuration 时间基点：onAccepted 翻 __accepted=true 的瞬间。__acceptedAt
				// 一定 >0（cancelSend 入口已 gate this.__accepted=true，onAccepted 同步双置）。
				const acceptedAt = this.__acceptedAt;
				// 唯一 id（Symbol，原始值经 Pinia reactive 解引用后仍 ===）。
				// 防御：若 await 期间发生 __clearCancelling('superseded') + 新 cancelSend2 →
				// `this.__cancelling` 被替换为新对象；老 tick 用 id 比对发现不再属于自己即退出，
				// 不会污染新 coordination 的 tickSeq / tickTimer / resolve。
				// 注：不能用 `this.__cancelling === me` 因 Pinia reactive 把 me 包成 Proxy，
				// proxy !== 原对象。
				const myId = Symbol('cancel');
				const me = {
					sid, promise, resolve: resolveFn, tickTimer: null, tickSeq: 0, id: myId,
					// abortDuration 时间基点：协调任务建立瞬间。每 tick 用 Date.now() - startedAt
					// 实算墙钟差透传给 plugin 启发判定，不要用 tickSeq * CANCEL_TICK_MS 估算
					// （setTimeout 调度漂移会失真，特别是 RPC await 串行化拖长间隔时）。
					startedAt: Date.now(),
				};
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
					const now = Date.now();
					// 透传给 plugin 的启发判定上下文：runDuration / abortDuration 都是墙钟差。
					// 旧版 plugin 不识别这两个字段会原样透传 not-found，UI 继续重试，行为兼容。
					const params = {
						sessionId: sid,
						runDuration: Math.max(0, now - acceptedAt),
						abortDuration: Math.max(0, now - me.startedAt),
					};
					let result;
					try {
						result = await conn.request('coclaw.agent.abort', params);
					} catch {
						// WS 闪断 / 其它 RPC 错误：继续重试，由 run-ended/immediate 路径终止
						if (!isMine()) return;
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
					// 终态收尾前重检 isRunning：若 await 期间 run 已自然结束（rpc/wait/failed
					// 终态信号到达），降级走 run-ended 静默路径，避免 settleByCancel 重复打日志
					// + 给用户多一个 gone toast。仅对 gone/not-supported 这两个会主动收尾的分支生效。
					if ((result?.reason === 'gone' || result?.reason === 'not-supported')
							&& !runsStore.isRunning(runKey)) {
						console.info('[chat] cancelSend done: run-ended (post-await fallback) sid=%s rawReason=%s', sid, result.reason);
						// 用独立事件名 cancel.run-ended-fallback（不复用 cancel.run-ended 前缀）
						// 避免日志消费方按前缀聚合时把 race 兜底路径误归到普通 run-ended 路径
						remoteLog(`cancel.run-ended-fallback sid=${sid} rawReason=${result.reason}`);
						cleanup();
						resolveFn({ ok: false, reason: 'run-ended' });
						return;
					}
					if (result?.reason === 'gone') {
						// plugin 启发判定（双闸 runDuration ≥ 阈值 + abortDuration ≥ 阈值）认为 run
						// 大概率已结束。允许误判：UI 主动 settleByCancel 收尾本地 run，让用户回到可发送
						// 状态；后台若仍在跑，后续 event 会被 __dispatch 入口的 ended guard 全部丢弃。
						// notify 走 store（getSharedNotifier）而非 ChatPage：handoff 路径
						// （pre-accept 挂意图 → onAccepted 内部调 cancelSend）下 ChatPage 的 .then
						// 不在调用链上，只有放在 store 里 toast 才能可靠触发。
						console.info('[chat] cancelSend done: gone sid=%s ticks=%d', sid, me.tickSeq);
						remoteLog(`cancel.gone sid=${sid} ticks=${me.tickSeq} runDur=${params.runDuration} abortDur=${params.abortDuration}`);
						cleanup();
						// settle + notify 包 try/catch：notify/i18n 任一抛不阻断 resolveFn，
						// 否则 coord promise 永挂会让后续 cancelSend 拿到僵尸 promise（chat.store 内
						// __cancelling 已在 cleanup 时清空，但已挂 .then 的调用方仍受影响）
						try {
							runsStore.settleByCancel(runKey, 'cancel-gone');
							getSharedNotifier()?.info({
								title: i18n.global.t('chat.cancelGone'),
								description: i18n.global.t('chat.cancelGoneHint'),
							});
						}
						catch (e) {
							console.warn('[chat] cancelSend gone post-settle hook threw:', e?.message);
						}
						resolveFn({ ok: false, reason: 'gone' });
						return;
					}
					if (result?.reason === 'not-supported') {
						// plugin 上游侧门（embeddedRunState）不存在，无法主动 abort。UI 主动收尾让
						// 用户能继续发新消息；run 后台仍可能在跑（与 'gone' 风险一致）。
						// notify 同 gone 分支：走 store，handoff 路径下也能 toast。
						console.info('[chat] cancelSend done: not-supported sid=%s', sid);
						remoteLog(`cancel.not-supported sid=${sid}`);
						cleanup();
						// 同 gone 分支的容错合约：notify/i18n 抛不阻断 resolveFn
						try {
							runsStore.settleByCancel(runKey, 'cancel-not-supported');
							getSharedNotifier()?.warning({
								title: i18n.global.t('chat.cancelNotSupported'),
								description: i18n.global.t('chat.upgradeOpenClawHint'),
							});
						}
						catch (e) {
							console.warn('[chat] cancelSend not-supported post-settle hook threw:', e?.message);
						}
						resolveFn({ ok: false, reason: 'not-supported' });
						return;
					}
					// not-found / abort-threw / 其它：继续重试，等空窗期结束或 run 自然结束
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
					const result = await conn.request('chat.send', {
						sessionKey: this.chatSessionKey,
						message: command,
						idempotencyKey,
					});
					// 业务级失败防御：上游 chat.send 失败一般走 ok=false（→ catch），但协议
					// 允许 ok=true + payload.status='error'（见 chat.ts:2588）。不防御的话
					// spinner 会卡到 slashTimeout（5min ~ 24h）才超时清理，体感静默失败。
					// status='timeout' 是协议演进保险：当前 chat.ts 未见此分支，但保留兜底，
					// 防上游新增超时反馈而 UI 静默卡死。
					if (result?.status === 'error' || result?.status === 'timeout') {
						const reject = this.__slashCommandReject;
						this.__cleanupSlashCommand(conn);
						this.__removeLocalMessages();
						const rawMsg = result?.summary ?? result?.error ?? result?.errorMessage;
						const errMsg = (typeof rawMsg === 'string' && rawMsg)
							? rawMsg
							: (rawMsg != null ? String(rawMsg) : `chat.send ${result.status}`);
						const err = new Error(errMsg);
						err.code = 'SLASH_CMD_REJECTED';
						if (reject) reject(err);
						else throw err;
						return settlePromise;
					}
					// chat.send 已成功送达并返回 runId（语义等价于 agent() 的 onAccepted）
					// 本地"乐观活动"标记：仅在 server 真正 accept 后才 bump，避免 pre-acceptance 失败留下幻影 bump。
					// 与 sendMessage onAccepted 保持对称——topic 模式不在 agent 列表里，不浮顶
					if (!this.topicMode) {
						useSessionsStore().bumpActivity(this.clawId, this.__resolveAgentId());
					}
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

			// --- 输入区附件管理 ---

			/**
			 * 追加附件到 inputFiles。
			 * 调用方需事先完成大小校验与 formatFileBlob 包装（保留在 ChatInput 入口，
			 * 避免 store 直接 import use-notify）。
			 * @param {object[]} files - 已 formatFileBlob 包装的文件对象
			 */
			addFiles(files) {
				if (!files?.length) return;
				for (const f of files) this.inputFiles.push(f);
			},
			/**
			 * 按下标移除（点 X 按钮）
			 * @param {number} idx
			 */
			removeInputFile(idx) {
				const removed = this.inputFiles.splice(idx, 1);
				if (removed[0]?.url) URL.revokeObjectURL(removed[0].url);
			},
			/**
			 * 按文件 id 移除（上传成功逐个移除）
			 * @param {string} id
			 */
			removeFileById(id) {
				const idx = this.inputFiles.findIndex((f) => f.id === id);
				if (idx === -1) return;
				const [removed] = this.inputFiles.splice(idx, 1);
				if (removed?.url) URL.revokeObjectURL(removed.url);
			},
			/** 清空 inputFiles，对图片释放 ObjectURL */
			clearInputFiles() {
				for (const f of this.inputFiles) {
					if (f.url) URL.revokeObjectURL(f.url);
				}
				this.inputFiles = [];
			},
			/**
			 * 失败回退：把已发送的文件恢复到 inputFiles。
			 * 图片重建 ObjectURL（旧 URL 已在上传 onFileUploaded 回调里 revoke）；
			 * 非图片直接复用。
			 *
			 * 注意：spread `{ ...f }` 会把可能已被 revoke 的 stale `f.url` 一并带入。
			 * 必须对图片显式重赋值 url（即使 f.file 为 null 也把 url 置 null，
			 * 避免模板渲染破图）。
			 * @param {object[]} files
			 */
			restoreFiles(files) {
				if (!files?.length) return;
				for (const f of files) {
					const restored = { ...f };
					if (f.isImg) {
						restored.url = f.file ? URL.createObjectURL(f.file) : null;
					}
					this.inputFiles.push(restored);
				}
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
				// 丢弃 pre-accept 挂起的取消意图（页面都关了，发送一旦触发 onAccepted 也没 store 来接手）
				this.__pendingCancelIntent = false;
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
				// 主动 settle 挂起的 slash command promise，防止 dispose 路径下
				// 调用方 await 永久悬挂（正常 timeout/RPC-error/event-final 路径
				// 都在调用 __cleanupSlashCommand 之后显式 reject/resolve，不经此处）。
				// 快照在 __cleanupSlashCommand 之前取，避免被它清空。
				const pendingSlashResolve = this.__slashCommandResolve;
				// 清理斜杠命令状态
				this.__cleanupSlashCommand(this.__getConnection());
				if (pendingSlashResolve) {
					try { pendingSlashResolve(); }
					catch (err) { console.debug('[chat] slash resolve on cleanup failed: %s', err?.message); }
				}
			},

			/**
			 * 实例被淘汰时的完整清理（由 chatStoreManager.dispose 调用）
			 *
			 * 注意 inputFiles 的 ObjectURL 释放须放在 dispose 而非 cleanup —— cleanup 在 ChatPage
			 * unmount 时也会被调，而切到 /topics 列表是预期保留附件的场景，cleanup 不能丢。
			 * 真正销毁 store（chatStoreManager.dispose / disposeAll）才走到本路径，此时附件随 store 一起释放。
			 */
			dispose() {
				console.debug('[chat] dispose topicMode=%s runKey=%s', this.topicMode, this.runKey);
				this.cleanup();
				for (const f of this.inputFiles) {
					if (f.url) URL.revokeObjectURL(f.url);
				}
				this.inputFiles = [];
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
					console.debug('[chat] loadNextHistory raw messages sessionId=%s count=%d %o',
						entry.sessionId, msgs.length, msgs);

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

			/**
			 * accepted 后 endRun 信号到达：拉服务端 history 并释放 streamingMsgs 遮罩。
			 *
			 * "等持久化"的逻辑在源头 agent-runs.store 的 rpc grace 窗口内已处理：
			 *   - 'rpc' 路径：上游同步 await 链保证 transcript 已写完
			 *   - 'wait' 路径：源头已等满 RPC_GRACE_MS（默认 2s），transcript 大概率写完
             *   - 'failed' 路径：网络异常，不再等
             *
			 * 因此本函数无需再做"是否已写完终态 assistant"的猜测校验——避免 fast follow-up 场景下
			 * 把上一轮的最终回答误判成本轮终态而提前 drop。
             *
			 * silent loadMessages 失败时不 dropRun（沿用旧策略）：避免清掉 streamingMsgs 又
			 * 拉不到终态消息。下次 activate / __onConnReady silent reload 成功才会
			 * 重新走 reconcile 路径——但 stripLocalUserMsgs 在 run.ended=true 时早返回，
			 * 不动 streamingMsgs；__endRun 已清掉 POST_ACCEPT_TIMEOUT_MS 24h 兜底定时器。
			 * 等于 sessions.get 失败时本 run 的 streamingMsgs 永久 orphan（直到 chat 重建）。
			 * 这是预存缺陷，详见 TODO.md 第 2 条。
			 *
			 * **必须用 force 路径**：终态触发的载入必须拿到与本次 run 状态对齐的 fresh
			 * sessions.get。如果复用 activate / connReady / onRefresh 起的 silent reload，
			 * 那个 reload 的 sessions.get 可能在本 run 出现之前就发出去了（A 的快照不含
			 * 本 run 的回复），hook 同步触发 dropRun 时会基于 stale messages 删 streamingMsgs，
			 * 让本 run 的回复整段消失。force 路径独立跑一次 doLoad，自带新鲜快照。
			 *
			 * dropRun 走两条路径互为兜底：
			 *   - **主路径**：onMessagesPersisted hook 在 sessions.get 主数据落地时同步触发——
			 *     chat.history 可能慢挂起最长 60s，hook 让 dropRun 在主数据就位的一瞬间
			 *     就跑，把双气泡可见窗口压回单 RTT。
			 *   - **兜底**：ok=true 时再调一次。覆盖罕见边角（如 hook 函数本身抛错被吞）。
			 *   - **幂等性**：dropRun 内 `runKeyIndex[runKey]` 已删时直接 return，重复调安全。
			 *
			 * @param {{ runId: string, accepted: boolean, endReason: string }} res
			 * @param {string} runKey
			 * @param {object} runsStore - useAgentRunsStore() 实例（来自调用方避免重复 lookup）
			 */
			async __awaitPersistAndDrop(res, runKey, runsStore) {
				const ok = await this.loadMessages({
					silent: true,
					force: true,
					onMessagesPersisted: () => runsStore.dropRun(runKey, res.runId),
				});
				if (ok) runsStore.dropRun(runKey, res.runId);
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
