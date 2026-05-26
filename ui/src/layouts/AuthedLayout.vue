<template>
	<div class="bg-default" :class="rootClasses">
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
import { ref, watch } from 'vue';
import DesktopSidebar from '../components/DesktopSidebar.vue';
import MobileBottomTabs from '../components/MobileBottomTabs.vue';
import { useClawStatusSse } from '../composables/use-claw-status-sse.js';
import { useSignalingConnection } from '../services/signaling-connection.js';
import { useRemoteLog } from '../services/remote-log.js';
import { usePullRefresh } from '../composables/use-pull-refresh.js';
import { useAuthStore, isLogoutInflight } from '../stores/auth.store.js';
import { useClawsStore } from '../stores/claws.store.js';
import { isCapacitorApp } from '../utils/platform.js';

export default {
	name: 'AuthedLayout',
	components: {
		DesktopSidebar,
		MobileBottomTabs,
	},
	setup() {
		const authStore = useAuthStore();
		const clawsStore = useClawsStore();
		const sigConn = useSignalingConnection();
		const sse = useClawStatusSse(clawsStore, { autoStart: false });
		useRemoteLog(); // 单例已在 main.js 早期初始化；此处保留以确保引用

		// 登录态驱动 WS + SSE 启停：
		// 未登录（含冷启动直达 /about、登出后留在 /about）保持零连接；
		// refreshSession 成功后 user 响应式变化触发首次 connect/start；
		// logout 使 user→null 触发 disconnect/stop。
		watch(
			() => authStore.user?.id ?? null,
			(userId) => {
				if (userId) {
					sigConn.connect();
					sse.start();
				} else {
					sigConn.disconnect();
					sse.stop();
				}
			},
			{ immediate: true },
		);

		const contentSection = ref(null);
		const { pulling, pullDistance, pastThreshold } = usePullRefresh(contentSection);

		return {
			authStore,
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
			// 顶部/底部安全区域：始终保留，不按断点清除。
			// index.html 声明了 viewport-fit=cover，浏览器会将内容延伸至安全区内，
			// 由页面自行通过 env(safe-area-inset-*) 让出空间。在无安全区的环境（桌面浏览器）
			// 下 CSS 变量值为 0，不产生多余间距；在有安全区的环境（Capacitor 原生壳、
			// 移动端浏览器、平板横屏）下正确避让状态栏/导航栏。
			cls.push('pt-[var(--safe-area-inset-top)]');
			// 底部安全区域：有底部导航时额外加 tab 高度（md 以上底部导航隐藏，只保留安全区）
			if (this.showMobileNav) {
				cls.push('pb-[calc(3.25rem+var(--safe-area-inset-bottom))] md:pb-[var(--safe-area-inset-bottom)]');
			} else {
				cls.push('pb-[var(--safe-area-inset-bottom)]');
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
			// 用户主动发起的 logout 如果 API 自身 401，http.js 会同步派发本事件。
			// 此时 logout 已在跑清理 + 将完成自己的跳转（如 /about），本分支跳过避免双重 router.replace
			if (isLogoutInflight()) {
				console.log('[AuthedLayout] session expired event ignored: logout already in flight');
				return;
			}
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
		// 仅监听 app:foreground（移动浏览器由 capacitor-app.js 桥接 visibility 覆盖）；
		// 桌面浏览器 tab 切换不再触发 session 验证——401 拦截器在下次 API 调用时会兜底清理
		this.__lastResumeAt = 0;
		this.__refreshSessionOnResume = async () => {
			// 节流：app:foreground 在 Capacitor 下可能多源派发，2s 节流作幂等保险
			const now = Date.now();
			if (now - this.__lastResumeAt < 2000) return;
			this.__lastResumeAt = now;
			if (!this.authStore.user) return;
			await this.authStore.refreshSession();
			// 若 session 已过期，401 拦截器派发 auth:session-expired → __onSessionExpired 执行完整清理 + 跳转
		};
		window.addEventListener('app:foreground', this.__refreshSessionOnResume);

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
