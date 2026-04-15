<template>
	<div class="flex min-h-0 flex-1 flex-col">
		<MobilePageHeader :title="$t('admin.users.title')" />
		<main class="flex-1 overflow-auto px-3 pt-4 pb-8 sm:px-4 lg:px-5">
			<section class="mx-auto flex w-full max-w-4xl flex-col gap-4">
				<header class="hidden items-center justify-between md:flex">
					<h1 class="text-base font-medium">{{ $t('admin.users.title') }}</h1>
					<AdminNavTabs />
				</header>

				<UInput
					v-model="searchInput"
					:placeholder="$t('admin.users.searchPlaceholder')"
					icon="i-lucide-search"
					size="md"
					class="w-full md:w-80"
				/>

				<p v-if="adminStore.users.error" class="text-sm text-error">{{ adminStore.users.error }}</p>

				<!-- 桌面端：UTable -->
				<div class="hidden md:block">
					<UTable
						:data="adminStore.users.items"
						:columns="tableColumns"
						:loading="adminStore.users.loading"
						:empty="$t('admin.common.noData')"
						:get-row-id="getRowId"
					>
						<template #name-cell="{ row }">
							<span class="font-medium">{{ row.original.name || row.original.loginName || '—' }}</span>
						</template>

						<template #loginName-cell="{ row }">
							<span class="text-sm text-dimmed">{{ row.original.loginName ?? '—' }}</span>
						</template>

						<template #clawCount-cell="{ row }">
							<span class="text-sm">{{ row.original.clawCount ?? 0 }}</span>
						</template>

						<template #createdAt-cell="{ row }">
							<span class="text-sm text-dimmed">{{ formatTimeAgo(row.original.createdAt) }}</span>
						</template>

						<template #lastLoginAt-cell="{ row }">
							<span class="text-sm text-dimmed">{{ formatTimeAgo(row.original.lastLoginAt) }}</span>
						</template>
					</UTable>
				</div>

				<!-- 移动端：卡片降级 -->
				<div class="space-y-3 md:hidden">
					<p
						v-if="!adminStore.users.items.length && !adminStore.users.loading"
						class="text-sm text-dimmed"
					>
						{{ $t('admin.common.noData') }}
					</p>
					<article
						v-for="user in adminStore.users.items"
						:key="user.id"
						class="rounded-xl bg-elevated p-3"
					>
						<div class="flex items-start justify-between gap-2">
							<div class="flex min-w-0 flex-col gap-1">
								<span class="truncate font-medium">{{ user.name || user.loginName || '—' }}</span>
								<div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-dimmed">
									<span v-if="user.loginName">@{{ user.loginName }}</span>
									<span>{{ $t('admin.users.columnClawCount') }}: {{ user.clawCount ?? 0 }}</span>
								</div>
								<div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-dimmed">
									<span>{{ $t('admin.users.columnCreatedAt') }}: {{ formatTimeAgo(user.createdAt) }}</span>
									<span>{{ $t('admin.users.columnLastLogin') }}: {{ formatTimeAgo(user.lastLoginAt) }}</span>
								</div>
							</div>
						</div>
					</article>
				</div>

				<!-- 加载更多 -->
				<div v-if="adminStore.users.nextCursor" class="flex justify-center">
					<UButton
						variant="soft"
						size="sm"
						:loading="adminStore.users.loading"
						@click="loadMore"
					>
						{{ $t('admin.common.loadMore') }}
					</UButton>
				</div>
			</section>
		</main>
	</div>
</template>

<script>
import { useNotify } from '../composables/use-notify.js';
import { useAdminStore } from '../stores/admin.store.js';
import MobilePageHeader from '../components/MobilePageHeader.vue';
import AdminNavTabs from '../components/AdminNavTabs.vue';

const SEARCH_DEBOUNCE_MS = 300;

export default {
	name: 'AdminUsersPage',
	components: { MobilePageHeader, AdminNavTabs },
	setup() {
		return { notify: useNotify(), adminStore: useAdminStore() };
	},
	data() {
		return {
			searchInput: '',
		};
	},
	computed: {
		tableColumns() {
			return [
				{ id: 'name', accessorKey: 'name', header: this.$t('admin.users.columnName') },
				{ id: 'loginName', accessorKey: 'loginName', header: this.$t('admin.users.columnLoginName') },
				{ id: 'clawCount', accessorKey: 'clawCount', header: this.$t('admin.users.columnClawCount') },
				{ id: 'createdAt', accessorKey: 'createdAt', header: this.$t('admin.users.columnCreatedAt') },
				{ id: 'lastLoginAt', accessorKey: 'lastLoginAt', header: this.$t('admin.users.columnLastLogin') },
			];
		},
	},
	watch: {
		searchInput(next) {
			clearTimeout(this.__searchTimer);
			this.__searchTimer = setTimeout(() => {
				this.doSearch(next);
			}, SEARCH_DEBOUNCE_MS);
		},
	},
	async mounted() {
		this.__searchTimer = null;
		try {
			await this.adminStore.fetchUsers();
		}
		catch (err) {
			console.warn('[AdminUsersPage] fetchUsers failed:', err);
			this.notify.error(this.__pickErrMsg(err));
		}
	},
	beforeUnmount() {
		clearTimeout(this.__searchTimer);
	},
	methods: {
		async doSearch(q) {
			this.adminStore.resetUsers();
			try {
				await this.adminStore.fetchUsers({ search: q });
			}
			catch (err) {
				console.warn('[AdminUsersPage] search failed:', err);
				this.notify.error(this.__pickErrMsg(err));
			}
		},
		async loadMore() {
			try {
				await this.adminStore.fetchMoreUsers();
			}
			catch (err) {
				console.warn('[AdminUsersPage] loadMore failed:', err);
				this.notify.error(this.__pickErrMsg(err));
			}
		},
		getRowId(row) {
			return String(row.id);
		},
		formatTimeAgo(iso) {
			if (!iso) return '—';
			const diff = (Date.now() - new Date(iso).getTime()) / 1000;
			if (diff < 0 || Number.isNaN(diff)) return '—';
			if (diff < 60) return this.$t('dashboard.justNow');
			if (diff < 3600) return this.$t('dashboard.minutesAgo', { n: Math.floor(diff / 60) });
			if (diff < 86400) return this.$t('dashboard.hoursAgo', { n: Math.floor(diff / 3600) });
			return this.$t('dashboard.daysAgo', { n: Math.floor(diff / 86400) });
		},
		__pickErrMsg(err) {
			return err?.response?.data?.message ?? err?.message ?? 'Load failed';
		},
	},
};
</script>
