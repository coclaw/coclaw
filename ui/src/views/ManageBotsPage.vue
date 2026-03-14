<template>
	<main class="flex-1 overflow-auto px-4 pt-4 pb-8 lg:px-5">
		<section class="mx-auto flex w-full max-w-3xl flex-col gap-4">
			<div class="flex items-center justify-between gap-3">
				<h1 class="text-base font-medium">{{ $t('layout.manageBots') }}</h1>
				<div class="flex items-center gap-2">
					<UButton data-testid="btn-refresh-bots" class="cc-icon-btn" color="primary" variant="ghost" size="md" icon="i-lucide-refresh-cw" :loading="loading" @click="loadBots" />
					<UButton data-testid="btn-add-bot" color="primary" variant="soft" @click="$router.push('/bots/add')">
						{{ $t('bots.addBot') }}
					</UButton>
				</div>
			</div>

			<p v-if="!loading && !bots.length" class="text-sm text-muted">{{ $t('bots.noBot') }}</p>

			<div
				v-for="bot in bots"
				:key="bot.id"
				:data-testid="'bot-' + bot.id"
				class="rounded-xl border border-default bg-muted p-4 space-y-3"
			>
				<div class="flex items-center justify-between gap-3">
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

				<!-- Agent 列表 -->
				<div v-if="getAgents(bot.id).length" class="space-y-1.5">
					<div
						v-for="agent in getAgents(bot.id)"
						:key="agent.id"
						class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm"
						:class="bot.online ? 'bg-default/50' : 'opacity-50'"
					>
						<span class="size-7 shrink-0 rounded-full bg-accented flex items-center justify-center overflow-hidden">
							<img
								v-if="agentDisplay(bot.id, agent.id).avatarUrl"
								:src="agentDisplay(bot.id, agent.id).avatarUrl"
								:alt="agentDisplay(bot.id, agent.id).name"
								class="size-full object-cover"
							/>
							<span v-else-if="agentDisplay(bot.id, agent.id).emoji" class="text-sm leading-none">{{ agentDisplay(bot.id, agent.id).emoji }}</span>
							<span v-else class="text-xs font-medium text-dimmed">{{ agentDisplay(bot.id, agent.id).name.charAt(0).toUpperCase() }}</span>
						</span>
						<span class="min-w-0 flex-1 truncate">{{ agentDisplay(bot.id, agent.id).name }}</span>
						<UButton
							variant="ghost"
							size="xs"
							:disabled="!bot.online"
							@click="goToAgent(bot.id, agent.id)"
						>
							{{ $t('agents.chat') }}
						</UButton>
					</div>
				</div>
			</div>

		</section>
	</main>
</template>

<script>
import { useNotify } from '../composables/use-notify.js';
import { unbindBotByUser } from '../services/bots.api.js';
import { useAgentsStore } from '../stores/agents.store.js';
import { useBotsStore } from '../stores/bots.store.js';
import { useSessionsStore } from '../stores/sessions.store.js';

export default {
	name: 'ManageBotsPage',
	setup() {
		return { notify: useNotify() };
	},
	data() {
		return {
			loading: false,
			unbindingId: '',
			agentsStore: null,
			botsStore: null,
			sessionsStore: null,
		};
	},
	computed: {
		bots() {
			return this.botsStore?.items ?? [];
		},
	},
	async mounted() {
		this.agentsStore = useAgentsStore();
		this.botsStore = useBotsStore();
		this.sessionsStore = useSessionsStore();
		await this.loadBots();
	},
	methods: {
		agentDisplay(botId, agentId) {
			return this.agentsStore?.getAgentDisplay?.(botId, agentId) ?? { name: agentId || 'Agent', avatarUrl: null, emoji: null };
		},
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
		getAgents(botId) {
			return this.agentsStore?.getAgentsByBot(botId) ?? [];
		},
		goToAgent(botId, agentId) {
			const mainSessionKey = `agent:${agentId}:main`;
			const sessions = this.sessionsStore?.items ?? [];
			const session = sessions.find(
				(s) => s.botId === botId && s.sessionKey === mainSessionKey,
			);
			if (session?.sessionId) {
				this.$router.push({ name: 'chat', params: { sessionId: session.sessionId } });
			}
		},
		async loadBots() {
			this.loading = true;
			try {
				await this.botsStore?.loadBots();
				await this.agentsStore?.loadAllAgents();
				await this.sessionsStore?.loadAllSessions();
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
