<template>
	<!--
		⚠️ 布局关键约束 ⚠️
		- 原生壳：AuthedLayout 已约束视口高度，此处用 flex-1+min-h-0 填充剩余空间
		- Web：父容器仅 min-height，需 h-dvh-safe 硬约束以固定 header/footer（临时方案，
		  后续全面改为浏览器滚动后可移除）
		- 勿同时加 flex-1 + h-dvh-safe，否则 flex 算法以 max-content 撑开父容器
	-->
	<div data-testid="chat-root" class="relative flex flex-col overflow-hidden" :class="chatRootClasses">
		<MobilePageHeader :title="chatTitle">
			<template #actions>
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
		<header class="z-10 hidden shrink-0 min-h-12 items-center border-b border-default bg-elevated pl-4 py-1 md:flex">
			<h1 class="text-base">{{ chatTitle }}</h1>
			<div class="ml-auto pr-2">
				<UButton
					v-if="showNewTopicBtn"
					data-testid="btn-new-topic"
					class="cc-icon-btn"
					variant="ghost"
					color="primary"
					icon="i-lucide-square-pen"
					@click="onNewTopic"
				/>
			</div>
		</header>

		<!-- flex-1 + min-h-0：让 main 填充剩余空间并内部滚动；移除 min-h-0 会导致撑开父容器 -->
		<main ref="scrollContainer" class="flex-1 min-h-0 overflow-x-hidden overflow-y-auto" @scroll="onScroll" @wheel="onWheel">
			<div class="mx-auto w-full max-w-3xl">
				<div v-if="isBotOffline" class="mx-4 mt-4 rounded-lg bg-warning/10 px-4 py-2 text-center text-sm text-warning">
					{{ $t('chat.botOffline') }}
				</div>
				<div v-else-if="awaitingAgent" class="px-4 py-8 text-center text-sm text-muted">
					{{ $t('chat.connecting') }}
				</div>
				<!-- 消息分页加载状态提示 -->
				<div v-if="chatStore.messagesLoading" class="px-4 py-3 text-center text-xs text-muted">
					{{ $t('chat.loading') }}
				</div>
				<!-- 历史加载状态提示 -->
				<div v-else-if="chatStore.historyLoading" class="px-4 py-3 text-center text-xs text-muted">
					{{ $t('chat.loading') }}
				</div>
				<div v-else-if="showNoMoreHint" class="px-4 pt-3 pb-2 text-center text-xs text-muted">
					{{ $t('chat.noMoreHistory') }}
				</div>
				<div v-else-if="hasMoreHistory" class="px-4 pt-3 pb-2 text-center text-xs text-muted">
					{{ $t('chat.scrollUpForMore') }}
				</div>
				<div v-if="chatStore.loading && !awaitingAgent" class="px-4 py-8 text-center text-sm text-muted">
					{{ $t('chat.loading') }}
				</div>
				<div v-else-if="chatStore.errorText && !isBotOffline" class="px-4 py-8 text-center text-sm">
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
						/>
					</template>
				</div>
				<div v-else class="px-4 py-8 text-center text-sm text-toned">
					{{ $t('chat.empty') }}
				</div>
			</div>
		</main>

		<ChatInput
			v-if="isTopicRoute || isNewTopic || agentVerified"
			ref="chatInput"
			v-model="inputText"
			:sending="chatStore.sending"
			:disabled="isNewTopic ? (!newTopicReady || __creatingTopic) : (isTopicRoute ? (!currentSessionId || isBotOffline || chatStore.loading) : (!routeBotId || isBotOffline || chatStore.loading))"
			@send="onSendMessage"
			@cancel="onCancelSend"
		>
			<template #prepend>
				<SlashCommandMenu
					v-if="showSlashMenu"
					class="absolute bottom-full left-0 z-10 pb-1"
					:disabled="chatStore.sending || isBotOffline || chatStore.loading"
					@command="onSlashCommand"
				/>
			</template>
		</ChatInput>
	</div>
</template>

<script>
import MobilePageHeader from '../components/MobilePageHeader.vue';
import ChatMsgItem from '../components/ChatMsgItem.vue';
import defaultBotAvatar from '../assets/bot-avatars/openclaw.svg';
import ChatInput from '../components/ChatInput.vue';
import SlashCommandMenu from '../components/chat/SlashCommandMenu.vue';
import { useNotify } from '../composables/use-notify.js';
import { useAgentsStore } from '../stores/agents.store.js';
import { useBotsStore } from '../stores/bots.store.js';
import { useTopicsStore } from '../stores/topics.store.js';
import { useChatStore } from '../stores/chat.store.js';
import { useBotConnections } from '../services/bot-connection-manager.js';
import { groupSessionMessages } from '../utils/session-msg-group.js';
import { isCapacitorApp } from '../utils/platform.js';
import { usePullRefreshSuppress } from '../composables/use-pull-refresh.js';
import { isMobileViewport } from '../utils/layout.js';
import { useDraftStore } from '../stores/draft.store.js';

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
			chatStore: useChatStore(),
			botsStore: useBotsStore(),
			topicsStore: useTopicsStore(),
			draftStore: useDraftStore(),
			suppressPullRefresh: suppress,
			unsuppressPullRefresh: unsuppress,
		};
	},
	data() {
		return {
			defaultBotAvatar,
			userScrolledUp: false,
			showNoMoreHint: false,
			__exiting: false,
			// 标记当前 topic 是否为首轮（用于 generateTitle）
			__isFirstRound: false,
			// 新建 topic 流程进行中，抑制 watcher 的重复激活
			__creatingTopic: false,
			// 历史加载中，抑制 messages watcher 的 scrollToBottom
			__loadingHistory: false,
		};
	},
	computed: {
		/** 草稿持久化的 key，随路由自动切换 */
		draftKey() {
			if (this.isNewTopic) return `new-topic:${this.newTopicBotId}:${this.newTopicAgentId}`;
			if (this.isTopicRoute) {
				const sid = this.$route.params?.sessionId;
				return sid ? `topic:${sid}` : '';
			}
			return this.routeBotId ? `chat:${this.routeBotId}:${this.routeAgentId}` : '';
		},
		/** 输入框文本，映射到 draftStore */
		inputText: {
			get() { return this.draftKey ? this.draftStore.getDraft(this.draftKey) : ''; },
			set(val) { if (this.draftKey) this.draftStore.setDraft(this.draftKey, val); },
		},
		chatRootClasses() {
			return isCapacitorApp ? 'flex-1 min-h-0' : 'h-dvh-safe';
		},
		currentSessionId() {
			if (this.isTopicRoute) {
				const sid = this.$route.params?.sessionId;
				return typeof sid === 'string' ? sid.trim() : '';
			}
			return this.chatStore.currentSessionId || '';
		},
		/** chat 路由的 botId 参数 */
		routeBotId() {
			return this.$route.params?.botId || '';
		},
		/** chat 路由的 agentId 参数 */
		routeAgentId() {
			return this.$route.params?.agentId || 'main';
		},
		/** 合并 botId+agentId，用于 watch 去重（避免同一导航触发两次 __activate） */
		__routeKey() {
			return `${this.routeBotId}:${this.routeAgentId}`;
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
		newTopicBotId() {
			return this.$route.query?.bot || '';
		},
		/** 新 topic 是否具备发送条件 */
		newTopicReady() {
			if (!this.isNewTopic) return false;
			if (!this.newTopicBotId) return false;
			const conn = this.__getBotConnection(this.newTopicBotId);
			return conn?.state === 'connected';
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
		/** 是否显示"新话题"按钮：topic 页面始终显示；session 页面仅 main agent 显示 */
		showNewTopicBtn() {
			if (this.isTopicRoute) return true;
			return this.currentAgentId === 'main';
		},
		/** 当前上下文的 botId */
		currentBotId() {
			if (this.isNewTopic) return this.newTopicBotId;
			if (this.isTopicRoute) return this.chatStore.botId;
			return this.routeBotId;
		},
		isBotOffline() {
			const botId = this.currentBotId;
			if (!botId) return false;
			const bot = this.botsStore.items.find((b) => String(b.id) === String(botId));
			return bot ? !bot.online : true;
		},
		chatTitle() {
			if (this.isNewTopic) return this.$t('topic.newTopic');
			if (this.isTopicRoute) {
				if (!this.currentSessionId) return '';
				const topic = this.topicsStore.findTopic(this.currentSessionId);
				if (topic?.title) return topic.title;
				return this.$t('topic.newTopic');
			}
			if (!this.routeBotId) return '';
			return this.agentDisplay?.name || 'Agent';
		},
		agentDisplay() {
			const botId = this.currentBotId;
			const agentId = this.currentAgentId;
			if (!botId || !agentId) return { name: 'Agent', avatarUrl: null, emoji: null };
			return this.agentsStore.getAgentDisplay(botId, agentId);
		},
		/** 斜杠命令菜单仅在 chat 模式（非 topic）且有 sessionKey 时显示 */
		showSlashMenu() {
			return !this.isTopicRoute && !this.isNewTopic && !!this.chatStore.chatSessionKey;
		},
		/** 是否还有未加载的更早历史 session */
		hasMoreHistory() {
			if (this.isTopicRoute) return false;
			// 当前 session 还有更早消息，或有历史 session 可加载
			if (this.chatStore.hasMoreMessages) return true;
			return !this.chatStore.historyExhausted
				&& this.chatStore.historySessionIds.length > 0
				&& !this.chatStore.loading;
		},
		/**
		 * session 模式下 agent 是否已验证存在
		 * - topic 模式 / new topic 不检查（由各自逻辑管理）
		 * - agents 未加载 → false（阻断输入）
		 * - agents 已加载且 agent 在列表中 → true
		 */
		agentVerified() {
			if (this.isTopicRoute || this.isNewTopic) return true;
			if (!this.routeBotId) return false;
			const entry = this.agentsStore.byBot[this.routeBotId];
			if (!entry?.fetched) return false;
			return entry.agents.some((a) => a.id === this.routeAgentId);
		},
		/** bot 在线但 agents 尚未加载（WS 连接中） */
		awaitingAgent() {
			if (this.isTopicRoute || this.isNewTopic) return false;
			if (!this.routeBotId || this.isBotOffline) return false;
			const entry = this.agentsStore.byBot[this.routeBotId];
			return !entry?.fetched;
		},
		chatMessages() {
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
			// 当前 session 消息
			const current = groupSessionMessages(this.chatStore.messages);
			if (current.length > 0 && items.length > 0) {
				// 最近一条孤儿的归档时间 = 当前 session 开始的时间点
				const latest = this.chatStore.historySessionIds[0];
				items.push({ type: 'separator', id: 'sep-current', archivedAt: latest?.archivedAt ?? null });
			}
			items.push(...current);
			return items;
		},
	},
	async mounted() {
		this.suppressPullRefresh();
		await this.__activate();
	},
	watch: {
		__routeKey() {
			if (!this.isTopicRoute) this.__activate();
		},
		'$route.params.sessionId': {
			handler() {
				if (this.isTopicRoute) this.__activate();
			},
		},
		// 数据异步就绪 → 重试或做终态判定
		'botsStore.items': {
			deep: true,
			handler() { this.__retryActivation(); },
		},
		// WS 连接就绪信号：__listenForReady 在 connected 后更新 pluginVersionOk
		'botsStore.pluginVersionOk': {
			deep: true,
			handler() { this.__retryActivation(); },
		},
		// agents 加载完成后做 agent 存在性终态判定
		'agentsStore.byBot': {
			deep: true,
			handler() { if (!this.isTopicRoute) this.__retryActivation(); },
		},
		'topicsStore.items'() {
			if (this.isTopicRoute && !this.isNewTopic) this.__retryActivation();
		},
		isBotOffline(offline) {
			if (offline) {
				this.chatStore.cancelSend();
			}
			else if (!this.isNewTopic) {
				this.chatStore.loadMessages();
			}
		},
		'chatStore.messages'() {
			if (!this.__loadingHistory) {
				this.scrollToBottom();
			}
		},
	},
	beforeUnmount() {
		this.unsuppressPullRefresh();
		this.chatStore.cleanup();
	},
	methods: {
		/** 根据路由上下文激活对应模式 */
		async __activate() {
			if (this.__creatingTopic) return;
			this.showNoMoreHint = false;

			if (this.isNewTopic) {
				this.chatStore.cleanup();
				this.__isFirstRound = true;
				return;
			}
			if (this.isTopicRoute) {
				const topicSessionId = this.currentSessionId;
				const topic = this.topicsStore.findTopic(topicSessionId);
				if (topic) {
					this.__isFirstRound = topic.title === null;
					await this.chatStore.activateTopic(topicSessionId, {
						botId: topic.botId,
						agentId: topic.agentId,
					});
				}
				else {
					this.__isFirstRound = false;
					this.chatStore.loading = true;
				}
				return;
			}
			// session 模式：直接从路由参数获取 botId/agentId
			this.__isFirstRound = false;
			const botId = this.routeBotId;
			const agentId = this.routeAgentId;
			if (!botId) return;
			// agents 已加载时做前置检查，防止向不存在的 agent 发起 RPC
			const agentEntry = this.agentsStore.byBot[botId];
			if (agentEntry?.fetched && !agentEntry.agents.some((a) => a.id === agentId)) {
				return this.__exitChat(this.$t('chat.agentNotFound'));
			}
			await this.chatStore.activateSession(botId, agentId);
		},

		async onSendMessage({ text, files }) {
			if ((!text && !files?.length) || this.chatStore.sending) return;

			// 新建 topic 流程
			if (this.isNewTopic) {
				return this.__handleNewTopicSend(text, files);
			}

			if (!this.isTopicRoute && !this.routeBotId) return;
			if (this.isTopicRoute && !this.currentSessionId) return;

			const savedText = this.inputText;
			this.inputText = '';
			this.userScrolledUp = false;
			this.scrollToBottom();

			try {
				const result = await this.chatStore.sendMessage(text, files);
				if (!result.accepted) {
					this.inputText = savedText;
					this.$refs.chatInput?.restoreFiles(files);
				}
				else {
					this.__tryGenerateTitle();
				}
			}
			catch (err) {
				this.notify.error(err?.message || this.$t('chat.orphanSendFailed'));
				if (!this.chatStore.__accepted) {
					this.inputText = savedText;
					this.$refs.chatInput?.restoreFiles(files);
				}
			}
		},

		async __handleNewTopicSend(text, files) {
			const agentId = this.newTopicAgentId;
			const botId = this.newTopicBotId;
			if (!botId || !agentId) {
				this.notify.error(this.$t('topic.createFailed'));
				return;
			}
			// 插件版本过低时话题功能不可用
			if (this.botsStore.pluginVersionOk[String(botId)] === false) {
				this.notify.warning(this.$t('pluginUpgrade.outdated'));
				return;
			}

			// 标志位：抑制路由 watcher + 禁用输入（防止 createTopic 期间重复发送）
			this.__creatingTopic = true;
			// 路由切换会改变 draftKey，提前清理旧 key 并保存原文
			const oldDraftKey = this.draftKey;
			try {
				// 1. 创建 topic
				const topicId = await this.topicsStore.createTopic(botId, agentId);
				// 2. 激活 topic（跳过消息加载）
				await this.chatStore.activateTopic(topicId, { botId, agentId, skipLoad: true });
				// 3. 切换路由并等待完成（draftKey 从 new-topic:... 变为 topic:${topicId}）
				await this.$router.replace({ name: 'topics-chat', params: { sessionId: topicId } });
				// 4. 解除抑制（路由已稳定，后续 watcher 可正常工作）
				this.__creatingTopic = false;
				// 5. 清空旧草稿并发送消息
				if (oldDraftKey) this.draftStore.clearDraft(oldDraftKey);
				this.inputText = '';
				this.userScrolledUp = false;
				this.scrollToBottom();
				const result = await this.chatStore.sendMessage(text, files);
				if (!result.accepted) {
					this.inputText = text;
					this.$refs.chatInput?.restoreFiles(files);
				}
				else {
					this.__tryGenerateTitle();
				}
			}
			catch (err) {
				this.__creatingTopic = false;
				this.notify.error(err?.message || this.$t('topic.createFailed'));
				if (!this.chatStore.__accepted) {
					this.inputText = text;
					this.$refs.chatInput?.restoreFiles(files);
				}
			}
		},

		/** 首轮完成后触发标题生成 */
		__tryGenerateTitle() {
			if (!this.__isFirstRound || !this.isTopicRoute) return;
			this.__isFirstRound = false;
			const topicId = this.chatStore.sessionId;
			const botId = this.chatStore.botId;
			if (topicId && botId) {
				console.debug('[chat] triggering generateTitle topicId=%s', topicId);
				this.topicsStore.generateTitle(botId, topicId);
			}
		},

		/** 新建话题 */
		onNewTopic() {
			const agentId = this.currentAgentId;
			const botId = this.currentBotId;
			const route = {
				name: 'topics-chat',
				params: { sessionId: 'new' },
				query: { agent: agentId, bot: botId },
			};
			// replace 场景：topic 页面新建（避免话题栈堆积）、窄屏模式（无侧边栏，返回应回列表页）
			if (this.isTopicRoute || isMobileViewport(window.innerWidth)) this.$router.replace(route);
			else this.$router.push(route);
		},

		async onSlashCommand(cmd) {
			try {
				await this.chatStore.sendSlashCommand(cmd);

				if (/^\/(new|reset)\b/i.test(cmd)) {
					this.showNoMoreHint = false;
					// 旧 session 已在 __onChatEvent 中本地追加为 segment，
					// 异步刷新孤儿列表供后续上翻使用（不阻塞渲染）
					this.chatStore.__loadChatHistory();
				}
			}
			catch (err) {
				this.notify.error(err?.message || this.$t('slashCmd.error'));
			}
		},

		onCancelSend() {
			this.chatStore.cancelSend();
		},

		/**
		 * 两阶段重试：
		 * 1) 数据未就绪 → 继续等待（保持 loading）
		 * 2) 数据已就绪 → 终态判定：不可恢复则 notify + 跳转，否则重试
		 */
		__retryActivation() {
			if (this.isNewTopic || this.__creatingTopic) return;

			if (!this.botsStore.fetched) return;

			const bots = this.botsStore.items;
			if (!bots.length) {
				return this.__exitChat(this.$t('chat.botUnbound'));
			}

			if (this.isTopicRoute) {
				return this.__retryTopicActivation(bots);
			}

			// session 模式：检查路由中的 bot 是否仍存在
			if (!this.routeBotId) return;
			const botExists = bots.some((b) => String(b.id) === this.routeBotId);
			if (!botExists) {
				return this.__exitChat(this.$t('chat.botNotFound'));
			}

			// agents 已加载时，检查路由中的 agent 是否存在
			const agentEntry = this.agentsStore.byBot[this.routeBotId];
			if (agentEntry?.fetched) {
				const agentExists = agentEntry.agents.some((a) => a.id === this.routeAgentId);
				if (!agentExists) {
					return this.__exitChat(this.$t('chat.agentNotFound'));
				}
			}

			// 需要重试（连接未就绪、加载中、有错误）
			if (!this.chatStore.botId || this.chatStore.errorText || this.chatStore.loading) {
				this.chatStore.activateSession(this.routeBotId, this.routeAgentId, { force: true });
			}
		},

		__retryTopicActivation(bots) {
			const topic = this.topicsStore.findTopic(this.currentSessionId);
			if (topic) {
				const ownerBot = bots.find((b) => String(b.id) === String(topic.botId));
				if (!ownerBot) {
					return this.__exitChat(this.$t('chat.botUnbound'));
				}
				// topic 已找到但 chat 尚未激活或有错误 → 重试
				if (!this.chatStore.botId || this.chatStore.errorText || this.chatStore.loading) {
					this.chatStore.activateTopic(this.currentSessionId, {
						botId: topic.botId,
						agentId: topic.agentId,
					});
				}
			}
			// topic 尚未加载到 store → 等待 topicsStore 加载完成
		},

		__exitChat(message) {
			if (this.__exiting) return;
			this.__exiting = true;
			this.chatStore.cleanup();
			this.notify.warning(message);
			this.$router.replace('/');
		},

		__getBotConnection(botId) {
			if (!botId) return null;
			return useBotConnections().get(String(botId)) ?? null;
		},

		/** 分隔线标签：历史 session 显示归档日期，当前 session 分隔线无标签 */
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

		scrollToBottom() {
			const el = this.$refs.scrollContainer;
			if (el?.scrollTo && !this.userScrolledUp) {
				this.$nextTick(() => {
					el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
				});
			}
		},
		onScroll() {
			const el = this.$refs.scrollContainer;
			if (!el) return;
			const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
			this.userScrolledUp = !atBottom;

			// 历史懒加载：滚动到顶部时触发
			if (el.scrollTop < 50 && !this.isTopicRoute) {
				this.__loadMoreHistory();
			}
		},
		/** 桌面端：已在顶部时继续上滚（wheel 事件仍触发，scroll 事件不触发） */
		onWheel(e) {
			if (e.deltaY >= 0 || this.isTopicRoute) return;
			const el = this.$refs.scrollContainer;
			if (el && el.scrollTop <= 0) {
				this.__loadMoreHistory();
			}
		},

		async __loadMoreHistory() {
			// 优先加载当前 session 内的更早消息
			if (this.chatStore.hasMoreMessages && !this.chatStore.messagesLoading) {
				const el = this.$refs.scrollContainer;
				const prevHeight = el?.scrollHeight ?? 0;
				this.__loadingHistory = true;
				const loaded = await this.chatStore.loadOlderMessages();
				if (loaded && el) {
					// 保持滚动位置（新内容 prepend 后 scrollHeight 增加）
					this.$nextTick(() => {
						const newHeight = el.scrollHeight;
						el.scrollTop += (newHeight - prevHeight);
						this.__loadingHistory = false;
					});
				} else {
					this.__loadingHistory = false;
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
			this.__loadingHistory = true;
			const loaded = await this.chatStore.loadNextHistorySession();
			if (loaded && el) {
				// 保持滚动位置（新内容 prepend 后 scrollHeight 增加）
				this.$nextTick(() => {
					const newHeight = el.scrollHeight;
					el.scrollTop += (newHeight - prevHeight);
					this.__loadingHistory = false;
				});
			} else {
				this.__loadingHistory = false;
			}
			// 刚加载完最后一段历史后也显示提示
			if (this.chatStore.historyExhausted && !this.isTopicRoute && this.userScrolledUp) {
				this.showNoMoreHint = true;
			}
		},
	},
};
</script>
