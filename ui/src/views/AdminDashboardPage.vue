<template>
	<div class="flex min-h-0 flex-1 flex-col">
		<MobilePageHeader :title="$t('adminDashboard.title')" />
		<main class="flex-1 overflow-auto px-3 pt-4 pb-8 sm:px-4 lg:px-5">
			<section class="mx-auto flex w-full max-w-3xl flex-col gap-5">
				<!-- 桌面端标题 -->
				<h1 class="hidden text-base font-medium md:flex">{{ $t('adminDashboard.title') }}</h1>

				<p v-if="loading" class="text-sm text-muted">{{ $t('chat.loading') }}</p>

				<template v-if="!loading && data">
					<!-- 用户统计卡片 -->
					<div class="grid grid-cols-3 gap-3">
						<div class="rounded-xl bg-elevated p-4 text-center">
							<p class="text-2xl font-semibold">{{ data.users.total }}</p>
							<p class="mt-1 text-xs text-dimmed">{{ $t('adminDashboard.totalUsers') }}</p>
						</div>
						<div class="rounded-xl bg-elevated p-4 text-center">
							<p class="text-2xl font-semibold">{{ data.users.todayNew }}</p>
							<p class="mt-1 text-xs text-dimmed">{{ $t('adminDashboard.todayNew') }}</p>
						</div>
						<div class="rounded-xl bg-elevated p-4 text-center">
							<p class="text-2xl font-semibold">{{ data.users.todayActive }}</p>
							<p class="mt-1 text-xs text-dimmed">{{ $t('adminDashboard.todayActive') }}</p>
						</div>
					</div>

					<!-- Claw 统计 + 版本 -->
					<div class="rounded-xl bg-elevated p-4">
						<div class="flex items-center justify-between text-sm">
							<span class="text-dimmed">{{ $t('adminDashboard.totalBots') }}</span>
							<span class="font-medium">{{ data.bots.total }}</span>
						</div>
						<div class="mt-2 flex items-center justify-between text-sm">
							<span class="text-dimmed">{{ $t('adminDashboard.serverVersion') }}</span>
							<span class="font-medium">v{{ data.version.server }}</span>
						</div>
					</div>

					<!-- 最近活跃用户 -->
					<div class="rounded-xl bg-elevated p-4">
						<h2 class="mb-3 text-sm font-medium">{{ $t('adminDashboard.topActiveUsers') }}</h2>
						<p v-if="!data.topActiveUsers?.length" class="text-sm text-dimmed">{{ $t('adminDashboard.noData') }}</p>
						<ul v-else class="space-y-2">
							<li
								v-for="(user, idx) in data.topActiveUsers"
								:key="user.id"
								class="flex items-center justify-between text-sm"
							>
								<span>
									<span class="mr-2 text-dimmed">{{ idx + 1 }}.</span>
									<span>{{ user.name }}</span>
								</span>
								<span class="text-xs text-dimmed">{{ formatTimeAgo(user.lastLoginAt) }}</span>
							</li>
						</ul>
					</div>
				</template>
			</section>
		</main>
	</div>
</template>

<script>
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
		};
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
	},
};
</script>
