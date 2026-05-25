import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// 可写的 auth store 替身：let 用例逐项控制 changePassword 返回值与 errorMessage
const authStore = vi.hoisted(() => ({
	user: { authType: 'local', auth: { local: { loginName: 'tester' } } },
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

// 渲染真实 <input> 的 UInput 替身：让 type/autocomplete 真正落到 DOM，断言才有意义
// （全局 setup 把 UInput stub 成空 div，会让 form 里没有真实 input）
const UInputStub = {
	name: 'UInput',
	props: ['modelValue', 'type', 'autocomplete', 'placeholder'],
	emits: ['update:modelValue'],
	template: `<input
		:type="type ?? 'text'"
		:autocomplete="autocomplete"
		:placeholder="placeholder"
		:value="modelValue"
		@input="$emit('update:modelValue', $event.target.value)"
	/>`,
};

function mountPanel() {
	return mount(UserSettingsPanel, {
		props: {},
		global: {
			stubs: {
				UModal: UModalStub,
				UInput: UInputStub,
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

	test('改密表单含隐藏 username + 三个 password 框（消除两类浏览器告警）', () => {
		const w = mountPanel();
		const form = w.find('form');
		expect(form.exists()).toBe(true);

		// 隐藏 username 字段：autocomplete=username + 当前账号登录名，供密码管理器关联
		const username = form.find('input[autocomplete="username"]');
		expect(username.exists()).toBe(true);
		expect(username.attributes('type')).toBe('text');
		expect(username.element.value).toBe('tester');

		// 三个密码框都在 form 内，type=password，autocomplete 依次 current/new/new
		const pwInputs = form.findAll('input[type="password"]');
		expect(pwInputs).toHaveLength(3);
		expect(pwInputs.map((i) => i.attributes('autocomplete'))).toEqual([
			'current-password',
			'new-password',
			'new-password',
		]);

		// 隐藏 submit：保证多输入框场景下原生回车也能触发提交
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

	test('提交进行中再次触发被在途守卫挡下：changePassword 只调用一次', async () => {
		// changePassword 挂起不 resolve，模拟 RPC 在途
		let resolveCall;
		authStore.changePassword.mockReturnValueOnce(new Promise((res) => { resolveCall = res; }));
		const w = mountPanel();
		w.vm.pwdForm.currentPassword = 'old-secret';
		w.vm.pwdForm.newPassword = 'new-secret';
		w.vm.pwdForm.confirmPassword = 'new-secret';
		// 第一次：进入在途（pwdSubmitting=true 后停在 await）
		const first = w.vm.onSubmitPasswordChange();
		// 第二次（回车叠点按钮）：应被守卫挡下，不再调用
		await w.vm.onSubmitPasswordChange();
		expect(authStore.changePassword).toHaveBeenCalledTimes(1);
		// 放行收尾
		resolveCall(true);
		await first;
		expect(w.vm.pwdSubmitting).toBe(false);
	});
});
