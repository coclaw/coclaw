<template>
	<main class="min-h-screen bg-default px-4 py-10">
		<section class="mx-auto w-full max-w-2xl rounded-xl border border-default bg-elevated p-6 shadow-sm">
			<h1 class="text-2xl font-semibold text-highlighted">{{ $t('authPrototype.title') }}</h1>
			<p class="mt-2 text-sm text-muted">
				{{ $t('authPrototype.desc') }}
			</p>
			<router-link
				to="/nuxt-ui-demo"
				class="mt-3 inline-flex text-sm font-medium text-blue-600 hover:text-blue-700"
			>
				{{ $t('authPrototype.openDemo') }}
			</router-link>

			<form class="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2" @submit.prevent="onLogin">
				<label class="flex flex-col gap-2">
					<span class="text-sm text-default">{{ $t('authPrototype.loginName') }}</span>
					<input
						v-model="form.loginName"
						data-testid="login-name"
						type="text"
						class="rounded-md border border-accented px-3 py-2 focus:border-blue-500 focus:outline-none"
					/>
				</label>

				<label class="flex flex-col gap-2">
					<span class="text-sm text-default">{{ $t('authPrototype.password') }}</span>
					<input
						v-model="form.password"
						data-testid="login-password"
						type="password"
						class="rounded-md border border-accented px-3 py-2 focus:border-blue-500 focus:outline-none"
					/>
				</label>

				<div class="col-span-full flex flex-wrap gap-3">
					<button
						data-testid="btn-login"
						type="submit"
						:disabled="authStore.loading"
						class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400"
					>
						{{ $t('authPrototype.login') }}
					</button>
					<button
						data-testid="btn-logout"
						type="button"
						:disabled="authStore.loading"
						class="rounded-md bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
						@click="onLogout"
					>
						{{ $t('authPrototype.logout') }}
					</button>
					<button
						data-testid="btn-session"
						type="button"
						:disabled="authStore.loading"
						class="rounded-md border border-accented bg-elevated px-4 py-2 text-sm font-medium text-default hover:bg-muted disabled:cursor-not-allowed"
						@click="onRefreshSession"
					>
						{{ $t('authPrototype.refreshSession') }}
					</button>
				</div>
			</form>

			<p v-if="authStore.errorMessage" data-testid="error" class="mt-4 text-sm text-error">
				{{ authStore.errorMessage }}
			</p>

			<section class="mt-6 rounded-lg bg-muted p-4" data-testid="session-panel">
				<h2 class="text-sm font-semibold text-highlighted">{{ $t('authPrototype.currentSession') }}</h2>
				<p v-if="authStore.user" data-testid="session-user" class="mt-2 text-sm text-toned">
					id: {{ authStore.user.id }}<span v-if="authStore.user.name">, name: {{ authStore.user.name }}</span>
				</p>
				<p v-else data-testid="session-empty" class="mt-2 text-sm text-muted">{{ $t('common.notLoggedIn') }}</p>
			</section>
		</section>
	</main>
</template>

<script>
import { useAuthStore } from '../stores/auth.store.js';

export default {
	name: 'AuthPrototypePage',
	setup() {
		const authStore = useAuthStore();
		return {
			authStore,
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
	async mounted() {
		await this.authStore.refreshSession();
	},
	methods: {
		async onLogin() {
			await this.authStore.login({
				loginName: this.form.loginName,
				password: this.form.password,
			});
		},
		async onLogout() {
			await this.authStore.logout();
		},
		async onRefreshSession() {
			await this.authStore.refreshSession();
		},
	},
};
</script>
