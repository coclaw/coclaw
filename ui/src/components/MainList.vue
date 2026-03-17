<template>
	<div
		class="min-h-0 flex-1"
		:class="scrollable ? 'overflow-auto overscroll-contain scrollbar-hide' : 'overflow-hidden'"
	>
		<!-- Group 1: 机器人操作入口 -->
		<nav class="space-y-0 px-2" :class="scrollable ? '' : 'mt-3'">
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
		<nav class="mt-3 space-y-0 px-2 pb-2">
			<RouterLink
				v-for="item in topicItems"
				:key="item.id"
				:to="item.to"
				class="group flex h-11 items-center gap-3 rounded-lg px-2 py-1 text-sm text-default transition-colors hover:bg-accented/80"
				:class="resolvePath(item.to) === currentPath ? 'bg-accented text-highlighted' : ''"
				role="listitem"
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
		</nav>
	</div>
</template>

<script>
import { useAgentsStore } from '../stores/agents.store.js';
import { useBotsStore } from '../stores/bots.store.js';
import { useSessionsStore } from '../stores/sessions.store.js';
import { useTopicsStore } from '../stores/topics.store.js';
import defaultBotAvatar from '../assets/bot-avatars/openclaw.svg';

function toTopicLabel(topic, t) {
	if (typeof topic?.title === 'string' && topic.title.trim()) {
		return topic.title.trim();
	}
	return t('topic.newTopic');
}

export default {
	name: 'MainList',
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
			agentsStore: null,
			botsStore: null,
			sessionsStore: null,
			topicsStore: null,
		};
	},
	computed: {
		/** 当前路由上下文解析出的活跃 agentId（仅 main session 路由时高亮 agent） */
		activeAgentKey() {
			const route = this.$route;
			if (!route) return '';
			// 仅在 session 路由（用户点击 agent 进入 main session）时高亮 agent
			// topic 路由下不高亮 agent，由 topic 列表的 currentPath 匹配负责高亮
			if (route.name === 'chat') {
				const sid = route.params?.sessionId;
				const session = this.sessionsStore?.items?.find((s) => s.sessionId === sid);
				if (session?.sessionKey) {
					const agentId = this.agentsStore?.parseAgentId(session.sessionKey);
					if (agentId) return `${session.botId}:${agentId}`;
				}
			}
			return '';
		},
		botActionItems() {
			const items = [
				{ id: 'add-bot', label: this.$t('layout.addBot'), icon: 'i-lucide-plus', to: '/bots/add' },
			];
			if (this.scrollable) {
				items.push({ id: 'manage-bots', label: this.$t('layout.manageBots'), icon: 'i-lucide-settings', to: '/bots' });
			}
			return items;
		},
		agentItems() {
			const allAgents = this.agentsStore?.allAgentItems ?? [];
			const sessions = this.sessionsStore?.items ?? [];
			const display = this.agentsStore?.getAgentDisplay;
			if (!allAgents.length) {
				// agents 未加载时 fallback 到 bot 列表
				const bots = this.botsStore?.items ?? [];
				return bots.map((b) => {
					const mainSession = sessions.find(
						(s) => s.botId === b.id && /^agent:[^:]+:main$/.test(s.sessionKey),
					);
					return {
						id: b.id,
						label: b.name || 'OpenClaw',
						avatarUrl: null,
						emoji: null,
						online: Boolean(b.online),
						active: this.activeAgentKey === `${b.id}:main`,
						to: mainSession
							? { name: 'chat', params: { sessionId: mainSession.sessionId } }
							: '/home',
					};
				});
			}
			return allAgents.map((agent) => {
				const mainSessionKey = `agent:${agent.id}:main`;
				const session = sessions.find(
					(s) => s.botId === agent.botId && s.sessionKey === mainSessionKey,
				);
				const d = display?.(agent.botId, agent.id) ?? {};
				return {
					id: `${agent.botId}:${agent.id}`,
					label: d.name || agent.id,
					avatarUrl: d.avatarUrl,
					emoji: d.emoji,
					online: agent.botOnline,
					active: this.activeAgentKey === `${agent.botId}:${agent.id}`,
					to: session
						? { name: 'chat', params: { sessionId: session.sessionId } }
						: '/home',
				};
			});
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
		this.sessionsStore = useSessionsStore();
		this.topicsStore = useTopicsStore();
		this.loadAllData();
	},
	watch: {
		'botsStore.items': {
			deep: true,
			async handler() {
				await this.agentsStore?.loadAllAgents();
				this.sessionsStore.loadAllSessions();
				this.topicsStore.loadAllTopics();
			},
		},
	},
	methods: {
		async loadAllData() {
			try {
				await this.botsStore?.loadBots();
			}
			catch {
				this.botsStore?.setBots([]);
			}
			await this.agentsStore?.loadAllAgents();
			await Promise.all([
				this.sessionsStore.loadAllSessions(),
				this.topicsStore.loadAllTopics(),
			]);
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
