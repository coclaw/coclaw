import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// 可写的 auth store 替身：让用例逐项控制 changePassword 返回值与 errorMessage
const authStore = vi.hoisted(() => ({
	user: { authType: 'local' },
	errorMessage: '',
	updateSettings: vi.fn().mockResolvedValue(undefined),
	changePassword: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../stores/auth.store.js', () => ({
	useAuthStore: () => authStore,
}));

const notify = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
	info: vi.fn(),
}));
vi.mock('../../composables/use-notify.js', () => ({
	useNotify: () => notify,
}));

import UserSettingsPanel from './UserSettingsPanel.vue';

// 默认全局 UModal stub 只渲染默认插槽；本组件用 #body/#footer 具名插槽，需自定义 stub 渲染 body
const UModalStub = {
	props: ['open', 'title', 'description', 'ui'],
	emits: ['update:open'],
	template: '<div class="u-modal-stub"><slot name="body" /><slot name="footer" /></div>',
};

function mountPanel() {
	return mount(UserSettingsPanel, {
		props: {},
		global: {
			stubs: {
				UModal: UModalStub,
				USelect: { template: '<div />' },
				UCheckbox: { template: '<div />' },
			},
			mocks: { $t: (k) => k },
		},
	});
}

describe('UserSettingsPanel 修改密码', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		authStore.errorMessage = '';
		authStore.changePassword.mockResolvedValue(true);
	});

	test('密码框被 form 包裹（消除浏览器“password 不在 form 内”告警）', () => {
		const w = mountPanel();
		// 三个密码输入都应位于同一个 form 内
		const form = w.find('form');
		expect(form.exists()).toBe(true);
		// 隐藏的 submit 按钮：保证多输入框场景下原生回车也能触发提交
		expect(form.find('button[type="submit"]').exists()).toBe(true);
	});

	test('原生提交（回车）走 onSubmitPasswordChange：校验通过则调用 changePassword 并提示成功', async () => {
		const w = mountPanel();
		w.vm.pwdForm.currentPassword = 'old-secret';
		w.vm.pwdForm.newPassword = 'new-secret';
		w.vm.pwdForm.confirmPassword = 'new-secret';
		await w.find('form').trigger('submit');
		expect(authStore.changePassword).toHaveBeenCalledWith({
			oldPassword: 'old-secret',
			newPassword: 'new-secret',
		});
		expect(notify.success).toHaveBeenCalledWith('settings.passwordChanged');
		// 提交后清空表单，避免明文残留
		expect(w.vm.pwdForm.currentPassword).toBe('');
		expect(w.vm.pwdForm.newPassword).toBe('');
	});

	test('两次新密码不一致：提示且不调用 changePassword', async () => {
		const w = mountPanel();
		w.vm.pwdForm.currentPassword = 'old-secret';
		w.vm.pwdForm.newPassword = 'new-secret';
		w.vm.pwdForm.confirmPassword = 'mismatch';
		await w.find('form').trigger('submit');
		expect(notify.warning).toHaveBeenCalledWith('settings.passwordNotMatch');
		expect(authStore.changePassword).not.toHaveBeenCalled();
	});
});
