<template>
	<!--
		⚠️ 布局关键约束 ⚠️
		- 原生壳：AuthedLayout 已约束视口高度，此处用 flex-1+min-h-0 填充剩余空间
		- Web：父容器仅 min-height，需 h-dvh 硬约束以固定 header/footer（临时方案，
		  后续全面改为浏览器滚动后可移除 h-dvh）
		- 勿同时加 flex-1 + h-dvh，否则 flex 算法以 max-content 撑开父容器
	-->
	<div data-testid="chat-root" class="relative flex flex-col overflow-hidden" :class="chatRootClasses">
		<MobilePageHeader :title="chatTitle">
			<template v-if="isMainSession" #actions>
				<UButton
					class="cc-icon-btn-lg"
					variant="ghost"
					color="primary"
					icon="i-lucide-square-pen"
					:loading="resetting"
					@click="onNewChat"
				/>
			</template>
		</MobilePageHeader>
		<header class="z-10 hidden shrink-0 min-h-12 items-center border-b border-default bg-elevated pl-4 py-1 md:flex">
			<h1 class="text-base --font-medium">{{ chatTitle }}</h1>
			<div class="ml-auto pr-2">
				<UButton
					v-if="isMainSession"
					class="cc-icon-btn"
					variant="ghost"
					color="primary"
					icon="i-lucide-square-pen"
					:loading="resetting"
					@click="onNewChat"
				/>
			</div>
		</header>

		<!-- flex-1 + min-h-0：让 main 填充剩余空间并内部滚动；移除 min-h-0 会导致撑开父容器 -->
		<main ref="scrollContainer" class="flex-1 min-h-0 overflow-x-hidden overflow-y-auto" @scroll="onScroll">
			<div class="mx-auto w-full max-w-3xl">
				<div v-if="isBotOffline" class="mx-4 mt-4 rounded-lg bg-warning/10 px-4 py-2 text-center text-sm text-warning">
					{{ $t('chat.botOffline') }}
				</div>
				<div v-if="loading" class="px-4 py-8 text-center text-sm text-muted">
					{{ $t('chat.loading') }}
				</div>
				<div v-else-if="errorText && !isBotOffline" class="px-4 py-8 text-center text-sm text-error">
					{{ errorText }}
				</div>
				<div v-else-if="chatMessages.length > 0" class="pb-2">
					<ChatMsgItem
						v-for="item in chatMessages"
						:key="item.id"
						:item="item"
					/>
				</div>
				<div v-else class="px-4 py-8 text-center text-sm text-toned">
					{{ $t('chat.empty') }}
				</div>
			</div>
		</main>

		<ChatInput
			ref="chatInput"
			v-model="inputText"
			:sending="sending"
			:disabled="!currentSessionId || isBotOffline"
			@send="onSendMessage"
			@cancel="onCancelSend"
		/>
	</div>
</template>

<script>
import MobilePageHeader from '../components/MobilePageHeader.vue';
import ChatMsgItem from '../components/ChatMsgItem.vue';
import ChatInput from '../components/ChatInput.vue';
import { createGatewayRpcClient } from '../services/gateway.ws.js';
import { useNotify } from '../composables/use-notify.js';
import { useBotsStore } from '../stores/bots.store.js';
import { useSessionsStore } from '../stores/sessions.store.js';
import { groupSessionMessages, cleanDerivedTitle } from '../utils/session-msg-group.js';
import { fileToBase64 } from '../utils/file-helper.js';
import { isNative } from '../utils/capacitor-app.js';

export default {
	name: 'ChatPage',
	components: {
		MobilePageHeader,
		ChatMsgItem,
		ChatInput,
	},
	setup() {
		return { notify: useNotify() };
	},
	data() {
		return {
			rpcClient: null,
			loading: false,
			sending: false,
			errorText: '',
			inputText: '',
			messages: [],
			sessionKeyById: {},
			botsStore: null,
			// 流式状态
			streamingRunId: null,
			streamingTimer: null,
			// 自动滚动
			userScrolledUp: false,
			// 新建对话 loading
			resetting: false,
		};
	},
	computed: {
		chatRootClasses() {
			// 原生壳：flex-1 填充父容器；Web：h-dvh 硬约束视口
			return isNative ? 'flex-1 min-h-0' : 'h-dvh';
		},
		currentSessionId() {
			return typeof this.$route.params?.sessionId === 'string'
				? this.$route.params.sessionId.trim()
				: '';
		},
		currentBotId() {
			if (!this.currentSessionId) {
				return null;
			}
			const session = useSessionsStore().items.find(
				(s) => s.sessionId === this.currentSessionId,
			);
			return session?.botId ?? null;
		},
		isBotOffline() {
			if (!this.currentBotId) {
				return false;
			}
			const bot = this.botsStore?.items?.find(
				(b) => String(b.id) === String(this.currentBotId),
			);
			return bot ? !bot.online : true;
		},
		chatTitle() {
			if (!this.currentSessionId) return '';
			const session = useSessionsStore().items.find(
				(s) => s.sessionId === this.currentSessionId,
			);
			if (session) {
				const label = (typeof session.title === 'string' && session.title.trim())
					? cleanDerivedTitle(session.title) || session.title.trim()
					: cleanDerivedTitle(session.derivedTitle);
				if (label) return label;
			}
			return this.$t('chat.sessionTitle', { id: this.currentSessionId });
		},
		isMainSession() {
			return this.sessionKeyById[this.currentSessionId] === 'agent:main:main';
		},
		detailRoutePrefix() {
			return this.$route.path.startsWith('/topics/') ? '/topics' : '/home';
		},
		/** @type {object[]} 分组后的聊天消息 */
		chatMessages() {
			return groupSessionMessages(this.messages);
		},
	},
	async mounted() {
		this.botsStore = useBotsStore();
		await this.loadSessionMessages();
	},
	watch: {
		'$route.params.sessionId': {
			handler() {
				this.loadSessionMessages();
			},
		},
		isBotOffline(offline) {
			if (offline) {
				this.clearStreamingState();
				this.rpcClient?.close?.();
				this.rpcClient = null;
				this.sending = false;
			}
			else {
				// bot 重新上线，自动刷新
				this.errorText = '';
				this.loadSessionMessages();
			}
		},
		currentBotId(newVal, oldVal) {
			// session 被清理且仍在 chat 路由上：区分"真正解绑"与"离线导致 sessions 清空"
			if (oldVal && !newVal && this.currentSessionId) {
				const botStillExists = this.botsStore?.items?.some(
					(b) => String(b.id) === String(oldVal),
				);
				if (botStillExists) {
					// bot 仍在（只是离线），不提示解绑；isBotOffline watcher 会处理
					return;
				}
				this.clearStreamingState();
				this.rpcClient?.close?.();
				this.rpcClient = null;
				this.sending = false;
				this.notify.warning(this.$t('chat.botUnbound'));
				this.$router.replace(this.detailRoutePrefix === '/topics' ? '/topics' : '/');
			}
		},
		'messages.length'() {
			this.scrollToBottom();
		},
	},
	beforeUnmount() {
		this.clearStreamingState();
		this.rpcClient?.close?.();
		this.rpcClient = null;
	},
	methods: {
		async ensureRpcClient() {
			const botId = this.currentBotId;
			// botId 明确变化时关闭旧连接，重建（botId 为 null 时走下方回退逻辑，不触发重建）
			if (this.rpcClient && botId && this.__rpcBotId !== botId) {
				this.clearStreamingState();
				this.rpcClient.close();
				this.rpcClient = null;
			}
			if (this.rpcClient) {
				return this.rpcClient;
			}
			if (!botId) {
				// 无法从 session 确定 botId 时回退到第一个在线 bot
				let bots = this.botsStore?.items ?? [];
				if (!bots.length) {
					bots = await this.botsStore.loadBots();
				}
				const onlineBot = bots.find((b) => b.online) ?? null;
				if (!onlineBot?.id) {
					throw new Error(this.$t('chat.noActiveBot'));
				}
				this.__rpcBotId = onlineBot.id;
				this.rpcClient = await createGatewayRpcClient({ botId: onlineBot.id });
				return this.rpcClient;
			}
			this.__rpcBotId = botId;
			this.rpcClient = await createGatewayRpcClient({ botId });
			return this.rpcClient;
		},
		/**
		 * @param {object} [opts]
		 * @param {boolean} [opts.silent] - true 时不显示 loading 状态，用于流式结束后静默刷新
		 * @returns {Promise<boolean>} 是否成功加载
		 */
		async loadSessionMessages({ silent = false } = {}) {
			if (!this.currentSessionId) {
				this.messages = [];
				this.errorText = '';
				this.loading = false;
				return false;
			}
			if (!silent) {
				this.loading = true;
				this.errorText = '';
			}
			try {
				const rpc = await this.ensureRpcClient();
				const list = await rpc.request('nativeui.sessions.listAll', {
					agentId: 'main',
					limit: 200,
					cursor: 0,
				});
				const items = Array.isArray(list?.items) ? list.items : [];
				// 仅 indexed + 有 sessionKey 的才走 chat.send；其余视为 orphan
				this.sessionKeyById = Object.fromEntries(
					items
						.filter((item) => item.sessionKey && item.indexed !== false)
						.map((item) => [item.sessionId, item.sessionKey]),
				);
				const cur = this.currentSessionId;
				const hasKey = !!this.sessionKeyById[cur];
				console.debug('[chat] listAll items=%d, current=%s, hasKey=%s, indexed map:', items.length, cur, hasKey, this.sessionKeyById);

				const result = await rpc.request('nativeui.sessions.get', {
					agentId: 'main',
					sessionId: this.currentSessionId,
					limit: 500,
					cursor: 0,
				});
				this.messages = Array.isArray(result?.messages) ? result.messages : [];
			}
			catch (err) {
				if (!silent) {
					this.messages = [];
					this.errorText = err?.message || this.$t('chat.loadFailed');
				}
				return false;
			}
			finally {
				this.loading = false;
				this.scrollToBottom();
			}
			return true;
		},
		async onSendMessage({ text, files }) {
			if ((!text && !files?.length) || !this.currentSessionId || this.sending) {
				return;
			}
			// 构建本地消息 content：有图片时用数组格式，否则用纯文本
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
			// 乐观追加用户消息到 messages
			this.messages = [...this.messages, {
				type: 'message',
				id: `__local_user_${Date.now()}`,
				_local: true,
				message: { role: 'user', content, timestamp: Date.now() },
			}];
			this.userScrolledUp = false;
			this.scrollToBottom();
			// 统一走 agent 方法，indexed 传 sessionKey，orphan 传 sessionId
			await this.sendViaAgent(text, files);
		},
		/** 统一发送：indexed session 传 sessionKey，orphan 传 sessionId */
		async sendViaAgent(text, files = []) {
			let sessionKey = this.sessionKeyById[this.currentSessionId];
			console.debug('[chat] sendViaAgent sessionId=%s sessionKey=%s text=%s', this.currentSessionId, sessionKey ?? '(none)', text.slice(0, 80));
			this.sending = true;
			this.streamingRunId = null;
			// 追加 streaming bot 条目（思考中指示器）
			this.messages = [...this.messages, {
				type: 'message',
				id: `__local_bot_${Date.now()}`,
				_local: true,
				_streaming: true,
				_startTime: Date.now(),
				message: { role: 'assistant', content: '', stopReason: null },
			}];

			// 立即清除输入，提升响应感；失败时恢复
			const savedInputText = this.inputText;
			this.inputText = '';
			let accepted = false;
			this.__agentSettled = false;

			try {
				const rpc = await this.ensureRpcClient();

				// 轮转检测：有 sessionKey 时，发送前查询当前 sessionId 是否一致
				if (sessionKey) {
					const rotated = await this.__detectRotation(rpc, sessionKey);
					if (rotated) {
						sessionKey = null;
					}
				}

				rpc.on('agent', this.onAgentEvent);

				// 构建附件（图片/文件转 base64）
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
				// OpenClaw 要求 message 至少 1 字符；仅有附件无文本时补占位符
				const safeText = (!text && attachments.length) ? '\u{1F449}' : text;
				const agentParams = {
					message: safeText,
					deliver: false,
					idempotencyKey,
				};
				if (attachments.length) {
					agentParams.attachments = attachments;
				}
				// indexed session 用 sessionKey 路由；orphan 用 sessionId 直接指向 transcript
				if (sessionKey) {
					agentParams.sessionKey = sessionKey;
				} else {
					agentParams.sessionId = this.currentSessionId;
				}
				console.debug('[chat] agent request idempotencyKey=%s params:', idempotencyKey, agentParams);

				// pre-acceptance 超时守卫 30s：防止 WS 静默断连导致无限"思考中"
				this.streamingTimer = setTimeout(() => {
					if (!accepted) {
						console.debug('[chat] agent pre-acceptance timeout (30s)');
						this.__agentSettled = true;
						this.notify.error(this.$t('chat.orphanSendFailed'));
						this.clearStreamingState();
						this.sending = false;
						this.rpcClient?.close?.();
						this.rpcClient = null;
					}
				}, 30_000);

				// 两阶段模式：onAccepted 获取 runId 并设置超时守卫，Promise 等待终态
				const final = await rpc.request('agent', agentParams, {
					onAccepted: (payload) => {
						accepted = true;
						this.streamingRunId = payload?.runId ?? null;
						console.debug('[chat] agent accepted runId=%s', this.streamingRunId, payload);

						// 清除 pre-acceptance 计时器，启动 post-acceptance 超时守卫 120s
						if (this.streamingTimer) {
							clearTimeout(this.streamingTimer);
						}
						this.streamingTimer = setTimeout(() => {
							console.debug('[chat] agent timeout (120s), runId=%s', this.streamingRunId);
							this.__agentSettled = true;
							this.notify.error(this.$t('chat.orphanSendTimeout'));
							this.clearStreamingState();
							this.sending = false;
							this.rpcClient?.close?.();
							this.rpcClient = null;
						}, 120_000);
					},
					onUnknownStatus: (status, payload) => {
						this.notify.error(this.$t('chat.unknownRpcStatus', { status }));
						console.error('[chat] unknown agent rpc status=%s payload:', status, payload);
					},
				});
				console.debug('[chat] agent final status=%s runId=%s', final?.status, final?.runId, final);

				// 终态到达，确保清理（lifecycle:end 可能已处理，幂等操作）
				this.__clearStreamingFlags();
				this.__cleanupTimersAndListeners();
				this.sending = false;

				// 容错：未 accepted 且终态非 ok → 恢复输入
				if (!accepted && final?.status !== 'ok') {
					this.inputText = savedInputText;
					this.$refs.chatInput?.restoreFiles(files);
					this.__removeLocalEntries();
				} else {
					await this.__reconcileMessages();
				}
			}
			catch (err) {
				console.error('[chat] sendViaAgent error:', err);
				// lifecycle:end 已完成清理，WS 关闭产生的尾巴错误直接忽略
				if (this.__agentSettled && err?.code === 'WS_CLOSED') {
					return;
				}
				this.notify.error(err?.message || this.$t('chat.orphanSendFailed'));
				this.clearStreamingState();
				this.sending = false;

				// 未 accepted 即失败：恢复输入，避免用户内容丢失
				if (!accepted) {
					this.inputText = savedInputText;
					this.$refs.chatInput?.restoreFiles(files);
				}
			}
		},
		/**
		 * 检测 sessionKey 对应的 sessionId 是否已被 OpenClaw 轮转。
		 * 若轮转则移除映射、通知用户、刷新列表。
		 * @param {object} rpc
		 * @param {string} sessionKey
		 * @returns {boolean} true = 已轮转，调用方应回退 orphan 路径
		 */
		async __detectRotation(rpc, sessionKey) {
			try {
				const hist = await rpc.request('chat.history', { sessionKey, limit: 1 });
				const remoteId = hist?.sessionId ?? null;
				console.debug('[chat] rotation check: remote=%s local=%s', remoteId, this.currentSessionId);
				if (remoteId && remoteId !== this.currentSessionId) {
					// 轮转发生：回退为 orphan 路径
					delete this.sessionKeyById[this.currentSessionId];
					this.notify.warning(this.$t('chat.sessionRotated'));
					// 并行刷新 sessions 列表（不阻塞发送）
					useSessionsStore().loadAllSessions();
					return true;
				}
			}
			catch (err) {
				// chat.history 失败不阻塞发送
				console.warn('[chat] rotation check failed, proceeding with sessionKey:', err);
			}
			return false;
		},
		/** 处理 agent 事件流 */
		async onAgentEvent(payload) {
			const match = this.streamingRunId && payload?.runId === this.streamingRunId;
			console.debug('[chat] agent event runId=%s (expect %s, match=%s) stream=%s data:', payload?.runId, this.streamingRunId, match, payload?.stream, payload?.data);
			if (!match) {
				return;
			}
			const { stream, data } = payload;
			if (stream === 'assistant' && data?.text != null) {
				const entry = this.__findStreamingBotEntry();
				if (entry) {
					// 保留已有 thinking blocks，替换/追加 text block
					const content = this.__ensureContentArray(entry);
					const nonText = content.filter((b) => b.type !== 'text');
					entry.message.content = [...nonText, { type: 'text', text: data.text }];
					entry.message.stopReason = 'stop';
					this.messages = [...this.messages];
					this.scrollToBottom();
				}
			} else if (stream === 'tool') {
				if (data?.phase === 'start') {
					const entry = this.__findStreamingBotEntry();
					if (entry) {
						const content = this.__ensureContentArray(entry);
						content.push({ type: 'toolCall', name: data.name ?? 'unknown' });
						entry.message.stopReason = 'toolUse';
						this.messages = [...this.messages];
						this.scrollToBottom();
					}
				} else if (data?.phase === 'result' && data.result != null) {
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
			} else if (stream === 'thinking' && data?.text != null) {
				const entry = this.__findStreamingBotEntry();
				if (entry) {
					const content = this.__ensureContentArray(entry);
					const lastIdx = content.length - 1;
					if (lastIdx >= 0 && content[lastIdx].type === 'thinking') {
						content[lastIdx] = { type: 'thinking', thinking: data.text };
					} else {
						content.push({ type: 'thinking', thinking: data.text });
					}
					this.messages = [...this.messages];
					this.scrollToBottom();
				}
			} else if (stream === 'lifecycle') {
				console.debug('[chat] lifecycle phase=%s', data?.phase);
				if (data?.phase === 'end') {
					this.__agentSettled = true;
					this.sending = false;
					this.__cleanupTimersAndListeners();
					// Phase 1：清除 streaming 标记 → DOM 平滑过渡到完成态
					this.__clearStreamingFlags();
					// Phase 2：后台 reconcile
					this.rpcClient?.close?.();
					this.rpcClient = null;
					await this.__reconcileMessages();
					// reconcile 失败时保留本地内容可见
				} else if (data?.phase === 'error') {
					this.notify.error(data?.message || this.$t('chat.orphanSendFailed'));
					this.clearStreamingState();
					this.sending = false;
				}
			}
		},
		/** 清理流式状态 + 移除本地条目（用于错误/取消路径） */
		clearStreamingState() {
			console.debug('[chat] clearStreamingState runId=%s', this.streamingRunId);
			this.__cleanupTimersAndListeners();
			this.__removeLocalEntries();
		},
		/** 清理定时器和事件监听 */
		__cleanupTimersAndListeners() {
			if (this.streamingTimer) {
				clearTimeout(this.streamingTimer);
				this.streamingTimer = null;
			}
			this.streamingRunId = null;
			this.rpcClient?.off?.('agent', this.onAgentEvent);
		},
		/** 移除 messages 中所有 _local 条目 */
		__removeLocalEntries() {
			if (this.messages.some((e) => e._local)) {
				this.messages = this.messages.filter((e) => !e._local);
			}
		},
		/** 清除 messages 中所有 _streaming 标记（DOM 平滑过渡到完成态） */
		__clearStreamingFlags() {
			let changed = false;
			for (const entry of this.messages) {
				if (entry._streaming) {
					entry._streaming = false;
					changed = true;
				}
			}
			if (changed) {
				this.messages = [...this.messages];
			}
		},
		/** 找到最后一个 _streaming 的 assistant 条目 */
		__findStreamingBotEntry() {
			for (let i = this.messages.length - 1; i >= 0; i--) {
				const e = this.messages[i];
				if (e._streaming && e.message?.role === 'assistant') return e;
			}
			return null;
		},
		/** 确保条目的 content 为数组格式 */
		__ensureContentArray(entry) {
			const c = entry.message.content;
			if (Array.isArray(c)) return c;
			entry.message.content = (c && typeof c === 'string') ? [{ type: 'text', text: c }] : [];
			return entry.message.content;
		},
		/**
		 * 流式结束后刷新 sessionKeyById 映射。
		 * 不替换 messages：本地流式内容已完整，替换会因 v-for key 变化导致 DOM 重建和视觉抖动。
		 * 下次路由切换时 loadSessionMessages 会获取最新 server 数据。
		 */
		async __reconcileMessages() {
			try {
				const rpc = await this.ensureRpcClient();
				const list = await rpc.request('nativeui.sessions.listAll', {
					agentId: 'main', limit: 200, cursor: 0,
				});
				const items = Array.isArray(list?.items) ? list.items : [];
				this.sessionKeyById = Object.fromEntries(
					items.filter((i) => i.sessionKey && i.indexed !== false)
						.map((i) => [i.sessionId, i.sessionKey]),
				);
				// 同步刷新 sessions store（更新标题等元信息）
				useSessionsStore().loadAllSessions();
				return true;
			} catch (err) {
				console.warn('[chat] reconcile failed:', err);
				return false;
			}
		},
		scrollToBottom() {
			const el = this.$refs.scrollContainer;
			if (el?.scrollTo && !this.userScrolledUp) {
				this.$nextTick(() => {
					el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
				});
			}
		},
		onScroll() {
			const el = this.$refs.scrollContainer;
			if (!el) return;
			const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
			this.userScrolledUp = !atBottom;
		},
		async onNewChat() {
			this.resetting = true;
			try {
				const rpc = await this.ensureRpcClient();
				const resetResult = await rpc.request('sessions.reset', { key: 'agent:main:main', reason: 'new' });
				const newSessionId = resetResult?.entry?.sessionId;
				if (!newSessionId) {
					throw new Error('Failed to resolve new session');
				}
				await useSessionsStore().loadAllSessions();
				this.$router.push({ name: 'chat', params: { sessionId: newSessionId } });
			}
			catch (err) {
				console.error('[chat] onNewChat error:', err);
				this.notify.error(this.$t('chat.newChatFailed'));
			}
			finally {
				this.resetting = false;
			}
		},
		onCancelSend() {
			this.clearStreamingState();
			this.sending = false;
		},
	},
};
</script>
