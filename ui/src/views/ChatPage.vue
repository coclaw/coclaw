<template>
	<!--
		⚠️ 布局关键约束 ⚠️（原 chat-layout-fix skill 已退役，要点固化于此）
		整体是固定视口高度的 flex 列：header 顶部、<main> 中间滚动、ChatInput 底部，均按 flex 自然定位
		- 原生壳：AuthedLayout 已约束视口高度，此处用 flex-1+min-h-0 填充剩余空间
		- Web：父容器仅 min-height，需 h-dvh-safe 硬约束以固定 header/footer（临时方案，
		  后续全面改为浏览器滚动后可移除）
		- 勿同时加 flex-1 + h-dvh-safe，否则 flex 算法以 max-content 撑开父容器
		- <main> 需 min-h-0（覆盖默认 min-height:auto）才能在自身内部滚动而非撑开父容器；
		  overflow-y 非 visible 时 overflow-x 会退化为 auto，需显式 overflow-x-hidden 禁横向滚动
		- ChatInput 禁止 sticky/fixed 定位，须作为 flex 列最后一个子元素、靠自然布局固定在底部
	-->
	<div ref="chatRoot" data-testid="chat-root" class="relative flex flex-col overflow-hidden" :class="chatRootClasses">
		<MobilePageHeader :title="chatTitle">
			<template v-if="headerLabel" #default>
				<span>{{ headerLabel.agent }}</span>
				<span v-if="headerLabel.claw" class="text-dimmed">@{{ headerLabel.claw }}</span>
			</template>
			<template #actions>
				<UButton
					data-testid="btn-refresh-mobile"
					class="cc-icon-btn-lg"
					variant="ghost"
					color="neutral"
					icon="i-lucide-refresh-cw"
					:title="$t('chat.refresh')"
					:disabled="refreshDisabled"
					:loading="refreshLoading"
					@click="onRefresh"
				/>
				<UButton
					v-if="canOpenFiles"
					data-testid="btn-files-mobile"
					class="cc-icon-btn-lg"
					variant="ghost"
					color="neutral"
					icon="i-lucide-folder"
					@click="openFiles"
				/>
				<UButton
					v-if="showNewTopicBtn"
					data-testid="btn-new-topic-mobile"
					class="cc-icon-btn-lg"
					variant="ghost"
					color="primary"
					icon="i-lucide-square-pen"
					@click="onNewTopic"
				/>
			</template>
		</MobilePageHeader>
		<header class="z-10 hidden shrink-0 min-h-12 items-center justify-between border-b border-default bg-default pl-4 pr-1 lg:pl-5 lg:pr-2 py-1 md:flex">
			<h1 class="min-w-0 flex-1 truncate text-base">
				<template v-if="headerLabel">
					<span>{{ headerLabel.agent }}</span>
					<span v-if="headerLabel.claw" class="text-dimmed">@{{ headerLabel.claw }}</span>
				</template>
				<template v-else>{{ chatTitle }}</template>
			</h1>
			<div class="flex items-center">
				<UButton
					data-testid="btn-refresh-desktop"
					class="cc-icon-btn-lg"
					variant="ghost"
					color="neutral"
					icon="i-lucide-refresh-cw"
					:title="$t('chat.refresh')"
					:disabled="refreshDisabled"
					:loading="refreshLoading"
					@click="onRefresh"
				/>
				<UButton
					v-if="canOpenFiles"
					data-testid="btn-files-desktop"
					class="cc-icon-btn-lg"
					variant="ghost"
					color="neutral"
					icon="i-lucide-folder"
					@click="openFiles"
				/>
				<UButton
					v-if="showNewTopicBtn"
					data-testid="btn-new-topic-desktop"
					class="cc-icon-btn-lg"
					variant="ghost"
					color="primary"
					icon="i-lucide-square-pen"
					@click="onNewTopic"
				/>
			</div>
		</header>

		<!-- 触屏下拉加载历史指示器（仅移动端） -->
		<div
			v-show="pullIndicatorVisible"
			data-testid="pull-indicator"
			class="pointer-events-none fixed left-1/2 z-50 -translate-x-1/2 md:hidden"
			:style="pullIndicatorStyle"
		>
			<div class="flex size-8 items-center justify-center rounded-full bg-elevated shadow-md">
				<UIcon
					:name="pullIndicatorPastThreshold ? 'i-lucide-refresh-cw' : 'i-lucide-arrow-down'"
					class="size-4 text-dimmed"
					:class="{ 'animate-spin': pullIndicatorSpinning }"
				/>
			</div>
		</div>

		<!-- flex-1 + min-h-0：让 main 填充剩余空间并内部滚动；移除 min-h-0 会导致撑开父容器 -->
		<main ref="scrollContainer" class="flex-1 min-h-0 overflow-x-hidden overflow-y-auto cc-scrollbar-thin cc-scrollbar-gutter" @scroll="onScroll" @wheel="onWheel">
			<div ref="scrollContent" class="mx-auto w-full max-w-3xl" :style="!__scrollReady && chatMessages.length ? { visibility: 'hidden' } : undefined">
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
						<!-- 系统块（OpenClaw 注入 / HEARTBEAT_OK / NO_REPLY 等非自然对话消息） -->
						<div v-else-if="item.type === 'systemNote'" data-testid="system-note" class="px-3 py-2 sm:px-4">
							<div class="rounded-lg bg-elevated px-3 py-2 text-sm text-dimmed">
								<div class="whitespace-pre-wrap break-words">{{ item.text }}</div>
								<div v-if="item.timestamp || (item.source === 'inject' && item.model)" class="mt-1 flex items-center justify-end gap-2 text-xs">
									<span v-if="item.timestamp">{{ formatSysNoteTime(item.timestamp) }}</span>
									<span v-if="item.source === 'inject' && item.model" class="rounded bg-muted/60 px-1.5 py-0.5 text-toned">
										{{ item.model }}
									</span>
								</div>
							</div>
						</div>
						<!-- 正文已丢的归档 session 占位（书签还在、正文已不存在） -->
						<div v-else-if="item.type === 'emptySession'" data-testid="empty-session" class="px-3 py-2 sm:px-4">
							<div class="flex items-center justify-center gap-1.5 text-xs text-muted">
								<UIcon name="i-lucide-info" class="size-3.5 shrink-0" />
								<span>{{ item.reason === 'corrupt' ? $t('chat.historyCorrupt') : $t('chat.historyUnavailable') }}</span>
							</div>
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
			</div>
		</main>

		<ChatInput
			v-if="isTopicRoute || isNewTopic || !!routeClawId"
			ref="chatInput"
			v-model="inputText"
			:chat-store="chatStore"
			:sending="chatStore?.isSending ?? false"
			:file-upload-state="chatStore?.fileUploadState ?? null"
			:disabled="inputLocked || (isNewTopic ? (!newTopicReady || __creatingTopic) : (isTopicRoute ? (!currentSessionId || isLoadingChat) : (!routeClawId || isLoadingChat)))"
			:cancel-disabled="!!chatStore?.__slashCommandType || !!chatStore?.isCancelling"
			:cancelling="!!chatStore?.isCancelling"
			@send="onSendMessage"
			@cancel="onCancelSend"
		>
			<template #floating>
				<UButton
					v-if="farFromBottom && !__loadingHistory"
					data-testid="btn-back-to-bottom"
					class="cc-icon-btn-lg absolute bottom-[calc(100%+32px)] left-1/2 -translate-x-1/2 bg-elevated/80 shadow-[0_2px_8px_rgba(0,0,0,0.12)] ring-1 ring-default/20 dark:shadow-[0_2px_8px_rgba(255,255,255,0.14)] dark:ring-white/15"
					size="md"
					variant="ghost"
					color="neutral"
					icon="i-lucide-arrow-down"
					:aria-label="$t('chat.scrollToBottom')"
					@click="onClickBackToBottom"
				/>
			</template>
			<template #prepend>
				<SlashCommandMenu
					v-if="showSlashMenu"
					class="absolute bottom-full left-0 z-10 pb-1"
					:disabled="chatStore?.isSending || isLoadingChat"
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

// iOS<16 WebKit bug 187449：用户惯性未停时程序化 scrollTo 被合成线程丢弃，
// 惯性结束后重发即生效 → force 路径按帧重试直到稳定到底。
// 超时用 Date 计时而非帧数——120Hz 设备帧数计时会把窗口砍半
const FORCE_SCROLL_TIMEOUT_MS = 2500;
const FORCE_SCROLL_STABLE_FRAMES = 3;

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
			// 距底超过 1 屏时显示「回到底部」悬浮按钮；与 userScrolledUp（60px 阈值）解耦
			farFromBottom: false,
			showNoMoreHint: false,
			dragging: false,
			__exiting: false,
			// 新建 topic 流程进行中，抑制 watcher 的重复激活
			__creatingTopic: false,
			// 历史加载进行中，阻止 scrollToBottom 干扰位置恢复
			__loadingHistory: false,
			// 首次消息加载 + scrollToBottom 完成前隐藏消息列表，防止闪顶
			__scrollReady: false,
			// 刷新按钮本地状态（用户发起刷新到完成的窗口）
			refreshing: false,
			// 触屏下拉距离（px，可为负）—— 当前手指相对起点的位移，驱动指示器视觉。
			// 触发加载在 __onPullEnd 里判定 dist>=60，向上滑（负值）不触发
			pullDistance: 0,
			// 标记本次进行中的加载是否由触屏下拉手势触发；
			// 仅它为 true 时显示指示器，避免 onScroll/onWheel/__autoFillHistory 等
			// 非手势路径触发 __loadingHistory 时也意外亮起指示器
			__pullGestureLoading: false,
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
			return !!this.clawsStore.byId[this.newTopicClawId];
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
		 * 基于 rtcPhase 给出精确状态。注意：ICE restart 恢复期（rtcPhase==='restarting'）
		 * 即使 dcReady 仍为 true 也会显示一条横幅，故不止「连接不可用时」才出（见下方 restarting 分支）。
		 */
		connStatusText() {
			if (this.isNewTopic) return '';
			const clawId = this.currentClawId;
			if (!clawId) return '';
			const claw = this.clawsStore.byId[clawId];
			if (!claw) return this.$t('chat.clawNotFound');
			if (!claw.online) return this.$t('chat.clawOffline');
			// ICE restart 恢复期：DC/SCTP 仍存活、dcReady 不翻转，但底层路径正在重协商。
			// 放在 dcReady 守卫前，让聊天页也给一条「正在恢复连接…」横幅（此前此窗口无任何在场信号）。
			if (claw.rtcPhase === 'restarting') return this.$t('chat.connRecovering');
			// claw 在线但 DC 未就绪 → 根据 rtcPhase 细化
			if (claw.dcReady) return '';
			const phase = claw.rtcPhase;
			if (phase === 'building') return this.$t('chat.connBuilding');
			if (phase === 'recovering') return this.$t('chat.connRecovering');
			if (phase === 'failed') {
				return claw.retryNextAt > 0
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
		/**
		 * chat 模式下 header 的结构化 label：{ agent, claw }
		 * - topic / new-topic / 无 clawId 时返回 null（header 走 chatTitle 字符串路径）
		 * - 单 claw 不带 @ 后缀，多 claw 才带（与 MainList 策略一致）
		 * - agent 名与 claw 名相同时丢掉后缀（避免 "Alpha@Alpha" 重复）
		 */
		headerLabel() {
			if (this.isNewTopic || this.isTopicRoute) return null;
			if (!this.routeClawId) return null;
			const agent = this.agentDisplay?.name || 'Agent';
			const allClaws = this.clawsStore?.items ?? [];
			if (allClaws.length < 2) return { agent, claw: null };
			const claw = this.clawsStore?.byId?.[this.currentClawId]?.name || 'OpenClaw';
			if (claw === agent) return { agent, claw: null };
			return { agent, claw };
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
		 * 连接就绪：DC 可用 + (topic 或 agent 已验证)
		 * 驱动首次/重连消息加载，消除时序依赖。
		 * 不读 claw.online——presence 是展示层信号，通信就绪只看 DC（详见通信模型 §5.5）
		 */
		connReady() {
			if (this.isNewTopic || !this.chatStore) return false;
			const claw = this.clawsStore.byId[this.currentClawId];
			if (!claw || !claw.dcReady) return false;
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
		/** 刷新按钮：本地请求中 / store 内部 load 中 / 连接未就绪时 disabled */
		refreshDisabled() {
			return this.refreshing || !!this.chatStore?.isLoadingMessages || !this.connReady;
		},
		/** 刷新按钮 spinner：本地请求中 或 store 内部 load 中 */
		refreshLoading() {
			return this.refreshing || !!this.chatStore?.isLoadingMessages;
		},

		/**
		 * 当前路由对应的 chat store 实例
		 * 返回 null 表示尚未就绪（topic 数据未加载 / 无 clawId / new-topic 缺 query 参数）
		 */
		chatStore() {
			if (this.isNewTopic) {
				if (!this.newTopicClawId) return null;
				// new-topic store 由 chatStoreManager 维护但不入 LRU（每个 claw/agent 组合最多一个，
				// 量级 ≤ 数十；登出 disposeAll 兜底）；inputFiles 随 store 走
				return chatStoreManager.get(
					`new-topic:${this.newTopicClawId}:${this.newTopicAgentId}`,
					{ clawId: this.newTopicClawId, agentId: this.newTopicAgentId },
				);
			}
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
				// 正文取回为空的归档段：留占位条目而非整段隐藏，让用户知道这段曾存在、内容现已不可用。
				// 用 seg.messages.length 而非分组结果判定：slash 归档路径（sessions.get 不过滤）可能塞进
				// 全是非对话行的段，那种 length>0、分组后才空，应维持隐藏；getById 取回为空才是真没正文
				// （文件已删，或极少数文件在但无可显示消息），中性占位文案对两种情形都如实。
				if (seg.messages.length === 0) {
					if (items.length > 0) {
						items.push({
							type: 'separator',
							id: `sep-${seg.sessionId}`,
							archivedAt: seg.archivedAt,
						});
					}
					items.push({
						type: 'emptySession',
						id: `empty-${seg.sessionId}`,
						archivedAt: seg.archivedAt,
						// reason 来自 loadNextHistorySession 终态分支：'missing'(NOT_FOUND) / 'corrupt'(PARSE_FAILED)；
						// 旧插件空返回或良性空段无 reason → undefined → 走中性文案
						reason: seg.reason,
					});
					continue;
				}
				const grouped = groupSessionMessages(seg.messages);
				if (grouped.length) {
					if (items.length > 0) {
						items.push({
							type: 'separator',
							id: `sep-${seg.sessionId}`,
							archivedAt: seg.archivedAt ?? this.__firstValidTimestamp(grouped),
						});
					}
					items.push(...grouped);
				}
			}
			// 当前 session 消息（含 agentRunsStore 的流式消息）
			const current = groupSessionMessages(this.chatStore.allMessages);
			if (current.length > 0 && items.length > 0) {
				const latest = this.chatStore.historySessionIds[0];
				items.push({
					type: 'separator',
					id: 'sep-current',
					archivedAt: latest?.archivedAt ?? this.__firstValidTimestamp(current),
				});
			}
			items.push(...current);
			return items;
		},
		/** 触屏下拉指示器是否显示：拉动中，或手势触发的加载进行中 */
		pullIndicatorVisible() {
			return this.pullDistance > 0 || this.__pullGestureLoading;
		},
		/** 是否进入"过阈值/加载中"形态——决定图标切到刷新形态 */
		pullIndicatorPastThreshold() {
			return this.pullDistance >= 60 || this.__pullGestureLoading;
		},
		/** 是否旋转——仅在加载真正进行时转，避免拉过阈值就转给人"已在加载"错觉 */
		pullIndicatorSpinning() {
			return this.__pullGestureLoading;
		},
		/** 指示器位置 / 透明度 / 过渡：跟手时无过渡；释放或加载时定在阈值并淡入。
		 *  视觉位置 clamp 到 [0,100]，避免拉到很远时图标飞到屏幕中部 */
		pullIndicatorStyle() {
			const releasing = this.pullDistance === 0;
			const visualDist = Math.min(Math.max(this.pullDistance, 0), 100);
			// 加载中且已松手 → 定在阈值位置（60-8）；否则按 clamp 后的视觉距离跟手
			const dist = this.__pullGestureLoading && releasing ? 60 : visualDist;
			const visualOpacity = this.__pullGestureLoading
				? 1
				: Math.min(visualDist / 60, 1);
			return {
				top: `calc(var(--safe-area-inset-top) + ${dist - 8}px)`,
				opacity: visualOpacity,
				transition: releasing ? 'all 0.2s ease-out' : 'none',
			};
		},
	},
	watch: {
		/** chatStore 变化时激活（首次 init 或重新进入时 refresh） */
		chatStore: {
			immediate: true,
			handler(store, prevStore) {
				// chat 真切了就要清掉与上一个 chat 关联的 transient 状态——必须在
				// __creatingTopic 早退之前，因为：
				// 1. __loadMoreHistory 的 finally 已改为身份比对，不再兜底清锁；
				//    若 watcher 也跳过清锁（__creatingTopic 早退路径），旧 await 醒来
				//    finally 因 store 不等也不清，锁就永远卡 true。
				// 2. mid-touch 切换时旧手势的 startY/Dist 留在实例上，松手时 __onPullEnd
				//    会用旧 dist 在新 chat 上误触发 __loadMoreHistory。
				if (store !== prevStore) {
					this.__loadingHistory = false;
					this.__pullGestureLoading = false;
					this.__pullStartY = null;
					this.pullDistance = 0;
					// store 切换（含变 null）都清回到底部按钮的显示状态：
					// topic/new-topic 路由下 ChatInput 仍渲染，残留 true 会让按钮错误显现
					this.farFromBottom = false;
					// 滚动容器跨 chat 复用，旧 chat 的 force 循环不得滚到新 chat 上
					this.__stopForceScroll(false);
				}
				if (this.__creatingTopic) return;
				if (store && store !== prevStore) {
					this.showNoMoreHint = false;
					this.userScrolledUp = false;
					this.farFromBottom = false;
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
		// 消息刷新完全交给 connReady watcher（dcReady 翻转驱动），不再监听 visibility/app:foreground
		// —— DC 不断时 event:agent 实时推送；DC 断后恢复时 connReady 翻转触发 silent reload

		// 滚动容器 / 内容区域 ResizeObserver：覆盖软键盘弹起、输入框撑高、
		// 图片加载、表格包装、steps 展开等所有导致容器或内容尺寸变化的场景
		this.__resizeOb = new ResizeObserver(() => {
			// 内容/视口尺寸变化不会触发 scroll 事件——必须主动重算 farFromBottom，
			// 否则用户已上滚 + 流式输出令 scrollHeight 长高时，距底跨过 1 屏阈值也看不到按钮
			this.__refreshFarFromBottom();
			this.scrollToBottom();
		});
		const sc = this.$refs.scrollContainer;
		const content = this.$refs.scrollContent;
		if (sc) this.__resizeOb.observe(sc);
		if (content) this.__resizeOb.observe(content);

		// 触屏下拉加载更早历史：内容没溢出时浏览器不发滚动事件，scroll/wheel 那条路在
		// 这一刻是哑的；触摸事件不依赖"能不能滚"，所以补一条独立的入口。
		// 仅在按下时已经在最顶才接管，下拉超过阈值且抬起触发 __loadMoreHistory。
		if (sc) {
			sc.addEventListener('touchstart', this.__onPullStart, { passive: true });
			sc.addEventListener('touchmove', this.__onPullMove, { passive: true });
			sc.addEventListener('touchend', this.__onPullEnd, { passive: true });
			// touchcancel 表示手势被系统中断（来电、多任务、被其他元素接管），
			// 应当作 abort 处理，仅重置跟踪状态、不触发加载
			sc.addEventListener('touchcancel', this.__onPullCancel, { passive: true });
		}

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
		this.__stopForceScroll(false);
		this.unsuppressPullRefresh();
		this.chatStore?.cleanup();
		this.__resizeOb?.disconnect();
		const sc = this.$refs.scrollContainer;
		if (sc) {
			sc.removeEventListener('touchstart', this.__onPullStart);
			sc.removeEventListener('touchmove', this.__onPullMove);
			sc.removeEventListener('touchend', this.__onPullEnd);
			sc.removeEventListener('touchcancel', this.__onPullCancel);
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
			// new-topic 模式 chatStore.isSending=false（无 run），单独防重入：
			// 用户在 createTopic / router.replace await 期间快速双击会进两次
			if (this.__creatingTopic) return;

			// 新建 topic 流程
			if (this.isNewTopic) {
				return this.__handleNewTopicSend(text, files);
			}

			if (!this.chatStore) return;
			if (!this.isTopicRoute && !this.routeClawId) return;
			if (this.isTopicRoute && !this.currentSessionId) return;

			// 入口快照 targetStore：失败回退路径要打回这里，
			// 防止用户在 await 期间切走再回退把附件灌到错的 chat/topic
			const targetStore = this.chatStore;
			const savedText = this.inputText;
			const draftKey = this.draftKey;
			this.inputText = '';
			this.userScrolledUp = false;
			this.farFromBottom = false;
			this.scrollToBottom();

			try {
				const result = await targetStore.sendMessage(text, files, {
					onFileUploaded: (f) => targetStore.removeFileById(f.id),
				});
				if (!result.accepted) {
					// 用闭包 draftKey + targetStore 恢复，组件可能已 unmount 或路由已切换
					if (draftKey) this.draftStore.setDraft(draftKey, savedText);
					targetStore.clearInputFiles();
					targetStore.restoreFiles(files);
				}
				else {
					this.__notifyRunFailed(result, targetStore);
					this.__tryGenerateTitle(targetStore);
				}
			}
			catch (err) {
				console.error('[chat] send in established-chat flow failed', err);
				// 根据 err.code 映射友好文案
				const errMsg = this.__sendErrorMessage(err);
				this.notify.error(this.__withSourcePrefix(errMsg, targetStore));
				if (!targetStore.__accepted) {
					if (draftKey) this.draftStore.setDraft(draftKey, savedText);
					targetStore.clearInputFiles();
					targetStore.restoreFiles(files);
				}
			}
		},

		/**
		 * accepted 后失败终态（模型不可用、上游执行失败、业务级 timeout）— 弹错误 toast。
		 * description 用 OpenClaw 原始错误文案，截断 + 取首行避免 stack-like 噪音。
		 * @param {{ endReason?: string, errorMessage?: string|null }} result
		 */
		__notifyRunFailed(result, srcStore) {
			if (result?.endReason !== 'failed' && result?.endReason !== 'rpc-timeout') return;
			this.notify.error({
				title: this.__withSourcePrefix(this.$t('chat.errRunFailed'), srcStore),
				description: this.__formatRunErrorMessage(result.errorMessage),
			});
		},

		/**
		 * 条件给失败 toast 文案加来源 chat/topic 标题前缀：仅当失败来源 ≠ 当前正看的 chat 时加，
		 * 来源取自发送入口快照 srcStore、不随当前路由漂移（修「await 期间切走后失败 toast 看着
		 * 像当前 chat 失败」的误导）。同一 chat 或来源解析为空时回退原文案、不加前缀。
		 * @param {string} msg - 原始文案
		 * @param {object} [srcStore] - 发送入口快照的 chat store
		 * @returns {string}
		 */
		__withSourcePrefix(msg, srcStore) {
			// 只在「失败来源 ≠ 当前正看的 chat」时加前缀——消歧限定符只在有歧义时露出，
			// 给常态（没切走）加 [agent名] 是自指噪音。chatStoreManager 按 key memoize，
			// srcStore 与 this.chatStore 同实例即同一 chat。this.chatStore 为 null（用户已离开
			// chat 区）时与真实 srcStore 必不等 → 加前缀，正确（用户没在看来源）。
			if (!srcStore || srcStore === this.chatStore) return msg;
			const name = this.__resolveSourceName(srcStore);
			if (!name) return msg;
			return this.$t('chat.errWithSource', { name, msg });
		},

		/**
		 * 从入口快照 srcStore 解析来源标题：chat 模式取 agent 显示名，topic 模式取 topic 标题。
		 * ⚠️ 必须用传入的快照、不能用按当前路由算的 chatTitle/agentDisplay，否则会复刻
		 * 「切走后归因到当前 chat」的 bug。topic 已在 store 但未命名（title 空）时回退到占位名
		 * 「新话题」（topic.newTopic，与列表/header 口径一致），让未命名 topic 切走后的失败 toast 也带前缀。
		 * 返回 '' 仅发生在「无 srcStore」或「topic 已不在 store（已删/claw 解绑）」——拿不到真名、不强行贴占位名。
		 * chat 模式 agent 名有多级兜底（clawName/id/'Agent'）始终非空，未加载时退化为占位 id 而非空。
		 * @param {object} [srcStore] - 发送入口快照的 chat store
		 * @returns {string}
		 */
		__resolveSourceName(srcStore) {
			if (!srcStore) return '';
			if (srcStore.topicMode) {
				const topic = this.topicsStore.findTopic(srcStore.sessionId);
				if (!topic) return '';
				return topic.title || this.$t('topic.newTopic');
			}
			// chat 模式 agentId 不在 store 顶层字段、藏在 chatSessionKey；用 store 自带的
			// __resolveAgentId() 取，与 store 其它路径口径一致，别自行 split。
			return this.agentsStore.getAgentDisplay(srcStore.clawId, srcStore.__resolveAgentId())?.name || '';
		},

		/** 错误文案截断：取首行 + 限 200 字符（覆盖典型 FailoverError ~240 字符的实质提示部分） */
		__formatRunErrorMessage(msg) {
			if (!msg || typeof msg !== 'string') return undefined;
			const firstLine = msg.split('\n')[0].trim();
			if (!firstLine) return undefined;
			return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
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
				// topics.store.createTopic 在 await 期间 claw 被解绑时抛出，归类为"连接断了"
				CLAW_DISCONNECTED: 'chat.errWsClosed',
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

			this.__creatingTopic = true;
			const oldDraftKey = this.draftKey;
			const newTopicKey = `new-topic:${clawId}:${agentId}`;
			let newDraftKey = '';
			let targetStore = null;
			try {
				// 1. 创建 topic
				const topicId = await this.topicsStore.createTopic(clawId, agentId);
				// 2. promote：建新 topic store，把 inputFiles 引用共享过去
				const { newStore, commit } = chatStoreManager.promoteToTopic(
					newTopicKey, topicId, { clawId, agentId },
				);
				targetStore = newStore;
				// 3. 切换路由
				await this.$router.replace({ name: 'topics-chat', params: { sessionId: topicId } });
				// 4. router.replace 之后再 commit：切断旧引用 + dispose 旧 new-topic store。
				// 顺序非常重要——commit 早于 router.replace 会让 ChatPage chatStore computed
				// 仍指向 oldStore 时触发 dispose，ChatInput 一个 tick 看到空数组
				commit();
				// 5. 解除抑制
				this.__creatingTopic = false;
				// 6. 清空旧草稿并发送消息
				if (oldDraftKey) this.draftStore.clearDraft(oldDraftKey);
				this.inputText = '';
				newDraftKey = this.draftKey;
				this.userScrolledUp = false;
				this.farFromBottom = false;
				// force=true：new-topic 首发时初始 loadMessages 可能仍 pending，__scrollReady 未就绪会让
				// 整个消息面板 visibility:hidden（防闪顶）；非 force 的 scrollToBottom 在面板隐藏/无内容时
				// 不会打开可见门，首条消息会短暂不可见直到初始加载完成。force 走重试路径，气泡注入后开门。
				// established-chat 的 onSendMessage(~L766) 保持非 force——避免被拖进 force 重试循环（含
				// in-flight 历史分页边角），new-topic 无此风险。
				this.scrollToBottom(true);
				const result = await targetStore.sendMessage(text, files, {
					onFileUploaded: (f) => targetStore.removeFileById(f.id),
				});
				if (!result.accepted) {
					if (newDraftKey) this.draftStore.setDraft(newDraftKey, text);
					targetStore.clearInputFiles();
					targetStore.restoreFiles(files);
				}
				else {
					this.__notifyRunFailed(result, targetStore);
					this.__tryGenerateTitle(targetStore);
				}
			}
			catch (err) {
				console.error('[chat] send in new-topic flow failed', err);
				this.__creatingTopic = false;
				const errMsg = this.__sendErrorMessage(err);
				this.notify.error(this.__withSourcePrefix(errMsg, targetStore));
				// targetStore 可能是 null（promote 失败前），也可能是 newStore（promote 成功但 send 失败）
				if (!targetStore?.__accepted) {
					if (newDraftKey) this.draftStore.setDraft(newDraftKey, text);
					targetStore?.clearInputFiles();
					targetStore?.restoreFiles(files);
				}
				// claw 中途解绑：当前路由是 /topics/new?claw=<已解绑> 已成死胡同，
				// 不跳走的话再点发送只会重抛同样的错。跳默认首页让用户重新选择入口
				if (err?.code === 'CLAW_DISCONNECTED') {
					this.$router.replace('/');
				}
			}
		},

		/**
		 * 前 N 条 user message 内，若 topic 尚无标题则尝试自动生成
		 * @param {object} [targetStore] - 入口快照的 chat store；await 期间用户切走时仍给原 store 起标题，
		 *                                 不漂移到当前 this.chatStore（可能已是别的 chat / topic）。
		 *                                 默认 this.chatStore 保持非 sendMessage 路径的旧行为
		 */
		__tryGenerateTitle(targetStore = this.chatStore) {
			if (!targetStore?.topicMode) return;
			const topicId = targetStore.sessionId;
			const clawId = targetStore.clawId;
			if (!topicId || !clawId) return;
			const topic = this.topicsStore.findTopic(topicId);
			if (topic?.title) return;
			const userMsgCount = targetStore.messages.filter(
				m => m.message?.role === 'user' && !m._local
			).length;
			if (userMsgCount > MAX_AUTO_TITLE_MSGS) return;
			console.debug('[chat] triggering generateTitle topicId=%s userMsgs=%d', topicId, userMsgCount);
			this.topicsStore.generateTitle(clawId, topicId);
		},

		openFiles() {
			this.$router.push({
				name: 'files',
				params: { clawId: this.currentClawId, agentId: this.currentAgentId },
			});
		},

		/**
		 * 刷新按钮：静默拉一次当前 session 的消息。
		 * 用 silent 模式避免失败时清空 messages，失败保留当前视图；成功时顺带清掉 errorText
		 * 残留（ChatPage.vue v-else-if 里 errorText 比 messages 优先，不清会遮住新拉回的数据）
		 */
		async onRefresh() {
			if (this.refreshing || !this.chatStore) return;
			this.refreshing = true;
			try {
				const ok = await this.chatStore.loadMessages({ silent: true });
				// await 返回后组件可能已卸载（用户切路由），对齐 __onConnReady 的 guard
				if (this.__unmounted) return;
				if (ok && this.chatStore?.errorText) {
					this.chatStore.errorText = '';
				}
			}
			finally {
				this.refreshing = false;
			}
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
			console.info('[chat] onCancelSend clicked');
			// cancelSend 协调任务的终态 toast（gone / not-supported）由 store 内部走
			// getSharedNotifier 触发，handoff 路径（pre-accept 挂意图 → onAccepted 内部
			// 调 cancelSend）也能可靠 toast。本侧仅触发取消并打日志即可。
			// cancelSend 协议永不 reject，无 .catch 也无 unhandled rejection 风险。
			this.chatStore?.cancelSend();
		},

		// --- 拖拽上传 ---
		__onDragOver(e) {
			if (!this.$refs.chatInput) return;
			if (!e.dataTransfer?.types?.includes('Files')) return;
			// pre-accepted 期间（sending && !__accepted）拒绝拖入，与 + 按钮/textarea 禁用语义对齐
			if (this.inputLocked) return;
			e.preventDefault();
			this.dragging = true;
		},
		__onDragLeave(e) {
			// 仅离开根元素时关闭蒙层，忽略子元素间的冒泡
			if (this.$refs.chatRoot?.contains(e.relatedTarget)) return;
			this.dragging = false;
		},
		__onDrop(e) {
			// pre-accepted 期间丢弃拖入的文件（不 preventDefault，让浏览器默认处理，避免误上传）
			if (this.inputLocked) {
				this.dragging = false;
				return;
			}
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
			const targetStore = this.chatStore;
			this.__connReadyStore = targetStore;
			let succeeded = false;
			try {
				// WS 重连时清理挂起的 slash command（event:chat 可能在断连期间丢失）
				targetStore.__reconcileSlashCommand();
				const isFirstLoad = !targetStore.__messagesLoaded;
				if (isFirstLoad) {
					await targetStore.loadMessages();
					if (this.__unmounted || this.chatStore !== targetStore) return;
					if (!targetStore.topicMode) targetStore.__loadChatHistory();
				} else if (!targetStore.sending) {
					// 重连后可能丢失事件，只要非发送中就强制刷新以触发 reconcile (#235)
					targetStore.loadMessages({ silent: true });
				}
				// 加载完成后：强制滚到底部，并检测内容是否不足以填满容器
				// 非首次加载（组件重建但 store 复用）时也需 force 以解锁 visibility
				this.$nextTick(() => {
					// 与既有"主动滚到底"入口对称：force 滚动前清两个 flag，避免 scroll 事件回弹前按钮残留
					this.userScrolledUp = false;
					this.farFromBottom = false;
					this.scrollToBottom(true);
					if (isFirstLoad) this.__autoFillHistory();
				});
				succeeded = true;
			} finally {
				// reject / 中途切走时回滚 guard，避免后续切回 targetStore 时 dedup 拦死
				if (!succeeded && this.__connReadyStore === targetStore) {
					this.__connReadyStore = null;
				}
			}
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

		// archivedAt fallback：plugin 写入 archivedAt 与 UI 缓存有时序差（daily-reset 自动换 sid 等
		// 场景下 UI 拿到的 raw chat-history 还是旧快照），用 grouped items 中首个有效 timestamp 兜底
		// 显示分隔线日期。下一段第一条 message 时间紧邻真实归档时刻（旧段归档 ≈ 新段第一条消息）。
		// 仍找不到 timestamp 时返回 null，formatSeparatorLabel 退化为无文字纯横线（与改动前一致）。
		__firstValidTimestamp(items) {
			for (const it of items) {
				if (typeof it?.timestamp === 'number' && it.timestamp > 0) return it.timestamp;
			}
			return null;
		},

		/** systemNote 时间标签：HH:MM 与 ChatMsgItem.formattedTime 一致 */
		formatSysNoteTime(ts) {
			if (!ts) return '';
			const d = new Date(ts);
			if (isNaN(d.getTime())) return '';
			const hh = String(d.getHours()).padStart(2, '0');
			const mi = String(d.getMinutes()).padStart(2, '0');
			return `${hh}:${mi}`;
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
			if (this.__loadingHistory) {
				// 历史加载中 scrollTop 由 __loadMoreHistory 自管，这里不补一次 scroll；
				// 但首屏 visibility 解锁不能被它卡死——否则 __onConnReady 的强制 scroll 撞上
				// chatMessages watcher 触发的 __autoFillHistory（视口未满 → 立即 loadOlderMessages）这条 race，
				// __scrollReady 就再也回不到 true，整面板永久 visibility:hidden。
				if (force) {
					if (!this.__scrollReady) this.__scrollReady = true;
					// force 不再被吞：循环在锁释放前不发 scrollTo（不干扰位置恢复），释放后补滚到底
					this.__startForceScroll();
				}
				return;
			}
			if (force) {
				// force 委托 rAF 逐帧逼近循环；解锁时机与原单发实现等价——
				// tick() 同步首发与解锁在同一 tick 内完成，paint 在其后，无闪顶
				this.$nextTick(() => {
					this.__startForceScroll();
					if (!this.__scrollReady) this.__scrollReady = true;
				});
				return;
			}

			this.$nextTick(() => {
				// 二次检查：$nextTick 排队期间用户可能已上划
				if (!force && this.userScrolledUp) return;
				// 非 force 且已在底部则跳过，避免 ResizeObserver 高频回调时的冗余 scrollTo
				if (!force && el.scrollHeight - el.scrollTop - el.clientHeight <= 1) return;
				el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
				// 兜底：DOM 高度可能在 $nextTick 后仍未稳定，下一帧再校验一次
				requestAnimationFrame(() => {
					if (!force && this.userScrolledUp) return;
					if (el.scrollHeight - el.scrollTop - el.clientHeight > 10) {
						el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
					}
				});
			});
		},
		/**
		 * force 滚动的 rAF 逐帧逼近循环：每帧重发 scrollTo，直到连续 FORCE_SCROLL_STABLE_FRAMES
		 * 帧距底 ≤1px 或超时。iOS<16 惯性期被吞的帧落空、惯性一停下一帧即生效；
		 * 其余平台首发即中、数帧后退出，无感知。
		 * 循环状态全部用非响应式实例字段（模板不读，先例 __connReadyStore/__pullStartY）。
		 */
		__startForceScroll() {
			const el = this.$refs.scrollContainer;
			if (!el?.scrollTo) return;
			// 重启（连点按钮等）：旧循环先停但不回置 flag，由新循环收尾时统一 resync
			if (this.__forceScrollActive) this.__stopForceScroll(false);
			// start 时缓存容器引用，stop 从同一引用摘监听，钉死"加谁摘谁"
			this.__forceScrollEl = el;
			// 世代令牌：停止/重启后已排队的旧世代残帧一律灭活（cancelRAF 之外的第二道闸）
			this.__forceScrollGen = (this.__forceScrollGen || 0) + 1;
			const gen = this.__forceScrollGen;
			this.__forceScrollActive = true;
			this.__forceScrollDeadline = Date.now() + FORCE_SCROLL_TIMEOUT_MS;
			this.__forceScrollStable = 0;
			// 用户真实介入信号：scroll 事件不可作信号——程序化滚动与残余惯性都会发；
			// mousedown 兜桌面拖滚动条（部分引擎滚动条交互不发 pointerdown）；
			// 键盘 PgUp/Home/End 不覆盖，由总超时兜底
			el.addEventListener('touchstart', this.__onForceScrollUserIntervene, { passive: true });
			el.addEventListener('wheel', this.__onForceScrollUserIntervene, { passive: true });
			el.addEventListener('pointerdown', this.__onForceScrollUserIntervene, { passive: true });
			el.addEventListener('mousedown', this.__onForceScrollUserIntervene, { passive: true });
			const tick = () => {
				if (gen !== this.__forceScrollGen || !this.__forceScrollActive) return;
				if (this.__unmounted || this.$refs.scrollContainer !== el) {
					this.__stopForceScroll(false);
					return;
				}
				if (Date.now() > this.__forceScrollDeadline) {
					this.__stopForceScroll(true);
					return;
				}
				if (this.__loadingHistory) {
					// 翻页位置恢复在飞：本帧不发 scrollTo 免互踩，锁释放后继续逼近
					this.__forceScrollStable = 0;
				} else {
					// Math.ceil 容差：DPR 非整数时 scrollTop 带小数，到底也差 <1px
					const dist = el.scrollHeight - Math.ceil(el.scrollTop) - el.clientHeight;
					if (dist <= 1) {
						if (++this.__forceScrollStable >= FORCE_SCROLL_STABLE_FRAMES) {
							// 判稳退出后不得再排帧
							this.__stopForceScroll(true);
							return;
						}
					} else {
						this.__forceScrollStable = 0;
						el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
					}
				}
				this.__forceScrollRaf = requestAnimationFrame(tick);
			};
			// 同步首发不等下一帧：保住 __scrollReady 解锁前已定位，防闪顶
			tick();
		},
		/** 停止 force 循环；resync=true 按真实落点回置滚动 flag（解"被吞后 userScrolledUp 卡死"的放大器） */
		__stopForceScroll(resync = true) {
			if (!this.__forceScrollActive) return;
			this.__forceScrollActive = false;
			this.__forceScrollGen++;
			cancelAnimationFrame(this.__forceScrollRaf);
			this.__forceScrollRaf = null;
			const el = this.__forceScrollEl;
			if (el) {
				el.removeEventListener('touchstart', this.__onForceScrollUserIntervene);
				el.removeEventListener('wheel', this.__onForceScrollUserIntervene);
				el.removeEventListener('pointerdown', this.__onForceScrollUserIntervene);
				el.removeEventListener('mousedown', this.__onForceScrollUserIntervene);
				this.__forceScrollEl = null;
			}
			if (resync && !this.__unmounted) this.__syncScrollFlags();
		},
		/** force 循环期间用户真实介入（触摸/滚轮/按下）→ 立即让权并按落点回置 flag */
		__onForceScrollUserIntervene() {
			this.__stopForceScroll(true);
		},
		/** 与 onScroll 同公式回置滚动 flag，不带翻页触发 */
		__syncScrollFlags() {
			const el = this.$refs.scrollContainer;
			if (!el) return;
			const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
			this.userScrolledUp = dist >= 60;
			this.farFromBottom = dist > el.clientHeight;
		},
		onClickBackToBottom() {
			this.userScrolledUp = false;
			this.farFromBottom = false;
			this.scrollToBottom(true);
		},
		/** ResizeObserver 等非 scroll 路径需要主动调；不动 userScrolledUp 以保留自动追尾决策 */
		__refreshFarFromBottom() {
			// 与 onScroll 同款循环期间抑制：流式长高会让按钮中途闪现
			if (this.__forceScrollActive) return;
			const el = this.$refs.scrollContainer;
			if (!el) return;
			this.farFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight;
		},
		onScroll() {
			// 强制滚动循环期间 scroll 事件来源不可分（残余惯性 / 自家 scrollTo），一律不更新
			// flag、不触发翻页；用户真实介入由 touchstart/wheel/pointerdown/mousedown 接管
			if (this.__forceScrollActive) return;
			const el = this.$refs.scrollContainer;
			if (!el) return;
			const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
			this.userScrolledUp = dist >= 60;
			this.farFromBottom = dist > el.clientHeight;

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

		__onPullStart(e) {
			if (this.isTopicRoute) return;
			const el = this.$refs.scrollContainer;
			if (!el) return;
			// 仅在已经在最顶才进入跟踪；其余情况让浏览器照常滚动
			if (el.scrollTop > 0) {
				this.__pullStartY = null;
				return;
			}
			const t = e.touches?.[0];
			if (!t) return;
			this.__pullStartY = t.clientY;
		},
		__onPullMove(e) {
			if (this.__pullStartY == null) return;
			const t = e.touches?.[0];
			if (!t) return;
			this.pullDistance = t.clientY - this.__pullStartY;
		},
		__onPullEnd() {
			const dist = this.pullDistance || 0;
			this.__pullStartY = null;
			this.pullDistance = 0;
			// 下拉≥60px 才触发；阈值与 use-pull-refresh 视觉阈值一致；向上滑（dist 负值）不触发
			if (dist >= 60 && !this.isTopicRoute) {
				// 标记为手势触发的加载——指示器仅响应这种路径
				this.__loadMoreHistory(true);
			}
		},
		__onPullCancel() {
			// 仅重置跟踪状态；中断的手势不当作完成
			this.__pullStartY = null;
			this.pullDistance = 0;
		},

		/** 消息加载后若内容不足以填满容器，主动加载历史 */
		__autoFillHistory() {
			if (this.isTopicRoute) return;
			const el = this.$refs.scrollContainer;
			if (el && el.scrollHeight <= el.clientHeight) {
				this.__loadMoreHistory();
			}
		},

		async __loadMoreHistory(fromPullGesture = false) {
			if (!this.chatStore || this.__loadingHistory) return;
			// 入口快照 store 引用：await 醒来后 chatStore 可能已切到别的 chat。
			// 弱 guard "!this.chatStore" 形同虚设（getter 永远 truthy），必须身份比对。
			const targetStore = this.chatStore;
			this.__loadingHistory = true;
			if (fromPullGesture) this.__pullGestureLoading = true;
			try {
				// 优先加载当前 session 内的更早消息
				if (targetStore.hasMoreMessages && !targetStore.messagesLoading) {
					const el = this.$refs.scrollContainer;
					// 入口快照 scrollTop + scrollHeight：恢复时用绝对赋值盖住浏览器锚定
					// （Chrome/Edge/Firefox 的 overflow-anchor:auto 会在 prepend 后自动调整 scrollTop，
					// 用 += 会双倍位移把用户撞到底）
					const prevScrollTop = el?.scrollTop ?? 0;
					const prevHeight = el?.scrollHeight ?? 0;
					const loaded = await targetStore.loadOlderMessages();
					// await 后 chatStore 已切走 / 组件已卸载 → 不再动 DOM
					if (this.__unmounted || this.chatStore !== targetStore) return;
					if (loaded && el) {
						this.$nextTick(() => {
							if (this.__unmounted || this.chatStore !== targetStore) return;
							const newHeight = el.scrollHeight;
							el.scrollTop = prevScrollTop + (newHeight - prevHeight);
						});
					}
					return;
				}

				if (targetStore.historyExhausted || targetStore.historyLoading) {
					if (targetStore.historyExhausted && !this.isTopicRoute && this.userScrolledUp) {
						this.showNoMoreHint = true;
					}
					return;
				}
				const el = this.$refs.scrollContainer;
				const prevScrollTop = el?.scrollTop ?? 0;
				const prevHeight = el?.scrollHeight ?? 0;
				const loaded = await targetStore.loadNextHistorySession();
				if (this.__unmounted || this.chatStore !== targetStore) return;
				if (loaded && el) {
					this.$nextTick(() => {
						if (this.__unmounted || this.chatStore !== targetStore) return;
						const newHeight = el.scrollHeight;
						el.scrollTop = prevScrollTop + (newHeight - prevHeight);
					});
				}
				if (targetStore.historyExhausted && !this.isTopicRoute && this.userScrolledUp) {
					this.showNoMoreHint = true;
				}
			} finally {
				// 只有"当前仍是发起这次加载的那个 store"才回收锁。
				// 切走的情况：watcher 已提前清零；如果新 chat 期间又触发了新加载，
				// 锁可能已被新加载置 true，这里若无条件清会把新加载的锁误清掉
				// 导致后续可能双发。__unmounted 同理：实例已卸载就别再写状态。
				if (!this.__unmounted && this.chatStore === targetStore) {
					this.__loadingHistory = false;
					// 同步清掉手势加载标志：本次加载结束 → 指示器隐藏
					this.__pullGestureLoading = false;
				}
			}
		},
	},
};
</script>
