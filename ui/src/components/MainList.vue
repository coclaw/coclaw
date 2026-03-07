<template>
	<div
		class="min-h-0 flex-1"
		:class="scrollable ? 'overflow-auto overscroll-contain scrollbar-hide' : 'overflow-hidden'"
	>
		<!-- Group 1: 机器人操作入口（仅桌面 drawer） -->
		<template v-if="showBotActions">
			<nav class="space-y-0 px-2 --pt-2">
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
		</template>

		<!-- Group 2: 常用机器人 -->
		<nav class="mt-3 space-y-0 px-2">
			<RouterLink
				v-for="item in botItems"
				:key="item.id"
				:to="item.to"
				class="group flex h-11 items-center gap-3 rounded-lg pl-2 pr-1 py-1 text-sm text-default transition-colors hover:bg-accented/80"
				role="listitem"
			>
				<span class="relative shrink-0">
					<img
						:src="item.avatar || defaultBotAvatar"
						:alt="item.label"
						class="size-6 rounded-full object-cover"
					/>
					<span
						class="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-default"
						:class="item.online ? 'bg-success' : 'bg-neutral'"
					/>
				</span>
				<span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
			</RouterLink>
			<!-- 移动端：末尾追加"添加机器人"入口 -->
			<RouterLink
				v-if="!showBotActions"
				to="/bots/add"
				class="group flex h-11 items-center gap-3 rounded-lg pl-2 pr-1 py-1 text-sm text-default transition-colors hover:bg-accented/80"
				role="listitem"
			>
				<UIcon name="i-lucide-plus" class="size-6 text-dimmed" />
				<span class="min-w-0 flex-1 truncate">{{ $t('layout.addBot') }}</span>
			</RouterLink>
		</nav>

		<!-- Group 3: 会话列表 -->
		<nav class="mt-3 space-y-0 px-2 pb-2">
			<RouterLink
				v-for="item in sessionItems"
				:key="item.id"
				:to="item.to"
				class="group flex h-11 items-center gap-3 rounded-lg px-2 py-1 text-sm text-default transition-colors hover:bg-accented/80"
				:class="resolvePath(item.to) === currentPath ? 'bg-accented text-highlighted' : ''"
				role="listitem"
			>
				<span class="size-6 shrink-0 rounded-full bg-accented flex items-center justify-center text-xs font-medium text-dimmed">{{ item.botInitial }}</span>
				<span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
				<UIcon v-if="item.badge" :name="item.badge.icon" class="size-4 shrink-0" :class="item.badge.color" />
			</RouterLink>
		</nav>
	</div>
</template>

<script>
import { useBotsStore } from '../stores/bots.store.js';
import { useSessionsStore } from '../stores/sessions.store.js';
import { cleanDerivedTitle } from '../utils/session-msg-group.js';
import defaultBotAvatar from '../assets/bot-avatars/openclaw.svg';

/** 根据 sessionKey / indexed 状态返回图标标记 */
function toSessionBadge(item) {
	if (!item.indexed) {
		return { icon: 'i-lucide-unlink', color: 'text-dimmed' };
	}
	const key = item.sessionKey;
	if (!key) return null;
	if (key === 'agent:main:main') {
		return { icon: 'i-lucide-star', color: 'text-primary' };
	}
	if (/^agent:[^:]+:cron:/.test(key)) {
		return { icon: 'i-lucide-clock', color: 'text-warning' };
	}
	if (/^agent:[^:]+:session-research-/.test(key)) {
		return { icon: 'i-lucide-flask-conical', color: 'text-dimmed' };
	}
	return null;
}

function toSessionLabel(item, t) {
	if (typeof item?.title === 'string' && item.title.trim()) {
		return cleanDerivedTitle(item.title) || item.title.trim();
	}
	const cleaned = cleanDerivedTitle(item?.derivedTitle);
	if (cleaned) {
		return cleaned;
	}
	const id = String(item?.sessionId ?? '');
	return id || t('layout.unnamedSession');
}

export default {
	name: 'MainList',
	props: {
		currentPath: {
			type: String,
			default: '',
		},
		showBotActions: {
			type: Boolean,
			default: false,
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
			botsStore: null,
			sessionsStore: null,
		};
	},
	computed: {
		botNameMap() {
			const bots = this.botsStore?.items ?? [];
			const map = {};
			for (const b of bots) {
				map[b.id] = b.name || 'OpenClaw';
			}
			return map;
		},
		botActionItems() {
			return [
				{ id: 'add-bot', label: this.$t('layout.addBot'), icon: 'i-lucide-plus', to: '/bots/add' },
				{ id: 'manage-bots', label: this.$t('layout.manageBots'), icon: 'i-lucide-settings', to: '/bots' },
			];
		},
		botItems() {
			const bots = this.botsStore?.items ?? [];
			const sessions = this.sessionsStore?.items ?? [];
			return bots.map((b) => {
				// 查找 agent:main:main 对应的 session
				const mainSession = sessions.find(
					(s) => s.botId === b.id && s.sessionKey === 'agent:main:main',
				);
				const to = mainSession
					? { name: 'chat', params: { sessionId: mainSession.sessionId } }
					: '/home';
				return {
					id: b.id,
					label: b.name || 'OpenClaw',
					avatar: defaultBotAvatar,
					online: Boolean(b.online),
					to,
				};
			});
		},
		sessionItems() {
			const items = this.sessionsStore?.items ?? [];
			const detailRouteName = this.currentPath.startsWith('/topics') ? 'topics-chat' : 'chat';
			return items.map((item) => ({
				id: item.sessionId,
				label: toSessionLabel(item, this.$t),
				badge: toSessionBadge(item),
				botInitial: (this.botNameMap[item.botId] ?? 'O').charAt(0).toUpperCase(),
				to: {
					name: detailRouteName,
					params: { sessionId: item.sessionId },
				},
			}));
		},
	},
	mounted() {
		this.botsStore = useBotsStore();
		this.sessionsStore = useSessionsStore();
		this.loadAllData();
	},
	watch: {
		'botsStore.items': {
			deep: true,
			handler() {
				this.sessionsStore.loadAllSessions();
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
			await this.sessionsStore.loadAllSessions();
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
