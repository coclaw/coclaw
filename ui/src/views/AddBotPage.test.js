import { createPinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { vi } from 'vitest';

import AddBotPage from './AddBotPage.vue';

const mockCreateBindingCode = vi.fn().mockResolvedValue({
	code: '12345678',
	expiresAt: new Date(Date.now() + 300_000).toISOString(),
	waitToken: 'tok_test',
});

const mockWaitBindingCode = vi.fn().mockResolvedValue({ code: 'BINDING_TIMEOUT' });
const mockCancelBindingCode = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/bots.api.js', () => ({
	listBots: vi.fn().mockResolvedValue([]),
	createBindingCode: (...args) => mockCreateBindingCode(...args),
	waitBindingCode: (...args) => mockWaitBindingCode(...args),
	cancelBindingCode: (...args) => mockCancelBindingCode(...args),
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

const i18nMap = {
	'bots.addBot': '添加机器人',
	'bots.preparing': '正在准备，请稍候…',
	'bots.retry': '重试',
	'bots.restart': '重新开始',
	'bots.chatMethodTitle': '方式一：通过对话',
	'bots.chatMethodDesc': '如果你已经能和你的 OpenClaw 聊天（比如通过 QQ、飞书等），把下面的内容复制发送给它',
	'bots.shellMethodTitle': '方式二：通过终端',
	'bots.shellMethodDesc': '如果你能打开 OpenClaw 所在电脑的终端（命令行），复制下面的命令执行即可',
	'bots.shellSemicolonHint': '如果手动输入，请注意两条命令之间用分号（;）分隔',
	'bots.copy': '复制',
	'bots.commandCopied': '已复制',
	'bots.expired': '已过期，请点击"重新开始"',
};

function createWrapper(overrides = {}) {
	return mount(AddBotPage, {
		global: {
			plugins: [createPinia()],
			stubs: {
				UButton: UButtonStub,
				UIcon: { props: ['name'], template: '<span />' },
			},
			mocks: {
				$t: (key, params) => {
					if (key === 'bots.chatPrompt') {
						return `请帮我依次运行以下两条命令。即使第一条提示已安装或执行失败，也请继续执行第二条：\n1. openclaw plugins install @coclaw/openclaw-coclaw\n2. openclaw coclaw bind ${params?.code ?? ''}${params?.serverSuffix ?? ''}\n注意：必须使用 openclaw plugins install 安装插件，不要用 npm install -g，否则 OpenClaw 无法识别。`;
					}
					if (key === 'bots.expiryLeft') {
						return `有效期剩余 ${params?.time ?? ''}`;
					}
					return i18nMap[key] ?? key;
				},
				$router: { push: vi.fn() },
				...overrides,
			},
		},
	});
}

beforeEach(() => {
	mockCreateBindingCode.mockReset().mockResolvedValue({
		code: '12345678',
		expiresAt: new Date(Date.now() + 300_000).toISOString(),
		waitToken: 'tok_test',
	});
	mockWaitBindingCode.mockReset().mockResolvedValue({ code: 'BINDING_TIMEOUT' });
	mockCancelBindingCode.mockReset().mockResolvedValue(undefined);
	mockNotify.success.mockReset();
	mockNotify.error.mockReset();
	mockNotify.warning.mockReset();
});

test('should auto-generate binding code on mount and show two methods', async () => {
	const wrapper = createWrapper();
	await flushPromises();

	expect(mockCreateBindingCode).toHaveBeenCalled();
	expect(wrapper.text()).toContain('添加机器人');
	expect(wrapper.text()).toContain('方式一：通过对话');
	expect(wrapper.text()).toContain('方式二：通过终端');
});

test('should show chat prompt with binding code', async () => {
	const wrapper = createWrapper();
	await flushPromises();

	const pres = wrapper.findAll('pre');
	expect(pres[0].text()).toContain('openclaw plugins install @coclaw/openclaw-coclaw');
	expect(pres[0].text()).toContain('openclaw coclaw bind 12345678');
});

test('should show shell command with install and bind', async () => {
	const wrapper = createWrapper();
	await flushPromises();

	const pres = wrapper.findAll('pre');
	expect(pres[1].text()).toContain('openclaw plugins install @coclaw/openclaw-coclaw ; openclaw coclaw bind 12345678');
});

test('should show loading state before code is ready', async () => {
	mockCreateBindingCode.mockReturnValueOnce(new Promise(() => {}));
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('正在准备，请稍候…');
	expect(wrapper.text()).not.toContain('方式一：通过对话');
});

test('should show error state and retry button on failure and log warning', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const err = new Error('network error');
	mockCreateBindingCode.mockRejectedValueOnce(err);
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('network error');
	expect(wrapper.text()).toContain('重试');
	expect(warnSpy).toHaveBeenCalledWith('[AddBotPage] startBinding failed:', err);
	warnSpy.mockRestore();
});

test('should show copy buttons as text buttons', async () => {
	const wrapper = createWrapper();
	await flushPromises();

	const buttons = wrapper.findAll('button');
	const copyBtns = buttons.filter(b => b.text() === '复制');
	expect(copyBtns.length).toBe(2);
});

test('should hide content and show expired message when countdown reaches zero', async () => {
	mockCreateBindingCode.mockResolvedValueOnce({
		code: 'EXPIRED1',
		expiresAt: new Date(Date.now() - 1000).toISOString(), // 已过期
		waitToken: 'tok_exp',
	});
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('已过期，请点击"重新开始"');
	expect(wrapper.text()).not.toContain('方式一：通过对话');
	expect(wrapper.text()).not.toContain('方式二：通过终端');
});

test('should NOT cancel binding code on unmount (let it expire naturally)', async () => {
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.vm.bindingCode).toBe('12345678');
	wrapper.unmount();

	expect(mockCancelBindingCode).not.toHaveBeenCalled();
});

test('should cancel old binding code when restarting', async () => {
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.vm.bindingCode).toBe('12345678');

	mockCreateBindingCode.mockResolvedValueOnce({
		code: 'NEWCODE1',
		expiresAt: new Date(Date.now() + 300_000).toISOString(),
		waitToken: 'tok_new',
	});
	await wrapper.vm.startBinding();

	expect(mockCancelBindingCode).toHaveBeenCalledWith('12345678');
	expect(wrapper.vm.bindingCode).toBe('NEWCODE1');
});

test('should not call cancelBindingCode on unmount when no code exists', async () => {
	mockCreateBindingCode.mockRejectedValueOnce(new Error('fail'));
	const wrapper = createWrapper();
	await flushPromises();

	wrapper.unmount();
	expect(mockCancelBindingCode).not.toHaveBeenCalled();
});

test('should show semicolon hint below shell command', async () => {
	const wrapper = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('如果手动输入，请注意两条命令之间用分号（;）分隔');
});
