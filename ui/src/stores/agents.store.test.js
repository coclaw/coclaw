import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useAgentsStore } from './agents.store.js';

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

function mockConn(agents = [], state = 'connected', identityMap = {}) {
	return {
		state,
		request: vi.fn().mockImplementation((method, params) => {
			if (method === 'agents.list') {
				return Promise.resolve({ defaultId: 'main', agents });
			}
			if (method === 'agent.identity.get') {
				const agentId = params?.agentId;
				return Promise.resolve(identityMap[agentId] ?? { agentId, name: agentId });
			}
			return Promise.resolve(null);
		}),
		on: vi.fn(),
		off: vi.fn(),
	};
}

describe('agents store', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		mockConnections.clear();
		vi.clearAllMocks();
	});

	test('loadAgents 应加载 agent 列表并用 identity.get 补充', async () => {
		const agents = [
			{ id: 'main', name: 'main' },
			{ id: 'ops', name: 'ops' },
		];
		const identityMap = {
			main: { agentId: 'main', name: '小点', emoji: '🦞' },
			ops: { agentId: 'ops', name: 'Ops Bot', emoji: '⚙️' },
		};
		const conn = mockConn(agents, 'connected', identityMap);
		mockConnections.set('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');

		expect(store.byBot['bot-1'].agents).toHaveLength(2);
		expect(store.byBot['bot-1'].agents[0].resolvedIdentity).toEqual(identityMap.main);
		expect(store.byBot['bot-1'].agents[1].resolvedIdentity).toEqual(identityMap.ops);
		expect(store.byBot['bot-1'].defaultId).toBe('main');
		expect(store.byBot['bot-1'].fetched).toBe(true);
		expect(store.byBot['bot-1'].loading).toBe(false);
		expect(conn.request).toHaveBeenCalledWith('agents.list', {});
		expect(conn.request).toHaveBeenCalledWith('agent.identity.get', { agentId: 'main' });
		expect(conn.request).toHaveBeenCalledWith('agent.identity.get', { agentId: 'ops' });
	});

	test('loadAgents 无连接时应跳过', async () => {
		const store = useAgentsStore();
		await store.loadAgents('no-conn');
		expect(store.byBot['no-conn']).toBeUndefined();
	});

	test('loadAgents 连接未就绪时应跳过', async () => {
		const conn = mockConn([], 'connecting');
		mockConnections.set('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');
		expect(store.byBot['bot-1']).toBeUndefined();
		expect(conn.request).not.toHaveBeenCalled();
	});

	test('loadAgents agents.list 失败时不抛错', async () => {
		const conn = {
			state: 'connected',
			request: vi.fn().mockRejectedValue(new Error('rpc failed')),
			on: vi.fn(),
			off: vi.fn(),
		};
		mockConnections.set('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');
		expect(store.byBot['bot-1'].agents).toEqual([]);
		expect(store.byBot['bot-1'].loading).toBe(false);
	});

	test('identity.get 失败时 resolvedIdentity 为 null', async () => {
		const agents = [{ id: 'main', name: 'main' }];
		const conn = {
			state: 'connected',
			request: vi.fn().mockImplementation((method) => {
				if (method === 'agents.list') return Promise.resolve({ defaultId: 'main', agents });
				return Promise.reject(new Error('identity failed'));
			}),
			on: vi.fn(),
			off: vi.fn(),
		};
		mockConnections.set('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');
		expect(store.byBot['bot-1'].agents[0].resolvedIdentity).toBeNull();
	});

	test('getAgentsByBot 应返回指定 bot 的 agents', async () => {
		const agents = [{ id: 'main', name: 'Main' }];
		const conn = mockConn(agents);
		mockConnections.set('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');

		const result = store.getAgentsByBot('bot-1');
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('main');
		expect(store.getAgentsByBot('unknown')).toEqual([]);
	});

	test('getAgent 应返回单个 agent', async () => {
		const agents = [
			{ id: 'main', name: 'Main' },
			{ id: 'ops', name: 'Ops' },
		];
		const conn = mockConn(agents);
		mockConnections.set('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');

		const agent = store.getAgent('bot-1', 'ops');
		expect(agent.id).toBe('ops');
		expect(agent.name).toBe('Ops');
		expect(store.getAgent('bot-1', 'none')).toBeUndefined();
	});

	test('allAgentItems 应返回附带 bot 信息的扁平列表', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([
			{ id: 'bot-1', name: 'Bot One', online: true },
		]);

		const agents = [
			{ id: 'main', name: 'Main' },
			{ id: 'ops', name: 'Ops' },
		];
		const conn = mockConn(agents);
		mockConnections.set('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');

		const items = store.allAgentItems;
		expect(items).toHaveLength(2);
		expect(items[0].botId).toBe('bot-1');
		expect(items[0].botName).toBe('Bot One');
		expect(items[0].botOnline).toBe(true);
		expect(items[0].id).toBe('main');
		expect(items[1].id).toBe('ops');
	});

	test('allAgentItems 无 agents 数据的 bot 不产出条目', () => {
		const botsStore = useBotsStore();
		botsStore.setBots([{ id: 'bot-1', name: 'Bot', online: true }]);

		const store = useAgentsStore();
		expect(store.allAgentItems).toEqual([]);
	});

	test('loadAllAgents 应为所有在线 bot 加载 agents', async () => {
		const botsStore = useBotsStore();
		botsStore.setBots([
			{ id: 'bot-1', name: 'B1', online: true },
			{ id: 'bot-2', name: 'B2', online: true },
			{ id: 'bot-3', name: 'B3', online: false },
		]);

		const conn1 = mockConn([{ id: 'main' }]);
		const conn2 = mockConn([{ id: 'main' }, { id: 'test' }]);
		mockConnections.set('bot-1', conn1);
		mockConnections.set('bot-2', conn2);

		const store = useAgentsStore();
		await store.loadAllAgents();

		expect(store.byBot['bot-1'].agents).toHaveLength(1);
		expect(store.byBot['bot-2'].agents).toHaveLength(2);
		expect(store.byBot['bot-3']).toBeUndefined();
	});

	test('removeByBot 应移除指定 bot 的数据', async () => {
		const conn = mockConn([{ id: 'main' }]);
		mockConnections.set('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');
		expect(store.byBot['bot-1']).toBeDefined();

		store.removeByBot('bot-1');
		expect(store.byBot['bot-1']).toBeUndefined();
	});

	// =====================================================================
	// getAgentDisplay
	// =====================================================================

	describe('getAgentDisplay', () => {
		test('返回 resolvedIdentity 优先的 name/emoji', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: 'bot-1', name: 'BotName', online: true }]);

			const agents = [{ id: 'main', name: 'main' }];
			const identityMap = {
				main: { agentId: 'main', name: '小点', emoji: '🦞' },
			};
			const conn = mockConn(agents, 'connected', identityMap);
			mockConnections.set('bot-1', conn);

			const store = useAgentsStore();
			await store.loadAgents('bot-1');

			const d = store.getAgentDisplay('bot-1', 'main');
			expect(d.name).toBe('小点');
			expect(d.emoji).toBe('🦞');
			expect(d.avatarUrl).toBeNull();
		});

		test('无 resolvedIdentity 时默认 agent fallback 到 botName', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: 'bot-1', name: '我的Bot', online: true }]);

			const agents = [{ id: 'main', name: 'main' }];
			// identity.get 失败 → resolvedIdentity 为 null
			const conn = {
				state: 'connected',
				request: vi.fn().mockImplementation((method) => {
					if (method === 'agents.list') return Promise.resolve({ defaultId: 'main', agents });
					return Promise.reject(new Error('no identity'));
				}),
				on: vi.fn(),
				off: vi.fn(),
			};
			mockConnections.set('bot-1', conn);

			const store = useAgentsStore();
			await store.loadAgents('bot-1');

			const d = store.getAgentDisplay('bot-1', 'main');
			expect(d.name).toBe('我的Bot');
		});

		test('非默认 agent 不 fallback 到 botName', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: 'bot-1', name: '我的Bot', online: true }]);

			const agents = [{ id: 'main', name: 'main' }, { id: 'tester', name: 'tester' }];
			const conn = {
				state: 'connected',
				request: vi.fn().mockImplementation((method) => {
					if (method === 'agents.list') return Promise.resolve({ defaultId: 'main', agents });
					return Promise.reject(new Error('no identity'));
				}),
				on: vi.fn(),
				off: vi.fn(),
			};
			mockConnections.set('bot-1', conn);

			const store = useAgentsStore();
			await store.loadAgents('bot-1');

			const d = store.getAgentDisplay('bot-1', 'tester');
			expect(d.name).toBe('tester');
		});

		test('agent 不存在时 fallback 到 agentId', () => {
			const store = useAgentsStore();
			const d = store.getAgentDisplay('no-bot', 'unknown');
			expect(d.name).toBe('unknown');
			expect(d.avatarUrl).toBeNull();
			expect(d.emoji).toBeNull();
		});

		test('avatarUrl 仅接受 data: 和 http(s): URL', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: 'bot-1', name: 'B', online: true }]);

			const agents = [{
				id: 'main',
				name: 'main',
				identity: { avatarUrl: 'avatars/bot.png' },
			}];
			const conn = mockConn(agents, 'connected', {});
			mockConnections.set('bot-1', conn);

			const store = useAgentsStore();
			await store.loadAgents('bot-1');

			const d = store.getAgentDisplay('bot-1', 'main');
			expect(d.avatarUrl).toBeNull(); // 相对路径不通过校验
		});

		test('avatarUrl 为 data URI 时可用', async () => {
			const botsStore = useBotsStore();
			botsStore.setBots([{ id: 'bot-1', name: 'B', online: true }]);

			const agents = [{
				id: 'main',
				name: 'main',
				identity: { avatarUrl: 'data:image/png;base64,abc' },
			}];
			const conn = mockConn(agents, 'connected', {});
			mockConnections.set('bot-1', conn);

			const store = useAgentsStore();
			await store.loadAgents('bot-1');

			const d = store.getAgentDisplay('bot-1', 'main');
			expect(d.avatarUrl).toBe('data:image/png;base64,abc');
		});
	});

	// =====================================================================
	// parseAgentId
	// =====================================================================

	describe('parseAgentId', () => {
		test('从标准 sessionKey 解析 agentId', () => {
			const store = useAgentsStore();
			expect(store.parseAgentId('agent:main:main')).toBe('main');
			expect(store.parseAgentId('agent:tester:main')).toBe('tester');
			expect(store.parseAgentId('agent:ops:cron:daily')).toBe('ops');
		});

		test('无效 sessionKey 返回 null', () => {
			const store = useAgentsStore();
			expect(store.parseAgentId(null)).toBeNull();
			expect(store.parseAgentId('')).toBeNull();
			expect(store.parseAgentId('invalid')).toBeNull();
		});
	});

	test('loadAgents 应将 botId 归一化为 string 作为 byBot key', async () => {
		const conn = mockConn([{ id: 'main' }]);
		mockConnections.set('42', conn);

		const store = useAgentsStore();
		// 传入 numeric botId
		await store.loadAgents(42);
		expect(store.byBot['42']).toBeDefined();
		expect(store.byBot['42'].agents).toHaveLength(1);
	});

	test('identity.get 失败时应输出 debug 日志', async () => {
		const agents = [{ id: 'fail-agent', name: 'fail' }];
		const conn = {
			state: 'connected',
			request: vi.fn().mockImplementation((method) => {
				if (method === 'agents.list') return Promise.resolve({ defaultId: 'main', agents });
				return Promise.reject(new Error('identity rpc error'));
			}),
			on: vi.fn(),
			off: vi.fn(),
		};
		mockConnections.set('bot-1', conn);

		const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
		const store = useAgentsStore();
		await store.loadAgents('bot-1');

		expect(debugSpy).toHaveBeenCalledWith(
			expect.stringContaining('agent.identity.get failed'),
			'fail-agent',
			'identity rpc error',
		);
		debugSpy.mockRestore();
	});

	test('loadAgents 应处理 defaultId 非 main 的情况', async () => {
		const conn = {
			state: 'connected',
			request: vi.fn().mockResolvedValue({
				defaultId: 'custom',
				agents: [{ id: 'custom' }],
			}),
			on: vi.fn(),
			off: vi.fn(),
		};
		mockConnections.set('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');
		expect(store.byBot['bot-1'].defaultId).toBe('custom');
	});
});
