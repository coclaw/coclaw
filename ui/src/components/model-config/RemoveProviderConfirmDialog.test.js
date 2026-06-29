import { mount } from '@vue/test-utils';
import { test, expect, describe } from 'vitest';

import RemoveProviderConfirmDialog from './RemoveProviderConfirmDialog.vue';

const UButtonStub = {
	props: { disabled: { type: Boolean, default: false }, loading: { type: Boolean, default: false } },
	emits: ['click'],
	template: '<button :disabled="disabled || loading" :data-loading="loading" @click="$emit(\'click\')"><slot /></button>',
};

// 让 UModal 在 open=true 时把 body / footer slot 渲染出来，否则 wrapper.text 看不到
const UModalStub = {
	props: { open: { type: Boolean, default: false }, title: { type: String, default: '' } },
	emits: ['update:open'],
	template: `
		<div v-if="open">
			<h3 class="modal-title">{{ title }}</h3>
			<div class="modal-body"><slot name="body" /></div>
			<div class="modal-footer"><slot name="footer" /></div>
		</div>
	`,
};

function makeWrapper(props = {}) {
	return mount(RemoveProviderConfirmDialog, {
		props: {
			open: true,
			provider: 'groq',
			currentPrimary: '',
			isPrimaryCarrier: false,
			busy: false,
			...props,
		},
		global: {
			stubs: { UButton: UButtonStub, UModal: UModalStub },
			mocks: {
				$t: (key, params) => {
					// 把模板占位简单插值，方便断言文案是否落进 dialog
					if (!params) return key;
					return `${key}:${Object.entries(params).map(([k, v]) => `${k}=${v}`).join('|')}`;
				},
			},
		},
	});
}

describe('RemoveProviderConfirmDialog', () => {
	test('renders normal text variant when not primary carrier (uses friendly brand name)', () => {
		const w = makeWrapper({ isPrimaryCarrier: false });
		const text = w.text();
		// provider 展示经 getProviderName（groq → 'Groq'）；i18n 模板 key 不变
		expect(text).toContain('modelConfig.providerAuth.remove.title:provider=Groq');
		expect(text).toContain('modelConfig.providerAuth.remove.descNormal:provider=Groq');
		expect(text).not.toContain('descAffectPrimary');
		// desc 带 testid（E2E 锚点，避免断言整段 i18n 文案）；展示亦为品牌名
		const desc = w.find('[data-testid="remove-provider-desc"]');
		expect(desc.exists()).toBe(true);
		expect(desc.text()).toContain('provider=Groq');
	});

	test('renders strong-warning text variant when primary carrier (passes primary string)', () => {
		const w = makeWrapper({
			isPrimaryCarrier: true,
			currentPrimary: 'groq/llama-3.3-70b-versatile',
		});
		const text = w.text();
		expect(text).toContain('descAffectPrimary');
		// primary 是完整模型标识，保持裸串（不过 getProviderName）
		expect(text).toContain('primary=groq/llama-3.3-70b-versatile');
		// provider 展示用友好品牌名
		expect(text).toContain('provider=Groq');
	});

	test('confirm button label changes between normal and strong', () => {
		const wNormal = makeWrapper({ isPrimaryCarrier: false });
		expect(wNormal.find('[data-testid="btn-remove-confirm"]').text()).toBe('modelConfig.providerAuth.remove.confirmButton');

		const wStrong = makeWrapper({ isPrimaryCarrier: true, currentPrimary: 'groq/x' });
		expect(wStrong.find('[data-testid="btn-remove-confirm"]').text()).toBe('modelConfig.providerAuth.remove.confirmButtonStrong');
	});

	test('confirm button emits confirm (no update:open — page handles close after RPC)', async () => {
		const w = makeWrapper();
		await w.find('[data-testid="btn-remove-confirm"]').trigger('click');
		expect(w.emitted('confirm')).toBeTruthy();
		expect(w.emitted('cancel')).toBeFalsy();
		expect(w.emitted('update:open')).toBeFalsy();
	});

	test('cancel button emits cancel + update:open=false', async () => {
		const w = makeWrapper();
		await w.find('[data-testid="btn-remove-cancel"]').trigger('click');
		expect(w.emitted('cancel')).toBeTruthy();
		expect(w.emitted('update:open')?.[0]).toEqual([false]);
	});

	test('UModal close (mask / Esc) is treated as cancel', async () => {
		const w = makeWrapper();
		// UModalStub 没有真实 Esc 行为，直接调组件的 onOpenChange 模拟
		await w.vm.onOpenChange(false);
		expect(w.emitted('cancel')).toBeTruthy();
		expect(w.emitted('update:open')?.[0]).toEqual([false]);
	});

	test('UModal open=true reflux does not emit cancel', async () => {
		const w = makeWrapper();
		await w.vm.onOpenChange(true);
		expect(w.emitted('cancel')).toBeFalsy();
		expect(w.emitted('update:open')).toBeFalsy();
	});

	test('cancel button disabled while busy', () => {
		const w = makeWrapper({ busy: true });
		expect(w.find('[data-testid="btn-remove-cancel"]').element.disabled).toBe(true);
	});

	test('cancel-button click during busy is a no-op (no emits — RPC keeps running)', async () => {
		const w = makeWrapper({ busy: true });
		await w.vm.onCancel();
		expect(w.emitted('cancel')).toBeFalsy();
		expect(w.emitted('update:open')).toBeFalsy();
	});

	test('mask click / Esc (onOpenChange false) during busy is also ignored', async () => {
		const w = makeWrapper({ busy: true });
		await w.vm.onOpenChange(false);
		expect(w.emitted('cancel')).toBeFalsy();
		expect(w.emitted('update:open')).toBeFalsy();
	});

	test('confirm button shows loading while busy', () => {
		const w = makeWrapper({ busy: true });
		const btn = w.find('[data-testid="btn-remove-confirm"]');
		expect(btn.attributes('data-loading')).toBe('true');
	});

	test('does not render anything when open=false', () => {
		const w = makeWrapper({ open: false });
		expect(w.find('.modal-title').exists()).toBe(false);
	});

	test('unknown provider (no brand name) falls back to the raw id verbatim', () => {
		const w = makeWrapper({ provider: 'mystery' });
		expect(w.text()).toContain('provider=mystery');
	});

	// 撤内联不再追加"会改配置文件"提示——确认弹窗与普通删除一致（2026-05-28 拍板），故不再有 source 分支测试
});
