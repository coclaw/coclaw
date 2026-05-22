<template>
	<div class="flex min-h-0 flex-1 flex-col">
		<MobilePageHeader :title="$t('admin.claws.title')" />
		<main class="flex-1 overflow-auto px-3 pt-4 pb-8 sm:px-4 lg:px-5">
			<section class="mx-auto flex w-full max-w-5xl flex-col gap-4">
				<header class="hidden items-center justify-between md:flex">
					<h1 class="text-base font-medium">{{ $t('admin.dashboard.title') }}</h1>
					<AdminNavTabs />
				</header>

				<UInput
					v-model="searchInput"
					:placeholder="$t('admin.claws.searchPlaceholder')"
					icon="i-lucide-search"
					size="lg"
					class="w-full md:w-80"
					:ui="{ base: 'leading-normal' }"
				/>

				<p v-if="adminStore.claws.error" class="text-sm text-error">{{ adminStore.claws.error }}</p>

				<!-- 桌面端：UTable -->
				<div class="hidden lg:block">
					<UTable
						:data="adminStore.claws.items"
						:columns="tableColumns"
						:loading="adminStore.claws.loading"
						:empty="$t('admin.common.noData')"
						:get-row-id="getRowId"
						:ui="{ th: 'p-2', td: 'p-2' }"
					>
						<template #name-cell="{ row }">
							<span class="font-medium">{{ row.original.name || row.original.hostName || '—' }}</span>
						</template>

						<template #online-cell="{ row }">
							<span class="inline-flex items-center gap-1.5 text-sm">
								<span
									:class="[
										'h-2 w-2 rounded-full',
										row.original.online ? 'bg-green-500' : 'bg-neutral-400',
									]"
									:aria-label="row.original.online ? $t('admin.common.online') : $t('admin.common.offline')"
								></span>
								<span>{{ row.original.online ? $t('admin.common.online') : $t('admin.common.offline') }}</span>
							</span>
						</template>

						<template #user-cell="{ row }">
							<span class="text-sm">{{ row.original.userName || row.original.userLoginName || '—' }}</span>
						</template>

						<template #pluginVersion-cell="{ row }">
							<span class="text-sm">{{ row.original.pluginVersion ?? '—' }}</span>
						</template>

						<template #createdAt-cell="{ row }">
							<span class="text-sm text-dimmed">{{ formatTimeAgo(row.original.createdAt) }}</span>
						</template>
					</UTable>
				</div>

				<!-- 移动端：卡片降级（仅摘要，无展开） -->
				<div class="space-y-3 lg:hidden">
					<p
						v-if="!adminStore.claws.items.length && !adminStore.claws.loading"
						class="text-sm text-dimmed"
					>
						{{ $t('admin.common.noData') }}
					</p>
					<article
						v-for="claw in adminStore.claws.items"
						:key="claw.id"
						class="rounded-xl bg-elevated p-3"
					>
						<div class="flex min-w-0 flex-col gap-1">
							<div class="flex items-center gap-2">
								<span
									:class="[
										'h-2 w-2 shrink-0 rounded-full',
										claw.online ? 'bg-green-500' : 'bg-neutral-400',
									]"
									:aria-label="claw.online ? $t('admin.common.online') : $t('admin.common.offline')"
								></span>
								<span class="truncate font-medium">{{ claw.name || claw.hostName || '—' }}</span>
							</div>
							<div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-dimmed">
								<span v-if="claw.userName || claw.userLoginName">
									{{ claw.userName || claw.userLoginName }}
								</span>
								<span>v{{ claw.pluginVersion ?? '—' }}</span>
								<span>{{ formatTimeAgo(claw.createdAt) }}</span>
							</div>
						</div>
					</article>
				</div>

				<!-- 加载更多 -->
				<div v-if="adminStore.claws.nextCursor" class="flex justify-center">
					<UButton
						variant="soft"
						size="sm"
						:loading="adminStore.claws.loading"
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
	name: 'AdminClawsPage',
	components: { MobilePageHeader, AdminNavTabs },
	setup() {
		return { notify: useNotify(), adminStore: useAdminStore() };
	},
	data() {
		return {
			searchInput: this.adminStore.claws.search ?? '',
		};
	},
	computed: {
		tableColumns() {
			return [
				{ id: 'name', accessorKey: 'name', header: this.$t('admin.claws.columnName') },
				{ id: 'online', accessorKey: 'online', header: this.$t('admin.claws.columnStatus') },
				{ id: 'user', accessorKey: 'userName', header: this.$t('admin.claws.columnUser') },
				{ id: 'pluginVersion', accessorKey: 'pluginVersion', header: this.$t('admin.claws.columnVersion') },
				{ id: 'createdAt', accessorKey: 'createdAt', header: this.$t('admin.claws.columnCreatedAt') },
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
			await this.adminStore.fetchClaws();
		}
		catch (err) {
			console.warn('[AdminClawsPage] fetchClaws failed:', err);
			this.notify.error(this.__pickErrMsg(err));
		}
	},
	beforeUnmount() {
		clearTimeout(this.__searchTimer);
	},
	methods: {
		async doSearch(q) {
			this.adminStore.resetClaws();
			try {
				await this.adminStore.fetchClaws({ search: q });
			}
			catch (err) {
				console.warn('[AdminClawsPage] search failed:', err);
				this.notify.error(this.__pickErrMsg(err));
			}
		},
		async loadMore() {
			try {
				await this.adminStore.fetchMoreClaws();
			}
			catch (err) {
				console.warn('[AdminClawsPage] loadMore failed:', err);
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
