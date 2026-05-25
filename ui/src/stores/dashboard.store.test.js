// @vitest-environment node
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useDashboardStore, __test__, computePrimaryEffective } from './dashboard.store.js';
import { __resetSessionsInternals, useSessionsStore } from './sessions.store.js';

const {
	buildChannelList,
	extractToolIds,
	findCurrentModel,
	filterSessionsByAgent,
	computeSessionStats,
	_loadingByClaw,
} = __test__;

// =====================================================================
// Mock
// =====================================================================

const mockConnections = new Map();

vi.mock('../services/claw-connection-manager.js', () => ({
	useClawConnections: () => ({
		get: (clawId) => mockConnections.get(String(clawId)),
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

import { useClawsStore } from './claws.store.js';
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

		test('accounts 非数组时该条目被过滤', () => {
			const data = { web: { accounts: 'invalid' } };
			const result = buildChannelList(data);
			expect(result).toEqual([]);
		});

		test('元数据属性（ts、channelOrder 等）被正确过滤', () => {
			const data = {
				ts: 1234567890,
				channelOrder: ['discord', 'slack'],
				channelLabels: { discord: 'Discord' },
				channelDetailLabels: {},
				channelSystemImageUrl: 'https://example.com/img.png',
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
function mockConn(rpcMap = {}) {
	return {
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
function mockAgentConn(agents, identityMap = {}) {
	return {
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

/** 注册 mock conn 并设置 clawsStore 中 claw 的 dcReady */
function setConn(clawId, conn, { dcReady = true } = {}) {
	mockConnections.set(String(clawId), conn);
	const clawsStore = useClawsStore();
	if (!clawsStore.byId[String(clawId)]) {
		clawsStore.byId[String(clawId)] = { id: String(clawId), dcReady };
	} else {
		clawsStore.byId[String(clawId)].dcReady = dcReady;
	}
}

describe('dashboard store', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		mockConnections.clear();
		_loadingByClaw.clear();
		// sessions.store 是真依赖（dashboard 通过 useSessionsStore 调用 getRawSessionsForClaw）
		// 必须清掉 sessions.store 模块级 _perClawLoading / _rawByClaw / _loadingPromise，
		// 避免上一个测试的 raw 缓存被本测试命中（getRawSessionsForClaw 跳过 RPC）
		__resetSessionsInternals();
		vi.clearAllMocks();
	});

	test('getDashboard 无数据时返回 null', () => {
		const store = useDashboardStore();
		expect(store.getDashboard('bot-1')).toBeNull();
	});

	test('loadDashboard 成功加载完整数据', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'MyBot', online: true }]);
		clawsStore.byId['bot-1'].pluginInfo = { version: '0.3.0', clawVersion: '0.7.0' };

		// 先注册 agents mock conn
		const agentConn = mockAgentConn(
			[{ id: 'main', name: 'Main', identity: { theme: 'blue' } }],
			{ main: { agentId: 'main', name: '小点', emoji: '🦞' } },
		);
		setConn('bot-1', agentConn);

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
		setConn('bot-1', dashConn);

		const store = useDashboardStore();
		await store.loadDashboard('bot-1');

		const entry = store.byClaw['bot-1'];
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

	test('instance.name 优先使用 pluginInfo.name，其次 hostName，再 claw.name', async () => {
		const clawsStore = useClawsStore();

		// 有 pluginInfo.name 时使用 pluginInfo.name
		clawsStore.setClaws([{ id: 'bot-1', name: 'ServerName', online: true }]);
		clawsStore.byId['bot-1'].pluginInfo = { version: '0.3.0', clawVersion: '0.7.0', name: 'My Claw', hostName: 'host1' };

		const agentConn = mockAgentConn([{ id: 'main', name: 'Main' }]);
		setConn('bot-1', agentConn);
		const agentsStore = useAgentsStore();
		await agentsStore.loadAgents('bot-1');

		const dashConn = mockConn({
			'agents.list': { defaultId: 'main', agents: [{ id: 'main' }] },
			'status': { model: 'claude-3', provider: 'anthropic' },
			'models.list': { models: [] },
			'usage.cost': { total: 0, currency: 'USD' },
			'sessions.list': { sessions: [] },
			'tts.status': { enabled: false },
			'channels.status': {},
			'tools.catalog': { groups: [] },
		});
		setConn('bot-1', dashConn);

		const store = useDashboardStore();
		await store.loadDashboard('bot-1');
		expect(store.byClaw['bot-1'].instance.name).toBe('My Claw');

		// 无 pluginInfo.name 时回退到 hostName
		clawsStore.byId['bot-1'].pluginInfo = { version: '0.3.0', clawVersion: '0.7.0', name: null, hostName: 'host1' };
		await store.loadDashboard('bot-1');
		expect(store.byClaw['bot-1'].instance.name).toBe('host1');

		// 无 pluginInfo 时回退到 claw.name
		clawsStore.byId['bot-1'].pluginInfo = null;
		await store.loadDashboard('bot-1');
		expect(store.byClaw['bot-1'].instance.name).toBe('ServerName');

		// 无 claw.name 时回退到 OpenClaw
		clawsStore.byId['bot-1'].name = null;
		clawsStore.byId['bot-1'].pluginInfo = null;
		await store.loadDashboard('bot-1');
		expect(store.byClaw['bot-1'].instance.name).toBe('OpenClaw');
	});

	test('loadDashboard 部分 RPC 失败时优雅降级', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

		// 预加载 agents
		const agentConn = mockAgentConn([{ id: 'main', name: 'Main' }]);
		setConn('bot-1', agentConn);
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
		setConn('bot-1', dashConn);

		const store = useDashboardStore();
		await store.loadDashboard('bot-1');

		const entry = store.byClaw['bot-1'];
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

	test('loadDashboard claw 未连接时直接返回', async () => {
		const store = useDashboardStore();
		await store.loadDashboard('no-conn');
		expect(store.byClaw['no-conn']).toBeUndefined();
	});

	test('loadDashboard conn 状态非 connected 时直接返回且不污染飞行中守卫', async () => {
		const conn = mockConn({});
		setConn('bot-1', conn, { dcReady: false });

		const store = useDashboardStore();
		await store.loadDashboard('bot-1');
		expect(store.byClaw['bot-1']).toBeUndefined();
		expect(conn.request).not.toHaveBeenCalled();
		// 提前返回不应留下飞行中守卫
		expect(_loadingByClaw.has('bot-1')).toBe(false);
	});

	test('loadDashboard 异常时记录 error', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

		// 预加载 agents 避免 loadAgents 内部吞错
		const agentConn = mockAgentConn([{ id: 'main' }]);
		setConn('bot-1', agentConn);
		const agentsStore = useAgentsStore();
		await agentsStore.loadAgents('bot-1');

		// conn.request 同步抛出（非 rejected promise），触发 catch
		const badConn = {
			request: vi.fn().mockImplementation(() => { throw new Error('total failure'); }),
			on: vi.fn(),
			off: vi.fn(),
		};
		setConn('bot-1', badConn);

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const store = useDashboardStore();
		await store.loadDashboard('bot-1');

		const entry = store.byClaw['bot-1'];
		expect(entry.loading).toBe(false);
		expect(entry.error).toBe('total failure');
		// 失败后飞行中守卫应已清理
		expect(_loadingByClaw.has('bot-1')).toBe(false);
		warnSpy.mockRestore();
	});

	test('clearDashboard 清除数据', async () => {
		const store = useDashboardStore();
		store.byClaw['bot-1'] = { loading: false, error: null, instance: {}, agents: [] };
		expect(store.getDashboard('bot-1')).not.toBeNull();

		store.clearDashboard('bot-1');
		expect(store.getDashboard('bot-1')).toBeNull();
	});

	test('clearDashboard 对不存在的 claw 不报错', () => {
		const store = useDashboardStore();
		expect(() => store.clearDashboard('nonexist')).not.toThrow();
	});

	test('loadDashboard 将 clawId 归一化为 string', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: '42', name: 'Bot42', online: true }]);

		const agentConn = mockAgentConn([{ id: 'main' }]);
		setConn('42', agentConn);
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
		setConn('42', dashConn);

		const store = useDashboardStore();
		await store.loadDashboard(42);
		expect(store.byClaw['42']).toBeDefined();
		expect(store.byClaw['42'].loading).toBe(false);
	});

	test('loadDashboard 并发调用复用飞行中 promise', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

		const agentConn = mockAgentConn([{ id: 'main' }]);
		setConn('bot-1', agentConn);
		const agentsStore = useAgentsStore();
		await agentsStore.loadAgents('bot-1');

		const dashConn = mockConn({
			'status': {},
			'models.list': { models: [] },
			'usage.cost': null,
			'sessions.list': { sessions: [] },
			'tts.status': {},
			'channels.status': {},
			'tools.catalog': { groups: [] },
		});
		setConn('bot-1', dashConn);

		const store = useDashboardStore();
		const p1 = store.loadDashboard('bot-1');
		const p2 = store.loadDashboard('bot-1');

		await Promise.all([p1, p2]);

		// 飞行中 map 已清理
		expect(_loadingByClaw.has('bot-1')).toBe(false);

		// RPC 仅调用一批（status 只调用一次）
		const statusCalls = dashConn.request.mock.calls.filter(([m]) => m === 'status');
		expect(statusCalls).toHaveLength(1);
	});

	test('所有 dashboard 直接发起的 RPC 请求都带 180s timeout 选项（弱网超时防御）', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

		const agentConn = mockAgentConn([{ id: 'main', name: 'Main' }]);
		setConn('bot-1', agentConn);
		const agentsStore = useAgentsStore();
		await agentsStore.loadAgents('bot-1');

		const dashConn = mockConn({
			'status': { model: 'claude-3' },
			'models.list': { models: [] },
			'usage.cost': { total: 0 },
			'sessions.list': { sessions: [] },
			'tts.status': { enabled: false },
			'channels.status': {},
			'tools.catalog': { groups: [] },
		});
		setConn('bot-1', dashConn);

		const store = useDashboardStore();
		await store.loadDashboard('bot-1');

		// dashboard 直接发起的 8 种方法（sessions.list 已下放给 sessionsStore，单独验证）
		const expectedMethods = [
			'status',
			'models.list',
			'usage.cost',
			'tts.status',
			'channels.status',
			'coclaw.providerAuth.list',
			'coclaw.model.list',
			'tools.catalog',
		];

		for (const method of expectedMethods) {
			const calls = dashConn.request.mock.calls.filter(([m]) => m === method);
			expect(calls.length).toBeGreaterThanOrEqual(1);
			for (const call of calls) {
				// 第三个参数必须包含 timeout: 180_000
				expect(call[2]).toBeDefined();
				expect(call[2]).toMatchObject({ timeout: 180_000 });
			}
		}

		// dashboard 直接发的总 call 数精确等于 8（7 + tools.catalog × 1 agent）
		const dashCalls = dashConn.request.mock.calls.filter(([m]) => expectedMethods.includes(m));
		expect(dashCalls).toHaveLength(8);

		// 关键参数也同时校验（确保不是空 params 而 options 偷跑）
		const usageCostCall = dashConn.request.mock.calls.find(([m]) => m === 'usage.cost');
		expect(usageCostCall[1]).toEqual({ mode: 'month' });
		const channelsCall = dashConn.request.mock.calls.find(([m]) => m === 'channels.status');
		expect(channelsCall[1]).toEqual({ probe: false });
		// models.list 必须用 view:'all'——model-config 失效校验依据（设计 § 7.2）
		const modelsListCall = dashConn.request.mock.calls.find(([m]) => m === 'models.list');
		expect(modelsListCall[1]).toEqual({ view: 'all' });

		// sessions.list 由 sessionsStore.getRawSessionsForClaw 间接发起，
		// timeout 是 sessions.store 自己的 60_000（不是 dashboard 的 180_000）
		const sessionsCalls = dashConn.request.mock.calls.filter(([m]) => m === 'sessions.list');
		expect(sessionsCalls).toHaveLength(1);
		expect(sessionsCalls[0][2]).toMatchObject({ timeout: 60_000 });
	});

	test('tools.catalog 在多 agent 场景下每次调用都带 180s timeout', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

		const agents = [
			{ id: 'main', name: 'Main' },
			{ id: 'ops', name: 'Ops' },
			{ id: 'research', name: 'Research' },
		];
		const agentConn = mockAgentConn(agents);
		setConn('bot-1', agentConn);
		const agentsStore = useAgentsStore();
		await agentsStore.loadAgents('bot-1');

		const dashConn = mockConn({
			'status': { model: 'claude-3' },
			'models.list': { models: [] },
			'usage.cost': { total: 0 },
			'sessions.list': { sessions: [] },
			'tts.status': { enabled: false },
			'channels.status': {},
			'tools.catalog': { groups: [] },
		});
		setConn('bot-1', dashConn);

		const store = useDashboardStore();
		await store.loadDashboard('bot-1');

		// tools.catalog 被调用 3 次（每个 agent 各一次），每次都带 timeout: 180_000
		const toolsCalls = dashConn.request.mock.calls.filter(([m]) => m === 'tools.catalog');
		expect(toolsCalls).toHaveLength(3);

		// 每一次调用的 agentId 与 agent.id 对应，且 options 都带 180s timeout
		const seenAgentIds = new Set();
		for (const call of toolsCalls) {
			expect(call[1]).toHaveProperty('agentId');
			seenAgentIds.add(call[1].agentId);
			expect(call[2]).toMatchObject({ timeout: 180_000 });
		}
		expect(seenAgentIds).toEqual(new Set(['main', 'ops', 'research']));

		// 基础 7 个 RPC 也仍然各带 timeout（sessions.list 已下放给 sessionsStore）
		for (const method of [
			'status', 'models.list', 'usage.cost', 'tts.status', 'channels.status',
			'coclaw.providerAuth.list', 'coclaw.model.list',
		]) {
			const call = dashConn.request.mock.calls.find(([m]) => m === method);
			expect(call).toBeDefined();
			expect(call[2]).toMatchObject({ timeout: 180_000 });
		}
	});

	// P2-2: 第二次 loadDashboard 某个 RPC reject 时的字段语义
	// 当前实现：entry.instance 整个被重写；reject 字段被写成 null（无条件覆盖），不保留旧值
	// 注：如果将来要改成"保留旧值"，本测试也要相应修改
	test('第二次 loadDashboard reject 字段被写为 null（锁定当前无条件覆盖行为；不保留旧值）', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);
		clawsStore.byId['bot-1'].pluginInfo = { version: '0.5.0', clawVersion: '2026.3.14' };

		const agentConn = mockAgentConn([{ id: 'main', name: 'Main' }]);
		setConn('bot-1', agentConn);
		const agentsStore = useAgentsStore();
		await agentsStore.loadAgents('bot-1');

		// 第一次：全成功
		const dashConn = mockConn({
			'status': { model: 'claude-3', provider: 'anthropic' },
			'models.list': { models: [] },
			'usage.cost': { total: 50, currency: 'USD' },
			'sessions.list': { sessions: [] },
			'tts.status': { enabled: false },
			'channels.status': { discord: { accounts: [{ enabled: true }] } },
			'tools.catalog': { groups: [] },
		});
		setConn('bot-1', dashConn);

		const store = useDashboardStore();
		await store.loadDashboard('bot-1');

		const entry1 = store.byClaw['bot-1'];
		expect(entry1.instance.monthlyCost).toEqual({ total: 50, currency: 'USD' });
		expect(entry1.instance.channels).toEqual([{ id: 'discord', connected: true }]);
		expect(entry1.instance.model).toBe('claude-3');

		// 第二次：usage.cost reject、其他成功；锁定"reject 字段被写 null/默认值"
		const dashConn2 = mockConn({
			'status': { model: 'claude-3.5', provider: 'anthropic' },
			'models.list': { models: [] },
			'usage.cost': new Error('rpc timeout'),
			'sessions.list': { sessions: [] },
			'tts.status': { enabled: false },
			'channels.status': { discord: { accounts: [{ enabled: true }] } },
			'tools.catalog': { groups: [] },
		});
		setConn('bot-1', dashConn2);

		await store.loadDashboard('bot-1');

		const entry2 = store.byClaw['bot-1'];
		// reject 字段被写 null（不保留旧 50/USD）——dashboard.store.js 当前实现是无条件覆盖
		expect(entry2.instance.monthlyCost).toBeNull();
		// 其他成功 RPC 字段被新值覆盖
		expect(entry2.instance.model).toBe('claude-3.5');
		expect(entry2.instance.channels).toEqual([{ id: 'discord', connected: true }]);
	});

	test('loadDashboard agents 已加载时不重复调用 loadAgents', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

		const agentConn = mockAgentConn([{ id: 'main' }]);
		setConn('bot-1', agentConn);
		const agentsStore = useAgentsStore();
		await agentsStore.loadAgents('bot-1');
		expect(agentsStore.byClaw['bot-1'].fetched).toBe(true);

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
		setConn('bot-1', dashConn);

		const store = useDashboardStore();
		await store.loadDashboard('bot-1');
		expect(loadSpy).not.toHaveBeenCalled();
	});

	// 与 agents/sessions/topics 三 store 对称：clearDashboard 必须同步清飞行中 dedup
	// Map，避免同 id 重绑后新 loadDashboard 命中 dedup 拿到旧 promise（旧 promise
	// 完成后写到 byClaw 的是旧 claw 的实例信息）
	// 注：生产路径 cleanupClawResources 同时调 clearDashboard + removeSessionsByClawId
	// （见 claw-lifecycle.js），测试也需模拟该编排——dashboard 走 sessionsStore 取 raw 后，
	// 单独清 dashboard dedup 无法解开 sessions 那边的 inflight 锁
	test('clearDashboard 同步清飞行中 dedup：同 id 重绑后新 loadDashboard 走独立请求', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

		const agentConn = mockAgentConn([{ id: 'main' }]);
		setConn('bot-1', agentConn);
		const agentsStore = useAgentsStore();
		await agentsStore.loadAgents('bot-1');

		// 旧 conn：所有 RPC 都 deferred（永不 resolve），让旧 loadDashboard 长期飞行中
		const oldConn = {
			request: vi.fn().mockImplementation(() => new Promise(() => {})),
			on: vi.fn(),
			off: vi.fn(),
		};
		setConn('bot-1', oldConn);

		const store = useDashboardStore();
		const sessionsStore = useSessionsStore();
		// fire-and-forget：不取 promise（IIFE 永不 settle 是预期，由 GC 兜底）
		store.loadDashboard('bot-1');
		expect(_loadingByClaw.has('bot-1')).toBe(true);
		// 至少触发了首批 RPC
		expect(oldConn.request).toHaveBeenCalled();

		// 清除 + 同 id 重绑：飞行中 dedup 必须被清掉（同时模拟 cleanupClawResources 的完整动作）
		store.clearDashboard('bot-1');
		sessionsStore.removeSessionsByClawId('bot-1');
		expect(_loadingByClaw.has('bot-1')).toBe(false);

		// 重新挂 conn 用一个立即 resolve 的新对象，模拟同 id 新 claw
		const newConn = mockConn({
			'status': { model: 'claude-3' },
			'models.list': { models: [] },
			'usage.cost': null,
			'sessions.list': { sessions: [] },
			'tts.status': {},
			'channels.status': {},
			'tools.catalog': { groups: [] },
		});
		setConn('bot-1', newConn);

		// 新 loadDashboard：应走独立请求（不被旧 dedup 命中）
		const newPromise = store.loadDashboard('bot-1');
		expect(newConn.request).toHaveBeenCalled();

		await newPromise;
	});

	// 与 agents/sessions/topics 三 store 对称：旧 promise resolve 后 finally 必须做 identity
	// check，避免擦掉 NEW promise 已写入的 dedup 入口（否则下次同 id loadDashboard 再
	// 命中 dedup miss 多发一批 RPC）
	test('同 id 重绑：旧 loadDashboard 的 stale finally 不删替换 promise', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

		const agentConn = mockAgentConn([{ id: 'main' }]);
		setConn('bot-1', agentConn);
		const agentsStore = useAgentsStore();
		await agentsStore.loadAgents('bot-1');

		// 旧 conn：所有 RPC 立即 resolve，让旧 loadDashboard 自然完成（finally 触发）
		const oldConn = mockConn({
			'status': {}, 'models.list': {}, 'usage.cost': null, 'sessions.list': {},
			'tts.status': {}, 'channels.status': {}, 'tools.catalog': { groups: [] },
		});
		setConn('bot-1', oldConn);

		const store = useDashboardStore();
		const oldPromise = store.loadDashboard('bot-1');
		expect(_loadingByClaw.has('bot-1')).toBe(true);

		// 立即 clearDashboard 同步清 dedup（让旧 finally 跑时 Map 已被换成 NEW 入口）
		store.clearDashboard('bot-1');
		expect(_loadingByClaw.has('bot-1')).toBe(false);

		// 新 conn：deferred，让新 loadDashboard 留在 dedup map 里供 identity 比对
		const newConn = {
			request: vi.fn().mockImplementation(() => new Promise(() => {})),
			on: vi.fn(),
			off: vi.fn(),
		};
		setConn('bot-1', newConn);

		// 第一次新 loadDashboard：fire-and-forget，新 promise 入 dedup map
		store.loadDashboard('bot-1');
		expect(_loadingByClaw.has('bot-1')).toBe(true);
		const newCallsAfter1 = newConn.request.mock.calls.length;
		expect(newCallsAfter1).toBeGreaterThan(0);

		// 等旧 promise 完成（让 stale finally 跑）
		await oldPromise;
		await Promise.resolve();
		await Promise.resolve();

		// 关键：旧 finally 的 identity check 应阻止它擦掉新 entry
		expect(_loadingByClaw.has('bot-1')).toBe(true);

		// 第二次同 id loadDashboard：被新 promise dedup 拦下，不发起新一批 RPC
		store.loadDashboard('bot-1');
		expect(newConn.request.mock.calls.length).toBe(newCallsAfter1);
	});

	// sessions raw 走 sessionsStore：消除 dashboard 与 sessions.store 各发一次 sessions.list 的重复 RPC
	describe('sessions raw 走 sessionsStore（消除 sessions.list 重复 RPC）', () => {
		test('loadDashboard 不直接发起 sessions.list（仅由 sessionsStore 代发一次）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			const dashConn = mockConn({
				'status': {},
				'models.list': { models: [] },
				'usage.cost': null,
				'sessions.list': { sessions: [{ key: 'agent:main:main', totalTokens: 100, updatedAt: '2026-01-01T00:00:00Z' }] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			await store.loadDashboard('bot-1');

			// sessions.list 总计仅一次（由 sessionsStore 发，timeout 60s）
			const sessionsCalls = dashConn.request.mock.calls.filter(([m]) => m === 'sessions.list');
			expect(sessionsCalls).toHaveLength(1);
			expect(sessionsCalls[0][2]).toMatchObject({ timeout: 60_000 });

			// dashboard 统计仍由 raw 数据驱动
			expect(store.byClaw['bot-1'].agents[0].totalTokens).toBe(100);
		});

		test('第二次 loadDashboard（无 force）复用 sessionsStore raw 缓存：sessions.list 不重发', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			const dashConn = mockConn({
				'status': {},
				'models.list': { models: [] },
				'usage.cost': null,
				'sessions.list': { sessions: [] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			await store.loadDashboard('bot-1');
			const sessionsCallsAfter1 = dashConn.request.mock.calls.filter(([m]) => m === 'sessions.list').length;
			expect(sessionsCallsAfter1).toBe(1);

			// 第二次默认 force=false：sessions.list 不重发（命中 sessionsStore raw 缓存）
			await store.loadDashboard('bot-1');
			const sessionsCallsAfter2 = dashConn.request.mock.calls.filter(([m]) => m === 'sessions.list').length;
			expect(sessionsCallsAfter2).toBe(1);
		});

		test('force=true 透传到 sessionsStore → 重新拉取 sessions.list', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			const dashConn = mockConn({
				'status': {},
				'models.list': { models: [] },
				'usage.cost': null,
				'sessions.list': { sessions: [] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			await store.loadDashboard('bot-1');
			expect(dashConn.request.mock.calls.filter(([m]) => m === 'sessions.list')).toHaveLength(1);

			// force=true：sessions.list 应被重新调用
			await store.loadDashboard('bot-1', { force: true });
			expect(dashConn.request.mock.calls.filter(([m]) => m === 'sessions.list')).toHaveLength(2);
		});

		test('force=true 进入时若当前飞行非 force：等其完成后启动新一轮（不被合流吞掉）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			// dashConn 的 sessions.list 用 deferred resolver，便于精确控制飞行时序
			let resolveSessions;
			const sessionsPromise = new Promise((r) => { resolveSessions = r; });
			const dashConn = {
				request: vi.fn().mockImplementation((method) => {
					if (method === 'sessions.list') return sessionsPromise;
					return Promise.resolve({});
				}),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			// 第一次（非 force）：进入飞行
			const p1 = store.loadDashboard('bot-1');
			// 第二次（force=true）：当前飞行非 force，应等其完成再启动新一轮
			const p2 = store.loadDashboard('bot-1', { force: true });

			// 此时第一次飞行还没完，sessions.list 已发一次（第一次的）
			expect(dashConn.request.mock.calls.filter(([m]) => m === 'sessions.list')).toHaveLength(1);

			// 完成第一次飞行
			resolveSessions({ sessions: [] });
			await p1;

			// 第二次 force 应启动新一轮：sessions.list 再被调一次
			// 注：新一轮的 sessions.list 也是 deferred（共享同一个 sessionsPromise，已 resolve），所以会立即完成
			await p2;
			expect(dashConn.request.mock.calls.filter(([m]) => m === 'sessions.list')).toHaveLength(2);
		});

		test('dashboard + sessionsStore 同 claw 并发：只发一次 sessions.list（最核心设计点）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			// sessions raw 用 ISO 字符串 updatedAt（gateway 返回的真实格式，dashboard.stats 用 new Date 解析），
			// 同时给 live key 配 sessionId + 一条 orphan 条目带 numeric updatedAt 让 SessionItem 折叠也通过
			const dashConn = mockConn({
				'status': {},
				'models.list': { models: [] },
				'usage.cost': null,
				'sessions.list': { sessions: [
					{ key: 'agent:main:main', sessionId: 'sid-live', totalTokens: 42, updatedAt: '2026-01-01T00:00:00Z' },
					{ key: 'agent:main:sess-orph', sessionId: 'sid-orph', totalTokens: 8, updatedAt: 1730_000_000_000 },
				] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			const sessionsStore = useSessionsStore();
			// 同一 claw 上 dashboard 与 sessions.store 同时触发：模拟 lifecycle initClawResources
			// 顺序（sessions → dashboard 并发，fire-and-forget）
			await Promise.all([
				sessionsStore.loadSessionsForClaw('bot-1'),
				store.loadDashboard('bot-1'),
			]);

			// 核心联合断言：sessions.list 总计只被 dashConn 调用一次
			const sessionsCalls = dashConn.request.mock.calls.filter(([m]) => m === 'sessions.list');
			expect(sessionsCalls).toHaveLength(1);

			// dashboard 拿到正确统计（说明 raw 真的流到了 dashboard：42 + 8 = 50）
			expect(store.byClaw['bot-1'].agents[0].totalTokens).toBe(50);
			expect(store.byClaw['bot-1'].agents[0].activeSessions).toBe(2);
			// sessions.store 也写入了对应 SessionItem（live key sessionId + max numeric updatedAt）
			const item = sessionsStore.items.find((s) => s.clawId === 'bot-1');
			expect(item).toBeDefined();
			expect(item.sessionId).toBe('sid-live');
			expect(item.updatedAt).toBe(1730_000_000_000);
		});

		test('force→force 并发：2nd force 不合流，等 1st 完成后串行启动独立重载（sessions.list 两次）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			const dashConn = mockConn({
				'status': {},
				'models.list': { models: [] },
				'usage.cost': null,
				'sessions.list': { sessions: [] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			const p1 = store.loadDashboard('bot-1', { force: true });
			const p2 = store.loadDashboard('bot-1', { force: true });

			await Promise.all([p1, p2]);

			// 2nd force 不再被合流吞掉：等 1st force 飞行结束后串行启动独立的一轮重载，
			// force 透传到 sessionsStore 绕过 raw 缓存 → sessions.list 共两次
			expect(dashConn.request.mock.calls.filter(([m]) => m === 'sessions.list')).toHaveLength(2);
			// 飞行中守卫最终清空（串行链终止）
			expect(_loadingByClaw.has('bot-1')).toBe(false);
		});

		// 陈旧快照回归 pin：add-provider → pick-primary 急促序列里，1st force 的飞行在“选主模型”
		// 写入之前已取快照（真实 status RPC ~10s manifest-cache 卡顿），2nd force 若复用该飞行就会
		// 把终态停在“无主模型”的陈旧值。修复后 2nd force 必须串一轮独立重载，落到选主后的最新数据。
		test('force→force：2nd force 不复用 1st 飞行快照，串独立重载落最新数据（防陈旧快照）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			// primary 模拟用户写入：先无主模型（add-provider 后），后选定主模型（pick-primary 后）。
			// coclaw.model.list 的返回值在每次 request() 调用时点求值 primary，从而区分两轮快照。
			let primary = null;
			// status 用 deferred：卡住第 1 个 force 的飞行，模拟真实 status RPC 的 manifest-cache 卡顿，
			// 让“选主模型”有机会发生在第 1 轮取快照之后、第 2 轮重载之前。
			let resolveStatus;
			const statusPromise = new Promise((r) => { resolveStatus = r; });
			const dashConn = {
				request: vi.fn().mockImplementation((method) => {
					if (method === 'status') return statusPromise;
					if (method === 'models.list') {
						return Promise.resolve({ models: [{ id: 'llama-3.3-70b-versatile', provider: 'groq' }] });
					}
					if (method === 'coclaw.providerAuth.list') {
						return Promise.resolve({ profiles: [{ profileId: 'groq:default', provider: 'groq', type: 'api_key' }] });
					}
					if (method === 'coclaw.model.list') {
						return Promise.resolve({ default: { primary }, agents: {} });
					}
					if (method === 'sessions.list') return Promise.resolve({ sessions: [] });
					if (method === 'tools.catalog') return Promise.resolve({ groups: [] });
					return Promise.resolve({});
				}),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			// 1st force：同步发出全部 RPC，coclaw.model.list 此刻捕获 primary=null（中间态），卡在 deferred status
			const p1 = store.loadDashboard('bot-1', { force: true });
			// 2nd force：当前飞行也是 force → 必须串一轮独立重载，不复用 1st 的 null 快照
			const p2 = store.loadDashboard('bot-1', { force: true });

			// 用户在两次 load 之间选定了主模型
			primary = 'groq/llama-3.3-70b-versatile';

			// 放行 1st 飞行；2nd 的串行重载随后在 microtask 中跑，此时 primary 已是最新值
			resolveStatus({});
			await p1;
			await p2;

			const entry = store.byClaw['bot-1'];
			// 终态必须是选主后的最新数据，而非 1st 飞行的陈旧 null 快照
			expect(entry.primaryModel).toBe('groq/llama-3.3-70b-versatile');
			expect(entry.primaryEffective).toBe(true);
			// 2nd force 确实启动了独立重载：coclaw.model.list 被调两次（不是复用一次）
			expect(dashConn.request.mock.calls.filter(([m]) => m === 'coclaw.model.list')).toHaveLength(2);
			expect(_loadingByClaw.has('bot-1')).toBe(false);
		});
	});

	// =====================================================================
	// model-config 派生字段：hasAnyProviderAuth / primaryModel / primaryEffective
	// =====================================================================
	describe('model-config 派生字段', () => {
		test('两条 RPC 都成功 + primary 在 catalog 内：三字段全 truthy', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			const dashConn = mockConn({
				'status': {},
				'models.list': { models: [
					{ id: 'llama-3.3-70b-versatile', provider: 'groq' },
					{ id: 'claude-sonnet-4-6', provider: 'anthropic' },
				] },
				'usage.cost': null,
				'sessions.list': { sessions: [] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
				'coclaw.providerAuth.list': {
					profiles: [
						{ profileId: 'groq:default', provider: 'groq', type: 'api_key', keyPreview: 'gsk_…ABCD' },
						{ profileId: 'anthropic:default', provider: 'anthropic', type: 'api_key', keyPreview: 'sk-an…XYZW' },
					],
				},
				'coclaw.model.list': { default: { primary: 'groq/llama-3.3-70b-versatile' }, agents: {} },
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			await store.loadDashboard('bot-1');

			const entry = store.byClaw['bot-1'];
			expect(entry.hasAnyProviderAuth).toBe(true);
			expect(entry.primaryModel).toBe('groq/llama-3.3-70b-versatile');
			expect(entry.primaryEffective).toBe(true);
		});

		test('凭据为空 → hasAnyProviderAuth=false / primaryEffective=false', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			const dashConn = mockConn({
				'status': {},
				'models.list': { models: [{ id: 'm1', provider: 'groq' }] },
				'usage.cost': null,
				'sessions.list': { sessions: [] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
				'coclaw.providerAuth.list': { profiles: [] },
				'coclaw.model.list': { default: { primary: null }, agents: {} },
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			await store.loadDashboard('bot-1');

			const entry = store.byClaw['bot-1'];
			expect(entry.hasAnyProviderAuth).toBe(false);
			expect(entry.primaryModel).toBeNull();
			expect(entry.primaryEffective).toBe(false);
		});

		test('primary 引用合法 provider 但 model 不在 catalog → primaryEffective=false（primaryModel 保留）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			const dashConn = mockConn({
				'status': {},
				'models.list': { models: [
					{ id: 'llama-3.1-8b-instant', provider: 'groq' },
				] },
				'usage.cost': null,
				'sessions.list': { sessions: [] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
				'coclaw.providerAuth.list': {
					profiles: [{ profileId: 'groq:default', provider: 'groq', type: 'api_key' }],
				},
				// primary 指向 groq，但 model id 在 catalog 里不存在
				'coclaw.model.list': { default: { primary: 'groq/llama-deprecated' }, agents: {} },
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			await store.loadDashboard('bot-1');

			const entry = store.byClaw['bot-1'];
			expect(entry.hasAnyProviderAuth).toBe(true);
			expect(entry.primaryModel).toBe('groq/llama-deprecated');
			expect(entry.primaryEffective).toBe(false);
		});

		test('primary 解析为 provider 不在凭据内 → primaryEffective=false（但 primaryModel 保留）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			const dashConn = mockConn({
				'status': {},
				'models.list': { models: [
					{ id: 'llama-3.3-70b-versatile', provider: 'groq' },
				] },
				'usage.cost': null,
				'sessions.list': { sessions: [] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
				'coclaw.providerAuth.list': {
					profiles: [{ profileId: 'anthropic:default', provider: 'anthropic', type: 'api_key' }],
				},
				'coclaw.model.list': { default: { primary: 'groq/llama-3.3-70b-versatile' }, agents: {} },
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			await store.loadDashboard('bot-1');

			const entry = store.byClaw['bot-1'];
			expect(entry.hasAnyProviderAuth).toBe(true);
			expect(entry.primaryModel).toBe('groq/llama-3.3-70b-versatile');
			expect(entry.primaryEffective).toBe(false);
		});

		test('providerAuth.list 失败 → 三字段整组默认 false/null/false（未知态，不让外层引导误报）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			const dashConn = mockConn({
				'status': {},
				'models.list': { models: [{ id: 'm1', provider: 'groq' }] },
				'usage.cost': null,
				'sessions.list': { sessions: [] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
				'coclaw.providerAuth.list': new Error('rpc timeout'),
				// model.list 即便成功，primaryModel 也不放进 entry（不让"凭据未知 + 已设主模型"的
				// 错觉触发 T4 橙条逻辑——参考设计 § 7.2 的"未知态"语义）
				'coclaw.model.list': { default: { primary: 'groq/m1' }, agents: {} },
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			await store.loadDashboard('bot-1');

			const entry = store.byClaw['bot-1'];
			expect(entry.hasAnyProviderAuth).toBe(false);
			expect(entry.primaryModel).toBeNull();
			expect(entry.primaryEffective).toBe(false);
			// 整体 error 不写：单条 RPC 失败不报警
			expect(entry.error).toBeNull();
		});

		test('model.list 失败 → 三字段整组默认 false/null/false', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			const dashConn = mockConn({
				'status': {},
				'models.list': { models: [{ id: 'm1', provider: 'groq' }] },
				'usage.cost': null,
				'sessions.list': { sessions: [] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
				// providerAuth 成功也不让 hasAnyProviderAuth=true：因为 primaryModel 未知，
				// 整组保持"数据未到齐"状态
				'coclaw.providerAuth.list': {
					profiles: [{ profileId: 'groq:default', provider: 'groq', type: 'api_key' }],
				},
				'coclaw.model.list': new Error('rpc timeout'),
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			await store.loadDashboard('bot-1');

			const entry = store.byClaw['bot-1'];
			expect(entry.hasAnyProviderAuth).toBe(false);
			expect(entry.primaryModel).toBeNull();
			expect(entry.primaryEffective).toBe(false);
			expect(entry.error).toBeNull();
		});

		test('两条 RPC 都失败 → 默认值 false/null/false', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			const dashConn = mockConn({
				'status': {},
				'models.list': { models: [] },
				'usage.cost': null,
				'sessions.list': { sessions: [] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
				'coclaw.providerAuth.list': new Error('boom'),
				'coclaw.model.list': new Error('boom'),
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			await store.loadDashboard('bot-1');

			const entry = store.byClaw['bot-1'];
			expect(entry.hasAnyProviderAuth).toBe(false);
			expect(entry.primaryModel).toBeNull();
			expect(entry.primaryEffective).toBe(false);
		});

		test('两条 RPC 都成功 → modelConfigFetched=true（外层据此才渲染引导态）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			const dashConn = mockConn({
				'status': {},
				'models.list': { models: [{ id: 'm1', provider: 'groq' }] },
				'usage.cost': null,
				'sessions.list': { sessions: [] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
				'coclaw.providerAuth.list': { profiles: [{ profileId: 'groq:default', provider: 'groq', type: 'api_key' }] },
				'coclaw.model.list': { default: { primary: 'groq/m1' }, agents: {} },
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			await store.loadDashboard('bot-1');

			expect(store.byClaw['bot-1'].modelConfigFetched).toBe(true);
		});

		test('providerAuth.list 失败 → modelConfigFetched=false（未知态，外层不渲染橙条）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			const dashConn = mockConn({
				'status': {},
				'models.list': { models: [{ id: 'm1', provider: 'groq' }] },
				'usage.cost': null,
				'sessions.list': { sessions: [] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
				'coclaw.providerAuth.list': new Error('rpc timeout'),
				'coclaw.model.list': { default: { primary: 'groq/m1' }, agents: {} },
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			await store.loadDashboard('bot-1');

			expect(store.byClaw['bot-1'].modelConfigFetched).toBe(false);
		});

		test('model.list 失败 → modelConfigFetched=false', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			const dashConn = mockConn({
				'status': {},
				'models.list': { models: [{ id: 'm1', provider: 'groq' }] },
				'usage.cost': null,
				'sessions.list': { sessions: [] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
				'coclaw.providerAuth.list': { profiles: [{ profileId: 'groq:default', provider: 'groq', type: 'api_key' }] },
				'coclaw.model.list': new Error('rpc timeout'),
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			await store.loadDashboard('bot-1');

			expect(store.byClaw['bot-1'].modelConfigFetched).toBe(false);
		});

		test('models.list catalog 失败（providerAuth/model.list 成功）→ modelConfigFetched=false（空 catalog 不可信）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			const dashConn = mockConn({
				'status': {},
				'models.list': new Error('catalog down'),
				'usage.cost': null,
				'sessions.list': { sessions: [] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
				'coclaw.providerAuth.list': { profiles: [{ profileId: 'groq:default', provider: 'groq', type: 'api_key' }] },
				'coclaw.model.list': { default: { primary: 'groq/m1' }, agents: {} },
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			await store.loadDashboard('bot-1');

			// catalog 拉不到 → 不能视为已成功，否则空 catalog 会让合法 primary 误判失效、外层误报橙条
			expect(store.byClaw['bot-1'].modelConfigFetched).toBe(false);
		});

		test('硬失败（loadAgents 抛错触发 catch）→ modelConfigFetched 重置为 false（不残留上次成功态）', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

			const agentConn = mockAgentConn([{ id: 'main' }]);
			setConn('bot-1', agentConn);
			const agentsStore = useAgentsStore();
			await agentsStore.loadAgents('bot-1');

			const dashConn = mockConn({
				'status': {},
				'models.list': { models: [{ id: 'm1', provider: 'groq' }] },
				'usage.cost': null,
				'sessions.list': { sessions: [] },
				'tts.status': {},
				'channels.status': {},
				'tools.catalog': { groups: [] },
				'coclaw.providerAuth.list': { profiles: [{ profileId: 'groq:default', provider: 'groq', type: 'api_key' }] },
				'coclaw.model.list': { default: { primary: 'groq/m1' }, agents: {} },
			});
			setConn('bot-1', dashConn);

			const store = useDashboardStore();
			await store.loadDashboard('bot-1');
			expect(store.byClaw['bot-1'].modelConfigFetched).toBe(true);

			// 第二次：强制 loadAgents 抛错 → 进入 catch 分支
			agentsStore.byClaw['bot-1'].fetched = false;
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			vi.spyOn(agentsStore, 'loadAgents').mockRejectedValue(new Error('boom'));
			await store.loadDashboard('bot-1');
			warnSpy.mockRestore();

			expect(store.byClaw['bot-1'].error).toBeTruthy();
			expect(store.byClaw['bot-1'].modelConfigFetched).toBe(false);
		});
	});
});

// =====================================================================
// computePrimaryEffective 纯函数
// =====================================================================
describe('computePrimaryEffective', () => {
	const catalog = [
		{ id: 'm1', provider: 'groq' },
		{ id: 'claude-sonnet-4-6', provider: 'anthropic' },
	];

	test('合法 + provider 在内 + model 在 catalog → true', () => {
		expect(computePrimaryEffective('groq/m1', ['groq'], catalog)).toBe(true);
	});

	test('provider 不在凭据列表 → false', () => {
		expect(computePrimaryEffective('groq/m1', ['anthropic'], catalog)).toBe(false);
	});

	test('model 不在 catalog 该 provider 下 → false', () => {
		expect(computePrimaryEffective('groq/unknown', ['groq'], catalog)).toBe(false);
	});

	test('catalog 里同 model id 但 provider 不同 → false', () => {
		expect(computePrimaryEffective('groq/claude-sonnet-4-6', ['groq', 'anthropic'], catalog)).toBe(false);
	});

	test('primary 为 null → false', () => {
		expect(computePrimaryEffective(null, ['groq'], catalog)).toBe(false);
	});

	test('primary 为 undefined → false', () => {
		expect(computePrimaryEffective(undefined, ['groq'], catalog)).toBe(false);
	});

	test('primary 不含 "/" → false', () => {
		expect(computePrimaryEffective('claude-sonnet-4-6', ['anthropic'], catalog)).toBe(false);
	});

	test('primary 以 "/" 开头（provider 端为空）→ false', () => {
		expect(computePrimaryEffective('/m1', ['groq'], catalog)).toBe(false);
	});

	test('primary 以 "/" 结尾（model 端为空）→ false', () => {
		expect(computePrimaryEffective('groq/', ['groq'], catalog)).toBe(false);
	});

	test('primary 含多个 "/"：按首个 / 拆，剩余作 model id', () => {
		const cat = [{ id: 'foo/bar', provider: 'groq' }];
		expect(computePrimaryEffective('groq/foo/bar', ['groq'], cat)).toBe(true);
	});

	test('providers 非数组 → false', () => {
		expect(computePrimaryEffective('groq/m1', null, catalog)).toBe(false);
	});

	test('catalog 非数组 → false', () => {
		expect(computePrimaryEffective('groq/m1', ['groq'], null)).toBe(false);
	});

	test('primary 非字符串（数字等）→ false', () => {
		expect(computePrimaryEffective(123, ['groq'], catalog)).toBe(false);
	});

	test('空字符串 primary → false', () => {
		expect(computePrimaryEffective('', ['groq'], catalog)).toBe(false);
	});
});
