<template>
	<!--
		⚠️ 布局关键约束 — 请勿添加 flex-1 ⚠️
		此根元素用 h-dvh 固定为视口高度，内部 <main> 用 flex-1+min-h-0 实现滚动。
		若加上 flex-1，当父容器（AuthedLayout section）无固定 height（仅 min-height）时，
		flex 算法会以 max-content 尺寸替代 h-dvh，导致整个页面被消息内容撑开，
		header/footer 随之滚出视口。此 bug 已多次复现，切勿重犯。
	-->
	<div data-testid="chat-root" class="relative flex h-dvh flex-col overflow-hidden">
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
			// 流式状态（统一走 agent 方法）
			streamingText: '',
			streamingRunId: null,
			streamingTimer: null,
			streamingSteps: [],
			streamingStartTime: null,
			// 乐观用户消息
			pendingUserMsg: '',
			// 思考中指示器
			isThinking: false,
			// 自动滚动
			userScrolledUp: false,
			// 新建对话 loading
			resetting: false,
		};
	},
	computed: {
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
			const items = groupSessionMessages(this.messages);
			// 乐观用户消息
			if (this.pendingUserMsg) {
				items.push({
					id: '__pending_user__',
					type: 'user',
					textContent: this.pendingUserMsg,
					images: [],
					timestamp: null,
				});
			}
			// 流式/思考中 bot 消息
			if (this.isThinking || this.streamingText) {
				items.push({
					id: '__streaming__',
					type: 'botTask',
					resultText: this.streamingText,
					isStreaming: true,
					startTime: this.streamingStartTime,
					model: null,
					timestamp: null,
					duration: null,
					steps: this.streamingSteps,
					images: [],
				});
			}
			return items;
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
		streamingText() {
			this.scrollToBottom();
		},
		'streamingSteps.length'() {
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
			this.pendingUserMsg = text;
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
			this.streamingText = '';
			this.streamingRunId = null;
			this.streamingSteps = [];
			this.streamingStartTime = Date.now();
			this.isThinking = true;

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
							this.pendingUserMsg = '';
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

				// 终态到达，确保清理（lifecycle:end 可能已处理，clearStreamingState 是幂等的）
				this.pendingUserMsg = '';
				this.clearStreamingState();
				this.sending = false;

				// 容错：未 accepted 且终态非 ok → 恢复输入
				if (!accepted && final?.status !== 'ok') {
					this.inputText = savedInputText;
					this.$refs.chatInput?.restoreFiles(files);
				} else {
					await this.loadSessionMessages({ silent: true });
				}
			}
			catch (err) {
				console.error('[chat] sendViaAgent error:', err);
				// 已通过 timeout 或 lifecycle:end 处理时，忽略 WS 关闭产生的尾巴错误
				if (!(this.__agentSettled && err?.code === 'WS_CLOSED')) {
					this.notify.error(err?.message || this.$t('chat.orphanSendFailed'));
				}
				this.pendingUserMsg = '';
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
				this.isThinking = false;
				this.streamingText = data.text;
			} else if (stream === 'tool') {
				if (data?.phase === 'start') {
					this.streamingSteps = [...this.streamingSteps, { kind: 'toolCall', name: data.name ?? 'unknown' }];
				} else if (data?.phase === 'result' && data.result != null) {
					const text = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
					this.streamingSteps = [...this.streamingSteps, { kind: 'toolResult', text }];
				}
			} else if (stream === 'thinking' && data?.text != null) {
				// 替换最后一条 thinking step 或新增
				const steps = [...this.streamingSteps];
				const lastIdx = steps.length - 1;
				if (lastIdx >= 0 && steps[lastIdx].kind === 'thinking') {
					steps[lastIdx] = { kind: 'thinking', text: data.text };
				} else {
					steps.push({ kind: 'thinking', text: data.text });
				}
				this.streamingSteps = steps;
			} else if (stream === 'lifecycle') {
				console.debug('[chat] lifecycle phase=%s', data?.phase);
				if (data?.phase === 'end') {
					this.__agentSettled = true;
					this.sending = false;
					this.rpcClient?.off?.('agent', this.onAgentEvent);
					if (this.streamingTimer) {
						clearTimeout(this.streamingTimer);
						this.streamingTimer = null;
					}
					this.streamingRunId = null;
					this.isThinking = false;
					// 静默刷新：使用新连接确保可用；失败则保留流式内容和乐观消息
					this.rpcClient?.close?.();
					this.rpcClient = null;
					let refreshOk = await this.loadSessionMessages({ silent: true });
					if (!refreshOk) {
						this.rpcClient = null;
						refreshOk = await this.loadSessionMessages({ silent: true });
					}
					if (refreshOk) {
						// 刷新成功：持久化消息已加载，清除临时 UI 状态
						this.streamingText = '';
						this.streamingSteps = [];
						this.streamingStartTime = null;
						this.pendingUserMsg = '';
					}
					// 刷新失败：保留 streamingText 和 pendingUserMsg 可见
				} else if (data?.phase === 'error') {
					this.notify.error(data?.message || this.$t('chat.orphanSendFailed'));
					this.pendingUserMsg = '';
					this.clearStreamingState();
					this.sending = false;
				}
			}
		},
		/** 清理流式状态 + 取消事件监听 */
		clearStreamingState() {
			console.debug('[chat] clearStreamingState runId=%s, textLen=%d', this.streamingRunId, this.streamingText.length);
			if (this.streamingTimer) {
				clearTimeout(this.streamingTimer);
				this.streamingTimer = null;
			}
			this.streamingText = '';
			this.streamingRunId = null;
			this.streamingSteps = [];
			this.streamingStartTime = null;
			this.isThinking = false;
			this.rpcClient?.off?.('agent', this.onAgentEvent);
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
