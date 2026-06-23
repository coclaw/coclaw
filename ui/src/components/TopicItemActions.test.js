import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { beforeEach, expect, test, vi } from 'vitest';

const mockRequest = vi.fn();

vi.mock('../services/claw-connection-manager.js', () => ({
	useClawConnections: () => ({
		get: () => ({ state: 'connected', request: mockRequest, on: vi.fn(), off: vi.fn() }),
		connect: vi.fn(),
		disconnect: vi.fn(),
		syncConnections: vi.fn(),
		disconnectAll: vi.fn(),
	}),
	__resetClawConnections: vi.fn(),
}));

vi.mock('../services/claws.api.js', () => ({
	listClaws: vi.fn().mockResolvedValue([]),
}));

const mockNotify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => mockNotify,
}));

import TopicItemActions from './TopicItemActions.vue';
import { useTopicsStore } from '../stores/topics.store.js';
import { useClawsStore } from '../stores/claws.store.js';

// UDropdownMenu stub：渲染 trigger（默认插槽）+ 把 :items 平铺成按钮，便于断言项内容并模拟 select。
// onSelect 在点击时调用，等价真实组件的菜单项 @select。
const UDropdownMenuStub = {
	name: 'UDropdownMenu',
	props: ['items', 'open', 'content'],
	emits: ['update:open'],
	template: `
		<div class="dropdown-stub">
			<slot :open="open" />
			<button
				v-for="(it, i) in (items || [])"
				:key="i"
				type="button"
				class="dropdown-item"
				:data-color="it.color"
				@click="it.onSelect && it.onSelect()"
			>
				<slot name="item-leading" :item="it"><span class="icon" :name="it.icon" /></slot>
				<slot name="item-label" :item="it">{{ it.label }}</slot>
			</button>
		</div>
	`,
};

const UModalStub = {
	props: ['open', 'title', 'description'],
	emits: ['update:open'],
	template: '<div class="modal-stub" v-if="open"><slot name="body" /><slot name="footer" /></div>',
};

const UButtonStub = {
	props: ['disabled', 'loading', 'variant', 'color'],
	template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
};

const UInputStub = {
	props: ['modelValue', 'autofocus', 'placeholder'],
	emits: ['update:modelValue', 'keydown'],
	template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" @keydown="$emit(\'keydown\', $event)" />',
};

const UIconStub = {
	props: ['name'],
	template: '<span class="icon" />',
};

function createWrapper(props = {}) {
	const pinia = createPinia();
	setActivePinia(pinia);
	const clawsStore = useClawsStore();
	clawsStore.byId['bot-1'] = { id: 'bot-1', dcReady: true };
	return mount(TopicItemActions, {
		props: {
			topicId: 't1',
			clawId: 'bot-1',
			title: 'Test Topic',
			...props,
		},
		global: {
			plugins: [pinia],
			stubs: {
				UDropdownMenu: UDropdownMenuStub,
				UModal: UModalStub,
				UButton: UButtonStub,
				UInput: UInputStub,
				UIcon: UIconStub,
			},
			mocks: {
				$t: (key, params) => {
					const map = {
						'topic.rename': '重命名',
						'topic.delete': '删除',
						'topic.deleteConfirmTitle': '删除话题',
						'topic.deleteConfirmDesc': '确定删除？',
						'topic.deleteFailed': '删除失败',
						'topic.renameFailed': '重命名失败',
						'topic.newTopic': '新话题',
						'common.cancel': '取消',
						'common.confirm': '确认',
					};
					const base = map[key] ?? key;
					return params && params.name ? `${base} · ${params.name}` : base;
				},
			},
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockRequest.mockReset();
});

test('renders menu trigger button', () => {
	const wrapper = createWrapper();
	const button = wrapper.find('button');
	expect(button.exists()).toBe(true);
});

test('trigger aria-label carries row name when name prop is set (WCAG 2.4.6)', () => {
	const wrapper = createWrapper({ name: 'My Topic' });
	const label = wrapper.findAll('button')[0].attributes('aria-label');
	// locale 安全：走带占位符的新 key 且行名出现在标签内，不硬编码完整英文
	expect(label).toContain('common.moreActionsFor');
	expect(label).toContain('My Topic');
});

test('trigger aria-label falls back to generic label without name', () => {
	const wrapper = createWrapper({ name: '' });
	expect(wrapper.findAll('button')[0].attributes('aria-label')).toBe('common.moreActions');
});

test('menu shows rename and delete options', () => {
	const wrapper = createWrapper();
	expect(wrapper.text()).toContain('重命名');
	expect(wrapper.text()).toContain('删除');
});

test('menuItems：项数/标签/图标/危险项/回调全绑定到位（钉死配对，互换或丢色能测出）', () => {
	const wrapper = createWrapper();
	const items = wrapper.findComponent({ name: 'UDropdownMenu' }).props('items');
	expect(items).toHaveLength(2);

	expect(items[0].label).toBe('重命名');
	expect(items[0].icon).toBe('i-lucide-pencil');
	expect(items[0].color).toBeUndefined();

	// 删除是危险项：必须带 color 'error'（per-item 红色），图标 trash-2
	expect(items[1].label).toBe('删除');
	expect(items[1].icon).toBe('i-lucide-trash-2');
	expect(items[1].color).toBe('error');

	// onSelect 接到对应方法：调用即打开对应 modal
	items[0].onSelect();
	expect(wrapper.vm.renameOpen).toBe(true);
	items[1].onSelect();
	expect(wrapper.vm.deleteOpen).toBe(true);
});

test('clicking rename opens rename modal with current title', async () => {
	const wrapper = createWrapper({ title: 'My Title' });
	const buttons = wrapper.findAll('button');
	const renameBtn = buttons.find((b) => b.text() === '重命名');
	await renameBtn.trigger('click');
	expect(wrapper.vm.renameOpen).toBe(true);
	expect(wrapper.vm.renameValue).toBe('My Title');
});

test('rename with empty title does nothing', async () => {
	const wrapper = createWrapper();
	wrapper.vm.renameOpen = true;
	wrapper.vm.renameValue = '   ';
	await wrapper.vm.onConfirmRename();
	expect(mockRequest).not.toHaveBeenCalled();
});

test('successful rename calls updateTopic and shows notify', async () => {
	mockRequest.mockResolvedValue({ topic: { topicId: 't1', agentId: 'main', title: '新名称', createdAt: 100 } });

	const wrapper = createWrapper();
	const store = useTopicsStore();
	store.byId = { t1: { topicId: 't1', agentId: 'main', title: 'Old', createdAt: 100, clawId: 'bot-1' } };

	wrapper.vm.renameOpen = true;
	wrapper.vm.renameValue = '新名称';
	await wrapper.vm.onConfirmRename();

	expect(mockRequest).toHaveBeenCalledWith('coclaw.topics.update', { topicId: 't1', changes: { title: '新名称' } }, { timeout: 60_000 });
	expect(mockNotify.success).not.toHaveBeenCalled();
	expect(wrapper.vm.renameOpen).toBe(false);
});

test('failed rename shows error notify', async () => {
	mockRequest.mockRejectedValue(new Error('fail'));

	const wrapper = createWrapper();
	const store = useTopicsStore();
	store.byId = { t1: { topicId: 't1', agentId: 'main', title: 'Old', createdAt: 100, clawId: 'bot-1' } };

	wrapper.vm.renameOpen = true;
	wrapper.vm.renameValue = '新名称';
	await wrapper.vm.onConfirmRename();

	expect(mockNotify.error).toHaveBeenCalledWith('重命名失败');
	// modal 不关闭（用户可重试）
	expect(wrapper.vm.renaming).toBe(false);
});

test('clicking delete opens confirmation modal', async () => {
	const wrapper = createWrapper();
	const buttons = wrapper.findAll('button');
	const deleteBtn = buttons.find((b) => b.text() === '删除');
	await deleteBtn.trigger('click');
	expect(wrapper.vm.deleteOpen).toBe(true);
});

test('successful delete calls deleteTopic, shows notify and emits deleted', async () => {
	mockRequest.mockResolvedValue({ ok: true });

	const wrapper = createWrapper();
	const store = useTopicsStore();
	store.byId = { t1: { topicId: 't1', agentId: 'main', title: 'X', createdAt: 100, clawId: 'bot-1' } };

	wrapper.vm.deleteOpen = true;
	await wrapper.vm.onConfirmDelete();

	expect(mockRequest).toHaveBeenCalledWith('coclaw.topics.delete', { topicId: 't1' }, { timeout: 60_000 });
	expect(mockNotify.success).not.toHaveBeenCalled();
	expect(wrapper.vm.deleteOpen).toBe(false);
	expect(wrapper.emitted('deleted')).toBeTruthy();
	expect(wrapper.emitted('deleted')[0]).toEqual(['t1']);
});

test('deleting current topic navigates to default route', async () => {
	mockRequest.mockResolvedValue({ ok: true });
	const mockReplace = vi.fn();

	const wrapper = createWrapper();
	wrapper.vm.$route = { name: 'topics-chat', params: { sessionId: 't1' } };
	wrapper.vm.$router = { replace: mockReplace };

	const store = useTopicsStore();
	store.byId = { t1: { topicId: 't1', agentId: 'main', title: 'X', createdAt: 100, clawId: 'bot-1' } };

	wrapper.vm.deleteOpen = true;
	await wrapper.vm.onConfirmDelete();

	expect(mockReplace).toHaveBeenCalledWith('/');
	expect(wrapper.emitted('deleted')).toBeTruthy();
});

test('deleting non-current topic does not navigate', async () => {
	mockRequest.mockResolvedValue({ ok: true });
	const mockReplace = vi.fn();

	const wrapper = createWrapper();
	wrapper.vm.$route = { name: 'topics-chat', params: { sessionId: 'other-topic' } };
	wrapper.vm.$router = { replace: mockReplace };

	const store = useTopicsStore();
	store.byId = { t1: { topicId: 't1', agentId: 'main', title: 'X', createdAt: 100, clawId: 'bot-1' } };

	wrapper.vm.deleteOpen = true;
	await wrapper.vm.onConfirmDelete();

	expect(mockReplace).not.toHaveBeenCalled();
	expect(wrapper.emitted('deleted')).toBeTruthy();
});

test('failed delete shows error notify', async () => {
	mockRequest.mockRejectedValue(new Error('fail'));

	const wrapper = createWrapper();
	const store = useTopicsStore();
	store.byId = { t1: { topicId: 't1', agentId: 'main', title: 'X', createdAt: 100, clawId: 'bot-1' } };

	wrapper.vm.deleteOpen = true;
	await wrapper.vm.onConfirmDelete();

	expect(mockNotify.error).toHaveBeenCalledWith('删除失败');
	expect(wrapper.vm.deleting).toBe(false);
});
