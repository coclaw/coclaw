<template>
	<div class="grid gap-0">
		<div data-testid="setting-theme" class="flex items-center justify-between gap-3 py-3">
			<span class="text-sm">{{ $t('settings.appearance') }}</span>
			<USelect v-model="form.theme" :items="themeOptions" value-key="value" class="w-40" @update:model-value="onSaveSettings" />
		</div>

		<div data-testid="setting-lang" class="flex items-center justify-between gap-3 py-3">
			<span class="text-sm">{{ $t('settings.language') }}</span>
			<USelect v-model="form.lang" :items="langOptions" value-key="value" class="w-40" @update:model-value="onSaveSettings" />
		</div>

		<div v-if="isLocalAuth" class="flex items-center justify-between gap-3 py-3">
			<span class="text-sm">{{ $t('settings.loginPassword') }}</span>
			<UButton data-testid="btn-change-password" variant="soft" @click="passwordModalOpen = true">
				{{ $t('settings.change') }}
			</UButton>
		</div>

		<div class="flex items-center justify-between gap-3 py-3">
			<span class="text-sm">{{ $t('settings.clearChats') }}</span>
			<UButton color="error" variant="soft" @click="clearConfirmOpen = true">{{ $t('settings.clear') }}</UButton>
		</div>

		<UModal v-model:open="passwordModalOpen" :title="$t('settings.passwordTitle')" description=" " :ui="promptUi">
			<template #body>
				<!-- 用 form 包裹密码框：消除浏览器“password 不在 form 内”告警；原生回车走 onSubmit -->
				<form class="grid gap-3" @submit.prevent="onSubmitPasswordChange">
					<!-- 隐藏 username 字段：消除“改密表单应含 username 字段”告警，并让密码管理器把新密码关联到当前账号 -->
					<input type="text" :value="loginName" autocomplete="username" class="hidden" aria-hidden="true" tabindex="-1" readonly />
					<PasswordInput v-model="pwdForm.currentPassword" data-testid="pwd-current" autocomplete="current-password" :placeholder="$t('settings.currentPassword')" />
					<PasswordInput v-model="pwdForm.newPassword" data-testid="pwd-new" autocomplete="new-password" :placeholder="$t('settings.newPassword')" />
					<PasswordInput v-model="pwdForm.confirmPassword" data-testid="pwd-confirm" autocomplete="new-password" :placeholder="$t('settings.confirmPassword')" />
					<!-- 隐藏 submit：让多输入框场景下的原生回车也能触发提交（按钮在 footer 外，不在 form 内） -->
					<button type="submit" class="hidden" aria-hidden="true" tabindex="-1"></button>
				</form>
			</template>
			<template #footer>
				<div class="flex w-full justify-end gap-2">
					<UButton variant="ghost" color="neutral" :disabled="pwdSubmitting" @click="passwordModalOpen = false">{{ $t('common.cancel') }}</UButton>
					<UButton :loading="pwdSubmitting" :disabled="pwdSubmitting" @click="onSubmitPasswordChange">{{ $t('settings.change') }}</UButton>
				</div>
			</template>
		</UModal>

		<UModal v-model:open="clearConfirmOpen" :title="$t('settings.dangerTitle')" description=" " :ui="promptUi">
			<template #body>
				<p class="text-sm text-muted">{{ $t('settings.dangerDesc') }}</p>
				<UCheckbox v-model="clearAcknowledge" :label="$t('settings.ackDanger')" class="mt-3" />
			</template>
			<template #footer>
				<div class="flex w-full justify-end gap-2">
					<UButton variant="ghost" color="neutral" @click="clearConfirmOpen = false">{{ $t('common.cancel') }}</UButton>
					<UButton color="error" :disabled="!clearAcknowledge" @click="onConfirmClearChats">{{ $t('common.confirm') }}</UButton>
				</div>
			</template>
		</UModal>
	</div>
</template>

<script>
import { useAuthStore } from '../../stores/auth.store.js';
import { useNotify } from '../../composables/use-notify.js';
import { promptModalUi } from '../../constants/prompt-modal-ui.js';
import { getUserLoginName } from '../../utils/user-profile.js';
import PasswordInput from '../PasswordInput.vue';

export default {
	name: 'UserSettingsPanel',
	components: {
		PasswordInput,
	},
	setup() {
		return {
			authStore: useAuthStore(),
			notify: useNotify(),
			promptUi: promptModalUi,
		};
	},
	data() {
		return {
			form: {
				theme: 'dark',
				lang: 'zh-CN',
			},
			passwordModalOpen: false,
			pwdSubmitting: false,
			pwdForm: {
				currentPassword: '',
				newPassword: '',
				confirmPassword: '',
			},
			clearConfirmOpen: false,
			clearAcknowledge: false,
		};
	},
	computed: {
		themeOptions() {
			return [
				{ label: this.$t('settings.themeAuto'), value: 'auto' },
				{ label: this.$t('settings.themeDark'), value: 'dark' },
				{ label: this.$t('settings.themeLight'), value: 'light' },
			];
		},
		langOptions() {
			return [
				{ label: this.$t('settings.langZh'), value: 'zh-CN' },
				{ label: this.$t('settings.langZhTW'), value: 'zh-TW' },
				{ label: this.$t('settings.langEn'), value: 'en' },
				{ label: this.$t('settings.langJa'), value: 'ja' },
				{ label: this.$t('settings.langKo'), value: 'ko' },
				{ label: this.$t('settings.langFr'), value: 'fr' },
				{ label: this.$t('settings.langDe'), value: 'de' },
				{ label: this.$t('settings.langEs'), value: 'es' },
				{ label: this.$t('settings.langPt'), value: 'pt' },
				{ label: this.$t('settings.langRu'), value: 'ru' },
				{ label: this.$t('settings.langVi'), value: 'vi' },
				{ label: this.$t('settings.langHi'), value: 'hi' },
			];
		},
		isLocalAuth() {
			return this.authStore.user?.authType === 'local';
		},
		// 当前账号登录名：作为改密表单隐藏 username 字段的值，供密码管理器关联
		loginName() {
			return getUserLoginName(this.authStore.user);
		},
	},
	watch: {
		'authStore.user': {
			immediate: true,
			handler(user) {
				this.form.theme = user?.settings?.theme ?? 'dark';
				this.form.lang = user?.settings?.lang ?? 'zh-CN';
			},
		},
	},
	methods: {
		async onSaveSettings() {
			await this.authStore.updateSettings({
				theme: this.form.theme,
				lang: this.form.lang,
			});
			if (this.authStore.errorMessage) {
				this.notify.error(this.authStore.errorMessage);
			}
		},
		async onSubmitPasswordChange() {
			// 在途守卫：回车与点按钮可能叠触发，提交中直接忽略，避免改密请求发两次
			if (this.pwdSubmitting) return;
			if (!this.pwdForm.currentPassword || !this.pwdForm.newPassword) {
				this.notify.warning(this.$t('settings.needPassword'));
				return;
			}
			if (this.pwdForm.newPassword !== this.pwdForm.confirmPassword) {
				this.notify.warning(this.$t('settings.passwordNotMatch'));
				return;
			}
			this.pwdSubmitting = true;
			try {
				const ok = await this.authStore.changePassword({
					oldPassword: this.pwdForm.currentPassword,
					newPassword: this.pwdForm.newPassword,
				});
				if (ok) {
					this.notify.success(this.$t('settings.passwordChanged'));
				} else {
					this.notify.error(this.authStore.errorMessage);
				}
				this.passwordModalOpen = false;
				this.pwdForm = {
					currentPassword: '',
					newPassword: '',
					confirmPassword: '',
				};
			} finally {
				this.pwdSubmitting = false;
			}
		},
		onConfirmClearChats() {
			this.notify.info({
				title: this.$t('settings.clearApiNotReady'),
				description: this.$t('settings.clearApiNotReadyDesc'),
			});
			this.clearConfirmOpen = false;
			this.clearAcknowledge = false;
		},
	},
};
</script>
