import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useDashboardStore, __test__ } from './dashboard.store.js';

const {
	buildChannelList,
	extractToolIds,
	findCurrentModel,
	filterSessionsByAgent,
	computeSessionStats,
} = __test__;

// =====================================================================
// Mock
// =====================================================================

const mockConnections = new Map();

vi.mock('../services/bot-connection-manager.js', () => ({
	useBotConnections: () => ({
		get: (botId) => mockConnections.get(String(botId)),
		connect: vi.fn(),
		disconnect: vi.fn(),
		syncConnections: vi.fn(),
		disconnectAll: vi.fn(),
	}),
	__resetBotConnections: vi.fn(),
}));

vi.mock('../services/bots.api.js', () => ({
	listBots: vi.fn().mockResolvedValue([]),
}));

import { useBotsStore } from './bots.store.js';
import { useAgentsStore } from './agents.store.js';

// =====================================================================
// 辅助函数测试
// =====================================================================

describe('dashboard store helpers', () => {
	// -----------------------------------------------------------------
	// buildChannelList
	// -----------------------------------------------------------------
	describe('buildChannelList', () => {
		test('正常数据返回频道列表', () => {
			const data = {
				defaultAccountId: 'acc-1',
				discord: { accounts: [{ enabled: true }] },
				slack: { accounts: [{ enabled: false }] },
			};
			const result = buildChannelList(data);
			expect(result).toEqual([
				{ id: 'discord', connected: true },
				{ id: 'slack', connected: false },
			]);
		});

		test('account 无 enabled 字段视为启用', () => {
			const data = { telegram: { accounts: [{}] } };
			const result = buildChannelList(data);
			expect(result).toEqual([{ id: 'telegram', connected: true }]);
		});

		test('空数据返回空数组', () => {
			expect(buildChannelList({})).toEqual([]);
		});

		test('null 返回空数组', () => {
			expect(buildChannelList(null)).toEqual([]);
		});

		test('accounts 非数组时 connected 为 false', () => {
			const data = { web: { accounts: 'invalid' } };
			const result = buildChannelList(data);
			expect(result).toEqual([{ id: 'web', connected: false }]);
		});
	});

	// -----------------------------------------------------------------
	// extractToolIds
	// -----------------------------------------------------------------
	describe('extractToolIds', () => {
		test('正常 groups 提取工具 ID', () => {
			const catalog = {
				groups: [
					{ tools: [{ id: 'web_search' }, { id: 'web_fetch' }] },
					{ tools: [{ id: 'read' }] },
				],
			};
			expect(extractToolIds(catalog)).toEqual(['web_search', 'web_fetch', 'read']);
		});

		test('空 groups 返回空数组', () => {
			expect(extractToolIds({ groups: [] })).toEqual([]);
		});

		test('null 返回空数组', () => {
			expect(extractToolIds(null)).toEqual([]);
		});

		test('group.tools 非数组时跳过', () => {
			const catalog = { groups: [{ tools: 'bad' }, { tools: [{ id: 'exec' }] }] };
			expect(extractToolIds(catalog)).toEqual(['exec']);
		});
	});

	// -----------------------------------------------------------------
	// findCurrentModel
	// -----------------------------------------------------------------
	describe('findCurrentModel', () => {
		const catalog = [
			{ id: 'claude-3', name: 'Claude 3' },
			{ id: 'gpt-4', name: 'GPT-4' },
		];

		test('匹配成功返回模型', () => {
			expect(findCurrentModel('gpt-4', catalog)).toEqual({ id: 'gpt-4', name: 'GPT-4' });
		});

		test('不匹配返回 null', () => {
			expect(findCurrentModel('gemini', catalog)).toBeNull();
		});

		test('modelId 为 null 返回 null', () => {
			expect(findCurrentModel(null, catalog)).toBeNull();
		});

		test('catalog 为 null 返回 null', () => {
			expect(findCurrentModel('gpt-4', null)).toBeNull();
		});
	});

	// -----------------------------------------------------------------
	// filterSessionsByAgent
	// -----------------------------------------------------------------
	describe('filterSessionsByAgent', () => {
		const sessions = [
			{ key: 'agent:main:main', totalTokens: 100 },
			{ key: 'agent:main:sess-2', totalTokens: 200 },
			{ key: 'agent:ops:main', totalTokens: 50 },
			{ key: 'other:key', totalTokens: 10 },
		];

		test('过滤匹配 agentId 的 session', () => {
			const result = filterSessionsByAgent(sessions, 'main');
			expect(result).toHaveLength(2);
			expect(result[0].key).toBe('agent:main:main');
			expect(result[1].key).toBe('agent:main:sess-2');
		});

		test('无匹配返回空数组', () => {
			expect(filterSessionsByAgent(sessions, 'nonexist')).toEqual([]);
		});

		test('空列表返回空数组', () => {
			expect(filterSessionsByAgent([], 'main')).toEqual([]);
		});

		test('session 无 key 字段不匹配', () => {
			const result = filterSessionsByAgent([{ totalTokens: 1 }], 'main');
			expect(result).toEqual([]);
		});
	});

	// -----------------------------------------------------------------
	// computeSessionStats
	// -----------------------------------------------------------------
	describe('computeSessionStats', () => {
		test('汇总 tokens 并取最新 lastActivity', () => {
			const sessions = [
				{ totalTokens: 100, updatedAt: '2026-01-01T10:00:00Z' },
				{ totalTokens: 200, updatedAt: '2026-03-15T12:00:00Z' },
				{ totalTokens: 50, updatedAt: '2026-02-10T08:00:00Z' },
			];
			const result = computeSessionStats(sessions);
			expect(result.totalTokens).toBe(350);
			expect(result.activeSessions).toBe(3);
			expect(result.lastActivity).toBe(new Date('2026-03-15T12:00:00Z').toISOString());
		});

		test('空列表返回零值', () => {
			const result = computeSessionStats([]);
			expect(result.totalTokens).toBe(0);
			expect(result.activeSessions).toBe(0);
			expect(result.lastActivity).toBeNull();
		});

		test('session 无 totalTokens 不计入', () => {
			const sessions = [{ updatedAt: '2026-01-01T00:00:00Z' }];
			const result = computeSessionStats(sessions);
			expect(result.totalTokens).toBe(0);
			expect(result.activeSessions).toBe(1);
			expect(result.lastActivity).not.toBeNull();
		});

		test('session 无 updatedAt 不影响 lastActivity', () => {
			const sessions = [{ totalTokens: 42 }];
			const result = computeSessionStats(sessions);
			expect(result.totalTokens).toBe(42);
			expect(result.lastActivity).toBeNull();
		});
	});
});

// =====================================================================
// Store 集成测试
// =====================================================================

/**
 * 创建 mock conn，根据 method 路由返回不同数据
 * @param {Object<string, *>} rpcMap - method → 响应数据
 * @param {string} [state='connected']
 */
function mockConn(rpcMap = {}, state = 'connected') {
	return {
		state,
		request: vi.fn().mockImplementation((method, params) => {
			if (method in rpcMap) {
				const val = rpcMap[method];
				if (val instanceof Error) return Promise.reject(val);
				if (typeof val === 'function') return Promise.resolve(val(params));
				return Promise.resolve(val);
			}
			return Promise.resolve(null);
		}),
		on: vi.fn(),
		off: vi.fn(),
	};
}

/** 标准的 agents.list 和 agent.identity.get mock conn */
function mockAgentConn(agents, identityMap = {}, state = 'connected') {
	return {
		state,
		request: vi.fn().mockImplementation((method, params) => {
			if (method === 'agents.list') {
				return Promise.resolve({ defaultId: 'main', agents });
			}
			if (method === 'agent.identity.get') {
				return Promise.resolve(identityMap[params?.agentId] ?? null);
			}
			return Promise.resolve(null);
		}),
		on: vi.fn(),
		off: vi.fn(),
	};
}

describe('dashboard store', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		mockConnections.clear();
		vi.clearAllMocks();
	});

	test('getDashboard 无数据时返回 null', () => {
		const store = useDashboardStore();
		expect(store.getDashboard('bot-1')).toBeNull();
	});

	test('loadDashboard 成功加载完整数据', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'MyBot', online: true }]);
		botsStore.pluginInfo['bot-1'] = { version: '0.3.0', clawVersion: '0.7.0' };

		// 先注册 agents mock conn
		const agentConn = mockAgentConn(
			[{ id: 'main', name: 'Main', identity: { theme: 'blue' } }],
			{ main: { agentId: 'main', name: '小点', emoji: '🦞' } },
		);
		mockConnections.set('bot-1', agentConn);

		// 预加载 agents
		const agentsStore = useAgentsStore();
		await agentsStore.loadAgents('bot-1');

		// 替换为 dashboard RPC conn
		const dashConn = mockConn({
			'agents.list': { defaultId: 'main', agents: [{ id: 'main' }] },
			'agent.identity.get': (params) => ({ agentId: params?.agentId, name: '小点', emoji: '🦞' }),
			'status': { model: 'claude-3', provider: 'anthropic' },
			'models.list': { models: [{ id: 'claude-3', name: 'Claude 3', provider: 'anthropic', reasoning: true }] },
			'usage.cost': { total: 12.5, currency: 'USD' },
			'sessions.list': {
				sessions: [
					{ key: 'agent:main:main', totalTokens: 500, updatedAt: '2026-03-20T10:00:00Z' },
					{ key: 'agent:main:sess-2', totalTokens: 300, updatedAt: '2026-03-21T08:00:00Z' },
				],
			},
			'tts.status': { enabled: true },
			'channels.status': {
				defaultAccountId: 'acc-1',
				discord: { accounts: [{ enabled: true }] },
			},
			'tools.catalog': {
				groups: [{ tools: [{ id: 'web_search' }, { id: 'read' }] }],
			},
		});
		mockConnections.set('bot-1', dashConn);

		const store = useDashboardStore();
		await store.loadDashboard('bot-1');

		const entry = store.byBot['bot-1'];
		expect(entry.loading).toBe(false);
		expect(entry.error).toBeNull();

		// instance
		expect(entry.instance.name).toBe('MyBot');
		expect(entry.instance.online).toBe(true);
		expect(entry.instance.pluginVersion).toBe('0.3.0');
		expect(entry.instance.clawVersion).toBe('0.7.0');
		expect(entry.instance.monthlyCost).toEqual({ total: 12.5, currency: 'USD' });
		expect(entry.instance.channels).toEqual([{ id: 'discord', connected: true }]);
		expect(entry.instance.model).toBe('claude-3');
		expect(entry.instance.provider).toBe('anthropic');

		// agents
		expect(entry.agents).toHaveLength(1);
		const agent = entry.agents[0];
		expect(agent.id).toBe('main');
		expect(agent.name).toBe('小点');
		expect(agent.emoji).toBe('🦞');
		expect(agent.totalTokens).toBe(800);
		expect(agent.activeSessions).toBe(2);
		expect(agent.lastActivity).toBe(new Date('2026-03-21T08:00:00Z').toISOString());
		expect(agent.modelTags.length).toBeGreaterThan(0);
		expect(agent.capabilities.length).toBeGreaterThan(0);
		// web_search 匹配能力
		expect(agent.capabilities.some(c => c.id === 'web_search')).toBe(true);
		// tts 启用
		expect(agent.capabilities.some(c => c.id === 'tts')).toBe(true);
		// file_ops（read 匹配）
		expect(agent.capabilities.some(c => c.id === 'file_ops')).toBe(true);
	});

	test('loadDashboard 部分 RPC 失败时优雅降级', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'Bot', online: true }]);

		// 预加载 agents
		const agentConn = mockAgentConn([{ id: 'main', name: 'Main' }]);
		mockConnections.set('bot-1', agentConn);
		const agentsStore = useAgentsStore();
		await agentsStore.loadAgents('bot-1');

		// status 和 models 成功，其余失败
		const dashConn = mockConn({
			'status': { model: 'gpt-4', provider: 'openai' },
			'models.list': { models: [] },
			'usage.cost': new Error('rpc timeout'),
			'sessions.list': new Error('not available'),
			'tts.status': new Error('not supported'),
			'channels.status': new Error('failed'),
			'tools.catalog': new Error('catalog error'),
		});
		mockConnections.set('bot-1', dashConn);

		const store = useDashboardStore();
		await store.loadDashboard('bot-1');

		const entry = store.byBot['bot-1'];
		expect(entry.loading).toBe(false);
		expect(entry.error).toBeNull(); // allSettled 不触发 catch

		// 失败的 RPC 产出 null/空值
		expect(entry.instance.monthlyCost).toBeNull();
		expect(entry.instance.channels).toEqual([]);
		expect(entry.instance.model).toBe('gpt-4');

		// agent 能力为空（tools.catalog 失败）
		expect(entry.agents[0].capabilities).toEqual([]);
		expect(entry.agents[0].totalTokens).toBe(0);
		expect(entry.agents[0].activeSessions).toBe(0);
	});

	test('loadDashboard bot 未连接时直接返回', async () => {
		const store = useDashboardStore();
		await store.loadDashboard('no-conn');
		expect(store.byBot['no-conn']).toBeUndefined();
	});

	test('loadDashboard conn 状态非 connected 时直接返回', async () => {
		const conn = mockConn({}, 'connecting');
		mockConnections.set('bot-1', conn);

		const store = useDashboardStore();
		await store.loadDashboard('bot-1');
		expect(store.byBot['bot-1']).toBeUndefined();
		expect(conn.request).not.toHaveBeenCalled();
	});

	test('loadDashboard 异常时记录 error', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'Bot', online: true }]);

		// 预加载 agents 避免 loadAgents 内部吞错
		const agentConn = mockAgentConn([{ id: 'main' }]);
		mockConnections.set('bot-1', agentConn);
		const agentsStore = useAgentsStore();
		await agentsStore.loadAgents('bot-1');

		// conn.request 同步抛出（非 rejected promise），触发 catch
		const badConn = {
			state: 'connected',
			request: vi.fn().mockImplementation(() => { throw new Error('total failure'); }),
			on: vi.fn(),
			off: vi.fn(),
		};
		mockConnections.set('bot-1', badConn);

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const store = useDashboardStore();
		await store.loadDashboard('bot-1');

		const entry = store.byBot['bot-1'];
		expect(entry.loading).toBe(false);
		expect(entry.error).toBe('total failure');
		warnSpy.mockRestore();
	});

	test('clearDashboard 清除数据', async () => {
		const store = useDashboardStore();
		store.byBot['bot-1'] = { loading: false, error: null, instance: {}, agents: [] };
		expect(store.getDashboard('bot-1')).not.toBeNull();

		store.clearDashboard('bot-1');
		expect(store.getDashboard('bot-1')).toBeNull();
	});

	test('clearDashboard 对不存在的 bot 不报错', () => {
		const store = useDashboardStore();
		expect(() => store.clearDashboard('nonexist')).not.toThrow();
	});

	test('loadDashboard 将 botId 归一化为 string', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: '42', name: 'Bot42', online: true }]);

		const agentConn = mockAgentConn([{ id: 'main' }]);
		mockConnections.set('42', agentConn);
		const agentsStore = useAgentsStore();
		await agentsStore.loadAgents('42');

		const dashConn = mockConn({
			'status': {},
			'models.list': { models: [] },
			'usage.cost': null,
			'sessions.list': { sessions: [] },
			'tts.status': {},
			'channels.status': {},
			'tools.catalog': { groups: [] },
		});
		mockConnections.set('42', dashConn);

		const store = useDashboardStore();
		await store.loadDashboard(42);
		expect(store.byBot['42']).toBeDefined();
		expect(store.byBot['42'].loading).toBe(false);
	});

	test('loadDashboard agents 已加载时不重复调用 loadAgents', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'Bot', online: true }]);

		const agentConn = mockAgentConn([{ id: 'main' }]);
		mockConnections.set('bot-1', agentConn);
		const agentsStore = useAgentsStore();
		await agentsStore.loadAgents('bot-1');
		expect(agentsStore.byBot['bot-1'].fetched).toBe(true);

		// spy loadAgents 不应再被调用
		const loadSpy = vi.spyOn(agentsStore, 'loadAgents');

		const dashConn = mockConn({
			'status': {},
			'models.list': { models: [] },
			'usage.cost': null,
			'sessions.list': { sessions: [] },
			'tts.status': {},
			'channels.status': {},
			'tools.catalog': { groups: [] },
		});
		mockConnections.set('bot-1', dashConn);

		const store = useDashboardStore();
		await store.loadDashboard('bot-1');
		expect(loadSpy).not.toHaveBeenCalled();
	});
});
