<template>
	<div class="flex flex-1 items-center justify-center">
		<UIcon name="i-lucide-loader-circle" class="size-8 animate-spin text-dimmed" />
	</div>
</template>

<script>
import { useAgentsStore } from '../stores/agents.store.js';
import { useBotsStore } from '../stores/bots.store.js';
import { useEnvStore } from '../stores/env.store.js';

const TIMEOUT_MS = 5000;

export default {
	name: 'HomePage',
	data() {
		return {
			timer: null,
			__resolved: false,
		};
	},
	async mounted() {
		// 移动端直接跳转
		if (useEnvStore().screen.ltMd) {
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

			if (!bots.length) {
				this.go('/bots/add');
				return;
			}

			const onlineBot = bots.find((b) => b.online);
			if (!onlineBot) {
				this.go('/bots');
				return;
			}

			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents(onlineBot.id);
			const defaultId = agentsStore.byBot[onlineBot.id]?.defaultId || 'main';
			this.go({
				name: 'chat',
				params: { botId: String(onlineBot.id), agentId: defaultId },
			});
		},
		go(to) {
			if (this.__resolved) return;
			this.__resolved = true;
			if (this.timer) {
				clearTimeout(this.timer);
				this.timer = null;
			}
			this.$router.replace(to);
		},
		fallback() {
			this.timer = null;
			this.go('/bots');
		},
	},
};
</script>
