import { describe, test, expect, vi, beforeEach } from 'vitest';

// 避免 router/index.js 的 createWebHistory() 在 jsdom 下触发真实路由引擎
// —— 只测纯函数 evaluateAuthGuard
vi.mock('vue-router', () => ({
	createRouter: () => ({ beforeEach: () => {} }),
	createWebHistory: () => ({}),
}));

// stub 业务页面模块，避免拉入真实组件及其深链依赖
function stubComponent() {
	return { default: { template: '<div />' } };
}
vi.mock('../layouts/AuthedLayout.vue', stubComponent);
vi.mock('../layouts/AdminLayout.vue', stubComponent);
vi.mock('../views/LoginPage.vue', stubComponent);
vi.mock('../views/RegisterPage.vue', stubComponent);
vi.mock('../views/NuxtUiDemoPage.vue', stubComponent);
vi.mock('../views/HomePage.vue', stubComponent);
vi.mock('../views/ChatPage.vue', stubComponent);
vi.mock('../views/TopicsPage.vue', stubComponent);
vi.mock('../views/AddClawPage.vue', stubComponent);
vi.mock('../views/ManageClawsPage.vue', stubComponent);
vi.mock('../views/UserPage.vue', stubComponent);
vi.mock('../views/AboutPage.vue', stubComponent);
vi.mock('../views/ClaimPage.vue', stubComponent);
vi.mock('../views/FileManagerPage.vue', stubComponent);
vi.mock('../views/AdminDashboardPage.vue', stubComponent);
vi.mock('../views/AdminClawsPage.vue', stubComponent);
vi.mock('../views/AdminUsersPage.vue', stubComponent);
vi.mock('../stores/auth.store.js', () => ({ useAuthStore: () => ({}) }));
vi.mock('../utils/platform.js', () => ({ isNativeShell: false }));

import { evaluateAuthGuard } from './index.js';

describe('evaluateAuthGuard', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	test('requiresAuth=false 直接放行', () => {
		const result = evaluateAuthGuard(
			{ fullPath: '/about', meta: { requiresAuth: false } },
			{ user: null },
		);
		expect(result).toBeUndefined();
	});

	test('requiresAuth 但未登录 → 跳转 /login 带 redirect', () => {
		const result = evaluateAuthGuard(
			{ fullPath: '/admin/dashboard', meta: { requiresAuth: true, requiresAdmin: true } },
			{ user: null },
		);
		expect(result).toEqual({
			path: '/login',
			query: { redirect: '/admin/dashboard' },
			replace: true,
		});
	});

	test('已登录普通用户访问普通页面放行', () => {
		const result = evaluateAuthGuard(
			{ fullPath: '/home', meta: { requiresAuth: true } },
			{ user: { level: 0 } },
		);
		expect(result).toBeUndefined();
	});

	test('已登录普通用户访问 /admin/* → 回 /home', () => {
		const result = evaluateAuthGuard(
			{ fullPath: '/admin/claws', meta: { requiresAuth: true, requiresAdmin: true } },
			{ user: { level: 0 } },
		);
		expect(result).toEqual({ path: '/home', replace: true });
	});

	test('VIP / SVIP 用户（level !== -100）同样被 /admin 守卫拦截', () => {
		const vip = evaluateAuthGuard(
			{ fullPath: '/admin/users', meta: { requiresAuth: true, requiresAdmin: true } },
			{ user: { level: 1 } },
		);
		const svip = evaluateAuthGuard(
			{ fullPath: '/admin/users', meta: { requiresAuth: true, requiresAdmin: true } },
			{ user: { level: 100 } },
		);
		expect(vip).toEqual({ path: '/home', replace: true });
		expect(svip).toEqual({ path: '/home', replace: true });
	});

	test('admin 用户（level === -100）访问 /admin/* 放行', () => {
		const result = evaluateAuthGuard(
			{ fullPath: '/admin/dashboard', meta: { requiresAuth: true, requiresAdmin: true } },
			{ user: { level: -100 } },
		);
		expect(result).toBeUndefined();
	});

	test('admin 用户访问非 admin 保护页面放行（requiresAdmin 缺失不触发守卫）', () => {
		const result = evaluateAuthGuard(
			{ fullPath: '/topics', meta: { requiresAuth: true } },
			{ user: { level: -100 } },
		);
		expect(result).toBeUndefined();
	});
});
