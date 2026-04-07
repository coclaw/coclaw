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

const UPopoverStub = {
	props: ['open'],
	emits: ['update:open'],
	template: '<div class="popover-stub"><slot /><slot name="content" /></div>',
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
				UPopover: UPopoverStub,
				UModal: UModalStub,
				UButton: UButtonStub,
				UInput: UInputStub,
				UIcon: UIconStub,
			},
			mocks: {
				$t: (key) => {
					const map = {
						'topic.rename': '重命名',
						'topic.delete': '删除',
						'topic.deleteConfirmTitle': '删除话题',
						'topic.deleteConfirmDesc': '确定删除？',
						'topic.deleted': '已删除',
						'topic.deleteFailed': '删除失败',
						'topic.renamed': '已重命名',
						'topic.renameFailed': '重命名失败',
						'topic.newTopic': '新话题',
						'common.cancel': '取消',
						'common.confirm': '确认',
					};
					return map[key] ?? key;
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

test('menu shows rename and delete options', () => {
	const wrapper = createWrapper();
	expect(wrapper.text()).toContain('重命名');
	expect(wrapper.text()).toContain('删除');
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

	expect(mockRequest).toHaveBeenCalledWith('coclaw.topics.update', { topicId: 't1', changes: { title: '新名称' } });
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

	expect(mockRequest).toHaveBeenCalledWith('coclaw.topics.delete', { topicId: 't1' });
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
