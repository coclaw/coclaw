<template>
	<div class="flex min-h-0 flex-1 flex-col">
		<MobilePageHeader :title="$t('admin.users.title')" />
		<main class="flex-1 overflow-auto px-3 pt-4 pb-8 sm:px-4 lg:px-5">
			<section class="mx-auto flex w-full max-w-3xl flex-col gap-5">
				<header class="hidden items-center justify-between md:flex">
					<h1 class="text-base font-medium">{{ $t('admin.users.title') }}</h1>
					<AdminNavTabs />
				</header>
				<p class="text-sm text-muted">{{ $t('admin.common.comingSoon') }}</p>
			</section>
		</main>
	</div>
</template>

<script>
import MobilePageHeader from '../components/MobilePageHeader.vue';
import AdminNavTabs from '../components/AdminNavTabs.vue';

export default {
	name: 'AdminUsersPage',
	components: { MobilePageHeader, AdminNavTabs },
};
</script>
