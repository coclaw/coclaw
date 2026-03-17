<template>
	<div class="flex min-h-0 flex-1 flex-col">
		<MobilePageHeader :title="$t('pluginUpgrade.title')" />
		<main class="flex-1 overflow-auto px-4 pt-4 pb-8 lg:px-5">
			<section class="mx-auto flex w-full max-w-3xl flex-col gap-4">
				<!-- 桌面端标题 -->
				<div class="hidden items-center justify-between md:flex">
					<h1 class="text-base font-medium">{{ $t('pluginUpgrade.title') }}</h1>
				</div>

				<p class="text-sm text-dimmed">{{ $t('pluginUpgrade.desc') }}</p>

				<!-- 方式一：通过对话 -->
				<div>
					<h2 class="text-base font-medium">{{ $t('pluginUpgrade.chatMethodTitle') }}</h2>
					<p class="mt-1 text-sm text-dimmed">{{ $t('pluginUpgrade.chatMethodDesc') }}</p>
					<div class="mt-2 rounded-lg bg-elevated overflow-hidden">
						<pre class="whitespace-pre-wrap px-3 py-2 text-sm text-default">{{ chatPromptText }}</pre>
						<div class="flex items-center justify-end px-3 py-1.5">
							<UButton
								v-if="copiedKey !== 'chat'"
								variant="ghost"
								color="primary"
								size="md"
								@click="copyToClipboard('chat', chatPromptText)"
							>{{ $t('bots.copy') }}</UButton>
							<span v-else class="flex items-center gap-1 text-sm text-success">
								<UIcon name="i-lucide-check" class="size-4" />
								{{ $t('bots.commandCopied') }}
							</span>
						</div>
					</div>
				</div>

				<!-- 方式二：通过终端 -->
				<div>
					<h2 class="text-base font-medium">{{ $t('pluginUpgrade.shellMethodTitle') }}</h2>
					<p class="mt-1 text-sm text-dimmed">{{ $t('pluginUpgrade.shellMethodDesc') }}</p>
					<div class="mt-2 rounded-lg bg-elevated overflow-hidden">
						<pre class="whitespace-pre-wrap px-3 py-2 text-sm text-default">{{ upgradeCommand }}</pre>
						<div class="flex items-center justify-end px-3 py-1.5">
							<UButton
								v-if="copiedKey !== 'shell'"
								variant="ghost"
								color="primary"
								size="md"
								@click="copyToClipboard('shell', upgradeCommand)"
							>{{ $t('bots.copy') }}</UButton>
							<span v-else class="flex items-center gap-1 text-sm text-success">
								<UIcon name="i-lucide-check" class="size-4" />
								{{ $t('bots.commandCopied') }}
							</span>
						</div>
					</div>
				</div>

				<!-- 重试 -->
				<div class="flex justify-center pt-2">
					<UButton color="primary" :loading="checking" @click="onRetry">
						{{ $t('pluginUpgrade.retry') }}
					</UButton>
				</div>
			</section>
		</main>
	</div>
</template>

<script>
import MobilePageHeader from '../components/MobilePageHeader.vue';
import { useNotify } from '../composables/use-notify.js';
import { useBotsStore } from '../stores/bots.store.js';
import { useBotConnections } from '../services/bot-connection-manager.js';
import { checkPluginVersion, MIN_PLUGIN_VERSION } from '../utils/plugin-version.js';

const UPGRADE_COMMAND = 'openclaw plugins update openclaw-coclaw';

export default {
	name: 'PluginUpgradePage',
	components: { MobilePageHeader },
	setup() {
		return { notify: useNotify() };
	},
	data() {
		return {
			checking: false,
			copiedKey: '',
			copiedTimer: null,
		};
	},
	computed: {
		upgradeCommand() {
			return UPGRADE_COMMAND;
		},
		chatPromptText() {
			return this.$t('pluginUpgrade.chatPrompt', { command: UPGRADE_COMMAND });
		},
	},
	beforeUnmount() {
		clearTimeout(this.copiedTimer);
	},
	methods: {
		async copyToClipboard(key, text) {
			try {
				await navigator.clipboard.writeText(text);
				clearTimeout(this.copiedTimer);
				this.copiedKey = key;
				this.copiedTimer = setTimeout(() => { this.copiedKey = ''; }, 3000);
			}
			catch {
				this.notify.error(this.$t('common.copyFailed'));
			}
		},
		async onRetry() {
			this.checking = true;
			try {
				const botsStore = useBotsStore();
				const manager = useBotConnections();
				// 检查所有已连接 bot 的插件版本
				let allOk = true;
				for (const bot of botsStore.items) {
					const conn = manager.get(String(bot.id));
					if (!conn || conn.state !== 'connected') continue;
					const ok = await checkPluginVersion(conn);
					if (!ok) {
						allOk = false;
						break;
					}
				}
				if (allOk) {
					this.notify.success(this.$t('pluginUpgrade.versionOk'));
					const redirect = this.$route.query?.redirect || '/';
					this.$router.replace(redirect);
				}
				else {
					this.notify.warning(this.$t('pluginUpgrade.stillOutdated', { version: MIN_PLUGIN_VERSION }));
				}
			}
			catch (err) {
				this.notify.error(err?.message || this.$t('pluginUpgrade.checkFailed'));
			}
			finally {
				this.checking = false;
			}
		},
	},
};
</script>
