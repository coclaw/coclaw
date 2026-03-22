<template>
	<main class="flex-1 overflow-auto px-3 pt-4 pb-8 sm:px-4 lg:px-5">
		<section class="mx-auto flex w-full max-w-3xl flex-col gap-4">
			<div class="flex items-center justify-between gap-3">
				<h1 class="text-base font-medium">{{ $t('bots.pageTitle') }}</h1>
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
				class="rounded-xl border border-default bg-muted px-3 py-3 sm:px-4 sm:py-3.5"
			>
				<div class="flex items-center justify-between gap-3">
					<div class="min-w-0 space-y-0.5 text-sm">
						<!-- 行内编辑名称 -->
						<div v-if="editingBotId === bot.id" class="flex items-center gap-2">
							<UInput
								v-model="editingName"
								:placeholder="$t('bots.renamePlaceholder')"
								size="sm"
								class="w-40 sm:w-56"
								maxlength="128"
								autofocus
								@keydown.enter="onSaveRename(bot.id)"
								@keydown.esc="cancelRename"
							/>
							<UButton size="xs" color="primary" variant="soft" :loading="renamingId === bot.id" @click="onSaveRename(bot.id)">
								{{ $t('common.save') }}
							</UButton>
							<UButton size="xs" color="neutral" variant="ghost" @click="cancelRename">
								{{ $t('common.cancel') }}
							</UButton>
						</div>
						<p v-else class="flex items-center gap-2 truncate font-medium">
							<span
								class="truncate cursor-pointer hover:underline"
								:title="$t('bots.rename')"
								@click="startRename(bot.id, bot.name)"
							>{{ bot.name || 'OpenClaw' }}</span>
							<UBadge
								:color="bot.online ? 'success' : 'neutral'"
								variant="soft"
								size="sm"
							>
								{{ bot.online ? $t('bots.online') : $t('bots.offline') }}
							</UBadge>
						</p>
						<p v-if="false" class="text-xs text-dimmed">{{ $t('bots.updatedAt') }}{{ formatTime(bot.updatedAt) }}</p>
						<p v-if="getPluginInfo(bot.id)" class="text-xs text-dimmed">
							<span v-if="getPluginInfo(bot.id).version">{{ $t('bots.pluginVersion') }}{{ getPluginInfo(bot.id).version }}</span>
							<span v-if="getPluginInfo(bot.id).clawVersion" class="ml-2">{{ $t('bots.clawVersion') }}{{ getPluginInfo(bot.id).clawVersion }}</span>
						</p>
					</div>
					<UButton
						class="shrink-0"
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
				<div v-if="getAgents(bot.id).length" class="mt-2.5 space-y-0.5">
					<div
						v-for="agent in getAgents(bot.id)"
						:key="agent.id"
						class="flex items-center gap-2.5 py-1.5 text-sm"
						:class="bot.online ? '' : 'opacity-50'"
					>
						<span class="size-6 shrink-0 rounded-full bg-accented flex items-center justify-center overflow-hidden">
							<img
								v-if="agentDisplay(bot.id, agent.id).avatarUrl"
								:src="agentDisplay(bot.id, agent.id).avatarUrl"
								:alt="agentDisplay(bot.id, agent.id).name"
								class="size-full object-cover"
							/>
							<span v-else-if="agentDisplay(bot.id, agent.id).emoji" class="text-xs leading-none">{{ agentDisplay(bot.id, agent.id).emoji }}</span>
							<span v-else class="text-[10px] font-medium text-dimmed">{{ agentDisplay(bot.id, agent.id).name.charAt(0).toUpperCase() }}</span>
						</span>
						<span class="min-w-0 flex-1 truncate">{{ agentDisplay(bot.id, agent.id).name }}</span>
						<UButton
							class="shrink-0"
							variant="soft"
							size="sm"
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

export default {
	name: 'ManageBotsPage',
	setup() {
		return { notify: useNotify() };
	},
	data() {
		return {
			loading: false,
			unbindingId: '',
			renamingId: '',
			editingBotId: '',
			editingName: '',
			agentsStore: null,
			botsStore: null,
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
		await this.loadBots();
	},
	methods: {
		// TODO: agentDisplay() 在模板中对同一 agent 被调用多次，应预计算或 memoize 以优化渲染性能
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
		getPluginInfo(botId) {
			return this.botsStore?.pluginInfo?.[String(botId)] ?? null;
		},
		getAgents(botId) {
			return this.agentsStore?.getAgentsByBot(botId) ?? [];
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
		async loadBots() {
			this.loading = true;
			try {
				await this.botsStore?.loadBots();
				await this.agentsStore?.loadAllAgents();
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
		startRename(botId, currentName) {
			this.editingBotId = String(botId);
			this.editingName = currentName || '';
		},
		cancelRename() {
			this.editingBotId = '';
			this.editingName = '';
		},
		async onSaveRename(botId) {
			if (this.renamingId) return;
			this.renamingId = String(botId);
			try {
				await this.botsStore.renameBot(botId, this.editingName);
				this.notify.success(this.$t('bots.renamed'));
				this.cancelRename();
			}
			catch (err) {
				console.warn('[bots-manage] rename failed id=%s:', botId, err?.message);
				this.notify.error(err?.response?.data?.message ?? err?.message ?? this.$t('bots.renameFailed'));
			}
			finally {
				this.renamingId = '';
			}
		},
	},
};
</script>
