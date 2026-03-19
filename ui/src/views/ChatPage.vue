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
				<!-- 历史加载状态提示 -->
				<div v-if="chatStore.historyLoading" class="px-4 py-3 text-center text-xs text-muted">
					{{ $t('chat.loading') }}
				</div>
				<div v-else-if="showNoMoreHint" class="px-4 pt-3 pb-2 text-center text-xs text-muted">
					{{ $t('chat.noMoreHistory') }}
				</div>
				<div v-if="chatStore.loading" class="px-4 py-8 text-center text-sm text-muted">
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
			ref="chatInput"
			v-model="inputText"
			:sending="chatStore.sending"
			:disabled="isNewTopic ? (!newTopicReady || __creatingTopic) : (!currentSessionId || isBotOffline || chatStore.loading)"
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
import { useSessionsStore } from '../stores/sessions.store.js';
import { useTopicsStore } from '../stores/topics.store.js';
import { useChatStore } from '../stores/chat.store.js';
import { useBotConnections } from '../services/bot-connection-manager.js';
import { groupSessionMessages } from '../utils/session-msg-group.js';
import { isCapacitorApp } from '../utils/platform.js';
import { usePullRefreshSuppress } from '../composables/use-pull-refresh.js';
import { isMobileViewport } from '../utils/layout.js';

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
			sessionsStore: useSessionsStore(),
			topicsStore: useTopicsStore(),
			suppressPullRefresh: suppress,
			unsuppressPullRefresh: unsuppress,
		};
	},
	data() {
		return {
			defaultBotAvatar,
			inputText: '',
			userScrolledUp: false,
			showNoMoreHint: false,
			__exiting: false,
			// 标记当前 topic 是否为首轮（用于 generateTitle）
			__isFirstRound: false,
			// 新建 topic 流程进行中，抑制 watcher 的重复激活
			__creatingTopic: false,
			// /new|/reset 过渡期间，抑制 __activate/__retryActivation 竞态
			__resetTransition: false,
		};
	},
	computed: {
		chatRootClasses() {
			return isCapacitorApp ? 'flex-1 min-h-0' : 'h-dvh-safe';
		},
		currentSessionId() {
			return typeof this.$route.params?.sessionId === 'string'
				? this.$route.params.sessionId.trim()
				: '';
		},
		/** 是否为 topic 路由（包括 new 和已有 topic） */
		isTopicRoute() {
			return this.$route.name === 'topics-chat';
		},
		/** 是否为新建 topic 模式 */
		isNewTopic() {
			return this.isTopicRoute && this.currentSessionId === 'new';
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
			return this.agentsStore.parseAgentId(this.chatStore.currentSessionKey) || 'main';
		},
		/** 是否显示"新话题"按钮：topic 页面始终显示；session 页面仅 main agent 显示 */
		showNewTopicBtn() {
			if (this.isTopicRoute) return true;
			return this.currentAgentId === 'main';
		},
		/** 当前上下文的 botId */
		currentBotId() {
			if (this.isNewTopic) return this.newTopicBotId;
			return this.chatStore.botId;
		},
		isBotOffline() {
			const botId = this.currentBotId;
			if (!botId) return false;
			const bot = this.botsStore.items.find((b) => String(b.id) === String(botId));
			return bot ? !bot.online : true;
		},
		chatTitle() {
			if (this.isNewTopic) return this.$t('topic.newTopic');
			if (!this.currentSessionId) return '';
			// topic 模式
			if (this.isTopicRoute) {
				const topic = this.topicsStore.findTopic(this.currentSessionId);
				if (topic?.title) return topic.title;
				return this.$t('topic.newTopic');
			}
			// session 模式：显示 agent 名称
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
		'$route.params.sessionId': {
			handler() {
				this.__activate();
			},
		},
		// 数据异步就绪 → 重试或做终态判定
		'botsStore.items': {
			deep: true,
			handler() { this.__retryActivation(); },
		},
		'sessionsStore.items'() {
			if (!this.isTopicRoute) this.__retryActivation();
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
			this.scrollToBottom();
		},
	},
	beforeUnmount() {
		this.unsuppressPullRefresh();
		this.chatStore.cleanup();
	},
	methods: {
		/** 根据路由上下文激活对应模式 */
		async __activate() {
			// 新建 topic / session reset 流程进行中，抑制 watcher 触发的重复激活
			if (this.__creatingTopic || this.__resetTransition) return;
			this.showNoMoreHint = false;
			if (this.isNewTopic) {
				// 新建 topic：清空状态，不加载消息
				this.chatStore.cleanup();
				this.__isFirstRound = true;
				return;
			}
			if (this.isTopicRoute) {
				// 已有 topic：从 topicsStore 获取元信息并激活
				const topic = this.topicsStore.findTopic(this.currentSessionId);
				if (topic) {
					this.__isFirstRound = topic.title === null;
					await this.chatStore.activateTopic(this.currentSessionId, {
						botId: topic.botId,
						agentId: topic.agentId,
					});
				}
				else {
					// topic 未加载到 store（可能 topics 尚未加载），保持 loading 等待 retry
					this.__isFirstRound = false;
					this.chatStore.loading = true;
				}
				return;
			}
			// session 模式：从 sessionsStore 反查 sessionKey 和 botId
			this.__isFirstRound = false;
			const id = this.currentSessionId;
			const session = this.sessionsStore.items.find((s) => s.sessionId === id);
			await this.chatStore.activateSession(typeof id === 'string' ? id.trim() : '', {
				botId: session?.botId,
				sessionKey: session?.sessionKey,
			});
		},

		async onSendMessage({ text, files }) {
			if ((!text && !files?.length) || this.chatStore.sending) return;

			// 新建 topic 流程
			if (this.isNewTopic) {
				return this.__handleNewTopicSend(text, files);
			}

			if (!this.currentSessionId) return;

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
			try {
				// 1. 创建 topic
				const topicId = await this.topicsStore.createTopic(botId, agentId);
				// 2. 激活 topic（跳过消息加载）
				await this.chatStore.activateTopic(topicId, { botId, agentId, skipLoad: true });
				// 3. 切换路由并等待完成
				await this.$router.replace({ name: 'topics-chat', params: { sessionId: topicId } });
				// 4. 解除抑制（路由已稳定，后续 watcher 可正常工作）
				this.__creatingTopic = false;
				// 5. 清空输入并发送消息（延迟到此处，避免 createTopic 期间页面闪烁空态）
				const savedText = this.inputText;
				this.inputText = '';
				this.userScrolledUp = false;
				this.scrollToBottom();
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
				const isReset = /^\/(new|reset)\b/i.test(cmd);
				// 抑制 __retryActivation，避免 route/sessions 更新竞态导致误判 sessionNotFound
				if (isReset) this.__resetTransition = true;

				await this.chatStore.sendSlashCommand(cmd);

				if (isReset && this.chatStore.currentSessionId) {
					const newId = this.chatStore.currentSessionId;
					if (newId !== this.currentSessionId) {
						await this.$router.replace({ params: { sessionId: newId } });
					}
					this.__resetTransition = false;
					this.sessionsStore.loadAllSessions();
					this.chatStore.__loadChatHistory();
				}
			}
			catch (err) {
				this.notify.error(err?.message || this.$t('slashCmd.error'));
			}
			finally {
				this.__resetTransition = false;
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
			if (!this.currentSessionId || this.isNewTopic || this.__creatingTopic || this.__resetTransition) return;

			// 阶段 1：数据未就绪，继续等待
			if (!this.botsStore.fetched) return;

			// 阶段 2：数据已就绪，做终态判定
			const bots = this.botsStore.items;

			// 无任何 bot
			if (!bots.length) {
				return this.__exitChat(this.$t('chat.botUnbound'));
			}

			if (this.isTopicRoute) {
				return this.__retryTopicActivation(bots);
			}

			// --- session 模式 ---
			// 运行时 bot 被解绑
			const currentBotId = this.chatStore.botId;
			if (currentBotId && !bots.some((b) => String(b.id) === currentBotId)) {
				return this.__exitChat(this.$t('chat.botUnbound'));
			}

			// 当前 session 对应的 bot 检查
			const session = this.sessionsStore.items.find(
				(s) => s.sessionId === this.currentSessionId,
			);
			if (session) {
				const ownerBot = bots.find((b) => String(b.id) === String(session.botId));
				if (!ownerBot) {
					return this.__exitChat(this.$t('chat.botUnbound'));
				}
			}
			else if (this.sessionsStore.items.length > 0) {
				// sessions 已加载但找不到当前 session
				return this.__exitChat(this.$t('chat.sessionNotFound'));
			}

			// 仍需要重试——传入 sessionKey 和 botId
			if (!this.chatStore.botId || this.chatStore.errorText || this.chatStore.loading) {
				this.chatStore.activateSession(this.currentSessionId, {
					botId: session?.botId,
					sessionKey: session?.sessionKey,
					force: true,
				});
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
			if (this.chatStore.historyExhausted || this.chatStore.historyLoading) {
				if (this.chatStore.historyExhausted && !this.isTopicRoute) {
					this.showNoMoreHint = true;
				}
				return;
			}
			const el = this.$refs.scrollContainer;
			const prevHeight = el?.scrollHeight ?? 0;
			const loaded = await this.chatStore.loadNextHistorySession();
			if (loaded && el) {
				// 保持滚动位置（新内容 prepend 后 scrollHeight 增加）
				this.$nextTick(() => {
					const newHeight = el.scrollHeight;
					el.scrollTop += (newHeight - prevHeight);
				});
			}
			// 刚加载完最后一段历史后也显示提示
			if (this.chatStore.historyExhausted && !this.isTopicRoute) {
				this.showNoMoreHint = true;
			}
		},
	},
};
</script>
