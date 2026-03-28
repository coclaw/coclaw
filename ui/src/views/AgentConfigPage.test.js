import { mount, flushPromises } from '@vue/test-utils';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import AgentConfigPage, {
	parseSoulMd,
	parseUserMd,
	parseMemoryBlocks,
	serializeMemoryBlocks,
} from './AgentConfigPage.vue';

// ---- mocks ----

const mockRequest = vi.fn().mockResolvedValue({ content: '' });
const mockConn = { request: mockRequest };

vi.mock('../services/bot-connection-manager.js', () => ({
	useBotConnections: () => ({
		get: () => mockConn,
	}),
}));

const mockNotify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => mockNotify,
}));

// ---- stubs ----

const UTabsStub = {
	props: ['modelValue', 'items'],
	emits: ['update:modelValue'],
	template: `<div>
		<button
			v-for="item in items"
			:key="item.value"
			:data-testid="'tab-' + item.value"
			@click="$emit('update:modelValue', item.value)"
		>{{ item.label }}</button>
		<slot v-if="modelValue === 'personality'" name="personality" />
		<slot v-if="modelValue === 'memory'" name="memory" />
		<slot v-if="modelValue === 'skills'" name="skills" />
		<slot v-if="modelValue === 'tools'" name="tools" />
	</div>`,
};

const UInputStub = {
	props: ['modelValue'],
	emits: ['update:modelValue'],
	template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};

const UTextareaStub = {
	props: ['modelValue', 'rows'],
	emits: ['update:modelValue'],
	template: '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};

const URadioGroupStub = {
	props: ['modelValue', 'items'],
	emits: ['update:modelValue'],
	template: '<div><span v-for="item in items" :key="item.value">{{ item.label }}</span></div>',
};

const UButtonStub = {
	props: ['icon', 'loading', 'disabled', 'color', 'variant', 'size', 'block'],
	emits: ['click'],
	template: '<button :disabled="disabled || loading" v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
	inheritAttrs: false,
};

const UModalStub = {
	props: ['open', 'title', 'ui'],
	emits: ['update:open'],
	template: '<div v-if="open"><slot name="body" /><slot name="footer" /></div>',
};

const globalStubs = {
	MobilePageHeader: { props: ['title'], template: '<header>{{ title }}</header>' },
	UTabs: UTabsStub,
	UInput: UInputStub,
	UTextarea: UTextareaStub,
	URadioGroup: URadioGroupStub,
	UButton: UButtonStub,
	UFormField: { props: ['label'], template: '<div><label>{{ label }}</label><slot /></div>' },
	USeparator: { template: '<hr />' },
	UAccordion: { props: ['items', 'collapsible'], template: '<div><slot /></div>' },
	UModal: UModalStub,
};

const mockRoute = { params: { botId: '1', agentId: 'main' } };

function createWrapper() {
	return mount(AgentConfigPage, {
		global: {
			stubs: globalStubs,
			mocks: {
				$t: (key) => key,
				$route: mockRoute,
				$router: { push: vi.fn(), back: vi.fn() },
			},
		},
	});
}

describe('AgentConfigPage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequest.mockResolvedValue({ content: '' });
	});

	test('renders page title', async () => {
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.text()).toContain('agentConfig.title');
	});

	test('renders all 4 tab buttons', async () => {
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.find('[data-testid="tab-personality"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="tab-memory"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="tab-skills"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="tab-tools"]').exists()).toBe(true);
	});

	test('default tab is personality', async () => {
		const wrapper = createWrapper();
		await flushPromises();
		// personality tab content should be visible
		expect(wrapper.text()).toContain('agentConfig.personality.agentName');
	});

	test('switching to memory tab shows memory content', async () => {
		const wrapper = createWrapper();
		await flushPromises();
		await wrapper.find('[data-testid="tab-memory"]').trigger('click');
		await flushPromises();
		expect(wrapper.text()).toContain('agentConfig.memory.empty');
	});

	test('loads SOUL.md, USER.md, MEMORY.md on mount', async () => {
		createWrapper();
		await flushPromises();
		expect(mockRequest).toHaveBeenCalledWith('agents.files.get', { agentId: 'main', name: 'SOUL.md' });
		expect(mockRequest).toHaveBeenCalledWith('agents.files.get', { agentId: 'main', name: 'USER.md' });
		expect(mockRequest).toHaveBeenCalledWith('agents.files.get', { agentId: 'main', name: 'MEMORY.md' });
	});

	test('missing file sets empty form', async () => {
		mockRequest.mockResolvedValue({ missing: true });
		const wrapper = createWrapper();
		await flushPromises();
		// 应该不报错，表单为空
		expect(wrapper.text()).toContain('agentConfig.personality.agentName');
	});

	test('save calls agents.files.set for SOUL.md and USER.md', async () => {
		const wrapper = createWrapper();
		await flushPromises();
		mockRequest.mockResolvedValue({});
		// 点保存
		const saveBtn = wrapper.findAll('button').find(b => b.text().includes('agentConfig.personality.save'));
		await saveBtn.trigger('click');
		await flushPromises();
		const setCalls = mockRequest.mock.calls.filter(c => c[0] === 'agents.files.set');
		expect(setCalls.length).toBe(2);
		expect(setCalls.some(c => c[1].name === 'SOUL.md')).toBe(true);
		expect(setCalls.some(c => c[1].name === 'USER.md')).toBe(true);
		expect(mockNotify.success).toHaveBeenCalled();
	});

	test('save error shows notify.error', async () => {
		const wrapper = createWrapper();
		await flushPromises();
		mockRequest.mockRejectedValue(new Error('Network error'));
		const saveBtn = wrapper.findAll('button').find(b => b.text().includes('agentConfig.personality.save'));
		await saveBtn.trigger('click');
		await flushPromises();
		expect(mockNotify.error).toHaveBeenCalled();
	});
});

describe('parseSoulMd', () => {
	test('parses valid SOUL.md', () => {
		const md = '## 身份\n- 名字：小助手\n- 语气：轻松\n## 专长\n编程\n写作\n## 补充说明\n无特殊要求';
		const result = parseSoulMd(md);
		expect(result.name).toBe('小助手');
		expect(result.tone).toBe('轻松');
		expect(result.skills).toBe('编程\n写作');
		expect(result.extra).toBe('无特殊要求');
	});

	test('returns empty for null input', () => {
		const result = parseSoulMd(null);
		expect(result).toEqual({ name: '', tone: '', skills: '', extra: '' });
	});

	test('returns empty for empty string', () => {
		const result = parseSoulMd('');
		expect(result).toEqual({ name: '', tone: '', skills: '', extra: '' });
	});
});

describe('parseUserMd', () => {
	test('parses valid USER.md', () => {
		const md = '## 关于我\n- 称谓：张三\n- 语言偏好：中文\n## 补充\n喜欢简洁回答';
		const result = parseUserMd(md);
		expect(result.name).toBe('张三');
		expect(result.lang).toBe('中文');
		expect(result.extra).toBe('喜欢简洁回答');
	});

	test('returns empty for null input', () => {
		const result = parseUserMd(null);
		expect(result).toEqual({ name: '', lang: '', extra: '' });
	});
});

describe('parseMemoryBlocks', () => {
	test('splits by ## headings', () => {
		const md = '## 标题一\n内容一\n\n## 标题二\n内容二';
		const blocks = parseMemoryBlocks(md);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].title).toBe('标题一');
		expect(blocks[0].content).toBe('内容一');
		expect(blocks[1].title).toBe('标题二');
		expect(blocks[1].content).toBe('内容二');
	});

	test('returns empty array for null', () => {
		expect(parseMemoryBlocks(null)).toEqual([]);
	});

	test('returns empty array for empty string', () => {
		expect(parseMemoryBlocks('')).toEqual([]);
	});

	test('handles heading with no content', () => {
		const blocks = parseMemoryBlocks('## 仅标题');
		expect(blocks).toHaveLength(1);
		expect(blocks[0].title).toBe('仅标题');
		expect(blocks[0].content).toBe('');
	});
});

describe('serializeMemoryBlocks', () => {
	test('serializes blocks back to markdown', () => {
		const blocks = [
			{ title: '标题一', content: '内容一' },
			{ title: '标题二', content: '内容二' },
		];
		const md = serializeMemoryBlocks(blocks);
		expect(md).toBe('## 标题一\n内容一\n\n## 标题二\n内容二');
	});

	test('empty array returns empty string', () => {
		expect(serializeMemoryBlocks([])).toBe('');
	});
});

describe('AgentConfigPage memory delete', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('delete memory block calls agents.files.set with updated content', async () => {
		mockRequest.mockImplementation((method, params) => {
			if (method === 'agents.files.get' && params.name === 'MEMORY.md') {
				return Promise.resolve({ content: '## 标题一\n内容一\n\n## 标题二\n内容二' });
			}
			return Promise.resolve({ content: '' });
		});

		const wrapper = createWrapper();
		await flushPromises();

		// 切换到 memory tab
		await wrapper.find('[data-testid="tab-memory"]').trigger('click');
		await flushPromises();

		// 应有2个 memory block
		expect(wrapper.text()).toContain('标题一');
		expect(wrapper.text()).toContain('标题二');

		// 点击第一个删除按钮（通过 data-testid 定位）
		const deleteButtons = wrapper.findAll('[data-testid="delete-memory-btn"]');
		expect(deleteButtons.length).toBe(2);

		await deleteButtons[0].trigger('click');
		await flushPromises();

		// 确认对话框应打开，点击确认按钮
		mockRequest.mockResolvedValue({});
		const confirmBtn = wrapper.findAll('button').find(b => b.text().includes('common.confirm'));
		expect(confirmBtn.exists()).toBe(true);
		await confirmBtn.trigger('click');
		await flushPromises();

		const setCalls = mockRequest.mock.calls.filter(c => c[0] === 'agents.files.set' && c[1].name === 'MEMORY.md');
		expect(setCalls.length).toBe(1);
		expect(setCalls[0][1].content).not.toContain('标题一');
		expect(setCalls[0][1].content).toContain('标题二');
	});
});
