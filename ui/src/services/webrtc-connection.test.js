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
			// 规范默认值（与真实浏览器行为一致，用来验证代码显式覆盖为 'arraybuffer'）
			binaryType: 'blob',
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

	test('无 DC → 返回 false', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		// 未 connect，无 DC
		expect(await rtc.probe(100)).toBe(false);
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

	// __enqueueSendMulti 快路径中第 N 个 dc.send 同步抛错的契约锁：与"DC close 触发
	// __rejectSendQueue"路径不同——快路径 throw 时 chunks 还没入队，整体 promise 由
	// `return Promise.reject(err)` 直接 reject；__sendQueue 仍为空、__rpcChannel 不动。
	// 防止将来误改成"throw 后还入队"或"清队列"，把两条路径混淆
	test('快路径中第 N 个 dc.send 抛错 → 整体 promise reject 同一 error，队列保持空且 __rpcChannel 不动', async () => {
		const { rtc, dc } = await makeReady();
		const pc = MockRTCPeerConnection.lastInstance;
		pc.sctp = { maxMessageSize: 64 }; // 强制分片
		dc.bufferedAmount = 0; // 维持低水位让快路径 while 跑多轮

		// 让 dc.send 在第 2 次调用时抛错（前 1 次已成功，正中"partial throw"窗口）
		const sendErr = new Error('send failed');
		let sendCount = 0;
		dc.send = vi.fn(() => {
			sendCount++;
			if (sendCount === 2) throw sendErr;
		});

		const longStr = 'x'.repeat(500); // 跨 ≥ 3 chunk 的 payload
		const p = rtc.send({ method: 'big', payload: longStr });

		// 整体 reject 同一 error 实例
		await expect(p).rejects.toBe(sendErr);
		// 快路径 throw 后不入队
		expect(rtc.__sendQueue.length).toBe(0);
		// dc.send 调用次数严格等于失败时的 i+1=2（验证未继续后续 chunk）
		expect(dc.send).toHaveBeenCalledTimes(2);
		// __rpcChannel 不被置空（与 DC close 路径区分：close 才会清，throw 不会）
		expect(rtc.__rpcChannel).toBe(dc);

		rtc.close();
	});

	// 多 chunk 大消息发送中 DC 突然关：__enqueueSendMulti 把第 2..N 块入队后，
	// dc.onclose 同步触发 __rejectSendQueue('DataChannel closed') 把整个 promise reject。
	// 锁的是"分片消息整体作为一个 promise（看最后一片的 reject）跨 close 边界正确失败"
	// 的契约，不再让任何残留 chunk 在 rebuild 后被误发到新 DC。
	test('多 chunk 发送中 DC 关闭 → 整体 promise reject "DataChannel closed"，队列清空', async () => {
		const { rtc, dc } = await makeReady();
		// 强制分片：低 maxMessageSize 让 jsonStr 必须分片
		const pc = MockRTCPeerConnection.lastInstance;
		pc.sctp = { maxMessageSize: 64 };
		// 高水位入队全部尾部 chunk（首块走快路径同步发出，其余进队等 drain）
		const HIGH = 1024 * 1024;
		dc.bufferedAmount = HIGH;

		// 构造一个 jsonStr 跨 chunk 数 ≥ 3 的 payload
		const longStr = 'x'.repeat(500);
		const p = rtc.send({ method: 'big', payload: longStr });

		// 让微任务跑一遍，确认队列里至少有一项尾部 chunk 等 drain
		await Promise.resolve();
		expect(rtc.__sendQueue.length).toBeGreaterThan(0);

		// DC 关闭 → onclose 同步触发 __rejectSendQueue
		dc.readyState = 'closed';
		dc.onclose();

		await expect(p).rejects.toThrow('DataChannel closed');
		expect(rtc.__sendQueue.length).toBe(0);

		// dc.onclose 同步把 __rpcChannel 置空，后续 rebuild 不会拿到旧 chunk 残留
		expect(rtc.__rpcChannel).toBeNull();
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

	test('initRtc 把 callbacks.onRtcUnrecoverable 接入到 rtc 实例上', async () => {
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockResolvedValue({ data: MOCK_TURN_CREDS });

		const clawConn = createMockBotConn();
		const onRtcUnrecoverable = vi.fn();

		try {
			const p = initRtc('bot-wire', clawConn, { onRtcUnrecoverable });
			await vi.advanceTimersByTimeAsync(0);
			const rtc = __getRtcInstance('bot-wire');
			expect(rtc.onUnrecoverable).toBe(onRtcUnrecoverable);

			// 不传 callback 时应回退为 null（向后兼容）
			rtc.close();
			await p.catch(() => {});

			const clawConn2 = createMockBotConn();
			const p2 = initRtc('bot-wire2', clawConn2);
			await vi.advanceTimersByTimeAsync(0);
			const rtc2 = __getRtcInstance('bot-wire2');
			expect(rtc2.onUnrecoverable).toBeNull();
			rtc2.close();
			await p2.catch(() => {});
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

	test('fallbackTimer fire 后晚到的 TURN creds 不调 rtc.connect 也不创建 orphan PC', async () => {
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;
		const { httpClient } = await import('./http.js');
		// 手工 deferred：模拟 TURN creds HTTP 长时间未返回
		let resolveCreds;
		const credsPromise = new Promise((res) => { resolveCreds = res; });
		const mockGet = vi.spyOn(httpClient, 'get').mockReturnValue(credsPromise);

		const clawConn = createMockBotConn();

		try {
			const p = initRtc('bot-late-1', clawConn);
			// 推进到 fallbackTimer fire（默认 RTC_TRANSPORT_TIMEOUT_MS）
			await vi.advanceTimersByTimeAsync(15_000);
			const result = await p;
			expect(result).toBe('failed');
			expect(__getRtcInstance('bot-late-1')).toBeUndefined();
			// clearRtc 在 fallbackTimer 路径里至少被调一次（rtc.close() 触发 onStateChange
			// 也会触发 close 分支再清一次，是已有逻辑的重复保险，不影响晚到守卫的语义）
			const clearCntAfterTimer = clawConn.clearRtc.mock.calls.length;
			expect(clearCntAfterTimer).toBeGreaterThanOrEqual(1);
			// 此时还未触发任何 PC 创建：__channels 为空（因为 connect 未被调用）
			const pcCountBefore = pcInstances.length;
			expect(pcCountBefore).toBe(0);
			expect(mockSendSignaling).not.toHaveBeenCalledWith('bot-late-1', 'rtc:offer', expect.anything());

			// 现在让 TURN creds 晚到
			resolveCreds({ data: MOCK_TURN_CREDS });
			await vi.advanceTimersByTimeAsync(0);
			await Promise.resolve();

			// 关键：晚到的 creds 不应再调 rtc.connect，因此不会有新 PC、不会发 rtc:offer
			expect(pcInstances.length).toBe(0);
			expect(mockSendSignaling).not.toHaveBeenCalledWith('bot-late-1', 'rtc:offer', expect.anything());
			// 关键：clearRtc 调用次数没有再增加（晚到路径不再触发额外的 clear）
			expect(clawConn.clearRtc.mock.calls.length).toBe(clearCntAfterTimer);
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});

	test('外部 closeRtcForClaw 后晚到的 TURN creds 不调 rtc.connect', async () => {
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;
		const { httpClient } = await import('./http.js');
		let resolveCreds;
		const credsPromise = new Promise((res) => { resolveCreds = res; });
		const mockGet = vi.spyOn(httpClient, 'get').mockReturnValue(credsPromise);

		const clawConn = createMockBotConn();

		try {
			const p = initRtc('bot-late-2', clawConn);
			await vi.advanceTimersByTimeAsync(0);
			expect(__getRtcInstance('bot-late-2')).toBeTruthy();

			// 外部主动 close（如 logout / unbind 等路径）
			closeRtcForClaw('bot-late-2');
			expect(__getRtcInstance('bot-late-2')).toBeUndefined();

			const pcCountBefore = pcInstances.length;
			const sigCallsBefore = mockSendSignaling.mock.calls.length;

			// 让 TURN creds 晚到
			resolveCreds({ data: MOCK_TURN_CREDS });
			await vi.advanceTimersByTimeAsync(0);
			await Promise.resolve();

			// 没有新 PC、没有 rtc:offer 信令
			expect(pcInstances.length).toBe(pcCountBefore);
			expect(mockSendSignaling.mock.calls.length).toBe(sigCallsBefore);

			// p 仍可走到 fallbackTimer 路径或直接由 onStateChange 关闭路径 settle，
			// 这里推进时间确保 promise 不悬挂
			await vi.advanceTimersByTimeAsync(15_000);
			const result = await p;
			expect(result).toBe('failed');
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});

	test('TURN creds 在 fallbackTimer 之前正常 resolve 时仍调 rtc.connect 一次', async () => {
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockResolvedValue({ data: MOCK_TURN_CREDS });

		const clawConn = createMockBotConn();

		try {
			const p = initRtc('bot-happy', clawConn);
			await vi.advanceTimersByTimeAsync(0);
			// 守卫不破坏 happy path：connect 调用一次 → 创建一个 PC + 发出 rtc:offer
			expect(pcInstances.length).toBe(1);
			expect(mockSendSignaling).toHaveBeenCalledWith('bot-happy', 'rtc:offer', { sdp: 'mock-sdp-offer' });

			const dc = MockRTCPeerConnection.lastInstance.__channels[0];
			dc.readyState = 'open';
			dc.onopen();
			const result = await p;
			expect(result).toBe('rtc');
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

	// --- 前后台 disconnected timer 生命周期 ---

	test('app:background 清除已 arm 的 disconnected timer', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		// 前台先进入 disconnected → arm 5s timer
		pc.connectionState = 'disconnected';
		pc.onconnectionstatechange();
		expect(rtc.__disconnectedTimer).not.toBeNull();

		const failedSpy = vi.spyOn(rtc, '__onIceFailed');
		window.dispatchEvent(new Event('app:background'));
		expect(rtc.__disconnectedTimer).toBeNull();

		// 推 6s（超过原 5s 超时）不应触发升级
		await vi.advanceTimersByTimeAsync(6_000);
		expect(failedSpy).not.toHaveBeenCalled();

		rtc.close();
	});

	test('app:background 记录 __backgroundAt（PC 仍 connected 场景）', async () => {
		const { rtc } = await setupConnectedRtc();
		expect(rtc.__backgroundAt).toBe(0);

		window.dispatchEvent(new Event('app:background'));
		expect(rtc.__disconnectedTimer).toBeNull();
		expect(rtc.__backgroundAt).toBeGreaterThan(0);

		rtc.close();
	});

	test('短后台 < 25s 回前台 + PC disconnected → 5s 后升级', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		const failedSpy = vi.spyOn(rtc, '__onIceFailed');

		window.dispatchEvent(new Event('app:background'));
		await vi.advanceTimersByTimeAsync(10_000);
		// 模拟后台期间 PC 变 disconnected（事件未派发到 JS）
		pc.connectionState = 'disconnected';
		window.dispatchEvent(new Event('app:foreground'));

		expect(rtc.__disconnectedTimer).not.toBeNull();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(failedSpy).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2);
		expect(failedSpy).toHaveBeenCalledTimes(1);

		rtc.close();
	});

	test('长后台 ≥ 25s 回前台 + PC disconnected → 1.5s 后升级', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		const failedSpy = vi.spyOn(rtc, '__onIceFailed');

		window.dispatchEvent(new Event('app:background'));
		await vi.advanceTimersByTimeAsync(60_000);
		pc.connectionState = 'disconnected';
		window.dispatchEvent(new Event('app:foreground'));

		expect(rtc.__disconnectedTimer).not.toBeNull();
		await vi.advanceTimersByTimeAsync(1_499);
		expect(failedSpy).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2);
		expect(failedSpy).toHaveBeenCalledTimes(1);

		rtc.close();
	});

	test('后台 → 前台 PC disconnected 但 state=restarting → 不 arm timer（restart 进行中不干预）', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		window.dispatchEvent(new Event('app:background'));
		await vi.advanceTimersByTimeAsync(60_000);

		// 模拟 restart 进行中：state='restarting' + PC 层仍在 disconnected
		rtc.__state = 'restarting';
		pc.connectionState = 'disconnected';
		window.dispatchEvent(new Event('app:foreground'));

		expect(rtc.__disconnectedTimer).toBeNull();

		rtc.close();
	});

	test('后台 → 前台 PC 仍 connected → 不 arm disconnected timer，仅恢复 keepalive', async () => {
		const { rtc } = await setupConnectedRtc();

		window.dispatchEvent(new Event('app:background'));
		expect(rtc.__keepaliveTimer).toBeNull();
		await vi.advanceTimersByTimeAsync(50_000);

		// PC 仍 connected
		window.dispatchEvent(new Event('app:foreground'));
		expect(rtc.__disconnectedTimer).toBeNull();
		expect(rtc.__keepaliveTimer).not.toBeNull();
		expect(rtc.__backgroundAt).toBe(0);

		rtc.close();
	});

	test('后台 → 前台 但 __restartPaused=true → 不 re-arm disconnected timer / keepalive', async () => {
		// round 7 P2：pauseRestart 冻结期间（claw.offline / sig_offline 门控关）前后台切换
		// 不应偷偷绕过冻结重启 keepalive——否则 probe RPC 白发，破坏"门控关着时预算冻结"语义
		const { rtc, pc } = await setupConnectedRtc();

		// 门控路径：调 pauseRestart 冻结
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__keepaliveTimer).toBeNull();

		// 切后台（独立于 pauseRestart）
		window.dispatchEvent(new Event('app:background'));

		// 模拟后台期间 PC 层变 disconnected（connected 路径也要验证；两路分支见下一条）
		pc.connectionState = 'disconnected';

		// 切回前台：__restartPaused=true 让 handler 整体早退
		window.dispatchEvent(new Event('app:foreground'));

		// 断言：disconnected timer 不 arm、keepalive 不重启、__backgroundAt 仍被清零
		expect(rtc.__disconnectedTimer).toBeNull();
		expect(rtc.__keepaliveTimer).toBeNull();
		expect(rtc.__backgroundAt).toBe(0);

		rtc.close();
	});

	test('后台 → 前台 + __restartPaused=true + PC connected → 不重启 keepalive', async () => {
		// P2 补充：覆盖 pauseRestart 的典型路径（PC 保持 connected），防 foreground 重启 keepalive
		const { rtc } = await setupConnectedRtc();

		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);

		window.dispatchEvent(new Event('app:background'));
		await vi.advanceTimersByTimeAsync(50_000);
		window.dispatchEvent(new Event('app:foreground'));

		// PC 仍 connected 但因 paused → 不启动 keepalive
		expect(rtc.__keepaliveTimer).toBeNull();
		expect(rtc.__disconnectedTimer).toBeNull();

		rtc.close();
	});

	test('foreground 时 __backgroundAt=0 → 不报错且不 arm disconnected timer', async () => {
		const { rtc } = await setupConnectedRtc();
		expect(rtc.__backgroundAt).toBe(0);

		expect(() => window.dispatchEvent(new Event('app:foreground'))).not.toThrow();
		expect(rtc.__disconnectedTimer).toBeNull();
		expect(rtc.__backgroundAt).toBe(0);

		rtc.close();
	});

	test('close() 后 app:foreground 不触发动作（回归，防 __pc=null 空指针）', async () => {
		const { rtc } = await setupConnectedRtc();
		rtc.close();
		expect(rtc.state).toBe('closed');

		expect(() => window.dispatchEvent(new Event('app:foreground'))).not.toThrow();
		expect(rtc.__disconnectedTimer).toBeNull();
		expect(rtc.__keepaliveTimer).toBeNull();
		expect(rtc.state).toBe('closed');
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
		const { rtc } = await setupConnectedRtc();
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
		const { rtc } = await setupConnectedRtc();
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

	test('rtc:restart-rejected 迟到（已非 restarting 态）→ 忽略，不关闭 PC', async () => {
		// 模拟：旧 restart offer 发出 → UI 因其它路径已 rebuild 新 PC（新 PC 当前 connected）
		// 旧 reject 迟到到达时，connId 按 claw 复用 → 路由到新 WebRtcConnection
		// 若不校验 __state=='restarting' 会误杀新 PC
		const { rtc, pc } = await setupConnectedRtc();
		expect(rtc.state).toBe('connected');

		// 迟到的旧 reject 到达
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:restart-rejected', payload: { reason: 'no_session' } });

		// PC 仍然 connected，未被关闭
		expect(rtc.state).toBe('connected');
		expect(pc.__closed).toBe(false);
		expect(rtc.__pc).toBe(pc);
		// 未发 rtc:closed（未走 close 流程）
		expect(mockSendSignaling).not.toHaveBeenCalledWith('bot1', 'rtc:closed');

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

	test('connected 时 DC 意外关闭 → 也走 close(asFailed)，让 store 侧 dcReady 同步 false', async () => {
		// pre-existing 漏洞：旧代码只在 restarting 下处理，connected 时 __rpcChannel=null
		// 但 state 不变、onStateChange 不 fire → store.dcReady 脱钩（见 dcReady 语义讨论）
		const { rtc, pc, dc } = await setupConnectedRtc();
		expect(rtc.state).toBe('connected');
		expect(rtc.isReady).toBe(true);

		const stateChanges = [];
		rtc.onStateChange = () => stateChanges.push(rtc.state);

		// DC 意外关闭（对端主动关 DC 或 SCTP 故障）
		dc.readyState = 'closed';
		dc.onclose();

		// 新逻辑：connected 下 DC 关 → close(asFailed) → state='failed'
		expect(rtc.state).toBe('failed');
		expect(stateChanges.at(-1)).toBe('failed');
		expect(pc.__closed).toBe(true);
		expect(rtc.__pc).toBeNull();
		expect(rtc.__rpcChannel).toBeNull();
		expect(rtc.isReady).toBe(false);
		expect(mockSendSignaling).toHaveBeenCalledWith('bot1', 'rtc:closed');
	});

	test('closed / failed 态下 dc.onclose 不重复 close（幂等）', async () => {
		const { rtc, pc, dc } = await setupConnectedRtc();

		// 主动 close → state='closed'
		rtc.close();
		expect(rtc.state).toBe('closed');
		const closeCountBefore = pc.__closeCallCount;
		const sigCloseBefore = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:closed').length;

		// 再次触发 dc.onclose（某些浏览器会在 pc.close 后异步 fire dc 事件）
		dc.readyState = 'closed';
		dc.onclose();

		// state 仍为 closed；pc 不重关、信令不重发
		expect(rtc.state).toBe('closed');
		expect(pc.__closeCallCount).toBe(closeCountBefore);
		const sigCloseAfter = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:closed').length;
		expect(sigCloseAfter).toBe(sigCloseBefore);
	});

	// dc.onerror 是孤立事件契约：浏览器 spec 里 DC error 多数情况只是临时 transport 抖动，
	// 后续会再 fire dc.onclose 才真的失效。代码里 onerror 仅打 warn 日志、不动 state/不关 PC，
	// 防止把"还能恢复的 transient error"误升级为 close+rebuild。本 test 锁这个契约。
	test('dc.onerror 单独 fire 不动 state、不发 rtc:closed、不重建 PC', async () => {
		const { rtc, pc, dc } = await setupConnectedRtc();
		mockSendSignaling.mockClear();
		const stateBefore = rtc.state;
		const pcBefore = rtc.__pc;
		const dcBefore = rtc.__rpcChannel;

		// 模拟 DC transient error（没有伴随 onclose）
		dc.onerror({ error: { message: 'transient' } });

		expect(rtc.state).toBe(stateBefore); // 'connected'
		expect(rtc.__pc).toBe(pcBefore);
		expect(rtc.__rpcChannel).toBe(dcBefore);
		expect(pc.__closed).toBe(false);
		// 没发 rtc:closed 信令，没排 restart timer
		const closedMsgs = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:closed');
		expect(closedMsgs).toHaveLength(0);
		expect(rtc.__restartTimer).toBeNull();

		rtc.close();
	});

	test('restarting 下 DC 关 → close(asFailed) → 二次 fire dc.onclose 不重复 close', async () => {
		// 某些浏览器会在 pc.close() 内部异步再 fire 一次 dc.onclose；
		// 首次 fire 里 __rpcChannel 已置 null，第二次 fire 的 `__rpcChannel === dc` 分支不成立
		const { rtc, pc, dc } = await setupConnectedRtc();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');

		// 首次：SCTP 断
		dc.readyState = 'closed';
		dc.onclose();
		expect(rtc.state).toBe('failed');
		const closeCountBefore = pc.__closeCallCount;
		const sigCloseBefore = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:closed').length;

		// 二次 fire（浏览器重入）
		dc.onclose();

		expect(rtc.state).toBe('failed');
		expect(pc.__closeCallCount).toBe(closeCountBefore);
		const sigCloseAfter = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:closed').length;
		expect(sigCloseAfter).toBe(sigCloseBefore);
	});

	test('createDataChannel 在 restarting 时仍返回有效 DC（ICE restart 期间 SCTP 保留，新 DC 可 open）', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');

		const dc = rtc.createDataChannel('file:test', { ordered: true });
		expect(dc).not.toBeNull();
		// restart 期间新建也要 arraybuffer，不能让 mock 的默认 'blob' 漏过
		expect(dc.binaryType).toBe('arraybuffer');

		rtc.close();
	});

	test('createDataChannel 显式把 binaryType 置为 arraybuffer（防 Blob 默认导致的下载兜底失效）', async () => {
		const { rtc } = await setupConnectedRtc();

		const fileDc = rtc.createDataChannel('file:bt-check', { ordered: true });
		expect(fileDc).not.toBeNull();
		expect(fileDc.binaryType).toBe('arraybuffer');

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
		const { rtc } = await setupConnectedRtc();
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

	test('triggerRestart from connected：始终 await ensureConnected（让陈旧 WS 检查有机会触发）', async () => {
		// FIX-1 回归锁：typeChanged 切网窗口里 sig.state 仍 'connected' 但 lastAliveAt 陈旧时，
		// 旧实现按 sig.state==='connected' 早跳，rtc:offer 直接被丢进死 WS。
		// 修法：去掉 `if (sig.state !== 'connected')` 早退，始终 await ensureConnected——
		// 让其内部的 lastAliveAt > HB_TIMEOUT_MS → forceReconnect 检查有机会跑一遍。
		// 健康路径基本零成本（ensureConnected 一次分支判断即返回）。
		const { rtc } = await setupConnectedRtc();
		mockSigState = 'connected'; // 注意：state 是 connected，但仍要求调 ensureConnected
		mockSendSignaling.mockClear();
		mockEnsureConnected.mockClear();
		mockEnsureConnected.mockResolvedValue(undefined);

		rtc.triggerRestart('network_type_changed');
		await vi.advanceTimersByTimeAsync(0);

		// 断言 1：ensureConnected 恰好被调一次（即使 sig.state=connected）
		expect(mockEnsureConnected).toHaveBeenCalledTimes(1);

		// 断言 2：state 已切到 restarting
		expect(rtc.state).toBe('restarting');

		// 断言 3：rtc:offer 在 ensureConnected 之后送出
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(1);
		expect(offers[0][2]).toEqual(expect.objectContaining({ iceRestart: true }));
		// 调用次序：mockEnsureConnected.invocationCallOrder < sendSignaling.invocationCallOrder
		expect(mockEnsureConnected.mock.invocationCallOrder[0])
			.toBeLessThan(mockSendSignaling.mock.invocationCallOrder.at(-1));

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

		// 推进时间到预算耗尽（180s）
		await vi.advanceTimersByTimeAsync(180_000);
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

	test('时间预算耗尽 → 打 rtc.unrecoverable 诊断信号 + 触发 onUnrecoverable 回调（一次）', async () => {
		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
		const onUnrecoverable = vi.fn();

		const { rtc, pc } = await setupConnectedRtc();
		// 把回调挂到 rtc 实例上（生产路径走 initRtc 的 callbacks.onRtcUnrecoverable）
		rtc.onUnrecoverable = onUnrecoverable;

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');

		await vi.advanceTimersByTimeAsync(180_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('failed');

		const calls = remoteLog.mock.calls.map((c) => String(c[0]));
		expect(calls.some((t) => t.startsWith('rtc.unrecoverable') && t.includes('claw=bot1'))).toBe(true);
		expect(onUnrecoverable).toHaveBeenCalledTimes(1);

		rtc.close();
	});

	test('其它 close({asFailed:true}) 路径（dc.onclose / init 超时等）不触发 onUnrecoverable', async () => {
		const onUnrecoverable = vi.fn();
		const { rtc } = await setupConnectedRtc();
		rtc.onUnrecoverable = onUnrecoverable;

		// 直接走 close({asFailed:true}) 通用路径——不应触发 unrecoverable hook（此 hook 仅 ICE 预算耗尽专用）
		rtc.close({ asFailed: true });
		expect(rtc.state).toBe('failed');
		expect(onUnrecoverable).not.toHaveBeenCalled();
	});

	test('预算耗尽 await 期间被 pauseRestart 冻结 → 不触发 onUnrecoverable + 不 close', async () => {
		const onUnrecoverable = vi.fn();
		const { rtc, pc } = await setupConnectedRtc();
		rtc.onUnrecoverable = onUnrecoverable;

		// 进入 restarting + 装作 startTime 已超预算（避开真实推进 180s + 多轮 safety timer 串扰）
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		rtc.__restartStartTime = Date.now() - 200_000;

		// 直接进入 budget exhaust 分支；__attemptRestart 内部 await Promise.race(dumpStats, sleep 500)
		// 同步段执行到 await 后即把控制权交还给当前 task
		const attemptPromise = rtc.__attemptRestart('budget-exhaust-test');
		// 此时 attempt 处于 await 中；epoch 仍为 entry epoch
		const epochBefore = rtc.__restartEpoch;

		// 同步 pauseRestart：递增 epoch + 标记 paused，但保留 __state='restarting'
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__restartEpoch).toBe(epochBefore + 1);
		expect(rtc.state).toBe('restarting');

		// 让 await 完成（500ms sleep 或 dumpStats 任一胜出 → 微任务 flush）
		await vi.advanceTimersByTimeAsync(500);
		await attemptPromise;

		// guard 应拦下：不打 hook、不 close（state 仍为 restarting，留给后续 resume）
		expect(onUnrecoverable).not.toHaveBeenCalled();
		expect(rtc.state).toBe('restarting');

		rtc.close();
	});

	test('rtc.unrecoverable hook 抛异常时被 catch + close 仍正常进行', async () => {
		const onUnrecoverable = vi.fn(() => { throw new Error('hook boom'); });
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { rtc, pc } = await setupConnectedRtc();
		rtc.onUnrecoverable = onUnrecoverable;

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(180_000);
		await vi.advanceTimersByTimeAsync(0);

		expect(onUnrecoverable).toHaveBeenCalledTimes(1);
		// hook 抛错被 try/catch 吞掉，close({asFailed:true}) 仍执行 → state=failed
		expect(rtc.state).toBe('failed');
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('onUnrecoverable hook err'), expect.any(Error));

		consoleSpy.mockRestore();
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

	test('安全网定时器每 15s 重发 offer', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		mockSendSignaling.mockClear();

		// 15s 后安全网重试
		await vi.advanceTimersByTimeAsync(15_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(mockSendSignaling).toHaveBeenCalledWith(
			'bot1', 'rtc:offer',
			expect.objectContaining({ iceRestart: true }),
		);

		rtc.close();
	});

	test('restart answer 到达 → 本地日志 + remoteLog 记录 offer→answer RTT', async () => {
		const { remoteLog } = await import('./remote-log.js');
		const { rtc, pc } = await setupConnectedRtc();

		// 进入 restarting → 等 __attemptRestart 的 async 段落把 offer 发出
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartOfferSentAt).toBeGreaterThan(0);

		// 模拟 plugin 回 answer,1200ms 往返
		await vi.advanceTimersByTimeAsync(1200);
		remoteLog.mockClear();
		const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:answer', payload: { sdp: 'mock-answer-sdp' } });

		expect(infoSpy).toHaveBeenCalledWith(
			expect.stringMatching(/ICE restart answer received, offerRtt=\d+ms attempt=\d+/),
		);
		expect(remoteLog).toHaveBeenCalledWith(
			expect.stringMatching(/^rtc\.restartAnswer claw=bot1 rtt=\d+ms attempt=\d+$/),
		);
		// 已消费,避免后续误用
		expect(rtc.__restartOfferSentAt).toBe(0);

		infoSpy.mockRestore();
		rtc.close();
	});

	test('非 restart 路径的 rtc:answer 不记录 restart RTT', async () => {
		const { remoteLog } = await import('./remote-log.js');
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		remoteLog.mockClear();
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:answer', payload: { sdp: 'mock-answer-sdp' } });

		const restartCalls = remoteLog.mock.calls.filter((c) => String(c[0]).startsWith('rtc.restartAnswer'));
		expect(restartCalls).toHaveLength(0);

		rtc.close();
	});

	test('安全网周期重试后 RTT 基于最新一次 offer 计算', async () => {
		const { remoteLog } = await import('./remote-log.js');
		const { rtc, pc } = await setupConnectedRtc();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		const firstOfferAt = rtc.__restartOfferSentAt;
		expect(firstOfferAt).toBeGreaterThan(0);

		// 触发一次安全网周期重试：timestamp 应被刷新
		await vi.advanceTimersByTimeAsync(15_000);
		await vi.advanceTimersByTimeAsync(0);
		const secondOfferAt = rtc.__restartOfferSentAt;
		expect(secondOfferAt).toBeGreaterThan(firstOfferAt);

		// 第二次 offer 发出后 800ms,answer 到达
		await vi.advanceTimersByTimeAsync(800);
		remoteLog.mockClear();
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:answer', payload: { sdp: 'mock-answer-sdp' } });

		// RTT 应基于最近一次 offer（800ms 级别），而不是首次 offer（~15.8s）
		const restartCalls = remoteLog.mock.calls.filter((c) => String(c[0]).startsWith('rtc.restartAnswer'));
		expect(restartCalls).toHaveLength(1);
		const match = String(restartCalls[0][0]).match(/rtt=(\d+)ms/);
		expect(match).not.toBeNull();
		const rtt = Number(match[1]);
		expect(rtt).toBeGreaterThanOrEqual(800);
		expect(rtt).toBeLessThan(2000);

		rtc.close();
	});

	test('close() 清除 __restartOfferSentAt', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartOfferSentAt).toBeGreaterThan(0);

		rtc.close();
		expect(rtc.__restartOfferSentAt).toBe(0);
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

	// --- stats 轮询路径（覆盖"旧 pair 还活着、connectionState 从未跳变"的 ICE restart 成功判定）

	test('stats 轮询：ufrag 变化 → 判定 restart 成功（事件路径静默场景）', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		// pre-restart：nominated pair 的 local ufrag 为 'A'
		pc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc1', remoteCandidateId: 'rc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1', candidateType: 'host', protocol: 'udp', usernameFragment: 'A' }],
			['rc1', { type: 'remote-candidate', id: 'rc1', candidateType: 'host', protocol: 'udp' }],
		]);

		rtc.triggerRestart('network_type_changed');
		await vi.advanceTimersByTimeAsync(0); // offer 发出 + snap 首次 getStats
		await vi.advanceTimersByTimeAsync(0); // snap.then → startPoll
		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartUfragSnap).toBe('A');
		expect(rtc.__restartPollTimer).not.toBeNull();

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();

		// 模拟 plugin 完成 restart：新 pair 使用新 ufrag 'B'；connectionState 故意保持不动
		pc.__statsReport = new Map([
			['cp2', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc2', remoteCandidateId: 'rc2' }],
			['lc2', { type: 'local-candidate', id: 'lc2', candidateType: 'relay', protocol: 'udp', usernameFragment: 'B' }],
			['rc2', { type: 'remote-candidate', id: 'rc2', candidateType: 'prflx', protocol: 'udp' }],
		]);
		expect(pc.connectionState).toBe('connected');

		await vi.advanceTimersByTimeAsync(500); // 下一次 poll
		await vi.advanceTimersByTimeAsync(0); // poll 内部 getStats.then

		expect(rtc.state).toBe('connected');
		expect(rtc.__restartPollTimer).toBeNull();
		expect(rtc.__restartUfragSnap).toBeNull();
		expect(rtc.__restartAttemptCount).toBe(0);
		const logs = await getRemoteLogCalls();
		expect(logs.some((s) => /ICE restart succeeded via=stats/.test(s))).toBe(true);

		rtc.close();
	});

	test('stats 轮询：ufrag 不变 → 不判定成功（防误报）', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		pc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1', usernameFragment: 'A' }],
		]);

		rtc.triggerRestart('test');
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartUfragSnap).toBe('A');
		expect(rtc.__restartPollTimer).not.toBeNull();

		// 连跑多轮 poll，ufrag 都是 'A' → 不判成功
		await vi.advanceTimersByTimeAsync(5000);
		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartUfragSnap).toBe('A');

		rtc.close();
	});

	test('stats 轮询：pre-restart 无 selected pair → 不启动轮询', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		// 清空 stats：模拟 getStats 读不到 nominated+succeeded pair
		pc.__statsReport = new Map();

		rtc.triggerRestart('test');
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartUfragSnap).toBeNull();
		expect(rtc.__restartPollTimer).toBeNull();

		// 即使后来 stats 里出现"新 ufrag"，也不应误判成功（没有基准可比）
		pc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1', usernameFragment: 'B' }],
		]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(rtc.state).toBe('restarting');

		rtc.close();
	});

	test('stats 轮询：close 时清理 poll 和 snap', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		pc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1', usernameFragment: 'A' }],
		]);
		rtc.triggerRestart('test');
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartPollTimer).not.toBeNull();
		expect(rtc.__restartUfragSnap).toBe('A');

		rtc.close();
		expect(rtc.__restartPollTimer).toBeNull();
		expect(rtc.__restartUfragSnap).toBeNull();
	});

	test('stats 轮询：事件路径先成功时 poll 不再误触发（幂等）', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		pc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1', usernameFragment: 'A' }],
		]);
		rtc.triggerRestart('test');
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartPollTimer).not.toBeNull();

		// 事件路径先到：假设 pc 报上来 disconnected→connected（比如 ice_failed 恢复）
		pc.connectionState = 'disconnected';
		pc.onconnectionstatechange();
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		expect(rtc.state).toBe('connected');
		expect(rtc.__restartPollTimer).toBeNull();

		// 进一步把 stats 改成新 ufrag 'B'——poll 已经停了，不会再触发
		pc.__statsReport = new Map([
			['cp2', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc2' }],
			['lc2', { type: 'local-candidate', id: 'lc2', usernameFragment: 'B' }],
		]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(rtc.state).toBe('connected'); // 无变化

		rtc.close();
	});

	test('stats 轮询：多轮 poll 才命中（第二次 tick 才出现新 ufrag）', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		pc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1', usernameFragment: 'A' }],
		]);
		rtc.triggerRestart('test');
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartPollTimer).not.toBeNull();

		// 第 1 次 poll：仍是旧 pair → 不判成功
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');

		// 第 2 次 poll 前 restart 真正完成，新 ufrag 'B' 出现
		pc.__statsReport = new Map([
			['cp2', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc2' }],
			['lc2', { type: 'local-candidate', id: 'lc2', usernameFragment: 'B' }],
		]);
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('connected');

		rtc.close();
	});

	test('stats 轮询：poll 获取 getStats 期间 pc 被替换 → 静默早退，不改状态', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		pc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1', usernameFragment: 'A' }],
		]);
		rtc.triggerRestart('test');
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartPollTimer).not.toBeNull();

		// 让 getStats 挂起
		let resolveGetStats;
		pc.getStats = () => new Promise((r) => { resolveGetStats = r; });

		// 触发 poll tick
		await vi.advanceTimersByTimeAsync(500);

		// poll 正在 await getStats 期间，__pc 被清空（模拟 close 中间态）
		rtc.__pc = null;

		// 让挂起的 getStats resolve 出"新 ufrag 的 report"，此时 guard 应阻止误判
		resolveGetStats(new Map([
			['cp2', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc2' }],
			['lc2', { type: 'local-candidate', id: 'lc2', usernameFragment: 'B' }],
		]));
		await vi.advanceTimersByTimeAsync(0);

		// state 没有被误改（__pc !== pc 守卫生效）
		expect(rtc.state).toBe('restarting');
	});

	test('stats 轮询：超时 await 窗内 state 已切成 connected → close 不覆盖（guard 生效）', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		pc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1', usernameFragment: 'A' }],
		]);
		rtc.triggerRestart('test');
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);

		// 让 __attemptRestart 进入超时分支：把 startTime 推到预算外（181s 前），且 dumpStats 的 getStats 挂住
		rtc.__restartStartTime = Date.now() - 181_000;
		pc.getStats = () => new Promise(() => {}); // 永不 resolve，依赖 500ms 兜底
		rtc.nudgeRestart();
		await vi.advanceTimersByTimeAsync(0); // 进入分支 → stopPoll/stopTimer → await Promise.race(...)

		// 模拟"500ms 窗内 poll tick 迟到判成功"：手工把 state 切到 connected 并清 restart 状态
		rtc.__clearRestartState();
		rtc.__setState('connected');

		// 推进到兜底 timer 触发 → Promise.race resolve → guard 判断 state 后决定是否 close
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(0);

		// 关键断言：state 保持 connected，close({asFailed:true}) 被 guard 拦下
		expect(rtc.state).toBe('connected');

		rtc.close();
	});

	test('stats 轮询：background 停 poll，foreground nudge 后恢复', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		pc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1', usernameFragment: 'A' }],
		]);
		rtc.triggerRestart('test');
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartPollTimer).not.toBeNull();
		expect(rtc.__restartUfragSnap).toBe('A');

		// 切后台 → poll 停
		window.dispatchEvent(new Event('app:background'));
		expect(rtc.__restartPollTimer).toBeNull();
		expect(rtc.__restartUfragSnap).toBe('A'); // snap 保留

		// nudge（模拟前台恢复）→ poll 恢复
		rtc.nudgeRestart();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartPollTimer).not.toBeNull();
		expect(rtc.__restartUfragSnap).toBe('A'); // snap 没变

		rtc.close();
	});

	test('stats 轮询：跨 epoch 迟到的 snap.then 不污染新 epoch（即使新 epoch 处于 restarting）', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		// E1 snap 的 getStats 挂起
		let resolveE1Snap;
		pc.getStats = () => new Promise((r) => { resolveE1Snap = r; });

		rtc.triggerRestart('e1');
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartUfragSnap).toBeNull();
		const epochAtE1 = rtc.__restartEpoch;

		// 事件路径先成功（E1 → 进入下一 epoch，state=connected）
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		expect(rtc.state).toBe('connected');
		expect(rtc.__restartEpoch).toBe(epochAtE1 + 1);

		// 立即再次 triggerRestart 进入 E3 的 restarting；新 snap 的 getStats 也挂起（不关心 resolver）
		pc.getStats = () => new Promise(() => {});
		rtc.triggerRestart('e3');
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		// triggerRestart 自身不递增 epoch（只有 __clearRestartState 会）；事件成功递增过一次
		expect(rtc.__restartEpoch).toBe(epochAtE1 + 1);
		expect(rtc.__restartUfragSnap).toBeNull(); // E3 snap 未到

		// E1 的旧 snap 现在 resolve，返回 'E1-OLD'
		// 关键点：此时 (pc 同) 且 (state==='restarting')——如果 epoch guard 缺失，
		// 旧 E1 snap 会被误写入 E3 的 __restartUfragSnap；epoch guard 生效则拒之。
		resolveE1Snap(new Map([
			['cp1', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1', usernameFragment: 'E1-OLD' }],
		]));
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);

		// 没被污染：E3 snap 仍未就位
		expect(rtc.__restartUfragSnap).toBeNull();
		expect(rtc.__restartPollTimer).toBeNull();

		rtc.close();
	});

	test('stats 轮询：check tick 跨 epoch TOCTOU——await getStats 期间 epoch 推进不误判', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		pc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1', usernameFragment: 'E1-OLD' }],
		]);
		rtc.triggerRestart('e1');
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartUfragSnap).toBe('E1-OLD');
		expect(rtc.__restartPollTimer).not.toBeNull();

		// 切挂起版 getStats，让下一次 check tick 挂起
		let resolveCheckTick;
		pc.getStats = () => new Promise((r) => { resolveCheckTick = r; });

		// 触发 poll tick → __checkRestartViaStats 捕获 epochAtEntry，await getStats 挂起
		await vi.advanceTimersByTimeAsync(500);
		const savedCheckResolver = resolveCheckTick;

		// 切回非挂起版 getStats，保证事件路径/新 triggerRestart 里的 getStats 正常 resolve
		pc.getStats = async () => pc.__statsReport ?? new Map();
		pc.__statsReport = new Map();

		// 事件路径赢下当前 restart → __clearRestartState 里 epoch++，state=connected
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		expect(rtc.state).toBe('connected');

		// 立即再次 triggerRestart 进入新 epoch 的 restarting（新 snap 取不到 ufrag → null）
		rtc.triggerRestart('e3');
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartUfragSnap).toBeNull();

		// E1 的 check tick 现在 resolve，返回"新 ufrag"。
		// 关键：local const snap='E1-OLD'，pc 同、state='restarting' 守卫都成立；
		// 若无 epoch guard 会把当前 E3 误判成功（state→connected）；epoch guard 拦下。
		savedCheckResolver(new Map([
			['cp2', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc2' }],
			['lc2', { type: 'local-candidate', id: 'lc2', usernameFragment: 'E1-NEW' }],
		]));
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.state).toBe('restarting'); // 未被误触 connected

		rtc.close();
	});

	test('stats 轮询：ufrag 字段缺失且 SDP 也读不到 → warn 每 epoch 只打一次、切 epoch 后可再 warn', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		// 让 localDescription.sdp 不含 a=ice-ufrag，阻断 SDP fallback，强制走 warn 路径
		pc.localDescription = { type: 'offer', sdp: 'mock-sdp-no-ufrag' };
		pc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1', usernameFragment: 'A' }],
		]);
		rtc.triggerRestart('e1');
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);

		// poll 后 stats 的新 pair 没有 usernameFragment 字段
		pc.__statsReport = new Map([
			['cp2', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc2' }],
			['lc2', { type: 'local-candidate', id: 'lc2' }], // 无 usernameFragment
		]);

		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();

		// 多次 poll tick（同一 epoch 内）→ 只 warn 一次
		for (let i = 0; i < 3; i++) {
			await vi.advanceTimersByTimeAsync(500);
			await vi.advanceTimersByTimeAsync(0);
		}
		let warnLogs = (await getRemoteLogCalls()).filter((s) => /ufrag unavailable/.test(s));
		expect(warnLogs).toHaveLength(1);
		expect(rtc.state).toBe('restarting');

		// 推进到下一个 epoch：事件路径走失败 + 再 trigger restart → 新 epoch
		rtc.__clearRestartState(); // 模拟走任意 __clearRestartState 路径：epoch++，missingLogged flag 重置
		rtc.__setState('connected');
		// 重新 triggerRestart → 新 epoch 的 restarting（snap 也将拿不到 ufrag）
		pc.__statsReport = new Map([
			['cp3', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc3' }],
			['lc3', { type: 'local-candidate', id: 'lc3', usernameFragment: 'C' }],
		]);
		remoteLog.mockClear();
		rtc.triggerRestart('e2');
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		// 进入第二 epoch 后 poll 的 stats 再次没有 usernameFragment
		pc.__statsReport = new Map([
			['cp4', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc4' }],
			['lc4', { type: 'local-candidate', id: 'lc4' }],
		]);
		for (let i = 0; i < 3; i++) {
			await vi.advanceTimersByTimeAsync(500);
			await vi.advanceTimersByTimeAsync(0);
		}
		warnLogs = (await getRemoteLogCalls()).filter((s) => /ufrag unavailable/.test(s));
		// 新 epoch 重置了 missingLogged flag → 再次 warn 一次
		expect(warnLogs).toHaveLength(1);

		rtc.close();
	});

	test('stats 轮询：SDP ufrag fallback（usernameFragment 缺失但 SDP 可读）→ 判成功', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		// snap 阶段：localDescription.sdp 是"旧" ufrag
		pc.localDescription = { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:OLDF\r\n' };
		// stats 的 usernameFragment 为空（模拟 Safari / 老 Firefox 场景）
		pc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1' }], // 无 usernameFragment
		]);
		rtc.triggerRestart('test');
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		// snap 应通过 SDP fallback 拿到 'OLDF'
		expect(rtc.__restartUfragSnap).toBe('OLDF');
		expect(rtc.__restartPollTimer).not.toBeNull();

		// restart 完成：SDP 更新为新 ufrag；getStats 仍不暴露 usernameFragment
		pc.localDescription = { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:NEWF\r\n' };
		pc.__statsReport = new Map([
			['cp2', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc2' }],
			['lc2', { type: 'local-candidate', id: 'lc2' }],
		]);
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.state).toBe('connected');
		expect(rtc.__restartPollTimer).toBeNull();

		rtc.close();
	});

	test('stats 轮询：同时存在多个 nominated+succeeded pair，只要任一 local ufrag 已变即判成功', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		pc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc1' }],
			['lc1', { type: 'local-candidate', id: 'lc1', usernameFragment: 'OLD' }],
		]);
		rtc.triggerRestart('test');
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__restartUfragSnap).toBe('OLD');
		expect(rtc.__restartPollTimer).not.toBeNull();

		// migration 窗口：旧 pair 仍 nominated+succeeded（报告顺序在前），新 pair 也出现
		// 如果按"首个命中"逻辑，会取到旧 pair 的 ufrag='OLD' → 判失败；
		// 正确聚合策略应识别到新 pair 的 ufrag='NEW' ≠ snap 即判成功。
		pc.__statsReport = new Map([
			['cp1', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc1' }],
			['cp2', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'lc2' }],
			['lc1', { type: 'local-candidate', id: 'lc1', usernameFragment: 'OLD' }],
			['lc2', { type: 'local-candidate', id: 'lc2', usernameFragment: 'NEW' }],
		]);
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.state).toBe('connected');

		rtc.close();
	});
});

describe('WebRtcConnection — pauseRestart', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** 把 rtc 推入 'restarting' 状态并等到 restart offer 发出 */
	async function driveIntoRestarting() {
		const { rtc, pc, dc } = await setupConnectedRtc();
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		return { rtc, pc, dc };
	}

	test('connected 状态下 pauseRestart 停 keepalive/disconnected timer，置 paused', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		expect(rtc.state).toBe('connected');
		expect(rtc.__keepaliveTimer).not.toBeNull();

		// 模拟 ICE disconnected → 触发 disconnected timer（pauseRestart 应将其清掉）
		pc.connectionState = 'disconnected';
		pc.onconnectionstatechange();
		expect(rtc.__disconnectedTimer).not.toBeNull();

		const epochBefore = rtc.__restartEpoch;
		const keepaliveGenBefore = rtc.__keepaliveGen;

		rtc.pauseRestart();

		// state 保持 connected（PC 不关）
		expect(rtc.state).toBe('connected');
		// keepalive 已停：__keepaliveTimer 清空、gen 递增
		expect(rtc.__keepaliveTimer).toBeNull();
		expect(rtc.__keepaliveGen).toBe(keepaliveGenBefore + 1);
		// disconnected timer 已清
		expect(rtc.__disconnectedTimer).toBeNull();
		// epoch 递增，paused 置位
		expect(rtc.__restartEpoch).toBe(epochBefore + 1);
		expect(rtc.__restartPaused).toBe(true);

		rtc.close();
	});

	test('idle/failed/closed 状态下 pauseRestart 为 no-op', async () => {
		// idle（未 connect）
		const rtc1 = new WebRtcConnection('bot-idle', createMockBotConn(), { PeerConnection: MockRTCPeerConnection });
		expect(rtc1.state).toBe('idle');
		const epoch1 = rtc1.__restartEpoch;
		rtc1.pauseRestart();
		expect(rtc1.__restartPaused).toBe(false);
		expect(rtc1.__restartEpoch).toBe(epoch1);

		// closed
		const { rtc: rtc2 } = await setupConnectedRtc(createMockBotConn());
		rtc2.close();
		expect(rtc2.state).toBe('closed');
		const epoch2 = rtc2.__restartEpoch;
		rtc2.pauseRestart();
		expect(rtc2.__restartPaused).toBe(false);
		expect(rtc2.__restartEpoch).toBe(epoch2);
	});

	test('restarting 状态下 pauseRestart 停止 timer / poll，重置预算，置 __restartPaused=true', async () => {
		const { rtc } = await driveIntoRestarting();
		// 让 ufragSnap 的异步 promise 解析（让 startRestartPoll 有机会跑）
		await vi.advanceTimersByTimeAsync(0);

		// pause 前断言有 restart timer 在跑（安全网）
		expect(rtc.__restartTimer).not.toBeNull();
		const epochBefore = rtc.__restartEpoch;

		rtc.pauseRestart();

		// state 保持 'restarting'，PC 保留不关
		expect(rtc.state).toBe('restarting');
		// timer 与 poll 已停
		expect(rtc.__restartTimer).toBeNull();
		expect(rtc.__restartPollTimer).toBeNull();
		// 预算字段清零
		expect(rtc.__restartStartTime).toBe(0);
		expect(rtc.__restartAttemptCount).toBe(0);
		expect(rtc.__restartOfferSentAt).toBe(0);
		expect(rtc.__restartUfragSnap).toBeNull();
		expect(rtc.__restartUfragMissingLogged).toBe(false);
		// epoch 递增让在途回调失效
		expect(rtc.__restartEpoch).toBe(epochBefore + 1);
		// paused 标志置位
		expect(rtc.__restartPaused).toBe(true);

		rtc.close();
	});

	test('pause 后 triggerRestart 视为 first-trigger：重新计预算、发新 offer', async () => {
		const { rtc, pc } = await driveIntoRestarting();
		await vi.advanceTimersByTimeAsync(0);

		rtc.pauseRestart();
		mockSendSignaling.mockClear();
		pc.__createOfferOpts.length = 0;

		// Resume：触发 online_resume
		rtc.triggerRestart('online_resume');
		await vi.advanceTimersByTimeAsync(0);

		// 首次进入（视为 first trigger）应该重新 set restartStartTime
		expect(rtc.__restartStartTime).toBeGreaterThan(0);
		// attempt 从 1 开始（pause 时清 0 + 本次 attemptRestart 里 count++）
		expect(rtc.__restartAttemptCount).toBe(1);
		// paused 标志已被消费
		expect(rtc.__restartPaused).toBe(false);
		// 新 offer 发出
		expect(mockSendSignaling).toHaveBeenCalledWith(
			'bot1', 'rtc:offer',
			expect.objectContaining({ iceRestart: true }),
		);
		// state 仍是 restarting（PC 复用）
		expect(rtc.state).toBe('restarting');

		rtc.close();
	});

	test('pause 后 close：资源清理干净，无 leak', async () => {
		const { rtc, pc } = await driveIntoRestarting();
		await vi.advanceTimersByTimeAsync(0);

		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);

		rtc.close();

		// close 通过 __clearRestartState 把 paused 清掉
		expect(rtc.__restartPaused).toBe(false);
		expect(rtc.__restartTimer).toBeNull();
		expect(rtc.__restartPollTimer).toBeNull();
		expect(rtc.state).toBe('closed');
		expect(pc.__closed).toBe(true);
	});

	test('__clearRestartState 清 __restartPaused（restart 成功路径）', async () => {
		const { rtc, pc } = await driveIntoRestarting();
		await vi.advanceTimersByTimeAsync(0);

		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);

		// Resume → 成功到 connected
		rtc.triggerRestart('online_resume');
		await vi.advanceTimersByTimeAsync(0);
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();

		expect(rtc.state).toBe('connected');
		expect(rtc.__restartPaused).toBe(false);
		expect(rtc.__restartAttemptCount).toBe(0);

		rtc.close();
	});

	test('paused + connected 时 pc→failed 的 __onIceFailed 被 drop（不发 offer、不改 state）', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);
		mockSendSignaling.mockClear();
		pc.__createOfferOpts.length = 0;

		// 模拟底层 PC 原生进入 failed → onconnectionstatechange → __onIceFailed → __attemptRestart('ice_failed')
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);

		// paused gate 生效：不进入 restart 流程
		expect(rtc.state).toBe('connected');
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__restartAttemptCount).toBe(0);
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(0);

		rtc.close();
	});

	test('paused + restarting 时 ice_check_failed 再入 __attemptRestart 被 drop', async () => {
		const { rtc, pc } = await driveIntoRestarting();
		await vi.advanceTimersByTimeAsync(0);
		rtc.pauseRestart();
		mockSendSignaling.mockClear();
		pc.__createOfferOpts.length = 0;

		// restarting 中 pc 又报 failed（iceCheckFailed 路径会调 __attemptRestart('ice_check_failed')）
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);

		// paused 下被 drop：state 不变（仍 restarting），不新增 offer
		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartAttemptCount).toBe(0);
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(0);
		// paused 标志不被上述 drop 误清
		expect(rtc.__restartPaused).toBe(true);

		rtc.close();
	});

	test('pauseRestart 发生在 await ensureConnected 期间 → 旧 tick 不发 offer', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		mockSigState = 'disconnected';
		let resolveEnsure;
		mockEnsureConnected.mockImplementation(() => new Promise((r) => { resolveEnsure = r; }));
		mockSendSignaling.mockClear();

		// 进入 restarting → __attemptRestart 走到 await ensureConnected 挂起
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		expect(mockEnsureConnected).toHaveBeenCalled();

		// 在 await ensureConnected 挂起期间 pauseRestart（epoch++）
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);

		// 现在 resolve ensureConnected → 旧 tick 回到 __attemptRestart，
		// 新加的 epoch guard（epoch !== epochAtEntry）应拦截，不走到 createOffer
		mockSendSignaling.mockClear();
		pc.__createOfferOpts.length = 0;
		resolveEnsure();
		await vi.advanceTimersByTimeAsync(0);

		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(0);
		expect(rtc.__restartAttemptCount).toBe(0);
		// paused 状态不被旧 tick 误清
		expect(rtc.__restartPaused).toBe(true);

		mockSigState = 'connected';
		rtc.close();
	});

	test('resumeRecovery 在 connected+paused 下清 paused 并立即触发一次 probe（把 30-40s 黑洞压到 ~1-3s），不发 offer', async () => {
		// Finding 1: 网络恢复时 SCTP 可能已死但 pc.connectionState 尚未翻 failed/disconnected，
		// 仅 __startKeepalive() 要等完整 30s 间隔+10s 超时才能发现 → ~30-40s 黑洞。
		// 修法：__probeNow() 立即发一次 probe，失败复用 __doKeepalive 的 __onIceFailed 路径。
		const { rtc, pc, dc } = await setupConnectedRtc();
		expect(rtc.__keepaliveTimer).not.toBeNull();
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__keepaliveTimer).toBeNull();
		const keepaliveGenBefore = rtc.__keepaliveGen;
		mockSendSignaling.mockClear();
		pc.__createOfferOpts.length = 0;
		dc.sent.length = 0;

		rtc.resumeRecovery();

		expect(rtc.__restartPaused).toBe(false);
		// gen 递增（__probeNow bump）；不等 30s 间隔
		expect(rtc.__keepaliveGen).toBe(keepaliveGenBefore + 1);
		await vi.advanceTimersByTimeAsync(0);
		const probeSent = dc.sent.find((d) => {
			try { return JSON.parse(d).type === 'probe'; } catch { return false; }
		});
		expect(probeSent).toBeTruthy();
		// probe-ack → __doKeepalive schedule 下一轮 keepaliveTimer
		dc.onmessage({ data: JSON.stringify({ type: 'probe-ack' }) });
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.__keepaliveTimer).not.toBeNull();
		// 未发 ICE restart offer（PC 还健康，不需要）
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(0);
		expect(rtc.state).toBe('connected');

		rtc.close();
	});

	test('resumeRecovery 立即 probe 超时 → 短 pause 下也走 __onIceFailed（__probeNow 自身绕过 activity-grace）', async () => {
		// Finding 1 失败路径（短 pause 场景，deep-review A-P2 修复）：
		// resume 立即 probe 超时时，pause 期间 __lastDcActivityAt 不再被更新（DC 入向事件停摆），
		// elapsed < DC_ACTIVITY_GRACE_MS(20s) 原本会被 grace 跳过 → 退化到等 30s+10s 才升级。
		// 修法：__probeNow 入口清零 __lastDcActivityAt，让 grace 失效一次 probe 失败直接升级。
		// 断言：dc.onopen 刚刚设过 __lastDcActivityAt=Date.now()，若 __probeNow 不清，probe 超时会被 skip；
		//       清后 probe 超时 → __onIceFailed → triggerRestart → state='restarting'
		const { rtc, dc } = await setupConnectedRtc();
		expect(rtc.__lastDcActivityAt).toBeGreaterThan(0); // 确认 dc.onopen 设过
		rtc.pauseRestart();
		mockSendSignaling.mockClear();
		dc.sent.length = 0;

		rtc.resumeRecovery();
		// 立即发 probe
		await vi.advanceTimersByTimeAsync(0);
		const probeSent = dc.sent.find((d) => {
			try { return JSON.parse(d).type === 'probe'; } catch { return false; }
		});
		expect(probeSent).toBeTruthy();
		// probe 不 ack → 超时 DC_KEEPALIVE_TIMEOUT_MS=10_000
		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(0);

		// __doKeepalive → probe=false → activity grace 过 → __onIceFailed → triggerRestart
		expect(rtc.state).toBe('restarting');
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers.length).toBeGreaterThan(0);

		rtc.close();
	});

	test('resumeRecovery 发现 pc.connectionState=failed → 升级为 ice-restart（online_resume）', async () => {
		// 背景：paused 期间 __onIceFailed 触发 __attemptRestart 会在 L975 paused gate 被 drop，
		// 没有留下"已失败"标记；UI __state 仍为 connected（__setState 没走）。此时若仅清 paused +
		// startKeepalive，实际路径已死，要等下一轮 probe/keepalive 超时（30-40s）才被动触发 restart。
		// 修法：resumeRecovery 入口读 pc.connectionState，failed/disconnected 升级为
		// triggerRestart('online_resume')（paused 白名单 reason）立即发 ICE restart offer。
		const { rtc, pc } = await setupConnectedRtc();
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);

		// 模拟 paused 期间 PC 真失败
		pc.connectionState = 'failed';
		mockSendSignaling.mockClear();

		rtc.resumeRecovery();
		await vi.advanceTimersByTimeAsync(0);

		// 升级为 ICE restart：state='restarting'，发了 iceRestart offer
		expect(rtc.state).toBe('restarting');
		expect(mockSendSignaling).toHaveBeenCalledWith(
			'bot1', 'rtc:offer',
			expect.objectContaining({ iceRestart: true }),
		);
		// paused 也被清（triggerRestart → __attemptRestart 会清）
		expect(rtc.__restartPaused).toBe(false);

		rtc.close();
	});

	test('resumeRecovery 发现 pc.connectionState=disconnected → 同样升级为 ice-restart', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		rtc.pauseRestart();

		pc.connectionState = 'disconnected';
		mockSendSignaling.mockClear();

		rtc.resumeRecovery();
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.state).toBe('restarting');
		expect(mockSendSignaling).toHaveBeenCalledWith(
			'bot1', 'rtc:offer',
			expect.objectContaining({ iceRestart: true }),
		);

		rtc.close();
	});

	test('resumeRecovery 未 paused 或非 connected 时为 no-op', async () => {
		const { rtc: rtc1 } = await setupConnectedRtc();
		// 未 paused
		rtc1.resumeRecovery();
		expect(rtc1.__restartPaused).toBe(false);
		rtc1.close();

		// restarting + paused：resumeRecovery 不触发 keepalive（restart 场景走 triggerRestart 路径）。
		// 注意 driveIntoRestarting 里把 pc.connectionState 置为 'failed' —— 即使如此，
		// resumeRecovery 也不自动升级为 ice-restart（restarting+paused 由调用方显式走
		// triggerRestart('online_resume') 分派，API 合约只在 connected+paused 时升级）
		const { rtc: rtc2, pc: pc2 } = await driveIntoRestarting();
		rtc2.pauseRestart();
		expect(rtc2.__keepaliveTimer).toBeNull();
		mockSendSignaling.mockClear();
		rtc2.resumeRecovery();
		await vi.advanceTimersByTimeAsync(0);
		// paused 被清（便于调用方判断）
		expect(rtc2.__restartPaused).toBe(false);
		// 但 keepalive 在 restarting 下不启动
		expect(rtc2.__keepaliveTimer).toBeNull();
		// 且不发 offer：保守——restarting+paused 的 ICE restart 由调用方显式发起，
		// 防止未来有人撤掉 `__state === 'connected'` 限定后引入意外 restart
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(0);
		void pc2;
		rtc2.close();
	});

	// --- resumeRecovery 在 rpcChannel 非 open 时的健壮性（G-06）---

	test('resumeRecovery gate：__rpcChannel=null 时只清 paused、不调 __probeNow', async () => {
		// 边界场景：paused 期间 DC 被清空（onclose 先 fire 过）。gate 条件
		// `__rpcChannel?.readyState === 'open'` 必须拦住 __probeNow，避免
		// 在 probe 内触碰 null.send 之类的未定义行为。
		const { rtc } = await setupConnectedRtc();
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);
		// 强制 rpcChannel=null，模拟 DC 已关
		rtc.__rpcChannel = null;
		const keepaliveGenBefore = rtc.__keepaliveGen;
		const lastActivityBefore = rtc.__lastDcActivityAt;
		mockSendSignaling.mockClear();

		// 不应抛
		expect(() => rtc.resumeRecovery()).not.toThrow();
		await vi.advanceTimersByTimeAsync(0);

		// paused 清掉（API 合约），__probeNow 未跑（gen 不 bump、__lastDcActivityAt 未清零）
		expect(rtc.__restartPaused).toBe(false);
		expect(rtc.__keepaliveGen).toBe(keepaliveGenBefore);
		expect(rtc.__lastDcActivityAt).toBe(lastActivityBefore);
		// 不发 offer
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(0);

		rtc.close();
	});

	test('resumeRecovery gate：__rpcChannel.readyState=closing 时同样不调 __probeNow', async () => {
		// DC.onclose 尚未 fire 但 readyState 已进入 closing 的瞬间窗口；
		// gate 只识别 'open'，其他状态（connecting/closing/closed）均不 probe。
		const { rtc, dc } = await setupConnectedRtc();
		rtc.pauseRestart();
		dc.readyState = 'closing';
		const keepaliveGenBefore = rtc.__keepaliveGen;
		const lastActivityBefore = rtc.__lastDcActivityAt;
		dc.sent.length = 0;

		expect(() => rtc.resumeRecovery()).not.toThrow();
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.__restartPaused).toBe(false);
		expect(rtc.__keepaliveGen).toBe(keepaliveGenBefore);
		expect(rtc.__lastDcActivityAt).toBe(lastActivityBefore);
		// 未发 probe
		const probeSent = dc.sent.find((d) => {
			try { return JSON.parse(d).type === 'probe'; } catch { return false; }
		});
		expect(probeSent).toBeFalsy();

		rtc.close();
	});

	test('resumeRecovery：gate 通过后 dc.send 抛异常 → probe try/catch 收敛，走 __onIceFailed → triggerRestart', async () => {
		// 场景：gate 判断瞬间 DC readyState='open' 通过，但 __probeNow → __doKeepalive → probe()
		// 内执行 dc.send 时底层抛（如 SCTP 层已断但 readyState 未同步翻 closing）。
		// probe() 内部 try/catch 调 __settleProbe(false) → probe resolve false
		// → __doKeepalive 看 __lastDcActivityAt=0（__probeNow 已清零）→ grace 过 → __onIceFailed
		// → triggerRestart('ice_failed')。
		// 断言：不把异常冒泡、最终 state='restarting' 且发了 iceRestart offer。
		const { rtc, dc } = await setupConnectedRtc();
		rtc.pauseRestart();
		// send 抛异常（gate 已经以 readyState='open' 过关）
		dc.send = vi.fn(() => { throw new Error('dc send failed'); });
		mockSendSignaling.mockClear();

		expect(() => rtc.resumeRecovery()).not.toThrow();
		// probe 内 catch → __settleProbe(false)（同步）；让 __doKeepalive 的 await 推进
		await vi.advanceTimersByTimeAsync(0);

		// __lastDcActivityAt 被 __probeNow 清零 → elapsed 超 grace → __onIceFailed → restart
		expect(rtc.state).toBe('restarting');
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers.length).toBeGreaterThan(0);
		expect(offers[0][2]).toEqual(expect.objectContaining({ iceRestart: true }));

		rtc.close();
	});

	test('resumeRecovery：gate 通过后 rpcChannel 在 probe 开始前翻 closed → probe 内置守卫 resolve(false) → __onIceFailed', async () => {
		// 场景 C：gate 判断（readyState='open'）与 probe 实际执行之间，DC 状态翻到 'closed'。
		// probe() 函数入口的 `if (!dc || dc.readyState !== 'open')` 守卫兜底 → 返回 Promise.resolve(false)，
		// 不触碰 dc.send。然后 __doKeepalive 看 !alive + __lastDcActivityAt=0 → __onIceFailed。
		const { rtc, dc } = await setupConnectedRtc();
		rtc.pauseRestart();
		// 用 getter 让 gate 读到 'open'，之后 probe() 再读时已 'closed'
		let readCount = 0;
		Object.defineProperty(dc, 'readyState', {
			configurable: true,
			get() { return readCount++ === 0 ? 'open' : 'closed'; },
		});
		const sendSpy = vi.spyOn(dc, 'send');
		mockSendSignaling.mockClear();

		expect(() => rtc.resumeRecovery()).not.toThrow();
		await vi.advanceTimersByTimeAsync(0);

		// probe 内置守卫拦下：send 未被调用
		expect(sendSpy).not.toHaveBeenCalled();
		// __doKeepalive 仍然看到 alive=false → grace 已被 __probeNow 清零 → __onIceFailed → restart
		expect(rtc.state).toBe('restarting');
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers.length).toBeGreaterThan(0);

		rtc.close();
	});

	test('pauseRestart 发生在 await createOffer 期间 → 旧 tick 不发 offer、attempt 保持', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		// createOffer 挂起：便于在 await 窗口里插 pauseRestart
		let resolveOffer;
		pc.createOffer = (opts) => {
			pc.__createOfferOpts.push(opts);
			return new Promise((r) => { resolveOffer = r; });
		};
		// setLocalDescription 计数：断言 createOffer 之后没再往前走
		let sldCalls = 0;
		const origSld = pc.setLocalDescription.bind(pc);
		pc.setLocalDescription = (desc) => { sldCalls++; return origSld(desc); };

		// 进入 restarting → __attemptRestart 走到 await pc.createOffer 挂起
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartInFlight).toBe(true);
		expect(pc.__createOfferOpts.at(-1)).toEqual({ iceRestart: true });

		mockSendSignaling.mockClear();
		const epochBefore = rtc.__restartEpoch;

		// createOffer await 期间 pauseRestart → epoch++
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__restartEpoch).toBe(epochBefore + 1);

		// 现在 resolve createOffer → 回到 __attemptRestart，epoch guard 应拦截
		resolveOffer({ type: 'offer', sdp: 'stale-restart-sdp' });
		await vi.advanceTimersByTimeAsync(0);

		// L1098 epoch guard 生效：不走 setLocalDescription、不 sendSignaling、不 attempt++
		expect(sldCalls).toBe(0);
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(0);
		expect(rtc.__restartAttemptCount).toBe(0);
		expect(rtc.__restartOfferSentAt).toBe(0);
		// paused 标志不被旧 tick 误清
		expect(rtc.__restartPaused).toBe(true);
		// finally 正常复位
		expect(rtc.__restartInFlight).toBe(false);

		rtc.close();
	});

	test('pauseRestart 发生在 await setLocalDescription 期间 → 不发 offer、attempt 保持', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		// createOffer 走默认 mock（立即 resolve）；只挂起 setLocalDescription
		let resolveSld;
		pc.setLocalDescription = (desc) => {
			pc.localDescription = desc;
			return new Promise((r) => { resolveSld = r; });
		};

		// 清 connect 阶段的 rtc:offer 计数
		mockSendSignaling.mockClear();

		// 进入 restarting → 走完 createOffer、挂在 setLocalDescription 的 await
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartInFlight).toBe(true);
		// createOffer 已跑过
		expect(pc.__createOfferOpts.at(-1)).toEqual({ iceRestart: true });
		// SLD 挂起中 → 还没到 sendSignaling
		const offersMid = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offersMid).toHaveLength(0);

		const epochBefore = rtc.__restartEpoch;

		// SLD await 期间 pauseRestart → epoch++
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__restartEpoch).toBe(epochBefore + 1);

		// 释放 SLD → 回到 __attemptRestart，epoch guard（L1101）应拦截 sendSignaling
		resolveSld();
		await vi.advanceTimersByTimeAsync(0);

		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(0);
		expect(rtc.__restartAttemptCount).toBe(0);
		expect(rtc.__restartOfferSentAt).toBe(0);
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__restartInFlight).toBe(false);

		rtc.close();
	});

	// pauseRestart 在 createOffer await 期间 reject 路径：旧 tick 的 reject 不应越过 pause
	// 屏障 close({asFailed:true})。L1195 的 epoch / paused guard 应吞掉 reject。
	test('pauseRestart 后 createOffer reject → 不发 rtc:closed、保持 restarting + paused', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		let rejectOffer;
		pc.createOffer = (opts) => {
			pc.__createOfferOpts.push(opts);
			return new Promise((_, rej) => { rejectOffer = rej; });
		};

		// 进入 restarting → 挂在 await createOffer
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartInFlight).toBe(true);

		mockSendSignaling.mockClear();
		const epochBefore = rtc.__restartEpoch;
		const pcBefore = rtc.__pc;

		// pauseRestart → epoch++、paused=true
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__restartEpoch).toBe(epochBefore + 1);

		// 旧 createOffer 现在 reject → catch 里的 paused/epoch guard 应吞掉
		rejectOffer(new Error('createOffer failed'));
		await vi.advanceTimersByTimeAsync(0);

		// state 维持 restarting（不被 close 升级到 closed/failed）
		expect(rtc.state).toBe('restarting');
		expect(rtc.__pc).toBe(pcBefore);
		expect(pcBefore.__closed).toBe(false);
		expect(rtc.__restartPaused).toBe(true);
		// 没发 rtc:closed
		const closedMsgs = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:closed');
		expect(closedMsgs).toHaveLength(0);
		// finally 复位
		expect(rtc.__restartInFlight).toBe(false);

		rtc.close();
	});

	test('pauseRestart 后 setLocalDescription reject → 不发 rtc:closed、保持 restarting + paused', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		// createOffer 走默认（立即 resolve），SLD 挂起后 reject
		let rejectSld;
		pc.setLocalDescription = (desc) => {
			pc.localDescription = desc;
			return new Promise((_, rej) => { rejectSld = rej; });
		};

		mockSendSignaling.mockClear();
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartInFlight).toBe(true);

		const epochBefore = rtc.__restartEpoch;
		const pcBefore = rtc.__pc;

		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__restartEpoch).toBe(epochBefore + 1);

		rejectSld(new Error('SLD failed'));
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.state).toBe('restarting');
		expect(rtc.__pc).toBe(pcBefore);
		expect(pcBefore.__closed).toBe(false);
		expect(rtc.__restartPaused).toBe(true);
		const closedMsgs = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:closed');
		expect(closedMsgs).toHaveLength(0);
		expect(rtc.__restartInFlight).toBe(false);

		rtc.close();
	});

	test('对照：createOffer 全流程无 pause 干扰 → attempt++ 且 offer 正常发出', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		mockSendSignaling.mockClear();

		// 进入 restarting → __attemptRestart 一路走完（createOffer/SLD 均使用默认 mock，立即 resolve）
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartInFlight).toBe(false); // finally 复位
		expect(rtc.__restartAttemptCount).toBe(1);
		expect(rtc.__restartOfferSentAt).toBeGreaterThan(0);
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(1);
		expect(offers[0][2]).toEqual(expect.objectContaining({ iceRestart: true }));

		rtc.close();
	});

	test('对照：SLD 挂起但无 pause → 释放后 sendSignaling 正常调、attempt++', async () => {
		const { rtc, pc } = await setupConnectedRtc();

		// 挂起 SLD，但不调 pauseRestart
		let resolveSld;
		pc.setLocalDescription = (desc) => {
			pc.localDescription = desc;
			return new Promise((r) => { resolveSld = r; });
		};

		// 清 connect 阶段的 rtc:offer 计数
		mockSendSignaling.mockClear();

		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		expect(rtc.__restartInFlight).toBe(true);
		// SLD 挂起期间 offer 还没发（clear 后）
		expect(mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer')).toHaveLength(0);
		expect(rtc.__restartAttemptCount).toBe(0);

		// 释放 SLD → epoch 未变 → 正常 sendSignaling + attempt++
		resolveSld();
		await vi.advanceTimersByTimeAsync(0);

		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(1);
		expect(offers[0][2]).toEqual(expect.objectContaining({ iceRestart: true }));
		expect(rtc.__restartAttemptCount).toBe(1);
		expect(rtc.__restartOfferSentAt).toBeGreaterThan(0);
		expect(rtc.__restartInFlight).toBe(false);

		rtc.close();
	});
});

describe('paused gate 抗迟到 signaling', () => {
	// 覆盖 __onSignaling 入口的 paused guard：paused 期间 restart 相关的迟到信令
	// （answer / ice / restart-rejected）一律 drop，避免：
	// - answer/ice 让 ICE 跑通 → onconnectionstatechange('connected') → __clearRestartState 清 paused
	// - reject 直接 close PC + 清 paused
	beforeEach(() => {
		vi.useFakeTimers();
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** 把 rtc 推入 restarting + paused 状态 */
	async function driveIntoRestartingPaused() {
		const { rtc, pc, dc } = await setupConnectedRtc();
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__state).toBe('restarting');
		return { rtc, pc, dc };
	}

	test('paused + restarting 下迟到 rtc:restart-rejected → drop，不 close PC', async () => {
		const { rtc, pc } = await driveIntoRestartingPaused();
		mockSendSignaling.mockClear();

		fireRtcSignal({ clawId: 'bot1', type: 'rtc:restart-rejected', payload: { reason: 'no_session' } });

		// PC 未被关
		expect(pc.__closed).toBe(false);
		expect(pc.__closeCallCount).toBe(0);
		// 未向 plugin 发 rtc:closed
		const closedCalls = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:closed');
		expect(closedCalls).toHaveLength(0);
		// paused 与 restarting 状态均未被动摇
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__state).toBe('restarting');

		rtc.close();
	});

	test('paused + restarting 下迟到 rtc:answer → drop，不 setRemoteDescription', async () => {
		const { rtc, pc } = await driveIntoRestartingPaused();
		const sldSpy = vi.spyOn(pc, 'setRemoteDescription');

		fireRtcSignal({ clawId: 'bot1', type: 'rtc:answer', payload: { sdp: 'late-ans' } });
		await vi.advanceTimersByTimeAsync(0);

		// setRemoteDescription 完全没被调
		expect(sldSpy).toHaveBeenCalledTimes(0);
		// __remoteDescSet 保持初始 false（restart 后 __restartWithNewPc 会重置它）
		expect(rtc.__remoteDescSet).toBe(false);
		// paused 未被动摇
		expect(rtc.__restartPaused).toBe(true);

		rtc.close();
	});

	test('paused + restarting 下迟到 rtc:ice → drop，不入队、不 addIceCandidate', async () => {
		const { rtc, pc } = await driveIntoRestartingPaused();
		const addSpy = vi.spyOn(pc, 'addIceCandidate');
		// 基线：pending 队列在 paused 开始时为空
		expect(rtc.__pendingCandidates).toHaveLength(0);

		fireRtcSignal({ clawId: 'bot1', type: 'rtc:ice', payload: { candidate: 'candidate:late', sdpMid: '0' } });

		// addIceCandidate 完全没被调
		expect(addSpy).toHaveBeenCalledTimes(0);
		// 也没被 push 进 pending 队列
		expect(rtc.__pendingCandidates).toHaveLength(0);
		// paused 未被动摇
		expect(rtc.__restartPaused).toBe(true);

		rtc.close();
	});

	/** 把 rtc 推入 connected + paused 状态（pauseRestart 入口同样允许 connected 源态） */
	async function driveIntoConnectedPaused() {
		const { rtc, pc, dc } = await setupConnectedRtc();
		expect(rtc.__state).toBe('connected');
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__state).toBe('connected');
		return { rtc, pc, dc };
	}

	test('paused + connected 下迟到 rtc:answer → drop，不 setRemoteDescription', async () => {
		const { rtc, pc } = await driveIntoConnectedPaused();
		const sldSpy = vi.spyOn(pc, 'setRemoteDescription');

		fireRtcSignal({ clawId: 'bot1', type: 'rtc:answer', payload: { sdp: 'late-ans' } });
		await vi.advanceTimersByTimeAsync(0);

		expect(sldSpy).toHaveBeenCalledTimes(0);
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__state).toBe('connected');

		rtc.close();
	});

	test('paused + connected 下迟到 rtc:ice → drop，不 addIceCandidate', async () => {
		const { rtc, pc } = await driveIntoConnectedPaused();
		const addSpy = vi.spyOn(pc, 'addIceCandidate');
		const pendingBefore = rtc.__pendingCandidates.length;

		fireRtcSignal({ clawId: 'bot1', type: 'rtc:ice', payload: { candidate: 'candidate:late', sdpMid: '0' } });

		expect(addSpy).toHaveBeenCalledTimes(0);
		// 不入队，长度未变
		expect(rtc.__pendingCandidates).toHaveLength(pendingBefore);
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__state).toBe('connected');

		rtc.close();
	});

	// P0-5: rtc:answer setRemoteDescription pending 期间 pauseRestart →
	// .then 中的 paused/pc-replace guard 必须丢弃迟到 resolve，不写 __remoteDescSet 不 drain
	test('setRemoteDescription pending 期间 pauseRestart → resolve 后 drop（不 drain pendingCandidates）', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		// 推入 restarting 让 rtc:answer 走"restarting answer"路径
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');

		// 用手动可控 promise 替换 pc.setRemoteDescription
		let resolveSDP;
		const sdpPromise = new Promise((r) => { resolveSDP = r; });
		const sldSpy = vi.spyOn(pc, 'setRemoteDescription').mockReturnValue(sdpPromise);
		const addSpy = vi.spyOn(pc, 'addIceCandidate');

		// 预先注入一个 pending candidate，验证 drain 不被执行
		rtc.__pendingCandidates.push({ candidate: 'cand:pre', sdpMid: '0' });

		// 触发 rtc:answer：进入 setRemoteDescription（仍 pending）
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:answer', payload: { sdp: 'mock-answer' } });
		expect(sldSpy).toHaveBeenCalledTimes(1);

		// await 期间 pause
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);

		// resolve setRemoteDescription
		resolveSDP();
		await vi.advanceTimersByTimeAsync(0);

		// guard 拦住：__remoteDescSet 不被翻 true，pendingCandidates 不被 drain
		expect(rtc.__remoteDescSet).toBe(false);
		expect(rtc.__pendingCandidates).toHaveLength(1);
		expect(addSpy).toHaveBeenCalledTimes(0);

		rtc.close();
	});

	test('正常路径（无 pause）：setRemoteDescription resolve 后 drain pendingCandidates（guard 不误伤）', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');

		let resolveSDP;
		const sdpPromise = new Promise((r) => { resolveSDP = r; });
		vi.spyOn(pc, 'setRemoteDescription').mockReturnValue(sdpPromise);
		const addSpy = vi.spyOn(pc, 'addIceCandidate');

		// 注入 candidate，验证正常路径会 drain
		rtc.__pendingCandidates.push({ candidate: 'cand:normal', sdpMid: '0' });

		fireRtcSignal({ clawId: 'bot1', type: 'rtc:answer', payload: { sdp: 'mock-answer' } });
		// 不 pause，直接 resolve
		resolveSDP();
		await vi.advanceTimersByTimeAsync(0);

		expect(rtc.__remoteDescSet).toBe(true);
		expect(rtc.__pendingCandidates).toHaveLength(0);
		expect(addSpy).toHaveBeenCalledTimes(1);

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
		await vi.advanceTimersByTimeAsync(180_000);
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
		await vi.advanceTimersByTimeAsync(180_000);
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
	beforeEach(async () => {
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
		// 清掉之前测试留下的 remoteLog 调用，避免按 filter 断言被污染
		const { remoteLog } = await import('./remote-log.js');
		remoteLog.mockClear();
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
		mockSendSignaling.mockClear();

		const toJson = { from: 'missing-typ' };
		pc.onicecandidate({ candidate: { candidate: 'candidate-no-typ', toJSON: () => toJson } });
		// 计数器不加
		expect(rtc.__iceCandCounts.host).toBe(0);
		expect(rtc.__iceCandCounts.srflx).toBe(0);
		// 仍应把 candidate 通过信令发出，不能早退
		expect(mockSendSignaling).toHaveBeenCalledWith('bot1', 'rtc:ice', toJson);

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

		// triggerRestart → 第一次 attempt 快速超时：手动把 __restartStartTime 设为预算外（181s 前）
		rtc.triggerRestart('test');
		await vi.advanceTimersByTimeAsync(0);
		rtc.__restartStartTime = Date.now() - 181_000;
		rtc.nudgeRestart();
		await vi.advanceTimersByTimeAsync(0);

		const logs = await getRemoteLogCalls();
		expect(logs.some((s) => /stats\.restart-timeout/.test(s))).toBe(true);

		vi.useRealTimers();
		rtc.close();
	});

	test('ICE restart 超时时 getStats 挂住 → 500ms 兜底解除阻塞，state 变 failed', async () => {
		vi.useFakeTimers();
		const { rtc, pc } = await setupConnectedRtc();
		// 让 getStats 永不 resolve：模拟 pion 病态场景（正是本次调查目标）
		pc.getStats = () => new Promise(() => {});

		rtc.triggerRestart('test');
		await vi.advanceTimersByTimeAsync(0);
		rtc.__restartStartTime = Date.now() - 181_000;
		rtc.nudgeRestart();
		// __attemptRestart 走到 Promise.race，等待 500ms 兜底
		await vi.advanceTimersByTimeAsync(0);
		// 此时还在 race 中，state 仍是 restarting
		expect(rtc.state).toBe('restarting');

		// 推到 500ms 超时 → race resolve → close 执行
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('failed');

		vi.useRealTimers();
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

// --- P0-3: stale rtc:answer/ice across rebuild ---
//
// rebuild 场景（claws.store.js:858 closeRtcForClaw → conn.clearRtc → new WebRtcConnection）：
// 旧 rtc.close() 内（webrtc-connection.js:290）调用 __removeRtcListener → 从 signaling 'rtc' 事件解绑。
// 期望：旧 listener 在 close 后不再接收 signaling，新 rtc 实例独立运作。
//
// 锚点：
// - __onSignaling rtc:answer (L1425-1453)：pcAtAnswer?.setRemoteDescription — 无显式 stale guard
// - __onSignaling rtc:ice (L1454-1459)：this.__pc?.addIceCandidate — 无 epoch/pc 代际校验
// - rtc:restart-rejected (L1465)：有 state==='restarting' guard
// - close() (L290)：__removeRtcListener → sig.off('rtc', this.__onRtcMsg)
// - __ensureRtcListener (L1476-1483)：__onRtcMsg 闭包 → 调 this.__onSignaling
describe('P0-3: stale rtc:answer/ice across rebuild', () => {
	beforeEach(() => {
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});

	test('rebuild 后旧 rtc 的 listener 已从 signaling 解绑（不接收新消息）', async () => {
		const oldConn = createMockBotConn();
		const oldRtc = new WebRtcConnection('bot1', oldConn, { PeerConnection: MockRTCPeerConnection });
		await oldRtc.connect(MOCK_TURN_CREDS);
		const oldPc = MockRTCPeerConnection.lastInstance;

		// close 前：应已订阅 signaling 'rtc'
		expect(sigListeners['rtc']?.length).toBe(1);
		expect(oldRtc.__onRtcMsg).toBeTruthy();

		// 模拟 rebuild 的第一步：closeRtcForClaw → rtc.close()
		oldRtc.close();

		// close 后：旧 listener 已从 signaling 摘除
		expect(sigListeners['rtc']?.length ?? 0).toBe(0);
		expect(oldRtc.__onRtcMsg).toBeNull();
		expect(oldRtc.__pc).toBeNull();

		// 模拟 rebuild 第二步：new WebRtcConnection（新实例注册自己的 listener）
		const newConn = createMockBotConn();
		const newRtc = new WebRtcConnection('bot1', newConn, { PeerConnection: MockRTCPeerConnection });
		await newRtc.connect(MOCK_TURN_CREDS);
		const newPc = MockRTCPeerConnection.lastInstance;

		// 新 listener 已注册，且与旧 PC 是独立实例
		expect(sigListeners['rtc']?.length).toBe(1);
		expect(newPc).not.toBe(oldPc);

		// 发 rtc:answer → 仅新 PC 收到 setRemoteDescription，旧 PC __remoteDesc 保持 null
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:answer', payload: { sdp: 'new-ans' } });
		await vi.waitFor(() => {
			expect(newPc.__remoteDesc).toEqual({ type: 'answer', sdp: 'new-ans' });
		});
		expect(oldPc.__remoteDesc).toBeNull();

		newRtc.close();
	});

	test('rebuild 后对旧 clawId 的 rtc:ice 仅路由到新 PC，旧 PC 不收', async () => {
		const oldConn = createMockBotConn();
		const oldRtc = new WebRtcConnection('bot1', oldConn, { PeerConnection: MockRTCPeerConnection });
		await oldRtc.connect(MOCK_TURN_CREDS);
		const oldPc = MockRTCPeerConnection.lastInstance;

		// 模拟 rebuild
		oldRtc.close();
		const newConn = createMockBotConn();
		const newRtc = new WebRtcConnection('bot1', newConn, { PeerConnection: MockRTCPeerConnection });
		await newRtc.connect(MOCK_TURN_CREDS);
		const newPc = MockRTCPeerConnection.lastInstance;

		// 先让新 rtc 进入 remoteDescSet=true（否则 rtc:ice 会入暂存队列）
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:answer', payload: { sdp: 'new-ans' } });
		await vi.waitFor(() => {
			expect(newRtc.__remoteDescSet).toBe(true);
		});

		// 发 rtc:ice → 新 PC 收到，旧 PC 一条 candidate 都不收
		const icePayload = { candidate: 'candidate:999', sdpMid: '0', sdpMLineIndex: 0 };
		fireRtcSignal({ clawId: 'bot1', type: 'rtc:ice', payload: icePayload });

		expect(newPc.__candidates).toContainEqual(icePayload);
		expect(oldPc.__candidates).toHaveLength(0);
		// 旧 PC 已 close
		expect(oldPc.__closed).toBe(true);

		newRtc.close();
	});

	test('旧 rtc close 后 __pc=null，迟到 rtc:answer/ice 对旧实例完全 no-op', async () => {
		// 精细场景：即便测试直接调旧实例的 __onSignaling（绕过 signaling 分发），
		// 也不应对已 close 的 PC 产生副作用（optional chaining 护栏）。
		const oldConn = createMockBotConn();
		const oldRtc = new WebRtcConnection('bot1', oldConn, { PeerConnection: MockRTCPeerConnection });
		await oldRtc.connect(MOCK_TURN_CREDS);
		const oldPc = MockRTCPeerConnection.lastInstance;

		oldRtc.close();
		expect(oldRtc.__pc).toBeNull();
		expect(oldPc.__closed).toBe(true);

		// 直接调 __onSignaling 模拟"假如 listener 清理出现竞态"的迟到消息
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		oldRtc.__onSignaling({ type: 'rtc:answer', payload: { sdp: 'late-ans' } });
		oldRtc.__onSignaling({
			type: 'rtc:ice',
			payload: { candidate: 'candidate:late', sdpMid: '0', sdpMLineIndex: 0 },
		});
		// 等一轮 microtask 让 setRemoteDescription Promise 链路走完（__pc?.setRemote... 已是 undefined?.）
		await Promise.resolve();

		// 已关闭的旧 PC 不应被改动
		expect(oldPc.__remoteDesc).toBeNull();
		expect(oldPc.__candidates).toHaveLength(0);
		// setRemoteDescription failed warn 不应被打（__pc?. 短路成 undefined → Promise 调用不发生）
		expect(warnSpy).not.toHaveBeenCalledWith(
			expect.stringContaining('setRemoteDescription failed'),
		);
		warnSpy.mockRestore();
	});

	test('两条 rtc 实例（不同 clawId）共存时，按 clawId 过滤不串台', async () => {
		// __onRtcMsg 内 `if (clawId !== this.clawId) return;` 做过滤
		const connA = createMockBotConn();
		const rtcA = new WebRtcConnection('botA', connA, { PeerConnection: MockRTCPeerConnection });
		await rtcA.connect(MOCK_TURN_CREDS);
		const pcA = MockRTCPeerConnection.lastInstance;

		const connB = createMockBotConn();
		const rtcB = new WebRtcConnection('botB', connB, { PeerConnection: MockRTCPeerConnection });
		await rtcB.connect(MOCK_TURN_CREDS);
		const pcB = MockRTCPeerConnection.lastInstance;

		expect(sigListeners['rtc']?.length).toBe(2);
		expect(pcA).not.toBe(pcB);

		// 针对 botA 发 answer → 仅 pcA 收
		fireRtcSignal({ clawId: 'botA', type: 'rtc:answer', payload: { sdp: 'ans-A' } });
		await vi.waitFor(() => {
			expect(pcA.__remoteDesc).toEqual({ type: 'answer', sdp: 'ans-A' });
		});
		expect(pcB.__remoteDesc).toBeNull();

		// 针对 botB 发 answer → 仅 pcB 收
		fireRtcSignal({ clawId: 'botB', type: 'rtc:answer', payload: { sdp: 'ans-B' } });
		await vi.waitFor(() => {
			expect(pcB.__remoteDesc).toEqual({ type: 'answer', sdp: 'ans-B' });
		});
		// pcA 的 remoteDesc 未被覆盖
		expect(pcA.__remoteDesc).toEqual({ type: 'answer', sdp: 'ans-A' });

		rtcA.close();
		rtcB.close();
		// 两条 listener 均摘除
		expect(sigListeners['rtc']?.length ?? 0).toBe(0);
	});
});

// --- P1-1: resumeRecovery probe 期间 re-offline ---
// 场景：resumeRecovery → __probeNow 发起 probe 后、结果回来前，若再次 pauseRestart
// （claw 再次 offline / sig 再次 offline），probe 的迟到回调不应偷发 ICE restart。
// 防护点：
//   1) __probeNow bump __keepaliveGen=N，__doKeepalive 捕获 gen=N
//   2) pauseRestart → __stopKeepalive 再 bump __keepaliveGen=N+1
//   3) probe settle（超时或 ack）后 __doKeepalive 的 `gen !== this.__keepaliveGen` 提前 return
//      → 不进 __onIceFailed → 不进 __attemptRestart → 即便不靠 pause gate 也已被拦
//   4) pause gate (L975) 作为 defense-in-depth，即使有人漏掉 gen-guard 也能 drop
describe('P1-1: resumeRecovery probe 期间 re-offline', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('probe 未完成期间 claw 再次 offline (pauseRestart)：probe 超时的迟到回调不偷发 ICE restart', async () => {
		// 第一轮 pause（claw offline）→ resumeRecovery 触发 __probeNow（gen=N）
		// 第二轮 pause（claw 再次 offline）→ gen=N+1；probe 超时到来时 gen-guard 拦下
		const { rtc, dc } = await setupConnectedRtc();
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);
		dc.sent.length = 0;
		mockSendSignaling.mockClear();

		// resumeRecovery → __probeNow：发出 probe，__keepaliveGen bump 到 N
		rtc.resumeRecovery();
		expect(rtc.__restartPaused).toBe(false);
		const genAfterResume = rtc.__keepaliveGen;
		// probe 已通过 dc.send 发出（同步）
		const probeMsg = dc.sent.find((d) => {
			try { return JSON.parse(d).type === 'probe'; } catch { return false; }
		});
		expect(probeMsg).toBeTruthy();

		// probe 还没回——此时 claw 再次 offline → pauseRestart
		const epochBeforeRePause = rtc.__restartEpoch;
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);
		// __stopKeepalive bump 了 __keepaliveGen
		expect(rtc.__keepaliveGen).toBe(genAfterResume + 1);
		// pauseRestart 递增 restart epoch
		expect(rtc.__restartEpoch).toBe(epochBeforeRePause + 1);

		// 现在让 probe 超时：DC_KEEPALIVE_TIMEOUT_MS=10_000
		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(0);

		// 迟到的 probe 回调：gen-guard 早退 → 没走到 __onIceFailed → __attemptRestart 未被调
		expect(rtc.state).toBe('connected'); // __setState 未走
		expect(rtc.__restartAttemptCount).toBe(0);
		expect(rtc.__restartOfferSentAt).toBe(0);
		// 没发 ICE restart offer
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(0);
		// pause 状态不被迟到回调误清
		expect(rtc.__restartPaused).toBe(true);
		// keepalive 也没被 schedule（gen 失配 → 不走 __scheduleKeepalive 分支）
		expect(rtc.__keepaliveTimer).toBeNull();

		rtc.close();
	});

	test('probe 未完成期间 sig 再次 offline (pauseRestart)：同样不偷发 ICE restart', async () => {
		// 对称路径：sig offline 由 signaling-connection 的 offline 事件触发 store 调 pauseRestart，
		// 对 rtc 来说与 claw offline 是同一个入口。这里构造 mockSigState='disconnected' 以贴近语义。
		const { rtc, dc } = await setupConnectedRtc();
		rtc.pauseRestart();
		dc.sent.length = 0;
		mockSendSignaling.mockClear();

		rtc.resumeRecovery();
		const genAfterResume = rtc.__keepaliveGen;
		expect(rtc.__restartPaused).toBe(false);
		expect(dc.sent.some((d) => {
			try { return JSON.parse(d).type === 'probe'; } catch { return false; }
		})).toBe(true);

		// sig 再次 offline 模拟：state 切换 + pauseRestart
		mockSigState = 'disconnected';
		const epochBefore = rtc.__restartEpoch;
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__keepaliveGen).toBe(genAfterResume + 1);
		expect(rtc.__restartEpoch).toBe(epochBefore + 1);

		// probe 超时 → 迟到回调
		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(0);

		// gen-guard 拦下：不升级 __onIceFailed
		expect(rtc.state).toBe('connected');
		expect(rtc.__restartAttemptCount).toBe(0);
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(0);
		expect(rtc.__restartPaused).toBe(true);

		mockSigState = 'connected';
		rtc.close();
	});

	test('probe 成功 ack 迟到：gen 失配 → 不调度下一轮 keepalive、不发 offer', async () => {
		// 与失败路径对称：probe 回来是成功的，但 __doKeepalive 第二次 gen-guard（probe 后那个）
		// 同样拦下 → __scheduleKeepalive 不被调 → __keepaliveTimer 保持 null。
		const { rtc, dc } = await setupConnectedRtc();
		rtc.pauseRestart();
		dc.sent.length = 0;
		mockSendSignaling.mockClear();

		rtc.resumeRecovery();
		expect(rtc.__restartPaused).toBe(false);
		const genAfterResume = rtc.__keepaliveGen;
		// __probeNow 把 __keepaliveTimer 清空了
		expect(rtc.__keepaliveTimer).toBeNull();

		// 再次 pause（模拟 probe 在途期间 offline）
		rtc.pauseRestart();
		expect(rtc.__keepaliveGen).toBe(genAfterResume + 1);
		expect(rtc.__restartPaused).toBe(true);

		// 现在对端 ack 迟到
		dc.onmessage({ data: JSON.stringify({ type: 'probe-ack' }) });
		await vi.advanceTimersByTimeAsync(0);

		// __doKeepalive 第二次 gen-guard（probe 成功后那个 L763）拦下
		// → 既不进 !alive 分支、也不进 __scheduleKeepalive 分支
		expect(rtc.__keepaliveTimer).toBeNull();
		// 不发 offer
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(0);
		// state 仍 connected
		expect(rtc.state).toBe('connected');
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__restartAttemptCount).toBe(0);

		rtc.close();
	});

	test('pause 后没有 pause gate 兜底也安全：gen-guard 已经在 pause gate 之前拦截', async () => {
		// 防御纵深验证：即使我们"绕过" gen-guard（手动把 __keepaliveGen 复原，模拟 gen-guard 被未来重构破坏），
		// pause gate（L975）依然拦住 __attemptRestart 不发 offer。用 test.skip 的反面——这里真跑，
		// 断言两道防线独立有效。
		const { rtc, dc } = await setupConnectedRtc();
		rtc.pauseRestart();
		dc.sent.length = 0;
		mockSendSignaling.mockClear();

		rtc.resumeRecovery();
		const genCaptured = rtc.__keepaliveGen; // = N
		expect(dc.sent.some((d) => {
			try { return JSON.parse(d).type === 'probe'; } catch { return false; }
		})).toBe(true);

		// 再次 pause → __stopKeepalive bump 到 N+1，同时 __restartPaused=true
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);

		// 人为把 gen 复原成 N，模拟 gen-guard 不再有效的未来场景
		// （只在本测试内手动改，业务代码不受影响）
		rtc.__keepaliveGen = genCaptured;

		// 让 probe 超时 → __doKeepalive 会走到 !alive 分支 → __onIceFailed → __attemptRestart('ice_failed')
		// pause gate（L975）：reason='ice_failed' !== 'online_resume' 且 paused → drop
		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(0);

		// pause gate 拦住 restart：不发 offer、state 不变
		expect(rtc.state).toBe('connected');
		expect(rtc.__restartAttemptCount).toBe(0);
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(0);
		// paused 标志不被 drop 路径误清
		expect(rtc.__restartPaused).toBe(true);

		rtc.close();
	});

	test('对照：probe 期间不 pause，probe 成功 → 正常 schedule 下一轮 keepalive、state 保持 connected', async () => {
		// 确保测试框架对 probe 的处理没有副作用——无 pause 时 probe 正常走完并 schedule。
		const { rtc, dc } = await setupConnectedRtc();
		rtc.pauseRestart();
		dc.sent.length = 0;
		mockSendSignaling.mockClear();

		rtc.resumeRecovery();
		expect(rtc.__restartPaused).toBe(false);
		const genAfterResume = rtc.__keepaliveGen;
		expect(rtc.__keepaliveTimer).toBeNull();

		// 不再 pause；probe ack 及时回
		dc.onmessage({ data: JSON.stringify({ type: 'probe-ack' }) });
		await vi.advanceTimersByTimeAsync(0);

		// gen 未变 → __doKeepalive 走到健康分支 → __scheduleKeepalive(gen) 重启 timer
		expect(rtc.__keepaliveGen).toBe(genAfterResume);
		expect(rtc.__keepaliveTimer).not.toBeNull();
		expect(rtc.state).toBe('connected');
		// 无 offer
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(0);

		rtc.close();
	});
});

describe('P0-4: connect 跨 await close 防护', () => {
	// 修法：__buildPeerConnection 三处 await（ensureConnected / createOffer /
	// setLocalDescription）后加 state==='closed'/'failed' 守卫；createOffer / SLD 在 closed pc 上
	// 抛 InvalidStateError 时 try/catch 吃掉 + 守卫早退（不让异常穿透到 initRtc 的
	// .then(rtc.connect).catch → 误判建连失败）。

	test('ensureConnected pending 时 close → late resolve 不 setState/创建 PC/sendOffer', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		// ensureConnected 返回手控 promise
		let resolveEnsure;
		mockEnsureConnected.mockImplementationOnce(() => new Promise((r) => { resolveEnsure = r; }));

		const pcCountBefore = pcInstances.length;
		const offerCallsBefore = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer').length;

		const connectPromise = rtc.connect(MOCK_TURN_CREDS);
		// 此时 ensureConnected 未 resolve；state 仍是 idle
		expect(rtc.state).toBe('idle');

		// 主动 close（state → 'closed'）
		rtc.close();
		expect(rtc.state).toBe('closed');

		// late resolve ensureConnected → 守卫看到 state='closed' 应 abort
		resolveEnsure();
		await connectPromise;

		// 断言：没有新 PC、没发新 offer、state 不被复活
		expect(pcInstances.length).toBe(pcCountBefore);
		const offerCallsAfter = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer').length;
		expect(offerCallsAfter).toBe(offerCallsBefore);
		expect(rtc.state).toBe('closed');
		expect(rtc.__pc).toBeNull();
	});

	test('createOffer pending 时 close → late resolve 不 SLD 不 sendOffer', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		// 拦截 createOffer：返回手控 promise
		let resolveCreate;
		const origCreateOffer = MockRTCPeerConnection.prototype.createOffer;
		MockRTCPeerConnection.prototype.createOffer = function () {
			return new Promise((r) => { resolveCreate = r; });
		};

		try {
			const connectPromise = rtc.connect(MOCK_TURN_CREDS);
			// 等到 connect 推进到 await pc.createOffer 阶段（ensureConnected 默认立即 resolve）
			await Promise.resolve();
			await Promise.resolve();
			expect(rtc.state).toBe('connecting');
			const pc = MockRTCPeerConnection.lastInstance;
			const sldCountBefore = pc.localDescription;
			const offerCallsBefore = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer').length;

			// close 期间 createOffer pending
			rtc.close();
			expect(rtc.state).toBe('closed');

			// late resolve createOffer → 守卫应早退
			resolveCreate({ type: 'offer', sdp: 'late-sdp' });
			await connectPromise;

			// 断言：setLocalDescription 未被调（pc.localDescription 不变）；rtc:offer 未发；__pc 已清
			expect(pc.localDescription).toBe(sldCountBefore);
			const offerCallsAfter = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer').length;
			expect(offerCallsAfter).toBe(offerCallsBefore);
			expect(rtc.state).toBe('closed');
			expect(rtc.__pc).toBeNull();
		} finally {
			MockRTCPeerConnection.prototype.createOffer = origCreateOffer;
		}
	});

	test('createOffer pending 时 close → late reject 不 unhandled（异常被 try/catch 吃掉）', async () => {
		// late reject 模拟浏览器在 closed pc 上抛 InvalidStateError；不能让异常穿透到
		// initRtc 的 .then(rtc.connect).catch → 误判建连失败 + clearRtc + 重复退避
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		let rejectCreate;
		const origCreateOffer = MockRTCPeerConnection.prototype.createOffer;
		MockRTCPeerConnection.prototype.createOffer = function () {
			return new Promise((_resolve, reject) => { rejectCreate = reject; });
		};

		try {
			let connectErr = null;
			const connectPromise = rtc.connect(MOCK_TURN_CREDS).catch((err) => { connectErr = err; });
			await Promise.resolve();
			await Promise.resolve();
			const offerCallsBefore = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer').length;

			rtc.close();
			expect(rtc.state).toBe('closed');

			// late reject InvalidStateError
			const invalidErr = new Error('InvalidStateError: pc closed');
			invalidErr.name = 'InvalidStateError';
			rejectCreate(invalidErr);
			await connectPromise;

			// 断言：异常被守卫 try/catch 早退吃掉 → connect 不 reject + 副作用未穿透
			expect(connectErr).toBeNull();
			expect(rtc.state).toBe('closed');
			expect(rtc.__pc).toBeNull();
			const offerCallsAfter = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer').length;
			expect(offerCallsAfter).toBe(offerCallsBefore);
		} finally {
			MockRTCPeerConnection.prototype.createOffer = origCreateOffer;
		}
	});

	test('setLocalDescription pending 时 close → late resolve 不 sendOffer/复活 PC', async () => {
		// 与 createOffer 用例对称：把手控 promise 移到 setLocalDescription（offer 已生成、
		// 但 SLD 卡在 await 阶段）。close 期间晚到的 SLD resolve 必须凭 epoch 守卫早退，
		// 不能继续 sendSignaling('rtc:offer')、不能复活 __pc 或 state
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		let resolveSld;
		const origSld = MockRTCPeerConnection.prototype.setLocalDescription;
		MockRTCPeerConnection.prototype.setLocalDescription = function () {
			return new Promise((r) => { resolveSld = r; });
		};

		try {
			const connectPromise = rtc.connect(MOCK_TURN_CREDS);
			// 推进到 setLocalDescription await：ensureConnected + createOffer 各占一拍 microtask
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(rtc.state).toBe('connecting');
			const pcCountBefore = pcInstances.length;
			const offerCallsBefore = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer').length;

			rtc.close();
			expect(rtc.state).toBe('closed');

			// late resolve SLD → 守卫应早退，不进入 sendSignaling 路径
			resolveSld();
			await connectPromise;

			// 断言：无新 PC、无新 offer、state 不被复活、__pc 已清
			expect(pcInstances.length).toBe(pcCountBefore);
			const offerCallsAfter = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer').length;
			expect(offerCallsAfter).toBe(offerCallsBefore);
			expect(rtc.state).toBe('closed');
			expect(rtc.__pc).toBeNull();
		} finally {
			MockRTCPeerConnection.prototype.setLocalDescription = origSld;
		}
	});

	test('setLocalDescription pending 时 close → late reject InvalidStateError 不穿透成 connect 失败', async () => {
		// 浏览器在已 close 的 pc 上调 setLocalDescription 也会抛 InvalidStateError。
		// 修法：try/catch 包住 SLD await，凭 epoch 早退 → 异常不能穿透到 initRtc 的
		// .then(rtc.connect).catch（否则会走 settle('failed') + clearRtc，触发 store 退避重试）
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });

		let rejectSld;
		const origSld = MockRTCPeerConnection.prototype.setLocalDescription;
		MockRTCPeerConnection.prototype.setLocalDescription = function () {
			return new Promise((_resolve, reject) => { rejectSld = reject; });
		};

		try {
			let connectErr = null;
			const connectPromise = rtc.connect(MOCK_TURN_CREDS).catch((err) => { connectErr = err; });
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			const offerCallsBefore = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer').length;

			rtc.close();
			expect(rtc.state).toBe('closed');

			const invalidErr = new Error('InvalidStateError: pc closed');
			invalidErr.name = 'InvalidStateError';
			rejectSld(invalidErr);
			await connectPromise;

			// 异常被守卫 + try/catch 吞掉，不向上传
			expect(connectErr).toBeNull();
			expect(rtc.state).toBe('closed');
			expect(rtc.__pc).toBeNull();
			const offerCallsAfter = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer').length;
			expect(offerCallsAfter).toBe(offerCallsBefore);
		} finally {
			MockRTCPeerConnection.prototype.setLocalDescription = origSld;
		}
	});
});

describe('P0-5: 主动 close 同步 dc.onclose 不重入', () => {
	// 修法：close() 把 `__rpcChannel = null` 移到 pc.close() 之前；同步 fire 的 dc.onclose 检查
	// `__rpcChannel === dc` 不通过 → short-circuit。同时 close() 顶层接管 __rejectAllPending
	// 调用，避免依赖 dc.onclose 路径。

	test('asFailed=false：pc.close 同步 fire dc.onclose 不二次 sendSignaling("rtc:closed")，最终 state="closed"', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		const dc = pc.__channels[0];
		dc.readyState = 'open';
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		dc.onopen();
		expect(rtc.state).toBe('connected');

		// 让 mock 的 pc.close() 同步 fire dc.onclose（覆盖浏览器同步 fire 行为）
		const origClose = pc.close.bind(pc);
		pc.close = () => {
			origClose();
			dc.readyState = 'closed';
			if (dc.onclose) dc.onclose();
		};

		// 主动 close（asFailed=false）
		const sigCloseBefore = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:closed').length;
		rtc.close({ asFailed: false });

		// 断言：rtc:closed 仅发 1 次（不被同步重入二次发送）
		const sigCloseAfter = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:closed').length;
		expect(sigCloseAfter - sigCloseBefore).toBe(1);
		// state 终态为 'closed'（不被同步重入的 close({asFailed:true}) 翻成 'failed' 再被覆盖）
		expect(rtc.state).toBe('closed');
		expect(rtc.__pc).toBeNull();
		expect(rtc.__rpcChannel).toBeNull();
	});

	test('asFailed=true：pc.close 同步 fire dc.onclose 不重入，最终 state="failed"', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		const dc = pc.__channels[0];
		dc.readyState = 'open';
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		dc.onopen();

		const origClose = pc.close.bind(pc);
		pc.close = () => {
			origClose();
			dc.readyState = 'closed';
			if (dc.onclose) dc.onclose();
		};

		const sigCloseBefore = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:closed').length;
		rtc.close({ asFailed: true });

		const sigCloseAfter = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:closed').length;
		expect(sigCloseAfter - sigCloseBefore).toBe(1);
		expect(rtc.state).toBe('failed');
		expect(rtc.__pc).toBeNull();
		expect(rtc.__rpcChannel).toBeNull();
	});

	test('close() 顶层兜底调 __rejectAllPending（防 dc.onclose short-circuit 后 pending RPC 永不 reject）', async () => {
		const clawConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', clawConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const pc = MockRTCPeerConnection.lastInstance;
		const dc = pc.__channels[0];
		dc.readyState = 'open';
		pc.connectionState = 'connected';
		pc.onconnectionstatechange();
		dc.onopen();

		// pc.close 同步 fire dc.onclose 模拟浏览器
		const origClose = pc.close.bind(pc);
		pc.close = () => {
			origClose();
			dc.readyState = 'closed';
			if (dc.onclose) dc.onclose();
		};

		clawConn.__rejectAllPending.mockClear();
		rtc.close({ asFailed: false });

		// close() 顶层调一次；dc.onclose 同步重入因 __rpcChannel === dc 失败 short-circuit，
		// 不会再调 __rejectAllPending。总次数 1。
		expect(clawConn.__rejectAllPending).toHaveBeenCalledTimes(1);
		expect(clawConn.__rejectAllPending).toHaveBeenCalledWith(expect.any(String), 'DC_CLOSED');
	});
});

// P0-6: paused + online_resume 触发的 __attemptRestart 在 sig.ensureConnected reject 时，
// 应回滚到 paused 原状（恢复 __restartPaused=true、清 timer/poll、重置 __restartStartTime=0），
// 而不是让自动路径继续烧预算
describe('P0-6: online_resume + ensureConnected 失败 → 回到 paused', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('paused 起点 + ensureConnected reject → 回到 paused 原状（清 timer/poll/重置 startTime）', async () => {
		// 推到 restarting + paused
		const { rtc, pc } = await setupConnectedRtc();
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		expect(rtc.state).toBe('restarting');
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__restartTimer).toBeNull();
		expect(rtc.__restartPollTimer).toBeNull();
		expect(rtc.__restartStartTime).toBe(0);

		// sig 不可用：ensureConnected reject
		mockSigState = 'connecting';
		mockEnsureConnected.mockReset();
		mockEnsureConnected.mockRejectedValueOnce(new Error('ws not ready'));
		mockSendSignaling.mockClear();

		// online_resume 入口（白名单 reason 可越过 paused gate）
		rtc.triggerRestart('online_resume');
		// 同步路径：__attemptRestart 进入 sig.ensureConnected await
		await vi.advanceTimersByTimeAsync(0);
		// reject 已抛回 catch 分支，回到 paused
		await Promise.resolve();

		expect(rtc.__restartPaused).toBe(true);
		expect(rtc.__restartTimer).toBeNull();
		expect(rtc.__restartPollTimer).toBeNull();
		expect(rtc.__restartStartTime).toBe(0);
		// 未发出 offer
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(0);

		rtc.close();
	});

	test('从 paused 二次 online_resume + ensureConnected resolve → 正常发 offer（证明可从 paused 重启）', async () => {
		const { rtc, pc } = await setupConnectedRtc();
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
		await vi.advanceTimersByTimeAsync(0);
		rtc.pauseRestart();
		expect(rtc.__restartPaused).toBe(true);

		// 第一次：sig 不通 → 回到 paused
		mockSigState = 'connecting';
		mockEnsureConnected.mockReset();
		mockEnsureConnected.mockRejectedValueOnce(new Error('ws not ready'));
		rtc.triggerRestart('online_resume');
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
		expect(rtc.__restartPaused).toBe(true);

		// 第二次：sig 来了 → ensureConnected resolve，正常发 offer
		mockSigState = 'connecting';
		mockEnsureConnected.mockResolvedValueOnce(undefined);
		mockSendSignaling.mockClear();

		rtc.triggerRestart('online_resume');
		// 让 await ensureConnected 完成
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(0);

		// rtc:offer 被发出（含 iceRestart）
		const offers = mockSendSignaling.mock.calls.filter((c) => c[1] === 'rtc:offer');
		expect(offers).toHaveLength(1);
		expect(offers[0][2]).toEqual(expect.objectContaining({ iceRestart: true }));

		rtc.close();
	});
});
