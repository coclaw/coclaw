import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// mock remote-log（webrtc-connection 内部 import）
vi.mock('./remote-log.js', () => ({ remoteLog: vi.fn() }));

// mock signaling-connection 单例
const mockSendSignaling = vi.fn().mockReturnValue(true);
const mockEnsureConnected = vi.fn().mockResolvedValue(undefined);
const sigListeners = {};
/** 信令 WS 状态（可在测试中切换） */
let mockSigState = 'connected';
vi.mock('./signaling-connection.js', () => ({
	useSignalingConnection: () => ({
		sendSignaling: mockSendSignaling,
		ensureConnected: mockEnsureConnected,
		get state() { return mockSigState; },
		on(event, cb) { (sigListeners[event] ??= []).push(cb); },
		off(event, cb) {
			if (sigListeners[event]) sigListeners[event] = sigListeners[event].filter(c => c !== cb);
		},
	}),
}));

/** 触发 signaling 'rtc' 事件（模拟入站信令） */
function fireRtcSignal(data) {
	for (const cb of sigListeners['rtc'] ?? []) cb(data);
}

import {
	WebRtcConnection,
	initRtc,
	initRtcForClaw,
	closeRtcForClaw,
	closeAllRtcInstances,
	parseCredExpireAt,
	__resetRtcInstances,
	__getRtcInstance,
} from './webrtc-connection.js';

// 全局重置 mock 状态
beforeEach(() => {
	mockSendSignaling.mockClear();
	mockSendSignaling.mockReturnValue(true);
	mockEnsureConnected.mockReset();
	mockEnsureConnected.mockResolvedValue(undefined);
	mockSigState = 'connected';
	for (const key of Object.keys(sigListeners)) delete sigListeners[key];
});

// --- Mock RTCPeerConnection ---

/** 记录创建的所有实例 */
const pcInstances = [];

class MockRTCPeerConnection {
	constructor(config) {
		this.config = config;
		this.onicecandidate = null;
		this.onconnectionstatechange = null;
		this.oniceconnectionstatechange = null;
		this.onicegatheringstatechange = null;
		this.onsignalingstatechange = null;
		this.onicecandidateerror = null;
		this.connectionState = 'new';
		this.iceConnectionState = 'new';
		this.iceGatheringState = 'new';
		this.signalingState = 'stable';
		this.localDescription = null;
		this.__remoteDesc = null;
		this.__candidates = [];
		this.__channels = [];
		this.__closed = false;
		this.__closeCallCount = 0; // 统计 close() 调用次数，用于验证幂等
		this.__createOfferOpts = []; // 记录每次 createOffer 的选项
		MockRTCPeerConnection.lastInstance = this;
		pcInstances.push(this);
	}

	createDataChannel(label, opts) {
		const dcListeners = {};
		const dc = {
			label,
			ordered: opts?.ordered,
			onopen: null,
			onclose: null,
			onmessage: null,
			readyState: 'connecting',
			bufferedAmount: 0,
			bufferedAmountLowThreshold: 0,
			sent: [],
			send(data) { this.sent.push(data); },
			addEventListener(event, cb) { (dcListeners[event] ??= []).push(cb); },
			removeEventListener(event, cb) {
				if (dcListeners[event]) dcListeners[event] = dcListeners[event].filter((c) => c !== cb);
			},
			__fireDcEvent(event) {
				for (const cb of dcListeners[event] ?? []) cb();
			},
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
		return this.__statsReport ?? new Map();
	}

	close() {
		this.__closed = true;
		this.__closeCallCount++;
		this.connectionState = 'closed';
	}
}

// --- Mock ClawConnection ---

function createMockBotConn() {
	return {
		setRtc: vi.fn(),
		clearRtc: vi.fn(),
		__rejectAllPending: vi.fn(),
		__onRtcMessage: vi.fn(),
	};
}

const MOCK_TURN_CREDS = {
	username: '1234:42',
	credential: 'base64==',
	ttl: 86400,
	urls: [
		'turn:coclaw.net:3478?transport=udp',
		'turns:coclaw.net:443?transport=tcp',
	],
};

describe('WebRtcConnection — 基础建连', () => {
	beforeEach(() => {
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});

	test('初始状态为 idle', () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		expect(rtc.state).toBe('idle');
		expect(rtc.candidateType).toBeNull();
		expect(rtc.transportInfo).toBeNull();
	});

	test('connect 发送 offer 并创建 rpc DataChannel', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		mockSendSignaling.mockClear();

		await rtc.connect(MOCK_TURN_CREDS);

		expect(rtc.state).toBe('connecting');
		expect(mockSendSignaling).toHaveBeenCalledWith('bot1', 'rtc:offer', { sdp: 'mock-sdp-offer' });

		const pc = MockRTCPeerConnection.lastInstance;
		expect(pc.__channels.length).toBe(1);
		expect(pc.__channels[0].label).toBe('rpc');
		expect(pc.__channels[0].ordered).toBe(true);

		rtc.close();
	});

	test('connect 正确构建 iceServers（turn/turns 均附带 credential）', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		const iceServers = pc.config.iceServers;
		expect(iceServers).toHaveLength(2);
		expect(iceServers[0]).toEqual({
			urls: 'turn:coclaw.net:3478?transport=udp',
			username: '1234:42',
			credential: 'base64==',
		});
		expect(iceServers[1]).toEqual({
			urls: 'turns:coclaw.net:443?transport=tcp',
			username: '1234:42',
			credential: 'base64==',
		});

		rtc.close();
	});

	test('connect 无 turnCreds 时 iceServers 为空', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(null);

		const pc = MockRTCPeerConnection.lastInstance;
		expect(pc.config.iceServers).toEqual([]);

		rtc.close();
	});

	test('非 idle/closed/failed 状态下 connect 是幂等的', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const firstPc = MockRTCPeerConnection.lastInstance;
		await rtc.connect(MOCK_TURN_CREDS);
		expect(MockRTCPeerConnection.lastInstance).toBe(firstPc);

		rtc.close();
	});

	test('closed 状态可重新 connect', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		rtc.close();
		expect(rtc.state).toBe('closed');

		await rtc.connect(MOCK_TURN_CREDS);
		expect(rtc.state).toBe('connecting');

		rtc.close();
	});

	test('connect 不缓存完整 turnCreds，但缓存过期时间戳用于 ICE restart 诊断', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		// 完整 turnCreds 不缓存（外层 rebuild 会重新 fetch）
		expect(rtc.__turnCreds).toBeUndefined();
		// 但 username 里的过期时间戳缓存供 credRemain 日志使用
		expect(rtc.__credExpireAt).toBe(1234);

		rtc.close();
	});

	test('connect 凭证 username 解析失败时 __credExpireAt 为 null', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect({ ...MOCK_TURN_CREDS, username: 'malformed' });
		expect(rtc.__credExpireAt).toBeNull();

		rtc.close();
	});

	test('connect 无 turnCreds 时 __credExpireAt 为 null', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(null);
		expect(rtc.__credExpireAt).toBeNull();

		rtc.close();
	});
});

describe('WebRtcConnection — 状态变更', () => {
	beforeEach(() => {
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});

	test('onconnectionstatechange → connected 更新状态', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		const stateChanges = [];
		rtc.onStateChange = (s) => stateChanges.push(s);

		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();

		expect(rtc.state).toBe('connected');
		expect(stateChanges).toContain('connected');

		rtc.close();
	});

	test('onconnectionstatechange → disconnected 不改变状态（等待自动恢复）', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

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

	test('disconnected 超时后升级到 __onIceFailed 恢复链', async () => {
		vi.useFakeTimers();
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();

		const failedSpy = vi.spyOn(rtc, '__onIceFailed');

		// 进入 disconnected
		pc.connectionState = 'disconnected';
		pc.onconnectionstatechange();

		// 未超时前不触发
		vi.advanceTimersByTime(4_999);
		expect(failedSpy).not.toHaveBeenCalled();

		// 超时后触发恢复
		vi.advanceTimersByTime(1);
		expect(failedSpy).toHaveBeenCalledTimes(1);

		rtc.close();
		vi.useRealTimers();
	});

	test('disconnected 后自动恢复到 connected 时清除超时定时器', async () => {
		vi.useFakeTimers();
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();

		const failedSpy = vi.spyOn(rtc, '__onIceFailed');

		// 进入 disconnected → 启动定时器
		pc.connectionState = 'disconnected';
		pc.onconnectionstatechange();

		// 3s 后恢复 connected → 清除定时器
		vi.advanceTimersByTime(3_000);
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();

		// 超时点过后不应触发
		vi.advanceTimersByTime(10_000);
		expect(failedSpy).not.toHaveBeenCalled();

		rtc.close();
		vi.useRealTimers();
	});

	test('onconnectionstatechange → closed 更新状态', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'closed';
		pc.onconnectionstatechange();

		expect(rtc.state).toBe('closed');
		rtc.close();
	});

	test('connected 后从 getStats 解析 transportInfo (P2P host/udp)', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		const changes = [];
		rtc.onStateChange = () => changes.push(rtc.transportInfo);

		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;

		pc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, localCandidateId: 'lc1', remoteCandidateId: 'rc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1', candidateType: 'host', protocol: 'udp' }],
			['rc1', { type: 'remote-candidate', id: 'rc1', candidateType: 'host', protocol: 'udp' }],
		]);

		pc.connectionState = 'connected';
		pc.onconnectionstatechange();

		// getStats 是异步的，等一个 tick
		await new Promise((r) => setTimeout(r, 0));

		expect(rtc.candidateType).toBe('host');
		expect(rtc.transportInfo).toEqual({
			localType: 'host',
			localProtocol: 'udp',
			remoteType: 'host',
			remoteProtocol: 'udp',
			relayProtocol: null,
		});
		// onStateChange 被调用三次：connecting + connected + transportInfo 解析完成
		expect(changes.length).toBe(3);
		expect(changes[2]).toEqual(rtc.transportInfo);
		rtc.close();
	});

	test('connected 后从 getStats 解析 transportInfo (relay/tls)', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;

		pc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, localCandidateId: 'lc1', remoteCandidateId: 'rc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1', candidateType: 'relay', protocol: 'tcp', relayProtocol: 'tls' }],
			['rc1', { type: 'remote-candidate', id: 'rc1', candidateType: 'srflx', protocol: 'udp' }],
		]);

		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		await new Promise((r) => setTimeout(r, 0));

		expect(rtc.candidateType).toBe('relay');
		expect(rtc.transportInfo).toEqual({
			localType: 'relay',
			localProtocol: 'tcp',
			remoteType: 'srflx',
			remoteProtocol: 'udp',
			relayProtocol: 'tls',
		});
		rtc.close();
	});

	test('getStats 返回时若 PC 已被替换则丢弃结果', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const oldPc = MockRTCPeerConnection.lastInstance;

		oldPc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, localCandidateId: 'lc1', remoteCandidateId: 'rc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1', candidateType: 'host', protocol: 'udp' }],
			['rc1', { type: 'remote-candidate', id: 'rc1', candidateType: 'host', protocol: 'udp' }],
		]);

		// 触发 connected → 调用 getStats（异步，microtask 尚未执行）
		oldPc.connectionState = 'connected';
		oldPc.onconnectionstatechange();

		// 模拟 full rebuild：先强制状态为 failed 以通过 connect() 守卫
		rtc.__state = 'failed';
		await rtc.connect(MOCK_TURN_CREDS);
		// 此时 this.__pc 已指向新 PC，旧 oldPc 的 getStats microtask 稍后执行

		// 等待旧 getStats Promise resolve
		await new Promise((r) => setTimeout(r, 0));

		// 旧 PC 的结果应被丢弃（__buildPeerConnection 已重置，且守卫 this.__pc !== pc 拦截）
		expect(rtc.transportInfo).toBeNull();
		expect(rtc.candidateType).toBeNull();
		rtc.close();
	});
});

describe('WebRtcConnection — 信令与 DataChannel', () => {
	beforeEach(() => {
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});

	test('ICE candidate 通过 WS 发送', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		const mockCandidate = {
			candidate: 'candidate:123',
			sdpMid: '0',
			sdpMLineIndex: 0,
			toJSON() { return { candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex }; },
		};
		pc.onicecandidate({ candidate: mockCandidate });

		expect(mockSendSignaling).toHaveBeenCalledWith(
			'bot1', 'rtc:ice', { candidate: 'candidate:123', sdpMid: '0', sdpMLineIndex: 0 },
		);

		rtc.close();
	});

	test('ICE candidate 为 null 时不发送', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		mockSendSignaling.mockClear();

		const pc = MockRTCPeerConnection.lastInstance;
		pc.onicecandidate({ candidate: null });

		expect(mockSendSignaling).not.toHaveBeenCalled();

		rtc.close();
	});

	test('rtc:answer 信令设置 remote description', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:answer', payload: { sdp: 'mock-answer-sdp' } });

		const pc = MockRTCPeerConnection.lastInstance;
		expect(pc.__remoteDesc).toEqual({ type: 'answer', sdp: 'mock-answer-sdp' });

		rtc.close();
	});

	test('rtc:answer setRemoteDescription 失败时 warn 日志', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		// 让 setRemoteDescription reject
		pc.setRemoteDescription = async () => { throw new Error('sdp invalid'); };

		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:answer', payload: { sdp: 'bad-sdp' } });
		// 等待异步 rejection 处理
		await vi.waitFor(() => {
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('setRemoteDescription failed'),
			);
		});
		warnSpy.mockRestore();
		rtc.close();
	});

	test('rtc:ice 在 answer 之后直接添加 ICE candidate', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		// 先设置 answer，等 setRemoteDescription 完成
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:answer', payload: { sdp: 'mock-answer-sdp' } });
		await vi.waitFor(() => {
			expect(MockRTCPeerConnection.lastInstance.__remoteDesc).toBeTruthy();
		});

		const icePayload = { candidate: 'candidate:456', sdpMid: '0', sdpMLineIndex: 0 };
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:ice', payload: icePayload });

		const pc = MockRTCPeerConnection.lastInstance;
		expect(pc.__candidates).toContainEqual(icePayload);

		rtc.close();
	});

	test('rtc:ice 在 answer 之前暂存，answer 后批量添加', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		// answer 到达前先发 ICE candidates
		const ice1 = { candidate: 'candidate:111', sdpMid: '0', sdpMLineIndex: 0 };
		const ice2 = { candidate: 'candidate:222', sdpMid: '0', sdpMLineIndex: 0 };
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:ice', payload: ice1 });
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:ice', payload: ice2 });

		const pc = MockRTCPeerConnection.lastInstance;
		// answer 前不应添加
		expect(pc.__candidates).toHaveLength(0);

		// answer 到达后触发排空
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:answer', payload: { sdp: 'mock-answer-sdp' } });
		await vi.waitFor(() => {
			expect(pc.__candidates).toHaveLength(2);
		});
		expect(pc.__candidates).toContainEqual(ice1);
		expect(pc.__candidates).toContainEqual(ice2);

		rtc.close();
	});

	test('DataChannel open 时发送 rtc:ready', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		pc.__channels[0].onopen();

		expect(mockSendSignaling).toHaveBeenCalledWith('bot1', 'rtc:ready');

		rtc.close();
	});

	test('DataChannel message 仅日志不抛异常', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		const dc = pc.__channels[0];
		expect(() => dc.onmessage({ data: '{"method":"test"}' })).not.toThrow();

		rtc.close();
	});

	test('dc.onmessage 中 reassembler.feed 抛异常时 catch 并 warn', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		const dc = pc.__channels[0];
		// 让 reassembler.feed 抛异常
		rtc.__reassembler.feed = () => { throw new Error('feed boom'); };
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(() => dc.onmessage({ data: 'bad-data' })).not.toThrow();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('DataChannel 消息错误'),
			expect.any(Error),
		);
		warnSpy.mockRestore();
		rtc.close();
	});

});

describe('WebRtcConnection — close', () => {
	beforeEach(() => {
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});

	test('close 发送 rtc:closed 并清理', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		rtc.close();

		expect(mockSendSignaling).toHaveBeenCalledWith('bot1', 'rtc:closed');
		expect(pc.__closed).toBe(true);
		expect(rtc.state).toBe('closed');
		expect(sigListeners['rtc']?.length ?? 0).toBe(0);
	});

	test('close 后再 close 不重复发送 rtc:closed', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		rtc.close();
		mockSendSignaling.mockClear();
		rtc.close();

		const closedCalls = mockSendSignaling.mock.calls.filter(
			([_botId, type]) => type === 'rtc:closed',
		);
		expect(closedCalls.length).toBe(0);
	});
});

describe('WebRtcConnection — __onIceFailed → ICE restart', () => {
	beforeEach(() => {
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});

	test('ICE failed 触发 ICE restart（发送 restart offer）', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		const stateChanges = [];
		rtc.onStateChange = (s) => stateChanges.push(s);

		await rtc.connect(MOCK_TURN_CREDS);
		mockSendSignaling.mockClear();

		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();

		await new Promise((r) => setTimeout(r, 0));

		// 不创建新 PC（ICE restart 复用现有 PC）
		expect(pcInstances.length).toBe(1);
		// 进入 restarting 状态
		expect(rtc.state).toBe('restarting');
		expect(stateChanges).toContain('restarting');
		// 发送了 ICE restart offer
		expect(mockSendSignaling).toHaveBeenCalledWith(
			'bot1', 'rtc:offer',
			expect.objectContaining({ iceRestart: true }),
		);
		// createOffer 使用了 iceRestart: true
		expect(pc.__createOfferOpts.at(-1)).toEqual({ iceRestart: true });

		rtc.close();
	});
});

describe('WebRtcConnection — DC probe', () => {
	beforeEach(() => {
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});

	test('DC open + probe-ack → 返回 true', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		dc.readyState = 'open';
		dc.onopen();

		// 启动 probe 后模拟收到 probe-ack
		const p = rtc.probe(1000);
		// 通过 reassembler 模拟入站消息
		dc.onmessage({ data: JSON.stringify({ type: 'probe-ack' }) });
		expect(await p).toBe(true);

		rtc.close();
	});

	test('DC open 但超时（无 ack）→ 返回 false', async () => {
		vi.useFakeTimers();
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		dc.readyState = 'open';
		dc.onopen();

		const p = rtc.probe(3000);
		vi.advanceTimersByTime(3000);
		expect(await p).toBe(false);

		rtc.close();
		vi.useRealTimers();
	});

	test('DC 未就绪 → 返回 false', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		// DC 仍是 connecting，未 open
		expect(await rtc.probe(100)).toBe(false);

		rtc.close();
	});

	test('无 DC → 返回 false', () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		// 未 connect，无 DC
		expect(rtc.probe(100)).resolves.toBe(false);
	});

	test('DC send 抛异常 → 返回 false', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		dc.readyState = 'open';
		dc.onopen();
		dc.send = () => { throw new Error('send failed'); };

		expect(await rtc.probe(100)).toBe(false);

		rtc.close();
	});

	test('close() 期间活跃 probe → resolve false（不挂起）', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		dc.readyState = 'open';
		dc.onopen();

		const p = rtc.probe(5000);
		// close 在 probe 进行中
		rtc.close();
		// probe 应 resolve false，不挂起
		expect(await p).toBe(false);
	});

	test('并发 probe() 复用同一 promise', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		dc.readyState = 'open';
		dc.onopen();

		const p1 = rtc.probe(1000);
		const p2 = rtc.probe(1000);
		expect(p1).toBe(p2);

		dc.onmessage({ data: JSON.stringify({ type: 'probe-ack' }) });
		expect(await p1).toBe(true);
		expect(await p2).toBe(true);

		rtc.close();
	});

	test('probe-ack 不传递给 ClawConnection.__onRtcMessage', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		dc.readyState = 'open';
		dc.onopen();

		rtc.probe(1000);
		dc.onmessage({ data: JSON.stringify({ type: 'probe-ack' }) });

		expect(clawConn.__onRtcMessage).not.toHaveBeenCalled();

		rtc.close();
	});
});

describe('initRtcForClaw / closeRtcForClaw', () => {
	beforeEach(() => {
		__resetRtcInstances();
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
		vi.useFakeTimers();
	});

	afterEach(() => {
		__resetRtcInstances();
		vi.useRealTimers();
	});

	test('initRtcForClaw 创建实例并发起连接', async () => {
		const clawConn = createMockBotConn();
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockResolvedValue({ data: MOCK_TURN_CREDS });
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;

		try {
			const p = initRtcForClaw('bot1', clawConn);
			await vi.advanceTimersByTimeAsync(0); // flush connect promise

			const instance = __getRtcInstance('bot1');
			expect(instance).toBeTruthy();
			expect(instance.state).toBe('connecting');
			expect(mockGet).toHaveBeenCalledWith('/api/v1/turn/creds');

			// 触发 DC open 让 Promise resolve
			const dc = MockRTCPeerConnection.lastInstance.__channels[0];
			dc.readyState = 'open';
			dc.onopen();
			await p;
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});

	test('initRtcForClaw 幂等：已有非 closed 实例时跳过', async () => {
		const clawConn = createMockBotConn();
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockResolvedValue({ data: MOCK_TURN_CREDS });
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;

		try {
			const p1 = initRtcForClaw('bot1', clawConn);
			await vi.advanceTimersByTimeAsync(0);
			const first = __getRtcInstance('bot1');
			// 触发 DC open
			const dc = MockRTCPeerConnection.lastInstance.__channels[0];
			dc.readyState = 'open';
			dc.onopen();
			await p1;
			mockGet.mockClear();

			await initRtcForClaw('bot1', clawConn);
			expect(mockGet).not.toHaveBeenCalled();
			expect(__getRtcInstance('bot1')).toBe(first);
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});

	test('initRtcForClaw TURN 请求失败时清理实例并降级到 WS', async () => {
		const clawConn = createMockBotConn();
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockRejectedValue(new Error('network error'));
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;

		try {
			const p = initRtcForClaw('bot1', clawConn);
			await vi.advanceTimersByTimeAsync(0);
			await p;
			expect(__getRtcInstance('bot1')).toBeUndefined();
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});

	test('closeRtcForClaw 关闭并移除实例', async () => {
		const clawConn = createMockBotConn();
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockResolvedValue({ data: MOCK_TURN_CREDS });
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;

		try {
			const p = initRtcForClaw('bot1', clawConn);
			await vi.advanceTimersByTimeAsync(0);
			// 触发 DC open
			const dc = MockRTCPeerConnection.lastInstance.__channels[0];
			dc.readyState = 'open';
			dc.onopen();
			await p;
			expect(__getRtcInstance('bot1')).toBeTruthy();

			closeRtcForClaw('bot1');
			expect(__getRtcInstance('bot1')).toBeUndefined();
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});

	test('closeRtcForClaw 对不存在的 clawId 无影响', () => {
		expect(() => closeRtcForClaw('nonexistent')).not.toThrow();
	});

	test('closeAllRtcInstances 关闭全部实例并清空 Map（logout 场景）', async () => {
		const clawConn1 = createMockBotConn();
		const clawConn2 = createMockBotConn();
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockResolvedValue({ data: MOCK_TURN_CREDS });
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;

		try {
			const p1 = initRtcForClaw('bot1', clawConn1);
			await vi.advanceTimersByTimeAsync(0);
			const dc1 = MockRTCPeerConnection.lastInstance.__channels[0];
			dc1.readyState = 'open';
			dc1.onopen();
			await p1;

			// 第二个 rtc 故意停留在 init 中（DC 未 open）——模拟 logout 时尚未完成初始化的孤儿
			initRtcForClaw('bot2', clawConn2);
			await vi.advanceTimersByTimeAsync(0);
			expect(__getRtcInstance('bot1')).toBeTruthy();
			expect(__getRtcInstance('bot2')).toBeTruthy();

			const rtc2 = __getRtcInstance('bot2');
			const closeSpy = vi.spyOn(rtc2, 'close');

			closeAllRtcInstances();

			// 包括未完成 init 的 bot2 也被 close + 从 Map 移除
			expect(closeSpy).toHaveBeenCalledTimes(1);
			expect(__getRtcInstance('bot1')).toBeUndefined();
			expect(__getRtcInstance('bot2')).toBeUndefined();
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});

	test('closeAllRtcInstances 后 fallbackTimer 不再误删下一用户同 clawId 的 rtc 条目', async () => {
		const clawConn1 = createMockBotConn();
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockResolvedValue({ data: MOCK_TURN_CREDS });
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;

		try {
			// 用户 A：init 启动但未完成（DC 未 open），fallbackTimer 挂起
			initRtcForClaw('bot1', clawConn1);
			await vi.advanceTimersByTimeAsync(0);
			expect(__getRtcInstance('bot1')).toBeTruthy();

			// 用户 A logout：closeAllRtcInstances 应同步触发 rtc.onStateChange('closed')
			// 路径清掉 fallbackTimer；Map 也被清空
			closeAllRtcInstances();
			expect(__getRtcInstance('bot1')).toBeUndefined();

			// 用户 B 马上用同 clawId 重登并让 DC 成功 open（清掉自己的 fallbackTimer）
			const clawConnB = createMockBotConn();
			const pB = initRtcForClaw('bot1', clawConnB);
			await vi.advanceTimersByTimeAsync(0);
			const dcB = MockRTCPeerConnection.lastInstance.__channels[0];
			dcB.readyState = 'open';
			dcB.onopen();
			await pB;
			const newRtc = __getRtcInstance('bot1');
			expect(newRtc).toBeTruthy();

			// 推进 30s——若 onStateChange('closed') 分支漏清 fallbackTimer，
			// 旧 rtc 的 timer 会 fire、其闭包里 rtcInstances.delete('bot1') 删掉新 rtc
			await vi.advanceTimersByTimeAsync(30_000);
			expect(__getRtcInstance('bot1')).toBe(newRtc);
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});

	test('closeAllRtcInstances 单个 rtc.close 抛错不影响其余清理', async () => {
		const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
		const clawConn1 = createMockBotConn();
		const clawConn2 = createMockBotConn();
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockResolvedValue({ data: MOCK_TURN_CREDS });
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;

		try {
			initRtcForClaw('bot1', clawConn1);
			await vi.advanceTimersByTimeAsync(0);
			initRtcForClaw('bot2', clawConn2);
			await vi.advanceTimersByTimeAsync(0);

			const rtc1 = __getRtcInstance('bot1');
			const rtc2 = __getRtcInstance('bot2');
			// 让 rtc1.close 抛错
			vi.spyOn(rtc1, 'close').mockImplementation(() => { throw new Error('boom from close'); });
			const close2Spy = vi.spyOn(rtc2, 'close');

			expect(() => closeAllRtcInstances()).not.toThrow();

			expect(close2Spy).toHaveBeenCalledTimes(1);
			// Map 仍被清空（rtc1 抛错不阻塞 rtc2 + clear）
			expect(__getRtcInstance('bot1')).toBeUndefined();
			expect(__getRtcInstance('bot2')).toBeUndefined();
			expect(debugSpy).toHaveBeenCalled();
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
			debugSpy.mockRestore();
		}
	});
});

// --- Phase 2: send / isReady / onReady ---

describe('WebRtcConnection — Phase 2 DataChannel 通信', () => {
	beforeEach(() => {
		pcInstances.length = 0;
		MockRTCPeerConnection.lastInstance = null;
	});

	test('send() 通过 DataChannel 发送 JSON（快路径）', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);

		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		dc.readyState = 'open';
		dc.bufferedAmount = 0;

		await rtc.send({ type: 'req', id: '1', method: 'test' });
		expect(dc.sent).toContainEqual(JSON.stringify({ type: 'req', id: '1', method: 'test' }));
	});

	test('send() DC 未 open 时 reject', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);

		// readyState 默认 'connecting'
		await expect(rtc.send({ type: 'req' })).rejects.toThrow('DataChannel not open');
	});

	test('isReady 返回 DataChannel 状态', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);

		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		expect(rtc.isReady).toBe(false); // readyState = 'connecting'

		dc.readyState = 'open';
		expect(rtc.isReady).toBe(true);
	});

	test('dc.onopen 触发 onReady 回调', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		const readyFn = vi.fn();
		rtc.onReady = readyFn;
		await rtc.connect(MOCK_TURN_CREDS);

		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		dc.readyState = 'open';
		dc.onopen();

		expect(readyFn).toHaveBeenCalledTimes(1);
		expect(mockSendSignaling).toHaveBeenCalledWith('bot1', 'rtc:ready');
	});

	test('dc.onmessage 回调 clawConn.__onRtcMessage', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);

		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		const payload = { type: 'res', id: 'ui-1', ok: true, payload: {} };
		dc.onmessage({ data: JSON.stringify(payload) });

		expect(clawConn.__onRtcMessage).toHaveBeenCalledWith(payload);
	});

	test('dc.onmessage 无效 JSON 不抛异常', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);

		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		expect(() => dc.onmessage({ data: 'invalid json{' })).not.toThrow();
		expect(clawConn.__onRtcMessage).not.toHaveBeenCalled();
	});

	test('dc.onmessage reassembler.feed 抛异常时 catch 并 warn', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);

		// 让 reassembler.feed 抛异常
		rtc.__reassembler = { feed: () => { throw new Error('feed boom'); } };
		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(() => dc.onmessage({ data: 'anything' })).not.toThrow();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('DataChannel 消息错误'),
			expect.any(Error),
		);
		warnSpy.mockRestore();
	});
});

describe('WebRtcConnection — send 流控', () => {
	/** 高/低水位与源码一致 */
	const HIGH = 1024 * 1024;

	/** 创建已连接的 rtc + open 的 DC */
	async function makeReady() {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		dc.readyState = 'open';
		dc.bufferedAmount = 0;
		return { rtc, dc, clawConn };
	}

	beforeEach(() => {
		pcInstances.length = 0;
		MockRTCPeerConnection.lastInstance = null;
	});

	test('bufferedAmount 低于高水位时直接发送（快路径）', async () => {
		const { rtc, dc } = await makeReady();
		dc.bufferedAmount = HIGH - 1;

		await rtc.send({ msg: 'hello' });
		expect(dc.sent).toHaveLength(1);
		expect(JSON.parse(dc.sent[0])).toEqual({ msg: 'hello' });
		rtc.close();
	});

	test('bufferedAmount 达到高水位时排队，bufferedamountlow 后排出', async () => {
		const { rtc, dc } = await makeReady();
		dc.bufferedAmount = HIGH; // 达到高水位

		let resolved = false;
		const p = rtc.send({ msg: 'queued' }).then(() => { resolved = true; });
		// 还未排出
		await Promise.resolve();
		expect(resolved).toBe(false);
		expect(dc.sent).toHaveLength(0);

		// 模拟缓冲区释放
		dc.bufferedAmount = 0;
		dc.__fireDcEvent('bufferedamountlow');

		await p;
		expect(resolved).toBe(true);
		expect(dc.sent).toHaveLength(1);
		expect(JSON.parse(dc.sent[0])).toEqual({ msg: 'queued' });
		rtc.close();
	});

	test('多条排队消息按顺序排出', async () => {
		const { rtc, dc } = await makeReady();
		dc.bufferedAmount = HIGH;

		const results = [];
		const p1 = rtc.send({ seq: 1 }).then(() => results.push(1));
		const p2 = rtc.send({ seq: 2 }).then(() => results.push(2));
		const p3 = rtc.send({ seq: 3 }).then(() => results.push(3));

		expect(dc.sent).toHaveLength(0);

		dc.bufferedAmount = 0;
		dc.__fireDcEvent('bufferedamountlow');

		await Promise.all([p1, p2, p3]);
		expect(results).toEqual([1, 2, 3]);
		expect(dc.sent).toHaveLength(3);
		rtc.close();
	});

	test('排出过程中缓冲区再次达到高水位时暂停，下次事件继续', async () => {
		const { rtc, dc } = await makeReady();
		dc.bufferedAmount = HIGH;

		const results = [];
		const p1 = rtc.send({ seq: 1 }).then(() => results.push(1));
		const p2 = rtc.send({ seq: 2 }).then(() => results.push(2));

		// 第一次排出：dc.send 后 bufferedAmount 又升高
		const origSend = dc.send.bind(dc);
		dc.send = (data) => {
			origSend(data);
			dc.bufferedAmount = HIGH; // 发完一条就满了
		};

		dc.bufferedAmount = 0;
		dc.__fireDcEvent('bufferedamountlow');

		await Promise.resolve(); // 让微任务执行
		expect(results).toEqual([1]); // 只排出 1 条
		expect(dc.sent).toHaveLength(1);

		// 第二次排出
		dc.bufferedAmount = 0;
		dc.__fireDcEvent('bufferedamountlow');

		await Promise.all([p1, p2]);
		expect(results).toEqual([1, 2]);
		expect(dc.sent).toHaveLength(2);
		rtc.close();
	});

	test('队列非空时新消息追加到队尾（不绕过队列）', async () => {
		const { rtc, dc } = await makeReady();
		dc.bufferedAmount = HIGH;

		const results = [];
		const p1 = rtc.send({ seq: 1 }).then(() => results.push(1));

		// 即使 bufferedAmount 降低了，只要队列非空新消息也应排队
		dc.bufferedAmount = 0;
		const p2 = rtc.send({ seq: 2 }).then(() => results.push(2));

		// 触发排出
		dc.__fireDcEvent('bufferedamountlow');

		await Promise.all([p1, p2]);
		expect(results).toEqual([1, 2]);
		rtc.close();
	});

	test('DC close 时 reject 队列中所有消息并 reject pending RPC', async () => {
		const { rtc, dc, clawConn } = await makeReady();
		dc.bufferedAmount = HIGH;

		const p1 = rtc.send({ seq: 1 });
		const p2 = rtc.send({ seq: 2 });

		dc.readyState = 'closed';
		dc.onclose();

		await expect(p1).rejects.toThrow('DataChannel closed');
		await expect(p2).rejects.toThrow('DataChannel closed');
		expect(clawConn.__rejectAllPending).toHaveBeenCalledWith('DataChannel closed', 'DC_CLOSED');
	});

	test('close() 时 reject 队列中所有消息', async () => {
		const { rtc, dc } = await makeReady();
		dc.bufferedAmount = HIGH;

		const p1 = rtc.send({ seq: 1 });
		const p2 = rtc.send({ seq: 2 });

		rtc.close();

		await expect(p1).rejects.toThrow('connection closed');
		await expect(p2).rejects.toThrow('connection closed');
	});

	test('快路径 dc.send() 抛异常时 reject 而非未捕获异常', async () => {
		const { rtc, dc } = await makeReady();
		dc.bufferedAmount = 0;
		dc.send = () => { throw new Error('mock send error'); };

		await expect(rtc.send({ msg: 'boom' })).rejects.toThrow('mock send error');
	});

	test('排出时 dc.send() 抛异常：当前消息 reject 且剩余队列全部 reject', async () => {
		const { rtc, dc } = await makeReady();
		dc.bufferedAmount = HIGH;

		const p1 = rtc.send({ seq: 1 });
		const p2 = rtc.send({ seq: 2 });
		const p3 = rtc.send({ seq: 3 });

		// 排出时第一条 send 就抛异常
		dc.send = () => { throw new Error('send exploded'); };
		dc.bufferedAmount = 0;
		dc.__fireDcEvent('bufferedamountlow');

		await expect(p1).rejects.toThrow('send exploded');
		await expect(p2).rejects.toThrow('DataChannel send failed');
		await expect(p3).rejects.toThrow('DataChannel send failed');
	});

	test('排出时 DC 已关闭 → reject 队列', async () => {
		const { rtc, dc } = await makeReady();
		dc.bufferedAmount = 1024 * 1024; // HIGH

		const p1 = rtc.send({ seq: 1 });
		const p2 = rtc.send({ seq: 2 });

		// 在触发 drain 前将 dc 标记为 closed
		dc.readyState = 'closed';
		dc.bufferedAmount = 0;
		dc.__fireDcEvent('bufferedamountlow');

		await expect(p1).rejects.toThrow('DataChannel closed');
		await expect(p2).rejects.toThrow('DataChannel closed');
	});

	test('setupDataChannelEvents 设置 bufferedAmountLowThreshold', async () => {
		const { dc } = await makeReady();
		expect(dc.bufferedAmountLowThreshold).toBe(256 * 1024); // DC_LOW_WATER_MARK
	});
});

describe('initRtc — RTC 建连', () => {
	beforeEach(() => {
		pcInstances.length = 0;
		MockRTCPeerConnection.lastInstance = null;
		__resetRtcInstances();
		vi.useFakeTimers();
	});
	afterEach(() => {
		__resetRtcInstances();
		vi.useRealTimers();
	});

	test('DataChannel 在超时内 open → resolve rtc', async () => {
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockResolvedValue({ data: MOCK_TURN_CREDS });

		const clawConn = createMockBotConn();

		try {
			const p = initRtc('bot1', clawConn);
			await vi.advanceTimersByTimeAsync(0);

			const dc = MockRTCPeerConnection.lastInstance.__channels[0];
			dc.readyState = 'open';
			dc.onopen();
			const result = await p;

			expect(result).toBe('rtc');
			expect(clawConn.setRtc).toHaveBeenCalled();
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});

	test('超时后 resolve failed', async () => {
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockResolvedValue({ data: MOCK_TURN_CREDS });

		const clawConn = createMockBotConn();

		try {
			const p = initRtc('bot2', clawConn);
			await vi.advanceTimersByTimeAsync(0);

			await vi.advanceTimersByTimeAsync(15_000);
			const result = await p;

			expect(result).toBe('failed');
			expect(clawConn.clearRtc).toHaveBeenCalled();
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});

	test('TURN 请求失败时 resolve failed', async () => {
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockRejectedValue(new Error('network error'));

		const clawConn = createMockBotConn();

		try {
			const p = initRtc('bot3', clawConn);
			await vi.advanceTimersByTimeAsync(0);
			const result = await p;

			expect(result).toBe('failed');
			expect(clawConn.clearRtc).toHaveBeenCalled();
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});

	test('connect 期间 rtc 被 close(asFailed) → resolve failed 且从 rtcInstances 移除', async () => {
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockResolvedValue({ data: MOCK_TURN_CREDS });

		const clawConn = createMockBotConn();

		try {
			const p = initRtc('bot4', clawConn);
			await vi.advanceTimersByTimeAsync(0);
			// connect 已发出 offer，此时手动触发失败（模拟 restart 超时等路径）
			const rtc = __getRtcInstance('bot4');
			expect(rtc).not.toBeUndefined();
			rtc.close({ asFailed: true });

			const result = await p;
			expect(result).toBe('failed');
			expect(clawConn.clearRtc).toHaveBeenCalled();
			// 关键：failed 分支应从 rtcInstances 删除，下次 initRtc 才能干净建连
			expect(__getRtcInstance('bot4')).toBeUndefined();
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});
});

// --- DC 应用层保活 ---

/** 辅助：建连 + PC connected + DC open，返回 { rtc, pc, dc } */
async function setupConnectedRtc(clawConn) {
	const conn = clawConn ?? createMockBotConn();
	const rtc = new WebRtcConnection('bot1', conn, { PeerConnection: MockRTCPeerConnection });
	await rtc.connect(MOCK_TURN_CREDS);
	const pc = MockRTCPeerConnection.lastInstance;
	const dc = pc.__channels[0];
	dc.readyState = 'open';
	pc.connectionState = 'connected';
	pc.onconnectionstatechange();
	dc.onopen();
	return { rtc, pc, dc };
}

describe('WebRtcConnection — DC 应用层保活', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	// --- 启动与停止 ---

	test('dc.onopen 时启动保活定时器', async () => {
		const { rtc } = await setupConnectedRtc();
		expect(rtc.__keepaliveTimer).not.toBeNull();
		expect(rtc.__keepaliveGen).toBe(1);
		rtc.close();
	});

	test('__startKeepalive 幂等：重复调用不创建多个定时器', async () => {
		const { rtc } = await setupConnectedRtc();
		const timer1 = rtc.__keepaliveTimer;
		rtc.__startKeepalive();
		expect(rtc.__keepaliveTimer).toBe(timer1);
		expect(rtc.__keepaliveGen).toBe(1); // 没有再次递增
		rtc.close();
	});

	test('close() 停止保活定时器并注销事件监听', async () => {
		const { rtc } = await setupConnectedRtc();
		expect(rtc.__keepaliveTimer).not.toBeNull();
		expect(rtc.__onAppBackground).not.toBeNull();

		rtc.close();

		expect(rtc.__keepaliveTimer).toBeNull();
		expect(rtc.__onAppBackground).toBeNull();
		expect(rtc.__onAppForeground).toBeNull();
	});

	test('close() 后无残留定时器（不泄漏）', async () => {
		const { rtc } = await setupConnectedRtc();
		rtc.close();
		// 推进大量时间，不应有任何回调触发
		const probeSpy = vi.spyOn(rtc, 'probe');
		await vi.advanceTimersByTimeAsync(120_000);
		expect(probeSpy).not.toHaveBeenCalled();
	});

	test('__stopKeepalive 重复调用安全（幂等）', async () => {
		const { rtc } = await setupConnectedRtc();
		rtc.__stopKeepalive();
		expect(rtc.__keepaliveTimer).toBeNull();
		// 再次调用不抛异常
		expect(() => rtc.__stopKeepalive()).not.toThrow();
		rtc.close();
	});

	// --- 正常保活周期 ---

	test('30s 后发送 probe，成功则调度下一次', async () => {
		const { rtc, dc } = await setupConnectedRtc();

		await vi.advanceTimersByTimeAsync(30_000);
		const probeSent = dc.sent.find(d => {
			try { return JSON.parse(d).type === 'probe'; } catch { return false; }
		});
		expect(probeSent).toBeTruthy();

		// 模拟 probe-ack
		dc.onmessage({ data: JSON.stringify({ type: 'probe-ack' }) });
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.__keepaliveTimer).not.toBeNull();
		rtc.close();
	});

	test('probe 成功后 30s 发送第二次 probe', async () => {
		const { rtc, dc } = await setupConnectedRtc();

		// 第一次
		await vi.advanceTimersByTimeAsync(30_000);
		dc.onmessage({ data: JSON.stringify({ type: 'probe-ack' }) });
		await vi.advanceTimersByTimeAsync(0);
		dc.sent.length = 0;

		// 第二次
		await vi.advanceTimersByTimeAsync(30_000);
		const probeSent = dc.sent.find(d => {
			try { return JSON.parse(d).type === 'probe'; } catch { return false; }
		});
		expect(probeSent).toBeTruthy();

		dc.onmessage({ data: JSON.stringify({ type: 'probe-ack' }) });
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__keepaliveTimer).not.toBeNull();

		rtc.close();
	});

	// --- probe 失败场景 ---

	test('probe 超时 + 无近期活动 → 触发 ICE restart 并记录 remoteLog', async () => {
		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		const { rtc } = await setupConnectedRtc();

		// 30s 间隔 + 20s 超时 = 50s，远超 30s 活动宽限
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(0);

		// 不再 close，而是触发 ICE restart
		expect(rtc.state).toBe('restarting');
		expect(remoteLog).toHaveBeenCalledWith(expect.stringContaining('dc.keepalive-failed'));
	});

	test('probe 超时 + state≠connected → 不 close', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		const closeSpy = vi.spyOn(rtc, 'close');

		await vi.advanceTimersByTimeAsync(30_000);

		// probe 超时前 ICE 进入 failed
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();

		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(0);

		expect(closeSpy).not.toHaveBeenCalled();
	});

	test('DC 已 null 且无近期活动 → 触发 ICE restart', async () => {
		const { rtc } = await setupConnectedRtc();

		rtc.__rpcChannel = null;

		// 30s 间隔后 probe 立即返回 false，且 50s 超过 30s 宽限
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.state).toBe('restarting');
	});

	// --- generation 机制 ---

	test('stop 后 stale 回调被 generation 拦截，不触发 close', async () => {
		const { rtc } = await setupConnectedRtc();
		const closeSpy = vi.spyOn(rtc, 'close');

		await vi.advanceTimersByTimeAsync(30_000);
		rtc.__stopKeepalive();

		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(0);

		expect(closeSpy).not.toHaveBeenCalled();
		rtc.close();
	});

	test('stop → start 快速切换，旧 probe 被忽略，新周期正常', async () => {
		const { rtc, dc } = await setupConnectedRtc();

		await vi.advanceTimersByTimeAsync(30_000); // 第一次 probe 发出

		rtc.__stopKeepalive(); // gen +1
		rtc.__startKeepalive(); // gen +1, 新 timer 在 T+30s

		// 旧 probe 超时
		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('connected'); // gen 不匹配，不 close

		// 推进到新 timer 触发（距离 start 30s），但不要超过 probe timeout
		dc.sent.length = 0;
		await vi.advanceTimersByTimeAsync(20_000); // 新 timer 触发，probe 发出
		await vi.advanceTimersByTimeAsync(0);

		const probeSent = dc.sent.find(d => {
			try { return JSON.parse(d).type === 'probe'; } catch { return false; }
		});
		expect(probeSent).toBeTruthy();

		// 立即 ack（在 probe timeout 之前）
		dc.onmessage({ data: JSON.stringify({ type: 'probe-ack' }) });
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__keepaliveTimer).not.toBeNull();

		rtc.close();
	});

	test('多次 stop/start 循环后 gen 正确递增', async () => {
		const { rtc, dc } = await setupConnectedRtc();
		const initialGen = rtc.__keepaliveGen;

		for (let i = 0; i < 5; i++) {
			rtc.__stopKeepalive();
			rtc.__startKeepalive();
		}
		// 每次 stop +1, start +1 → 共 +10
		expect(rtc.__keepaliveGen).toBe(initialGen + 10);

		// 最后一次 start 的保活应正常工作
		await vi.advanceTimersByTimeAsync(30_000);
		dc.onmessage({ data: JSON.stringify({ type: 'probe-ack' }) });
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__keepaliveTimer).not.toBeNull();

		rtc.close();
	});

	// --- Capacitor app 前后台事件 ---

	test('app:background 停止保活', async () => {
		const { rtc } = await setupConnectedRtc();
		expect(rtc.__keepaliveTimer).not.toBeNull();

		window.dispatchEvent(new Event('app:background'));

		expect(rtc.__keepaliveTimer).toBeNull();
		rtc.close();
	});

	test('app:foreground + DC 可用 → 重启保活', async () => {
		const { rtc } = await setupConnectedRtc();

		window.dispatchEvent(new Event('app:background'));
		expect(rtc.__keepaliveTimer).toBeNull();

		window.dispatchEvent(new Event('app:foreground'));
		expect(rtc.__keepaliveTimer).not.toBeNull();

		rtc.close();
	});

	test('app:foreground + state≠connected → 不启动保活', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		window.dispatchEvent(new Event('app:background'));

		// __onIceFailed → restarting（同步），keepalive 已停止
		// foreground handler 仍注册，但检查 state !== 'connected' → 不启动
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		expect(rtc.state).toBe('restarting');

		window.dispatchEvent(new Event('app:foreground'));
		expect(rtc.__keepaliveTimer).toBeNull();

		rtc.close();
	});

	test('app:foreground + DC 未 open → 不启动保活', async () => {
		const { rtc, dc } = await setupConnectedRtc();

		window.dispatchEvent(new Event('app:background'));
		dc.readyState = 'closed';

		window.dispatchEvent(new Event('app:foreground'));
		expect(rtc.__keepaliveTimer).toBeNull();

		rtc.close();
	});

	test('app:background → app:foreground 快速切换，旧 probe 被忽略', async () => {
		const { rtc } = await setupConnectedRtc();
		const closeSpy = vi.spyOn(rtc, 'close');

		await vi.advanceTimersByTimeAsync(30_000);

		window.dispatchEvent(new Event('app:background'));
		window.dispatchEvent(new Event('app:foreground'));

		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(0);

		expect(closeSpy).not.toHaveBeenCalled();
		expect(rtc.state).toBe('connected');
		rtc.close();
	});

	test('close() 后 app 事件不触发保活', async () => {
		const { rtc } = await setupConnectedRtc();
		rtc.close();

		window.dispatchEvent(new Event('app:foreground'));
		expect(rtc.__keepaliveTimer).toBeNull();
	});

	test('__registerAppLifecycle 幂等', async () => {
		const { rtc } = await setupConnectedRtc();
		const bgHandler = rtc.__onAppBackground;
		rtc.__registerAppLifecycle();
		expect(rtc.__onAppBackground).toBe(bgHandler);
		rtc.close();
	});

	// --- 交互场景 ---

	test('外部 close() 在 doKeepalive await probe 期间 → 不双重 close', async () => {
		const { rtc } = await setupConnectedRtc();

		await vi.advanceTimersByTimeAsync(30_000);
		rtc.close();
		expect(rtc.state).toBe('closed');

		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('closed');
	});

	test('probe 成功但 state 已非 connected 时不再调度', async () => {
		const { rtc, dc, pc } = await setupConnectedRtc();

		await vi.advanceTimersByTimeAsync(30_000);

		// failed → __onIceFailed → restarting（同步）
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		expect(rtc.state).toBe('restarting');

		dc.onmessage({ data: JSON.stringify({ type: 'probe-ack' }) });
		await vi.advanceTimersByTimeAsync(0);

		// state='restarting'（非 connected），不应调度 keepalive 下一次
		// restart 有自己的周期重试定时器
		expect(rtc.__keepaliveTimer).toBeNull();
		rtc.close();
	});

	test('probe 成功但 DC 已关闭时不再调度', async () => {
		const { rtc, dc } = await setupConnectedRtc();

		await vi.advanceTimersByTimeAsync(30_000);
		dc.readyState = 'closed';
		dc.onmessage({ data: JSON.stringify({ type: 'probe-ack' }) });
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.__keepaliveTimer).toBeNull();
		rtc.close();
	});

	test('DC 在保活 probe 进行中被置 null → probe 超时后触发 ICE restart', async () => {
		const { rtc } = await setupConnectedRtc();

		// probe 发出
		await vi.advanceTimersByTimeAsync(30_000);
		// DC 在 probe 超时前被外部置 null（模拟 DC onclose 但 PC 仍 connected）
		rtc.__rpcChannel = null;

		// probe 超时
		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(0);

		// state 仍是 connected → 触发 ICE restart
		expect(rtc.state).toBe('restarting');
	});

	test('dc.onopen 在 close() 之后触发时被 staleness guard 拦截', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		const dc = pc.__channels[0];

		// 在 DC open 前关闭连接
		rtc.close();
		expect(rtc.__keepaliveTimer).toBeNull();

		// 模拟 DC open 事件延迟触发
		dc.readyState = 'open';
		dc.onopen();

		// staleness guard 应阻止保活启动
		expect(rtc.__keepaliveTimer).toBeNull();
		expect(rtc.__onAppBackground).toBeNull();
	});

	test('保活 probe 进行中时外部 probe() 调用复用同一 promise', async () => {
		const { rtc, dc } = await setupConnectedRtc();

		await vi.advanceTimersByTimeAsync(30_000);

		const externalProbe = rtc.probe(3_000);
		dc.onmessage({ data: JSON.stringify({ type: 'probe-ack' }) });
		const result = await externalProbe;
		expect(result).toBe(true);

		rtc.close();
	});
});

describe('WebRtcConnection — DC 保活活动宽限', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	// --- __lastDcActivityAt 初始化与更新 ---

	test('__lastDcActivityAt 初始为 0', () => {
		const rtc = new WebRtcConnection('bot1', createMockBotConn(), { PeerConnection: MockRTCPeerConnection });
		expect(rtc.__lastDcActivityAt).toBe(0);
		rtc.close();
	});

	test('dc.onopen 更新 __lastDcActivityAt', async () => {
		const { rtc } = await setupConnectedRtc();
		expect(rtc.__lastDcActivityAt).toBeGreaterThan(0);
		rtc.close();
	});

	test('rpc dc.onmessage 更新 __lastDcActivityAt', async () => {
		const { rtc, dc } = await setupConnectedRtc();
		const before = rtc.__lastDcActivityAt;

		await vi.advanceTimersByTimeAsync(1_000); // 推进时间让 Date.now() 变化
		dc.onmessage({ data: JSON.stringify({ type: 'res', id: 1, ok: true }) });

		expect(rtc.__lastDcActivityAt).toBeGreaterThan(before);
		rtc.close();
	});

	test('file DC onmessage 通过 addEventListener 更新 __lastDcActivityAt', async () => {
		const { rtc } = await setupConnectedRtc();
		const before = rtc.__lastDcActivityAt;

		const fileDc = rtc.createDataChannel('file:test-uuid', { ordered: true });
		expect(fileDc).not.toBeNull();

		await vi.advanceTimersByTimeAsync(1_000);
		// 触发 addEventListener 注册的 message handler
		fileDc.__fireDcEvent('message');

		expect(rtc.__lastDcActivityAt).toBeGreaterThan(before);
		rtc.close();
	});

	test('file DC bufferedamountlow 更新 __lastDcActivityAt（上传出向 liveness）', async () => {
		const { rtc } = await setupConnectedRtc();
		const before = rtc.__lastDcActivityAt;

		const fileDc = rtc.createDataChannel('file:upload-uuid', { ordered: true });
		expect(fileDc).not.toBeNull();

		await vi.advanceTimersByTimeAsync(1_000);
		// 触发 addEventListener 注册的 bufferedamountlow handler
		// BAL 表示出向 SCTP 真实进展，是上传场景下唯一的活动信号
		fileDc.__fireDcEvent('bufferedamountlow');

		expect(rtc.__lastDcActivityAt).toBeGreaterThan(before);
		rtc.close();
	});

	test('多个 file DC 都能更新 __lastDcActivityAt', async () => {
		const { rtc } = await setupConnectedRtc();

		const dc1 = rtc.createDataChannel('file:uuid-1', { ordered: true });
		const dc2 = rtc.createDataChannel('file:uuid-2', { ordered: true });

		await vi.advanceTimersByTimeAsync(1_000);
		dc1.__fireDcEvent('message');
		const ts1 = rtc.__lastDcActivityAt;

		await vi.advanceTimersByTimeAsync(1_000);
		dc2.__fireDcEvent('message');
		expect(rtc.__lastDcActivityAt).toBeGreaterThan(ts1);

		rtc.close();
	});

	test('createDataChannel 返回 null 时不报错（PC 不可用）', async () => {
		const { rtc } = await setupConnectedRtc();
		rtc.close();
		const dc = rtc.createDataChannel('file:test', { ordered: true });
		expect(dc).toBeNull();
	});

	// --- 宽限逻辑 ---

	test('probe 超时但有近期 file DC 活动 → 跳过 close，重新调度', async () => {
		const { rtc, dc } = await setupConnectedRtc();
		const closeSpy = vi.spyOn(rtc, 'close');

		const fileDc = rtc.createDataChannel('file:download', { ordered: true });

		// 推进到 probe 发出（30s）
		await vi.advanceTimersByTimeAsync(30_000);

		// 在 probe 超时前，file DC 有活动
		await vi.advanceTimersByTimeAsync(5_000); // T=35s
		fileDc.__fireDcEvent('message'); // 更新 __lastDcActivityAt

		// probe 超时（再过 5s）
		await vi.advanceTimersByTimeAsync(5_000); // T=40s, 10s timeout 到期
		await vi.advanceTimersByTimeAsync(0);

		// 活动在 5s 前 < 30s 宽限 → 不 close
		expect(closeSpy).not.toHaveBeenCalled();
		expect(rtc.state).toBe('connected');
		expect(rtc.__keepaliveTimer).not.toBeNull();

		rtc.close();
	});

	test('probe 超时但有近期 file DC bufferedamountlow → 跳过 close（上传场景）', async () => {
		const { rtc } = await setupConnectedRtc();
		const closeSpy = vi.spyOn(rtc, 'close');

		const fileDc = rtc.createDataChannel('file:upload', { ordered: true });

		// 推进到 probe 发出（30s）
		await vi.advanceTimersByTimeAsync(30_000);

		// 在 probe 超时前，file DC 出向 buffer 排空（上传时唯一的活动证据）
		await vi.advanceTimersByTimeAsync(5_000); // T=35s
		fileDc.__fireDcEvent('bufferedamountlow');

		// probe 超时（再过 5s）
		await vi.advanceTimersByTimeAsync(5_000); // T=40s
		await vi.advanceTimersByTimeAsync(0);

		// BAL 在 5s 前 < 20s 宽限 → 不 close
		expect(closeSpy).not.toHaveBeenCalled();
		expect(rtc.state).toBe('connected');
		expect(rtc.__keepaliveTimer).not.toBeNull();

		rtc.close();
	});

	test('probe 超时但有近期 rpc DC 活动 → 跳过 close', async () => {
		const { rtc, dc } = await setupConnectedRtc();
		const closeSpy = vi.spyOn(rtc, 'close');

		await vi.advanceTimersByTimeAsync(30_000);
		// rpc DC 有响应（非 probe-ack），在 probe 超时前
		await vi.advanceTimersByTimeAsync(5_000); // T=35s
		dc.onmessage({ data: JSON.stringify({ type: 'res', id: 1, ok: true }) });

		await vi.advanceTimersByTimeAsync(5_000); // probe 超时
		await vi.advanceTimersByTimeAsync(0);

		expect(closeSpy).not.toHaveBeenCalled();
		expect(rtc.__keepaliveTimer).not.toBeNull();

		rtc.close();
	});

	test('probe 超时 + 活动超出宽限期 → 触发 ICE restart', async () => {
		const { rtc } = await setupConnectedRtc();

		// dc.onopen 时设置了 __lastDcActivityAt
		// 30s 间隔 + 20s 超时 = 50s，远超 30s 宽限
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.state).toBe('restarting');
	});

	test('__lastDcActivityAt=0 时无宽限保护 → 触发 ICE restart', async () => {
		const { rtc } = await setupConnectedRtc();
		// 强制清零（模拟未初始化场景）
		rtc.__lastDcActivityAt = 0;

		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.state).toBe('restarting');
	});

	test('连续多次宽限跳过后活动停止 → 最终触发 ICE restart', async () => {
		const { rtc, dc } = await setupConnectedRtc();
		const fileDc = rtc.createDataChannel('file:big', { ordered: true });

		// 第一次 probe：有活动，跳过
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(5_000);
		fileDc.__fireDcEvent('message'); // 更新活动时间
		await vi.advanceTimersByTimeAsync(5_000); // probe 超时
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('connected');

		// 第二次 probe：仍有活动，跳过
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(5_000);
		fileDc.__fireDcEvent('message');
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('connected');

		// 第三次 probe：活动停止（不再 fire message）
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(0);
		// 距上次活动 30s+10s=40s > 30s 宽限 → ICE restart
		expect(rtc.state).toBe('restarting');
	});

	test('宽限跳过后 probe 成功 → 正常周期恢复', async () => {
		const { rtc, dc } = await setupConnectedRtc();
		const fileDc = rtc.createDataChannel('file:dl', { ordered: true });

		// 第一次 probe 超时，靠活动宽限跳过
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(5_000);
		fileDc.__fireDcEvent('message');
		await vi.advanceTimersByTimeAsync(5_000); // probe 超时
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('connected');

		// 第二次 probe 成功（拥塞已缓解）
		dc.sent.length = 0;
		await vi.advanceTimersByTimeAsync(30_000);
		dc.onmessage({ data: JSON.stringify({ type: 'probe-ack' }) });
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.state).toBe('connected');
		expect(rtc.__keepaliveTimer).not.toBeNull();

		rtc.close();
	});

	// --- close() 后 file DC 活动无副作用 ---

	test('close() 后 file DC onmessage 更新时间戳但无害', async () => {
		const { rtc } = await setupConnectedRtc();
		const fileDc = rtc.createDataChannel('file:test', { ordered: true });
		rtc.close();

		// file DC 仍触发 message（浏览器异步回调）
		expect(() => fileDc.__fireDcEvent('message')).not.toThrow();
		// __lastDcActivityAt 被更新但保活已停止，无影响
		expect(rtc.__keepaliveTimer).toBeNull();
	});
});

// --- ICE restart 测试 ---

describe('WebRtcConnection — ICE restart', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('restarting 时 connected → 清除 restart 状态，恢复 connected', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		// 触发 ICE failed → restarting
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartTimer).not.toBeNull();

		// ICE restart 成功 → connected
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		expect(rtc.state).toBe('connected');
		expect(rtc.__restartTimer).toBeNull();
		expect(rtc.__restartAttemptCount).toBe(0);

		rtc.close();
	});

	test('restarting 时 disconnected → 忽略（中间状态）', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');

		// disconnected 不应改变状态
		pc.connectionState = 'disconnected';
		pc.onconnectionstatechange();
		expect(rtc.state).toBe('restarting');

		rtc.close();
	});

	test('restarting 时 failed → 立即重试（不等 timer）', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartAttemptCount).toBe(1);
		mockSendSignaling.mockClear();

		// 再次 failed（ICE check 失败）��� 仍在 restarting
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartAttemptCount).toBe(2);
		expect(mockSendSignaling).toHaveBeenCalledWith(
			'bot1', 'rtc:offer',
			expect.objectContaining({ iceRestart: true }),
		);

		rtc.close();
	});

	test('rtc:restart-rejected → failed + 完整释放资源', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');

		// plugin 回复 restart-rejected
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:restart-rejected', payload: { reason: 'no_session' } });
		expect(rtc.state).toBe('failed');
		expect(rtc.__restartTimer).toBeNull();
		// 底层 PC 立即释放 + 向 plugin 发 rtc:closed 信令
		expect(pc.__closed).toBe(true);
		expect(rtc.__pc).toBeNull();
		expect(rtc.__rpcChannel).toBeNull();
		expect(rtc.__keepaliveTimer).toBeNull();
		expect(mockSendSignaling).toHaveBeenCalledWith('bot1', 'rtc:closed');

		rtc.close();
	});

	test('restarting 时 DC 关闭 → SCTP 丢失 → failed + 完整释放资源', async () => {
		const { rtc, pc, dc } = await setupConnectedRtc();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');

		// DC 关闭（SCTP 断裂）
		dc.readyState = 'closed';
		dc.onclose();
		expect(rtc.state).toBe('failed');
		expect(rtc.__restartTimer).toBeNull();
		expect(pc.__closed).toBe(true);
		expect(rtc.__pc).toBeNull();
		expect(rtc.__rpcChannel).toBeNull();
		expect(mockSendSignaling).toHaveBeenCalledWith('bot1', 'rtc:closed');

		rtc.close();
	});

	test('createDataChannel 在 restarting 时返回 null', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');

		const dc = rtc.createDataChannel('file:test');
		expect(dc).toBeNull();

		rtc.close();
	});

	test('nudgeRestart：仅 restarting 时生效', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		mockSendSignaling.mockClear();

		// connected → nudge 无效
		rtc.nudgeRestart();
		expect(mockSendSignaling).not.toHaveBeenCalled();

		// 进入 restarting
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		mockSendSignaling.mockClear();

		// restarting → nudge 发送新 offer
		rtc.nudgeRestart();
		await vi.advanceTimersByTimeAsync(0);
		expect(mockSendSignaling).toHaveBeenCalledWith(
			'bot1', 'rtc:offer',
			expect.objectContaining({ iceRestart: true }),
		);

		rtc.close();
	});

	test('triggerRestart：从 connected 主动发起', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		mockSendSignaling.mockClear();

		rtc.triggerRestart('network_type_changed');
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.state).toBe('restarting');
		expect(mockSendSignaling).toHaveBeenCalledWith(
			'bot1', 'rtc:offer',
			expect.objectContaining({ iceRestart: true }),
		);

		rtc.close();
	});

	test('时间预算耗尽 → failed + 完整释放资源', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartAttemptCount).toBe(1);
		expect(rtc.__restartStartTime).toBeGreaterThan(0);

		// 推进时间到预算耗尽（90s）
		await vi.advanceTimersByTimeAsync(90_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('failed');
		expect(rtc.__restartAttemptCount).toBe(0);
		expect(rtc.__restartStartTime).toBe(0);
		expect(pc.__closed).toBe(true);
		expect(rtc.__pc).toBeNull();
		expect(rtc.__rpcChannel).toBeNull();
		expect(mockSendSignaling).toHaveBeenCalledWith('bot1', 'rtc:closed');

		rtc.close();
	});

	test('信令 WS 未连接 → 等待 ensureConnected 后发送 offer', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		mockSigState = 'disconnected';
		mockSendSignaling.mockClear();
		mockEnsureConnected.mockClear();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.state).toBe('restarting');
		expect(mockEnsureConnected).toHaveBeenCalledTimes(1);
		// ensureConnected mock 立即 resolve → offer 已发送
		expect(mockSendSignaling).toHaveBeenCalledWith(
			'bot1', 'rtc:offer',
			expect.objectContaining({ iceRestart: true }),
		);
		expect(rtc.__restartAttemptCount).toBe(1);

		rtc.close();
	});

	test('信令 WS 未连接 + ensureConnected 超时 → 不发送 offer，保持 restarting', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		mockSigState = 'disconnected';
		mockSendSignaling.mockClear();
		mockEnsureConnected.mockClear();
		mockEnsureConnected.mockRejectedValueOnce(new Error('ensureConnected timeout'));

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.state).toBe('restarting');
		expect(mockEnsureConnected).toHaveBeenCalledTimes(1);
		expect(mockSendSignaling).not.toHaveBeenCalled();
		expect(rtc.__restartAttemptCount).toBe(0);
		// restart 定时器仍在运行，后续周期重试可恢复
		expect(rtc.__restartTimer).not.toBeNull();

		rtc.close();
	});

	test('ensureConnected 等待期间 close() → 不发送 offer', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		mockSigState = 'disconnected';
		let resolveEnsure;
		mockEnsureConnected.mockImplementation(() => new Promise(r => { resolveEnsure = r; }));
		mockSendSignaling.mockClear();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.state).toBe('restarting');
		// ensureConnected 仍挂起，此时 close
		rtc.close();
		resolveEnsure();
		await vi.advanceTimersByTimeAsync(0);

		// close() 会发送 rtc:closed，但不应发送 rtc:offer
		const offerCalls = mockSendSignaling.mock.calls.filter(c => c[1] === 'rtc:offer');
		expect(offerCalls).toHaveLength(0);
		expect(rtc.state).toBe('closed');
	});

	test('ensureConnected 等待期间 restart 已由其他路径恢复 → 不重复发送 offer', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		mockSigState = 'disconnected';
		let resolveEnsure;
		mockEnsureConnected.mockImplementation(() => new Promise(r => { resolveEnsure = r; }));
		mockSendSignaling.mockClear();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');

		// 模拟 ICE 自行恢复
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		expect(rtc.state).toBe('connected');

		// ensureConnected resolve 后，post-await guard 应拦截
		mockSendSignaling.mockClear();
		resolveEnsure();
		await vi.advanceTimersByTimeAsync(0);

		const offerCalls = mockSendSignaling.mock.calls.filter(c => c[1] === 'rtc:offer');
		expect(offerCalls).toHaveLength(0);
	});

	test('多个并发 __attemptRestart 等待 ensureConnected → 仅发送一次 offer', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		mockSigState = 'disconnected';
		let resolveEnsure;
		// 所有调用共享同一个 pending promise
		const sharedPromise = new Promise(r => { resolveEnsure = r; });
		mockEnsureConnected.mockReturnValue(sharedPromise);
		mockSendSignaling.mockClear();

		// 进入 restarting
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');

		// 第二次 nudge（模拟 periodic 或 network:online 再次触发）
		rtc.nudgeRestart();
		await vi.advanceTimersByTimeAsync(0);

		// resolve：两个挂起的 __attemptRestart 同时恢复
		resolveEnsure();
		await vi.advanceTimersByTimeAsync(0);

		// __restartInFlight 确保只有一个发出 offer
		const offerCalls = mockSendSignaling.mock.calls
			.filter(c => c[1] === 'rtc:offer');
		expect(offerCalls).toHaveLength(1);
		expect(rtc.__restartAttemptCount).toBe(1);

		rtc.close();
	});

	test('安全网定时器每 30s 重发 offer', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		mockSendSignaling.mockClear();

		// 30s 后安全网重试
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(mockSendSignaling).toHaveBeenCalledWith(
			'bot1', 'rtc:offer',
			expect.objectContaining({ iceRestart: true }),
		);

		rtc.close();
	});

	test('close() 清除 restart 状态', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartTimer).not.toBeNull();

		rtc.close();
		expect(rtc.__restartTimer).toBeNull();
		expect(rtc.__restartAttemptCount).toBe(0);
	});

	test('app:background 停止 restart 定时器', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartTimer).not.toBeNull();

		// 模拟进入后台
		window.dispatchEvent(new Event('app:background'));
		expect(rtc.__restartTimer).toBeNull();
		// 仍在 restarting（不改变状态，等前台 nudge）
		expect(rtc.state).toBe('restarting');

		rtc.close();
	});

	test('restarting 时 keepalive 跳过 probe', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');

		// 手动启动 keepalive（不应该在 restarting 时启动，但测试防御性）
		rtc.__keepaliveGen = 99;
		const probeSpy = vi.spyOn(rtc, 'probe');
		await rtc.__doKeepalive(99);
		expect(probeSpy).not.toHaveBeenCalled();

		rtc.close();
	});

	test('createOffer await 期间 state 已 failed → catch 守卫生效，不重复 close', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		// createOffer 阻塞，模拟底层延迟
		let rejectOffer;
		pc.createOffer = () => new Promise((_, reject) => { rejectOffer = reject; });

		// 进入 restarting
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartInFlight).toBe(true);

		// 并发：plugin 先回 rtc:restart-rejected → 内部调 close({asFailed:true})
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:restart-rejected', payload: { reason: 'no_session' } });
		expect(rtc.state).toBe('failed');
		mockSendSignaling.mockClear();

		// createOffer 终于 reject → catch 守卫检测到 state==='failed' 直接 return
		rejectOffer(new Error('PC destroyed'));
		await vi.advanceTimersByTimeAsync(0);

		// 守卫生效：state 保持 failed 不被误改为 closed、不重发 rtc:closed 信令
		expect(rtc.state).toBe('failed');
		const closedCalls = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:closed');
		expect(closedCalls).toHaveLength(0);
		// finally 仍正常复位
		expect(rtc.__restartInFlight).toBe(false);
	});

	test('createOffer 抛异常 → 清除 restart 状态，变为 failed + 完整释放资源', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		// 让 createOffer 抛异常
		pc.createOffer = async () => { throw new Error('PC in invalid state'); };

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);

		// createOffer 失败 → 直接 failed
		expect(rtc.state).toBe('failed');
		expect(rtc.__restartTimer).toBeNull();
		expect(rtc.__restartAttemptCount).toBe(0);
		expect(pc.__closed).toBe(true);
		expect(rtc.__pc).toBeNull();
		expect(rtc.__rpcChannel).toBeNull();
		expect(mockSendSignaling).toHaveBeenCalledWith('bot1', 'rtc:closed');

		rtc.close();
	});

	test('ICE restart 成功后 keepalive 重新启动', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		// 进入 restarting
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		expect(rtc.__keepaliveTimer).toBeNull();

		// restart 成功
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		expect(rtc.state).toBe('connected');
		// keepalive 应已重启
		expect(rtc.__keepaliveTimer).not.toBeNull();

		rtc.close();
	});

	test('background→foreground 后 restart 定时器恢复', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartTimer).not.toBeNull();

		// 后台 → 停止 timer
		window.dispatchEvent(new Event('app:background'));
		expect(rtc.__restartTimer).toBeNull();

		// nudge（模拟 store 前台恢复调用）→ 应恢复 timer
		rtc.nudgeRestart();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartTimer).not.toBeNull();

		rtc.close();
	});

	test('connectionState=closed during restarting → 清除 restart 状态并变为 closed', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		// 进入 restarting
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartTimer).not.toBeNull();

		// PC 异常关闭（如浏览器回收）
		pc.connectionState = 'closed';
		pc.onconnectionstatechange();
		expect(rtc.state).toBe('closed');
		expect(rtc.__restartTimer).toBeNull();
		expect(rtc.__restartAttemptCount).toBe(0);
	});

	test('close() 后 triggerRestart/nudgeRestart 无效', async () => {
		const { rtc } = await setupConnectedRtc();
		rtc.close();
		expect(rtc.state).toBe('closed');

		mockSendSignaling.mockClear();

		// 关闭后尝试 restart 操作 → 不产生副作用
		rtc.triggerRestart('test');
		expect(rtc.state).toBe('closed');

		rtc.nudgeRestart();
		expect(rtc.state).toBe('closed');
		expect(mockSendSignaling).not.toHaveBeenCalled();
	});

	test('__attemptRestart 重置候选缓冲（__remoteDescSet / __pendingCandidates）', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		// 模拟已收到 answer → __remoteDescSet 为 true
		rtc.__remoteDescSet = true;
		rtc.__pendingCandidates = [{ candidate: 'old' }];

		// 进入 restarting → 候选缓冲被重置
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		expect(rtc.__remoteDescSet).toBe(false);
		expect(rtc.__pendingCandidates).toEqual([]);

		rtc.close();
	});

	test('__restartInFlight 防止并发 createOffer', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		// 进入 restarting
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		mockSendSignaling.mockClear();

		// 模拟 createOffer 阻塞
		let resolveOffer;
		pc.createOffer = () => new Promise((r) => { resolveOffer = r; });

		// 触发一次 restart（阻塞在 createOffer）
		rtc.nudgeRestart();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartInFlight).toBe(true);

		// 再次触发 → 应被 inFlight 防护跳过
		rtc.nudgeRestart();
		await vi.advanceTimersByTimeAsync(0);
		// createOffer 仅被调用一次（第二次被跳过）
		expect(mockSendSignaling).not.toHaveBeenCalled(); // 阻塞中，尚未 send

		// 释放 createOffer → 完成发送
		resolveOffer({ sdp: 'restart-sdp', type: 'offer' });
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartInFlight).toBe(false);
		expect(mockSendSignaling).toHaveBeenCalledTimes(1);

		rtc.close();
	});

	test('close() 期间 createOffer → 不覆盖 closed 状态', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		// 进入 restarting
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');

		// 模拟 createOffer 阻塞
		let resolveOffer;
		pc.createOffer = () => new Promise((r) => { resolveOffer = r; });

		// 触发 restart（阻塞在 createOffer）
		rtc.nudgeRestart();
		await vi.advanceTimersByTimeAsync(0);

		// 阻塞期间 close()
		rtc.close();
		expect(rtc.state).toBe('closed');

		// 释放 createOffer → bail out，不应变为 failed
		resolveOffer({ sdp: 'restart-sdp', type: 'offer' });
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('closed'); // 保持 closed，不变为 failed
	});

	// --- credRemain 诊断字段 ---

	test('ICE restart offer 日志带 credRemain（凭证有效）', async () => {
		const { remoteLog } = await import('./remote-log.js');
		// 控制"现在"为 expireAt - 3600s，credRemain 应为约 3600
		const now = 1_000_000_000;
		const expireAt = now + 3600;
		vi.setSystemTime(now * 1000);
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect({ ...MOCK_TURN_CREDS, username: `${expireAt}:42` });
		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		remoteLog.mockClear();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);

		const calls = remoteLog.mock.calls.map((c) => c[0]);
		const restartLog = calls.find((s) => /ICE restart offer sent/.test(s));
		expect(restartLog).toBeDefined();
		expect(restartLog).toMatch(/credRemain=3600\b/);

		rtc.close();
	});

	test('ICE restart offer 日志 credRemain 为负（凭证已过期）', async () => {
		const { remoteLog } = await import('./remote-log.js');
		const now = 1_000_000_000;
		const expireAt = now - 60;
		vi.setSystemTime(now * 1000);
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect({ ...MOCK_TURN_CREDS, username: `${expireAt}:42` });
		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		remoteLog.mockClear();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);

		const calls = remoteLog.mock.calls.map((c) => c[0]);
		const restartLog = calls.find((s) => /ICE restart offer sent/.test(s));
		expect(restartLog).toBeDefined();
		expect(restartLog).toMatch(/credRemain=-60\b/);

		rtc.close();
	});

	test('ICE restart offer 日志 credRemain=none（无 turnCreds）', async () => {
		const { remoteLog } = await import('./remote-log.js');
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(null);
		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		remoteLog.mockClear();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);

		const calls = remoteLog.mock.calls.map((c) => c[0]);
		const restartLog = calls.find((s) => /ICE restart offer sent/.test(s));
		expect(restartLog).toBeDefined();
		expect(restartLog).toMatch(/credRemain=none\b/);

		rtc.close();
	});
});

describe('WebRtcConnection — parseCredExpireAt', () => {
	test('解析有效 username（"<timestamp>:<userId>"）', () => {
		expect(parseCredExpireAt('1700000000:42')).toBe(1700000000);
	});

	test('username 缺冒号 → 取整段，仍可解析时返回数字', () => {
		expect(parseCredExpireAt('1700000000')).toBe(1700000000);
	});

	test('非数字时间戳 → null', () => {
		expect(parseCredExpireAt('malformed:42')).toBeNull();
	});

	test('非字符串输入 → null', () => {
		expect(parseCredExpireAt(undefined)).toBeNull();
		expect(parseCredExpireAt(null)).toBeNull();
		expect(parseCredExpireAt(123)).toBeNull();
	});
});

describe('WebRtcConnection — 失败路径资源清理', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('close({asFailed:true}) 后再调 close() 幂等：不重发 rtc:closed、不重关 pc', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		// 进入 restarting 并耗尽预算 → 首次 close({asFailed:true})
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(90_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('failed');

		const closedCalls = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:closed');
		expect(closedCalls).toHaveLength(1);
		expect(pc.__closeCallCount).toBe(1);

		// 二次 close（模拟 __ensureRtc 退避后 closeRtcForClaw → rtc.close()）
		rtc.close();
		expect(rtc.state).toBe('closed');

		// 信令不应重发、pc.close 不应再被调
		const closedCallsAfter = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:closed');
		expect(closedCallsAfter).toHaveLength(1);
		expect(pc.__closeCallCount).toBe(1);
	});

	test('失败路径触发 onStateChange 回调值为 "failed"（store 据此决定 rebuild）', async () => {
		const clawConn = createMockBotConn();
		const { rtc, pc } = await setupConnectedRtc(clawConn);

		const stateChanges = [];
		rtc.onStateChange = () => stateChanges.push(rtc.state);

		// 触发 restart 时间预算耗尽
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(90_000);
		await vi.advanceTimersByTimeAsync(0);

		// 末尾状态应为 'failed'，不是 'closed'
		expect(stateChanges.at(-1)).toBe('failed');

		rtc.close();
	});

	test('close() 不带参数默认进入 closed（向后兼容）', async () => {
		const { rtc } = await setupConnectedRtc();
		rtc.close();
		expect(rtc.state).toBe('closed');
	});
});

// 读 remoteLog mock，避免每个测试都重复一遍
async function getRemoteLogCalls() {
	const mod = await import('./remote-log.js');
	return mod.remoteLog.mock.calls.map((args) => args[0]);
}

describe('WebRtcConnection — 诊断日志补全', () => {
	beforeEach(() => {
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});

	test('oniceconnectionstatechange → rtc.info claw=X iceState: <state>', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;

		pc.iceConnectionState = 'checking';
		pc.oniceconnectionstatechange();
		pc.iceConnectionState = 'connected';
		pc.oniceconnectionstatechange();

		const calls = await getRemoteLogCalls();
		const iceLogs = calls.filter((s) => /iceState:/.test(s));
		expect(iceLogs.length).toBeGreaterThanOrEqual(2);
		expect(iceLogs.some((s) => s.includes('iceState: checking'))).toBe(true);
		expect(iceLogs.some((s) => s.includes('iceState: connected'))).toBe(true);

		rtc.close();
	});

	test('oniceconnectionstatechange 被替换 PC 回调时静默', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const firstPc = MockRTCPeerConnection.lastInstance;

		rtc.close();
		await rtc.connect(MOCK_TURN_CREDS);

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		firstPc.iceConnectionState = 'checking';
		firstPc.oniceconnectionstatechange();
		const iceLogs = (await getRemoteLogCalls()).filter((s) => /iceState:/.test(s));
		expect(iceLogs.length).toBe(0);

		rtc.close();
	});

	test('onicegatheringstatechange=gathering 重置候选计数器', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;

		// 先累积一些计数
		pc.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 999 1.2.3.4 5678 typ host', toJSON: () => ({}) } });
		pc.onicecandidate({ candidate: { candidate: 'candidate:2 1 udp 999 1.2.3.4 5678 typ relay', toJSON: () => ({}) } });
		expect(rtc.__iceCandCounts.host).toBe(1);
		expect(rtc.__iceCandCounts.relay).toBe(1);

		// gathering 重启应清零
		pc.iceGatheringState = 'gathering';
		pc.onicegatheringstatechange();
		expect(rtc.__iceCandCounts.host).toBe(0);
		expect(rtc.__iceCandCounts.relay).toBe(0);

		rtc.close();
	});

	test('onicegatheringstatechange=complete 不重置计数器', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;

		pc.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 999 1.2.3.4 5678 typ host', toJSON: () => ({}) } });
		pc.iceGatheringState = 'complete';
		pc.onicegatheringstatechange();
		expect(rtc.__iceCandCounts.host).toBe(1);

		rtc.close();
	});

	test('onsignalingstatechange 记录 rtc.info sigState: <state>', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;

		pc.signalingState = 'have-local-offer';
		pc.onsignalingstatechange();
		pc.signalingState = 'stable';
		pc.onsignalingstatechange();

		const logs = (await getRemoteLogCalls()).filter((s) => /sigState:/.test(s));
		expect(logs.some((s) => s.includes('sigState: have-local-offer'))).toBe(true);
		expect(logs.some((s) => s.includes('sigState: stable'))).toBe(true);

		rtc.close();
	});

	test('onsignalingstatechange 被替换 PC 时静默', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const firstPc = MockRTCPeerConnection.lastInstance;
		rtc.close();
		await rtc.connect(MOCK_TURN_CREDS);

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		firstPc.signalingState = 'stable';
		firstPc.onsignalingstatechange();
		expect((await getRemoteLogCalls()).filter((s) => /sigState:/.test(s))).toHaveLength(0);

		rtc.close();
	});

	test('onicegatheringstatechange 被替换 PC 时静默', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const firstPc = MockRTCPeerConnection.lastInstance;
		rtc.close();
		await rtc.connect(MOCK_TURN_CREDS);

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		firstPc.iceGatheringState = 'gathering';
		firstPc.onicegatheringstatechange();
		expect((await getRemoteLogCalls()).filter((s) => /iceGather:/.test(s))).toHaveLength(0);

		rtc.close();
	});

	test('onicecandidateerror 记录 rtc.warn iceCandErr 行', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;

		pc.onicecandidateerror({
			url: 'turn:example:3478',
			hostCandidate: '10.0.0.1',
			port: 54321,
			errorCode: 401,
			errorText: 'unauthorized',
		});
		const logs = (await getRemoteLogCalls()).filter((s) => /iceCandErr/.test(s));
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain('url=turn:example:3478');
		expect(logs[0]).toContain('host=10.0.0.1');
		expect(logs[0]).toContain('code=401');
		expect(logs[0]).toContain('text=unauthorized');

		rtc.close();
	});

	test('onicecandidateerror 全字段缺失 → 使用 "?" 占位不崩溃', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		pc.onicecandidateerror({});
		const logs = (await getRemoteLogCalls()).filter((s) => /iceCandErr/.test(s));
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain('url=?');
		expect(logs[0]).toContain('host=?');
		expect(logs[0]).toContain('code=?');

		rtc.close();
	});

	test('onicecandidateerror address fallback（hostCandidate 缺失但有 address）', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		pc.onicecandidateerror({ address: '10.0.0.5', errorCode: 500 });
		const logs = (await getRemoteLogCalls()).filter((s) => /iceCandErr/.test(s));
		expect(logs[0]).toContain('host=10.0.0.5');

		rtc.close();
	});

	test('onicecandidateerror 被替换 PC 时静默', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const firstPc = MockRTCPeerConnection.lastInstance;
		rtc.close();
		await rtc.connect(MOCK_TURN_CREDS);

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		firstPc.onicecandidateerror({ errorCode: 401 });
		expect((await getRemoteLogCalls()).filter((s) => /iceCandErr/.test(s))).toHaveLength(0);

		rtc.close();
	});

	test('candidate 按类型统计 + null candidate 输出 iceGathered 汇总', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;

		// 各类型各来一个
		pc.onicecandidate({ candidate: { candidate: 'candidate:a 1 udp 1 1.1.1.1 1 typ host', toJSON: () => ({}) } });
		pc.onicecandidate({ candidate: { candidate: 'candidate:b 1 udp 1 1.1.1.1 2 typ srflx raddr 2.2.2.2', toJSON: () => ({}) } });
		pc.onicecandidate({ candidate: { candidate: 'candidate:c 1 udp 1 3.3.3.3 3 typ relay', toJSON: () => ({}) } });
		pc.onicecandidate({ candidate: { candidate: 'candidate:d 1 udp 1 4.4.4.4 4 typ prflx', toJSON: () => ({}) } });
		// 未知类型不应抛
		pc.onicecandidate({ candidate: { candidate: 'candidate:e 1 udp 1 5.5.5.5 5 typ weird', toJSON: () => ({}) } });
		// null 触发汇总
		pc.onicecandidate({ candidate: null });

		const logs = await getRemoteLogCalls();
		const gathered = logs.find((s) => /iceGathered/.test(s));
		expect(gathered).toBeDefined();
		expect(gathered).toContain('host=1');
		expect(gathered).toContain('srflx=1');
		expect(gathered).toContain('relay=1');
		expect(gathered).toContain('prflx=1');

		rtc.close();
	});

	test('candidate 字符串缺 typ 匹配时不崩溃（只发信令不增计数）', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;

		pc.onicecandidate({ candidate: { candidate: 'candidate-no-typ', toJSON: () => ({}) } });
		expect(rtc.__iceCandCounts.host).toBe(0);
		expect(rtc.__iceCandCounts.srflx).toBe(0);

		rtc.close();
	});

	test('__attemptRestart 入口记录 restart.trigger 快照（含 dcIdleAgo）', async () => {
		vi.useFakeTimers();
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		const dc = pc.__channels[0];
		dc.readyState = 'open';
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		dc.onopen();
		// 模拟近期 DC 活动
		rtc.__lastDcActivityAt = Date.now() - 1234;

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();

		rtc.triggerRestart('unit-test');
		await vi.advanceTimersByTimeAsync(0);

		const logs = (await getRemoteLogCalls()).filter((s) => /restart\.trigger/.test(s));
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain('reason=unit-test');
		expect(logs[0]).toContain('connState=connected');
		expect(logs[0]).toMatch(/dcIdleAgo=\d+/);

		vi.useRealTimers();
		rtc.close();
	});

	test('__attemptRestart 再次调用（仍 restarting）不重复 restart.trigger', async () => {
		vi.useFakeTimers();
		const { rtc } = await setupConnectedRtc();

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		rtc.triggerRestart('first');
		await vi.advanceTimersByTimeAsync(0);
		rtc.nudgeRestart(); // 同一 epoch 内再进入
		await vi.advanceTimersByTimeAsync(0);

		const triggers = (await getRemoteLogCalls()).filter((s) => /restart\.trigger/.test(s));
		expect(triggers).toHaveLength(1);

		vi.useRealTimers();
		rtc.close();
	});

	test('__attemptRestart 入口 lastDcActivityAt=0 时记录 dcIdleAgo=never', async () => {
		vi.useFakeTimers();
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		const dc = pc.__channels[0];
		dc.readyState = 'open';
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		// 不触发 dc.onopen，保持 __lastDcActivityAt=0

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		rtc.triggerRestart('first');
		await vi.advanceTimersByTimeAsync(0);

		const triggers = (await getRemoteLogCalls()).filter((s) => /restart\.trigger/.test(s));
		expect(triggers[0]).toContain('dcIdleAgo=never');

		vi.useRealTimers();
		rtc.close();
	});

	test('__dumpStats 输出 stats.<reason> 格式，覆盖 pair/transport/data-channel', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		const report = new Map();
		report.set('cp1', {
			type: 'candidate-pair', nominated: true, state: 'succeeded',
			localCandidateId: 'l1', remoteCandidateId: 'r1',
			bytesSent: 100, bytesReceived: 200, currentRoundTripTime: 0.042,
			requestsSent: 3, responsesReceived: 3,
		});
		report.set('l1', { type: 'local-candidate', id: 'l1', candidateType: 'host', protocol: 'udp' });
		report.set('r1', { type: 'remote-candidate', id: 'r1', candidateType: 'prflx', protocol: 'udp' });
		report.set('tp', {
			type: 'transport', dtlsState: 'connected', iceState: 'connected',
			bytesSent: 1000, bytesReceived: 2000, selectedCandidatePairId: 'cp1',
		});
		report.set('dc1', {
			type: 'data-channel', label: 'rpc', state: 'open',
			messagesSent: 5, messagesReceived: 7, bytesSent: 500, bytesReceived: 700,
		});
		pc.__statsReport = report;

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		await rtc.__dumpStats('unit');
		const calls = await getRemoteLogCalls();
		const stats = calls.find((s) => /stats\.unit/.test(s));
		expect(stats).toBeDefined();
		expect(stats).toContain('pair=[host/udp>prflx/udp');
		expect(stats).toContain('nom=1');
		expect(stats).toContain('bs=100');
		expect(stats).toContain('rtt=0.042');
		expect(stats).toContain('dtls=connected');
		expect(stats).toContain('ice=connected');
		expect(stats).toContain('dc=[state=open');

		rtc.close();
	});

	test('__dumpStats 无 PC 时静默', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		await rtc.__dumpStats('no-pc');
		expect((await getRemoteLogCalls()).filter((s) => /stats\./.test(s))).toHaveLength(0);
	});

	test('__dumpStats getStats 不存在时静默', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		pc.getStats = undefined;
		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		await rtc.__dumpStats('no-getstats');
		expect((await getRemoteLogCalls()).filter((s) => /stats\./.test(s))).toHaveLength(0);

		rtc.close();
	});

	test('__dumpStats getStats 抛异常 → 记录 warn 行', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		pc.getStats = async () => { throw new Error('stats boom'); };

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		await rtc.__dumpStats('boom');
		const logs = await getRemoteLogCalls();
		const warn = logs.find((s) => /stats\.boom getStats failed/.test(s));
		expect(warn).toBeDefined();
		expect(warn).toContain('stats boom');

		rtc.close();
	});

	test('__dumpStats PC 已被替换时丢弃结果', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		let resolveStats;
		pc.getStats = () => new Promise((r) => { resolveStats = r; });

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		const p = rtc.__dumpStats('race');
		// 在 getStats 返回前替换 PC
		rtc.__pc = null;
		resolveStats(new Map());
		await p;
		expect((await getRemoteLogCalls()).filter((s) => /stats\.race/.test(s))).toHaveLength(0);
	});

	test('__dumpStats 无 pair/transport/dc 时输出 pair=none tp=none dc=[state=none]', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		pc.__statsReport = new Map();
		// 清掉 rpcChannel 引用
		rtc.__rpcChannel = null;

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		await rtc.__dumpStats('empty');
		const stats = (await getRemoteLogCalls()).find((s) => /stats\.empty/.test(s));
		expect(stats).toContain('pair=none');
		expect(stats).toContain('tp=none');
		expect(stats).toContain('dc=[state=none');

		rtc.close();
	});

	test('__dumpStats 使用 succeeded pair 作为回退（无 nominated）', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		const report = new Map();
		report.set('cp_x', { type: 'candidate-pair', nominated: false, state: 'succeeded', localCandidateId: 'lx', remoteCandidateId: 'rx' });
		report.set('lx', { type: 'local-candidate', id: 'lx', candidateType: 'srflx', protocol: 'udp' });
		report.set('rx', { type: 'remote-candidate', id: 'rx', candidateType: 'host', protocol: 'udp' });
		pc.__statsReport = report;

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		await rtc.__dumpStats('fallback');
		const stats = (await getRemoteLogCalls()).find((s) => /stats\.fallback/.test(s));
		expect(stats).toContain('pair=[srflx/udp>host/udp');
		expect(stats).toContain('nom=0');

		rtc.close();
	});

	test('rtc:answer 在 restarting 状态下 3s 后触发 post-answer stats dump', async () => {
		vi.useFakeTimers();
		const { rtc, pc } = await setupConnectedRtc();
		pc.__statsReport = new Map();

		// 进入 restarting
		rtc.triggerRestart('test');
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:answer', payload: { sdp: 'ans' } });
		// 等 setRemoteDescription
		await vi.advanceTimersByTimeAsync(0);
		// 未到 3s 不应有 post-answer
		await vi.advanceTimersByTimeAsync(2999);
		expect((await getRemoteLogCalls()).some((s) => /stats\.post-answer/.test(s))).toBe(false);
		// 3s 到期
		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(0);
		expect((await getRemoteLogCalls()).some((s) => /stats\.post-answer/.test(s))).toBe(true);

		vi.useRealTimers();
		rtc.close();
	});

	test('rtc:answer 非 restarting 时不触发 post-answer dump', async () => {
		vi.useFakeTimers();
		const { rtc, pc } = await setupConnectedRtc();
		pc.__statsReport = new Map();

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:answer', payload: { sdp: 'ans' } });
		await vi.advanceTimersByTimeAsync(5000);

		expect((await getRemoteLogCalls()).some((s) => /stats\.post-answer/.test(s))).toBe(false);

		vi.useRealTimers();
		rtc.close();
	});

	test('ICE restart 成功时 2s 后触发 post-restart-success stats dump', async () => {
		vi.useFakeTimers();
		const { rtc, pc } = await setupConnectedRtc();
		pc.__statsReport = new Map();

		rtc.triggerRestart('test');
		await vi.advanceTimersByTimeAsync(0);
		// 模拟 restart 成功 → onconnectionstatechange 再回 connected
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		await vi.advanceTimersByTimeAsync(2000);
		await vi.advanceTimersByTimeAsync(0);
		expect((await getRemoteLogCalls()).some((s) => /stats\.post-restart-success/.test(s))).toBe(true);

		vi.useRealTimers();
		rtc.close();
	});

	test('ICE restart 超时前输出 stats.restart-timeout', async () => {
		vi.useFakeTimers();
		const { rtc, pc } = await setupConnectedRtc();
		pc.__statsReport = new Map();

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();

		// triggerRestart → 第一次 attempt 快速超时：手动把 __restartStartTime 设为 91s 前
		rtc.triggerRestart('test');
		await vi.advanceTimersByTimeAsync(0);
		rtc.__restartStartTime = Date.now() - 91_000;
		rtc.nudgeRestart();
		await vi.advanceTimersByTimeAsync(0);

		const logs = await getRemoteLogCalls();
		expect(logs.some((s) => /stats\.restart-timeout/.test(s))).toBe(true);

		vi.useRealTimers();
		rtc.close();
	});

	test('post-restart-success 在 2s 内 PC 换掉时不发 stats（闭包守卫）', async () => {
		vi.useFakeTimers();
		const { rtc, pc } = await setupConnectedRtc();
		pc.__statsReport = new Map();

		rtc.triggerRestart('test');
		await vi.advanceTimersByTimeAsync(0);
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		// 中途替换 PC
		rtc.__pc = null;
		await vi.advanceTimersByTimeAsync(2500);
		expect((await getRemoteLogCalls()).some((s) => /stats\.post-restart-success/.test(s))).toBe(false);

		vi.useRealTimers();
	});

	test('plugin-probe 消息被 UI 回 ack 并打 echoed 日志', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		const dc = pc.__channels[0];
		dc.readyState = 'open';
		dc.sent.length = 0;

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		// 直接触发 onmessage 上的 JSON 字符串（reassembler 对 string 直接交付）
		dc.onmessage({ data: JSON.stringify({ type: 'plugin-probe', id: 42 }) });

		// 断言 ack 已发送
		expect(dc.sent).toHaveLength(1);
		const echoed = JSON.parse(dc.sent[0]);
		expect(echoed).toEqual({ type: 'plugin-probe-ack', id: 42 });
		// 断言日志行
		expect((await getRemoteLogCalls()).some((s) => /plugin-probe echoed id=42/.test(s))).toBe(true);
		// 断言不转发给业务层
		expect(clawConn.__onRtcMessage).not.toHaveBeenCalled();

		rtc.close();
	});

	test('plugin-probe 时 dc.send 抛异常 → warn 日志、不崩溃', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		const dc = pc.__channels[0];
		dc.readyState = 'open';
		dc.send = () => { throw new Error('dc closed'); };

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		dc.onmessage({ data: JSON.stringify({ type: 'plugin-probe', id: 7 }) });
		const logs = await getRemoteLogCalls();
		expect(logs.some((s) => /plugin-probe-ack send failed.*dc closed/.test(s))).toBe(true);

		rtc.close();
	});
});
