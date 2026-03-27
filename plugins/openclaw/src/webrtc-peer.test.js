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

test('WebRtcPeer: DataChannel ondatachannel → setupDataChannel (open/close)', async () => {
	const PC = MockPCFactory();
	const logs = [];
	const logger = {
		info: (msg) => logs.push(msg),
		warn: () => {},
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

	const fakeChannel = { label: 'rpc', onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: fakeChannel });

	assert.ok(logs.some((l) => l.includes('DataChannel "rpc" received')));

	// 触发 onopen
	fakeChannel.onopen();
	assert.ok(logs.some((l) => l.includes('DataChannel "rpc" opened')));

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
	assert.ok(warns.some((l) => l.includes('DC message parse failed')));

	await peer.closeAll();
});

test('WebRtcPeer: DataChannel onmessage Buffer data → 正常解析', async () => {
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

	// 模拟 Buffer data
	const reqPayload = { type: 'req', id: 'ui-2', method: 'test', params: {} };
	const buf = Buffer.from(JSON.stringify(reqPayload));
	fakeChannel.onmessage({ data: buf });

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

test('WebRtcPeer: ondatachannel 非 rpc label 不设置 rpcChannel', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_031'));
	const pc = PC.instances[0];

	const fakeChannel = { label: 'file:abc', onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: fakeChannel });

	// rpcChannel 应该仍为 null
	assert.equal(peer.__sessions.get('c_031').rpcChannel, null);

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

	// 设置 nominated
	pc.iceTransports[0].connection.nominated = { localCandidate: { type: 'srflx' } };
	pc.connectionState = 'connected';
	pc.onconnectionstatechange();

	assert.ok(logs.some((l) => l.includes('ICE connected via srflx')));
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

	pc.iceTransports[0].connection.nominated = { localCandidate: {} };
	pc.connectionState = 'connected';
	pc.onconnectionstatechange();

	assert.ok(logs.some((l) => l.includes('ICE connected via unknown')));
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
