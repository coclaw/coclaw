import { createRouter, createWebHistory } from 'vue-router';

import AuthedLayout from '../layouts/AuthedLayout.vue';
import LoginPage from '../views/LoginPage.vue';
import RegisterPage from '../views/RegisterPage.vue';
import NuxtUiDemoPage from '../views/NuxtUiDemoPage.vue';
import { useAuthStore } from '../stores/auth.store.js';

const routes = [
	{
		path: '/',
		redirect: '/home',
	},
	{
		path: '/login',
		name: 'login',
		component: LoginPage,
	},
	{
		path: '/register',
		name: 'register',
		component: RegisterPage,
	},
	{
		path: '/nuxt-ui-demo',
		name: 'nuxt-ui-demo',
		component: NuxtUiDemoPage,
	},
	{
		path: '/',
		component: AuthedLayout,
		children: [
			{
				path: 'home',
				name: 'home',
				component: () => import('../views/HomePage.vue'),
				meta: { requiresAuth: true, hideMobileNav: true },
			},
			{
				path: 'chat/:sessionId',
				name: 'chat',
				component: () => import('../views/ChatPage.vue'),
				meta: { requiresAuth: true, hideMobileNav: true },
			},
			{
				path: 'topics',
				name: 'topics',
				component: () => import('../views/TopicsPage.vue'),
				meta: { requiresAuth: true, isTopPage: true },
			},
			{
				path: 'topics/:sessionId',
				name: 'topics-chat',
				component: () => import('../views/ChatPage.vue'),
				meta: { requiresAuth: true, hideMobileNav: true },
			},
			{
				path: 'bots/add',
				name: 'bots-add',
				component: () => import('../views/AddBotPage.vue'),
				meta: { requiresAuth: true, hideMobileNav: true },
			},
			{
				path: 'bots',
				name: 'bots',
				component: () => import('../views/ManageBotsPage.vue'),
				meta: { requiresAuth: true, isTopPage: true },
			},
			{
				path: 'user',
				name: 'user',
				component: () => import('../views/UserPage.vue'),
				meta: { requiresAuth: true, isTopPage: true },
			},
			{
				path: 'about',
				name: 'about',
				component: () => import('../views/AboutPage.vue'),
				meta: { requiresAuth: false, hideMobileNav: true },
			},
		],
	},
	// catch-all: 未知路径回退到首页
	{
		path: '/:pathMatch(.*)*',
		redirect: '/home',
	},
];

export const router = createRouter({
	history: createWebHistory(),
	routes,
});

router.beforeEach(async (to) => {
	console.debug('[router] navigating to=%s, requiresAuth=%s', to.path, !!to.meta.requiresAuth);
	if (!to.meta.requiresAuth) {
		return;
	}
	const authStore = useAuthStore();
	await authStore.refreshSession();
	if (!authStore.user) {
		console.log('[router] auth redirect → /login');
		return { path: '/login', replace: true };
	}
	console.debug('[router] auth passed, user=%s', authStore.user?.id);
});
