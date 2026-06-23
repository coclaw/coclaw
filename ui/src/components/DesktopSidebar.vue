<template>
	<aside
		class="cc-desktop-sidebar sticky top-0 hidden h-screen flex-shrink-0 border-r border-default bg-elevated pt-[var(--safe-area-inset-top)] pb-[var(--safe-area-inset-bottom)] md:flex md:flex-col"
		:style="{ width: uiStore.drawerWidth + 'px' }"
	>
		<div class="flex min-h-0 flex-1 flex-col">
			<!-- cc-sidebar-top：惰性 marker，仅 main.css 内「原生全高侧栏」可选方案启用时生效；web / L 形默认下零影响 -->
			<!-- Windows Electron 标题栏左侧已显示 logo+"CoClaw"（自定义栏自绘、forceNative 原生栏系统自带），此处品牌行冗余，整行隐藏 -->
			<div v-if="showSidebarBrand" class="cc-sidebar-top flex min-h-12 items-center gap-2 pl-3.5 pr-2 py-1">
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
			<!-- 品牌行隐藏时（Windows Electron）补 8px 顶间距，避免列表贴顶 -->
			<MainList :current-path="currentPath" :class="{ 'pt-2': !showSidebarBrand }" scrollable instance="sidebar" />
		</div>

		<div class="border-t border-default px-2 py-1">
			<!-- 内容宽度钉回原 popover 宽度：原 popover shrink-wrap 到触发按钮宽（px-2 容器内的 w-full
			     按钮 = drawerWidth-16，距侧栏边各约 8px 内缩）。全局 dropdownMenu 主题默认内容自适应
			     （min-w-0 max-w-60），这里用 reka 暴露在弹层上的锚点（触发器）宽度变量
			     --reka-popper-anchor-width 复刻该按钮宽；max-w-none 解除默认 240px 上限（drawerWidth 最大 384px） -->
			<UDropdownMenu
				v-model:open="menuOpen"
				:items="userMenuDropdownItems"
				:content="{ side: 'top', align: 'center' }"
				:modal="false"
				:ui="{ content: 'w-[var(--reka-popper-anchor-width)] max-w-none' }"
			>
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

				<template #item-label="{ item }">
					<span :data-testid="item.testid">{{ item.label }}</span>
				</template>
			</UDropdownMenu>
		</div>
	</aside>
</template>

<script>
import MainList from './MainList.vue';
import { getUserMenuItems } from '../constants/layout.data.js';
import { useUserDialogs } from '../composables/use-user-dialogs.js';
import { useWebAgentDialogs } from '../composables/use-web-agent-dialogs.js';
import { getUserDisplayName } from '../utils/user-profile.js';
import { useUiStore } from '../stores/ui.store.js';
import { useEnvStore } from '../stores/env.store.js';
import { isElectronApp } from '../utils/platform.js';
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
			webAgentDialogs: useWebAgentDialogs(),
			uiStore: useUiStore(),
			envStore: useEnvStore(),
		};
	},
	data() {
		return {
			logoSrc,
			menuOpen: false,
		};
	},
	computed: {
		// Windows Electron 隐藏品牌行：标题栏左侧已放品牌（自定义栏自绘、forceNative 原生栏系统自带 icon+标题）；
		// macOS Electron / Linux Electron / 各浏览器保留（mac 标题栏无品牌惯例，身份靠系统菜单栏+侧边栏）
		showSidebarBrand() {
			return !(isElectronApp && this.envStore.isWin);
		},
		// 把 getUserMenuItems 形状（{ id, label, icon, separator? }）映射成 UDropdownMenu 扁平 items：
		// separator:true 项前先插一条 { type: 'separator' }（分隔线渲染在该项上方），logout 项透传 testid 供 #item-label 落到 DOM
		userMenuDropdownItems() {
			const items = [];
			for (const item of getUserMenuItems(this.$t, { isAdmin: this.user?.level === -100 })) {
				if (item.separator === true) {
					items.push({ type: 'separator' });
				}
				items.push({
					label: item.label,
					icon: item.icon,
					testid: item.id === 'logout' ? 'btn-logout' : undefined,
					onSelect: () => this.onMenuItemClick(item.id),
				});
			}
			return items;
		},
		userDisplayName() {
			return getUserDisplayName(this.user);
		},
	},
	methods: {
		onMenuItemClick(itemId) {
			this.menuOpen = false;
			if (itemId === 'admin-dashboard') {
				this.$router.push('/admin/dashboard');
				return;
			}
			if (itemId === 'logout') {
				this.$emit('logout');
				return;
			}
			if (itemId === 'about') {
				this.$router.push('/about');
				return;
			}
			if (itemId === 'add-claw') {
				this.$router.push('/claws/add');
				return;
			}
			if (itemId === 'add-web-agent') {
				this.webAgentDialogs.openPickerDialog();
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
