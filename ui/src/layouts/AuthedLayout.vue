<template>
	<div class="min-h-screen bg-default text-highlighted">
		<div class="flex min-h-screen">
			<DesktopSidebar
				:current-path="$route.path"
				:user="authStore.user"
				@logout="onLogout"
			/>

			<section
				class="flex min-h-screen min-w-0 flex-1 flex-col"
				:class="showMobileNav ? 'pb-13 md:pb-0' : ''"
			>
				<router-view />
				<MobileBottomTabs v-if="showMobileNav" :current-path="$route.path" />
			</section>
		</div>
	</div>
</template>

<script>
import DesktopSidebar from '../components/DesktopSidebar.vue';
import MobileBottomTabs from '../components/MobileBottomTabs.vue';
import { useBotStatusPoll } from '../composables/use-bot-status-poll.js';
import { useBotStatusSse } from '../composables/use-bot-status-sse.js';
import { useAuthStore } from '../stores/auth.store.js';
import { useBotsStore } from '../stores/bots.store.js';

export default {
	name: 'AuthedLayout',
	components: {
		DesktopSidebar,
		MobileBottomTabs,
	},
	setup() {
		const botsStore = useBotsStore();
		const { connected: sseConnected } = useBotStatusSse(botsStore);
		useBotStatusPoll(botsStore, { sseConnected });
		return {
			authStore: useAuthStore(),
		};
	},
	computed: {
		showMobileNav() {
			return !this.$route.meta.hideMobileNav;
		},
	},
	async mounted() {
		// 为非 requiresAuth 路由（如 AboutPage）填充用户数据
		await this.authStore.refreshSession();
	},
	methods: {
		async onLogout() {
			await this.authStore.logout();
			if (this.$route.path !== '/about') {
				this.$router.replace('/about');
			}
		},
	},
};
</script>
