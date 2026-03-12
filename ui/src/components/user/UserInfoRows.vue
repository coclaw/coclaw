<template>
	<div class="grid gap-0 text-sm">
		<div class="flex items-center justify-between gap-3 min-h-11">
			<span class="text-muted">{{ $t('profile.nickname') }}</span>
			<div class="flex items-center gap-2">
				<span>{{ displayName }}</span>
				<UButton v-if="editable" data-testid="btn-edit-name" class="cc-icon-btn" variant="ghost" color="primary" size="md" icon="i-lucide-pencil" @click="$emit('edit-name')" />
			</div>
		</div>
		<div v-if="isLocalAuth" class="flex items-center justify-between gap-3 min-h-11">
			<span class="text-muted">{{ $t('profile.loginName') }}</span>
			<div class="flex items-center gap-2">
				<span>{{ loginName || '-' }}</span>
				<UButton v-if="editable" class="cc-icon-btn" variant="ghost" color="primary" size="md" icon="i-lucide-copy" @click="$emit('copy-login-name')" />
			</div>
		</div>
		<div class="flex items-center justify-between gap-3 min-h-11">
			<span class="text-muted">{{ $t('profile.authType') }}</span>
			<span>{{ authTypeLabel }}</span>
		</div>
		<div v-if="lastLoginDate" class="flex items-center justify-between gap-3 min-h-11">
			<span class="text-muted">{{ $t('profile.lastLogin') }}</span>
			<span>{{ lastLoginDate }}</span>
		</div>
	</div>
</template>

<script>
import { getUserAuthTypeLabel, getUserDisplayName, getUserLoginName } from '../../utils/user-profile.js';

export default {
	name: 'UserInfoRows',
	props: {
		user: {
			type: Object,
			default: null,
		},
		editable: {
			type: Boolean,
			default: false,
		},
	},
	emits: ['edit-name', 'copy-login-name'],
	computed: {
		displayName() {
			return getUserDisplayName(this.user);
		},
		loginName() {
			return getUserLoginName(this.user);
		},
		authTypeLabel() {
			return getUserAuthTypeLabel(this.user, this.$t);
		},
		isLocalAuth() {
			return this.user?.authType === 'local';
		},
		lastLoginDate() {
			const raw = this.user?.lastLoginAt;
			if (!raw) {
				return '';
			}
			const d = new Date(raw);
			if (Number.isNaN(d.getTime())) {
				return '';
			}
			const y = d.getFullYear();
			const m = String(d.getMonth() + 1).padStart(2, '0');
			const day = String(d.getDate()).padStart(2, '0');
			return `${y}-${m}-${day}`;
		},
	},
};
</script>
