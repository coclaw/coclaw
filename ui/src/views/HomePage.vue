<template>
	<div class="flex flex-1 items-center justify-center">
		<UIcon name="i-lucide-loader-circle" class="size-8 animate-spin text-dimmed" />
	</div>
</template>

<script>
import { useAgentsStore } from '../stores/agents.store.js';
import { useBotsStore } from '../stores/bots.store.js';
import { useSessionsStore } from '../stores/sessions.store.js';
import { isMobileViewport } from '../utils/layout.js';

const TIMEOUT_MS = 5000;

export default {
	name: 'HomePage',
	data() {
		return {
			timer: null,
		};
	},
	async mounted() {
		// 移动端直接跳转
		if (isMobileViewport(window.innerWidth)) {
			this.$router.replace('/topics');
			return;
		}
		// 桌面端：加载 bot 数据后决定跳转目标
		this.timer = setTimeout(() => this.fallback(), TIMEOUT_MS);
		try {
			await this.resolveDesktopRoute();
		}
		catch (err) {
			console.warn('[home] resolve failed:', err);
			this.fallback();
		}
	},
	beforeUnmount() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	},
	methods: {
		async resolveDesktopRoute() {
			const botsStore = useBotsStore();
			await botsStore.loadBots();
			const bots = botsStore.items;

			// 无绑定 bot → 添加机器人
			if (!bots.length) {
				this.go('/bots/add');
				return;
			}

			const onlineBot = bots.find((b) => b.online);
			if (!onlineBot) {
				// 全部离线 → 管理机器人
				this.go('/bots');
				return;
			}

			// 有在线 bot → 加载 agents + sessions，跳到默认 agent 的 main session
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents(onlineBot.id);
			const sessionsStore = useSessionsStore();
			await sessionsStore.loadAllSessions();
			const defaultId = agentsStore.byBot[onlineBot.id]?.defaultId || 'main';
			const mainSession = sessionsStore.items.find(
				(s) => s.botId === onlineBot.id && s.sessionKey === `agent:${defaultId}:main`,
			);
			if (mainSession?.sessionId) {
				this.go({ name: 'chat', params: { sessionId: mainSession.sessionId } });
			}
			else {
				this.go('/bots');
			}
		},
		go(to) {
			if (this.timer) {
				clearTimeout(this.timer);
				this.timer = null;
			}
			this.$router.replace(to);
		},
		fallback() {
			this.timer = null;
			this.$router.replace('/bots');
		},
	},
};
</script>
