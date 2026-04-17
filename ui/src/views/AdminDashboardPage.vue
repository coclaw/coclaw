<template>
	<div class="flex min-h-0 flex-1 flex-col">
		<MobilePageHeader :title="$t('admin.dashboard.title')">
			<template #actions>
				<UButton
					class="cc-icon-btn-lg"
					variant="ghost"
					color="neutral"
					icon="i-lucide-server"
					:aria-label="$t('admin.nav.claws')"
					to="/admin/claws"
				/>
				<UButton
					class="cc-icon-btn-lg"
					variant="ghost"
					color="neutral"
					icon="i-lucide-users"
					:aria-label="$t('admin.nav.users')"
					to="/admin/users"
				/>
			</template>
		</MobilePageHeader>
		<main class="flex-1 overflow-auto px-3 pt-4 pb-8 sm:px-4 lg:px-5">
			<section class="mx-auto flex w-full max-w-3xl flex-col gap-5">
				<!-- 桌面端标题 + 导航 -->
				<header class="hidden items-center justify-between md:flex">
					<h1 class="text-base font-medium">{{ $t('admin.dashboard.title') }}</h1>
					<AdminNavTabs />
				</header>

				<p v-if="adminStore.dashboardLoading && !adminStore.dashboard" class="text-sm text-muted">{{ $t('chat.loading') }}</p>

				<template v-if="adminStore.dashboard">
					<!-- Primary: 实例维度三卡片 -->
					<div class="grid grid-cols-3 gap-3">
						<div class="rounded-xl bg-elevated p-3 text-center">
							<p class="text-2xl font-semibold">{{ adminStore.dashboard.claws.total }}</p>
							<p class="mt-1 text-xs text-dimmed">{{ $t('admin.dashboard.totalClaws') }}</p>
						</div>
						<div class="rounded-xl bg-elevated p-3 text-center">
							<p class="text-2xl font-semibold">{{ adminStore.hasOnlineSnapshot ? adminStore.onlineClawCount : '—' }}</p>
							<p class="mt-1 text-xs text-dimmed">{{ $t('admin.dashboard.onlineClaws') }}</p>
						</div>
						<div class="rounded-xl bg-elevated p-3 text-center">
							<p class="text-2xl font-semibold">{{ adminStore.dashboard.claws.todayNew }}</p>
							<p class="mt-1 text-xs text-dimmed">{{ $t('admin.dashboard.todayNewClaws') }}</p>
						</div>
					</div>

					<!-- Secondary: 用户维度三卡片 -->
					<div class="grid grid-cols-3 gap-3">
						<div class="rounded-lg bg-elevated p-3 text-center">
							<p class="text-lg font-medium">{{ adminStore.dashboard.users.total }}</p>
							<p class="mt-0.5 text-[11px] text-dimmed">{{ $t('admin.dashboard.totalUsers') }}</p>
						</div>
						<div class="rounded-lg bg-elevated p-3 text-center">
							<p class="text-lg font-medium">{{ adminStore.dashboard.users.todayNew }}</p>
							<p class="mt-0.5 text-[11px] text-dimmed">{{ $t('admin.dashboard.todayNewUsers') }}</p>
						</div>
						<div class="rounded-lg bg-elevated p-3 text-center">
							<p class="text-lg font-medium">{{ adminStore.dashboard.users.todayActive }}</p>
							<p class="mt-0.5 text-[11px] text-dimmed">{{ $t('admin.dashboard.todayActiveUsers') }}</p>
						</div>
					</div>

					<!-- 版本 -->
					<div class="rounded-xl bg-elevated p-3">
						<div class="flex items-center justify-between text-sm">
							<span class="text-dimmed">{{ $t('admin.dashboard.serverVersion') }}</span>
							<span class="font-medium">v{{ adminStore.dashboard.version.server }}</span>
						</div>
						<div class="mt-2 flex items-center justify-between text-sm">
							<span class="text-dimmed">{{ $t('admin.dashboard.uiVersion') }}</span>
							<span class="font-medium">v{{ uiVersion }}</span>
						</div>
						<div class="mt-2 flex items-center justify-between text-sm">
							<span class="text-dimmed">{{ $t('admin.dashboard.pluginVersion') }}</span>
							<span class="font-medium">v{{ adminStore.dashboard.version.plugin ?? '—' }}</span>
						</div>
					</div>

					<!-- 摘要：最近绑定实例 -->
					<div class="rounded-xl bg-elevated p-3">
						<div class="mb-3 flex items-center justify-between">
							<h2 class="text-sm font-medium">{{ $t('admin.dashboard.sectionLatestClaws') }}</h2>
							<RouterLink to="/admin/claws" class="text-xs text-primary hover:underline">{{ $t('admin.common.viewAll') }}</RouterLink>
						</div>
						<p v-if="!adminStore.dashboard.latestBoundClaws?.length" class="text-sm text-dimmed">{{ $t('admin.common.noData') }}</p>
						<ul v-else class="space-y-2">
							<li
								v-for="(claw, idx) in adminStore.dashboard.latestBoundClaws"
								:key="claw.id"
								class="flex items-center justify-between text-sm"
							>
								<span class="flex min-w-0 items-center gap-2">
									<span class="shrink-0 text-dimmed">{{ idx + 1 }}.</span>
									<span
										:class="[
											'inline-block h-2 w-2 shrink-0 rounded-full',
											adminStore.isClawOnline(claw.id) ? 'bg-green-500' : 'bg-neutral-400',
										]"
										:aria-label="adminStore.isClawOnline(claw.id) ? $t('admin.common.online') : $t('admin.common.offline')"
									></span>
									<span class="truncate">{{ claw.name || claw.id }}</span>
									<span v-if="claw.userName" class="truncate text-xs text-dimmed">· {{ claw.userName }}</span>
								</span>
								<span class="shrink-0 pl-2 text-xs text-dimmed">{{ formatTimeAgo(claw.createdAt) }}</span>
							</li>
						</ul>
					</div>

					<!-- 摘要：最近活跃用户 -->
					<div class="rounded-xl bg-elevated p-3">
						<div class="mb-3 flex items-center justify-between">
							<h2 class="text-sm font-medium">{{ $t('admin.dashboard.sectionTopActiveUsers') }}</h2>
							<RouterLink to="/admin/users" class="text-xs text-primary hover:underline">{{ $t('admin.common.viewAll') }}</RouterLink>
						</div>
						<p v-if="!adminStore.dashboard.topActiveUsers?.length" class="text-sm text-dimmed">{{ $t('admin.common.noData') }}</p>
						<ul v-else class="space-y-2">
							<li
								v-for="(user, idx) in adminStore.dashboard.topActiveUsers"
								:key="user.id"
								class="flex items-center justify-between text-sm"
							>
								<span class="flex min-w-0 items-center gap-2">
									<span class="shrink-0 text-dimmed">{{ idx + 1 }}.</span>
									<span class="truncate">{{ user.name || user.loginName || user.id }}</span>
								</span>
								<span class="shrink-0 pl-2 text-xs text-dimmed">{{ formatTimeAgo(user.lastLoginAt) }}</span>
							</li>
						</ul>
					</div>

					<!-- 摘要：最新注册用户 -->
					<div class="rounded-xl bg-elevated p-3">
						<div class="mb-3 flex items-center justify-between">
							<h2 class="text-sm font-medium">{{ $t('admin.dashboard.sectionLatestRegisteredUsers') }}</h2>
							<RouterLink to="/admin/users" class="text-xs text-primary hover:underline">{{ $t('admin.common.viewAll') }}</RouterLink>
						</div>
						<p v-if="!adminStore.dashboard.latestRegisteredUsers?.length" class="text-sm text-dimmed">{{ $t('admin.common.noData') }}</p>
						<ul v-else class="space-y-2">
							<li
								v-for="(user, idx) in adminStore.dashboard.latestRegisteredUsers"
								:key="user.id"
								class="flex items-center justify-between text-sm"
							>
								<span class="flex min-w-0 items-center gap-2">
									<span class="shrink-0 text-dimmed">{{ idx + 1 }}.</span>
									<span class="truncate">{{ user.name || user.loginName || user.id }}</span>
								</span>
								<span class="shrink-0 pl-2 text-xs text-dimmed">{{ formatTimeAgo(user.createdAt) }}</span>
							</li>
						</ul>
					</div>
				</template>
			</section>
		</main>
	</div>
</template>

<script>
import { RouterLink } from 'vue-router';

import { useNotify } from '../composables/use-notify.js';
import { useAdminStore } from '../stores/admin.store.js';
import MobilePageHeader from '../components/MobilePageHeader.vue';
import AdminNavTabs from '../components/AdminNavTabs.vue';

export default {
	name: 'AdminDashboardPage',
	components: { MobilePageHeader, AdminNavTabs, RouterLink },
	setup() {
		return { notify: useNotify(), adminStore: useAdminStore() };
	},
	data() {
		return {
			uiVersion: __APP_VERSION__,
		};
	},
	async mounted() {
		this.__lastResumeAt = 0;
		this.__onResume = () => {
			const now = Date.now();
			if (now - this.__lastResumeAt < 2000) return;
			this.__lastResumeAt = now;
			this.loadData();
		};
		this.__onVisibility = () => {
			if (document.visibilityState === 'visible') this.__onResume();
		};
		window.addEventListener('app:foreground', this.__onResume);
		document.addEventListener('visibilitychange', this.__onVisibility);

		await this.loadData();
	},
	beforeUnmount() {
		if (this.__onResume) {
			window.removeEventListener('app:foreground', this.__onResume);
		}
		if (this.__onVisibility) {
			document.removeEventListener('visibilitychange', this.__onVisibility);
		}
	},
	methods: {
		async loadData() {
			try {
				await this.adminStore.fetchDashboard();
			}
			catch (err) {
				console.warn('[AdminDashboardPage] loadData failed:', err);
				this.notify.error(err?.response?.data?.message ?? err?.message ?? 'Load failed');
			}
		},
		formatTimeAgo(iso) {
			if (!iso) return '—';
			const diff = (Date.now() - new Date(iso).getTime()) / 1000;
			if (diff < 0 || Number.isNaN(diff)) return '—';
			if (diff < 60) return this.$t('dashboard.justNow');
			if (diff < 3600) return this.$t('dashboard.minutesAgo', { n: Math.floor(diff / 60) });
			if (diff < 86400) return this.$t('dashboard.hoursAgo', { n: Math.floor(diff / 3600) });
			return this.$t('dashboard.daysAgo', { n: Math.floor(diff / 86400) });
		},
	},
};
</script>
