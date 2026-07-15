<template>
	<div class="flex min-h-0 flex-1 flex-col">
		<MobilePageHeader :title="$t('notices.title')" fallback="/about" />
		<main class="flex-1 overflow-auto px-4 py-5 lg:px-5">
			<div class="mx-auto w-full max-w-3xl">
				<h1 class="hidden text-xl font-semibold md:block">{{ $t('notices.title') }}</h1>
				<p class="text-sm text-toned md:mt-3">{{ $t('notices.intro') }}</p>
				<!-- Android 原生壳：跳 Google oss-licenses 标准界面（覆盖 Maven 原生组件） -->
				<div v-if="nativeLicensesAvailable" class="mt-4">
					<UButton
						data-testid="btn-native-licenses"
						variant="outline"
						color="neutral"
						icon="i-lucide-smartphone"
						@click="openNativeLicenses"
					>{{ $t('notices.androidNative') }}</UButton>
					<!-- 诚实说明：oss-licenses 按 POM 收集，部分组件仅有许可链接/标题 -->
					<p data-testid="native-licenses-desc" class="mt-2 text-xs text-dimmed">{{ $t('notices.androidNativeDesc') }}</p>
				</div>
				<div v-if="loading" class="flex justify-center py-10" data-testid="notices-loading">
					<UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-dimmed" />
				</div>
				<!-- 被动加载失败：内联错误卡 + 重试，不走 toast -->
				<div v-else-if="error" class="mt-6 flex flex-col items-center gap-3 rounded-lg bg-elevated px-4 py-6" data-testid="notices-error">
					<p class="text-sm text-toned">{{ $t('notices.loadFailed') }}</p>
					<UButton size="sm" variant="outline" color="neutral" @click="load">{{ $t('notices.retry') }}</UButton>
				</div>
				<pre v-else data-testid="notices-content" class="mt-4 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted">{{ text }}</pre>
			</div>
		</main>
	</div>
</template>

<script>
import axios from 'axios';

import MobilePageHeader from '../components/MobilePageHeader.vue';
import { useNotify } from '../composables/use-notify.js';

export default {
	name: 'OpenSourceNoticesPage',
	components: {
		MobilePageHeader,
	},
	setup() {
		return { notify: useNotify() };
	},
	data() {
		const Cap = window.Capacitor;
		return {
			loading: true,
			error: false,
			text: '',
			// Android 原生壳且 APK 已带 OssLicenses 插件才显示入口（旧 APK 无插件时隐藏，避免死按钮）
			nativeLicensesAvailable: !!Cap?.isNativePlatform?.()
				&& Cap?.getPlatform?.() === 'android'
				&& !!Cap?.isPluginAvailable?.('OssLicenses'),
		};
	},
	mounted() {
		this.load();
	},
	methods: {
		async load() {
			this.loading = true;
			this.error = false;
			try {
				// public 静态文件；带版本参数防部署后拿到陈旧缓存
				const res = await axios.get(`/third-party-notices.txt?v=${__APP_VERSION__}`, {
					responseType: 'text',
					transformResponse: [(d) => d],
				});
				this.text = res.data;
			}
			catch (err) {
				console.warn('[NoticesPage] load failed:', err);
				this.error = true;
			}
			finally {
				this.loading = false;
			}
		},
		async openNativeLicenses() {
			try {
				// 动态 import：仅原生壳路径触达，避免 Web 环境静态引入 @capacitor/core
				const { registerPlugin } = await import('@capacitor/core');
				const OssLicenses = registerPlugin('OssLicenses');
				await OssLicenses.open({ title: this.$t('notices.androidNative') });
			}
			catch (err) {
				console.warn('[NoticesPage] open native licenses failed:', err);
				this.notify.error(this.$t('notices.nativeOpenFailed'));
			}
		},
	},
};
</script>
