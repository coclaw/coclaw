import { test, expect, describe, vi, beforeEach } from 'vitest';

// 捕获注册的 hooks（vi.hoisted 确保在 vi.mock 提升后仍可访问）
const { capture } = vi.hoisted(() => {
	const capture = { hooks: {} };
	return { capture };
});
vi.mock('./claws.store.js', () => ({
	__registerClawLifecycleHooks: (hooks) => { capture.hooks = hooks; },
}));

// mock 子 store
const mockRemoveSessionsByBotId = vi.fn();
const mockLoadAllSessions = vi.fn().mockResolvedValue();
vi.mock('./sessions.store.js', () => ({
	useSessionsStore: () => ({
		removeSessionsByClawId: mockRemoveSessionsByBotId,
		loadAllSessions: mockLoadAllSessions,
	}),
}));

const mockAgentsRemoveByBot = vi.fn();
const mockLoadAgents = vi.fn().mockResolvedValue();
vi.mock('./agents.store.js', () => ({
	useAgentsStore: () => ({
		removeByClaw: mockAgentsRemoveByBot,
		loadAgents: mockLoadAgents,
	}),
}));

const mockAgentRunsRemoveByBot = vi.fn();
const mockDispatch = vi.fn();
vi.mock('./agent-runs.store.js', () => ({
	useAgentRunsStore: () => ({
		removeByClaw: mockAgentRunsRemoveByBot,
		__dispatch: mockDispatch,
	}),
}));

let dashboardByBot = {};
const mockClearDashboard = vi.fn();
const mockLoadDashboard = vi.fn().mockResolvedValue();
vi.mock('./dashboard.store.js', () => ({
	useDashboardStore: () => ({
		byClaw: dashboardByBot,
		clearDashboard: mockClearDashboard,
		loadDashboard: mockLoadDashboard,
	}),
}));

const mockTopicsRemoveByBot = vi.fn();
const mockLoadAllTopics = vi.fn().mockResolvedValue();
vi.mock('./topics.store.js', () => ({
	useTopicsStore: () => ({
		removeByClaw: mockTopicsRemoveByBot,
		loadAllTopics: mockLoadAllTopics,
	}),
}));

const mockClearDirCacheByClaw = vi.fn();
vi.mock('./files.store.js', () => ({
	useFilesStore: () => ({
		clearDirCacheByClaw: mockClearDirCacheByClaw,
	}),
}));

// 导入模块触发自注册
import './claw-lifecycle.js';

beforeEach(() => {
	vi.clearAllMocks();
	dashboardByBot = {};
});

describe('bot-lifecycle 自注册', () => {
	test('导入时调用 __registerClawLifecycleHooks 注册所有 hooks', () => {
		expect(capture.hooks).toBeDefined();
		expect(typeof capture.hooks.cleanupClawResources).toBe('function');
		expect(typeof capture.hooks.syncDashboardOffline).toBe('function');
		expect(typeof capture.hooks.loadDashboardForClaw).toBe('function');
		expect(typeof capture.hooks.initClawResources).toBe('function');
		expect(typeof capture.hooks.refreshClawResources).toBe('function');
		expect(typeof capture.hooks.dispatchAgentEvent).toBe('function');
	});
});

describe('cleanupClawResources', () => {
	test('调用所有 6 个子 store 的 remove/clear 方法', () => {
		capture.hooks.cleanupClawResources('bot-1');

		expect(mockRemoveSessionsByBotId).toHaveBeenCalledWith('bot-1');
		expect(mockAgentsRemoveByBot).toHaveBeenCalledWith('bot-1');
		expect(mockAgentRunsRemoveByBot).toHaveBeenCalledWith('bot-1');
		expect(mockClearDashboard).toHaveBeenCalledWith('bot-1');
		expect(mockTopicsRemoveByBot).toHaveBeenCalledWith('bot-1');
		expect(mockClearDirCacheByClaw).toHaveBeenCalledWith('bot-1');
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

describe('loadDashboardForClaw', () => {
	test('调用 dashboard.loadDashboard', () => {
		capture.hooks.loadDashboardForClaw('bot-4');
		expect(mockLoadDashboard).toHaveBeenCalledWith('bot-4');
	});
});

describe('initClawResources', () => {
	test('await loadAgents 并 fire-and-forget 其他三个', async () => {
		await capture.hooks.initClawResources('bot-5');

		expect(mockLoadAgents).toHaveBeenCalledWith('bot-5');
		expect(mockLoadAllSessions).toHaveBeenCalled();
		expect(mockLoadAllTopics).toHaveBeenCalled();
		expect(mockLoadDashboard).toHaveBeenCalledWith('bot-5');
	});

	test('loadAgents 失败时抛出异常（不被 catch 吞没）', async () => {
		mockLoadAgents.mockRejectedValueOnce(new Error('fail'));
		await expect(capture.hooks.initClawResources('bot-5')).rejects.toThrow('fail');
	});

	test('fire-and-forget 调用失败不影响整体（被 .catch 吞没）', async () => {
		mockLoadAllSessions.mockRejectedValueOnce(new Error('session fail'));
		mockLoadAllTopics.mockRejectedValueOnce(new Error('topic fail'));
		mockLoadDashboard.mockRejectedValueOnce(new Error('dash fail'));

		// 不应抛出
		await expect(capture.hooks.initClawResources('bot-5')).resolves.toBeUndefined();
	});
});

describe('refreshClawResources', () => {
	test('全部 fire-and-forget 并带 .catch', () => {
		capture.hooks.refreshClawResources('bot-6');

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

		expect(() => capture.hooks.refreshClawResources('bot-6')).not.toThrow();
	});
});

describe('dispatchAgentEvent', () => {
	test('调用 agentRuns.__dispatch 并传递 payload', () => {
		const payload = { type: 'started', agentId: 'a1' };
		capture.hooks.dispatchAgentEvent(payload);
		expect(mockDispatch).toHaveBeenCalledWith(payload);
	});
});
