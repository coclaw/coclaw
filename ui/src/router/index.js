import { createRouter, createWebHistory } from 'vue-router';

import AuthedLayout from '../layouts/AuthedLayout.vue';
import LoginPage from '../views/LoginPage.vue';
import RegisterPage from '../views/RegisterPage.vue';
import NuxtUiDemoPage from '../views/NuxtUiDemoPage.vue';
import HomePage from '../views/HomePage.vue';
import ChatPage from '../views/ChatPage.vue';
import TopicsPage from '../views/TopicsPage.vue';
import AddBotPage from '../views/AddBotPage.vue';
import ManageBotsPage from '../views/ManageBotsPage.vue';
import UserPage from '../views/UserPage.vue';
import AboutPage from '../views/AboutPage.vue';
import ClaimPage from '../views/ClaimPage.vue';
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
				component: HomePage,
				meta: { requiresAuth: true, hideMobileNav: true },
			},
			{
				path: 'chat/:botId/:agentId',
				name: 'chat',
				component: ChatPage,
				meta: { requiresAuth: true, hideMobileNav: true },
			},
			{
				path: 'topics',
				name: 'topics',
				component: TopicsPage,
				meta: { requiresAuth: true, isTopPage: true },
			},
			{
				path: 'topics/:sessionId',
				name: 'topics-chat',
				component: ChatPage,
				meta: { requiresAuth: true, hideMobileNav: true },
			},
			{
				path: 'bots/add',
				name: 'bots-add',
				component: AddBotPage,
				meta: { requiresAuth: true, hideMobileNav: true },
			},
			{
				path: 'bots',
				name: 'bots',
				component: ManageBotsPage,
				meta: { requiresAuth: true, isTopPage: true },
			},
			{
				path: 'user',
				name: 'user',
				component: UserPage,
				meta: { requiresAuth: true, isTopPage: true },
			},
			{
				path: 'claim',
				name: 'claim',
				component: ClaimPage,
				meta: { requiresAuth: true, hideMobileNav: true },
			},
			{
				path: 'about',
				name: 'about',
				component: AboutPage,
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
		return { path: '/login', query: { redirect: to.fullPath }, replace: true };
	}
	console.debug('[router] auth passed, user=%s', authStore.user?.id);
});
