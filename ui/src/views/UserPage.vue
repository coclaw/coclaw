<template>
	<main class="flex-1 overflow-auto">
		<div class="mx-auto w-full max-w-3xl">
			<div class="flex items-center gap-4 px-4 py-5">
				<span
					class="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary text-base font-medium text-white transition-transform hover:scale-110"
					@click="userDialogs.openProfileDialog()"
				>{{ displayName.slice(0, 1).toUpperCase() }}</span>
				<div class="min-w-0 flex-1">
					<p class="text-base font-medium">{{ loginName }}</p>
					<p class="text-xs text-dimmed">{{ userId }}</p>
				</div>
			</div>

			<nav class="mt-2">
				<template v-for="item in menuItems" :key="item.id">
					<div v-if="item.separator" class="my-1 border-t border-default" />
					<button
						:data-testid="'menu-' + item.id"
						type="button"
						class="flex h-11 w-full items-center gap-3 px-4 py-1 text-left text-sm text-highlighted hover:bg-accented/80"
						@click="onMenuClick(item.id)"
					>
						<UIcon :name="item.icon" class="size-5 text-muted" />
						<span>{{ item.label }}</span>
					</button>
				</template>
			</nav>
		</div>
	</main>
</template>

<script>
import { getUserMenuItems } from '../constants/layout.data.js';
import { useUserDialogs } from '../composables/use-user-dialogs.js';
import { useAuthStore } from '../stores/auth.store.js';
import { getUserDisplayName, getUserLoginName } from '../utils/user-profile.js';

export default {
	name: 'UserPage',
	setup() {
		return {
			authStore: useAuthStore(),
			userDialogs: useUserDialogs(),
		};
	},
	computed: {
		displayName() {
			return getUserDisplayName(this.authStore.user);
		},
		loginName() {
			return getUserLoginName(this.authStore.user) || this.displayName;
		},
		userId() {
			return this.authStore.user?.id || '-';
		},
		menuItems() {
			return getUserMenuItems(this.$t, { isAdmin: this.authStore.user?.level === -100 });
		},
	},
	methods: {
		onMenuClick(itemId) {
			if (itemId === 'admin-dashboard') {
				this.$router.push('/admin/dashboard');
				return;
			}
			if (itemId === 'logout') {
				this.authStore.logout().then(() => {
					this.$router.replace('/about');
				});
				return;
			}
			if (itemId === 'about') {
				this.$router.push('/about');
				return;
			}
			if (itemId === 'settings') {
				this.userDialogs.openSettingsDialog();
				return;
			}
			if (itemId === 'profile') {
				this.userDialogs.openProfileDialog();
				return;
			}
		},
	},
};
</script>
