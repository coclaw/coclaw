<template>
	<div
		class="min-h-0 flex-1"
		:class="scrollable ? 'overflow-auto overscroll-contain scrollbar-hide' : 'overflow-hidden'"
	>
		<!-- Capacitor header：logo + 名称 + RTC 连接状态 + 添加按钮（下拉菜单） -->
		<header v-if="showCapHeader" class="sticky top-0 z-10 flex items-center gap-2 border-b border-default bg-default pl-3.5 pr-1 py-[3px] md:hidden">
			<img :src="logoSrc" alt="CoClaw" class="size-7 rounded" />
			<span class="flex-1 truncate text-base font-semibold">{{ $t('layout.productName') }}</span>
			<div class="flex shrink-0 items-center">
				<!-- RTC 建连/恢复中：loading 状态的 refresh 按钮 -->
				<UButton
					v-if="showRtcConnecting"
					icon="i-lucide-refresh-cw"
					color="neutral"
					variant="ghost"
					class="cc-icon-btn-lg"
					data-testid="rtc-connecting"
					:title="$t('layout.rtcConnecting')"
					:aria-label="$t('layout.rtcConnecting')"
					:loading="true"
					:disabled="true"
				/>
				<!-- RTC 退避耗尽：warning 色 refresh 按钮 -->
				<UButton
					v-else-if="hasUnreachableClaws"
					icon="i-lucide-refresh-cw"
					color="warning"
					variant="ghost"
					class="cc-icon-btn-lg"
					data-testid="rtc-unreachable"
					:title="$t('layout.rtcUnreachable')"
					:aria-label="$t('layout.rtcUnreachable')"
					@click="onManualRetry"
				/>
				<!-- 添加按钮：下拉菜单（添加 Claw / 添加 Web Agent） -->
				<div class="relative">
					<UPopover v-model:open="capAddMenuOpen" :content="{ side: 'bottom', align: 'end' }">
						<UButton
							icon="i-lucide-plus"
							color="primary"
							variant="ghost"
							class="cc-icon-btn-lg"
							data-testid="cap-header-add-trigger"
							:aria-label="$t('layout.addEntry')"
							aria-haspopup="menu"
							:aria-expanded="capAddMenuOpen"
						/>
						<template #content>
							<div class="flex max-w-60 flex-col py-1" role="menu">
								<button
									v-for="item in addActionItems"
									:key="item.id"
									type="button"
									role="menuitem"
									:data-testid="`cap-header-add-${item.id}`"
									class="flex min-h-11 items-center gap-2.5 pl-4 pr-5 text-sm text-default transition-colors hover:bg-accented active:bg-accented"
									@click="onAddAction(item.id)"
								>
									<UIcon v-if="item.iconType === 'lucide'" :name="item.icon" class="size-[18px] shrink-0" :class="item.iconClass" aria-hidden="true" />
									<img v-else :src="item.icon" alt="" aria-hidden="true" class="size-[18px] shrink-0" />
									<span class="truncate">{{ item.label }}</span>
								</button>
							</div>
						</template>
					</UPopover>
				</div>
			</div>
		</header>

		<!-- Group 1: 我的 Claw（顶部，仅桌面侧边栏） -->
		<nav v-if="topActionItems.length" class="space-y-0 px-2" :class="scrollable ? '' : 'mt-3'">
			<RouterLink
				v-for="item in topActionItems"
				:key="item.id"
				:to="item.to"
				class="group flex h-11 cursor-pointer items-center gap-3 rounded-lg pl-2 pr-1 py-1 text-sm text-default transition-colors hover:bg-accented/80"
				:class="isTopItemActive(item) ? 'bg-accented text-highlighted' : ''"
				role="listitem"
			>
				<UIcon :name="item.icon" class="size-6 text-dimmed" />
				<span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
			</RouterLink>
		</nav>

		<!-- Group 2: Agent 列表（claw agent + 已点 web agent 混排，按 last used 倒排） -->
		<nav class="mt-3 space-y-0 px-2">
			<div
				v-for="item in mixedAgentItems"
				:key="item.id"
				class="group flex h-11 cursor-pointer items-center rounded-lg text-sm text-default transition-colors hover:bg-accented/80"
				:class="item.type === 'claw' && item.active ? 'bg-accented text-highlighted' : ''"
				role="listitem"
			>
				<template v-if="item.type === 'claw'">
					<RouterLink
						:to="item.to"
						class="flex min-w-0 flex-1 items-center gap-3 px-2 py-1"
					>
						<span class="relative shrink-0">
							<img
								v-if="item.avatarUrl"
								:src="item.avatarUrl"
								:alt="item.agentName"
								class="size-6 rounded-md object-cover"
							/>
							<span
								v-else-if="item.emoji"
								class="size-6 rounded-md bg-accented flex items-center justify-center text-sm leading-none"
							>{{ item.emoji }}</span>
							<img
								v-else
								:src="defaultClawAvatar"
								:alt="item.agentName"
								class="size-6 rounded-md object-cover"
							/>
							<span
								class="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-default"
								:class="item.online ? 'bg-success' : 'bg-neutral'"
							/>
						</span>
						<!-- label：单 claw 仅 agent 名；多 claw 时 agent@claw -->
						<span class="flex min-w-0 flex-1 items-baseline">
							<span class="truncate min-w-0">{{ item.agentName }}</span>
							<template v-if="item.clawName">
								<span class="shrink-0 text-muted">@</span>
								<span class="truncate min-w-0 text-muted">{{ item.clawName }}</span>
							</template>
						</span>
					</RouterLink>
					<AgentItemActions
						class="agent-actions shrink-0 pr-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
						:claw-id="item.clawId"
						:agent-id="item.agentId"
					/>
				</template>
				<template v-else>
					<button
						type="button"
						:data-testid="instance === 'main' ? `web-agent-recent-${item.slug ?? 'custom-' + item.webId}` : null"
						class="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-2 py-1 text-left"
						@click="onClickRecentWebAgent(item)"
					>
						<img
							v-if="webAgentIconFor(item.slug)"
							:src="webAgentIconFor(item.slug)"
							alt=""
							aria-hidden="true"
							class="size-6 shrink-0 rounded-md object-cover"
						/>
						<UIcon
							v-else
							name="i-lucide-globe"
							aria-hidden="true"
							class="size-6 shrink-0 text-dimmed"
						/>
						<span class="min-w-0 flex-1 truncate">{{ item.name }}</span>
					</button>
					<WebAgentItemActions
						class="web-agent-actions shrink-0 pr-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
						:web-agent-id="item.webId"
						:instance="instance"
					/>
				</template>
			</div>
		</nav>

		<!-- Group 3: Topic 列表 -->
		<nav class="mt-3 space-y-0 px-2">
			<div
				v-for="item in topicItems"
				:key="item.id"
				class="group flex h-11 cursor-pointer items-center rounded-lg text-sm text-default transition-colors hover:bg-accented/80"
				:class="resolvePath(item.to) === currentPath ? 'bg-accented text-highlighted' : ''"
				role="listitem"
			>
				<RouterLink
					:to="item.to"
					class="flex min-w-0 flex-1 items-center gap-3 px-2 py-1"
				>
					<img
						v-if="item.agentAvatarUrl"
						:src="item.agentAvatarUrl"
						:alt="item.label"
						class="size-6 shrink-0 rounded-full object-cover"
					/>
					<span
						v-else-if="item.agentEmoji"
						class="size-6 shrink-0 rounded-full bg-accented flex items-center justify-center text-sm leading-none"
					>{{ item.agentEmoji }}</span>
					<span
						v-else
						class="size-6 shrink-0 rounded-full bg-accented flex items-center justify-center text-xs font-medium text-dimmed"
					>{{ item.agentInitial }}</span>
					<span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
				</RouterLink>
				<TopicItemActions
					class="topic-actions shrink-0 pr-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
					:topic-id="item.id"
					:claw-id="item.clawId"
					:title="item.rawTitle"
					@deleted="onTopicDeleted"
				/>
			</div>
		</nav>

		<!-- Group 4: 底部 actions（添加 Claw / 添加 Web Agent，常驻） -->
		<nav class="mt-3 space-y-0 px-2 pb-4">
			<button
				v-for="item in addActionItems"
				:key="item.id"
				type="button"
				:data-testid="instance === 'main' ? `bottom-action-${item.id}` : null"
				class="group flex h-11 w-full cursor-pointer items-center gap-3 rounded-lg pl-2 pr-1 py-1 text-left text-sm text-default transition-colors hover:bg-accented/80"
				:class="isAddItemActive(item) ? 'bg-accented text-highlighted' : ''"
				@click="onAddAction(item.id)"
			>
				<UIcon v-if="item.iconType === 'lucide'" :name="item.icon" class="size-6" :class="item.iconClass" />
				<img v-else :src="item.icon" :alt="item.label" class="size-6" />
				<span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
			</button>
		</nav>
	</div>
</template>

<script>
import { useAgentsStore } from '../stores/agents.store.js';
import { useClawsStore } from '../stores/claws.store.js';
import { useEnvStore } from '../stores/env.store.js';
import { useSessionsStore } from '../stores/sessions.store.js';
import { useTopicsStore } from '../stores/topics.store.js';
import { useWebAgentsStore } from '../stores/web-agents.store.js';
import { useWebAgentDialogs } from '../composables/use-web-agent-dialogs.js';
import AgentItemActions from './AgentItemActions.vue';
import TopicItemActions from './TopicItemActions.vue';
import WebAgentItemActions from './WebAgentItemActions.vue';
import defaultClawAvatar from '../assets/claw-avatars/openclaw.svg';
import addClawIcon from '../assets/add-claw.svg';
import logoSrc from '../assets/coclaw-logo.jpg';
import { isCapacitorApp } from '../utils/platform.js';
import { openExternalUrl } from '../utils/external-url.js';

// 与 WebAgentPickerPanel 一致的 eager glob：slug → 静态资源 URL（svg/png 共享）
const webAgentIconModules = import.meta.glob('../assets/web-agents/*.{svg,png}', {
	eager: true,
	query: '?url',
	import: 'default',
});
const webAgentIconBySlug = {};
for (const [path, url] of Object.entries(webAgentIconModules)) {
	const m = path.match(/\/([^/]+)\.(svg|png)$/);
	if (!m) continue;
	const [, slug, ext] = m;
	if (webAgentIconBySlug[slug] && ext === 'png') continue;
	webAgentIconBySlug[slug] = url;
}

function toTopicLabel(topic, t) {
	if (typeof topic?.title === 'string' && topic.title.trim()) {
		return topic.title.trim();
	}
	return t('topic.newTopic');
}

export default {
	name: 'MainList',
	components: { AgentItemActions, TopicItemActions, WebAgentItemActions },
	props: {
		currentPath: {
			type: String,
			default: '',
		},
		/** 是否作为独立滚动容器（桌面侧边栏场景） */
		scrollable: {
			type: Boolean,
			default: false,
		},
		/**
		 * 实例标记：MainList 同时挂在 DesktopSidebar(<aside>) 与 TopicsPage(<main>)，两份 DOM 共存。
		 * 'main' 实例渲染 data-testid，'sidebar' 实例不渲染——避免 Playwright strict-mode 撞到两个相同 testid。
		 * 用户实际可见的总是其中之一（CSS hidden md:flex），单元/E2E 测试默认走 'main'。
		 */
		instance: {
			type: String,
			default: 'main',
		},
	},
	setup() {
		// composable 必须在 setup 内调用以拿到当前组件的 overlay context
		const { openPickerDialog } = useWebAgentDialogs();
		return { openPickerDialog };
	},
	data() {
		return {
			defaultClawAvatar,
			addClawIcon,
			logoSrc,
			capAddMenuOpen: false,
			agentsStore: null,
			clawsStore: null,
			envStore: null,
			sessionsStore: null,
			topicsStore: null,
			webAgentsStore: null,
		};
	},
	computed: {
		/** Capacitor 无侧边栏模式下显示页面 header */
		showCapHeader() {
			return !this.scrollable && isCapacitorApp && this.envStore?.screen.ltMd;
		},
		/** 至少一个 online claw 正在 RTC 建连/恢复/排退避 */
		showRtcConnecting() {
			return Boolean(this.clawsStore?.isConnectingRtc);
		},
		/** 存在退避耗尽的 online claw；与 spinner 的互斥由模板 v-else-if 保证 */
		hasUnreachableClaws() {
			return Boolean(this.clawsStore?.unreachableClaws.length);
		},
		/** 当前路由上下文解析出的活跃 agentId（chat 与 files 子页都按所属 agent 高亮） */
		activeAgentKey() {
			const route = this.$route;
			if (!route) return '';
			if (route.name === 'chat' || route.name === 'files') {
				const clawId = route.params?.clawId;
				const agentId = route.params?.agentId;
				if (clawId && agentId) return `${clawId}:${agentId}`;
			}
			return '';
		},
		/**
		 * 跟踪 claw 增删/上线变化，触发 agents、topics、sessions 重新加载
		 * 不含 dcReady：DC 就绪后的首屏加载由 claw-lifecycle 的 __fullInit 负责，避免与本 watcher 重复并发首屏 RPC
		 */
		clawListKey() {
			return (this.clawsStore?.items ?? [])
				.map((b) => `${b.id}:${b.online}`)
				.join(',');
		},
		/** 顶部组：仅桌面侧边栏显示"我的 Claw"（manage 入口）；其它场景留空 */
		topActionItems() {
			if (!this.scrollable) return [];
			return [
				{ id: 'manage-claws', label: this.$t('layout.manageClaws'), icon: 'i-lucide-settings', to: '/claws' },
			];
		},
		/** 底部组 + capacitor header 下拉菜单共用：添加 Claw / 添加 Web Agent */
		addActionItems() {
			return [
				// 添加 Claw 是独立入口（非 /claws 子页），有自己的路由用于高亮判定
				{ id: 'add-claw', label: this.$t('layout.addClaw'), icon: this.addClawIcon, iconType: 'svg', activePath: '/claws/add' },
				{ id: 'add-web-agent', label: this.$t('layout.addWebAgent'), icon: 'i-lucide-globe', iconType: 'lucide', iconClass: 'text-teal-600' },
			];
		},
		/** Agent 列表：claw agents + 用户点过的 web agents 混排，按 last used 倒排 */
		mixedAgentItems() {
			const items = [];
			const bots = this.clawsStore?.items ?? [];
			const display = this.agentsStore?.getAgentDisplay;
			const sessions = this.sessionsStore;
			// 仅在多 claw 时给 label 加 @clawName 后缀，单 claw 不冗余
			const useClawSuffix = bots.length >= 2;
			for (const b of bots) {
				const agents = this.agentsStore?.getAgentsByClaw(b.id) ?? [];
				if (agents.length) {
					// agents 已加载：展开为详细列表
					for (const agent of agents) {
						const d = display?.(b.id, agent.id) ?? {};
						const agentName = d.name || agent.id;
						// 默认 agent 无 identity 时同名场景丢掉 @ 后缀
						let clawName = useClawSuffix ? (b.name || 'OpenClaw') : null;
						if (clawName && clawName === agentName) clawName = null;
						items.push({
							id: `claw:${b.id}:${agent.id}`,
							type: 'claw',
							clawId: String(b.id),
							agentId: agent.id,
							agentName,
							clawName,
							avatarUrl: d.avatarUrl,
							emoji: d.emoji,
							online: Boolean(b.online),
							active: this.activeAgentKey === `${b.id}:${agent.id}`,
							to: { name: 'chat', params: { clawId: String(b.id), agentId: agent.id } },
							activity: sessions?.getActivity(b.id, agent.id) ?? 0,
						});
					}
				} else {
					// agents 未加载（离线/连接中）：以 claw 身份兜底
					items.push({
						id: `claw:${b.id}:main`,
						type: 'claw',
						clawId: String(b.id),
						agentId: 'main',
						agentName: b.name || 'OpenClaw',
						clawName: null,
						avatarUrl: null,
						emoji: null,
						online: Boolean(b.online),
						active: this.activeAgentKey === `${b.id}:main`,
						to: { name: 'chat', params: { clawId: String(b.id), agentId: 'main' } },
						activity: sessions?.getActivity(b.id, 'main') ?? 0,
					});
				}
			}
			const webAgents = this.webAgentsStore?.recentlyClicked ?? [];
			for (const w of webAgents) {
				items.push({
					id: `web:${w.id}`,
					type: 'web',
					webId: w.id,
					slug: w.slug ?? null,
					name: w.name,
					url: w.url,
					activity: w.lastClickedAt ? new Date(w.lastClickedAt).getTime() : 0,
				});
			}
			// 按 last used 时间倒排（ES2019 stable sort 保留 0 活动条目自然顺序）
			items.sort((a, b) => b.activity - a.activity);
			return items;
		},
		topicItems() {
			const items = this.topicsStore?.items ?? [];
			const display = this.agentsStore?.getAgentDisplay;
			const detailRouteName = 'topics-chat';
			return [...items]
				.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
				.map((topic) => {
					const d = display?.(topic.clawId, topic.agentId) ?? {};
					const agentName = d.name || topic.agentId || 'Agent';
					return {
						id: topic.topicId,
						label: toTopicLabel(topic, this.$t),
						rawTitle: topic.title ?? '',
						clawId: topic.clawId,
						agentAvatarUrl: d.avatarUrl || null,
						agentEmoji: d.emoji || null,
						agentInitial: agentName.charAt(0).toUpperCase(),
						to: {
							name: detailRouteName,
							params: { sessionId: topic.topicId },
						},
					};
				});
		},
	},
	mounted() {
		this.agentsStore = useAgentsStore();
		this.clawsStore = useClawsStore();
		this.envStore = useEnvStore();
		this.sessionsStore = useSessionsStore();
		this.topicsStore = useTopicsStore();
		this.webAgentsStore = useWebAgentsStore();
		this.loadAllData();
		// Web Agents 列表与上面 5 个 store 解耦，单独 fire-and-forget 加载
		this.webAgentsStore.loadAll();
	},
	watch: {
		/** claw 列表变化（增删/上线状态）时刷新 agents / topics / sessions */
		clawListKey: {
			async handler() {
				// sessions 拉取后按 agent 切片依赖 agents 已加载，必须先 await agents 再触发 sessions
				try {
					await this.agentsStore?.loadAllAgents();
				}
				catch (err) {
					console.debug('[MainList] watcher loadAllAgents failed: %s', err?.message);
				}
				await Promise.all([
					this.topicsStore.loadAllTopics(),
					this.sessionsStore?.loadAllSessions(),
				]);
			},
		},
	},
	methods: {
		async loadAllData() {
			// 等待 SSE 快照到达
			if (!this.clawsStore?.fetched) {
				await new Promise((resolve) => {
					const timer = setTimeout(() => { unwatch(); resolve(); }, 10_000);
					const unwatch = this.$watch(
						() => this.clawsStore?.fetched,
						(val) => {
							if (val) { clearTimeout(timer); unwatch(); resolve(); }
						},
						{ immediate: true },
					);
				});
			}
			// agents 必须先加载完，sessions 拉取时才能按 agentId 切片
			try {
				await this.agentsStore?.loadAllAgents();
			}
			catch (err) {
				console.debug('[MainList] loadAllData loadAllAgents failed: %s', err?.message);
			}
			await Promise.all([
				this.topicsStore.loadAllTopics(),
				this.sessionsStore?.loadAllSessions(),
			]);
		},
		onManualRetry() {
			this.clawsStore?.manualRetryUnreachable();
		},
		onAddAction(itemId) {
			this.capAddMenuOpen = false;
			if (itemId === 'add-claw') {
				this.$router.push('/claws/add');
				return;
			}
			if (itemId === 'add-web-agent') {
				this.openPickerDialog();
			}
		},
		webAgentIconFor(slug) {
			if (!slug) return null;
			return webAgentIconBySlug[slug] ?? null;
		},
		onClickRecentWebAgent(item) {
			this.webAgentsStore?.recordClick(item.webId);
			Promise.resolve(openExternalUrl(item.url)).catch((err) => {
				console.warn('[MainList] openExternalUrl failed:', err?.message ?? err);
			});
		},
		onTopicDeleted(topicId) {
			// 兜底：桌面端侧边栏始终挂载，若正在查看被删除的 topic 则跳转默认路由
			const route = this.$route;
			if (route?.name === 'topics-chat' && route.params?.sessionId === topicId) {
				this.$router.replace('/');
			}
		},
		resolvePath(to) {
			if (typeof to === 'string') {
				return to;
			}
			return this.$router.resolve(to).path;
		},
		/**
		 * 顶部入口高亮判定：前缀匹配（设计 § 3）。
		 * 当前路径等于入口路径本身、或是其子路径时都高亮——
		 * 让"我的 Claw"在 /claws、/claws/:id/models 等 /claws/... 下保持 active。
		 * 例外：带独立侧边栏入口的子路径（如 /claws/add）归该入口自己高亮，不归顶部入口。
		 */
		isTopItemActive(item) {
			const target = this.resolvePath(item.to);
			if (!target) return false;
			if (this.currentPath === target) return true;
			if (!this.currentPath.startsWith(`${target}/`)) return false;
			return !this.addActionItems.some((a) => a.activePath === this.currentPath);
		},
		/** 底部 action 入口高亮判定：仅带 activePath 的项（如 添加 Claw）在其路由下 active */
		isAddItemActive(item) {
			return Boolean(item.activePath) && this.currentPath === item.activePath;
		},
	},
};
</script>

<style scoped>
/* 触屏设备无 hover，操作按钮始终可见 */
@media (hover: none) {
	.topic-actions,
	.agent-actions,
	.web-agent-actions {
		opacity: 1;
	}
}
</style>
