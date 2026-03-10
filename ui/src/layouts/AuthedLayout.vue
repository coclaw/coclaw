<template>
	<div class="bg-default text-highlighted" :class="rootClasses">
		<!-- 下拉刷新指示器 -->
		<div
			v-show="pulling"
			class="pointer-events-none fixed left-1/2 z-50 -translate-x-1/2 md:hidden"
			:style="pullIndicatorStyle"
		>
			<div class="flex size-8 items-center justify-center rounded-full bg-elevated shadow-md">
				<UIcon
					:name="pastThreshold ? 'i-lucide-refresh-cw' : 'i-lucide-arrow-down'"
					class="size-4 text-dimmed"
					:class="{ 'animate-spin': pastThreshold }"
				/>
			</div>
		</div>

		<div class="flex" :class="innerClasses">
			<DesktopSidebar
				:current-path="$route.path"
				:user="authStore.user"
				@logout="onLogout"
			/>

			<section
				ref="contentSection"
				class="flex min-w-0 flex-1 flex-col"
				:class="sectionClasses"
			>
				<router-view />
				<MobileBottomTabs v-if="showMobileNav" :current-path="$route.path" />
			</section>
		</div>
	</div>
</template>

<script>
import { ref } from 'vue';
import DesktopSidebar from '../components/DesktopSidebar.vue';
import MobileBottomTabs from '../components/MobileBottomTabs.vue';
import { useBotStatusPoll } from '../composables/use-bot-status-poll.js';
import { useBotStatusSse } from '../composables/use-bot-status-sse.js';
import { usePullRefresh } from '../composables/use-pull-refresh.js';
import { useAuthStore } from '../stores/auth.store.js';
import { useBotsStore } from '../stores/bots.store.js';
import { isNative } from '../utils/capacitor-app.js';

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

		const contentSection = ref(null);
		const { pulling, pullDistance, pastThreshold } = usePullRefresh(contentSection);

		return {
			authStore: useAuthStore(),
			contentSection,
			pulling,
			pullDistance,
			pastThreshold,
		};
	},
	computed: {
		showMobileNav() {
			return !this.$route.meta.hideMobileNav;
		},
		isTopPage() {
			return !!this.$route.meta.isTopPage;
		},
		rootClasses() {
			// 原生壳：固定视口高度，禁止外层滚动；Web：浏览器滚动
			return isNative ? 'h-dvh overflow-hidden' : 'min-h-screen';
		},
		innerClasses() {
			return isNative ? 'h-full' : 'min-h-screen';
		},
		sectionClasses() {
			const cls = [];
			// 原生壳下 section 需 min-h-0 以允许 flex 子项内部滚动
			if (isNative) cls.push('min-h-0');
			if (!isNative) cls.push('min-h-screen');
			// 顶级页面无 MobilePageHeader，需要为状态栏留出安全距离
			if (this.isTopPage) cls.push('pt-[env(safe-area-inset-top)] md:pt-0');
			// 底部导航可见时为其留出空间
			if (this.showMobileNav) cls.push('pb-[calc(3.25rem+env(safe-area-inset-bottom))] md:pb-0');
			return cls.join(' ');
		},
		pullIndicatorStyle() {
			return {
				top: `calc(env(safe-area-inset-top, 0px) + ${this.pullDistance - 8}px)`,
				opacity: Math.min(this.pullDistance / 60, 1),
				transition: this.pulling ? 'none' : 'all 0.2s ease-out',
			};
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
