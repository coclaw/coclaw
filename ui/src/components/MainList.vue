<template>
	<div
		class="min-h-0 flex-1"
		:class="scrollable ? 'overflow-auto overscroll-contain scrollbar-hide' : 'overflow-hidden'"
	>
		<!-- Capacitor header：logo + 名称 + 添加按钮 -->
		<header v-if="showCapHeader" class="sticky top-0 z-10 flex items-center gap-2 border-b border-default bg-default pl-3.5 pr-1 py-[3px] md:hidden">
			<img :src="logoSrc" alt="CoClaw" class="size-7 rounded" />
			<span class="flex-1 truncate text-base font-semibold">{{ $t('layout.productName') }}</span>
			<UButton
				icon="i-lucide-plus"
				color="primary"
				variant="ghost"
				size="xl"
				class="cc-icon-btn-lg"
				@click="$router.push('/bots/add')"
			/>
		</header>

		<!-- Group 1: 机器人操作入口 -->
		<nav v-if="botActionItems.length" class="space-y-0 px-2" :class="scrollable ? '' : 'mt-3'">
				<RouterLink
					v-for="item in botActionItems"
					:key="item.id"
					:to="item.to"
					class="group flex h-11 items-center gap-3 rounded-lg pl-2 pr-1 py-1 text-sm text-default transition-colors hover:bg-accented/80"
					:class="resolvePath(item.to) === currentPath ? 'bg-accented text-highlighted' : ''"
					role="listitem"
				>
					<UIcon :name="item.icon" class="size-6 text-dimmed" />
					<span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
				</RouterLink>
		</nav>

		<!-- Group 2: Agent 列表 -->
		<nav class="mt-3 space-y-0 px-2">
			<RouterLink
				v-for="item in agentItems"
				:key="item.id"
				:to="item.to"
				class="group flex h-11 items-center gap-3 rounded-lg pl-2 pr-1 py-1 text-sm text-default transition-colors hover:bg-accented/80"
				:class="item.active ? 'bg-accented text-highlighted' : ''"
				role="listitem"
			>
				<span class="relative shrink-0">
					<img
						v-if="item.avatarUrl"
						:src="item.avatarUrl"
						:alt="item.label"
						class="size-6 rounded-md object-cover"
					/>
					<span
						v-else-if="item.emoji"
						class="size-6 rounded-md bg-accented flex items-center justify-center text-sm leading-none"
					>{{ item.emoji }}</span>
					<img
						v-else
						:src="defaultBotAvatar"
						:alt="item.label"
						class="size-6 rounded-md object-cover"
					/>
					<span
						class="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-default"
						:class="item.online ? 'bg-success' : 'bg-neutral'"
					/>
				</span>
				<span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
			</RouterLink>
		</nav>

		<!-- Group 3: Topic 列表 -->
		<nav class="mt-3 space-y-0 px-2 pb-4">
			<div
				v-for="item in topicItems"
				:key="item.id"
				class="group flex h-11 items-center rounded-lg text-sm text-default transition-colors hover:bg-accented/80"
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
					class="topic-actions shrink-0 pr-1 opacity-0 group-hover:opacity-100"
					:topic-id="item.id"
					:bot-id="item.botId"
					:title="item.rawTitle"
					@deleted="onTopicDeleted"
				/>
			</div>
		</nav>
	</div>
</template>

<script>
import { useAgentsStore } from '../stores/agents.store.js';
import { useBotsStore } from '../stores/bots.store.js';
import { useEnvStore } from '../stores/env.store.js';
import { useTopicsStore } from '../stores/topics.store.js';
import TopicItemActions from './TopicItemActions.vue';
import defaultBotAvatar from '../assets/bot-avatars/openclaw.svg';
import logoSrc from '../assets/coclaw-logo.jpg';
import { isCapacitorApp } from '../utils/platform.js';

function toTopicLabel(topic, t) {
	if (typeof topic?.title === 'string' && topic.title.trim()) {
		return topic.title.trim();
	}
	return t('topic.newTopic');
}

export default {
	name: 'MainList',
	components: { TopicItemActions },
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
	},
	data() {
		return {
			defaultBotAvatar,
			logoSrc,
			agentsStore: null,
			botsStore: null,
			envStore: null,
			topicsStore: null,
		};
	},
	computed: {
		/** Capacitor 无侧边栏模式下显示页面 header */
		showCapHeader() {
			return !this.scrollable && isCapacitorApp && this.envStore?.screen.ltMd;
		},
		/** 当前路由上下文解析出的活跃 agentId（仅 main session 路由时高亮 agent） */
		activeAgentKey() {
			const route = this.$route;
			if (!route) return '';
			if (route.name === 'chat') {
				const botId = route.params?.botId;
				const agentId = route.params?.agentId;
				if (botId && agentId) return `${botId}:${agentId}`;
			}
			return '';
		},
		/** 跟踪 bot 增删/上线/连接就绪变化，触发 agents 和 topics 重新加载 */
		botListKey() {
			return (this.botsStore?.items ?? [])
				.map((b) => `${b.id}:${b.online}:${b.connState === 'connected'}`)
				.join(',');
		},
		botActionItems() {
			// Capacitor 无侧边栏模式：header 已有"+"按钮，仅用户无 bot 时显示引导项
			if (this.showCapHeader) {
				if (!this.botsStore?.fetched || this.botsStore.items.length > 0) {
					return [];
				}
				return [
					{ id: 'add-bot', label: this.$t('layout.addBot'), icon: 'i-lucide-plus', to: '/bots/add' },
				];
			}
			const items = [
				{ id: 'add-bot', label: this.$t('layout.addBot'), icon: 'i-lucide-plus', to: '/bots/add' },
			];
			if (this.scrollable) {
				items.push({ id: 'manage-bots', label: this.$t('layout.manageBots'), icon: 'i-lucide-settings', to: '/bots' });
			}
			return items;
		},
		agentItems() {
			const bots = this.botsStore?.items ?? [];
			const display = this.agentsStore?.getAgentDisplay;
			const result = [];
			for (const b of bots) {
				const agents = this.agentsStore?.getAgentsByBot(b.id) ?? [];
				if (agents.length) {
					// agents 已加载：展开为详细列表
					for (const agent of agents) {
						const d = display?.(b.id, agent.id) ?? {};
						result.push({
							id: `${b.id}:${agent.id}`,
							label: d.name || agent.id,
							avatarUrl: d.avatarUrl,
							emoji: d.emoji,
							online: Boolean(b.online),
							active: this.activeAgentKey === `${b.id}:${agent.id}`,
							to: { name: 'chat', params: { botId: String(b.id), agentId: agent.id } },
						});
					}
				} else {
					// agents 未加载（离线/连接中）：以 bot 身份兜底
					result.push({
						id: b.id,
						label: b.name || 'OpenClaw',
						avatarUrl: null,
						emoji: null,
						online: Boolean(b.online),
						active: this.activeAgentKey === `${b.id}:main`,
						to: { name: 'chat', params: { botId: String(b.id), agentId: 'main' } },
					});
				}
			}
			return result;
		},
		topicItems() {
			const items = this.topicsStore?.items ?? [];
			const display = this.agentsStore?.getAgentDisplay;
			const detailRouteName = 'topics-chat';
			return [...items]
				.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
				.map((topic) => {
					const d = display?.(topic.botId, topic.agentId) ?? {};
					const agentName = d.name || topic.agentId || 'Agent';
					return {
						id: topic.topicId,
						label: toTopicLabel(topic, this.$t),
						rawTitle: topic.title ?? '',
						botId: topic.botId,
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
		this.botsStore = useBotsStore();
		this.envStore = useEnvStore();
		this.topicsStore = useTopicsStore();
		this.loadAllData();
	},
	watch: {
		/** bot 列表变化（增删/上线状态）时刷新 agents 和 topics */
		botListKey: {
			handler() {
				this.agentsStore?.loadAllAgents();
				this.topicsStore.loadAllTopics();
			},
		},
	},
	methods: {
		async loadAllData() {
			// 等待 SSE 快照到达（bot 数据由 SSE 维护，无需主动 loadBots）
			if (!this.botsStore?.fetched) {
				await new Promise((resolve) => {
					const timer = setTimeout(() => { unwatch(); resolve(); }, 10_000);
					const unwatch = this.$watch(
						() => this.botsStore?.fetched,
						(val) => {
							if (val) { clearTimeout(timer); unwatch(); resolve(); }
						},
						{ immediate: true },
					);
				});
			}
			await this.agentsStore?.loadAllAgents();
			await this.topicsStore.loadAllTopics();
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
	},
};
</script>

<style scoped>
/* 触屏设备无 hover，操作按钮始终可见 */
@media (hover: none) {
	.topic-actions {
		opacity: 1;
	}
}
</style>
