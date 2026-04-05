<template>
	<div class="fixed bottom-0 left-0 right-0 z-20 border-t border-default bg-elevated pb-[var(--safe-area-inset-bottom)] md:hidden">
		<UTabs
			v-model="activeTab"
			:items="mobileTabs"
			:content="false"
			color="neutral"
			variant="link"
			class="w-full"
			:ui="ui"
		>
			<template #leading="{ item, ui: tabUi }">
				<UAvatar
					v-if="item.avatar"
					v-bind="item.avatar"
					:class="tabUi.leadingIcon()"
				/>
				<UIcon
					v-else-if="item.icon"
					:name="item.icon"
					:class="tabUi.leadingIcon()"
				/>
			</template>
		</UTabs>
	</div>
</template>

<script>
import { getMobileTabs } from '../constants/layout.data.js';

export default {
	name: 'MobileBottomTabs',
	props: {
		currentPath: {
			type: String,
			default: '',
		},
	},
	data() {
		return {
			activeTab: 'chat',
			ui: {
				list: 'h-13 w-full gap-0 rounded-none border-none bg-transparent p-0',
				trigger: 'h-13 flex-1 flex-col gap-0.5 rounded-none text-xs',
				indicator: 'hidden',
			},
		};
	},
	computed: {
		mobileTabs() {
			return getMobileTabs(this.$t);
		},
	},
	watch: {
		currentPath: {
			immediate: true,
			handler(path) {
				this.activeTab = this.__routeToTab(path);
			},
		},
		activeTab(val) {
			this.__navigateByTab(val);
		},
	},
	methods: {
		__routeToTab(path) {
			if (path.startsWith('/claws')) {
				return 'claws';
			}
			if (path.startsWith('/user')) {
				return 'me';
			}
			return 'chat';
		},
		__navigateByTab(tabValue) {
			const tab = this.mobileTabs.find((item) => item.value === tabValue);
			if (!tab || tab.to === this.currentPath) {
				return;
			}
			this.$router.push(tab.to);
		},
	},
};
</script>
