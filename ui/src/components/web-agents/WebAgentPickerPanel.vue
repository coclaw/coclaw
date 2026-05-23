<template>
	<div data-testid="web-agent-picker-panel" class="grid gap-1">
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

		<!-- 列表：用 -mx-3 抵消 px-3，让 icon 左缘与 dialog title 纵向对齐 -->
		<button
			v-for="item in list"
			:key="item.id"
			type="button"
			class="-mx-3 flex h-12 cursor-pointer items-center gap-3 rounded-lg px-3 text-left text-sm text-default transition-colors hover:bg-accented/80"
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
			<!-- vendor 极端长名场景下也参与截断；不写 shrink-0，让 flex 默认 shrink:1 生效 -->
			<!-- 注意：testid 命名故意不落在 `web-agent-item-*` 命名空间下，
			     避免 `[data-testid^="web-agent-item-"]` 前缀枚举把它当成行项目误算入 -->
			<span
				v-if="vendorFor(item.slug)"
				class="min-w-0 truncate text-xs text-muted"
				data-testid="web-agent-row-vendor"
			>{{ vendorFor(item.slug) }}</span>
		</button>
	</div>
</template>

<script>
import { useWebAgentsStore } from '../../stores/web-agents.store.js';
import { openExternalUrl } from '../../utils/external-url.js';

// 预置图标资源由 assets/web-agents/<slug>.{svg,png} 提供，eager glob 拾取
// 部分品牌官方只发 PNG（如 kimi/yuanbao 用 favicon），SVG 优先；混用同 slug 时 SVG 胜出
const iconModules = import.meta.glob('../../assets/web-agents/*.{svg,png}', {
	eager: true,
	query: '?url',
	import: 'default',
});
const iconBySlug = {};
for (const [path, url] of Object.entries(iconModules)) {
	const m = path.match(/\/([^/]+)\.(svg|png)$/);
	if (!m) continue;
	const [, slug, ext] = m;
	// 同 slug 同时存在 svg/png 时让 svg 胜出（矢量优先）
	if (iconBySlug[slug] && ext === 'png') continue;
	iconBySlug[slug] = url;
}

// UModal 关闭动画通常 200ms 内完成；用 300ms 兜底覆盖，避免 destroyOnClose:false 期间重复点击
const SELECT_GUARD_MS = 300;

export default {
	name: 'WebAgentPickerPanel',
	emits: ['selected'],
	setup() {
		return { store: useWebAgentsStore() };
	},
	data() {
		return {
			selecting: false,
		};
	},
	computed: {
		list() {
			return this.store.pickerList;
		},
	},
	mounted() {
		// 首次进入对话框时兜底加载（store loadAll 内部 in-flight 去重 + loaded 短路）
		this.store.loadAll();
	},
	beforeUnmount() {
		if (this.__selectTimer) clearTimeout(this.__selectTimer);
	},
	methods: {
		iconFor(slug) {
			if (!slug) return null;
			return iconBySlug[slug] ?? null;
		},
		vendorFor(slug) {
			if (!slug) return '';
			const key = `webAgents.vendors.${slug}`;
			// 未在该 locale 下声明的 slug 不显示厂商，避免回退成键名
			return this.$te(key) ? this.$t(key) : '';
		},
		onSelect(item) {
			// 防双击：dialog 关闭动画期间 Panel 仍挂载，第二次点击会再开一个浏览器 tab
			if (this.selecting) return;
			this.selecting = true;
			if (this.__selectTimer) clearTimeout(this.__selectTimer);
			this.__selectTimer = setTimeout(() => {
				this.selecting = false;
				this.__selectTimer = null;
			}, SELECT_GUARD_MS);

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
