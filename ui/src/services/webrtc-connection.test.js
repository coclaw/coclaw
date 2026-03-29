import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	WebRtcConnection,
	initRtc,
	initRtcForBot,
	initRtcAndSelectTransport,
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
		setRtc: vi.fn(),
		clearRtc: vi.fn(),
		__onRtcMessage: vi.fn(),
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
		expect(rtc.transportInfo).toBeNull();
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

	test('connected 后从 getStats 解析 transportInfo (P2P host/udp)', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });
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
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

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
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

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

	test('rtc:ice 在 answer 之后直接添加 ICE candidate', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		// 先设置 answer，等 setRemoteDescription 完成
		botConn.__fire('rtc', { type: 'rtc:answer', payload: { sdp: 'mock-answer-sdp' } });
		await vi.waitFor(() => {
			expect(MockRTCPeerConnection.lastInstance.__remoteDesc).toBeTruthy();
		});

		const icePayload = { candidate: 'candidate:456', sdpMid: '0', sdpMLineIndex: 0 };
		botConn.__fire('rtc', { type: 'rtc:ice', payload: icePayload });

		const pc = MockRTCPeerConnection.lastInstance;
		expect(pc.__candidates).toContainEqual(icePayload);

		rtc.close();
	});

	test('rtc:ice 在 answer 之前暂存，answer 后批量添加', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);

		// answer 到达前先发 ICE candidates
		const ice1 = { candidate: 'candidate:111', sdpMid: '0', sdpMLineIndex: 0 };
		const ice2 = { candidate: 'candidate:222', sdpMid: '0', sdpMLineIndex: 0 };
		botConn.__fire('rtc', { type: 'rtc:ice', payload: ice1 });
		botConn.__fire('rtc', { type: 'rtc:ice', payload: ice2 });

		const pc = MockRTCPeerConnection.lastInstance;
		// answer 前不应添加
		expect(pc.__candidates).toHaveLength(0);

		// answer 到达后触发排空
		botConn.__fire('rtc', { type: 'rtc:answer', payload: { sdp: 'mock-answer-sdp' } });
		await vi.waitFor(() => {
			expect(pc.__candidates).toHaveLength(2);
		});
		expect(pc.__candidates).toContainEqual(ice1);
		expect(pc.__candidates).toContainEqual(ice2);

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
				payload: { sdp: 'mock-sdp-ice-restart', iceRestart: true },
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

	test('ICE restart 达到上限（5次）后执行 full rebuild', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		await rtc.connect(MOCK_TURN_CREDS);
		const firstPc = MockRTCPeerConnection.lastInstance;

		// 消耗 5 次 ICE restart
		for (let i = 1; i <= 5; i++) {
			firstPc.connectionState = 'failed';
			firstPc.onconnectionstatechange();
			await vi.waitFor(() => expect(rtc.__iceRestartCount).toBe(i));
		}

		// 第 6 次 failed → 超过 ICE restart 上限，应 full rebuild
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
		rtc.__iceRestartCount = 5;
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

		// 耗尽 ICE restart (5次) + full rebuild (3次)
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
		rtc.__iceRestartCount = 5;
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
		rtc.__iceRestartCount = 5;
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

describe('WebRtcConnection — tryIceRestart（前台恢复主动 ICE restart）', () => {
	beforeEach(() => {
		MockRTCPeerConnection.lastInstance = null;
		pcInstances.length = 0;
	});

	test('PC 处于 disconnected 时触发 ICE restart 并返回 true', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'disconnected';

		const result = rtc.tryIceRestart();
		expect(result).toBe(true);

		await vi.waitFor(() => {
			expect(botConn.sendRaw).toHaveBeenCalledWith({
				type: 'rtc:offer',
				payload: { sdp: 'mock-sdp-ice-restart', iceRestart: true },
			});
		});

		// 不重建 PeerConnection
		expect(pcInstances.length).toBe(1);
		rtc.close();
	});

	test('PC 处于 connected 时不触发 ICE restart 并返回 false', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'connected';

		const result = rtc.tryIceRestart();
		expect(result).toBe(false);

		rtc.close();
	});

	test('PC 处于 failed 时不触发（由 __onIceFailed 处理）', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'failed';

		const result = rtc.tryIceRestart();
		expect(result).toBe(false);

		rtc.close();
	});

	test('无 PC 时返回 false', () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });

		const result = rtc.tryIceRestart();
		expect(result).toBe(false);
	});

	test('tryIceRestart 不递增 __iceRestartCount（不消耗自动恢复预算）', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'disconnected';
		rtc.tryIceRestart();
		expect(rtc.__iceRestartCount).toBe(0);

		rtc.close();
	});

	test('多次前台恢复 tryIceRestart 不影响 __onIceFailed 的恢复预算', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);

		const pc = MockRTCPeerConnection.lastInstance;
		pc.connectionState = 'disconnected';

		// 模拟多次前台恢复
		rtc.tryIceRestart();
		rtc.tryIceRestart();
		rtc.tryIceRestart();

		// 计数器应始终为 0
		expect(rtc.__iceRestartCount).toBe(0);

		rtc.close();
	});
});

describe('initRtcForBot / closeRtcForBot', () => {
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

	test('initRtcForBot 创建实例并发起连接', async () => {
		const botConn = createMockBotConn();
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockResolvedValue({ data: MOCK_TURN_CREDS });
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;

		try {
			const p = initRtcForBot('bot1', botConn);
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

	test('initRtcForBot 幂等：已有非 closed 实例时跳过', async () => {
		const botConn = createMockBotConn();
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockResolvedValue({ data: MOCK_TURN_CREDS });
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;

		try {
			const p1 = initRtcForBot('bot1', botConn);
			await vi.advanceTimersByTimeAsync(0);
			const first = __getRtcInstance('bot1');
			// 触发 DC open
			const dc = MockRTCPeerConnection.lastInstance.__channels[0];
			dc.readyState = 'open';
			dc.onopen();
			await p1;
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

	test('initRtcForBot TURN 请求失败时清理实例并降级到 WS', async () => {
		const botConn = createMockBotConn();
		const { httpClient } = await import('./http.js');
		const mockGet = vi.spyOn(httpClient, 'get').mockRejectedValue(new Error('network error'));
		const origRTC = globalThis.RTCPeerConnection;
		globalThis.RTCPeerConnection = MockRTCPeerConnection;

		try {
			const p = initRtcForBot('bot1', botConn);
			await vi.advanceTimersByTimeAsync(0);
			await p;
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
			const p = initRtcForBot('bot1', botConn);
			await vi.advanceTimersByTimeAsync(0);
			// 触发 DC open
			const dc = MockRTCPeerConnection.lastInstance.__channels[0];
			dc.readyState = 'open';
			dc.onopen();
			await p;
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

// --- Phase 2: send / isReady / onReady ---

describe('WebRtcConnection — Phase 2 DataChannel 通信', () => {
	beforeEach(() => {
		pcInstances.length = 0;
		MockRTCPeerConnection.lastInstance = null;
	});

	test('send() 通过 DataChannel 发送 JSON（快路径）', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);

		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		dc.readyState = 'open';
		dc.bufferedAmount = 0;

		await rtc.send({ type: 'req', id: '1', method: 'test' });
		expect(dc.sent).toContainEqual(JSON.stringify({ type: 'req', id: '1', method: 'test' }));
	});

	test('send() DC 未 open 时 reject', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);

		// readyState 默认 'connecting'
		await expect(rtc.send({ type: 'req' })).rejects.toThrow('DataChannel not open');
	});

	test('isReady 返回 DataChannel 状态', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);

		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		expect(rtc.isReady).toBe(false); // readyState = 'connecting'

		dc.readyState = 'open';
		expect(rtc.isReady).toBe(true);
	});

	test('dc.onopen 触发 onReady 回调', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });
		const readyFn = vi.fn();
		rtc.onReady = readyFn;
		await rtc.connect(MOCK_TURN_CREDS);

		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		dc.readyState = 'open';
		dc.onopen();

		expect(readyFn).toHaveBeenCalledTimes(1);
		expect(botConn.sendRaw).toHaveBeenCalledWith({ type: 'rtc:ready' });
	});

	test('dc.onmessage 回调 botConn.__onRtcMessage', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);

		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		const payload = { type: 'res', id: 'ui-1', ok: true, payload: {} };
		dc.onmessage({ data: JSON.stringify(payload) });

		expect(botConn.__onRtcMessage).toHaveBeenCalledWith(payload);
	});

	test('dc.onmessage 无效 JSON 不抛异常', async () => {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);

		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		expect(() => dc.onmessage({ data: 'invalid json{' })).not.toThrow();
		expect(botConn.__onRtcMessage).not.toHaveBeenCalled();
	});
});

describe('WebRtcConnection — send 流控', () => {
	/** 高/低水位与源码一致 */
	const HIGH = 1024 * 1024;

	/** 创建已连接的 rtc + open 的 DC */
	async function makeReady() {
		const botConn = createMockBotConn();
		const rtc = new WebRtcConnection('bot1', botConn, { PeerConnection: MockRTCPeerConnection });
		await rtc.connect(MOCK_TURN_CREDS);
		const dc = MockRTCPeerConnection.lastInstance.__channels[0];
		dc.readyState = 'open';
		dc.bufferedAmount = 0;
		return { rtc, dc, botConn };
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

	test('DC close 时 reject 队列中所有消息', async () => {
		const { rtc, dc } = await makeReady();
		dc.bufferedAmount = HIGH;

		const p1 = rtc.send({ seq: 1 });
		const p2 = rtc.send({ seq: 2 });

		dc.readyState = 'closed';
		dc.onclose();

		await expect(p1).rejects.toThrow('DataChannel closed');
		await expect(p2).rejects.toThrow('DataChannel closed');
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

		const botConn = createMockBotConn();

		try {
			const p = initRtc('bot1', botConn);
			await vi.advanceTimersByTimeAsync(0);

			const dc = MockRTCPeerConnection.lastInstance.__channels[0];
			dc.readyState = 'open';
			dc.onopen();
			const result = await p;

			expect(result).toBe('rtc');
			expect(botConn.setRtc).toHaveBeenCalled();
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

		const botConn = createMockBotConn();

		try {
			const p = initRtc('bot2', botConn);
			await vi.advanceTimersByTimeAsync(0);

			await vi.advanceTimersByTimeAsync(15_000);
			const result = await p;

			expect(result).toBe('failed');
			expect(botConn.clearRtc).toHaveBeenCalled();
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

		const botConn = createMockBotConn();

		try {
			const p = initRtc('bot3', botConn);
			await vi.advanceTimersByTimeAsync(0);
			const result = await p;

			expect(result).toBe('failed');
			expect(botConn.clearRtc).toHaveBeenCalled();
		}
		finally {
			globalThis.RTCPeerConnection = origRTC;
			mockGet.mockRestore();
		}
	});
});
