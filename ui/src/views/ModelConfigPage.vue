<template>
	<div class="flex h-full min-h-0 flex-1 flex-col">
		<!-- 移动端 header（fallback /claws 处理 Electron / Capacitor 冷启 deep link） -->
		<MobilePageHeader :title="$t('modelConfig.title')" fallback="/claws" />

		<!-- 桌面端 header -->
		<header class="z-10 hidden shrink-0 min-h-12 items-center border-b border-default bg-elevated pl-2 py-1 md:flex">
			<UButton
				class="cc-icon-btn-lg shrink-0"
				size="xl"
				variant="ghost"
				color="neutral"
				icon="i-lucide-arrow-left"
				@click="goBack"
			/>
			<h1 class="text-base">{{ $t('modelConfig.title') }}</h1>
		</header>

		<!-- 内容区：T1 仅 stub，T2 替换为真实内容 -->
		<main class="flex-1 min-h-0 overflow-y-auto">
			<div class="mx-auto w-full max-w-2xl px-4 py-5 text-sm text-muted">
				<p>TBD — claw: {{ clawId }}</p>
			</div>
		</main>
	</div>
</template>

<script>
import MobilePageHeader from '../components/MobilePageHeader.vue';
import { navBack } from '../utils/nav-back.js';

export default {
	name: 'ModelConfigPage',
	components: {
		MobilePageHeader,
	},
	computed: {
		clawId() {
			return this.$route?.params?.clawId ?? '';
		},
	},
	methods: {
		goBack() {
			navBack(this.$router, '/claws');
		},
	},
};
</script>
