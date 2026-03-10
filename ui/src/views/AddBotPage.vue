<template>
	<div class="flex flex-1 flex-col">
		<MobilePageHeader :title="$t('bots.addBot')" />
	<main class="flex-1 overflow-auto px-4 pt-4 pb-8 lg:px-5">
		<section class="mx-auto flex w-full max-w-3xl flex-col gap-4">
			<h1 class="hidden text-lg font-medium md:block">{{ $t('bots.addBot') }}</h1>

			<!-- bot name 输入暂时隐藏；将来绑定非 OpenClaw bot 时可启用 -->
			<div v-if="false">
				<label class="mb-1 block text-sm text-muted">{{ $t('bots.botNameOptional') }}</label>
				<UInput v-model="botName" :placeholder="$t('bots.botNamePlaceholder')" />
			</div>

			<!-- 步骤一：安装或升级插件 -->
			<div>
				<h2 class="text-base font-medium">{{ $t('bots.step1') }}{{ $t('bots.sectionPlugin') }}</h2>
				<p class="mt-0.5 text-sm text-dimmed">{{ $t('bots.pluginHint') }}</p>

				<!-- 终端安装命令 -->
				<div class="rounded-lg bg-elevated overflow-hidden mt-2">
					<div class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-dimmed">
						<span>{{ $t('bots.installViaShell') }}</span>
						<UButton
							v-if="copiedKey !== 'install'"
							class="cc-icon-btn"
							color="primary"
							variant="ghost"
							size="md"
							icon="i-lucide-copy"
							@click="copyToClipboard('install', installCommand)"
						/>
						<span v-else class="flex shrink-0 items-center gap-1 text-sm text-success">
							<UIcon name="i-lucide-check" class="size-4" />
							{{ $t('bots.commandCopied') }}
						</span>
					</div>
					<pre class="block whitespace-pre-wrap px-3 py-2 text-sm text-default">{{ installCommand }}</pre>
				</div>

				<!-- 终端升级命令 -->
				<div class="rounded-lg bg-elevated overflow-hidden mt-2">
					<div class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-dimmed">
						<span>{{ $t('bots.updateViaShell') }}</span>
						<UButton
							v-if="copiedKey !== 'update'"
							class="cc-icon-btn"
							color="primary"
							variant="ghost"
							size="md"
							icon="i-lucide-copy"
							@click="copyToClipboard('update', updateCommand)"
						/>
						<span v-else class="flex shrink-0 items-center gap-1 text-sm text-success">
							<UIcon name="i-lucide-check" class="size-4" />
							{{ $t('bots.commandCopied') }}
						</span>
					</div>
					<pre class="block whitespace-pre-wrap px-3 py-2 text-sm text-default">{{ updateCommand }}</pre>
				</div>

				<!-- 通过 IM 对话安装/升级 -->
				<div class="rounded-lg bg-elevated overflow-hidden mt-2">
					<div class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-dimmed">
						<span>{{ $t('bots.installViaChat') }}</span>
						<UButton
							v-if="copiedKey !== 'installChat'"
							class="cc-icon-btn"
							color="primary"
							variant="ghost"
							size="md"
							icon="i-lucide-copy"
							@click="copyToClipboard('installChat', $t('bots.installPrompt'))"
						/>
						<span v-else class="flex shrink-0 items-center gap-1 text-sm text-success">
							<UIcon name="i-lucide-check" class="size-4" />
							{{ $t('bots.commandCopied') }}
						</span>
					</div>
					<pre class="block whitespace-pre-wrap px-3 py-2 text-sm text-default">{{ $t('bots.installPrompt') }}</pre>
				</div>
			</div>

			<!-- 步骤二：绑定 -->
			<div>
				<div class="flex items-center justify-between">
					<h2 class="text-base font-medium">{{ $t('bots.step2') }}{{ $t('bots.sectionBind') }}</h2>
					<UButton size="md" color="primary" :loading="creatingCode" @click="generateCode">
						{{ bindingCode ? $t('bots.regenCode') : $t('bots.genCode') }}
					</UButton>
				</div>
				<div v-if="bindingCode" class="mt-2 rounded-lg border border-accented bg-default p-3">
					<p class="text-sm text-dimmed">{{ $t('bots.bindingCode') }}</p>
					<p class="mt-1 text-2xl font-semibold tracking-widest">{{ bindingCode }}</p>
					<p class="mt-2 text-sm text-muted">{{ expiryText }}</p>

					<div class="rounded-lg bg-elevated overflow-hidden mt-3">
						<div class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-dimmed">
							<span>{{ $t('bots.bindViaChat') }}</span>
							<UButton
								v-if="copiedKey !== 'chat'"
								class="cc-icon-btn"
								color="primary"
								variant="ghost"
								size="md"
								icon="i-lucide-copy"
								@click="copyToClipboard('chat')"
							/>
							<span v-else class="flex shrink-0 items-center gap-1 text-sm text-success">
								<UIcon name="i-lucide-check" class="size-4" />
								{{ $t('bots.commandCopied') }}
							</span>
						</div>
						<code class="block whitespace-pre-wrap px-3 py-2 text-sm text-default">/coclaw bind {{ bindingCode }}{{ serverSuffix }}</code>
					</div>

					<div class="rounded-lg bg-elevated overflow-hidden mt-2">
						<div class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-dimmed">
							<span>{{ $t('bots.bindViaShell') }}</span>
							<UButton
								v-if="copiedKey !== 'shell'"
								class="cc-icon-btn"
								color="primary"
								variant="ghost"
								size="md"
								icon="i-lucide-copy"
								@click="copyToClipboard('shell')"
							/>
							<span v-else class="flex shrink-0 items-center gap-1 text-sm text-success">
								<UIcon name="i-lucide-check" class="size-4" />
								{{ $t('bots.commandCopied') }}
							</span>
						</div>
						<code class="block whitespace-pre-wrap px-3 py-2 text-sm text-default">openclaw coclaw bind {{ bindingCode }}{{ serverSuffix }}</code>
					</div>
				</div>
				<p v-else class="mt-1 text-sm text-muted">{{ $t('bots.genHint') }}</p>
			</div>
		</section>
	</main>
	</div>
</template>

<script>
import MobilePageHeader from '../components/MobilePageHeader.vue';
import { useNotify } from '../composables/use-notify.js';
import { createBindingCode, waitBindingCode } from '../services/bots.api.js';
import { useBotsStore } from '../stores/bots.store.js';

const DEFAULT_SERVER = 'https://app.coclaw.net';

const INSTALL_COMMAND = 'openclaw plugins install @coclaw/openclaw-coclaw';
const UPDATE_COMMAND = 'openclaw plugins update openclaw-coclaw';

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
			creatingCode: false,
			bindingCode: '',
			bindingExpiresAt: null,
			countdownMs: 0,
			countdownTimer: null,
			waitLoopRunning: false,
			waitCancelled: false,
			botName: 'OpenClaw',
			botsStore: null,
			installCommand: INSTALL_COMMAND,
			updateCommand: UPDATE_COMMAND,
			serverOrigin: window.location.origin,
			copiedKey: '',
			copiedTimer: null,
		};
	},
	computed: {
		serverSuffix() {
			return this.serverOrigin === DEFAULT_SERVER
				? ''
				: ` --server ${this.serverOrigin}`;
		},
		expiryText() {
			if (!this.bindingExpiresAt) {
				return '';
			}
			if (this.countdownMs <= 0) {
				return this.$t('bots.expired');
			}
			const seconds = Math.floor(this.countdownMs / 1000);
			const mins = Math.floor(seconds / 60);
			const secs = seconds % 60;
			const time = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
			return this.$t('bots.expiryLeft', { time });
		},
	},
	mounted() {
		this.botsStore = useBotsStore();
	},
	beforeUnmount() {
		this.stopCountdown();
		this.waitCancelled = true;
		this.waitLoopRunning = false;
		clearTimeout(this.copiedTimer);
	},
	methods: {
		async copyToClipboard(key, text) {
			if (!text) {
				if (key === 'chat') {
					text = `/coclaw bind ${this.bindingCode}${this.serverSuffix}`;
				} else if (key === 'shell') {
					text = `openclaw coclaw bind ${this.bindingCode}${this.serverSuffix}`;
				}
			}
			try {
				await navigator.clipboard.writeText(text);
				clearTimeout(this.copiedTimer);
				this.copiedKey = key;
				this.copiedTimer = setTimeout(() => { this.copiedKey = ''; }, 3000);
				console.debug('[add-bot] copied key=%s', key);
			}
			catch {
				this.notify.error(this.$t('profile.copyFailed'));
			}
		},
		async generateCode() {
			this.creatingCode = true;
			this.waitCancelled = true;
			this.waitLoopRunning = false;
			try {
				const data = await createBindingCode();
				this.bindingCode = data.code;
				this.bindingExpiresAt = data.expiresAt;
				console.log('[add-bot] binding code generated: %s', data.code);
				this.startCountdown();
				this.waitCancelled = false;
				this.waitLoopRunning = true;
				this.waitBindingLoop(data.code, data.waitToken, data.expiresAt);
			}
			catch (err) {
				this.notify.error(err?.response?.data?.message ?? err?.message ?? this.$t('bots.genFailed'));
			}
			finally {
				this.creatingCode = false;
			}
		},
		startCountdown() {
			this.stopCountdown();
			if (!this.bindingExpiresAt) {
				return;
			}
			const tick = () => {
				const target = new Date(this.bindingExpiresAt).getTime();
				this.countdownMs = Math.max(0, target - Date.now());
				if (this.countdownMs <= 0) {
					this.notify.warning(this.$t('bots.expired'));
					this.clearBindingCodeBlock();
				}
			};
			tick();
			this.countdownTimer = setInterval(tick, 1000);
		},
		clearBindingCodeBlock() {
			this.bindingCode = '';
			this.bindingExpiresAt = null;
			this.countdownMs = 0;
			this.stopCountdown();
			this.waitCancelled = true;
			this.waitLoopRunning = false;
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
					if (this.waitCancelled || !this.waitLoopRunning) {
						return;
					}
					if (result.code === 'BINDING_SUCCESS') {
						console.debug('[add-bot] bind success, bot=%s', result.bot?.id);
						this.botsStore?.addOrUpdateBot(result.bot);
						this.clearBindingCodeBlock();
						this.$router.push('/bots');
						return;
					}
					if (result.code === 'BINDING_TIMEOUT') {
						console.debug('[add-bot] bind timeout (server)');
						this.notify.warning(this.$t('bots.expired'));
						this.clearBindingCodeBlock();
						return;
					}
					console.debug('[add-bot] bind pending, code=%s', result.code);
				}
				catch (err) {
					if (this.waitCancelled || !this.waitLoopRunning) {
						return;
					}
					const apiCode = err?.response?.data?.code;
					if (apiCode === 'BINDING_TIMEOUT') {
						console.debug('[add-bot] bind timeout (error)');
						this.notify.warning(this.$t('bots.expired'));
						this.clearBindingCodeBlock();
						return;
					}
					console.debug('[add-bot] bind wait error:', err?.message);
				}
			}
			this.waitLoopRunning = false;
		},
	},
};
</script>
