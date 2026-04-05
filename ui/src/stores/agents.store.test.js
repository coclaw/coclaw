import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useAgentsStore } from './agents.store.js';

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

function mockConn(agents = [], _state = 'connected', identityMap = {}) {
	return {
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
		setConn('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');

		expect(store.byClaw['bot-1'].agents).toHaveLength(2);
		expect(store.byClaw['bot-1'].agents[0].resolvedIdentity).toEqual(identityMap.main);
		expect(store.byClaw['bot-1'].agents[1].resolvedIdentity).toEqual(identityMap.ops);
		expect(store.byClaw['bot-1'].defaultId).toBe('main');
		expect(store.byClaw['bot-1'].fetched).toBe(true);
		expect(store.byClaw['bot-1'].loading).toBe(false);
		expect(conn.request).toHaveBeenCalledWith('agents.list', {});
		expect(conn.request).toHaveBeenCalledWith('agent.identity.get', { agentId: 'main' });
		expect(conn.request).toHaveBeenCalledWith('agent.identity.get', { agentId: 'ops' });
	});

	test('loadAgents 无连接时应跳过', async () => {
		const store = useAgentsStore();
		await store.loadAgents('no-conn');
		expect(store.byClaw['no-conn']).toBeUndefined();
	});

	test('loadAgents 连接未就绪时应跳过', async () => {
		const conn = mockConn([]);
		setConn('bot-1', conn, { dcReady: false });

		const store = useAgentsStore();
		await store.loadAgents('bot-1');
		expect(store.byClaw['bot-1']).toBeUndefined();
		expect(conn.request).not.toHaveBeenCalled();
	});

	test('loadAgents agents.list 失败时不抛错', async () => {
		const conn = {
			request: vi.fn().mockRejectedValue(new Error('rpc failed')),
			on: vi.fn(),
			off: vi.fn(),
		};
		setConn('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');
		expect(store.byClaw['bot-1'].agents).toEqual([]);
		expect(store.byClaw['bot-1'].loading).toBe(false);
	});

	test('identity.get 失败时 resolvedIdentity 为 null', async () => {
		const agents = [{ id: 'main', name: 'main' }];
		const conn = {
			request: vi.fn().mockImplementation((method) => {
				if (method === 'agents.list') return Promise.resolve({ defaultId: 'main', agents });
				return Promise.reject(new Error('identity failed'));
			}),
			on: vi.fn(),
			off: vi.fn(),
		};
		setConn('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');
		expect(store.byClaw['bot-1'].agents[0].resolvedIdentity).toBeNull();
	});

	test('并发 loadAgents 应复用飞行中请求（in-flight dedup）', async () => {
		let reqCount = 0;
		let resolveReq;
		const conn = {
			request: vi.fn().mockImplementation((method) => {
				if (method === 'agents.list') {
					reqCount++;
					return new Promise((r) => { resolveReq = r; });
				}
				if (method === 'agent.identity.get') return Promise.resolve({ name: 'Agent' });
				return Promise.resolve(null);
			}),
			on: vi.fn(),
			off: vi.fn(),
		};
		setConn('bot-1', conn);

		const store = useAgentsStore();
		const p1 = store.loadAgents('bot-1');
		const p2 = store.loadAgents('bot-1');
		const p3 = store.loadAgents('bot-1');

		// agents.list 仅被调用 1 次
		expect(reqCount).toBe(1);

		resolveReq({ defaultId: 'main', agents: [{ id: 'main', name: 'main' }] });
		await Promise.all([p1, p2, p3]);

		expect(store.byClaw['bot-1'].agents).toHaveLength(1);
		expect(store.byClaw['bot-1'].loading).toBe(false);

		// dedup 清理后，新调用应发起新请求
		reqCount = 0;
		resolveReq = null;
		const p4 = store.loadAgents('bot-1');
		expect(reqCount).toBe(1);
		resolveReq({ defaultId: 'main', agents: [] });
		await p4;
	});

	test('getAgentsByClaw 应返回指定 claw 的 agents', async () => {
		const agents = [{ id: 'main', name: 'Main' }];
		const conn = mockConn(agents);
		setConn('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');

		const result = store.getAgentsByClaw('bot-1');
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('main');
		expect(store.getAgentsByClaw('unknown')).toEqual([]);
	});

	test('getAgent 应返回单个 agent', async () => {
		const agents = [
			{ id: 'main', name: 'Main' },
			{ id: 'ops', name: 'Ops' },
		];
		const conn = mockConn(agents);
		setConn('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');

		const agent = store.getAgent('bot-1', 'ops');
		expect(agent.id).toBe('ops');
		expect(agent.name).toBe('Ops');
		expect(store.getAgent('bot-1', 'none')).toBeUndefined();
	});

	test('allAgentItems 应返回附带 claw 信息的扁平列表', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-1', name: 'Bot One', online: true },
		]);

		const agents = [
			{ id: 'main', name: 'Main' },
			{ id: 'ops', name: 'Ops' },
		];
		const conn = mockConn(agents);
		setConn('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');

		const items = store.allAgentItems;
		expect(items).toHaveLength(2);
		expect(items[0].clawId).toBe('bot-1');
		expect(items[0].clawName).toBe('Bot One');
		expect(items[0].clawOnline).toBe(true);
		expect(items[0].id).toBe('main');
		expect(items[1].id).toBe('ops');
	});

	test('allAgentItems 无 agents 数据的 claw 不产出条目', () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([{ id: 'bot-1', name: 'Bot', online: true }]);

		const store = useAgentsStore();
		expect(store.allAgentItems).toEqual([]);
	});

	test('loadAllAgents 应为所有在线 claw 加载 agents', async () => {
		const clawsStore = useClawsStore();
		clawsStore.setClaws([
			{ id: 'bot-1', name: 'B1', online: true },
			{ id: 'bot-2', name: 'B2', online: true },
			{ id: 'bot-3', name: 'B3', online: false },
		]);

		const conn1 = mockConn([{ id: 'main' }]);
		const conn2 = mockConn([{ id: 'main' }, { id: 'test' }]);
		setConn('bot-1', conn1);
		setConn('bot-2', conn2);

		const store = useAgentsStore();
		await store.loadAllAgents();

		expect(store.byClaw['bot-1'].agents).toHaveLength(1);
		expect(store.byClaw['bot-2'].agents).toHaveLength(2);
		expect(store.byClaw['bot-3']).toBeUndefined();
	});

	test('removeByClaw 应移除指定 claw 的数据', async () => {
		const conn = mockConn([{ id: 'main' }]);
		setConn('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');
		expect(store.byClaw['bot-1']).toBeDefined();

		store.removeByClaw('bot-1');
		expect(store.byClaw['bot-1']).toBeUndefined();
	});

	// =====================================================================
	// getAgentDisplay
	// =====================================================================

	describe('getAgentDisplay', () => {
		test('返回 resolvedIdentity 优先的 name/emoji', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'BotName', online: true }]);

			const agents = [{ id: 'main', name: 'main' }];
			const identityMap = {
				main: { agentId: 'main', name: '小点', emoji: '🦞' },
			};
			const conn = mockConn(agents, 'connected', identityMap);
			setConn('bot-1', conn);

			const store = useAgentsStore();
			await store.loadAgents('bot-1');

			const d = store.getAgentDisplay('bot-1', 'main');
			expect(d.name).toBe('小点');
			expect(d.emoji).toBe('🦞');
			expect(d.avatarUrl).toBeNull();
		});

		test('无 resolvedIdentity 时默认 agent fallback 到 clawName', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: '我的Bot', online: true }]);

			const agents = [{ id: 'main', name: 'main' }];
			// identity.get 失败 → resolvedIdentity 为 null
			const conn = {
				request: vi.fn().mockImplementation((method) => {
					if (method === 'agents.list') return Promise.resolve({ defaultId: 'main', agents });
					return Promise.reject(new Error('no identity'));
				}),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', conn);

			const store = useAgentsStore();
			await store.loadAgents('bot-1');

			const d = store.getAgentDisplay('bot-1', 'main');
			expect(d.name).toBe('我的Bot');
		});

		test('非默认 agent 不 fallback 到 clawName', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: '我的Bot', online: true }]);

			const agents = [{ id: 'main', name: 'main' }, { id: 'tester', name: 'tester' }];
			const conn = {
				request: vi.fn().mockImplementation((method) => {
					if (method === 'agents.list') return Promise.resolve({ defaultId: 'main', agents });
					return Promise.reject(new Error('no identity'));
				}),
				on: vi.fn(),
				off: vi.fn(),
			};
			setConn('bot-1', conn);

			const store = useAgentsStore();
			await store.loadAgents('bot-1');

			const d = store.getAgentDisplay('bot-1', 'tester');
			expect(d.name).toBe('tester');
		});

		test('resolvedIdentity.name 为 Assistant 时应 fallback 到 agent.name', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Assistant', online: true }]);

			const agents = [{ id: 'main', name: '小易' }];
			const identityMap = {
				main: { agentId: 'main', name: 'Assistant' },
			};
			const conn = mockConn(agents, 'connected', identityMap);
			setConn('bot-1', conn);

			const store = useAgentsStore();
			await store.loadAgents('bot-1');

			const d = store.getAgentDisplay('bot-1', 'main');
			expect(d.name).toBe('小易');
		});

		test('多个 agent 无 IDENTITY.md 时应各自显示 agents.list 中的顶层 name', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'Assistant', online: true }]);

			const agents = [
				{ id: 'main', name: '小易' },
				{ id: 'stock-assistant', name: '股小龙' },
				{ id: 'writing-assistant', name: '文笔仙' },
			];
			// identity.get 对所有 agent 均返回 gateway 默认值
			const identityMap = {
				main: { agentId: 'main', name: 'Assistant' },
				'stock-assistant': { agentId: 'stock-assistant', name: 'Assistant' },
				'writing-assistant': { agentId: 'writing-assistant', name: 'Assistant' },
			};
			const conn = mockConn(agents, 'connected', identityMap);
			setConn('bot-1', conn);

			const store = useAgentsStore();
			await store.loadAgents('bot-1');

			expect(store.getAgentDisplay('bot-1', 'main').name).toBe('小易');
			expect(store.getAgentDisplay('bot-1', 'stock-assistant').name).toBe('股小龙');
			expect(store.getAgentDisplay('bot-1', 'writing-assistant').name).toBe('文笔仙');
		});

		test('agent.name 等于 agentId 时视为占位名跳过', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: '我的Bot', online: true }]);

			const agents = [{ id: 'main', name: 'main' }];
			const identityMap = {
				main: { agentId: 'main', name: 'Assistant' },
			};
			const conn = mockConn(agents, 'connected', identityMap);
			setConn('bot-1', conn);

			const store = useAgentsStore();
			await store.loadAgents('bot-1');

			// agent.name = 'main' = agentId → 被 pick 过滤 → fallback 到 clawName
			// clawName = '我的Bot'（非 Assistant 且非 agentId）→ 使用
			const d = store.getAgentDisplay('bot-1', 'main');
			expect(d.name).toBe('我的Bot');
		});

		test('所有 name 均为默认值时兜底到 agentId（含 clawName 过滤）', async () => {
			const clawsStore = useClawsStore();
			// clawName 也是 'Assistant'（server 侧 refreshBotName 同源问题）
			clawsStore.setClaws([{ id: 'bot-1', name: 'Assistant', online: true }]);

			const agents = [{ id: 'main', name: 'main' }];
			const identityMap = {
				main: { agentId: 'main', name: 'Assistant' },
			};
			const conn = mockConn(agents, 'connected', identityMap);
			setConn('bot-1', conn);

			const store = useAgentsStore();
			await store.loadAgents('bot-1');

			// ri.name = 'Assistant' → 过滤; agent.name = 'main' = agentId → 过滤;
			// 默认 agent → clawName = 'Assistant' → 过滤; 最终兜底到 agentId
			const d = store.getAgentDisplay('bot-1', 'main');
			expect(d.name).toBe('main');
		});

		test('agent 不存在时 fallback 到 agentId', () => {
			const store = useAgentsStore();
			const d = store.getAgentDisplay('no-bot', 'unknown');
			expect(d.name).toBe('unknown');
			expect(d.avatarUrl).toBeNull();
			expect(d.emoji).toBeNull();
		});

		test('avatarUrl 仅接受 data: 和 http(s): URL', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B', online: true }]);

			const agents = [{
				id: 'main',
				name: 'main',
				identity: { avatarUrl: 'avatars/bot.png' },
			}];
			const conn = mockConn(agents, 'connected', {});
			setConn('bot-1', conn);

			const store = useAgentsStore();
			await store.loadAgents('bot-1');

			const d = store.getAgentDisplay('bot-1', 'main');
			expect(d.avatarUrl).toBeNull(); // 相对路径不通过校验
		});

		test('avatarUrl 为 data URI 时可用', async () => {
			const clawsStore = useClawsStore();
			clawsStore.setClaws([{ id: 'bot-1', name: 'B', online: true }]);

			const agents = [{
				id: 'main',
				name: 'main',
				identity: { avatarUrl: 'data:image/png;base64,abc' },
			}];
			const conn = mockConn(agents, 'connected', {});
			setConn('bot-1', conn);

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

	test('loadAgents 应将 clawId 归一化为 string 作为 byClaw key', async () => {
		const conn = mockConn([{ id: 'main' }]);
		setConn('42', conn);

		const store = useAgentsStore();
		// 传入 numeric clawId
		await store.loadAgents(42);
		expect(store.byClaw['42']).toBeDefined();
		expect(store.byClaw['42'].agents).toHaveLength(1);
	});

	test('identity.get 失败时应输出 debug 日志', async () => {
		const agents = [{ id: 'fail-agent', name: 'fail' }];
		const conn = {
			request: vi.fn().mockImplementation((method) => {
				if (method === 'agents.list') return Promise.resolve({ defaultId: 'main', agents });
				return Promise.reject(new Error('identity rpc error'));
			}),
			on: vi.fn(),
			off: vi.fn(),
		};
		setConn('bot-1', conn);

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
			request: vi.fn().mockResolvedValue({
				defaultId: 'custom',
				agents: [{ id: 'custom' }],
			}),
			on: vi.fn(),
			off: vi.fn(),
		};
		setConn('bot-1', conn);

		const store = useAgentsStore();
		await store.loadAgents('bot-1');
		expect(store.byClaw['bot-1'].defaultId).toBe('custom');
	});
});
