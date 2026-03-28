<template>
	<div class="flex min-h-0 flex-1 flex-col">
		<MobilePageHeader :title="$t('adminDashboard.title')" />
		<main class="flex-1 overflow-auto px-3 pt-4 pb-8 sm:px-4 lg:px-5">
			<section class="mx-auto flex w-full max-w-3xl flex-col gap-5">
				<!-- 桌面端标题 -->
				<h1 class="hidden text-base font-medium md:flex">{{ $t('adminDashboard.title') }}</h1>

				<p v-if="loading" class="text-sm text-muted">{{ $t('chat.loading') }}</p>

				<template v-if="!loading && data">
					<!-- 顶部：实例维度三卡片 -->
					<div class="grid grid-cols-3 gap-3">
						<div class="rounded-xl bg-elevated p-4 text-center">
							<p class="text-2xl font-semibold">{{ data.bots.total }}</p>
							<p class="mt-1 text-xs text-dimmed">{{ $t('adminDashboard.totalBots') }}</p>
						</div>
						<div class="rounded-xl bg-elevated p-4 text-center">
							<p class="text-2xl font-semibold">{{ data.bots.todayNew }}</p>
							<p class="mt-1 text-xs text-dimmed">{{ $t('adminDashboard.todayNewBots') }}</p>
						</div>
						<div class="rounded-xl bg-elevated p-4 text-center">
							<p class="text-2xl font-semibold">{{ data.bots.online }}</p>
							<p class="mt-1 text-xs text-dimmed">{{ $t('adminDashboard.onlineBots') }}</p>
						</div>
					</div>

					<!-- 中部：实例情况表 -->
					<div class="rounded-xl bg-elevated p-4">
						<h2 class="mb-3 text-sm font-medium">{{ $t('adminDashboard.instanceList') }}</h2>
						<p v-if="!sortedBots.length" class="text-sm text-dimmed">{{ $t('adminDashboard.noData') }}</p>
						<ul v-else class="space-y-2">
							<li
								v-for="bot in sortedBots"
								:key="bot.id"
								class="text-sm"
							>
								<!-- 移动端：两行折叠 -->
								<div class="flex items-center justify-between">
									<span class="flex items-center gap-1.5">
										<span
											class="inline-block h-2 w-2 shrink-0 rounded-full"
											:class="bot.isOnline ? 'bg-green-500' : 'bg-gray-400'"
										/>
										<span>{{ bot.name || bot.id }}</span>
									</span>
									<span class="text-xs text-dimmed">{{ formatBindDuration(bot.createdAt) }}</span>
								</div>
								<div class="mt-0.5 flex items-center justify-between pl-3.5 text-xs text-dimmed">
									<span>{{ bot.userName || bot.userLoginName || bot.userId }}</span>
									<span>{{ formatTimeAgo(bot.lastSeenAt) }}</span>
								</div>
							</li>
						</ul>
					</div>

					<!-- 下部：用户情况表 -->
					<div class="rounded-xl bg-elevated p-4">
						<h2 class="mb-3 text-sm font-medium">{{ $t('adminDashboard.userList') }}</h2>
						<p v-if="!data.topActiveUsers?.length" class="text-sm text-dimmed">{{ $t('adminDashboard.noData') }}</p>
						<ul v-else class="space-y-2">
							<li
								v-for="(user, idx) in data.topActiveUsers"
								:key="user.id"
								class="flex items-center justify-between text-sm"
							>
								<span class="flex items-center gap-2">
									<span class="w-5 text-right text-dimmed">{{ idx + 1 }}.</span>
									<span>{{ user.name || user.loginName || user.id }}</span>
								</span>
								<span class="flex items-center gap-3 text-xs text-dimmed">
									<span class="font-medium" :class="user.onlineBotCount > 0 ? 'text-green-600 dark:text-green-400' : ''">{{ user.onlineBotCount }}/{{ user.botCount }}</span>
									<span class="w-16 text-right">{{ formatTimeAgo(user.lastLoginAt) }}</span>
								</span>
							</li>
						</ul>
					</div>

					<!-- 版本信息 -->
					<div class="rounded-xl bg-elevated p-4">
						<div class="flex items-center justify-between text-sm">
							<span class="text-dimmed">{{ $t('adminDashboard.serverVersion') }}</span>
							<span class="font-medium">v{{ data.version.server }}</span>
						</div>
						<div class="mt-2 flex items-center justify-between text-sm">
							<span class="text-dimmed">{{ $t('adminDashboard.uiVersion') }}</span>
							<span class="font-medium">v{{ uiVersion }}</span>
						</div>
						<div class="mt-2 flex items-center justify-between text-sm">
							<span class="text-dimmed">{{ $t('adminDashboard.pluginVersion') }}</span>
							<span class="font-medium">{{ data.version.plugin ? `v${data.version.plugin}` : '—' }}</span>
						</div>
					</div>
				</template>
			</section>
		</main>
	</div>
</template>

<script>
import { differenceInDays } from 'date-fns';

import { useNotify } from '../composables/use-notify.js';
import { fetchAdminDashboard } from '../services/admin.api.js';
import MobilePageHeader from '../components/MobilePageHeader.vue';

export default {
	name: 'AdminDashboardPage',
	components: { MobilePageHeader },
	setup() {
		return { notify: useNotify() };
	},
	data() {
		return {
			loading: false,
			data: null,
			uiVersion: __APP_VERSION__,
		};
	},
	computed: {
		sortedBots() {
			if (!this.data?.bots?.list) return [];
			return [...this.data.bots.list].sort((a, b) => {
				if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
				const aTime = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
				const bTime = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
				return bTime - aTime;
			});
		},
	},
	async mounted() {
		await this.loadData();
	},
	methods: {
		async loadData() {
			this.loading = true;
			try {
				this.data = await fetchAdminDashboard();
			}
			catch (err) {
				this.notify.error(err?.response?.data?.message ?? err?.message ?? 'Load failed');
			}
			finally {
				this.loading = false;
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
		formatBindDuration(iso) {
			if (!iso) return '—';
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return '—';
			const days = differenceInDays(new Date(), date);
			if (days < 1) return '< 1d';
			return `${days}d`;
		},
	},
};
</script>
