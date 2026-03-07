<template>
	<div class="grid gap-4">
		<div class="flex flex-col items-center gap-3 pb-4">
			<span class="flex size-16 shrink-0 items-center justify-center rounded-full bg-primary text-2xl font-medium text-white">{{ displayName.slice(0, 1).toUpperCase() }}</span>
			<p class="text-base font-medium">{{ displayName }}</p>
		</div>

		<UserInfoRows :user="authStore.user" editable @edit-name="openNameModal = true" @copy-login-name="onCopyLoginName" />

		<UModal v-model:open="openNameModal" :title="$t('profile.editName')">
			<template #body>
				<div class="flex items-center gap-2">
					<UInput v-model="nameForm" :placeholder="$t('profile.nicknamePlaceholder')" class="flex-1" @keydown.enter="onSaveName" />
					<UButton :loading="authStore.loading" @click="onSaveName">{{ $t('common.save') }}</UButton>
				</div>
			</template>
		</UModal>
	</div>
</template>

<script>
import { useAuthStore } from '../../stores/auth.store.js';
import { useNotify } from '../../composables/use-notify.js';
import { getUserDisplayName, getUserLoginName } from '../../utils/user-profile.js';
import UserInfoRows from './UserInfoRows.vue';

export default {
	name: 'UserProfilePanel',
	components: {
		UserInfoRows,
	},
	setup() {
		return {
			authStore: useAuthStore(),
			notify: useNotify(),
		};
	},
	data() {
		return {
			openNameModal: false,
			nameForm: '',
		};
	},
	computed: {
		displayName() {
			return getUserDisplayName(this.authStore.user);
		},
		loginName() {
			return getUserLoginName(this.authStore.user);
		},
	},
	watch: {
		'authStore.user': {
			immediate: true,
			handler(user) {
				this.nameForm = user?.name ?? '';
			},
		},
	},
	methods: {
		async onSaveName() {
			await this.authStore.updateProfile({
				name: this.nameForm || null,
			});
			if (!this.authStore.errorMessage) {
				this.notify.success(this.$t('profile.nameUpdated'));
				this.openNameModal = false;
			} else {
				this.notify.error(this.authStore.errorMessage);
			}
		},
		async onCopyLoginName() {
			try {
				await navigator.clipboard.writeText(this.loginName);
				this.notify.success(this.$t('profile.loginNameCopied'));
			} catch {
				this.notify.error(this.$t('profile.copyFailed'));
			}
		},
	},
};
</script>
