<template>
	<main class="flex min-h-screen items-center justify-center bg-default px-4 py-8 pt-[max(2rem,var(--safe-area-inset-top))] pb-[max(2rem,var(--safe-area-inset-bottom))] text-highlighted">
		<section class="w-full max-w-sm rounded-2xl border border-default bg-elevated p-5 shadow-xl" data-testid="login-page">
			<h1 class="text-xl font-semibold">{{ $t('login.title') }}</h1>

			<form class="mt-6 space-y-4" @submit.prevent="onLogin">
				<UFormField :label="$t('login.account')" name="loginName">
					<UInput
						v-model="form.loginName"
						data-testid="login-name"
						:placeholder="$t('login.accountPlaceholder')"
						size="xl"
						class="w-full"
					/>
				</UFormField>

				<UFormField :label="$t('login.password')" name="password">
					<UInput
						v-model="form.password"
						data-testid="login-password"
						type="password"
						:placeholder="$t('login.passwordPlaceholder')"
						size="xl"
						class="w-full"
					/>
				</UFormField>

				<UButton
					data-testid="btn-login"
					type="submit"
					block
					size="xl"
					:loading="authStore.loading"
					:disabled="authStore.loading"
				>
					{{ $t('login.loginBtn') }}
				</UButton>
			</form>

			<p v-if="authStore.errorMessage" data-testid="error" class="mt-3 text-sm text-error">
				{{ authStore.errorMessage }}
			</p>

			<p class="mt-3 text-sm text-muted">
				{{ $t('login.noAccount') }}
				<RouterLink :to="{ path: '/register', query: safeRedirect ? { redirect: safeRedirect } : {} }" class="text-primary">{{ $t('login.goRegister') }}</RouterLink>
			</p>
		</section>
	</main>
</template>

<script>
import { useAuthStore } from '../stores/auth.store.js';
import { useEnvStore } from '../stores/env.store.js';

export default {
	name: 'LoginPage',
	setup() {
		return {
			authStore: useAuthStore(),
		};
	},
	data() {
		return {
			form: {
				loginName: '',
				password: '',
			},
		};
	},
	computed: {
		safeRedirect() {
			const val = this.$route.query.redirect;
			if (typeof val !== 'string' || !val.startsWith('/') || val.startsWith('//')) {
				return null;
			}
			return val;
		},
		defaultRoute() {
			return useEnvStore().screen.ltMd ? '/topics' : '/home';
		},
	},
	async mounted() {
		await this.authStore.refreshSession();
		if (this.authStore.user) {
			this.$router.replace(this.safeRedirect ?? this.defaultRoute);
		}
	},
	methods: {
		async onLogin() {
			await this.authStore.login({
				loginName: this.form.loginName,
				password: this.form.password,
			});
			if (this.authStore.user) {
				this.$router.replace(this.safeRedirect ?? this.defaultRoute);
			}
		},
	},
};
</script>
