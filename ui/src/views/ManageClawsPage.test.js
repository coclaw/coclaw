import { createPinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import ManageClawsPage from './ManageClawsPage.vue';

// ---- mocks ----

vi.mock('../services/claws.api.js', () => ({
	listClaws: vi.fn().mockResolvedValue([]),
	unbindClawByUser: vi.fn().mockResolvedValue({}),
}));

import { unbindClawByUser } from '../services/claws.api.js';

const mockNotify = {
	success: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
};
vi.mock('../composables/use-notify.js', () => ({
	useNotify: () => mockNotify,
}));

const mockLoadDashboard = vi.fn().mockResolvedValue(undefined);
const mockGetDashboard = vi.fn().mockReturnValue(null);
const mockClearDashboard = vi.fn();

let mockGetReadyConn = vi.fn().mockReturnValue(null);

vi.mock('../stores/get-ready-conn.js', () => ({
	getReadyConn: (...args) => mockGetReadyConn(...args),
}));

vi.mock('../stores/claws.store.js', () => ({
	MAX_BACKOFF_RETRIES: 8,
	useClawsStore: () => ({
		get items() { return mockBots; },
		get byId() {
			const map = {};
			for (const b of mockBots) map[String(b.id)] = { ...b, pluginVersionOk: null, rtcPhase: b.rtcPhase ?? 'idle', rtcTransportInfo: b.rtcTransportInfo ?? null, retryCount: b.retryCount ?? 0, retryNextAt: b.retryNextAt ?? 0 };
			return map;
		},
		fetched: true, // SSE 快照已到达
	}),
}));

vi.mock('../stores/dashboard.store.js', () => ({
	useDashboardStore: () => ({
		loadDashboard: mockLoadDashboard,
		getDashboard: mockGetDashboard,
		clearDashboard: mockClearDashboard,
	}),
}));

// agentRunsStore mock：isRunning / getActiveRun 可由测试控制
let mockIsRunning = vi.fn().mockReturnValue(false);
let mockGetActiveRun = vi.fn().mockReturnValue(null);
vi.mock('../stores/agent-runs.store.js', () => ({
	useAgentRunsStore: () => ({
		isRunning: (runKey) => mockIsRunning(runKey),
		getActiveRun: (runKey) => mockGetActiveRun(runKey),
	}),
}));

// ---- stubs ----

const UButtonStub = {
	props: ['icon', 'loading', 'disabled', 'color', 'variant', 'size'],
	emits: ['click'],
	template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
};

const UBadgeStub = {
	props: ['color', 'variant', 'size'],
	template: '<span><slot /></span>',
};

const AgentCardStub = {
	name: 'AgentCard',
	props: ['agent', 'claw'],
	emits: ['chat', 'files'],
	template: '<div data-testid="agent-card">{{ agent.name }}</div>',
};

let mockBots = [];

function createWrapper() {
	return mount(ManageClawsPage, {
		global: {
			plugins: [createPinia()],
			stubs: {
				UButton: UButtonStub,
				UBadge: UBadgeStub,
				UIcon: { props: ['name'], template: '<i />' },
				AgentCard: AgentCardStub,
			},
			mocks: {
				$t: (key, params) => {
					const map = {
						'claws.pageTitle': 'My Claws',
						'claws.addClaw': 'Add Bot',
						'claws.noClaw': 'No Claw bound.',
						'claws.remove': 'Remove',
						'claws.preparing': 'Preparing...',
						'dashboard.offline': 'Offline',
						'claws.conn.rtcIdle': 'WebRTC: idle',
						'claws.conn.rtcBuilding': 'WebRTC: connecting…',
						'claws.conn.rtcRecovering': 'WebRTC: recovering…',
						'claws.conn.rtcRestarting': 'WebRTC: ICE restarting…',
						'claws.conn.rtcRetrying': `WebRTC: connection failed, retry ${params?.n}/${params?.max}…`,
						'claws.conn.rtcRetryExhausted': 'WebRTC: connection failed (retries exhausted)',
						'claws.conn.rtcLan': 'WebRTC: LAN',
						'claws.conn.rtcLanProto': `WebRTC: LAN · ${params?.protocol}`,
						'claws.conn.rtcP2P': 'WebRTC: P2P',
						'claws.conn.rtcP2PProto': `WebRTC: P2P · ${params?.protocol}`,
						'claws.conn.rtcRelay': 'WebRTC: Relay',
						'claws.conn.rtcRelayProto': `WebRTC: Relay · ${params?.protocol}`,
						'claws.renameFailed': 'Rename failed',
						'claws.summary.claws': `${params?.n} Claws`,
						'claws.summary.running': `${params?.n} 工作中`,
						'claws.summary.failed': `${params?.n} 异常`,
					};
					return map[key] ?? key;
				},
				$router: { push: vi.fn() },
			},
		},
	});
}

describe('ManageClawsPage', () => {
	beforeEach(() => {
		mockBots = [];
		mockGetDashboard.mockReturnValue(null);
		mockLoadDashboard.mockResolvedValue(undefined);
		mockIsRunning = vi.fn().mockReturnValue(false);
		mockGetActiveRun = vi.fn().mockReturnValue(null);
		mockGetReadyConn = vi.fn().mockReturnValue(null);
		vi.clearAllMocks();
	});

	test('无 claw 时显示空态提示', async () => {
		mockBots = [];
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.text()).toContain('No Claw bound.');
	});

	test('在线 claw → 渲染 Claw card（含名称）+ AgentCard', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue({
			instance: { name: 'Bot1', online: true, channels: [] },
			agents: [{ id: 'a1', name: 'Agent1', modelTags: [], capabilities: [], totalTokens: 0, activeSessions: 0, lastActivity: null }],
			loading: false,
		});
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.text()).toContain('Bot1');
		expect(wrapper.find('[data-testid="agent-card"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="agent-card"]').text()).toContain('Agent1');
	});

	test('离线 claw → 渲染 fallback header + Offline badge + 解绑按钮', async () => {
		mockBots = [{ id: '2', name: 'OfflineBot', online: false }];
		mockGetDashboard.mockReturnValue(null);
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.text()).toContain('OfflineBot');
		expect(wrapper.text()).toContain('Offline');
		expect(wrapper.text()).toContain('Remove');
	});

	test('离线 claw + 缓存 rtcTransportInfo → 连接行显示 idle 文案（与 online 解耦，detail 按钮仍可展开）', async () => {
		mockBots = [{ id: '1', name: 'A', online: false, rtcTransportInfo: { localType: 'srflx', localProtocol: 'udp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		// rtcPhase 默认 idle；connDetail 非空 → 外层 v-if 成立
		expect(wrapper.text()).toContain('WebRTC: idle');
	});

	test('离线 claw 无缓存 rtcTransportInfo → 连接信息行不显示', async () => {
		mockBots = [{ id: '1', name: 'A', online: false }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		// connDetail=null + rtcPhase=idle → 外层 v-if 假，整行隐藏
		expect(wrapper.text()).not.toContain('WebRTC');
	});

	test('claw 容器包含 data-testid', async () => {
		mockBots = [{ id: '99', name: 'TestBot', online: true }];
		mockGetDashboard.mockReturnValue(null);
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.find('[data-testid="claw-99"]').exists()).toBe(true);
	});

	test('mounted 时加载 dashboard', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		createWrapper();
		await flushPromises();

		expect(mockLoadDashboard).toHaveBeenCalledWith('1');
	});

	test('app:foreground 时重新加载 dashboard', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		const wrapper = createWrapper();
		await flushPromises();

		mockLoadDashboard.mockClear();
		window.dispatchEvent(new CustomEvent('app:foreground'));
		await flushPromises();

		expect(mockLoadDashboard).toHaveBeenCalled();
		wrapper.unmount();
	});

	test('visibilitychange → visible 时重新加载 dashboard', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		const wrapper = createWrapper();
		await flushPromises();

		mockLoadDashboard.mockClear();
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
		await flushPromises();

		expect(mockLoadDashboard).toHaveBeenCalled();
		wrapper.unmount();
	});

	test('2s 内重复前台恢复应节流', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		const wrapper = createWrapper();
		await flushPromises();

		mockLoadDashboard.mockClear();
		window.dispatchEvent(new CustomEvent('app:foreground'));
		window.dispatchEvent(new CustomEvent('app:foreground'));
		await flushPromises();

		expect(mockLoadDashboard).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	test('unmount 后前台恢复不再触发加载', async () => {
		mockBots = [];
		const wrapper = createWrapper();
		await flushPromises();

		wrapper.unmount();
		mockLoadDashboard.mockClear();

		window.dispatchEvent(new CustomEvent('app:foreground'));
		await flushPromises();

		expect(mockLoadDashboard).not.toHaveBeenCalled();
	});

	test('loadData 异常时 log warning 并 notify error', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		const err = new Error('dashboard boom');
		mockLoadDashboard.mockImplementation(() => { throw err; });
		createWrapper();
		await flushPromises();

		expect(warnSpy).toHaveBeenCalledWith('[ManageClawsPage] loadData failed:', err);
		expect(mockNotify.error).toHaveBeenCalledWith('dashboard boom');
		warnSpy.mockRestore();
	});

	test('onConfirmRemove 异常时 log warning 并 notify error', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue(null);
		const err = new Error('remove boom');
		unbindClawByUser.mockRejectedValueOnce(err);
		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.removeTargetId = '1';
		await wrapper.vm.onConfirmRemove();

		expect(warnSpy).toHaveBeenCalledWith('[ManageClawsPage] onConfirmRemove failed:', err);
		expect(mockNotify.error).toHaveBeenCalled();
		expect(wrapper.vm.unbindingId).toBe('');
		warnSpy.mockRestore();
	});

	// ---- 状态摘要栏 ----

	test('全部正常（无 running / failed）→ 摘要栏仅显示 N Claws', async () => {
		mockBots = [
			{ id: '1', name: 'Bot1', online: true, rtcPhase: 'ready' },
			{ id: '2', name: 'Bot2', online: true, rtcPhase: 'ready' },
		];
		const wrapper = createWrapper();
		await flushPromises();

		const bar = wrapper.find('[data-testid="status-summary"]');
		expect(bar.exists()).toBe(true);
		expect(bar.text()).toContain('2 Claws');
		expect(bar.text()).not.toContain('工作中');
		expect(bar.text()).not.toContain('异常');
	});

	test('有 running agent → 摘要栏包含工作中文字', async () => {
		mockBots = [
			{ id: '1', name: 'Bot1', online: true, rtcPhase: 'ready' },
		];
		// __hasRunningAgent 通过 dashboardStore 获取 agents
		mockGetDashboard.mockImplementation((clawId) => {
			if (clawId === '1') return { agents: [{ id: 'main' }], instance: null, loading: false };
			return null;
		});
		mockIsRunning = vi.fn().mockImplementation((k) => k.endsWith('::agent:main:main'));
		const wrapper = createWrapper();
		await flushPromises();

		const bar = wrapper.find('[data-testid="status-summary"]');
		expect(bar.text()).toContain('工作中');
	});

	test('有 failed claw → 摘要栏包含异常文字', async () => {
		mockBots = [
			{ id: '1', name: 'Bot1', online: true, rtcPhase: 'failed' },
		];
		const wrapper = createWrapper();
		await flushPromises();

		const bar = wrapper.find('[data-testid="status-summary"]');
		expect(bar.text()).toContain('异常');
	});

	test('无 claw 时不显示摘要栏', async () => {
		mockBots = [];
		const wrapper = createWrapper();
		await flushPromises();

		expect(wrapper.find('[data-testid="status-summary"]').exists()).toBe(false);
	});

	// ---- sortedClaws 排序 ----

	test('sortedClaws：failed claw 排在最前', async () => {
		mockBots = [
			{ id: '1', name: 'IdleBot', online: true, rtcPhase: 'ready', lastAliveAt: 1000 },
			{ id: '2', name: 'FailedBot', online: true, rtcPhase: 'failed', lastAliveAt: 500 },
			{ id: '3', name: 'OfflineBot', online: false, lastAliveAt: 800 },
		];
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.sortedClaws[0].name).toBe('FailedBot');
	});

	test('sortedClaws：offline claw 排在最后', async () => {
		mockBots = [
			{ id: '1', name: 'OfflineBot', online: false, lastAliveAt: 9999 },
			{ id: '2', name: 'IdleBot', online: true, rtcPhase: 'ready', lastAliveAt: 100 },
		];
		const wrapper = createWrapper();
		await flushPromises();
		const sorted = wrapper.vm.sortedClaws;
		expect(sorted[sorted.length - 1].name).toBe('OfflineBot');
	});

	test('sortedClaws：running bot（有 agent 在工作）排在 connecting 前', async () => {
		mockBots = [
			{ id: '1', name: 'ConnBot', online: true, rtcPhase: 'building', lastAliveAt: 300 },
			{ id: '2', name: 'RunBot', online: true, rtcPhase: 'ready', lastAliveAt: 200 },
		];
		mockGetDashboard.mockImplementation((clawId) => {
			if (clawId === '2') return { agents: [{ id: 'main' }], instance: null, loading: false };
			return null;
		});
		mockIsRunning = vi.fn().mockImplementation((k) => k.endsWith('::agent:main:main'));
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.sortedClaws[0].name).toBe('RunBot');
	});

	test('sortedClaws：restarting claw 归入 connecting 组', async () => {
		mockBots = [
			{ id: '1', name: 'IdleBot', online: true, rtcPhase: 'ready', lastAliveAt: 1000 },
			{ id: '2', name: 'RestartBot', online: true, rtcPhase: 'restarting', lastAliveAt: 500 },
		];
		const wrapper = createWrapper();
		await flushPromises();
		// restarting (connecting=2) 排在 idle (3) 前
		expect(wrapper.vm.sortedClaws[0].name).toBe('RestartBot');
	});

	test('sortedClaws：idle 同级按 lastAliveAt 降序', async () => {
		mockBots = [
			{ id: '1', name: 'OldIdle', online: true, rtcPhase: 'ready', lastAliveAt: 1000 },
			{ id: '2', name: 'NewIdle', online: true, rtcPhase: 'ready', lastAliveAt: 5000 },
		];
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.sortedClaws[0].name).toBe('NewIdle');
	});

	test('sortedClaws：空列表 → 空数组', async () => {
		mockBots = [];
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.sortedClaws).toEqual([]);
	});

	// ---- statusSummary 边界 ----

	test('statusSummary：全部 offline → running=0 failed=0', async () => {
		mockBots = [
			{ id: '1', name: 'Off1', online: false },
			{ id: '2', name: 'Off2', online: false },
		];
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.statusSummary).toEqual({ running: 0, failed: 0 });
	});

	test('statusSummary：mixed 状态统计正确', async () => {
		mockBots = [
			{ id: '1', name: 'Running1', online: true, rtcPhase: 'ready' },
			{ id: '2', name: 'Failed1', online: true, rtcPhase: 'failed' },
			{ id: '3', name: 'Idle1', online: true, rtcPhase: 'ready' },
			{ id: '4', name: 'Offline1', online: false },
		];
		mockGetDashboard.mockImplementation((clawId) => {
			if (clawId === '1') return { agents: [{ id: 'main' }, { id: 'ops' }], instance: null, loading: false };
			if (clawId === '3') return { agents: [{ id: 'main' }], instance: null, loading: false };
			return null;
		});
		mockIsRunning = vi.fn().mockImplementation((k) => k.endsWith('::agent:main:main'));
		const wrapper = createWrapper();
		await flushPromises();
		// bot1 has running agent, bot2 failed, bot3 main is running too
		expect(wrapper.vm.statusSummary).toEqual({ running: 2, failed: 1 });
	});
});

describe('connLabel', () => {
	test('bot 不存在时返回空字符串', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('999')).toBe('');
	});

	test('bot 离线（rtcPhase=idle）→ 按 rtcPhase 反映 idle（与 online 解耦）', async () => {
		mockBots = [{ id: '1', name: 'A', online: false, rtcPhase: 'idle' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: idle');
	});

	test('bot 离线但 rtcPhase=ready（解耦后可能出现）→ 仍显示 ready 文案', async () => {
		mockBots = [{ id: '1', name: 'A', online: false, rtcPhase: 'ready', rtcTransportInfo: { localType: 'srflx', localProtocol: 'udp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: P2P');
	});

	test('rtcPhase=failed + retryCount>0 显示重试进度', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'failed', retryCount: 3 }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		const text = wrapper.vm.connLabel('1');
		expect(text).toContain('WebRTC');
		expect(text).toContain('retry');
		expect(text).toContain('3');
	});

	test('rtcPhase=failed + retryCount=0 显示重试耗尽', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'failed', retryCount: 0 }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: connection failed (retries exhausted)');
	});

	test('rtcPhase=building → WebRTC connecting', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'building' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: connecting…');
	});

	test('rtcPhase=recovering → WebRTC recovering', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'recovering' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: recovering…');
	});

	test('rtcPhase=restarting → 始终显示 ICE restarting（不看 transportInfo）', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'restarting', rtcTransportInfo: { localType: 'srflx', localProtocol: 'udp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: ICE restarting…');
	});

	test('rtcPhase=restarting 无 transportInfo → ICE restarting', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'restarting' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: ICE restarting…');
	});

	test('rtcPhase=ready 无 transportInfo → 过渡态 fallback 到 building 文案', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: connecting…');
	});

	test('rtcPhase=ready + relay UDP → Relay', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'relay', relayProtocol: 'udp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: Relay');
	});

	test('rtcPhase=ready + relay TCP → Relay + protocol', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'relay', relayProtocol: 'tcp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: Relay · TCP');
	});

	test('rtcPhase=ready + host UDP → LAN', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'host', localProtocol: 'udp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: LAN');
	});

	test('rtcPhase=ready + srflx UDP → P2P', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'srflx', localProtocol: 'udp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: P2P');
	});

	test('rtcPhase=ready + host TCP → LAN + protocol', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'host', localProtocol: 'tcp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: LAN · TCP');
	});

	test('rtcPhase=ready + srflx TCP → P2P + protocol', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready', rtcTransportInfo: { localType: 'srflx', localProtocol: 'tcp' } }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.connLabel('1')).toBe('WebRTC: P2P · TCP');
	});
});

describe('clawDotClass', () => {
	test('offline → 灰色', async () => {
		mockBots = [{ id: '1', name: 'A', online: false }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		expect(wrapper.vm.clawDotClass(mockBots[0])).toBe('bg-gray-500');
	});

	test('online + ready → 绿色脉冲', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'ready' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		const cls = wrapper.vm.clawDotClass(mockBots[0]);
		expect(cls).toContain('bg-green-400');
		expect(cls).toContain('animate-pulse');
	});

	test('online + failed → 红色', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'failed' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		const cls = wrapper.vm.clawDotClass(mockBots[0]);
		expect(cls).toContain('bg-red-400');
		expect(cls).not.toContain('animate-pulse');
	});

	test('online + building → 黄色脉冲', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'building' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		const cls = wrapper.vm.clawDotClass(mockBots[0]);
		expect(cls).toContain('bg-yellow-400');
		expect(cls).toContain('animate-pulse');
	});

	test('online + recovering → 黄色脉冲', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'recovering' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		const cls = wrapper.vm.clawDotClass(mockBots[0]);
		expect(cls).toContain('bg-yellow-400');
		expect(cls).toContain('animate-pulse');
	});

	test('online + restarting → 黄色脉冲', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'restarting' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		const cls = wrapper.vm.clawDotClass(mockBots[0]);
		expect(cls).toContain('bg-yellow-400');
		expect(cls).toContain('animate-pulse');
	});

	test('online + idle → 黄色脉冲（RTC 尚未就绪）', async () => {
		mockBots = [{ id: '1', name: 'A', online: true, rtcPhase: 'idle' }];
		mockGetDashboard.mockReturnValue({ agents: [], instance: null, loading: false });
		const wrapper = createWrapper();
		await flushPromises();
		const cls = wrapper.vm.clawDotClass(mockBots[0]);
		expect(cls).toContain('bg-yellow-400');
		expect(cls).toContain('animate-pulse');
	});
});

describe('rename', () => {
	test('onConfirmRename 成功：调用 RPC + 乐观更新 pluginInfo.name + 关闭弹窗', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue({
			instance: { name: 'Bot1', online: true },
			agents: [],
			loading: false,
		});
		const mockConn = { request: vi.fn().mockResolvedValue({}) };
		mockGetReadyConn.mockReturnValue(mockConn);

		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.openRename({ id: '1', pluginInfo: { name: 'OldName' } });
		expect(wrapper.vm.renameOpen).toBe(true);
		expect(wrapper.vm.renameValue).toBe('OldName');

		wrapper.vm.renameValue = 'NewName';
		await wrapper.vm.onConfirmRename();

		expect(mockConn.request).toHaveBeenCalledWith('coclaw.info.patch', { name: 'NewName' });
		expect(wrapper.vm.renameOpen).toBe(false);
		expect(wrapper.vm.renaming).toBe(false);
	});

	test('onConfirmRename conn 不可用 → notify error', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue({ instance: { name: 'Bot1' }, agents: [], loading: false });
		mockGetReadyConn.mockReturnValue(null);

		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.openRename({ id: '1' });
		wrapper.vm.renameValue = 'NewName';
		await wrapper.vm.onConfirmRename();

		expect(mockNotify.error).toHaveBeenCalled();
		expect(wrapper.vm.renaming).toBe(false);
	});

	test('onConfirmRename RPC 报错 → notify error', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue({ instance: { name: 'Bot1' }, agents: [], loading: false });
		const mockConn = { request: vi.fn().mockRejectedValue(new Error('RPC timeout')) };
		mockGetReadyConn.mockReturnValue(mockConn);

		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.openRename({ id: '1' });
		wrapper.vm.renameValue = 'NewName';
		await wrapper.vm.onConfirmRename();

		expect(mockNotify.error).toHaveBeenCalledWith('RPC timeout');
		expect(wrapper.vm.renaming).toBe(false);
		expect(wrapper.vm.renameOpen).toBe(true);
		warnSpy.mockRestore();
	});

	test('onConfirmRename 空名称 → 不发请求', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: true }];
		mockGetDashboard.mockReturnValue({ instance: { name: 'Bot1' }, agents: [], loading: false });
		const mockConn = { request: vi.fn() };
		mockGetReadyConn.mockReturnValue(mockConn);

		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.openRename({ id: '1' });
		wrapper.vm.renameValue = '   ';
		await wrapper.vm.onConfirmRename();

		expect(mockConn.request).not.toHaveBeenCalled();
	});

	test('离线 claw → openRename 后 conn 不可用，直接报错', async () => {
		mockBots = [{ id: '1', name: 'Bot1', online: false }];
		mockGetDashboard.mockReturnValue({
			instance: { name: 'Bot1', online: false },
			agents: [],
			loading: false,
		});
		mockGetReadyConn.mockReturnValue(null);
		const wrapper = createWrapper();
		await flushPromises();

		wrapper.vm.openRename({ id: '1', name: 'Bot1' });
		wrapper.vm.renameValue = 'NewName';
		await wrapper.vm.onConfirmRename();

		expect(mockNotify.error).toHaveBeenCalled();
	});
});

