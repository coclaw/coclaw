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
						v-model:expanded="expandedState"
						:data="adminStore.claws.items"
						:columns="tableColumns"
						:loading="adminStore.claws.loading"
						:empty="$t('admin.common.noData')"
						:get-row-id="getRowId"
						:on-select="onRowSelect"
						:ui="{ th: 'p-2', td: 'p-2', tr: 'data-[selectable=true]:cursor-pointer' }"
					>
						<template #name-cell="{ row }">
							<span class="inline-flex items-center gap-1.5">
								<UIcon
									:name="row.getIsExpanded() ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
									class="text-dimmed"
								/>
								<span class="font-medium">{{ row.original.name || row.original.hostName || '—' }}</span>
							</span>
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

						<template #expanded="{ row }">
							<div class="text-sm">
								<p v-if="row.original.agentModels === null" class="text-dimmed">
									{{ $t('admin.claws.noAgentModels') }}
								</p>
								<p v-else-if="!row.original.agentModels.length" class="text-dimmed">
									{{ $t('admin.claws.emptyAgents') }}
								</p>
								<table v-else class="w-full">
									<thead>
										<tr class="text-left text-xs text-dimmed">
											<th class="py-1 pr-4 font-normal">{{ $t('admin.claws.expandAgentName') }}</th>
											<th class="py-1 font-normal">{{ $t('admin.claws.expandModel') }}</th>
										</tr>
									</thead>
									<tbody>
										<tr
											v-for="agent in row.original.agentModels"
											:key="agent.id"
										>
											<td class="py-1 pr-4">{{ agent.name || agent.id }}</td>
											<td class="py-1 text-dimmed">{{ agent.model ?? '—' }}</td>
										</tr>
									</tbody>
								</table>
							</div>
						</template>
					</UTable>
				</div>

				<!-- 移动端：卡片降级 + 点击展开 -->
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
						<button
							type="button"
							class="flex w-full items-start justify-between gap-2 text-left"
							@click="toggleMobileExpanded(claw.id)"
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
							<UIcon
								:name="mobileExpanded[claw.id] ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
								class="mt-0.5 shrink-0 text-dimmed"
							/>
						</button>
						<div
							v-if="mobileExpanded[claw.id]"
							class="mt-3 border-t border-default pt-3 text-sm"
						>
							<p v-if="claw.agentModels === null" class="text-dimmed">
								{{ $t('admin.claws.noAgentModels') }}
							</p>
							<p v-else-if="!claw.agentModels.length" class="text-dimmed">
								{{ $t('admin.claws.emptyAgents') }}
							</p>
							<ul v-else class="space-y-1">
								<li
									v-for="agent in claw.agentModels"
									:key="agent.id"
									class="flex items-center justify-between gap-2"
								>
									<span class="truncate">{{ agent.name || agent.id }}</span>
									<span class="shrink-0 text-dimmed">{{ agent.model ?? '—' }}</span>
								</li>
							</ul>
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
			expandedState: {},
			mobileExpanded: {},
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
			this.expandedState = {};
			this.mobileExpanded = {};
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
		onRowSelect(_e, row) {
			row.toggleExpanded();
		},
		toggleMobileExpanded(id) {
			this.mobileExpanded = { ...this.mobileExpanded, [id]: !this.mobileExpanded[id] };
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
