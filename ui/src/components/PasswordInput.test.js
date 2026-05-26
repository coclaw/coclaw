import { mount } from '@vue/test-utils';
import { expect, test } from 'vitest';

import PasswordInput from './PasswordInput.vue';

// 用 inheritAttrs:false + v-bind="$attrs" 的替身：把 type/aria/icon/onClick 等
// 原样落到原生元素上，避免 aria-* 是否映射成 prop 的歧义，也避免 onClick 双绑。
const UInputStub = {
	name: 'UInput',
	inheritAttrs: false,
	props: ['modelValue'],
	emits: ['update:modelValue'],
	template: `<div class="u-input">
		<input v-bind="$attrs" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />
		<slot name="trailing" />
	</div>`,
};

const UButtonStub = {
	name: 'UButton',
	inheritAttrs: false,
	template: '<button v-bind="$attrs"><slot /></button>',
};

function mountInput(props = {}, attrs = {}) {
	return mount(PasswordInput, {
		props,
		attrs,
		global: {
			stubs: { UInput: UInputStub, UButton: UButtonStub },
			mocks: { $t: (k) => k },
		},
	});
}

test('默认密文：input type=password，按钮为 type=button + eye 图标 + 未按下', () => {
	const w = mountInput();
	expect(w.find('input').attributes('type')).toBe('password');

	const btn = w.find('button');
	expect(btn.attributes('type')).toBe('button');
	expect(btn.attributes('icon')).toBe('i-lucide-eye');
	expect(btn.attributes('aria-label')).toBe('common.showPassword');
	expect(btn.attributes('aria-pressed')).toBe('false');
});

test('点眼睛切明文：type=text，图标/aria 翻转；再点切回密文', async () => {
	const w = mountInput();
	await w.find('button').trigger('click');

	expect(w.find('input').attributes('type')).toBe('text');
	const btn = w.find('button');
	expect(btn.attributes('icon')).toBe('i-lucide-eye-off');
	expect(btn.attributes('aria-label')).toBe('common.hidePassword');
	expect(btn.attributes('aria-pressed')).toBe('true');

	await w.find('button').trigger('click');
	expect(w.find('input').attributes('type')).toBe('password');
});

test('输入时向上 emit update:modelValue', async () => {
	const w = mountInput({ modelValue: '' });
	await w.find('input').setValue('secret');
	expect(w.emitted('update:modelValue')).toBeTruthy();
	expect(w.emitted('update:modelValue').at(-1)).toEqual(['secret']);
});

test('初始 modelValue 落到 input', () => {
	const w = mountInput({ modelValue: 'hello' });
	expect(w.find('input').element.value).toBe('hello');
});

// 透传必须真到内部 input：E2E 的 .fill() 靠 data-testid 命中真实 input，autocomplete 关系到密码管理器
test('透传 data-testid / autocomplete / placeholder 到内部 input', () => {
	const w = mountInput({}, {
		'data-testid': 'login-password',
		autocomplete: 'new-password',
		placeholder: 'Enter password',
	});
	const input = w.find('input');
	expect(input.attributes('data-testid')).toBe('login-password');
	expect(input.attributes('autocomplete')).toBe('new-password');
	expect(input.attributes('placeholder')).toBe('Enter password');
});

// 受控显隐 type 必须盖过调用方误传的 type，否则眼睛图标翻转但输入框不真正切换
test('调用方传入的 type 不能覆盖受控的显隐 type', async () => {
	const w = mountInput({}, { type: 'text' });
	expect(w.find('input').attributes('type')).toBe('password');
	await w.find('button').trigger('click');
	expect(w.find('input').attributes('type')).toBe('text');
});
