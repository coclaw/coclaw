import { createRouter, createWebHistory } from 'vue-router';

import AuthedLayout from '../layouts/AuthedLayout.vue';
import LoginPage from '../views/LoginPage.vue';
import RegisterPage from '../views/RegisterPage.vue';
import NuxtUiDemoPage from '../views/NuxtUiDemoPage.vue';
import HomePage from '../views/HomePage.vue';
import ChatPage from '../views/ChatPage.vue';
import TopicsPage from '../views/TopicsPage.vue';
import AddClawPage from '../views/AddClawPage.vue';
import ManageClawsPage from '../views/ManageClawsPage.vue';
import UserPage from '../views/UserPage.vue';
import AboutPage from '../views/AboutPage.vue';
import ClaimPage from '../views/ClaimPage.vue';
import FileManagerPage from '../views/FileManagerPage.vue';
import AdminDashboardPage from '../views/AdminDashboardPage.vue';
import { useAuthStore } from '../stores/auth.store.js';
import { isNative } from '../utils/capacitor-app.js';

const LAST_ROUTE_KEY = 'coclaw:lastRoute';

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
				path: 'chat/:clawId/:agentId',
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
				path: 'claws/add',
				name: 'claws-add',
				component: AddClawPage,
				meta: { requiresAuth: true, hideMobileNav: true },
			},
			{
				path: 'claws',
				name: 'claws',
				component: ManageClawsPage,
				meta: { requiresAuth: true, isTopPage: true },
			},
			{
				path: 'user',
				name: 'user',
				component: UserPage,
				meta: { requiresAuth: true, isTopPage: true },
			},
			{
				path: 'files/:clawId/:agentId',
				name: 'files',
				component: FileManagerPage,
				meta: { requiresAuth: true, hideMobileNav: true },
			},
			{
				path: 'claim',
				name: 'claim',
				component: ClaimPage,
				meta: { requiresAuth: true, hideMobileNav: true },
			},
			{
				path: 'admin/dashboard',
				name: 'admin-dashboard',
				component: AdminDashboardPage,
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

// --- Capacitor 冷启动路由恢复 ---
// OS kill 后重启时，从 localStorage 恢复上次路由
// 暖恢复（app:foreground）时清除，不需要恢复
let __pendingRestore = null;
if (isNative) {
	__pendingRestore = localStorage.getItem(LAST_ROUTE_KEY);
	localStorage.removeItem(LAST_ROUTE_KEY);
	if (__pendingRestore) {
		console.log('[router] cold start: saved route found → %s', __pendingRestore);
	}
}

router.beforeEach(async (to) => {
	// 冷启动路由恢复（一次性）
	if (__pendingRestore) {
		const target = __pendingRestore;
		__pendingRestore = null;
		if (to.fullPath !== target) {
			console.log('[router] cold start restore → %s', target);
			return target;
		}
	}

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

// Capacitor: 后台保存路由 / 前台清除
if (isNative) {
	window.addEventListener('app:background', () => {
		const path = router.currentRoute.value?.fullPath;
		if (path && path !== '/login' && path !== '/register') {
			localStorage.setItem(LAST_ROUTE_KEY, path);
			console.debug('[router] saved route on background: %s', path);
		}
	});
	window.addEventListener('app:foreground', () => {
		localStorage.removeItem(LAST_ROUTE_KEY);
	});
}
