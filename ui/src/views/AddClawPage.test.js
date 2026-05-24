import { createPinia, setActivePinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { vi } from 'vitest';

import AddClawPage from './AddClawPage.vue';
import { useClawsStore } from '../stores/claws.store.js';

const mockCreateBindingCode = vi.fn().mockResolvedValue({
	code: '12345678',
	expiresAt: new Date(Date.now() + 300_000).toISOString(),
	waitToken: 'tok_test',
});

const mockCancelBindingCode = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/claws.api.js', () => ({
	createBindingCode: (...args) => mockCreateBindingCode(...args),
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
	'claws.addClaw': '添加机器人',
	'claws.preparing': '正在准备，请稍候…',
	'claws.retry': '重试',
	'claws.restart': '重新开始',
	'claws.chatMethodTitle': '方式一：通过对话',
	'claws.chatMethodDesc': '如果你已经能和你的 OpenClaw 聊天（比如通过 QQ、飞书等），把下面的内容复制发送给它',
	'claws.shellMethodTitle': '方式二：通过终端',
	'claws.shellMethodDesc': '如果你能打开 OpenClaw 所在电脑的终端（命令行），复制下面的命令执行即可',
	'claws.shellSemicolonHint': '如果手动输入，请注意两条命令之间用分号（;）分隔',
	'claws.copy': '复制',
	'claws.commandCopied': '已复制',
	'claws.expired': '已过期，请点击"重新开始"',
};

// 进 setup 前 fetched=true，模拟"全局 SSE 已经至少推过一次 claw 快照"。
// 否则 captureBaseline 会一直阻塞在 fetched 翻 true 的 watcher 上，createBindingCode 永不执行。
function createWrapper({ initialClaws = [], routerPush = vi.fn(), ...overrides } = {}) {
	const pinia = createPinia();
	setActivePinia(pinia);
	const clawsStore = useClawsStore();
	clawsStore.byId = {};
	for (const c of initialClaws) {
		clawsStore.byId[String(c.id)] = { ...c, id: String(c.id) };
	}
	clawsStore.fetched = true;
	const wrapper = mount(AddClawPage, {
		global: {
			plugins: [pinia],
			stubs: {
				UButton: UButtonStub,
				UIcon: { props: ['name'], template: '<span />' },
			},
			mocks: {
				$t: (key, params) => {
					if (key === 'claws.chatPrompt') {
						return `请帮我依次运行以下两条命令。即使第一条提示已安装或执行失败，也请继续执行第二条：\n1. openclaw plugins install @coclaw/openclaw-coclaw\n2. openclaw coclaw bind ${params?.code ?? ''}${params?.serverSuffix ?? ''}\n注意：必须使用 openclaw plugins install 安装插件，不要用 npm install -g，否则 OpenClaw 无法识别。`;
					}
					if (key === 'claws.expiryLeft') {
						return `有效期剩余 ${params?.time ?? ''}`;
					}
					return i18nMap[key] ?? key;
				},
				$router: { push: routerPush },
				...overrides,
			},
		},
	});
	return { wrapper, clawsStore, routerPush };
}

beforeEach(() => {
	mockCreateBindingCode.mockReset().mockResolvedValue({
		code: '12345678',
		expiresAt: new Date(Date.now() + 300_000).toISOString(),
		waitToken: 'tok_test',
	});
	mockCancelBindingCode.mockReset().mockResolvedValue(undefined);
	mockNotify.success.mockReset();
	mockNotify.error.mockReset();
	mockNotify.warning.mockReset();
});

test('should auto-generate binding code on mount and show two methods', async () => {
	const { wrapper } = createWrapper();
	await flushPromises();

	expect(mockCreateBindingCode).toHaveBeenCalled();
	expect(wrapper.text()).toContain('添加机器人');
	expect(wrapper.text()).toContain('方式一：通过对话');
	expect(wrapper.text()).toContain('方式二：通过终端');
});

test('should show chat prompt with binding code', async () => {
	const { wrapper } = createWrapper();
	await flushPromises();

	const pres = wrapper.findAll('pre');
	expect(pres[0].text()).toContain('openclaw plugins install @coclaw/openclaw-coclaw');
	expect(pres[0].text()).toContain('openclaw coclaw bind 12345678');
});

test('should show shell command with install and bind', async () => {
	const { wrapper } = createWrapper();
	await flushPromises();

	const pres = wrapper.findAll('pre');
	expect(pres[1].text()).toContain('openclaw plugins install @coclaw/openclaw-coclaw ; openclaw coclaw bind 12345678');
});

test('should show loading state before code is ready', async () => {
	mockCreateBindingCode.mockReturnValueOnce(new Promise(() => {}));
	const { wrapper } = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('正在准备，请稍候…');
	expect(wrapper.text()).not.toContain('方式一：通过对话');
});

test('should show error state and retry button on failure and log warning', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const err = new Error('network error');
	mockCreateBindingCode.mockRejectedValueOnce(err);
	const { wrapper } = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('network error');
	expect(wrapper.text()).toContain('重试');
	expect(warnSpy).toHaveBeenCalledWith('[AddClawPage] startBinding failed:', err);
	warnSpy.mockRestore();
});

test('should show copy buttons as text buttons', async () => {
	const { wrapper } = createWrapper();
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
	const { wrapper } = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('已过期，请点击"重新开始"');
	expect(wrapper.text()).not.toContain('方式一：通过对话');
	expect(wrapper.text()).not.toContain('方式二：通过终端');
});

test('should NOT cancel binding code on unmount (let it expire naturally)', async () => {
	const { wrapper } = createWrapper();
	await flushPromises();

	expect(wrapper.vm.bindingCode).toBe('12345678');
	wrapper.unmount();

	expect(mockCancelBindingCode).not.toHaveBeenCalled();
});

test('should cancel old binding code when restarting', async () => {
	const { wrapper } = createWrapper();
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
	const { wrapper } = createWrapper();
	await flushPromises();

	wrapper.unmount();
	expect(mockCancelBindingCode).not.toHaveBeenCalled();
});

test('should show semicolon hint below shell command', async () => {
	const { wrapper } = createWrapper();
	await flushPromises();

	expect(wrapper.text()).toContain('如果手动输入，请注意两条命令之间用分号（;）分隔');
});

test('should navigate to /claws when a new claw appears in the store (SSE claw.bound)', async () => {
	const { wrapper, clawsStore, routerPush } = createWrapper();
	await flushPromises();

	// 模拟 SSE claw.bound 写入 store
	clawsStore.byId.b1 = { id: 'b1', name: 'NewClaw' };
	await flushPromises();

	expect(routerPush).toHaveBeenCalledWith('/claws');
	expect(wrapper.vm.bindingCode).toBe('');
});

test('should not navigate when an existing claw is already present at baseline', async () => {
	const { routerPush } = createWrapper({ initialClaws: [{ id: 'existing1', name: 'Old' }] });
	await flushPromises();

	expect(routerPush).not.toHaveBeenCalled();
});

test('should navigate when a new claw appears after existing baseline', async () => {
	const { clawsStore, routerPush } = createWrapper({ initialClaws: [{ id: 'existing1' }] });
	await flushPromises();

	clawsStore.byId.b2 = { id: 'b2', name: 'NewlyBound' };
	await flushPromises();

	expect(routerPush).toHaveBeenCalledWith('/claws');
});

test('should not navigate twice when newClawId actually changes after success (navigated guard)', async () => {
	const { clawsStore, routerPush } = createWrapper();
	await flushPromises();

	// 首次新增 → newClawId 由 null → 'b1'，watcher 触发跳转
	clawsStore.byId.b1 = { id: 'b1' };
	await flushPromises();
	expect(routerPush).toHaveBeenCalledTimes(1);

	// 模拟 SSE 重连推 snapshot：byId 整体替换，b1 不在，新增 b2
	// → newClawId 由 'b1' → 'b2'，watcher 再次触发；navigated 守卫拦下不重复跳转
	clawsStore.byId = { b2: { id: 'b2' } };
	await flushPromises();
	expect(routerPush).toHaveBeenCalledTimes(1);
});

test('should navigate when new claw arrives via snapshot replacement (SSE reconnect path)', async () => {
	const { clawsStore, routerPush } = createWrapper({ initialClaws: [{ id: 'existing1' }] });
	await flushPromises();

	// 模拟 SSE 重连后 applySnapshot 整体替换 byId（不是局部 mutate）
	clawsStore.byId = {
		existing1: { id: 'existing1' },
		newOne: { id: 'newOne' },
	};
	await flushPromises();

	expect(routerPush).toHaveBeenCalledWith('/claws');
});

test('startBinding inflight guard：上次 await 未结束时再次触发不重发 createBindingCode', async () => {
	// 让 createBindingCode 永远 pending，模拟"上一次还在飞"
	let resolveFirst;
	mockCreateBindingCode.mockReset().mockImplementation(() => new Promise((r) => { resolveFirst = r; }));

	const { wrapper } = createWrapper();
	await flushPromises();

	// mount 触发的 startBinding 已让 loading=true、createBindingCode 已发一次
	expect(mockCreateBindingCode).toHaveBeenCalledTimes(1);
	expect(wrapper.vm.loading).toBe(true);

	// 第二次手动调，应被 inflight guard 直接 return
	const r = wrapper.vm.startBinding();
	await flushPromises();
	expect(mockCreateBindingCode).toHaveBeenCalledTimes(1);

	// 让上一次完成，loading 恢复
	resolveFirst({ code: 'A1', expiresAt: new Date(Date.now() + 300_000).toISOString(), waitToken: 't' });
	await r;
	await flushPromises();
	expect(wrapper.vm.loading).toBe(false);

	// 后续再调可以正常走（不会被永久锁住）
	mockCreateBindingCode.mockResolvedValueOnce({ code: 'B2', expiresAt: new Date(Date.now() + 300_000).toISOString(), waitToken: 't2' });
	await wrapper.vm.startBinding();
	await flushPromises();
	expect(mockCreateBindingCode).toHaveBeenCalledTimes(2);
});

test('should defer baseline capture until store.fetched flips true', async () => {
	const pinia = createPinia();
	setActivePinia(pinia);
	const clawsStore = useClawsStore();
	clawsStore.byId = { existing1: { id: 'existing1' } };
	clawsStore.fetched = false; // SSE 还没推第一份 snapshot
	const routerPush = vi.fn();
	const wrapper = mount(AddClawPage, {
		global: {
			plugins: [pinia],
			stubs: {
				UButton: UButtonStub,
				UIcon: { props: ['name'], template: '<span />' },
			},
			mocks: {
				$t: (key, params) => {
					if (key === 'claws.expiryLeft') return `有效期剩余 ${params?.time ?? ''}`;
					return i18nMap[key] ?? key;
				},
				$router: { push: routerPush },
			},
		},
	});
	await flushPromises();

	// fetched=false 期间 baseline 没捕到，createBindingCode 也未调用
	expect(mockCreateBindingCode).not.toHaveBeenCalled();
	expect(wrapper.vm.baselineClawIds).toBeNull();

	// fetched 翻 true → captureBaseline 解锁，开始走后续流程
	clawsStore.fetched = true;
	await flushPromises();

	expect(mockCreateBindingCode).toHaveBeenCalled();
	expect(wrapper.vm.baselineClawIds).toBeInstanceOf(Set);
	// existing1 已纳入 baseline，不应触发跳转
	expect(routerPush).not.toHaveBeenCalled();

	// 正向断言：baseline 之后冒出的新 claw 仍能正常触发跳转
	clawsStore.byId.new1 = { id: 'new1' };
	await flushPromises();
	expect(routerPush).toHaveBeenCalledWith('/claws');
});
