<template>
	<div data-testid="web-agent-picker-panel" class="grid gap-1 py-1">
		<!-- loading 占位（首次加载且 items 为空） -->
		<div
			v-if="store.loading && !store.items.length"
			class="flex items-center justify-center py-8 text-sm text-dimmed"
			data-testid="web-agent-picker-loading"
		>
			<UIcon name="i-lucide-loader-2" class="mr-2 size-4 animate-spin" />
			<span>{{ $t('common.loading') }}</span>
		</div>

		<!-- 错误重试：仅在没有可显示项时占满，避免抹掉已加载的列表 -->
		<div
			v-else-if="store.error && !store.items.length"
			class="flex flex-col items-center gap-3 py-8 text-sm"
			data-testid="web-agent-picker-error"
		>
			<span class="text-error">{{ $t('common.loadFailed') }}</span>
			<UButton variant="soft" @click="onRetry">{{ $t('common.retry') }}</UButton>
		</div>

		<!-- 空态（理论上预置非空时不触发） -->
		<div
			v-else-if="!list.length"
			class="py-8 text-center text-sm text-dimmed"
			data-testid="web-agent-picker-empty"
		>
			{{ $t('webAgents.empty') }}
		</div>

		<!-- 列表 -->
		<button
			v-for="item in list"
			:key="item.id"
			type="button"
			class="flex h-12 items-center gap-3 rounded-lg px-3 text-left text-sm text-default transition-colors hover:bg-accented/80"
			:data-testid="`web-agent-item-${item.slug ?? 'custom-' + item.id}`"
			@click="onSelect(item)"
		>
			<img
				v-if="iconFor(item.slug)"
				:src="iconFor(item.slug)"
				alt=""
				aria-hidden="true"
				class="size-7 shrink-0 rounded-md object-cover"
			/>
			<UIcon
				v-else
				name="i-lucide-globe"
				aria-hidden="true"
				class="size-7 shrink-0 text-dimmed"
			/>
			<span class="min-w-0 flex-1 truncate">{{ item.name }}</span>
		</button>
	</div>
</template>

<script>
import { useWebAgentsStore } from '../../stores/web-agents.store.js';
import { openExternalUrl } from '../../utils/external-url.js';

// 预置图标资源由 S3 落地：assets/web-agents/<slug>.svg
// 这里用 eager glob，资源就绪后无需改组件即可拾取
const iconModules = import.meta.glob('../../assets/web-agents/*.svg', {
	eager: true,
	query: '?url',
	import: 'default',
});
const iconBySlug = {};
for (const [path, url] of Object.entries(iconModules)) {
	const slug = path.match(/\/([^/]+)\.svg$/)?.[1];
	if (slug) iconBySlug[slug] = url;
}

export default {
	name: 'WebAgentPickerPanel',
	emits: ['selected'],
	setup() {
		return { store: useWebAgentsStore() };
	},
	computed: {
		list() {
			return this.store.pickerList;
		},
	},
	mounted() {
		// 首次进入对话框时兜底加载（store loadAll 内部 in-flight 去重）
		this.store.loadAll();
	},
	methods: {
		iconFor(slug) {
			if (!slug) return null;
			return iconBySlug[slug] ?? null;
		},
		onSelect(item) {
			this.store.recordClick(item.id);
			// fire-and-forget：openExternalUrl 内部已兜底，但仍 catch 防止极端环境抛错冒泡
			Promise.resolve(openExternalUrl(item.url)).catch((err) => {
				console.warn('[web-agents] openExternalUrl failed:', err?.message ?? err);
			});
			this.$emit('selected', item);
		},
		onRetry() {
			this.store.loadAll();
		},
	},
};
</script>
