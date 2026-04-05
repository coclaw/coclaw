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
import { useClawStatusSse } from '../composables/use-claw-status-sse.js';
import { useSignalingConnection } from '../services/signaling-connection.js';
import { useRemoteLog } from '../services/remote-log.js';
import { usePullRefresh } from '../composables/use-pull-refresh.js';
import { useAuthStore } from '../stores/auth.store.js';
import { useClawsStore } from '../stores/claws.store.js';
import { isCapacitorApp } from '../utils/platform.js';

export default {
	name: 'AuthedLayout',
	components: {
		DesktopSidebar,
		MobileBottomTabs,
	},
	setup() {
		const clawsStore = useClawsStore();
		useClawStatusSse(clawsStore);
		useSignalingConnection().connect();
		useRemoteLog();

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
			return isCapacitorApp ? 'h-dvh-safe overflow-hidden' : 'min-h-screen';
		},
		innerClasses() {
			return isCapacitorApp ? 'h-full' : 'min-h-screen';
		},
		sectionClasses() {
			const cls = [];
			// 原生壳下 section 需 min-h-0 以允许 flex 子项内部滚动
			if (isCapacitorApp) cls.push('min-h-0');
			if (!isCapacitorApp) cls.push('min-h-screen');
			// 顶部安全区域（状态栏），始终生效
			cls.push('pt-[var(--safe-area-inset-top)] md:pt-0');
			// 底部安全区域：有底部导航时额外加 tab 高度
			if (this.showMobileNav) {
				cls.push('pb-[calc(3.25rem+var(--safe-area-inset-bottom))] md:pb-0');
			} else {
				cls.push('pb-[var(--safe-area-inset-bottom)] md:pb-0');
			}
			return cls.join(' ');
		},
		pullIndicatorStyle() {
			return {
				top: `calc(var(--safe-area-inset-top) + ${this.pullDistance - 8}px)`,
				opacity: Math.min(this.pullDistance / 60, 1),
				transition: this.pulling ? 'none' : 'all 0.2s ease-out',
			};
		},
	},
	async mounted() {
		// 认证过期统一监听（来源：HTTP 401 拦截）
		// 必须在 refreshSession() 之前注册，避免 await 期间事件丢失
		this.__onSessionExpired = async () => {
			if (!this.authStore.user) return; // 未登录或已在登出流程中
			console.warn('[AuthedLayout] session expired → full cleanup + redirect to login');
			const redirect = this.$route.fullPath;
			try {
				await this.authStore.logout(); // 完整清理：disconnectAll、store reset、draft persist
			} catch (err) {
				// logout 内部已处理 401；兜底防止意外错误阻断跳转
				console.warn('[AuthedLayout] logout cleanup failed:', err?.message);
				this.authStore.user = null;
			}
			this.$router.replace({
				path: '/login',
				query: redirect !== '/' ? { redirect } : {},
			}).catch(() => {}); // 导航可能被其他跳转取消，静默处理
		};
		window.addEventListener('auth:session-expired', this.__onSessionExpired);

		// 前台恢复刷新 session（覆盖"停留在页面不导航"的过期场景）
		this.__lastResumeAt = 0;
		this.__refreshSessionOnResume = async () => {
			// 节流：2s 内不重复执行（visibilitychange + app:foreground 可能同时触发）
			const now = Date.now();
			if (now - this.__lastResumeAt < 2000) return;
			this.__lastResumeAt = now;
			if (!this.authStore.user) return;
			await this.authStore.refreshSession();
			// 若 session 已过期，401 拦截器派发 auth:session-expired → __onSessionExpired 执行完整清理 + 跳转
		};
		this.__onVisibilityChange = () => {
			if (document.visibilityState === 'visible') {
				this.__refreshSessionOnResume();
			}
		};
		window.addEventListener('app:foreground', this.__refreshSessionOnResume);
		document.addEventListener('visibilitychange', this.__onVisibilityChange);

		// 为非 requiresAuth 路由（如 AboutPage）填充用户数据
		await this.authStore.refreshSession();
	},
	beforeUnmount() {
		if (this.__onSessionExpired) {
			window.removeEventListener('auth:session-expired', this.__onSessionExpired);
		}
		if (this.__refreshSessionOnResume) {
			window.removeEventListener('app:foreground', this.__refreshSessionOnResume);
		}
		if (this.__onVisibilityChange) {
			document.removeEventListener('visibilitychange', this.__onVisibilityChange);
		}
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
