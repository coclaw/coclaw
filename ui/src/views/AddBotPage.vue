<template>
	<div class="flex min-h-0 flex-1 flex-col">
		<MobilePageHeader :title="$t('bots.addBot')">
			<template v-if="expired" #actions>
				<UButton size="md" variant="ghost" color="primary" :loading="loading" @click="startBinding">
					{{ $t('bots.restart') }}
				</UButton>
			</template>
		</MobilePageHeader>
	<main class="flex-1 overflow-auto px-4 pt-4 pb-8 lg:px-5">
		<section class="mx-auto flex w-full max-w-3xl flex-col gap-4">
			<!-- 桌面端标题 + 倒计时/重新开始 -->
			<div class="hidden items-center justify-between md:flex">
				<h1 class="text-base font-medium">{{ $t('bots.addBot') }}</h1>
				<UButton v-if="expired" size="md" color="primary" :loading="loading" @click="startBinding">
					{{ $t('bots.restart') }}
				</UButton>
				<span v-else-if="bindingCode" class="text-sm text-muted">{{ expiryText }}</span>
			</div>

			<!-- 加载中 -->
			<div v-if="loading && !bindingCode" class="flex flex-col items-center gap-3 py-12">
				<UIcon name="i-lucide-loader-2" class="size-8 animate-spin text-muted" />
				<p class="text-sm text-muted">{{ $t('bots.preparing') }}</p>
			</div>

			<!-- 加载失败 -->
			<div v-else-if="loadError" class="flex flex-col items-center gap-3 py-12">
				<p class="text-sm text-danger">{{ loadError }}</p>
				<UButton size="md" color="primary" @click="startBinding">{{ $t('bots.retry') }}</UButton>
			</div>

			<!-- 过期 -->
			<div v-else-if="expired" class="flex flex-col items-center gap-3 py-12">
				<p class="text-sm text-muted">{{ $t('bots.expired') }}</p>
				<UButton size="md" color="primary" :loading="loading" @click="startBinding" class="md:hidden">
					{{ $t('bots.restart') }}
				</UButton>
			</div>

			<!-- 内容 -->
			<template v-else-if="bindingCode">
				<!-- 移动端倒计时 -->
				<div class="flex items-center md:hidden">
					<span class="text-sm text-muted">{{ expiryText }}</span>
				</div>

				<!-- 方式一：通过对话 -->
				<div>
					<h2 class="text-base font-medium">{{ $t('bots.chatMethodTitle') }}</h2>
					<p class="mt-1 text-sm text-dimmed">{{ $t('bots.chatMethodDesc') }}</p>
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
					<h2 class="text-base font-medium">{{ $t('bots.shellMethodTitle') }}</h2>
					<p class="mt-1 text-sm text-dimmed">{{ $t('bots.shellMethodDesc') }}</p>
					<div class="mt-2 rounded-lg bg-elevated overflow-hidden">
						<pre class="whitespace-pre-wrap px-3 py-2 text-sm text-default">{{ shellCommandText }}</pre>
						<div class="flex items-center justify-end px-3 py-1.5">
							<UButton
								v-if="copiedKey !== 'shell'"
								variant="ghost"
								color="primary"
								size="md"
								@click="copyToClipboard('shell', shellCommandText)"
							>{{ $t('bots.copy') }}</UButton>
							<span v-else class="flex items-center gap-1 text-sm text-success">
								<UIcon name="i-lucide-check" class="size-4" />
								{{ $t('bots.commandCopied') }}
							</span>
						</div>
					</div>
					<p class="mt-2 text-xs text-dimmed">{{ $t('bots.shellSemicolonHint') }}</p>
				</div>

				<!-- 云部署引导 -->
				<div class="mt-2 flex justify-center border-t border-default pt-4">
					<div class="flex flex-col items-center gap-2.5">
						<h2 class="text-base font-medium">{{ $t('about.cloudDeploy') }}</h2>
						<p class="text-sm text-toned">{{ $t('about.cloudDeployDesc') }}</p>
						<UButton
							class="mt-1 w-full justify-center"
							size="lg"
							variant="outline"
							color="primary"
							icon="i-lucide-external-link"
							@click="openCloudDeploy"
						>{{ $t('about.cloudDeployBtn') }}</UButton>
					</div>
				</div>
			</template>
		</section>
	</main>
	</div>
</template>

<script>
import MobilePageHeader from '../components/MobilePageHeader.vue';
import { useNotify } from '../composables/use-notify.js';
import { cancelBindingCode, createBindingCode, waitBindingCode } from '../services/bots.api.js';
import { useBotsStore } from '../stores/bots.store.js';
import { openExternalUrl } from '../utils/external-url.js';

const CLOUD_DEPLOY_URL = 'https://cloud.tencent.com/act/cps/redirect?redirect=38041&cps_key=3ad323275dc8d2d3fb6efe6fc6a27794';

const DEFAULT_SERVER = 'https://im.coclaw.net';

export default {
	name: 'AddBotPage',
	components: {
		MobilePageHeader,
	},
	setup() {
		return { notify: useNotify() };
	},
	data() {
		return {
			loading: false,
			loadError: '',
			bindingCode: '',
			bindingExpiresAt: null,
			countdownMs: 0,
			countdownTimer: null,
			waitLoopRunning: false,
			waitCancelled: false,
			botsStore: null,
			copiedKey: '',
			copiedTimer: null,
		};
	},
	computed: {
		expired() {
			return !!this.bindingCode && this.countdownMs <= 0;
		},
		expiryText() {
			if (this.countdownMs <= 0) return '';
			const seconds = Math.floor(this.countdownMs / 1000);
			const mins = Math.floor(seconds / 60);
			const secs = seconds % 60;
			const time = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
			return this.$t('bots.expiryLeft', { time });
		},
		serverSuffix() {
			return window.location.origin === DEFAULT_SERVER
				? ''
				: ` --server ${window.location.origin}`;
		},
		chatPromptText() {
			return this.$t('bots.chatPrompt', { code: this.bindingCode, serverSuffix: this.serverSuffix });
		},
		shellCommandText() {
			return `openclaw plugins install @coclaw/openclaw-coclaw ; openclaw coclaw bind ${this.bindingCode}${this.serverSuffix}`;
		},
	},
	mounted() {
		this.botsStore = useBotsStore();
		this.startBinding();
	},
	beforeUnmount() {
		this.stopCountdown();
		this.waitCancelled = true;
		this.waitLoopRunning = false;
		clearTimeout(this.copiedTimer);
		// 不主动删码，让其自然过期；用户离开后码仍可被 CLI 使用
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
				this.notify.error(this.$t('profile.copyFailed'));
			}
		},
		async startBinding() {
			if (this.bindingCode) {
				cancelBindingCode(this.bindingCode).catch(() => {});
			}
			this.loading = true;
			this.loadError = '';
			this.bindingCode = '';
			this.bindingExpiresAt = null;
			this.countdownMs = 0;
			this.waitCancelled = true;
			this.waitLoopRunning = false;
			this.stopCountdown();
			try {
				const data = await createBindingCode();
				this.bindingCode = data.code;
				this.bindingExpiresAt = data.expiresAt;
				this.startCountdown();
				this.waitCancelled = false;
				this.waitLoopRunning = true;
				this.waitBindingLoop(data.code, data.waitToken, data.expiresAt);
			}
			catch (err) {
				console.warn('[AddBotPage] startBinding failed:', err);
				this.loadError = err?.response?.data?.message ?? err?.message ?? this.$t('bots.genFailed');
				this.notify.error(this.loadError);
			}
			finally {
				this.loading = false;
			}
		},
		startCountdown() {
			this.stopCountdown();
			if (!this.bindingExpiresAt) return;
			const tick = () => {
				const target = new Date(this.bindingExpiresAt).getTime();
				this.countdownMs = Math.max(0, target - Date.now());
				if (this.countdownMs <= 0) {
					this.stopCountdown();
					this.waitCancelled = true;
					this.waitLoopRunning = false;
					this.notify.warning(this.$t('bots.expired'));
				}
			};
			tick();
			this.countdownTimer = setInterval(tick, 1000);
		},
		stopCountdown() {
			if (this.countdownTimer) {
				clearInterval(this.countdownTimer);
				this.countdownTimer = null;
			}
		},
		async waitBindingLoop(code, waitToken, expiresAt) {
			const deadline = new Date(expiresAt).getTime();
			while (!this.waitCancelled && this.waitLoopRunning && Date.now() < deadline) {
				try {
					const result = await waitBindingCode(code, waitToken);
					if (this.waitCancelled || !this.waitLoopRunning) return;
					if (result.code === 'BINDING_SUCCESS') {
						this.botsStore?.addOrUpdateBot(result.bot);
						this.bindingCode = '';
						this.stopCountdown();
						this.$router.push('/bots');
						return;
					}
				}
				catch (err) {
					if (this.waitCancelled || !this.waitLoopRunning) return;
					if (err?.response?.data?.code === 'BINDING_TIMEOUT') return;
					console.debug('[add-bot] bind wait error:', err?.message);
				}
			}
			this.waitLoopRunning = false;
		},
		openCloudDeploy() {
			openExternalUrl(CLOUD_DEPLOY_URL);
		},
	},
};
</script>
