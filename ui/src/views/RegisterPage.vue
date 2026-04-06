<template>
	<main class="flex min-h-screen items-center justify-center bg-default px-4 py-8 pt-[max(2rem,var(--safe-area-inset-top))] pb-[max(2rem,var(--safe-area-inset-bottom))] text-highlighted">
		<section class="w-full max-w-sm rounded-2xl border border-default bg-elevated p-5 shadow-xl" data-testid="register-page">
			<h1 class="text-xl font-semibold">{{ $t('register.title') }}</h1>
			<p class="mt-2 text-sm text-muted">{{ $t('register.desc') }}</p>

			<form class="mt-6 space-y-4" @submit.prevent="onRegister">
				<UFormField :label="$t('register.account')" name="loginName">
					<UInput
						v-model="form.loginName"
						data-testid="register-name"
						autocomplete="off"
						:placeholder="$t('register.accountPlaceholder')"
						size="xl"
						class="w-full"
					/>
				</UFormField>

				<UFormField :label="$t('register.password')" name="password">
					<UInput
						v-model="form.password"
						data-testid="register-password"
						type="password"
						autocomplete="new-password"
						:placeholder="$t('register.passwordPlaceholder')"
						size="xl"
						class="w-full"
					/>
				</UFormField>

				<UFormField :label="$t('register.confirmPassword')" name="confirmPassword">
					<UInput
						v-model="form.confirmPassword"
						data-testid="register-confirm-password"
						type="password"
						autocomplete="new-password"
						:placeholder="$t('register.confirmPasswordPlaceholder')"
						size="xl"
						class="w-full"
					/>
				</UFormField>

				<UButton
					data-testid="btn-register"
					type="submit"
					block
					size="xl"
					:loading="authStore.loading"
					:disabled="authStore.loading"
				>
					{{ $t('register.registerBtn') }}
				</UButton>
			</form>

			<p class="mt-3 text-sm text-muted">
				{{ $t('register.hasAccount') }}
				<RouterLink :to="{ path: '/login', query: safeRedirect ? { redirect: safeRedirect } : {} }" class="text-primary">{{ $t('register.goLogin') }}</RouterLink>
			</p>

			<p v-if="clientError" data-testid="client-error" class="mt-3 text-sm text-error">
				{{ clientError }}
			</p>
			<p v-if="authStore.errorMessage" data-testid="error" class="mt-3 text-sm text-error">
				{{ authStore.errorMessage }}
			</p>
		</section>
	</main>
</template>

<script>
import { useAuthStore } from '../stores/auth.store.js';
import { useEnvStore } from '../stores/env.store.js';
import { validateLoginName } from '../validators/login-name.js';

export default {
	name: 'RegisterPage',
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
				confirmPassword: '',
			},
			clientError: '',
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
		async onRegister() {
			this.clientError = '';
			this.authStore.clearError();

			if (!this.form.loginName || !this.form.password || !this.form.confirmPassword) {
				return;
			}

			const nameCheck = validateLoginName(this.form.loginName);
			if (!nameCheck.valid) {
				this.clientError = this.$t(`register.${nameCheck.code}`);
				return;
			}

			if (this.form.password !== this.form.confirmPassword) {
				this.clientError = this.$t('register.passwordMismatch');
				return;
			}

			await this.authStore.register({
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
