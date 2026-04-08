<template>
	<div class="flex min-h-0 flex-1 flex-col">
		<MobilePageHeader :title="$t('about.title')" />
	<main class="flex-1 overflow-auto px-4 py-5 lg:px-5">
		<div class="mx-auto w-full max-w-xl">
			<img :src="logoSrc" alt="CoClaw" class="mx-auto mb-4 size-16 rounded-xl" />
			<h1 v-if="false" class="hidden text-center text-xl font-semibold md:block">{{ $t('about.title') }}</h1>
			<p class="flex justify-center text-base text-toned md:mt-4">{{ $t('about.intro') }}</p>

			<div class="mt-4">
				<UAccordion :items="accordionItems" collapsible :unmount-on-hide="false" :ui="{ trigger: 'text-base' }">
					<template #highlights-body>
						<div class="space-y-3 text-sm text-muted leading-relaxed">
							<p><strong class="text-default">{{ $t('about.hlNativeApp') }}</strong>{{ $t('about.hlNativeAppDesc') }}</p>
							<p><strong class="text-default">{{ $t('about.hlTopic') }}</strong>{{ $t('about.hlTopicDesc') }}</p>
							<p><strong class="text-default">{{ $t('about.hlP2P') }}</strong>{{ $t('about.hlP2PDesc') }}</p>
							<p><strong class="text-default">{{ $t('about.hlFileBrowser') }}</strong>{{ $t('about.hlFileBrowserDesc') }}</p>
							<p><strong class="text-default">{{ $t('about.hlMultimodal') }}</strong>{{ $t('about.hlMultimodalDesc') }}</p>
						</div>
					</template>
					<!--
						用户信息手风琴项暂时注释。
						"我的"页面已有完整用户资料展示，About 页不再重复。
						短期内保留代码，暂不作为死代码清理。
					-->
					<!-- <template v-if="isLoggedIn" #user-info-body>
						<UserInfoRows :user="authStore.user" />
					</template> -->
					<template #guide-body>
						<div class="space-y-3 text-sm text-muted leading-relaxed">
							<p><strong class="text-default">{{ $t('about.guideBind') }}</strong>{{ $t('about.guideBindDesc') }}</p>
							<p><strong class="text-default">{{ $t('about.guideChat') }}</strong>{{ $t('about.guideChatDesc') }}</p>
							<p><strong class="text-default">{{ $t('about.guideTopic') }}</strong>{{ $t('about.guideTopicDesc') }}</p>
							<p><strong class="text-default">{{ $t('about.guideAttach') }}</strong>{{ $t('about.guideAttachDesc') }}</p>
							<p><strong class="text-default">{{ $t('about.guideFile') }}</strong>{{ $t('about.guideFileDesc') }}</p>
							<p><strong class="text-default">{{ $t('about.guideManageClaw') }}</strong>{{ $t('about.guideManageClawDesc') }}</p>
						</div>
					</template>
					<template #concepts-body>
						<div class="space-y-3 text-sm text-muted leading-relaxed">
							<p><strong class="text-default">{{ $t('about.conceptAgent') }}</strong>{{ $t('about.conceptAgentDesc') }}</p>
							<p><strong class="text-default">{{ $t('about.conceptClaw') }}</strong>{{ $t('about.conceptClawDesc') }}</p>
							<p><strong class="text-default">{{ $t('about.conceptClawAgent') }}</strong>{{ $t('about.conceptClawAgentDesc') }}</p>
							<p><strong class="text-default">{{ $t('about.conceptOnline') }}</strong>{{ $t('about.conceptOnlineDesc') }}</p>
							<p><strong class="text-default">{{ $t('about.conceptFlow') }}</strong>{{ $t('about.conceptFlowDesc') }}</p>
							<p><strong class="text-default">{{ $t('about.conceptTopic') }}</strong>{{ $t('about.conceptTopicDesc') }}</p>
							<p><strong class="text-default">{{ $t('about.conceptMemory') }}</strong>{{ $t('about.conceptMemoryDesc') }}</p>
							<p><strong class="text-default">{{ $t('about.conceptSession') }}</strong>{{ $t('about.conceptSessionDesc') }}</p>
						</div>
					</template>
				</UAccordion>
			</div>

			<!-- 云部署引导 -->
			<div class="mt-6 flex justify-center">
				<div class="flex flex-col items-center gap-2.5">
					<h2 class="text-base font-medium">{{ $t('about.cloudDeploy') }}</h2>
					<p class="text-sm text-toned">{{ $t('about.cloudDeployDesc') }}</p>
					<UButton
						class="mt-1 w-full justify-center"
						size="lg"
						variant="outline"
						color="primary"
						icon="i-lucide-external-link"
						@click="openCloudDeploy"
					>{{ $t('about.cloudDeployBtn') }}</UButton>
				</div>
			</div>
		</div>
	</main>
	<footer class="sticky bottom-0 bg-default px-4 pt-4 pb-2 lg:px-5">
		<div class="mx-auto w-full max-w-xl">
			<UButton
				v-if="isLoggedIn"
				data-testid="btn-about-logout"
				block
				size="lg"
				color="neutral"
				variant="outline"
				@click="onLogout"
			>
				{{ $t('layout.menu.logout') }}
			</UButton>
			<UButton
				v-else
				data-testid="btn-about-login"
				block
				size="lg"
				@click="$router.push('/login')"
			>
				{{ $t('about.goLogin') }}
			</UButton>
			<p class="mt-1 flex justify-center gap-2 text-xs text-dimmed">
				<span>{{ $t('about.clientVersion') }} {{ appVersion }}</span>
				<span v-if="serverVersion">{{ $t('about.serverVersion') }} {{ serverVersion }}</span>
			</p>
		</div>
	</footer>
	</div>
</template>

<script>
import MobilePageHeader from '../components/MobilePageHeader.vue';
// 暂时保留 import，与模板中注释掉的用户信息手风琴项配套，短期内不清理
// import UserInfoRows from '../components/user/UserInfoRows.vue';
import { fetchServerInfo } from '../services/server-info.api.js';
import { useAuthStore } from '../stores/auth.store.js';
import { openExternalUrl } from '../utils/external-url.js';
import logoSrc from '../assets/coclaw-logo.jpg';

const CLOUD_DEPLOY_URL = 'https://cloud.tencent.com/act/cps/redirect?redirect=38041&cps_key=3ad323275dc8d2d3fb6efe6fc6a27794';

export default {
	name: 'AboutPage',
	components: {
		MobilePageHeader,
	},
	setup() {
		return {
			authStore: useAuthStore(),
		};
	},
	data() {
		return {
			logoSrc,
			appVersion: __APP_VERSION__,
			serverVersion: null,
		};
	},
	async mounted() {
		try {
			const info = await fetchServerInfo();
			this.serverVersion = info?.version ?? null;
		}
		catch {
			// 静默忽略
		}
	},
	computed: {
		isLoggedIn() {
			return !!this.authStore.user;
		},
		accordionItems() {
			const items = [];
			// 用户信息手风琴项暂时注释，短期内不清理
			// if (this.isLoggedIn) {
			// 	items.push({
			// 		label: this.$t('about.loggedIn'),
			// 		value: 'user-info',
			// 		slot: 'user-info',
			// 	});
			// }
			items.push(
				{
					label: this.$t('about.highlightsTitle'),
					value: 'highlights',
					slot: 'highlights',
				},
				{
					label: this.$t('about.guide'),
					value: 'guide',
					slot: 'guide',
				},
				{
					label: this.$t('about.concepts'),
					value: 'concepts',
					slot: 'concepts',
				},
			);
			return items;
		},
	},
	methods: {
		async onLogout() {
			await this.authStore.logout();
			this.$router.replace('/login');
		},
		openCloudDeploy() {
			openExternalUrl(CLOUD_DEPLOY_URL);
		},
	},
};
</script>
