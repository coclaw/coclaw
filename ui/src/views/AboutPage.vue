<template>
	<div class="flex min-h-0 flex-1 flex-col">
		<MobilePageHeader :title="$t('about.title')" />
	<main class="flex-1 overflow-auto px-4 pt-5 pb-[max(2rem,env(safe-area-inset-bottom))] lg:px-5">
		<div class="mx-auto w-full max-w-3xl">
			<img :src="logoSrc" alt="CoClaw" class="mx-auto mb-5 size-20 rounded-xl" />
			<h1 v-if="false" class="hidden text-center text-xl font-semibold md:block">{{ $t('about.title') }}</h1>
			<p class="text-center text-base text-toned md:mt-4">{{ $t('about.intro') }}</p>

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

			<div class="mt-8">
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
			</div>
		</div>
	</main>
	</div>
</template>

<script>
import MobilePageHeader from '../components/MobilePageHeader.vue';
import UserInfoRows from '../components/user/UserInfoRows.vue';
import { useAuthStore } from '../stores/auth.store.js';
import logoSrc from '../assets/coclaw-logo.jpg';

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
		return { logoSrc };
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
	},
};
</script>
