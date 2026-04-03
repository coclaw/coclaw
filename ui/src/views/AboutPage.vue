<template>
	<div class="flex min-h-0 flex-1 flex-col">
		<MobilePageHeader :title="$t('about.title')" />
	<main class="flex-1 overflow-auto px-4 pt-5 lg:px-5">
		<div class="mx-auto w-full max-w-xl">
			<img :src="logoSrc" alt="CoClaw" class="mx-auto mb-5 size-20 rounded-xl" />
			<h1 v-if="false" class="hidden text-center text-xl font-semibold md:block">{{ $t('about.title') }}</h1>
			<p class="flex justify-center text-base text-toned md:mt-4">{{ $t('about.intro') }}</p>

			<div class="mt-8">
				<UAccordion :items="accordionItems" collapsible :ui="{ trigger: 'text-base' }">
					<template v-if="isLoggedIn" #user-info-body>
						<UserInfoRows :user="authStore.user" />
					</template>
					<template #guide-body>
						<div class="space-y-3 text-sm text-toned leading-relaxed">
							<p><strong>{{ $t('about.guideBind') }}</strong>{{ $t('about.guideBindDesc') }}</p>
							<p><strong>{{ $t('about.guideChat') }}</strong>{{ $t('about.guideChatDesc') }}</p>
							<p><strong>{{ $t('about.guideManage') }}</strong>{{ $t('about.guideManageDesc') }}</p>
						</div>
					</template>
					<template #concepts-body>
						<div class="space-y-3 text-sm text-toned leading-relaxed">
							<p><strong>{{ $t('about.conceptBot') }}</strong>{{ $t('about.conceptBotDesc') }}</p>
							<p><strong>{{ $t('about.conceptOnline') }}</strong>{{ $t('about.conceptOnlineDesc') }}</p>
							<p><strong>{{ $t('about.conceptSession') }}</strong>{{ $t('about.conceptSessionDesc') }}</p>
						</div>
					</template>
				</UAccordion>
			</div>

			<!-- 云部署引导 -->
			<div class="mt-6 flex flex-col items-center gap-2.5">
				<h2 class="text-base font-medium">{{ $t('about.cloudDeploy') }}</h2>
				<p class="text-sm text-toned">{{ $t('about.cloudDeployDesc') }}</p>
				<UButton
					class="mt-1"
					size="lg"
					variant="outline"
					color="primary"
					icon="i-lucide-external-link"
					@click="openCloudDeploy"
				>{{ $t('about.cloudDeployBtn') }}</UButton>
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
import UserInfoRows from '../components/user/UserInfoRows.vue';
import { fetchServerInfo } from '../services/server-info.api.js';
import { useAuthStore } from '../stores/auth.store.js';
import { openExternalUrl } from '../utils/external-url.js';
import logoSrc from '../assets/coclaw-logo.jpg';

const CLOUD_DEPLOY_URL = 'https://cloud.tencent.com/act/cps/redirect?redirect=38041&cps_key=3ad323275dc8d2d3fb6efe6fc6a27794';

export default {
	name: 'AboutPage',
	components: {
		MobilePageHeader,
		UserInfoRows,
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
			if (this.isLoggedIn) {
				items.push({
					label: this.$t('about.loggedIn'),
					value: 'user-info',
					slot: 'user-info',
				});
			}
			items.push(
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
