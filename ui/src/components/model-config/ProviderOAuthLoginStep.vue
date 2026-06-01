<template>
	<div data-testid="oauth-login-step" class="flex flex-col gap-3">
		<!-- starting：已发起 loginOauth、等 phase-1 受理帧 -->
		<div
			v-if="phase === 'starting'"
			data-testid="oauth-starting"
			class="px-2 py-6 text-center text-sm text-muted"
		>
			{{ $t('modelConfig.providerAuth.oauth.starting') }}
		</div>

		<!-- pending：拿到受理帧，先展示授权码（多数流程第一步是复制码），指引紧贴其所指的授权链接、置于链接正上方（rawText 在结构化字段抠不到时兜底） -->
		<template v-else-if="phase === 'pending'">
			<!-- 授权码：inline 等宽小块 + icon 复制按钮（样式同用户信息复制登录名）；
			     码已嵌进授权链接（如 minimax-portal）时不再单列，用户直接点链接即可（见 showUserCode） -->
			<div v-if="showUserCode" class="flex items-center gap-2">
				<span class="text-xs text-muted">{{ $t('modelConfig.providerAuth.oauth.codeLabel') }}</span>
				<code data-testid="oauth-user-code" class="select-all rounded bg-elevated px-2 py-0.5 font-mono text-base tracking-wider">{{ userCode }}</code>
				<UButton
					data-testid="oauth-copy-code"
					class="cc-icon-btn"
					variant="ghost"
					color="primary"
					size="md"
					:icon="codeCopied ? 'i-lucide-check' : 'i-lucide-copy'"
					:aria-label="$t('modelConfig.providerAuth.oauth.copy')"
					@click="onCopyCode"
				/>
				<!-- 复制成功就地反馈“已复制”，约 3s 后自动消失（不弹 toast） -->
				<span v-if="codeCopied" data-testid="oauth-code-copied" class="text-xs text-success">
					{{ $t('modelConfig.providerAuth.oauth.copied') }}
				</span>
			</div>

			<!-- 指引“点击下方链接进行授权”紧贴其所指链接：放在授权码之后、链接正上方，免被授权码隔开造成“下方链接”指代错位 -->
			<p class="text-sm text-muted">
				{{ $t('modelConfig.providerAuth.oauth.instructions') }}
			</p>

			<!-- 结构化授权链接：远端用户在自己设备打开（走平台外链）。指引已说“下方链接”、URL 自明，不再加标签/按钮 -->
			<a
				v-if="verificationUri"
				data-testid="oauth-verification-link"
				class="self-start break-all text-sm text-primary underline cursor-pointer"
				@click="onOpenLink"
			>
				{{ verificationUri }}
			</a>

			<!-- rawText 兜底：仅在结构化链接抠不到、且有原文时渲染（交用户自行阅读授权指引） -->
			<div v-if="showRawText" class="flex flex-col gap-1">
				<span class="text-xs text-muted">{{ $t('modelConfig.providerAuth.oauth.rawTextLabel') }}</span>
				<pre data-testid="oauth-raw-text" class="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-elevated px-2 py-1 text-xs">{{ rawText }}</pre>
			</div>

			<p class="text-xs text-muted">{{ $t('modelConfig.providerAuth.oauth.waiting') }}</p>
		</template>

		<!-- error：终态失败（含 phase-1 前单帧错误）。仅展示映射文案；
		     重试 / 返回 动作由父对话框的 footer 承载（见下方 update:phase + 公开方法 start/onBack） -->
		<template v-else-if="phase === 'error'">
			<p data-testid="oauth-error" class="text-sm text-error">{{ $t(errorKey) }}</p>
		</template>
	</div>
</template>

<script>
import { openExternalUrl } from '../../utils/external-url.js';
import { writeClipboardText } from '../../utils/clipboard.js';
import { useNotify } from '../../composables/use-notify.js';

// 终态失败 error.code → i18n key 映射。OAUTH_CANCELLED 不在此表（取消是预期终态、静默退回）；
// 未知码（含通道层 RPC_TIMEOUT/DC_CLOSED 等）回退到 oauth.failed 泛化文案。
const OAUTH_ERROR_KEYS = {
	OAUTH_FAILED: 'modelConfig.providerAuth.oauth.errors.OAUTH_FAILED',
	OAUTH_TIMEOUT: 'modelConfig.providerAuth.oauth.errors.OAUTH_TIMEOUT',
	IO_FAILED: 'modelConfig.providerAuth.oauth.errors.IO_FAILED',
	NOT_FOUND: 'modelConfig.providerAuth.oauth.errors.NOT_FOUND',
};
const OAUTH_FAILED_FALLBACK_KEY = 'modelConfig.providerAuth.oauth.failed';

export default {
	name: 'ProviderOAuthLoginStep',
	props: {
		/** 要登录的基座 provider id（如 minimax-portal / github-copilot） */
		provider: {
			type: String,
			required: true,
		},
		/**
		 * 发起两阶段 OAuth 登录的回调（由父组件 wrap 一次 conn.request）：
		 *   ({ provider, onAccepted, signal }) => Promise
		 * - onAccepted 仅在 phase-1 受理帧（status==='accepted'）触发一次，payload 带
		 *   { loginId, verificationUri|null, userCode|null, rawText }。
		 * - 返回的 promise：phase-2 成功 resolve（{ status:'ok', provider, profileIds }），
		 *   失败 reject（err.code 为 OAUTH_FAILED / OAUTH_TIMEOUT / IO_FAILED / NOT_FOUND）。
		 *
		 * 以函数注入而非组件直接拿 conn：测试只注入一个 vi.fn() 即可，父组件也能绑当前 clawId。
		 *
		 * @type {(args: { provider: string, onAccepted: Function, signal: AbortSignal }) => Promise<unknown>}
		 */
		loginOauth: {
			type: Function,
			default: null,
		},
		/**
		 * 取消进行中的登录：({ loginId }) => Promise。拨掉后端轮询，对应 loginOauth 的
		 * phase-2 回 cancelled（幂等）。
		 *
		 * @type {(args: { loginId: string }) => Promise<unknown>}
		 */
		cancelOauth: {
			type: Function,
			default: null,
		},
		/** 挂载即自动发起登录（默认 true）；false 时由父组件显式调 start() */
		autoStart: {
			type: Boolean,
			default: true,
		},
	},
	// update:phase 把内部阶段（starting/pending/error）抛给父对话框，
	// 让 footer 按阶段渲染对应动作（pending→取消 / error→返回+重试）。
	emits: ['success', 'cancel', 'update:phase'],
	setup() {
		return {
			notify: useNotify(),
		};
	},
	data() {
		return {
			/** 'starting' = 等受理帧；'pending' = 展示码等授权；'error' = 终态失败 */
			phase: 'starting',
			/** phase-1 拿到的 loginId（取消时关联）；空串 = 尚未受理 */
			loginId: '',
			verificationUri: '',
			userCode: '',
			rawText: '',
			/** 终态失败的 i18n key（'' 表示无错误） */
			errorKey: '',
			/** 授权码刚复制：就地显示“已复制”，约 3s 后由定时器复位（非 toast） */
			codeCopied: false,
		};
	},
	computed: {
		/**
		 * 是否渲染 rawText 兜底块：仅当结构化授权链接抠不到（verificationUri 为空）且有原文时。
		 * 链接在手就足够操作，rawText 只是结构化字段缺失时的退路（设计 §4.3）。
		 */
		showRawText() {
			return !this.verificationUri && !!this.rawText;
		},
		/**
		 * 是否单独展示授权码：码非空，且没被嵌进授权链接里。minimax-portal 这类把
		 * user_code 拼进 URL，用户点链接即完成、无需再单列码。假定码不会被 URI 换码，
		 * 直接子串匹配；匹配落空只会“照常显示码”（轻微冗余），失败安全。
		 * @returns {boolean}
		 */
		showUserCode() {
			if (!this.userCode) return false;
			return !(this.verificationUri && this.verificationUri.includes(this.userCode));
		},
	},
	watch: {
		// 阶段变化即上抛，父 footer 跟随切换动作按钮
		phase(val) {
			this.$emit('update:phase', val);
		},
	},
	mounted() {
		// 先同步初始阶段（每次重新挂载都会发，父级据此复位 footer），再自动发起
		this.$emit('update:phase', this.phase);
		if (this.autoStart) this.start();
	},
	beforeUnmount() {
		// 作废在飞 handler + 中止本地 waiter；有在途登录则顺手拨掉后端轮询（best-effort）
		this.__teardown();
		if (this.__copyTimer) clearTimeout(this.__copyTimer);
	},
	methods: {
		/**
		 * 给定终态 error.code 返回 i18n key；未知码回退泛化文案。
		 * @param {unknown} code
		 * @returns {string}
		 */
		__errorKeyFor(code) {
			return (typeof code === 'string' && OAUTH_ERROR_KEYS[code]) || OAUTH_FAILED_FALLBACK_KEY;
		},
		/** 中止当前在飞登录：bump token 让回调失效、abort 本地 waiter、拨后端轮询 */
		__teardown() {
			// bump run token → 在飞 loginOauth 的 onAccepted / then / catch 全部判过期丢弃
			this.__runToken = (this.__runToken || 0) + 1;
			if (this.__aborter) {
				try { this.__aborter.abort(); }
				catch { /* AbortController.abort 不应抛；极端环境兜底 */ }
				this.__aborter = null;
			}
			const loginId = this.loginId;
			this.loginId = '';
			if (loginId && this.cancelOauth) {
				// 幂等、fire-and-forget：拨掉后端轮询，phase-2 cancelled 会让 waiter 自己清掉
				Promise.resolve(this.cancelOauth({ loginId })).catch(() => {});
			}
		},
		/** 发起（或重试）一次两阶段 OAuth 登录 */
		start() {
			// 重置展示态；token 自增隔离上一轮可能仍在飞的回调
			this.phase = 'starting';
			this.loginId = '';
			this.verificationUri = '';
			this.userCode = '';
			this.rawText = '';
			this.errorKey = '';
			const token = (this.__runToken || 0) + 1;
			this.__runToken = token;
			if (!this.loginOauth) {
				// 父组件没注入通道——直接进错误态，不静默挂住
				this.errorKey = 'modelConfig.common.connError';
				this.phase = 'error';
				this.notify.error(this.$t(this.errorKey));
				return;
			}
			const aborter = new AbortController();
			this.__aborter = aborter;
			Promise.resolve(this.loginOauth({
				provider: this.provider,
				onAccepted: (payload) => {
					if (token !== this.__runToken) return;
					this.loginId = (payload && typeof payload.loginId === 'string') ? payload.loginId : '';
					this.verificationUri = (payload && typeof payload.verificationUri === 'string') ? payload.verificationUri : '';
					this.userCode = (payload && typeof payload.userCode === 'string') ? payload.userCode : '';
					this.rawText = (payload && typeof payload.rawText === 'string') ? payload.rawText : '';
					this.phase = 'pending';
				},
				signal: aborter.signal,
			}))
				.then((result) => {
					if (token !== this.__runToken) return;
					this.__aborter = null;
					this.loginId = '';
					this.$emit('success', { provider: this.provider, profileId: extractProfileId(result) });
				})
				.catch((err) => {
					if (token !== this.__runToken) return;
					this.__aborter = null;
					this.loginId = '';
					const code = err && typeof err === 'object' ? err.code : undefined;
					// 取消是预期终态（用户/卸载触发）：静默退回，不报错
					if (code === 'OAUTH_CANCELLED' || code === 'ERR_CANCELED') {
						this.$emit('cancel');
						return;
					}
					this.errorKey = this.__errorKeyFor(code);
					this.phase = 'error';
					// 错误操作始终 notify（ui/CLAUDE.md）；inline error 另给重试/返回入口
					this.notify.error(this.$t(this.errorKey));
				});
		},
		onOpenLink() {
			if (!this.verificationUri) return;
			// fire-and-forget：openExternalUrl 内部已兜底，这里再 catch 一层防极端环境抛出
			Promise.resolve(openExternalUrl(this.verificationUri)).catch(() => {});
		},
		/** 复制授权码：成功就地显示“已复制”约 3s（不弹 toast），失败才提示 */
		async onCopyCode() {
			try {
				await writeClipboardText(this.userCode);
				this.codeCopied = true;
				if (this.__copyTimer) clearTimeout(this.__copyTimer);
				this.__copyTimer = setTimeout(() => {
					this.codeCopied = false;
					this.__copyTimer = null;
				}, 3000);
			}
			catch {
				this.notify.error(this.$t('common.copyFailed'));
			}
		},
		onCancel() {
			// 仅在 starting/pending 有在飞登录时才需拨后端；其它态直接退回
			if (this.phase === 'starting' || this.phase === 'pending') {
				this.__teardown();
			}
			this.$emit('cancel');
		},
		onBack() {
			// 错误态返回：无在飞登录，直接退回
			this.$emit('cancel');
		},
	},
};

/**
 * 从 phase-2 成功 payload 抠 profileId：B1 回 profileIds[]、B2 回 profileId。
 * @param {unknown} result
 * @returns {string|undefined}
 */
function extractProfileId(result) {
	if (!result || typeof result !== 'object') return undefined;
	if (Array.isArray(result.profileIds) && typeof result.profileIds[0] === 'string') return result.profileIds[0];
	if (typeof result.profileId === 'string') return result.profileId;
	return undefined;
}
</script>
