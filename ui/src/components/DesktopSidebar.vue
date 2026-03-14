<template>
	<aside
		class="sticky top-0 hidden h-screen flex-shrink-0 border-r border-default bg-elevated text-highlighted md:flex md:flex-col"
		:style="{ width: uiStore.drawerWidth + 'px' }"
	>
		<div class="flex min-h-0 flex-1 flex-col">
			<div class="flex min-h-12 items-center gap-2 pl-3.5 pr-2 py-1">
				<img :src="logoSrc" alt="CoClaw" class="size-7 rounded" />
				<span class="flex-1 truncate text-base font-semibold">{{ $t('layout.productName') }}</span>
				<!-- TODO: 收起/展开 drawer 功能完成后恢复
				<UButton
					variant="ghost"
					color="neutral"
					icon="i-lucide-menu"
					class="h-11 w-11 items-center justify-center rounded-lg"
				/>
				-->
			</div>
			<MainList :current-path="currentPath" :show-bot-actions="true" scrollable />
		</div>

		<div class="border-t border-default px-2 py-1">
			<UPopover v-model:open="menuOpen" :content="{ side: 'top', align: 'center' }">
				<UButton
					data-testid="user-menu-trigger"
					variant="ghost"
					color="neutral"
					class="h-11 w-full justify-start gap-3 rounded-lg px-2 text-sm"
				>
					<span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-white">{{ userDisplayName.slice(0, 1).toUpperCase() }}</span>
					<span data-testid="session-user" class="flex-1 truncate text-left">{{ userDisplayName }}</span>
					<UIcon :name="menuOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'" class="size-4 text-muted" />
				</UButton>

				<template #content>
					<div class="bg-elevated p-2" :style="{ width: (uiStore.drawerWidth - 16) + 'px' }">
						<template v-for="item in userMenuItems" :key="item.id">
							<div v-if="item.separator" class="my-1 border-t border-default" />
							<button
								type="button"
								class="flex h-11 w-full items-center gap-3 rounded-lg px-2 py-1 text-left text-sm text-highlighted hover:bg-accented"
								:data-testid="item.id === 'logout' ? 'btn-logout' : null"
								@click="onMenuItemClick(item.id)"
							>
								<UIcon :name="item.icon" class="size-5" />
								<span>{{ item.label }}</span>
							</button>
						</template>
					</div>
				</template>
			</UPopover>
		</div>
	</aside>
</template>

<script>
import MainList from './MainList.vue';
import { getUserMenuItems } from '../constants/layout.data.js';
import { useUserDialogs } from '../composables/use-user-dialogs.js';
import { getUserDisplayName } from '../utils/user-profile.js';
import { useUiStore } from '../stores/ui.store.js';
import logoSrc from '../assets/coclaw-logo.jpg';

export default {
	name: 'DesktopSidebar',
	components: {
		MainList,
	},
	props: {
		currentPath: {
			type: String,
			default: '',
		},
		user: {
			type: Object,
			default: null,
		},
	},
	emits: ['logout'],
	setup() {
		return {
			userDialogs: useUserDialogs(),
			uiStore: useUiStore(),
		};
	},
	data() {
		return {
			logoSrc,
			menuOpen: false,
		};
	},
	computed: {
		userMenuItems() {
			return getUserMenuItems(this.$t);
		},
		userDisplayName() {
			return getUserDisplayName(this.user);
		},
	},
	methods: {
		onMenuItemClick(itemId) {
			this.menuOpen = false;
			if (itemId === 'logout') {
				this.$emit('logout');
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
			}
		},
	},
};
</script>
