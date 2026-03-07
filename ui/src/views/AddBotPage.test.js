import { createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { vi } from 'vitest';

import AddBotPage from './AddBotPage.vue';

vi.mock('../services/bots.api.js', () => ({
	listBots: vi.fn().mockResolvedValue([]),
	createBindingCode: vi.fn().mockResolvedValue({ code: '12345678', expiresAt: null }),
}));

const mockNotify = {
	success: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	error: vi.fn(),
};
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => mockNotify,
}));

const UButtonStub = {
	emits: ['click'],
	template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
};

const UInputStub = {
	props: ['modelValue', 'placeholder'],
	emits: ['update:modelValue'],
	template: '<input :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};

function createWrapper() {
	return mount(AddBotPage, {
		global: {
			plugins: [createPinia()],
			stubs: {
				UButton: UButtonStub,
				UInput: UInputStub,
				UIcon: { props: ['name'], template: '<span />' },
			},
			mocks: {
				$t: (key) => {
					const map = {
						'bots.addBot': '添加机器人',
						'bots.genCode': '生成绑定码',
						'bots.regenCode': '重新生成',
						'bots.sectionBind': '生成并绑定',
						'bots.sectionPlugin': '安装或升级插件',
						'bots.pluginHint': '首次使用时安装，有新版本时升级',
						'bots.installViaShell': '安装 — 在宿主机终端执行：',
						'bots.updateViaShell': '升级 — 在宿主机终端执行：',
						'bots.installViaChat': '或在 OpenClaw 对话中发送：',
						'bots.installPrompt': '帮我运行 CLI 命令 openclaw plugins update coclaw 或 openclaw plugins install @coclaw/openclaw-coclaw 升级或安装插件',
						'bots.genHint': '点击"生成绑定码"，然后在 OpenClaw 侧执行绑定命令。',
						'bots.bindViaChat': '在 OpenClaw 对话中输入：',
						'bots.bindViaShell': '或在宿主机终端执行：',
						'bots.commandCopied': '已复制',
					};
					return map[key] ?? key;
				},
			},
		},
	});
}

test('should render onboarding steps and generate button', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	expect(wrapper.text()).toContain('添加机器人');
	expect(wrapper.text()).toContain('生成绑定码');
	expect(wrapper.text()).toContain('生成并绑定');
	expect(wrapper.text()).toContain('安装或升级插件');
});

test('should show install and update commands', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const pres = wrapper.findAll('pre');
	expect(pres.length).toBeGreaterThanOrEqual(3);
	expect(pres[0].text()).toContain('openclaw plugins install @coclaw/openclaw-coclaw');
	expect(pres[1].text()).toContain('openclaw plugins update coclaw');
});

test('should show install-via-chat prompt with update and install', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const pres = wrapper.findAll('pre');
	expect(pres[2].text()).toContain('openclaw plugins update coclaw');
	expect(pres[2].text()).toContain('openclaw plugins install @coclaw/openclaw-coclaw');
	expect(wrapper.text()).toContain('或在 OpenClaw 对话中发送：');
});

test('should hide bot name input by default', async () => {
	const wrapper = createWrapper();
	await vi.dynamicImportSettled();

	const input = wrapper.find('input');
	expect(input.exists()).toBe(false);
});
