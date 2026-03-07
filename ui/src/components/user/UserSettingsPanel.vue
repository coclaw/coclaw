<template>
	<div class="grid gap-0">
		<div class="flex items-center justify-between gap-3 py-3">
			<span class="text-sm">{{ $t('settings.appearance') }}</span>
			<USelect v-model="form.theme" :items="themeOptions" value-key="value" class="w-40" @update:model-value="onSaveSettings" />
		</div>

		<div class="flex items-center justify-between gap-3 py-3">
			<span class="text-sm">{{ $t('settings.language') }}</span>
			<USelect v-model="form.lang" :items="langOptions" value-key="value" class="w-40" @update:model-value="onSaveSettings" />
		</div>

		<div v-if="isLocalAuth" class="flex items-center justify-between gap-3 py-3">
			<span class="text-sm">{{ $t('settings.loginPassword') }}</span>
			<UButton variant="soft" @click="passwordModalOpen = true">
				{{ $t('settings.change') }}
			</UButton>
		</div>

		<div class="flex items-center justify-between gap-3 py-3">
			<span class="text-sm">{{ $t('settings.clearChats') }}</span>
			<UButton color="error" variant="soft" @click="clearConfirmOpen = true">{{ $t('settings.clear') }}</UButton>
		</div>

		<UModal v-model:open="passwordModalOpen" :title="$t('settings.passwordTitle')">
			<template #body>
				<div class="grid gap-3">
					<UInput v-model="pwdForm.currentPassword" type="password" :placeholder="$t('settings.currentPassword')" />
					<UInput v-model="pwdForm.newPassword" type="password" :placeholder="$t('settings.newPassword')" />
					<UInput v-model="pwdForm.confirmPassword" type="password" :placeholder="$t('settings.confirmPassword')" />
				</div>
			</template>
			<template #footer>
				<UButton variant="ghost" @click="passwordModalOpen = false">{{ $t('common.cancel') }}</UButton>
				<UButton @click="onSubmitPasswordChange">{{ $t('settings.change') }}</UButton>
			</template>
		</UModal>

		<UModal v-model:open="clearConfirmOpen" :title="$t('settings.dangerTitle')" :description="$t('settings.dangerDesc')">
			<template #body>
				<UCheckbox v-model="clearAcknowledge" :label="$t('settings.ackDanger')" />
			</template>
			<template #footer>
				<UButton variant="ghost" @click="clearConfirmOpen = false">{{ $t('common.cancel') }}</UButton>
				<UButton color="error" :disabled="!clearAcknowledge" @click="onConfirmClearChats">{{ $t('common.confirm') }}</UButton>
			</template>
		</UModal>
	</div>
</template>

<script>
import { useAuthStore } from '../../stores/auth.store.js';
import { useNotify } from '../../composables/use-notify.js';

export default {
	name: 'UserSettingsPanel',
	setup() {
		return {
			authStore: useAuthStore(),
			notify: useNotify(),
		};
	},
	data() {
		return {
			form: {
				theme: 'dark',
				lang: 'zh-CN',
			},
			passwordModalOpen: false,
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
				{ label: this.$t('settings.langEn'), value: 'en' },
			];
		},
		isLocalAuth() {
			return this.authStore.user?.authType === 'local';
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
			if (!this.pwdForm.currentPassword || !this.pwdForm.newPassword) {
				this.notify.warning(this.$t('settings.needPassword'));
				return;
			}
			if (this.pwdForm.newPassword !== this.pwdForm.confirmPassword) {
				this.notify.warning(this.$t('settings.passwordNotMatch'));
				return;
			}
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
