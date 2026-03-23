import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	WebRtcConnection,
	initRtcForBot,
	closeRtcForBot,
	__resetRtcInstances,
	__getRtcInstance,
} from './webrtc-connection.js';

// --- Mock RTCPeerConnection ---

/** 记录创建的所有实例 */
const pcInstances = [];

class MockRTCPeerConnection {
	constructor(config) {
		this.config = config;
		this.onicecandidate = null;
		this.onconnectionstatechange = null;
		this.connectionState = 'new';
		this.localDescription = null;
		this.__remoteDesc = null;
		this.__candidates = [];
		this.__channels = [];
		this.__closed = false;
		this.__createOfferOpts = []; // 记录每次 createOffer 的选项
		MockRTCPeerConnection.lastInstance = this;
		pcInstances.push(this);
	}

	createDataChannel(label, opts) {
		const dc = {
			label,
			ordered: opts?.ordered,
			onopen: null,
			onclose: null,
			onmessage: null,
			readyState: 'connecting',
		};
		this.__channels.push(dc);
		return dc;
	}

	async createOffer(opts) {
		this.__createOfferOpts.push(opts);
		return { type: 'offer', sdp: opts?.iceRestart ? 'mock-sdp-ice-restart' : 'mock-sdp-offer' };
	}

	async setLocalDescription(desc) {
		this.localDescription = desc;
	}

	async setRemoteDescription(desc) {
		this.__remoteDesc = desc;
	}

	async addIceCandidate(candidate) {
		this.__candidates.push(candidate);
	}

	async getStats() {
		return new Map();
	}

	close() {
		this.__closed = true;
		this.connectionState = 'closed';
	}
}

// --- Mock BotConnection ---

function createMockBotConn() {
	const listeners = {};
	return {
		sendRaw: vi.fn().mockReturnValue(true),
		on(event, cb) { (listeners[event] ??= []).push(cb); },
		off(event, cb) {
			if (listeners[event]) listeners[event] = listeners[event].filter((c) => c !== cb);
		},
		__fire(event, data) {
			for (const cb of listeners[event] ?? []) cb(data);
		},
		__listeners: listeners,
	};
}

const MOCK_TURN_CREDS = {
	username: '1234:42',
	credential: 'base64==',
	ttl: 86400,
	urls: [
		'stun:coclaw.net:3478',
		'turn:coclaw.net:3478?transport=udp',
		'turn:coclaw.net:3478?transport=tcp',
	],
};

describe('WebRtcConnection — 基础建连', () => {
	beforeEach(() => {
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});

	test('初始状态为 idle', () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });
		expect(rtc.state).toBe('idle');
		expect(rtc.candidateType).toBeNull();
	});

	test('connect 发送 offer 并创建 rpc DataChannel', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		expect(rtc.state).toBe('connecting');
		expect(botConn.sendRaw).toHaveBeenCalledWith({
			type: 'rtc:offer',
			payload: { sdp: 'mock-sdp-offer' },
		});

		const pc = MockRTCPeerConnection.lastInstance;
		expect(pc.__channels.length).toBe(1);
		expect(pc.__channels[0].label).toBe('rpc');
		expect(pc.__channels[0].ordered).toBe(true);

		rtc.close();
	});

	test('connect 正确构建 iceServers（STUN 无 credential，TURN 有）', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		const iceServers = pc.config.iceServers;
		expect(iceServers).toHaveLength(3);
		expect(iceServers[0]).toEqual({ urls: 'stun:coclaw.net:3478' });
		expect(iceServers[1]).toEqual({
			urls: 'turn:coclaw.net:3478?transport=udp',
			username: '1234:42',
			credential: 'base64==',
		});

		rtc.close();
	});

	test('connect 无 turnCreds 时 iceServers 为空', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(null);

		const pc = MockRTCPeerConnection.lastInstance;
		expect(pc.config.iceServers).toEqual([]);

		rtc.close();
	});

	test('非 idle/closed/failed 状态下 connect 是幂等的', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const firstPc = MockRTCPeerConnection.lastInstance;
		await rtc.connect(MOCK_TURN_CREDS);
		expect(MockRTCPeerConnection.lastInstance).toBe(firstPc);

		rtc.close();
	});

	test('closed 状态可重新 connect', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		rtc.close();
		expect(rtc.state).toBe('closed');

		await rtc.connect(MOCK_TURN_CREDS);
		expect(rtc.state).toBe('connecting');

		rtc.close();
	});

	test('connect 缓存 turnCreds 供后续 rebuild 使用', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		// 内部应缓存 turnCreds
		expect(rtc.__turnCreds).toBe(MOCK_TURN_CREDS);

		rtc.close();
	});
});

describe('WebRtcConnection — 状态变更', () => {
	beforeEach(() => {
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});

	test('onconnectionstatechange → connected 更新状态并重置 ICE restart 计数', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });
		const stateChanges = [];
		rtc.onStateChange = (s) => stateChanges.push(s);

		await rtc.connect(MOCK_TURN_CREDS);
		rtc.__iceRestartCount = 1; // 模拟之前有过 ICE restart

		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();

		expect(rtc.state).toBe('connected');
		expect(stateChanges).toContain('connected');
		expect(rtc.__iceRestartCount).toBe(0); // 连接成功后重置

		rtc.close();
	});

	test('onconnectionstatechange → disconnected 不改变状态（等待自动恢复）', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		expect(rtc.state).toBe('connected');

		// disconnected → 应等待自动恢复，状态不变
		pc.connectionState = 'disconnected';
		pc.onconnectionstatechange();
		expect(rtc.state).toBe('connected'); // 仍是 connected

		rtc.close();
	});

	test('onconnectionstatechange → closed 更新状态', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'closed';
		pc.onconnectionstatechange();

		expect(rtc.state).toBe('closed');
		rtc.close();
	});
});

describe('WebRtcConnection — 信令与 DataChannel', () => {
	beforeEach(() => {
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});

	test('ICE candidate 通过 WS 发送', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		const mockCandidate = {
			candidate: 'candidate:123',
			sdpMid: '0',
			sdpMLineIndex: 0,
			toJSON() { return { candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex }; },
		};
		pc.onicecandidate({ candidate: mockCandidate });

		expect(botConn.sendRaw).toHaveBeenCalledWith({
			type: 'rtc:ice',
			payload: { candidate: 'candidate:123', sdpMid: '0', sdpMLineIndex: 0 },
		});

		rtc.close();
	});

	test('ICE candidate 为 null 时不发送', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		botConn.sendRaw.mockClear();

		const pc = MockRTCPeerConnection.lastInstance;
		pc.onicecandidate({ candidate: null });

		expect(botConn.sendRaw).not.toHaveBeenCalled();

		rtc.close();
	});

	test('rtc:answer 信令设置 remote description', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		botConn.__fire('rtc', { type: 'rtc:answer', payload: { sdp: 'mock-answer-sdp' } });

		const pc = MockRTCPeerConnection.lastInstance;
		expect(pc.__remoteDesc).toEqual({ type: 'answer', sdp: 'mock-answer-sdp' });

		rtc.close();
	});

	test('rtc:ice 信令添加 ICE candidate', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		const icePayload = { candidate: 'candidate:456', sdpMid: '0', sdpMLineIndex: 0 };
		botConn.__fire('rtc', { type: 'rtc:ice', payload: icePayload });

		const pc = MockRTCPeerConnection.lastInstance;
		expect(pc.__candidates).toContainEqual(icePayload);

		rtc.close();
	});

	test('DataChannel open 时发送 rtc:ready', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		pc.__channels[0].onopen();

		expect(botConn.sendRaw).toHaveBeenCalledWith({ type: 'rtc:ready' });

		rtc.close();
	});

	test('DataChannel message 仅日志不抛异常', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		const dc = pc.__channels[0];
		expect(() => dc.onmessage({ data: '{"method":"test"}' })).not.toThrow();

		rtc.close();
	});
});

describe('WebRtcConnection — close', () => {
	beforeEach(() => {
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});

	test('close 发送 rtc:closed 并清理', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		rtc.close();

		expect(botConn.sendRaw).toHaveBeenCalledWith({ type: 'rtc:closed' });
		expect(pc.__closed).toBe(true);
		expect(rtc.state).toBe('closed');
		expect(botConn.__listeners['rtc']?.length ?? 0).toBe(0);
	});

	test('close 后再 close 不重复发送 rtc:closed', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		rtc.close();
		botConn.sendRaw.mockClear();
		rtc.close();

		const closedCalls = botConn.sendRaw.mock.calls.filter(
			([msg]) => msg.type === 'rtc:closed',
		);
		expect(closedCalls.length).toBe(0);
	});
});

describe('WebRtcConnection — ICE restart 恢复', () => {
	beforeEach(() => {
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});

	test('failed 时发起 ICE restart（不重建 PeerConnection）', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;

		// 模拟 ICE failed（__doIceRestart 是异步的）
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();

		// 等待异步 ICE restart 完成
		await vi.waitFor(() => {
			expect(botConn.sendRaw).toHaveBeenCalledWith({
				type: 'rtc:offer',
				payload: { sdp: 'mock-sdp-ice-restart' },
			});
		});

		// 应发起 ICE restart，不重建 PeerConnection
		expect(pcInstances.length).toBe(1);
		expect(pc.__createOfferOpts).toContainEqual({ iceRestart: true });

		rtc.close();
	});

	test('ICE restart 成功后重置 iceRestartCount', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;

		// 模拟第一次 failed → ICE restart
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.waitFor(() => expect(rtc.__iceRestartCount).toBe(1));

		// 模拟 ICE restart 成功 → connected
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		expect(rtc.state).toBe('connected');
		expect(rtc.__iceRestartCount).toBe(0);

		rtc.close();
	});

	test('ICE restart 达到上限后执行 full rebuild', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const firstPc = MockRTCPeerConnection.lastInstance;

		// 消耗 2 次 ICE restart
		firstPc.connectionState = 'failed';
		firstPc.onconnectionstatechange(); // ICE restart #1
		await vi.waitFor(() => expect(rtc.__iceRestartCount).toBe(1));

		firstPc.connectionState = 'failed';
		firstPc.onconnectionstatechange(); // ICE restart #2
		await vi.waitFor(() => expect(rtc.__iceRestartCount).toBe(2));

		// 第 3 次 failed → 超过 ICE restart 上限，应 full rebuild
		firstPc.connectionState = 'failed';
		firstPc.onconnectionstatechange();

		await vi.waitFor(() => {
			// 应创建了新的 PeerConnection
			expect(pcInstances.length).toBe(2);
		});
		expect(MockRTCPeerConnection.lastInstance).not.toBe(firstPc);
		expect(firstPc.__closed).toBe(true);

		rtc.close();
	});

	test('full rebuild 使用缓存的 turnCreds', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const firstPc = MockRTCPeerConnection.lastInstance;

		// 强制进入 rebuild
		rtc.__iceRestartCount = 2;
		firstPc.connectionState = 'failed';
		firstPc.onconnectionstatechange();

		await vi.waitFor(() => expect(pcInstances.length).toBe(2));

		// 新 PC 应使用相同的 iceServers
		const newPc = MockRTCPeerConnection.lastInstance;
		expect(newPc).not.toBe(firstPc);
		expect(newPc.config.iceServers).toHaveLength(3);
		expect(newPc.config.iceServers[0]).toEqual({ urls: 'stun:coclaw.net:3478' });

		rtc.close();
	});

	test('所有恢复手段耗尽后状态变为 failed', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });
		const stateChanges = [];
		rtc.onStateChange = (s) => stateChanges.push(s);

		await rtc.connect(MOCK_TURN_CREDS);

		// 耗尽 ICE restart (2次) + full rebuild (3次)
		// 每次 rebuild 创建新 PC，新 PC 也可能 fail
		for (let i = 0; i < 20; i++) {
			const pc = MockRTCPeerConnection.lastInstance;
			if (pc.__closed) break;
			pc.connectionState = 'failed';
			pc.onconnectionstatechange();
			// 等待异步恢复操作完成
			await new Promise((r) => setTimeout(r, 0));
		}

		expect(rtc.state).toBe('failed');
		expect(stateChanges).toContain('failed');

		rtc.close();
	});

	test('旧 PeerConnection 的回调不影响新 PC', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const oldPc = MockRTCPeerConnection.lastInstance;

		// 强制 rebuild
		rtc.__iceRestartCount = 2;
		oldPc.connectionState = 'failed';
		oldPc.onconnectionstatechange();

		await vi.waitFor(() => expect(pcInstances.length).toBe(2));

		const newPc = MockRTCPeerConnection.lastInstance;
		expect(newPc).not.toBe(oldPc);

		// rebuild 清理旧 PC 时已清空事件回调
		expect(oldPc.onconnectionstatechange).toBeNull();

		rtc.close();
	});

	test('rebuild 后 rtc listener 保持（不重复注册）', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		// 强制 rebuild
		rtc.__iceRestartCount = 2;
		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();

		await vi.waitFor(() => expect(pcInstances.length).toBe(2));

		// rtc 监听器应仍只有 1 个
		expect(botConn.__listeners['rtc']?.length).toBe(1);

		// 信令仍可正常工作
		const newPc = MockRTCPeerConnection.lastInstance;
		botConn.__fire('rtc', { type: 'rtc:answer', payload: { sdp: 'new-answer' } });
		expect(newPc.__remoteDesc).toEqual({ type: 'answer', sdp: 'new-answer' });

		rtc.close();
	});
});

describe('initRtcForBot / closeRtcForBot', () => {
	beforeEach(() => {
		__resetRtcInstances();
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});

	afterEach(() => {
		__resetRtcInstances();
	});

	test('initRtcForBot 创建实例并发起连接', async () => {
		const botConn = createMockBotConn();
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockResolvedValue({ data: MOCK_TURN_CREDS });
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;

		try {
			await initRtcForBot('bot1', botConn);

			const instance = __getRtcInstance('bot1');
			expect(instance).toBeTruthy();
			expect(instance.state).toBe('connecting');
			expect(mockGet).toHaveBeenCalledWith('/api/v1/turn/creds');
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});

	test('initRtcForBot 幂等：已有非 closed 实例时跳过', async () => {
		const botConn = createMockBotConn();
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockResolvedValue({ data: MOCK_TURN_CREDS });
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;

		try {
			await initRtcForBot('bot1', botConn);
			const first = __getRtcInstance('bot1');
			mockGet.mockClear();

			await initRtcForBot('bot1', botConn);
			expect(mockGet).not.toHaveBeenCalled();
			expect(__getRtcInstance('bot1')).toBe(first);
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});

	test('initRtcForBot TURN 请求失败时清理实例', async () => {
		const botConn = createMockBotConn();
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockRejectedValue(new Error('network error'));
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;

		try {
			await initRtcForBot('bot1', botConn);
			expect(__getRtcInstance('bot1')).toBeUndefined();
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});

	test('closeRtcForBot 关闭并移除实例', async () => {
		const botConn = createMockBotConn();
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockResolvedValue({ data: MOCK_TURN_CREDS });
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;

		try {
			await initRtcForBot('bot1', botConn);
			expect(__getRtcInstance('bot1')).toBeTruthy();

			closeRtcForBot('bot1');
			expect(__getRtcInstance('bot1')).toBeUndefined();
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});

	test('closeRtcForBot 对不存在的 botId 无影响', () => {
		expect(() => closeRtcForBot('nonexistent')).not.toThrow();
	});
});
