<template>
	<!--
		⚠️ 布局关键约束 ⚠️
		- 原生壳：AuthedLayout 已约束视口高度，此处用 flex-1+min-h-0 填充剩余空间
		- Web：父容器仅 min-height，需 h-dvh-safe 硬约束以固定 header/footer（临时方案，
		  后续全面改为浏览器滚动后可移除）
		- 勿同时加 flex-1 + h-dvh-safe，否则 flex 算法以 max-content 撑开父容器
	-->
	<div ref="chatRoot" data-testid="chat-root" class="relative flex flex-col overflow-hidden" :class="chatRootClasses">
		<MobilePageHeader :title="chatTitle">
			<template #actions>
				<UButton
					v-if="canOpenFiles"
					data-testid="btn-files"
					class="cc-icon-btn-lg"
					variant="ghost"
					color="neutral"
					icon="i-lucide-folder"
					@click="openFiles"
				/>
				<UButton
					v-if="showNewTopicBtn"
					data-testid="btn-new-topic"
					class="cc-icon-btn-lg"
					variant="ghost"
					color="primary"
					icon="i-lucide-square-pen"
					@click="onNewTopic"
				/>
			</template>
		</MobilePageHeader>
		<header class="z-10 hidden shrink-0 min-h-12 items-center justify-between border-b border-default bg-elevated pl-4 pr-1 lg:pl-5 lg:pr-2 py-1 md:flex">
			<h1 class="text-base">{{ chatTitle }}</h1>
			<div class="flex items-center">
				<UButton
					v-if="canOpenFiles"
					data-testid="btn-files"
					class="cc-icon-btn-lg"
					variant="ghost"
					color="neutral"
					icon="i-lucide-folder"
					@click="openFiles"
				/>
				<UButton
					v-if="showNewTopicBtn"
					data-testid="btn-new-topic"
					class="cc-icon-btn-lg"
					variant="ghost"
					color="primary"
					icon="i-lucide-square-pen"
					@click="onNewTopic"
				/>
			</div>
		</header>

		<!-- flex-1 + min-h-0：让 main 填充剩余空间并内部滚动；移除 min-h-0 会导致撑开父容器 -->
		<main ref="scrollContainer" class="flex-1 min-h-0 overflow-x-hidden overflow-y-auto" @scroll="onScroll" @wheel="onWheel">
			<div class="mx-auto w-full max-w-3xl" :style="!__scrollReady && chatMessages.length ? { visibility: 'hidden' } : undefined">
				<div v-if="connStatusText" class="mx-4 mt-4 rounded-lg px-4 py-2 text-center text-sm" :class="connStatusSeverity === 'warn' ? 'bg-warning/10 text-warning' : 'bg-accented text-muted'">
					{{ connStatusText }}
				</div>
				<!-- 消息分页加载状态提示 -->
				<div v-if="chatStore?.messagesLoading" class="px-4 py-3 text-center text-xs text-muted">
					{{ $t('chat.loading') }}
				</div>
				<!-- 历史加载状态提示 -->
				<div v-else-if="chatStore?.historyLoading" class="px-4 py-3 text-center text-xs text-muted">
					{{ $t('chat.loading') }}
				</div>
				<div v-else-if="showNoMoreHint" class="px-4 pt-3 pb-2 text-center text-xs text-muted">
					{{ $t('chat.noMoreHistory') }}
				</div>
				<div v-else-if="hasMoreHistory" class="px-4 pt-3 pb-2 text-center text-xs text-muted">
					{{ $t('chat.scrollUpForMore') }}
				</div>
				<div v-if="isLoadingChat" class="px-4 py-8 text-center text-sm text-muted">
					{{ $t('chat.loading') }}
				</div>
				<div v-else-if="chatStore?.errorText && !isClawOffline" class="px-4 py-8 text-center text-sm">
					<p class="text-error">{{ chatStore.errorText }}</p>
					<p v-if="chatStore.errorText.includes('unknown method')" class="mt-3 text-muted">
						{{ $t('chat.upgradeOpenClawHint') }}
					</p>
				</div>
				<div v-else-if="chatMessages.length > 0" class="pb-12">
					<template v-for="item in chatMessages" :key="item.id">
						<!-- 历史 session 分隔线 -->
						<div v-if="item.type === 'separator'" class="flex items-center gap-3 px-4 py-3">
							<div class="flex-1 border-t border-dashed border-muted" />
							<span v-if="formatSeparatorLabel(item)" class="text-xs text-muted whitespace-nowrap">{{ formatSeparatorLabel(item) }}</span>
							<div class="flex-1 border-t border-dashed border-muted" />
						</div>
						<ChatMsgItem
							v-else
							:item="item"
							:agent-display="agentDisplay"
							:claw-id="currentClawId"
							:agent-id="currentAgentId"
						/>
					</template>
				</div>
				<div v-else class="px-4 py-8 text-center text-sm text-toned">
					{{ $t('chat.empty') }}
				</div>
			</div>
		</main>

		<ChatInput
			v-if="isTopicRoute || isNewTopic || !!routeClawId"
			ref="chatInput"
			v-model="inputText"
			:sending="chatStore?.isSending ?? false"
			:upload-progress="chatStore?.uploadProgress ?? null"
			:disabled="inputLocked || (isNewTopic ? (!newTopicReady || __creatingTopic) : (isTopicRoute ? (!currentSessionId || isLoadingChat) : (!routeClawId || isLoadingChat)))"
			@send="onSendMessage"
			@cancel="onCancelSend"
		>
			<template #prepend>
				<SlashCommandMenu
					v-if="showSlashMenu"
					class="absolute bottom-full left-0 z-10 pb-1"
					:disabled="chatStore?.isSending || isClawOffline || isLoadingChat"
					@command="onSlashCommand"
				/>
			</template>
		</ChatInput>

		<!-- 拖拽蒙层 -->
		<div
			v-if="dragging"
			class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-default/80"
		>
			<p class="text-lg font-medium text-primary">{{ $t('files.dropHint') }}</p>
		</div>
	</div>
</template>

<script>
import MobilePageHeader from '../components/MobilePageHeader.vue';
import ChatMsgItem from '../components/ChatMsgItem.vue';
import defaultClawAvatar from '../assets/claw-avatars/openclaw.svg';
import ChatInput from '../components/ChatInput.vue';
import SlashCommandMenu from '../components/chat/SlashCommandMenu.vue';
import { useNotify } from '../composables/use-notify.js';
import { useAgentsStore } from '../stores/agents.store.js';
import { useClawsStore } from '../stores/claws.store.js';
import { useTopicsStore } from '../stores/topics.store.js';
import { chatStoreManager } from '../stores/chat-store-manager.js';
import { groupSessionMessages } from '../utils/session-msg-group.js';
import { isCapacitorApp } from '../utils/platform.js';
import { usePullRefreshSuppress } from '../composables/use-pull-refresh.js';
import { isMobileViewport } from '../utils/layout.js';
import { useDraftStore } from '../stores/draft.store.js';

/** 自动生成标题的 user message 数量上限 */
const MAX_AUTO_TITLE_MSGS = 5;

export default {
	name: 'ChatPage',
	components: {
		MobilePageHeader,
		ChatMsgItem,
		ChatInput,
		SlashCommandMenu,
	},
	setup() {
		const { suppress, unsuppress } = usePullRefreshSuppress();
		return {
			notify: useNotify(),
			agentsStore: useAgentsStore(),
			clawsStore: useClawsStore(),
			topicsStore: useTopicsStore(),
			draftStore: useDraftStore(),
			suppressPullRefresh: suppress,
			unsuppressPullRefresh: unsuppress,
		};
	},
	data() {
		return {
			defaultClawAvatar,
			userScrolledUp: false,
			showNoMoreHint: false,
			dragging: false,
			__exiting: false,
			// 新建 topic 流程进行中，抑制 watcher 的重复激活
			__creatingTopic: false,
			// 历史加载进行中，阻止 scrollToBottom 干扰位置恢复
			__loadingHistory: false,
			// 首次消息加载 + scrollToBottom 完成前隐藏消息列表，防止闪顶
			__scrollReady: false,
		};
	},
	computed: {
		/** 草稿持久化的 key，随路由自动切换 */
		draftKey() {
			if (this.isNewTopic) return `new-topic:${this.newTopicClawId}:${this.newTopicAgentId}`;
			if (this.isTopicRoute) {
				const sid = this.$route.params?.sessionId;
				return sid ? `topic:${sid}` : '';
			}
			return this.routeClawId ? `chat:${this.routeClawId}:${this.routeAgentId}` : '';
		},
		/** 输入框文本，映射到 draftStore */
		inputText: {
			get() { return this.draftKey ? this.draftStore.getDraft(this.draftKey) : ''; },
			set(val) { if (this.draftKey) this.draftStore.setDraft(this.draftKey, val); },
		},
		/** 发送已开始但尚未 accepted 期间锁定输入 */
		inputLocked() {
			return !!(this.chatStore?.sending && !this.chatStore?.__accepted);
		},
		chatRootClasses() {
			return isCapacitorApp ? 'flex-1 min-h-0' : 'h-dvh-safe';
		},
		currentSessionId() {
			if (this.isTopicRoute) {
				const sid = this.$route.params?.sessionId;
				return typeof sid === 'string' ? sid.trim() : '';
			}
			return this.chatStore?.currentSessionId || '';
		},
		/** chat 路由的 clawId 参数 */
		routeClawId() {
			return this.$route.params?.clawId || '';
		},
		/** chat 路由的 agentId 参数 */
		routeAgentId() {
			return this.$route.params?.agentId || 'main';
		},
		/** 是否为 topic 路由（包括 new 和已有 topic） */
		isTopicRoute() {
			return this.$route.name === 'topics-chat';
		},
		/** 是否为新建 topic 模式 */
		isNewTopic() {
			return this.isTopicRoute && this.$route.params?.sessionId === 'new';
		},
		/** 新 topic 路由的 query 参数 */
		newTopicAgentId() {
			return this.$route.query?.agent || 'main';
		},
		newTopicClawId() {
			return this.$route.query?.claw || '';
		},
		/** 新 topic 是否具备发送条件 */
		newTopicReady() {
			if (!this.isNewTopic) return false;
			if (!this.newTopicClawId) return false;
			const claw = this.clawsStore.byId[this.newTopicClawId];
			return !!claw?.dcReady;
		},
		/** 当前上下文的 agentId */
		currentAgentId() {
			if (this.isNewTopic) return this.newTopicAgentId;
			if (this.isTopicRoute) {
				const topic = this.topicsStore.findTopic(this.currentSessionId);
				return topic?.agentId || 'main';
			}
			return this.routeAgentId || 'main';
		},
		/** 是否可打开文件管理（新建 topic 时不显示） */
		canOpenFiles() {
			if (this.isNewTopic) return false;
			return !!this.currentClawId && !!this.currentAgentId;
		},
		/** 是否显示"新话题"按钮 */
		showNewTopicBtn() {
			if (this.isTopicRoute) return true;
			return this.currentAgentId === 'main';
		},
		/** 当前上下文的 clawId */
		currentClawId() {
			if (this.isNewTopic) return this.newTopicClawId;
			if (this.isTopicRoute) return this.chatStore?.clawId || '';
			return this.routeClawId;
		},
		/** claw ID 列表快照（仅用于检测 claw 增删，避免 deep watch） */
		clawIds() {
			return Object.keys(this.clawsStore.byId).join(',');
		},
		isClawOffline() {
			const clawId = this.currentClawId;
			if (!clawId) return false;
			const claw = this.clawsStore.byId[clawId];
			return claw ? !claw.online : true;
		},
		/**
		 * 连接状态文案（inline banner）
		 * 仅在连接不可用时显示，基于 rtcPhase 给出精确状态
		 */
		connStatusText() {
			if (this.isNewTopic) return '';
			const clawId = this.currentClawId;
			if (!clawId) return '';
			const claw = this.clawsStore.byId[clawId];
			if (!claw) return this.$t('chat.clawNotFound');
			if (!claw.online) return this.$t('chat.clawOffline');
			// claw 在线但 DC 未就绪 → 根据 rtcPhase 细化
			if (claw.dcReady) return '';
			const phase = claw.rtcPhase;
			if (phase === 'building') return this.$t('chat.connBuilding');
			if (phase === 'recovering') return this.$t('chat.connRecovering');
			if (phase === 'failed') {
				return claw.retryCount > 0
					? this.$t('chat.connFailed')
					: this.$t('chat.connRetryExhausted');
			}
			// idle 或其它 → 通用连接中
			return this.$t('chat.connecting');
		},
		/** 连接状态 banner 的视觉层级：offline/failed 用 warn 色调 */
		connStatusSeverity() {
			if (this.isClawOffline) return 'warn';
			const claw = this.clawsStore.byId[this.currentClawId];
			if (claw?.rtcPhase === 'failed') return 'warn';
			return 'info';
		},
		chatTitle() {
			if (this.isNewTopic) return this.$t('topic.newTopic');
			if (this.isTopicRoute) {
				if (!this.currentSessionId) return '';
				const topic = this.topicsStore.findTopic(this.currentSessionId);
				if (topic?.title) return topic.title;
				return this.$t('topic.newTopic');
			}
			if (!this.routeClawId) return '';
			return this.agentDisplay?.name || 'Agent';
		},
		agentDisplay() {
			const clawId = this.currentClawId;
			const agentId = this.currentAgentId;
			if (!clawId || !agentId) return { name: 'Agent', avatarUrl: null, emoji: null };
			return this.agentsStore.getAgentDisplay(clawId, agentId);
		},
		/** 斜杠命令菜单仅在 chat 模式（非 topic）且有 sessionKey 时显示 */
		showSlashMenu() {
			return !this.isTopicRoute && !this.isNewTopic && !!this.chatStore?.chatSessionKey;
		},
		/** 是否还有未加载的更早历史 session */
		hasMoreHistory() {
			if (this.isTopicRoute || !this.chatStore) return false;
			if (this.chatStore.hasMoreMessages) return true;
			return !this.chatStore.historyExhausted
				&& this.chatStore.historySessionIds.length > 0
				&& !this.isLoadingChat;
		},
		/**
		 * session 模式下 agent 是否已验证存在
		 */
		agentVerified() {
			if (this.isTopicRoute || this.isNewTopic) return true;
			if (!this.routeClawId) return false;
			const entry = this.agentsStore.byClaw[this.routeClawId];
			if (!entry?.fetched) return false;
			return entry.agents.some((a) => a.id === this.routeAgentId);
		},
		/** claw 在线但 agents 尚未加载（WS 连接中） */
		awaitingAgent() {
			if (this.isTopicRoute || this.isNewTopic) return false;
			if (!this.routeClawId || this.isClawOffline) return false;
			const entry = this.agentsStore.byClaw[this.routeClawId];
			return !entry?.fetched;
		},
		/**
		 * 连接就绪：claw 在线 + DC 可用 + (topic 或 agent 已验证)
		 * 驱动首次/重连消息加载，消除时序依赖
		 */
		connReady() {
			if (this.isNewTopic || !this.chatStore) return false;
			const claw = this.clawsStore.byId[this.currentClawId];
			if (!claw || !claw.online) return false;
			if (!claw.dcReady) return false;
			if (this.isTopicRoute) return true;
			return this.agentVerified;
		},
		/**
		 * 消息加载中（计算属性，替代 chatStore.loading 避免命令式标志卡住）
		 * 已初始化 + 消息未成功加载 + 无错误 + 无内容 = 加载中
		 */
		isLoadingChat() {
			const s = this.chatStore;
			if (!s || this.isClawOffline || this.awaitingAgent) return false;
			if (s.allMessages.length > 0 || s.errorText) return false;
			return s.__initialized && !s.__messagesLoaded;
		},

		/**
		 * 当前路由对应的 chat store 实例
		 * 返回 null 表示尚未就绪（新 topic / topic 数据未加载 / 无 clawId）
		 */
		chatStore() {
			if (this.isNewTopic) return null;
			if (this.isTopicRoute) {
				const sid = this.currentSessionId;
				if (!sid) return null;
				const topic = this.topicsStore.findTopic(sid);
				if (!topic) return null;
				return chatStoreManager.get(`topic:${sid}`, { clawId: topic.clawId, agentId: topic.agentId });
			}
			if (!this.routeClawId) return null;
			return chatStoreManager.get(
				`session:${this.routeClawId}:${this.routeAgentId}`,
				{ clawId: this.routeClawId, agentId: this.routeAgentId },
			);
		},

		chatMessages() {
			if (!this.chatStore) return [];
			const items = [];
			// 历史 segments（从最旧到最近）
			for (const seg of this.chatStore.historySegments) {
				const grouped = groupSessionMessages(seg.messages);
				if (grouped.length) {
					if (items.length > 0) {
						items.push({ type: 'separator', id: `sep-${seg.sessionId}`, archivedAt: seg.archivedAt });
					}
					items.push(...grouped);
				}
			}
			// 当前 session 消息（含 agentRunsStore 的流式消息）
			const current = groupSessionMessages(this.chatStore.allMessages);
			if (current.length > 0 && items.length > 0) {
				const latest = this.chatStore.historySessionIds[0];
				items.push({ type: 'separator', id: 'sep-current', archivedAt: latest?.archivedAt ?? null });
			}
			items.push(...current);
			return items;
		},
	},
	watch: {
		/** chatStore 变化时激活（首次 init 或重新进入时 refresh） */
		chatStore: {
			immediate: true,
			handler(store, prevStore) {
				if (this.__creatingTopic) return;
				if (store && store !== prevStore) {
					this.showNoMoreHint = false;
					this.userScrolledUp = false;
					this.__scrollReady = false;
					store.activate();
					// connReady 可能已经为 true 但 watcher 不会触发（值未变）
					// 显式调用确保消息加载和 scrollToBottom 正确执行
					if (this.connReady) {
						this.__onConnReady();
					}
				}
			},
		},
		/** claw 列表变化（增删）时验证路由 — 避免 deep watch 被高频 lastAliveAt 更新触发 */
		clawIds() { this.__validateRoute(); },
		agentVerified(verified) {
			if (!this.isTopicRoute && verified === false) this.__validateRoute();
		},
		isClawOffline(offline) {
			if (offline) {
				this.chatStore?.cancelSend();
			}
			// 上线后由 connReady watcher 驱动消息加载
		},
		/** connReady 驱动消息加载：首次加载或重连刷新
		 * immediate: 确保组件挂载时 connReady 已为 true 的场景也能触发加载
		 * （如返回列表后重新进入会话，claw 已连接但 watcher 不会为初始值触发）
		 */
		connReady: {
			immediate: true,
			handler(ready) {
				if (!ready) {
					// 断连时清除 guard，确保重连后可再次触发
					this.__connReadyStore = null;
					return;
				}
				if (!this.chatStore) return;
				this.__onConnReady();
			},
		},
		chatMessages(msgs, oldMsgs) {
			this.scrollToBottom();
			// 从空到非空：首次消息渲染完成，检测是否需要自动填充历史
			if (msgs.length > 0 && (!oldMsgs || oldMsgs.length === 0)) {
				this.$nextTick(() => this.__autoFillHistory());
			}
		},
	},
	mounted() {
		this.suppressPullRefresh();
		// chatStore watcher (immediate: true) 已处理激活

		// 前台恢复监听：覆盖 WS 未断连时的数据刷新
		this.__lastResumeAt = 0;
		this.__onForeground = () => this.__handleForegroundResume();
		this.__onVisibility = () => {
			if (document.visibilityState === 'visible') this.__handleForegroundResume();
		};
		window.addEventListener('app:foreground', this.__onForeground);
		document.addEventListener('visibilitychange', this.__onVisibility);

		// 拖拽上传
		const root = this.$refs.chatRoot;
		if (root) {
			root.addEventListener('dragover', this.__onDragOver);
			root.addEventListener('dragleave', this.__onDragLeave);
			root.addEventListener('drop', this.__onDrop);
		}
	},
	beforeUnmount() {
		this.__unmounted = true;
		this.unsuppressPullRefresh();
		this.chatStore?.cleanup();
		if (this.__onForeground) {
			window.removeEventListener('app:foreground', this.__onForeground);
		}
		if (this.__onVisibility) {
			document.removeEventListener('visibilitychange', this.__onVisibility);
		}
		const root = this.$refs.chatRoot;
		if (root) {
			root.removeEventListener('dragover', this.__onDragOver);
			root.removeEventListener('dragleave', this.__onDragLeave);
			root.removeEventListener('drop', this.__onDrop);
		}
	},
	methods: {
		async onSendMessage({ text, files }) {
			if ((!text && !files?.length) || this.chatStore?.isSending) return;

			// 新建 topic 流程
			if (this.isNewTopic) {
				return this.__handleNewTopicSend(text, files);
			}

			if (!this.chatStore) return;
			if (!this.isTopicRoute && !this.routeClawId) return;
			if (this.isTopicRoute && !this.currentSessionId) return;

			const savedText = this.inputText;
			const draftKey = this.draftKey;
			this.inputText = '';
			this.userScrolledUp = false;
			this.scrollToBottom();

			try {
				const result = await this.chatStore.sendMessage(text, files);
				if (!result.accepted) {
					// 用闭包 draftKey 恢复，组件可能已 unmount
					if (draftKey) this.draftStore.setDraft(draftKey, savedText);
					this.$refs.chatInput?.restoreFiles(files);
				}
				else {
					this.__tryGenerateTitle();
				}
			}
			catch (err) {
				// 根据 err.code 映射友好文案
				const errMsg = this.__sendErrorMessage(err);
				this.notify.error(errMsg);
				if (!this.chatStore?.__accepted) {
					if (draftKey) this.draftStore.setDraft(draftKey, savedText);
					this.$refs.chatInput?.restoreFiles(files);
				}
			}
		},

		/** 根据 err.code 返回用户友好的错误消息 */
		__sendErrorMessage(err) {
			const codeMap = {
				RPC_TIMEOUT: 'chat.errRpcTimeout',
				PRE_ACCEPTANCE_TIMEOUT: 'chat.errPreAcceptTimeout',
				WS_CLOSED: 'chat.errWsClosed',
				WS_SEND_FAILED: 'chat.errWsSendFailed',
				RTC_SEND_FAILED: 'chat.errRtcSendFailed',
				RTC_LOST: 'chat.errWsClosed',
				// 连接/文件传输错误
				RTC_NOT_READY: 'chat.errRtcSendFailed',
				CONNECT_TIMEOUT: 'chat.errRpcTimeout',
				TRANSFER_INTERRUPTED: 'chat.errTransferInterrupted',
				DC_CLOSED: 'chat.errTransferInterrupted',
				DC_ERROR: 'chat.errTransferInterrupted',
				DC_SEND_FAILED: 'chat.errTransferInterrupted',
				READY_TIMEOUT: 'chat.errRpcTimeout',
				TRANSFER_FAILED: 'chat.errTransferFailed',
				SIZE_EXCEEDED: 'chat.errFileTooLarge',
			};
			const key = codeMap[err?.code];
			if (key) return this.$t(key);
			return this.$t('chat.errUnknown');
		},

		async __handleNewTopicSend(text, files) {
			const agentId = this.newTopicAgentId;
			const clawId = this.newTopicClawId;
			if (!clawId || !agentId) {
				this.notify.error(this.$t('topic.createFailed'));
				return;
			}
			// 插件版本过低时话题功能不可用
			if (this.clawsStore.byId[String(clawId)]?.pluginVersionOk === false) {
				this.notify.warning(this.$t('pluginUpgrade.outdated'));
				return;
			}

			this.__creatingTopic = true;
			const oldDraftKey = this.draftKey;
			let newDraftKey = '';
			try {
				// 1. 创建 topic
				const topicId = await this.topicsStore.createTopic(clawId, agentId);
				// 2. 获取（创建）store 并跳过消息加载
				const store = chatStoreManager.get(`topic:${topicId}`, { clawId, agentId });
				store.activate({ skipLoad: true });
				// 新 topic 无历史消息，直接标记已加载，
				// 避免 connReady watcher 触发 first-load 路径与 sendMessage 竞态
				store.__messagesLoaded = true;
				// 3. 切换路由
				await this.$router.replace({ name: 'topics-chat', params: { sessionId: topicId } });
				// 4. 解除抑制
				this.__creatingTopic = false;
				// 5. 清空旧草稿并发送消息
				if (oldDraftKey) this.draftStore.clearDraft(oldDraftKey);
				this.inputText = '';
				newDraftKey = this.draftKey;
				this.userScrolledUp = false;
				this.scrollToBottom();
				if (!this.chatStore) return;
				const result = await this.chatStore.sendMessage(text, files);
				if (!result.accepted) {
					if (newDraftKey) this.draftStore.setDraft(newDraftKey, text);
					this.$refs.chatInput?.restoreFiles(files);
				}
				else {
					this.__tryGenerateTitle();
				}
			}
			catch (err) {
				this.__creatingTopic = false;
				const errMsg = this.__sendErrorMessage(err);
				this.notify.error(errMsg);
				if (!this.chatStore?.__accepted) {
					if (newDraftKey) this.draftStore.setDraft(newDraftKey, text);
					this.$refs.chatInput?.restoreFiles(files);
				}
			}
		},

		/** 前 N 条 user message 内，若 topic 尚无标题则尝试自动生成 */
		__tryGenerateTitle() {
			if (!this.isTopicRoute || !this.chatStore?.topicMode) return;
			const topicId = this.chatStore.sessionId;
			const clawId = this.chatStore.clawId;
			if (!topicId || !clawId) return;
			const topic = this.topicsStore.findTopic(topicId);
			if (topic?.title) return;
			const userMsgCount = this.chatStore.messages.filter(
				m => m.message?.role === 'user' && !m._local
			).length;
			if (userMsgCount > MAX_AUTO_TITLE_MSGS) return;
			console.debug('[chat] triggering generateTitle topicId=%s userMsgs=%d', topicId, userMsgCount);
			this.topicsStore.generateTitle(clawId, topicId);
		},

		openFiles() {
			if (this.clawsStore.byId[String(this.currentClawId)]?.pluginVersionOk === false) {
				this.notify.warning(this.$t('pluginUpgrade.outdated'));
				return;
			}
			this.$router.push({
				name: 'files',
				params: { clawId: this.currentClawId, agentId: this.currentAgentId },
			});
		},

		/** 新建话题 */
		onNewTopic() {
			const agentId = this.currentAgentId;
			const clawId = this.currentClawId;
			const route = {
				name: 'topics-chat',
				params: { sessionId: 'new' },
				query: { agent: agentId, claw: clawId },
			};
			if (this.isTopicRoute || isMobileViewport(window.innerWidth)) this.$router.replace(route);
			else this.$router.push(route);
		},

		async onSlashCommand(cmd) {
			if (!this.chatStore) return;
			try {
				await this.chatStore.sendSlashCommand(cmd);
				if (!this.chatStore) return;

				if (/^\/(new|reset)\b/i.test(cmd)) {
					this.showNoMoreHint = false;
					this.chatStore.__loadChatHistory();
				}
			}
			catch (err) {
				console.warn('[ChatPage] onSlashCommand failed:', err);
				this.notify.error(err?.message || this.$t('slashCmd.error'));
			}
		},

		onCancelSend() {
			this.chatStore?.cancelSend();
		},

		// --- 拖拽上传 ---
		__onDragOver(e) {
			if (!this.$refs.chatInput) return;
			if (!e.dataTransfer?.types?.includes('Files')) return;
			e.preventDefault();
			this.dragging = true;
		},
		__onDragLeave(e) {
			// 仅离开根元素时关闭蒙层，忽略子元素间的冒泡
			if (this.$refs.chatRoot?.contains(e.relatedTarget)) return;
			this.dragging = false;
		},
		__onDrop(e) {
			e.preventDefault();
			this.dragging = false;
			const files = Array.from(e.dataTransfer?.files || []);
			if (files.length) {
				this.$refs.chatInput?.addFiles(files);
			}
		},

		/**
		 * connReady 触发时的消息加载逻辑
		 * 由 connReady watcher 和 chatStore watcher 共用，确保 connReady 值未变时也能正确加载
		 */
		async __onConnReady() {
			if (!this.chatStore) return;
			// 同一 store 实例去重：chatStore watcher 和 connReady watcher 可能在同一 tick 各触发一次
			if (this.__connReadyStore === this.chatStore) return;
			this.__connReadyStore = this.chatStore;
			// 与 __handleForegroundResume 去重
			this.__lastResumeAt = Date.now();
			// WS 重连时清理挂起的 slash command（event:chat 可能在断连期间丢失）
			this.chatStore.__reconcileSlashCommand();
			const isFirstLoad = !this.chatStore.__messagesLoaded;
			if (isFirstLoad) {
				await this.chatStore.loadMessages();
				if (this.__unmounted || !this.chatStore) return;
				if (!this.chatStore.topicMode) this.chatStore.__loadChatHistory();
			} else if (!this.chatStore.isSending) {
				this.chatStore.loadMessages({ silent: true });
			}
			// 首次加载完成后：强制滚到底部，并检测内容是否不足以填满容器
			if (isFirstLoad) {
				this.$nextTick(() => {
					this.scrollToBottom(true);
					this.__autoFillHistory();
				});
			}
		},

		/**
		 * 前台恢复：WS 未断连时 connReady 不会转换，需独立刷新数据
		 * 与 connReady watcher 去重：2s 内不重复执行
		 */
		__handleForegroundResume() {
			const now = Date.now();
			if (now - this.__lastResumeAt < 2000) return;
			this.__lastResumeAt = now;

			if (!this.chatStore || !this.connReady) return;
			if (this.chatStore.isSending) return;
			console.debug('[ChatPage] foreground resume → silent reload');
			this.chatStore.__reconcileSlashCommand();
			this.chatStore.loadMessages({ silent: true });
		},

		/**
		 * 路由级验证：claw/agent 存在性检查
		 * store 自身通过 WS 重连监听处理数据加载，此处仅做路由合法性判定
		 */
		__validateRoute() {
			if (this.isNewTopic || this.__creatingTopic) return;
			if (!this.clawsStore.fetched) return;

			const bots = this.clawsStore.items;
			if (!bots.length) {
				return this.__exitChat(this.$t('chat.clawUnbound'));
			}

			if (this.isTopicRoute) {
				const topic = this.topicsStore.findTopic(this.currentSessionId);
				if (topic) {
					const ownerBot = bots.find((b) => String(b.id) === String(topic.clawId));
					if (!ownerBot) return this.__exitChat(this.$t('chat.clawUnbound'));
				}
				return;
			}

			if (!this.routeClawId) return;
			const botExists = bots.some((b) => String(b.id) === this.routeClawId);
			if (!botExists) {
				return this.__exitChat(this.$t('chat.clawNotFound'));
			}

			const agentEntry = this.agentsStore.byClaw[this.routeClawId];
			if (agentEntry?.fetched && !agentEntry.agents.some((a) => a.id === this.routeAgentId)) {
				return this.__exitChat(this.$t('chat.agentNotFound'));
			}
		},

		__exitChat(message) {
			if (this.__exiting) return;
			this.__exiting = true;
			this.chatStore?.cleanup();
			this.notify.warning(message);
			this.$router.replace('/');
		},

		/** 分隔线标签 */
		formatSeparatorLabel(item) {
			if (!item.archivedAt) return '';
			return this.__formatDateTime(item.archivedAt);
		},
		__formatDateTime(ts) {
			try {
				const d = new Date(ts);
				const y = d.getFullYear();
				const mo = String(d.getMonth() + 1).padStart(2, '0');
				const dd = String(d.getDate()).padStart(2, '0');
				const hh = String(d.getHours()).padStart(2, '0');
				const mi = String(d.getMinutes()).padStart(2, '0');
				return `${y}-${mo}-${dd} ${hh}:${mi}`;
			}
			catch {
				return '';
			}
		},

		scrollToBottom(force = false) {
			const el = this.$refs.scrollContainer;
			if (!el?.scrollTo) return;
			if (!force && this.userScrolledUp) return;
			if (this.__loadingHistory) return;

			this.$nextTick(() => {
				// 二次检查：$nextTick 排队期间用户可能已上划
				if (!force && this.userScrolledUp) return;
				el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
				// 兜底：DOM 高度可能在 $nextTick 后仍未稳定，下一帧再校验一次
				requestAnimationFrame(() => {
					if (!force && this.userScrolledUp) return;
					if (el.scrollHeight - el.scrollTop - el.clientHeight > 10) {
						el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
					}
					// 首次滚动定位完成，解除 visibility hidden
					if (!this.__scrollReady) this.__scrollReady = true;
				});
			});
		},
		onScroll() {
			const el = this.$refs.scrollContainer;
			if (!el) return;
			const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
			this.userScrolledUp = !atBottom;

			if (el.scrollTop < 50 && !this.isTopicRoute) {
				this.__loadMoreHistory();
			}
		},
		onWheel(e) {
			if (e.deltaY >= 0 || this.isTopicRoute) return;
			const el = this.$refs.scrollContainer;
			if (el && el.scrollTop <= 0) {
				this.__loadMoreHistory();
			}
		},

		/** 消息加载后若内容不足以填满容器，主动加载历史 */
		__autoFillHistory() {
			if (this.isTopicRoute) return;
			const el = this.$refs.scrollContainer;
			if (el && el.scrollHeight <= el.clientHeight) {
				this.__loadMoreHistory();
			}
		},

		async __loadMoreHistory() {
			if (!this.chatStore || this.__loadingHistory) return;
			this.__loadingHistory = true;
			try {
				// 优先加载当前 session 内的更早消息
				if (this.chatStore.hasMoreMessages && !this.chatStore.messagesLoading) {
					const el = this.$refs.scrollContainer;
					const prevHeight = el?.scrollHeight ?? 0;
					const loaded = await this.chatStore.loadOlderMessages();
					// await 后 chatStore 可能因路由变化变为 null
					if (!this.chatStore) return;
					if (loaded && el) {
						this.$nextTick(() => {
							const newHeight = el.scrollHeight;
							el.scrollTop += (newHeight - prevHeight);
						});
					}
					return;
				}

				if (this.chatStore.historyExhausted || this.chatStore.historyLoading) {
					if (this.chatStore.historyExhausted && !this.isTopicRoute && this.userScrolledUp) {
						this.showNoMoreHint = true;
					}
					return;
				}
				const el = this.$refs.scrollContainer;
				const prevHeight = el?.scrollHeight ?? 0;
				const loaded = await this.chatStore.loadNextHistorySession();
				// await 后 chatStore 可能因路由变化变为 null
				if (!this.chatStore) return;
				if (loaded && el) {
					this.$nextTick(() => {
						const newHeight = el.scrollHeight;
						el.scrollTop += (newHeight - prevHeight);
					});
				}
				if (this.chatStore.historyExhausted && !this.isTopicRoute && this.userScrolledUp) {
					this.showNoMoreHint = true;
				}
			} finally {
				this.__loadingHistory = false;
				// 历史加载期间若有实时消息到达，其 scrollToBottom 被阻止了，
				// 此处补偿：若用户本就在底部附近则滚到底部
				this.$nextTick(() => this.scrollToBottom());
			}
		},
	},
};
</script>
