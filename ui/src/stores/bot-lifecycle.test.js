import { test, expect, describe, vi, beforeEach } from 'vitest';

// 捕获注册的 hooks（vi.hoisted 确保在 vi.mock 提升后仍可访问）
const { capture } = vi.hoisted(() => {
	const capture = { hooks: {} };
	return { capture };
});
vi.mock('./bots.store.js', () => ({
	__registerBotLifecycleHooks: (hooks) => { capture.hooks = hooks; },
}));

// mock 子 store
const mockRemoveSessionsByBotId = vi.fn();
const mockLoadAllSessions = vi.fn().mockResolvedValue();
vi.mock('./sessions.store.js', () => ({
	useSessionsStore: () => ({
		removeSessionsByBotId: mockRemoveSessionsByBotId,
		loadAllSessions: mockLoadAllSessions,
	}),
}));

const mockAgentsRemoveByBot = vi.fn();
const mockLoadAgents = vi.fn().mockResolvedValue();
vi.mock('./agents.store.js', () => ({
	useAgentsStore: () => ({
		removeByBot: mockAgentsRemoveByBot,
		loadAgents: mockLoadAgents,
	}),
}));

const mockAgentRunsRemoveByBot = vi.fn();
const mockDispatch = vi.fn();
vi.mock('./agent-runs.store.js', () => ({
	useAgentRunsStore: () => ({
		removeByBot: mockAgentRunsRemoveByBot,
		__dispatch: mockDispatch,
	}),
}));

let dashboardByBot = {};
const mockClearDashboard = vi.fn();
const mockLoadDashboard = vi.fn().mockResolvedValue();
vi.mock('./dashboard.store.js', () => ({
	useDashboardStore: () => ({
		byBot: dashboardByBot,
		clearDashboard: mockClearDashboard,
		loadDashboard: mockLoadDashboard,
	}),
}));

const mockTopicsRemoveByBot = vi.fn();
const mockLoadAllTopics = vi.fn().mockResolvedValue();
vi.mock('./topics.store.js', () => ({
	useTopicsStore: () => ({
		removeByBot: mockTopicsRemoveByBot,
		loadAllTopics: mockLoadAllTopics,
	}),
}));

// 导入模块触发自注册
import './bot-lifecycle.js';

beforeEach(() => {
	vi.clearAllMocks();
	dashboardByBot = {};
});

describe('bot-lifecycle 自注册', () => {
	test('导入时调用 __registerBotLifecycleHooks 注册所有 hooks', () => {
		expect(capture.hooks).toBeDefined();
		expect(typeof capture.hooks.cleanupBotResources).toBe('function');
		expect(typeof capture.hooks.syncDashboardOffline).toBe('function');
		expect(typeof capture.hooks.loadDashboardForBot).toBe('function');
		expect(typeof capture.hooks.initBotResources).toBe('function');
		expect(typeof capture.hooks.refreshBotResources).toBe('function');
		expect(typeof capture.hooks.dispatchAgentEvent).toBe('function');
	});
});

describe('cleanupBotResources', () => {
	test('调用所有 5 个子 store 的 remove/clear 方法', () => {
		capture.hooks.cleanupBotResources('bot-1');

		expect(mockRemoveSessionsByBotId).toHaveBeenCalledWith('bot-1');
		expect(mockAgentsRemoveByBot).toHaveBeenCalledWith('bot-1');
		expect(mockAgentRunsRemoveByBot).toHaveBeenCalledWith('bot-1');
		expect(mockClearDashboard).toHaveBeenCalledWith('bot-1');
		expect(mockTopicsRemoveByBot).toHaveBeenCalledWith('bot-1');
	});
});

describe('syncDashboardOffline', () => {
	test('dashEntry.instance 存在时设置 online=false', () => {
		const instance = { online: true };
		dashboardByBot['bot-2'] = { instance };

		capture.hooks.syncDashboardOffline('bot-2');

		expect(instance.online).toBe(false);
	});

	test('dashEntry 不存在时不报错', () => {
		expect(() => capture.hooks.syncDashboardOffline('non-existent')).not.toThrow();
	});

	test('dashEntry 存在但 instance 为 null 时不报错', () => {
		dashboardByBot['bot-3'] = { instance: null };
		expect(() => capture.hooks.syncDashboardOffline('bot-3')).not.toThrow();
	});
});

describe('loadDashboardForBot', () => {
	test('调用 dashboard.loadDashboard', () => {
		capture.hooks.loadDashboardForBot('bot-4');
		expect(mockLoadDashboard).toHaveBeenCalledWith('bot-4');
	});
});

describe('initBotResources', () => {
	test('await loadAgents 并 fire-and-forget 其他三个', async () => {
		await capture.hooks.initBotResources('bot-5');

		expect(mockLoadAgents).toHaveBeenCalledWith('bot-5');
		expect(mockLoadAllSessions).toHaveBeenCalled();
		expect(mockLoadAllTopics).toHaveBeenCalled();
		expect(mockLoadDashboard).toHaveBeenCalledWith('bot-5');
	});

	test('loadAgents 失败时抛出异常（不被 catch 吞没）', async () => {
		mockLoadAgents.mockRejectedValueOnce(new Error('fail'));
		await expect(capture.hooks.initBotResources('bot-5')).rejects.toThrow('fail');
	});

	test('fire-and-forget 调用失败不影响整体（被 .catch 吞没）', async () => {
		mockLoadAllSessions.mockRejectedValueOnce(new Error('session fail'));
		mockLoadAllTopics.mockRejectedValueOnce(new Error('topic fail'));
		mockLoadDashboard.mockRejectedValueOnce(new Error('dash fail'));

		// 不应抛出
		await expect(capture.hooks.initBotResources('bot-5')).resolves.toBeUndefined();
	});
});

describe('refreshBotResources', () => {
	test('全部 fire-and-forget 并带 .catch', () => {
		capture.hooks.refreshBotResources('bot-6');

		expect(mockLoadAgents).toHaveBeenCalledWith('bot-6');
		expect(mockLoadAllSessions).toHaveBeenCalled();
		expect(mockLoadAllTopics).toHaveBeenCalled();
		expect(mockLoadDashboard).toHaveBeenCalledWith('bot-6');
	});

	test('所有调用失败时不抛出异常', () => {
		mockLoadAgents.mockRejectedValueOnce(new Error('fail'));
		mockLoadAllSessions.mockRejectedValueOnce(new Error('fail'));
		mockLoadAllTopics.mockRejectedValueOnce(new Error('fail'));
		mockLoadDashboard.mockRejectedValueOnce(new Error('fail'));

		expect(() => capture.hooks.refreshBotResources('bot-6')).not.toThrow();
	});
});

describe('dispatchAgentEvent', () => {
	test('调用 agentRuns.__dispatch 并传递 payload', () => {
		const payload = { type: 'started', agentId: 'a1' };
		capture.hooks.dispatchAgentEvent(payload);
		expect(mockDispatch).toHaveBeenCalledWith(payload);
	});
});
