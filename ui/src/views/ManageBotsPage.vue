<template>
	<main class="flex-1 overflow-auto px-3 pt-4 pb-8 sm:px-4 lg:px-5">
		<section class="mx-auto flex w-full max-w-5xl flex-col gap-5">
			<div class="flex items-center justify-between gap-3">
				<h1 class="text-base font-medium">{{ $t('bots.pageTitle') }}</h1>
				<div class="flex items-center gap-2">
					<UButton data-testid="btn-refresh-bots" class="cc-icon-btn" color="primary" variant="ghost" size="md" icon="i-lucide-refresh-cw" :loading="loading" @click="loadData" />
					<UButton data-testid="btn-add-bot" color="primary" variant="soft" @click="$router.push('/bots/add')">
						{{ $t('bots.addBot') }}
					</UButton>
				</div>
			</div>

			<p v-if="!loading && !bots.length" class="text-sm text-muted">{{ $t('bots.noBot') }}</p>

			<div v-for="bot in bots" :key="bot.id" :data-testid="`bot-${bot.id}`" class="space-y-4">
				<InstanceOverview
					v-if="getDashboardData(bot.id)?.instance"
					:instance="getDashboardData(bot.id).instance"
					:agent-count="getDashboardData(bot.id).agents?.length ?? 0"
				/>
				<!-- 离线 / 数据未加载时的 fallback header -->
				<div v-else class="rounded-xl bg-elevated p-4 sm:p-5">
					<div class="flex items-center gap-2">
						<span class="inline-block size-2.5 rounded-full bg-gray-500"></span>
						<h2 class="text-lg font-semibold">{{ bot.name }}</h2>
						<UBadge color="neutral" variant="subtle" size="xs">{{ $t('dashboard.offline') }}</UBadge>
					</div>
				</div>

				<div class="flex justify-end">
					<UButton
						color="error"
						variant="soft"
						size="sm"
						:loading="unbindingId === bot.id"
						@click="onUnbindByUser(bot.id)"
					>
						{{ $t('bots.unbind') }}
					</UButton>
				</div>

				<div class="columns-1 gap-4 sm:columns-2 lg:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid">
					<AgentCard
						v-for="agent in getDashboardData(bot.id)?.agents ?? []"
						:key="agent.id"
						:agent="agent"
						:online="bot.online"
						@chat="goToAgent(bot.id, $event)"
					/>
				</div>

				<div v-if="getDashboardData(bot.id)?.loading" class="flex items-center justify-center py-8">
					<UButton loading variant="ghost" disabled>{{ $t('bots.preparing') }}</UButton>
				</div>
			</div>
		</section>
	</main>
</template>

<script>
import { useNotify } from '../composables/use-notify.js';
import { unbindBotByUser } from '../services/bots.api.js';
import { useBotsStore } from '../stores/bots.store.js';
import { useDashboardStore } from '../stores/dashboard.store.js';
import InstanceOverview from '../components/dashboard/InstanceOverview.vue';
import AgentCard from '../components/dashboard/AgentCard.vue';

export default {
	name: 'ManageBotsPage',
	components: { InstanceOverview, AgentCard },
	setup() {
		return { notify: useNotify() };
	},
	data() {
		return {
			loading: false,
			unbindingId: '',
			botsStore: null,
			dashboardStore: null,
		};
	},
	computed: {
		bots() {
			return this.botsStore?.items ?? [];
		},
	},
	async mounted() {
		this.botsStore = useBotsStore();
		this.dashboardStore = useDashboardStore();
		await this.loadData();
	},
	methods: {
		getDashboardData(botId) {
			return this.dashboardStore?.getDashboard(String(botId)) ?? null;
		},
		goToAgent(botId, agentId) {
			if (this.botsStore?.pluginVersionOk[String(botId)] === false) {
				this.notify.warning(this.$t('pluginUpgrade.outdated'));
			}
			this.$router.push({
				name: 'chat',
				params: { botId: String(botId), agentId },
			});
		},
		async loadData() {
			this.loading = true;
			try {
				await this.botsStore?.loadBots();
				// 并行加载所有 bot 的 dashboard
				await Promise.allSettled(
					this.bots.map(bot => this.dashboardStore.loadDashboard(String(bot.id)))
				);
			}
			catch (err) {
				this.notify.error(err?.response?.data?.message ?? err?.message ?? this.$t('bots.loadFailed'));
			}
			finally {
				this.loading = false;
			}
		},
		async onUnbindByUser(botId) {
			if (this.unbindingId) return;
			this.unbindingId = String(botId);
			try {
				await unbindBotByUser(botId);
				this.dashboardStore.clearDashboard(botId);
				await this.loadData();
				this.notify.success(this.$t('bots.unbindSuccess'));
			}
			catch (err) {
				this.notify.error(err?.response?.data?.message ?? err?.message ?? this.$t('bots.unbindFailed'));
			}
			finally {
				this.unbindingId = '';
			}
		},
	},
};
</script>
