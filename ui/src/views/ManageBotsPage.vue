<template>
	<main class="flex-1 overflow-auto px-4 pt-4 pb-8 lg:px-5">
		<section class="mx-auto flex w-full max-w-3xl flex-col gap-4">
			<div class="flex items-center justify-between gap-3">
				<h1 class="text-base font-medium">{{ $t('layout.manageBots') }}</h1>
				<div class="flex items-center gap-2">
					<UButton class="cc-icon-btn" color="primary" variant="ghost" size="md" icon="i-lucide-refresh-cw" :loading="loading" @click="loadBots" />
					<UButton color="primary" variant="soft" @click="$router.push('/bots/add')">
						{{ $t('bots.addBot') }}
					</UButton>
				</div>
			</div>

			<p v-if="!loading && !bots.length" class="text-sm text-muted">{{ $t('bots.noBot') }}</p>

			<div
				v-for="bot in bots"
				:key="bot.id"
				class="flex items-center justify-between gap-3 rounded-xl border border-default --bg-elevated bg-muted p-4"
			>
				<div class="min-w-0 space-y-1 text-sm">
					<p class="flex items-center gap-2 truncate font-medium">
						<span class="truncate">{{ bot.name || 'OpenClaw' }}</span>
						<UBadge
							:color="bot.online ? 'success' : 'neutral'"
							variant="soft"
							size="sm"
						>
							{{ bot.online ? $t('bots.online') : $t('bots.offline') }}
						</UBadge>
					</p>
					<p class="text-xs text-dimmed">{{ $t('bots.updatedAt') }}{{ formatTime(bot.updatedAt) }}</p>
				</div>
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

		</section>
	</main>
</template>

<script>
import { useNotify } from '../composables/use-notify.js';
import { unbindBotByUser } from '../services/bots.api.js';
import { useBotsStore } from '../stores/bots.store.js';

export default {
	name: 'ManageBotsPage',
	setup() {
		return { notify: useNotify() };
	},
	data() {
		return {
			loading: false,
			unbindingId: '',
			botsStore: null,
		};
	},
	computed: {
		bots() {
			return this.botsStore?.items ?? [];
		},
	},
	async mounted() {
		this.botsStore = useBotsStore();
		await this.loadBots();
	},
	methods: {
		formatTime(value) {
			if (!value) {
				return '—';
			}
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) {
				return String(value);
			}
			return date.toLocaleString();
		},
		async loadBots() {
			this.loading = true;
			try {
				await this.botsStore?.loadBots();
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
			console.debug('[bots-manage] unbinding id=%s', botId);
			this.unbindingId = String(botId);
			try {
				await unbindBotByUser(botId);
				await this.loadBots();
				console.log('[bots-manage] unbind success id=%s', botId);
				this.notify.success(this.$t('bots.unbindSuccess'));
			}
			catch (err) {
				console.warn('[bots-manage] unbind failed id=%s:', botId, err?.message);
				this.notify.error(err?.response?.data?.message ?? err?.message ?? this.$t('bots.unbindFailed'));
			}
			finally {
				this.unbindingId = '';
			}
		},
	},
};
</script>
