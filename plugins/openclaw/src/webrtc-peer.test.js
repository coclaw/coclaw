import assert from 'node:assert/strict';
import test from 'node:test';

import { WebRtcPeer } from './webrtc-peer.js';

// --- mock helpers ---

function createMockPC() {
	const pc = {
		onicecandidate: null,
		onconnectionstatechange: null,
		ondatachannel: null,
		connectionState: 'new',
		iceTransports: [{ connection: { nominated: null } }],
		setRemoteDescription: async () => {},
		createAnswer: async () => ({ sdp: 'mock-sdp-answer' }),
		setLocalDescription: async () => {},
		addIceCandidate: async () => {},
		close: async () => { pc.connectionState = 'closed'; },
		__constructorArgs: null,
	};
	return pc;
}

function MockPCFactory() {
	const instances = [];
	function PC(opts) {
		const pc = createMockPC();
		pc.__constructorArgs = opts;
		instances.push(pc);
		return pc;
	}
	PC.instances = instances;
	return PC;
}

function silentLogger() {
	return {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
	};
}

function makeOffer(connId, sdp = 'mock-sdp-offer', turnCreds = null) {
	return {
		type: 'rtc:offer',
		fromConnId: connId,
		payload: { sdp },
		turnCreds,
	};
}

// --- tests ---

test('WebRtcPeer: offer → answer 流程', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_001'));

	assert.equal(PC.instances.length, 1);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, 'rtc:answer');
	assert.equal(sent[0].toConnId, 'c_001');
	assert.equal(sent[0].payload.sdp, 'mock-sdp-answer');

	await peer.closeAll();
});

test('WebRtcPeer: TURN 凭证正确构建 iceServers', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	const turnCreds = {
		urls: ['stun:example.com:3478', 'turn:example.com:3478?transport=udp', 'turn:example.com:3478?transport=tcp'],
		username: 'user1',
		credential: 'cred1',
	};
	await peer.handleSignaling(makeOffer('c_002', 'sdp', turnCreds));

	const args = PC.instances[0].__constructorArgs;
	assert.equal(args.iceServers.length, 3);
	// STUN 不带 username/credential
	assert.equal(args.iceServers[0].urls, 'stun:example.com:3478');
	assert.equal(args.iceServers[0].username, undefined);
	// TURN 带 username/credential
	assert.equal(args.iceServers[1].urls, 'turn:example.com:3478?transport=udp');
	assert.equal(args.iceServers[1].username, 'user1');
	assert.equal(args.iceServers[1].credential, 'cred1');
	assert.equal(args.iceServers[2].urls, 'turn:example.com:3478?transport=tcp');
	assert.equal(args.iceServers[2].username, 'user1');

	await peer.closeAll();
});

test('WebRtcPeer: 无 turnCreds 时 iceServers 为空', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_003'));
	assert.deepEqual(PC.instances[0].__constructorArgs.iceServers, []);

	await peer.closeAll();
});

test('WebRtcPeer: ICE candidate 回调 → onSend', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_010'));
	const pc = PC.instances[0];

	// 模拟 ICE candidate
	pc.onicecandidate({ candidate: { candidate: 'cand1', sdpMid: '0', sdpMLineIndex: 0 } });
	assert.equal(sent.length, 2); // answer + ice
	assert.equal(sent[1].type, 'rtc:ice');
	assert.equal(sent[1].toConnId, 'c_010');
	assert.equal(sent[1].payload.candidate, 'cand1');

	// null candidate 应被忽略
	pc.onicecandidate({ candidate: null });
	assert.equal(sent.length, 2);

	await peer.closeAll();
});

test('WebRtcPeer: handleIce 正常添加', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_020'));
	const pc = PC.instances[0];
	let added = false;
	pc.addIceCandidate = async () => { added = true; };

	await peer.handleSignaling({
		type: 'rtc:ice',
		fromConnId: 'c_020',
		payload: { candidate: 'cand', sdpMid: '0', sdpMLineIndex: 0 },
	});
	assert.ok(added);

	await peer.closeAll();
});

test('WebRtcPeer: handleIce 无 session 时忽略', async () => {
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: MockPCFactory(),
	});

	// 不应抛异常
	await peer.handleSignaling({
		type: 'rtc:ice',
		fromConnId: 'c_nonexistent',
		payload: { candidate: 'cand' },
	});
});

test('WebRtcPeer: DataChannel ondatachannel → setupDataChannel (open/close/error)', async () => {
	const PC = MockPCFactory();
	const logs = [];
	const logger = {
		info: (msg) => logs.push(msg),
		warn: (msg) => logs.push(msg),
		error: () => {},
		debug: (msg) => logs.push(msg),
	};
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger,
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_030'));
	const pc = PC.instances[0];

	const fakeChannel = { label: 'rpc', onopen: null, onclose: null, onmessage: null, onerror: null };
	pc.ondatachannel({ channel: fakeChannel });

	assert.ok(logs.some((l) => l.includes('DataChannel "rpc" received')));

	// 触发 onopen
	fakeChannel.onopen();
	assert.ok(logs.some((l) => l.includes('DataChannel "rpc" opened')));

	// 触发 onerror
	fakeChannel.onerror({ message: 'dc-test-err' });
	assert.ok(logs.some((l) => l.includes('DataChannel "rpc" error') && l.includes('dc-test-err')), 'should log DC error');

	// 触发 onclose
	fakeChannel.onclose();
	assert.ok(logs.some((l) => l.includes('DataChannel "rpc" closed')));

	await peer.closeAll();
});

test('WebRtcPeer: DataChannel onmessage req → onRequest 回调', async () => {
	const PC = MockPCFactory();
	const requests = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		onRequest: (payload, connId) => requests.push({ payload, connId }),
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_030a'));
	const pc = PC.instances[0];
	const fakeChannel = { label: 'rpc', onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: fakeChannel });

	const reqPayload = { type: 'req', id: 'ui-1', method: 'agent', params: { text: 'hi' } };
	fakeChannel.onmessage({ data: JSON.stringify(reqPayload) });

	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0].payload, reqPayload);
	assert.equal(requests[0].connId, 'c_030a');

	await peer.closeAll();
});

test('WebRtcPeer: DataChannel onmessage 非 req 类型 → debug 日志', async () => {
	const PC = MockPCFactory();
	const logs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: (m) => logs.push(m) },
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_030b'));
	const pc = PC.instances[0];
	const fakeChannel = { label: 'rpc', onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: fakeChannel });

	fakeChannel.onmessage({ data: JSON.stringify({ type: 'event', event: 'test' }) });
	assert.ok(logs.some((l) => l.includes('unknown DC message type: event')));

	await peer.closeAll();
});

test('WebRtcPeer: DataChannel onmessage 无效 JSON → warn', async () => {
	const PC = MockPCFactory();
	const warns = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {}, debug: () => {} },
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_030c'));
	const pc = PC.instances[0];
	const fakeChannel = { label: 'rpc', onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: fakeChannel });

	fakeChannel.onmessage({ data: 'not-json' });
	assert.ok(warns.some((l) => l.includes('DC message error')));

	await peer.closeAll();
});

test('WebRtcPeer: DataChannel onmessage string data → reassembler 正常解析', async () => {
	const PC = MockPCFactory();
	const requests = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		onRequest: (payload, connId) => requests.push({ payload, connId }),
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_030d'));
	const pc = PC.instances[0];
	const fakeChannel = { label: 'rpc', onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: fakeChannel });

	// werift DataChannel 对 string PPID 传递 string 类型
	const reqPayload = { type: 'req', id: 'ui-2', method: 'test', params: {} };
	fakeChannel.onmessage({ data: JSON.stringify(reqPayload) });

	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0].payload, reqPayload);

	await peer.closeAll();
});

test('WebRtcPeer: 无 onRequest 时 req 消息不崩溃', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		// 不传 onRequest
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_030e'));
	const pc = PC.instances[0];
	const fakeChannel = { label: 'rpc', onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: fakeChannel });

	// 不应抛异常
	fakeChannel.onmessage({ data: JSON.stringify({ type: 'req', id: 'x', method: 'test' }) });

	await peer.closeAll();
});

test('WebRtcPeer: ondatachannel file:* label → onFileChannel 回调', async () => {
	const PC = MockPCFactory();
	const fileDCs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		onFileChannel: (dc, connId) => fileDCs.push({ dc, connId }),
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_031'));
	const pc = PC.instances[0];

	const fakeChannel = { label: 'file:abc', onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: fakeChannel });

	// rpcChannel 应该仍为 null
	assert.equal(peer.__sessions.get('c_031').rpcChannel, null);
	// onFileChannel 应被调用
	assert.equal(fileDCs.length, 1);
	assert.equal(fileDCs[0].dc, fakeChannel);
	assert.equal(fileDCs[0].connId, 'c_031');

	await peer.closeAll();
});

test('WebRtcPeer: ondatachannel file:* 无 onFileChannel 回调时不崩溃', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_031b'));
	const pc = PC.instances[0];
	const fakeChannel = { label: 'file:xyz', onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: fakeChannel });

	// 不应抛异常
	assert.equal(peer.__sessions.get('c_031b').rpcChannel, null);
	await peer.closeAll();
});

test('WebRtcPeer: ondatachannel 未知 label 不设置 rpcChannel', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_031c'));
	const pc = PC.instances[0];
	const fakeChannel = { label: 'other:channel', onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: fakeChannel });

	assert.equal(peer.__sessions.get('c_031c').rpcChannel, null);
	await peer.closeAll();
});

test('WebRtcPeer: connectionState connected 记录 candidate 类型', async () => {
	const PC = MockPCFactory();
	const logs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {}, debug: () => {} },
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_040'));
	const pc = PC.instances[0];

	// 设置 nominated（含 local + remote 候选信息）
	pc.iceTransports[0].connection.nominated = {
		localCandidate: { type: 'srflx', host: '1.2.3.4', port: 12345 },
		remoteCandidate: { type: 'host', host: '192.168.0.1', port: 54321 },
	};
	pc.connectionState = 'connected';
	pc.onconnectionstatechange();

	assert.ok(logs.some((l) => l.includes('ICE nominated: local=srflx 1.2.3.4:12345 remote=host 192.168.0.1:54321')));
});

test('WebRtcPeer: connectionState connected 无 nominated 不崩溃', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_041'));
	const pc = PC.instances[0];

	pc.connectionState = 'connected';
	pc.onconnectionstatechange(); // 不应抛异常
});

test('WebRtcPeer: connectionState connected 有 nominated 但无 localCandidate.type → unknown', async () => {
	const PC = MockPCFactory();
	const logs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {}, debug: () => {} },
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_042'));
	const pc = PC.instances[0];

	pc.iceTransports[0].connection.nominated = { localCandidate: {}, remoteCandidate: {} };
	pc.connectionState = 'connected';
	pc.onconnectionstatechange();

	assert.ok(logs.some((l) => l.includes('ICE nominated: local=? ?:? remote=? ?:?')));
});

test('WebRtcPeer: connectionState failed/closed 清理 session', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_050'));
	assert.ok(peer.__sessions.has('c_050'));

	const pc = PC.instances[0];
	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	assert.ok(!peer.__sessions.has('c_050'));
});

test('WebRtcPeer: connectionState closed 清理 session', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_051'));
	const pc = PC.instances[0];
	pc.connectionState = 'closed';
	pc.onconnectionstatechange();
	assert.ok(!peer.__sessions.has('c_051'));
});

test('WebRtcPeer: 重复 offer 同一 connId → 先关闭旧连接', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_060'));
	assert.equal(PC.instances.length, 1);

	await peer.handleSignaling(makeOffer('c_060'));
	assert.equal(PC.instances.length, 2);
	// 旧 PC 应已 close
	assert.equal(PC.instances[0].connectionState, 'closed');

	await peer.closeAll();
});

test('WebRtcPeer: 多 connId 并发', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_070'));
	await peer.handleSignaling(makeOffer('c_071'));
	assert.equal(peer.__sessions.size, 2);
	assert.equal(PC.instances.length, 2);

	await peer.closeByConnId('c_070');
	assert.equal(peer.__sessions.size, 1);
	assert.ok(!peer.__sessions.has('c_070'));
	assert.ok(peer.__sessions.has('c_071'));

	await peer.closeAll();
	assert.equal(peer.__sessions.size, 0);
});

test('WebRtcPeer: closeByConnId 不存在的 connId 不报错', async () => {
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: MockPCFactory(),
	});
	await peer.closeByConnId('c_nonexistent'); // 不应抛异常
});

test('WebRtcPeer: closeAll 空 sessions', async () => {
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: MockPCFactory(),
	});
	await peer.closeAll(); // 不应抛异常
});

test('WebRtcPeer: rtc:ready 仅日志', async () => {
	const logs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: (m) => logs.push(m) },
		PeerConnection: MockPCFactory(),
	});

	await peer.handleSignaling({ type: 'rtc:ready', fromConnId: 'c_080' });
	assert.ok(logs.some((l) => l.includes('rtc:ready from c_080')));
});

test('WebRtcPeer: rtc:closed 触发 closeByConnId', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_090'));
	assert.ok(peer.__sessions.has('c_090'));

	await peer.handleSignaling({ type: 'rtc:closed', fromConnId: 'c_090' });
	assert.ok(!peer.__sessions.has('c_090'));
});

test('WebRtcPeer: DataChannel onclose 清除 rpcChannel', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_100'));
	const pc = PC.instances[0];

	const fakeChannel = { label: 'rpc', onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: fakeChannel });
	assert.equal(peer.__sessions.get('c_100').rpcChannel, fakeChannel);

	fakeChannel.onclose();
	assert.equal(peer.__sessions.get('c_100').rpcChannel, null);

	await peer.closeAll();
});

test('WebRtcPeer: broadcast 发送到所有已打开的 rpcChannel', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_b01'));
	await peer.handleSignaling(makeOffer('c_b02'));

	const sentByChannel = { c_b01: [], c_b02: [] };
	const dc1 = { label: 'rpc', readyState: 'open', send: (d) => sentByChannel.c_b01.push(d), onopen: null, onclose: null, onmessage: null };
	const dc2 = { label: 'rpc', readyState: 'open', send: (d) => sentByChannel.c_b02.push(d), onopen: null, onclose: null, onmessage: null };
	PC.instances[0].ondatachannel({ channel: dc1 });
	PC.instances[1].ondatachannel({ channel: dc2 });

	const payload = { type: 'event', event: 'agent', payload: { runId: 'r1' } };
	peer.broadcast(payload);

	const expected = JSON.stringify(payload);
	assert.equal(sentByChannel.c_b01.length, 1);
	assert.equal(sentByChannel.c_b01[0], expected);
	assert.equal(sentByChannel.c_b02.length, 1);
	assert.equal(sentByChannel.c_b02[0], expected);

	await peer.closeAll();
});

test('WebRtcPeer: broadcast 跳过未打开的 rpcChannel', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_b10'));
	// rpcChannel 为 null（未触发 ondatachannel）
	peer.broadcast({ type: 'res', id: 'x' });
	// 不应报错

	// 设置一个 readyState !== 'open' 的 channel
	const dc = { label: 'rpc', readyState: 'connecting', send: () => { throw new Error('should not send'); }, onopen: null, onclose: null, onmessage: null };
	PC.instances[0].ondatachannel({ channel: dc });
	peer.broadcast({ type: 'res', id: 'x' });
	// 不应报错

	await peer.closeAll();
});

test('WebRtcPeer: broadcast send 失败时不抛异常', async () => {
	const PC = MockPCFactory();
	const logs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: (m) => logs.push(m) },
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_b20'));
	const dc = { label: 'rpc', readyState: 'open', send: () => { throw new Error('dc send error'); }, onopen: null, onclose: null, onmessage: null };
	PC.instances[0].ondatachannel({ channel: dc });

	peer.broadcast({ type: 'res', id: 'y' });
	assert.ok(logs.some((l) => l.includes('broadcast send failed')));

	await peer.closeAll();
});

test('WebRtcPeer: broadcast 空 sessions 不报错', () => {
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: MockPCFactory(),
	});
	peer.broadcast({ type: 'res', id: 'z' }); // 不应抛异常
});

test('WebRtcPeer: __logDebug 无 debug 方法时不报错', async () => {
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {} }, // 无 debug
		PeerConnection: MockPCFactory(),
	});

	// 直接调用 __logDebug 不应抛异常
	peer.__logDebug('test message');
});

test('WebRtcPeer: SDP 协商失败时清理 session', async () => {
	// 使用 function 声明以支持 new 调用
	function FailPC() {
		const pc = createMockPC();
		pc.setRemoteDescription = async () => { throw new Error('invalid SDP'); };
		return pc;
	}
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: FailPC,
	});

	await assert.rejects(
		() => peer.handleSignaling(makeOffer('c_sdp_fail')),
		{ message: 'invalid SDP' },
	);
	// session 应已被清理
	assert.equal(peer.__sessions.has('c_sdp_fail'), false);
});

test('WebRtcPeer: createAnswer 失败时清理 session', async () => {
	function FailPC() {
		const pc = createMockPC();
		pc.createAnswer = async () => { throw new Error('answer failed'); };
		return pc;
	}
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: FailPC,
	});

	await assert.rejects(
		() => peer.handleSignaling(makeOffer('c_ans_fail')),
		{ message: 'answer failed' },
	);
	assert.equal(peer.__sessions.has('c_ans_fail'), false);
});

test('WebRtcPeer: 默认 logger 为 console', () => {
	const peer = new WebRtcPeer({
		onSend: () => {},
		PeerConnection: MockPCFactory(),
	});
	assert.equal(peer.logger, console);
});

// --- coclaw.files.* RPC 拦截 ---

test('WebRtcPeer: coclaw.files.* req → onFileRpc 回调（不转发 onRequest）', async () => {
	const PC = MockPCFactory();
	const requests = [];
	const fileRpcs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		onRequest: (payload) => requests.push(payload),
		onFileRpc: (payload, sendFn, connId) => fileRpcs.push({ payload, sendFn, connId }),
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_file_01'));
	const pc = PC.instances[0];
	const fakeChannel = { label: 'rpc', onopen: null, onclose: null, onmessage: null, send: () => {} };
	pc.ondatachannel({ channel: fakeChannel });

	const fileReq = { type: 'req', id: 'f1', method: 'coclaw.files.list', params: { path: '.' } };
	fakeChannel.onmessage({ data: JSON.stringify(fileReq) });

	assert.equal(fileRpcs.length, 1);
	assert.deepEqual(fileRpcs[0].payload, fileReq);
	assert.equal(fileRpcs[0].connId, 'c_file_01');
	assert.equal(typeof fileRpcs[0].sendFn, 'function');

	// 不应转发到 onRequest
	assert.equal(requests.length, 0);

	await peer.closeAll();
});

test('WebRtcPeer: coclaw.files.* sendFn 发送响应到 DC', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		onFileRpc: (payload, sendFn) => {
			sendFn({ type: 'res', id: payload.id, ok: true, payload: { files: [] } });
		},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_file_02'));
	const pc = PC.instances[0];
	const sent = [];
	const fakeChannel = { label: 'rpc', onopen: null, onclose: null, onmessage: null, send: (d) => sent.push(d) };
	pc.ondatachannel({ channel: fakeChannel });

	fakeChannel.onmessage({ data: JSON.stringify({ type: 'req', id: 'f2', method: 'coclaw.files.list', params: {} }) });

	assert.equal(sent.length, 1);
	const res = JSON.parse(sent[0]);
	assert.equal(res.ok, true);
	assert.equal(res.id, 'f2');

	await peer.closeAll();
});

test('WebRtcPeer: coclaw.files.* sendFn DC 关闭时不崩溃', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		onFileRpc: (payload, sendFn) => {
			sendFn({ type: 'res', id: payload.id, ok: true });
		},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_file_03'));
	const pc = PC.instances[0];
	const fakeChannel = {
		label: 'rpc', onopen: null, onclose: null, onmessage: null,
		send: () => { throw new Error('DC closed'); },
	};
	pc.ondatachannel({ channel: fakeChannel });

	// 不应抛异常
	fakeChannel.onmessage({ data: JSON.stringify({ type: 'req', id: 'f3', method: 'coclaw.files.delete', params: {} }) });

	await peer.closeAll();
});

test('WebRtcPeer: 非 coclaw.files.* req 仍走 onRequest', async () => {
	const PC = MockPCFactory();
	const requests = [];
	const fileRpcs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		onRequest: (payload) => requests.push(payload),
		onFileRpc: (payload, _sendFn) => fileRpcs.push(payload),
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_file_04'));
	const pc = PC.instances[0];
	const fakeChannel = { label: 'rpc', onopen: null, onclose: null, onmessage: null, send: () => {} };
	pc.ondatachannel({ channel: fakeChannel });

	fakeChannel.onmessage({ data: JSON.stringify({ type: 'req', id: 'x1', method: 'agent', params: {} }) });

	assert.equal(requests.length, 1);
	assert.equal(fileRpcs.length, 0);

	await peer.closeAll();
});

test('WebRtcPeer: coclaw.files.* 无 onFileRpc 时走 onRequest', async () => {
	const PC = MockPCFactory();
	const requests = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		onRequest: (payload) => requests.push(payload),
		// 不传 onFileRpc
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_file_05'));
	const pc = PC.instances[0];
	const fakeChannel = { label: 'rpc', onopen: null, onclose: null, onmessage: null, send: () => {} };
	pc.ondatachannel({ channel: fakeChannel });

	fakeChannel.onmessage({ data: JSON.stringify({ type: 'req', id: 'x2', method: 'coclaw.files.list', params: {} }) });

	// 无 onFileRpc 时走 onRequest
	assert.equal(requests.length, 1);

	await peer.closeAll();
});

// --- ICE restart 测试 ---

test('WebRtcPeer: ICE restart offer 复用现有 PC', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
	});

	// 先建立正常连接
	await peer.handleSignaling(makeOffer('c_ir01'));
	assert.equal(PC.instances.length, 1);
	const firstPc = PC.instances[0];
	sent.length = 0;

	// 发送 ICE restart offer
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_ir01',
		payload: { sdp: 'ice-restart-sdp', iceRestart: true },
	});

	// 不应创建新 PC
	assert.equal(PC.instances.length, 1);
	// 应在现有 PC 上设置新的 remote description
	assert.equal(firstPc.setRemoteDescription.__called, undefined);
	// 应发送 answer
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, 'rtc:answer');
	assert.equal(sent[0].toConnId, 'c_ir01');

	await peer.closeAll();
});

test('WebRtcPeer: ICE restart 无现有 session 时回退到 full rebuild', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
	});

	// 直接发送 ICE restart offer（无现有 session）
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_ir02',
		payload: { sdp: 'ice-restart-sdp', iceRestart: true },
	});

	// 应创建新 PC（full rebuild 回退）
	assert.equal(PC.instances.length, 1);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, 'rtc:answer');

	await peer.closeAll();
});

test('WebRtcPeer: ICE restart 协商失败时回退到 full rebuild', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
	});

	// 先建立正常连接
	await peer.handleSignaling(makeOffer('c_ir03'));
	const firstPc = PC.instances[0];
	// 让现有 PC 的 setRemoteDescription 失败
	firstPc.setRemoteDescription = async () => { throw new Error('ICE restart SDP failed'); };
	sent.length = 0;

	// 发送 ICE restart offer
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_ir03',
		payload: { sdp: 'bad-sdp', iceRestart: true },
	});

	// 应回退创建新 PC
	assert.equal(PC.instances.length, 2);
	// 旧 PC 应已关闭
	assert.equal(firstPc.connectionState, 'closed');
	// 新 PC 应发送 answer
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, 'rtc:answer');

	await peer.closeAll();
});

// --- 竞态保护测试 ---

test('WebRtcPeer: closeByConnId detach 事件防止旧 PC 回调影响新 session', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_race01'));
	const oldPc = PC.instances[0];

	// 重复 offer 同一 connId → 关闭旧 PC，创建新 PC
	await peer.handleSignaling(makeOffer('c_race01'));
	assert.equal(PC.instances.length, 2);

	// 旧 PC 的 onconnectionstatechange 应已被 detach
	assert.equal(oldPc.onconnectionstatechange, null);
	assert.equal(oldPc.onicecandidate, null);

	// 新 session 应存在
	assert.ok(peer.__sessions.has('c_race01'));
	assert.equal(peer.__sessions.get('c_race01').pc, PC.instances[1]);

	await peer.closeAll();
});

test('WebRtcPeer: closeByConnId detach 后旧 PC handler 为 null', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_race02'));
	const oldPc = PC.instances[0];
	// handler 初始不为 null
	assert.ok(oldPc.onconnectionstatechange !== null);
	assert.ok(oldPc.onicecandidate !== null);

	// 重复 offer → closeByConnId detach 旧 PC
	await peer.handleSignaling(makeOffer('c_race02'));
	const newPc = PC.instances[1];

	// 旧 PC 的 handler 应被 detach
	assert.equal(oldPc.onconnectionstatechange, null);
	assert.equal(oldPc.onicecandidate, null);

	// 新 session 仍正常
	assert.ok(peer.__sessions.has('c_race02'));
	assert.equal(peer.__sessions.get('c_race02').pc, newPc);

	await peer.closeAll();
});

test('WebRtcPeer: onconnectionstatechange pc 不匹配时不删除 session', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_race03'));
	const pc = PC.instances[0];
	const handler = pc.onconnectionstatechange;

	// 手动替换 session 中的 pc（模拟竞态后的状态）
	const fakePc = createMockPC();
	peer.__sessions.set('c_race03', { pc: fakePc, rpcChannel: null });

	// 旧 pc 的 handler 触发 failed
	pc.connectionState = 'failed';
	handler();

	// session 不应被删除（因为 pc !== cur.pc）
	assert.ok(peer.__sessions.has('c_race03'));
	assert.equal(peer.__sessions.get('c_race03').pc, fakePc);

	await peer.closeAll();
});

test('WebRtcPeer: SDP 协商失败清理时也校验 pc 归属', async () => {
	const PC = MockPCFactory();
	let callCount = 0;
	function ConditionalFailPC(opts) {
		callCount++;
		const pc = createMockPC();
		pc.__constructorArgs = opts;
		if (callCount === 2) {
			pc.setRemoteDescription = async () => { throw new Error('SDP fail'); };
		}
		PC.instances.push(pc);
		return pc;
	}

	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: ConditionalFailPC,
	});

	// 第一次正常
	await peer.handleSignaling(makeOffer('c_race04'));
	assert.ok(peer.__sessions.has('c_race04'));

	// 第二次同一 connId 但 SDP 失败
	await assert.rejects(
		() => peer.handleSignaling(makeOffer('c_race04')),
		{ message: 'SDP fail' },
	);
	// session 应被清理（第二个 PC 失败）
	assert.equal(peer.__sessions.has('c_race04'), false);
});

// --- DataChannel 分片/重组测试 ---

import { HEADER_SIZE, FLAG_BEGIN, FLAG_END, FLAG_MIDDLE } from './utils/dc-chunking.js';

test('WebRtcPeer: broadcast 小消息不分片，直接 send string', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC });
	await peer.handleSignaling(makeOffer('c_chunk01', 'v=0\r\na=max-message-size:262144\r\n'));
	const pc = PC.instances[0];
	const sent = [];
	const dc = { label: 'rpc', readyState: 'open', send: (d) => sent.push(d), onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: dc });

	peer.broadcast({ type: 'event', event: 'ping' });
	assert.equal(sent.length, 1);
	assert.equal(typeof sent[0], 'string');
	await peer.closeAll();
});

test('WebRtcPeer: broadcast 大消息自动分片', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC });
	// 设置很小的 maxMessageSize 以触发分片
	await peer.handleSignaling(makeOffer('c_chunk02', 'v=0\r\na=max-message-size:50\r\n'));
	const pc = PC.instances[0];
	const sent = [];
	const dc = { label: 'rpc', readyState: 'open', send: (d) => sent.push(d), onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: dc });

	const largePayload = { type: 'res', data: 'X'.repeat(200) };
	peer.broadcast(largePayload);

	// 应该分片（多个 Buffer）
	assert.ok(sent.length > 1);
	assert.ok(Buffer.isBuffer(sent[0]));
	assert.equal(sent[0][0], FLAG_BEGIN);
	assert.equal(sent[sent.length - 1][0], FLAG_END);

	// 每个 chunk ≤ maxMessageSize
	for (const chunk of sent) {
		assert.ok(chunk.length <= 50);
	}

	await peer.closeAll();
});

test('WebRtcPeer: broadcast 多连接不同 maxMessageSize，各自分片', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC });

	// 连接 1：maxMessageSize=50（小，需要更多 chunk）
	await peer.handleSignaling(makeOffer('c_chunk03a', 'v=0\r\na=max-message-size:50\r\n'));
	const sent1 = [];
	const dc1 = { label: 'rpc', readyState: 'open', send: (d) => sent1.push(d), onopen: null, onclose: null, onmessage: null };
	PC.instances[0].ondatachannel({ channel: dc1 });

	// 连接 2：maxMessageSize=200（大，需要更少 chunk）
	await peer.handleSignaling(makeOffer('c_chunk03b', 'v=0\r\na=max-message-size:200\r\n'));
	const sent2 = [];
	const dc2 = { label: 'rpc', readyState: 'open', send: (d) => sent2.push(d), onopen: null, onclose: null, onmessage: null };
	PC.instances[1].ondatachannel({ channel: dc2 });

	peer.broadcast({ type: 'res', data: 'Y'.repeat(150) });

	assert.ok(sent1.length > sent2.length, `conn1 should have more chunks: ${sent1.length} vs ${sent2.length}`);

	await peer.closeAll();
});

test('WebRtcPeer: SDP 无 max-message-size 时默认 65536', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC });
	await peer.handleSignaling(makeOffer('c_chunk04', 'v=0\r\n')); // 无 max-message-size
	const session = peer.__sessions.get('c_chunk04');
	assert.equal(session.remoteMaxMessageSize, 65536);
	await peer.closeAll();
});

test('WebRtcPeer: SDP 中正确提取 max-message-size 值', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC });
	await peer.handleSignaling(makeOffer('c_chunk05', 'v=0\r\na=max-message-size:131072\r\n'));
	const session = peer.__sessions.get('c_chunk05');
	assert.equal(session.remoteMaxMessageSize, 131072);
	await peer.closeAll();
});

test('WebRtcPeer: 接收端重组分片消息 → onRequest 收到完整 payload', async () => {
	const PC = MockPCFactory();
	const requests = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		onRequest: (payload, connId) => requests.push({ payload, connId }),
		logger: silentLogger(),
		PeerConnection: PC,
	});
	await peer.handleSignaling(makeOffer('c_chunk06'));
	const pc = PC.instances[0];
	const dc = { label: 'rpc', readyState: 'open', send: () => {}, onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: dc });

	// 构造分片 chunk 序列
	const original = JSON.stringify({ type: 'req', id: 'ui-99', method: 'test.large', params: { data: 'Z'.repeat(200) } });
	const bytes = Buffer.from(original, 'utf8');
	const chunkSize = 50;
	const total = Math.ceil(bytes.length / chunkSize);

	for (let i = 0; i < total; i++) {
		const start = i * chunkSize;
		const end = Math.min(start + chunkSize, bytes.length);
		const flag = i === 0 ? FLAG_BEGIN : (i === total - 1 ? FLAG_END : FLAG_MIDDLE);
		const chunk = Buffer.allocUnsafe(HEADER_SIZE + (end - start));
		chunk[0] = flag;
		chunk.writeUInt32BE(1, 1); // msgId=1
		bytes.copy(chunk, HEADER_SIZE, start, end);
		dc.onmessage({ data: chunk });
	}

	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0].payload, JSON.parse(original));
	await peer.closeAll();
});

test('WebRtcPeer: 分片 chunk 中夹杂普通 string 消息，各自正确处理', async () => {
	const PC = MockPCFactory();
	const requests = [];
	const debugMsgs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		onRequest: (payload) => requests.push(payload),
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: (m) => debugMsgs.push(m) },
		PeerConnection: PC,
	});
	await peer.handleSignaling(makeOffer('c_chunk07'));
	const pc = PC.instances[0];
	const dc = { label: 'rpc', readyState: 'open', send: () => {}, onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: dc });

	// 大消息分 2 个 chunk
	const largeMsg = JSON.stringify({ type: 'req', id: 'ui-big', method: 'big', params: { d: 'A'.repeat(100) } });
	const bytes = Buffer.from(largeMsg, 'utf8');
	const mid = Math.floor(bytes.length / 2);

	// 小消息（普通 string）
	const smallMsg = JSON.stringify({ type: 'req', id: 'ui-small', method: 'small', params: {} });

	// BEGIN chunk
	const begin = Buffer.allocUnsafe(HEADER_SIZE + mid);
	begin[0] = FLAG_BEGIN;
	begin.writeUInt32BE(1, 1);
	bytes.copy(begin, HEADER_SIZE, 0, mid);
	dc.onmessage({ data: begin });

	// 中间插入普通消息
	dc.onmessage({ data: smallMsg });

	// END chunk
	const end = Buffer.allocUnsafe(HEADER_SIZE + (bytes.length - mid));
	end[0] = FLAG_END;
	end.writeUInt32BE(1, 1);
	bytes.copy(end, HEADER_SIZE, mid);
	dc.onmessage({ data: end });

	// 应收到 2 条请求：先是小消息（string 立即交付），再是大消息（END 时交付）
	assert.equal(requests.length, 2);
	assert.equal(requests[0].method, 'small');
	assert.equal(requests[1].method, 'big');
	await peer.closeAll();
});

test('WebRtcPeer: sendFn 大响应也会分片', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		onFileRpc: (payload, sendFn) => {
			// 模拟回复大响应
			sendFn({ type: 'res', id: payload.id, data: 'R'.repeat(200) });
		},
		logger: silentLogger(),
		PeerConnection: PC,
	});
	await peer.handleSignaling(makeOffer('c_chunk08', 'v=0\r\na=max-message-size:80\r\n'));
	const pc = PC.instances[0];
	const sent = [];
	const dc = { label: 'rpc', readyState: 'open', send: (d) => sent.push(d), onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: dc });

	// 发送 file RPC 请求
	dc.onmessage({ data: JSON.stringify({ type: 'req', id: 'ui-f1', method: 'coclaw.files.read', params: {} }) });

	// sendFn 回复的大响应应该被分片
	assert.ok(sent.length > 1, `should be chunked, got ${sent.length} sends`);
	assert.ok(Buffer.isBuffer(sent[0]));
	assert.equal(sent[0][0], FLAG_BEGIN);
	assert.equal(sent[sent.length - 1][0], FLAG_END);
	await peer.closeAll();
});

test('WebRtcPeer: DataChannel onclose 时清理 reassembler', async () => {
	const PC = MockPCFactory();
	const requests = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		onRequest: (payload) => requests.push(payload),
		logger: silentLogger(),
		PeerConnection: PC,
	});
	await peer.handleSignaling(makeOffer('c_chunk09'));
	const pc = PC.instances[0];
	const dc = { label: 'rpc', readyState: 'open', send: () => {}, onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: dc });

	// 发 BEGIN 不发 END
	const begin = Buffer.allocUnsafe(HEADER_SIZE + 5);
	begin[0] = FLAG_BEGIN;
	begin.writeUInt32BE(1, 1);
	begin.write('hello', HEADER_SIZE);
	dc.onmessage({ data: begin });

	// 触发 onclose → reassembler 应被 reset
	dc.onclose();

	// 后续 END 不应重组（reassembler 已清空）
	const end = Buffer.allocUnsafe(HEADER_SIZE + 5);
	end[0] = FLAG_END;
	end.writeUInt32BE(1, 1);
	end.write('world', HEADER_SIZE);
	dc.onmessage({ data: end });

	assert.equal(requests.length, 0);
	await peer.closeAll();
});
