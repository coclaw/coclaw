<template>
	<div class="flex flex-1 items-center justify-center">
		<UIcon name="i-lucide-loader-circle" class="size-8 animate-spin text-dimmed" />
	</div>
</template>

<script>
import { useAgentsStore } from '../stores/agents.store.js';
import { useClawsStore } from '../stores/claws.store.js';
import { useEnvStore } from '../stores/env.store.js';

const TIMEOUT_MS = 5000;

export default {
	name: 'HomePage',
	data() {
		return {
			timer: null,
			__resolved: false,
			__unwatchFetched: null,
		};
	},
	async mounted() {
		// 移动端直接跳转
		if (useEnvStore().screen.ltMd) {
			this.$router.replace('/topics');
			return;
		}
		// 桌面端：等待 claw 数据就绪后决定跳转目标
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
		if (this.__unwatchFetched) {
			this.__unwatchFetched();
			this.__unwatchFetched = null;
		}
	},
	methods: {
		async resolveDesktopRoute() {
			const clawsStore = useClawsStore();
			await this.waitFetched(clawsStore);
			const bots = clawsStore.items;

			if (!bots.length) {
				this.go('/claws/add');
				return;
			}

			const onlineClaw = bots.find((b) => b.online);
			if (!onlineClaw) {
				this.go('/claws');
				return;
			}

			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents(onlineClaw.id);
			const defaultId = agentsStore.byClaw[onlineClaw.id]?.defaultId || 'main';
			this.go({
				name: 'chat',
				params: { clawId: String(onlineClaw.id), agentId: defaultId },
			});
		},
		/** 等待 SSE 快照到达（clawsStore.fetched = true） */
		waitFetched(clawsStore) {
			if (clawsStore.fetched) return Promise.resolve();
			return new Promise((resolve) => {
				this.__unwatchFetched = this.$watch(
					() => clawsStore.fetched,
					(val) => {
						if (val) {
							this.__unwatchFetched();
							this.__unwatchFetched = null;
							resolve();
						}
					},
					{ immediate: true },
				);
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
			this.go('/claws');
		},
	},
};
</script>
