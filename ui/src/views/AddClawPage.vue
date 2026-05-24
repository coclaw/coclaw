<template>
	<div class="flex min-h-0 flex-1 flex-col">
		<MobilePageHeader :title="$t('claws.addClaw')">
			<template v-if="expired" #actions>
				<UButton size="md" variant="ghost" color="primary" :loading="loading" @click="startBinding">
					{{ $t('claws.restart') }}
				</UButton>
			</template>
		</MobilePageHeader>
	<main class="flex-1 overflow-auto px-4 pt-4 pb-8 lg:px-5">
		<section class="mx-auto flex w-full max-w-3xl flex-col gap-4">
			<!-- 桌面端标题 + 倒计时/重新开始 -->
			<div class="hidden items-center justify-between md:flex">
				<h1 class="text-base font-medium">{{ $t('claws.addClaw') }}</h1>
				<UButton v-if="expired" size="md" color="primary" :loading="loading" @click="startBinding">
					{{ $t('claws.restart') }}
				</UButton>
				<span v-else-if="bindingCode" class="text-sm text-muted">{{ expiryText }}</span>
			</div>

			<!-- 加载中 -->
			<div v-if="loading && !bindingCode" class="flex flex-col items-center gap-3 py-12">
				<UIcon name="i-lucide-loader-2" class="size-8 animate-spin text-muted" />
				<p class="text-sm text-muted">{{ $t('claws.preparing') }}</p>
			</div>

			<!-- 加载失败 -->
			<div v-else-if="loadError" class="flex flex-col items-center gap-3 py-12">
				<p class="text-sm text-danger">{{ loadError }}</p>
				<UButton size="md" color="primary" :loading="loading" @click="startBinding">{{ $t('claws.retry') }}</UButton>
			</div>

			<!-- 过期 -->
			<div v-else-if="expired" class="flex flex-col items-center gap-3 py-12">
				<p class="text-sm text-muted">{{ $t('claws.expired') }}</p>
				<UButton size="md" color="primary" :loading="loading" @click="startBinding" class="md:hidden">
					{{ $t('claws.restart') }}
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
					<h2 class="text-base font-medium">{{ $t('claws.chatMethodTitle') }}</h2>
					<p class="mt-1 text-sm text-dimmed">{{ $t('claws.chatMethodDesc') }}</p>
					<div class="mt-2 rounded-lg bg-elevated overflow-hidden">
						<pre class="whitespace-pre-wrap px-3 py-2 text-sm text-default">{{ chatPromptText }}</pre>
						<div class="flex items-center justify-end px-3 py-1.5">
							<UButton
								v-if="copiedKey !== 'chat'"
								variant="ghost"
								color="primary"
								size="md"
								@click="copyToClipboard('chat', chatPromptText)"
							>{{ $t('claws.copy') }}</UButton>
							<span v-else class="flex items-center gap-1 text-sm text-success">
								<UIcon name="i-lucide-check" class="size-4" />
								{{ $t('claws.commandCopied') }}
							</span>
						</div>
					</div>
				</div>

				<!-- 方式二：通过终端 -->
				<div>
					<h2 class="text-base font-medium">{{ $t('claws.shellMethodTitle') }}</h2>
					<p class="mt-1 text-sm text-dimmed">{{ $t('claws.shellMethodDesc') }}</p>
					<div class="mt-2 rounded-lg bg-elevated overflow-hidden">
						<pre class="whitespace-pre-wrap px-3 py-2 text-sm text-default">{{ shellCommandText }}</pre>
						<div class="flex items-center justify-end px-3 py-1.5">
							<UButton
								v-if="copiedKey !== 'shell'"
								variant="ghost"
								color="primary"
								size="md"
								@click="copyToClipboard('shell', shellCommandText)"
							>{{ $t('claws.copy') }}</UButton>
							<span v-else class="flex items-center gap-1 text-sm text-success">
								<UIcon name="i-lucide-check" class="size-4" />
								{{ $t('claws.commandCopied') }}
							</span>
						</div>
					</div>
					<p class="mt-2 text-xs text-dimmed">{{ $t('claws.shellSemicolonHint') }}</p>
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
import { cancelBindingCode, createBindingCode } from '../services/claws.api.js';
import { useClawsStore } from '../stores/claws.store.js';
import { openExternalUrl } from '../utils/external-url.js';
import { writeClipboardText } from '../utils/clipboard.js';

const CLOUD_DEPLOY_URL = 'https://cloud.tencent.com/act/cps/redirect?redirect=38041&cps_key=3ad323275dc8d2d3fb6efe6fc6a27794';

const DEFAULT_SERVER = 'https://im.coclaw.net';

export default {
	name: 'AddClawPage',
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
			clawsStore: null,
			copiedKey: '',
			copiedTimer: null,
			// 进页面时记下当前 claw id 集合作为 baseline；之后列表里冒出新 id 即视为本次绑定成功。
			// null 时 watcher 不工作（baseline 还没捕到，避免空集合把已有 claw 误判成"新增"）
			baselineClawIds: null,
			navigated: false,
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
			return this.$t('claws.expiryLeft', { time });
		},
		serverSuffix() {
			return window.location.origin === DEFAULT_SERVER
				? ''
				: ` --server ${window.location.origin}`;
		},
		chatPromptText() {
			return this.$t('claws.chatPrompt', { code: this.bindingCode, serverSuffix: this.serverSuffix });
		},
		shellCommandText() {
			return `openclaw plugins install @coclaw/openclaw-coclaw ; openclaw coclaw bind ${this.bindingCode}${this.serverSuffix}`;
		},
		// 收窄到 scalar：返回 baseline 之外的第一个 claw id 或 null。
		// 仅依赖 byId 的 keys（Vue 3 reactive ownKeys trap），避免 deep watch。
		newClawId() {
			if (!this.baselineClawIds || !this.clawsStore) return null;
			for (const id of Object.keys(this.clawsStore.byId)) {
				if (!this.baselineClawIds.has(id)) return id;
			}
			return null;
		},
	},
	watch: {
		// claw 列表里冒出 baseline 之外的 id（来自 SSE claw.bound 或重连后的 snapshot）→ 视为本次绑定成功
		newClawId(id) {
			if (!id || this.navigated) return;
			this.navigated = true;
			this.bindingCode = '';
			this.stopCountdown();
			this.$router.push('/claws');
		},
	},
	mounted() {
		this.clawsStore = useClawsStore();
		this.startBinding();
	},
	beforeUnmount() {
		this.stopCountdown();
		clearTimeout(this.copiedTimer);
		// 不主动删码，让其自然过期；用户离开后码仍可被 CLI 使用
	},
	methods: {
		async copyToClipboard(key, text) {
			try {
				await writeClipboardText(text);
				clearTimeout(this.copiedTimer);
				this.copiedKey = key;
				this.copiedTimer = setTimeout(() => { this.copiedKey = ''; }, 3000);
			}
			catch {
				this.notify.error(this.$t('profile.copyFailed'));
			}
		},
		async startBinding() {
			// in-flight guard：上一次还没结束就忽略本次（防双击让先到的 bindingCode 变孤儿）
			if (this.loading) return;
			if (this.bindingCode) {
				cancelBindingCode(this.bindingCode).catch(() => {});
			}
			this.loading = true;
			this.loadError = '';
			this.bindingCode = '';
			this.bindingExpiresAt = null;
			this.countdownMs = 0;
			this.navigated = false;
			this.baselineClawIds = null; // 重置期 disarm watcher，等 baseline 重新捕到再 arm
			this.stopCountdown();
			try {
				await this.captureBaseline();
				const data = await createBindingCode();
				this.bindingCode = data.code;
				this.bindingExpiresAt = data.expiresAt;
				this.startCountdown();
			}
			catch (err) {
				console.warn('[AddClawPage] startBinding failed:', err);
				this.loadError = err?.response?.data?.message ?? err?.message ?? this.$t('claws.genFailed');
				this.notify.error(this.loadError);
			}
			finally {
				this.loading = false;
			}
		},
		// 等到全局 SSE 至少推过一次 claw 快照（store.fetched=true）后再记 baseline，
		// 否则可能用空集合作底，把列表里"原本就有"的 claw 误判成"刚绑成功"。
		async captureBaseline() {
			if (!this.clawsStore.fetched) {
				await new Promise((resolve) => {
					const stop = this.$watch(
						() => this.clawsStore.fetched,
						(v) => {
							if (v) {
								stop();
								resolve();
							}
						},
					);
				});
			}
			this.baselineClawIds = new Set(Object.keys(this.clawsStore.byId));
		},
		startCountdown() {
			this.stopCountdown();
			if (!this.bindingExpiresAt) return;
			const tick = () => {
				const target = new Date(this.bindingExpiresAt).getTime();
				this.countdownMs = Math.max(0, target - Date.now());
				if (this.countdownMs <= 0) {
					this.stopCountdown();
					this.notify.warning(this.$t('claws.expired'));
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
		openCloudDeploy() {
			openExternalUrl(CLOUD_DEPLOY_URL);
		},
	},
};
</script>
