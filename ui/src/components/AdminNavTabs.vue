<template>
	<nav class="hidden gap-2 md:flex" role="tablist">
		<RouterLink
			v-for="tab in tabs"
			:key="tab.value"
			:to="tab.to"
			role="tab"
			:aria-selected="currentValue === tab.value"
			:class="[
				'rounded-lg px-3 py-1.5 text-sm transition-colors',
				currentValue === tab.value
					? 'bg-elevated font-medium text-default'
					: 'text-muted hover:bg-elevated hover:text-default',
			]"
		>
			{{ $t(tab.labelKey) }}
		</RouterLink>
	</nav>
</template>

<script>
import { RouterLink } from 'vue-router';

const TABS = [
	{ value: 'dashboard', to: '/admin/dashboard', labelKey: 'admin.nav.dashboard' },
	{ value: 'claws', to: '/admin/claws', labelKey: 'admin.nav.claws' },
	{ value: 'users', to: '/admin/users', labelKey: 'admin.nav.users' },
];

export default {
	name: 'AdminNavTabs',
	components: { RouterLink },
	computed: {
		tabs() {
			return TABS;
		},
		currentValue() {
			const path = this.$route?.path ?? '';
			if (path.startsWith('/admin/claws')) return 'claws';
			if (path.startsWith('/admin/users')) return 'users';
			return 'dashboard';
		},
	},
};
</script>
