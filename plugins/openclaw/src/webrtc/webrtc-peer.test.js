import assert from 'node:assert/strict';
import test from 'node:test';

import { WebRtcPeer, FAILED_SESSION_TTL_MS, MAX_SESSIONS } from './webrtc-peer.js';
import { __reset as resetRemoteLog, __buffer as remoteLogBuffer } from '../remote-log.js';

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

/**
 * 创建 rpc DC 的完整 mock，含 RpcSendQueue 所需的属性（bufferedAmount 等）
 * 用于涉及 broadcast / sendFn 的测试
 */
function makeMockRpcDc(overrides = {}) {
	const dc = {
		label: 'rpc',
		readyState: 'open',
		bufferedAmount: 0,
		bufferedAmountLowThreshold: 0,
		onopen: null,
		onclose: null,
		onmessage: null,
		onerror: null,
		onbufferedamountlow: null,
		send() {},
	};
	return Object.assign(dc, overrides);
}

// --- tests ---

test('WebRtcPeer: constructor throws when PeerConnection is not provided', () => {
	assert.throws(
		() => new WebRtcPeer({ onSend: () => {} }),
		{ message: 'PeerConnection constructor is required' },
	);
});

test('WebRtcPeer: offer → answer 流程', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
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
		impl: 'ndc',
	});

	const turnCreds = {
		urls: ['turn:example.com:3478?transport=udp', 'turn:example.com:3478?transport=tcp', 'turns:example.com:443?transport=tcp'],
		username: 'user1',
		credential: 'cred1',
	};
	await peer.handleSignaling(makeOffer('c_002', 'sdp', turnCreds));

	const args = PC.instances[0].__constructorArgs;
	assert.equal(args.iceServers.length, 3);
	// turn: 带 username/credential
	assert.equal(args.iceServers[0].urls, 'turn:example.com:3478?transport=udp');
	assert.equal(args.iceServers[0].username, 'user1');
	assert.equal(args.iceServers[0].credential, 'cred1');
	assert.equal(args.iceServers[1].urls, 'turn:example.com:3478?transport=tcp');
	assert.equal(args.iceServers[1].username, 'user1');
	// turns: 也带 username/credential
	assert.equal(args.iceServers[2].urls, 'turns:example.com:443?transport=tcp');
	assert.equal(args.iceServers[2].username, 'user1');
	assert.equal(args.iceServers[2].credential, 'cred1');

	await peer.closeAll();
});

test('WebRtcPeer: 无 turnCreds 时 iceServers 为空', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_003'));
	assert.deepEqual(PC.instances[0].__constructorArgs.iceServers, []);

	await peer.closeAll();
});

test('WebRtcPeer: ICE candidate 回调 → onSend', async () => {
	resetRemoteLog();
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_010'));
	const pc = PC.instances[0];

	// 模拟 ICE candidate（含 typ 字段，用于类型统计）
	pc.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.1 12345 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
	assert.equal(sent.length, 2); // answer + ice
	assert.equal(sent[1].type, 'rtc:ice');
	assert.equal(sent[1].toConnId, 'c_010');

	// null candidate → gathering 完成，触发 rtc.ice-gathered remoteLog，不增加 sent
	pc.onicecandidate({ candidate: null });
	assert.equal(sent.length, 2);
	assert.ok(remoteLogBuffer.some((e) => e.text.includes('rtc.ice-gathered') && e.text.includes('host=1')));

	await peer.closeAll();
});

test('WebRtcPeer: handleIce 正常添加', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
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

test('WebRtcPeer: handleIce addIceCandidate 失败时不抛异常', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_021'));
	const pc = PC.instances[0];
	pc.addIceCandidate = async () => { throw new Error('remote description not set'); };

	// 不应抛异常
	await peer.handleSignaling({
		type: 'rtc:ice',
		fromConnId: 'c_021',
		payload: { candidate: 'cand', sdpMid: '0', sdpMLineIndex: 0 },
	});

	await peer.closeAll();
});

test('WebRtcPeer: handleIce 无 session 时忽略', async () => {
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: MockPCFactory(),
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_030b'));
	const pc = PC.instances[0];
	const fakeChannel = { label: 'rpc', onopen: null, onclose: null, onmessage: null };
	pc.ondatachannel({ channel: fakeChannel });

	fakeChannel.onmessage({ data: JSON.stringify({ type: 'event', event: 'test' }) });
	assert.ok(logs.some((l) => l.includes('unknown DC message type: event')));

	await peer.closeAll();
});

test('WebRtcPeer: DC probe → 回复 probe-ack，不触发 onRequest', async () => {
	const PC = MockPCFactory();
	const requests = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		onRequest: (payload) => requests.push(payload),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_probe1'));
	const pc = PC.instances[0];
	const sent = [];
	const fakeChannel = {
		label: 'rpc', onopen: null, onclose: null, onmessage: null,
		send: (data) => sent.push(JSON.parse(data)),
	};
	pc.ondatachannel({ channel: fakeChannel });

	fakeChannel.onmessage({ data: JSON.stringify({ type: 'probe' }) });

	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0], { type: 'probe-ack' });
	assert.equal(requests.length, 0, 'probe should not trigger onRequest');

	await peer.closeAll();
});

test('WebRtcPeer: DC probe 回复失败（DC 已关闭）不抛异常', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_probe2'));
	const pc = PC.instances[0];
	const fakeChannel = {
		label: 'rpc', onopen: null, onclose: null, onmessage: null,
		send: () => { throw new Error('DC closed'); },
	};
	pc.ondatachannel({ channel: fakeChannel });

	// 应不抛异常
	fakeChannel.onmessage({ data: JSON.stringify({ type: 'probe' }) });

	await peer.closeAll();
});

test('WebRtcPeer: DataChannel onmessage 无效 JSON → warn', async () => {
	const PC = MockPCFactory();
	const warns = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {}, debug: () => {} },
		PeerConnection: PC,
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_042'));
	const pc = PC.instances[0];

	pc.iceTransports[0].connection.nominated = { localCandidate: {}, remoteCandidate: {} };
	pc.connectionState = 'connected';
	pc.onconnectionstatechange();

	assert.ok(logs.some((l) => l.includes('ICE nominated: local=? ?:? remote=? ?:?')));
});

test('WebRtcPeer: connectionState failed 保留 session（支持 ICE restart）', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_050'));
	assert.ok(peer.__sessions.has('c_050'));

	const pc = PC.instances[0];
	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	// failed 不删除 session，以支持后续 ICE restart 恢复
	assert.ok(peer.__sessions.has('c_050'));
});

test('WebRtcPeer: connectionState closed 清理 session', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_050b'));
	assert.ok(peer.__sessions.has('c_050b'));

	const pc = PC.instances[0];
	pc.connectionState = 'closed';
	pc.onconnectionstatechange();
	assert.ok(!peer.__sessions.has('c_050b'));
});

test('WebRtcPeer: connectionState failed 触发诊断 dump（含 rpc + file DC 状态）', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
		onFileChannel: () => {},
	});

	await peer.handleSignaling(makeOffer('c_dump1'));
	const pc = PC.instances[0];

	// 注入一个 rpc DC + 两个 file DC（一个仍 open，一个已 closed）
	pc.ondatachannel({ channel: { label: 'rpc', readyState: 'open', onopen: null, onclose: null, onerror: null, onmessage: null } });
	pc.ondatachannel({ channel: { label: 'file:abc', readyState: 'open' } });
	pc.ondatachannel({ channel: { label: 'file:def', readyState: 'closed' } });

	pc.connectionState = 'failed';
	pc.onconnectionstatechange();

	const dump = remoteLogBuffer.find((e) => /rtc\.dump/.test(e.text) && /conn=c_dump1/.test(e.text));
	assert.ok(dump, `expected rtc.dump log, got: ${JSON.stringify(remoteLogBuffer.map((e) => e.text))}`);
	assert.match(dump.text, /state=failed/);
	assert.match(dump.text, /rpc=open/);
	assert.match(dump.text, /fileCount=2/);
	assert.match(dump.text, /file:abc=open/);
	assert.match(dump.text, /file:def=closed/);

	// failed 保留 session 以支持 ICE restart
	assert.ok(peer.__sessions.has('c_dump1'));
});

test('WebRtcPeer: connectionState disconnected 触发 dump 但保留 session（可能恢复）', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_disc'));
	const pc = PC.instances[0];

	pc.connectionState = 'disconnected';
	pc.onconnectionstatechange();

	const dump = remoteLogBuffer.find((e) => /rtc\.dump/.test(e.text) && /conn=c_disc/.test(e.text));
	assert.ok(dump);
	assert.match(dump.text, /state=disconnected/);
	assert.match(dump.text, /rpc=none/); // 未注入 rpc DC
	assert.match(dump.text, /fileCount=0/);
	assert.match(dump.text, /files=\[none\]/);

	// session 不应被清理（disconnected 可能恢复）
	assert.ok(peer.__sessions.has('c_disc'));
});

test('WebRtcPeer: connectionState closed 不输出 dump（避免本地主动关闭噪声）', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_closed'));
	const pc = PC.instances[0];

	pc.connectionState = 'closed';
	pc.onconnectionstatechange();

	const dump = remoteLogBuffer.find((e) => /rtc\.dump/.test(e.text) && /conn=c_closed/.test(e.text));
	assert.equal(dump, undefined, 'closed should not emit dump');
});

test('WebRtcPeer: 重复 disconnected 同 state 去重，恢复 connected 后再 disconnected 仍 dump', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_flap'));
	const pc = PC.instances[0];

	pc.connectionState = 'disconnected';
	pc.onconnectionstatechange();
	pc.onconnectionstatechange();
	pc.onconnectionstatechange();

	let dumps = remoteLogBuffer.filter((e) => /rtc\.dump/.test(e.text) && /conn=c_flap/.test(e.text));
	assert.equal(dumps.length, 1, '相同 state 下多次回调只 dump 一次');

	// 恢复 connected
	pc.connectionState = 'connected';
	pc.onconnectionstatechange();

	// 再次 disconnected 应可重新 dump
	pc.connectionState = 'disconnected';
	pc.onconnectionstatechange();

	dumps = remoteLogBuffer.filter((e) => /rtc\.dump/.test(e.text) && /conn=c_flap/.test(e.text));
	assert.equal(dumps.length, 2, 'connected 恢复后 disconnected 应再次 dump');
});

test('WebRtcPeer: stale PC 异步回调不污染当前 session 诊断', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_stale'));
	const oldPc = PC.instances[0];
	const oldHandler = oldPc.onconnectionstatechange;

	// 重复 offer 触发 close 旧 + 建新
	await peer.handleSignaling(makeOffer('c_stale'));
	const newPc = PC.instances[1];
	assert.notEqual(oldPc, newPc);

	// 假设旧 PC 的异步回调"挣扎"地触发（实际中 closeByConnId 会 detach，
	// 但本测试模拟极端 race：保留 handler 引用并手动调用）
	oldPc.connectionState = 'failed';
	oldHandler();

	// 期望：dump 不应输出（pc 归属校验拒绝旧 PC），新 session 仍存活
	const dumps = remoteLogBuffer.filter((e) => /rtc\.dump/.test(e.text) && /conn=c_stale/.test(e.text));
	assert.equal(dumps.length, 0, 'stale PC 不应触发 dump');
	assert.ok(peer.__sessions.has('c_stale'), '新 session 不应被旧 PC 回调误删');
});

test('WebRtcPeer: connected 分支 pc 归属校验：旧 PC 不输出 ICE nominated', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_conn'));
	const oldPc = PC.instances[0];
	const oldHandler = oldPc.onconnectionstatechange;

	// 重复 offer 替换为新 PC
	await peer.handleSignaling(makeOffer('c_conn'));
	const newPc = PC.instances[1];
	assert.notEqual(oldPc, newPc);

	// 旧 PC 异步进入 connected 状态（极端 race）
	oldPc.iceTransports[0].connection.nominated = {
		localCandidate: { type: 'srflx', host: '1.1.1.1', port: 1111 },
		remoteCandidate: { type: 'host', host: '2.2.2.2', port: 2222 },
	};
	oldPc.connectionState = 'connected';
	oldHandler();

	// 关键：pc 归属校验早 return，不应输出 ICE nominated
	const nominated = remoteLogBuffer.find((e) => /rtc\.ice-nominated/.test(e.text) && /1\.1\.1\.1/.test(e.text));
	assert.equal(nominated, undefined, '旧 PC 的 connected 不应触发 ICE nominated 日志');
});

test('WebRtcPeer: file DC 历史上限 FIFO 淘汰', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
		onFileChannel: () => {},
	});

	await peer.handleSignaling(makeOffer('c_cap'));
	const pc = PC.instances[0];

	// 注入 25 个 file DC（超过上限 20）
	for (let i = 0; i < 25; i++) {
		pc.ondatachannel({ channel: { label: `file:dc${i}`, readyState: 'open' } });
	}

	pc.connectionState = 'failed';
	pc.onconnectionstatechange();

	const dump = remoteLogBuffer.find((e) => /rtc\.dump/.test(e.text) && /conn=c_cap/.test(e.text));
	assert.ok(dump);
	// fileCount 应被限制在 20
	assert.match(dump.text, /fileCount=20/);
	// 最老的 5 个（dc0..dc4）应已被 FIFO 淘汰
	assert.ok(!/file:dc0=/.test(dump.text), 'dc0 should be evicted');
	assert.ok(!/file:dc4=/.test(dump.text), 'dc4 should be evicted');
	// 最新的 dc5..dc24 应保留
	assert.match(dump.text, /file:dc5=/);
	assert.match(dump.text, /file:dc24=/);
});

test('WebRtcPeer: connectionState closed 清理 session', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
	});
	await peer.closeByConnId('c_nonexistent'); // 不应抛异常
});

test('WebRtcPeer: closeAll 空 sessions', async () => {
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: MockPCFactory(),
		impl: 'ndc',
	});
	await peer.closeAll(); // 不应抛异常
});

test('WebRtcPeer: rtc:ready 仅日志', async () => {
	const logs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: (m) => logs.push(m) },
		PeerConnection: MockPCFactory(),
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_b01'));
	await peer.handleSignaling(makeOffer('c_b02'));

	const sentByChannel = { c_b01: [], c_b02: [] };
	const dc1 = makeMockRpcDc({ send: (d) => sentByChannel.c_b01.push(d) });
	const dc2 = makeMockRpcDc({ send: (d) => sentByChannel.c_b02.push(d) });
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
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_b10'));
	// rpcChannel 为 null（未触发 ondatachannel）
	peer.broadcast({ type: 'res', id: 'x' });
	// 不应报错

	// 设置一个 readyState !== 'open' 的 channel
	const dc = makeMockRpcDc({ readyState: 'connecting', send: () => { throw new Error('should not send'); } });
	PC.instances[0].ondatachannel({ channel: dc });
	peer.broadcast({ type: 'res', id: 'x' });
	// 不应报错

	await peer.closeAll();
});

test('WebRtcPeer: broadcast send 失败时不抛异常（RpcSendQueue 内部捕获）', async () => {
	const PC = MockPCFactory();
	const warns = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {}, debug: () => {} },
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_b20'));
	const dc = makeMockRpcDc({ send: () => { throw new Error('dc send error'); } });
	PC.instances[0].ondatachannel({ channel: dc });

	peer.broadcast({ type: 'res', id: 'y' });
	// RpcSendQueue 内部 try/catch 记录 warn，broadcast 不会抛
	assert.ok(warns.some((l) => l.includes('fast-path send failed')));

	await peer.closeAll();
});

test('WebRtcPeer: broadcast 空 sessions 不报错', () => {
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: MockPCFactory(),
		impl: 'ndc',
	});
	peer.broadcast({ type: 'res', id: 'z' }); // 不应抛异常
});

test('WebRtcPeer: __logDebug 无 debug 方法时不报错', async () => {
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {} }, // 无 debug
		PeerConnection: MockPCFactory(),
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
	});
	assert.equal(peer.logger, console);
});

// --- impl 参数 ---

test('WebRtcPeer: impl 参数影响 logger 前缀和 remoteLog 后缀', async () => {
	resetRemoteLog();
	const logs = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {}, debug: () => {} },
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_impl1'));
	// logger 前缀应包含 impl
	assert.ok(logs.some((m) => m.includes('[coclaw/rtc:pion]')), `expected [coclaw/rtc:pion] in logs: ${JSON.stringify(logs)}`);
	// remoteLog 应追加 rtc=pion
	assert.ok(remoteLogBuffer.some((e) => e.text.includes('rtc=pion')), `expected rtc=pion in remoteLog: ${JSON.stringify(remoteLogBuffer.map((e) => e.text))}`);

	await peer.closeAll();
});

test('WebRtcPeer: 未传 impl 时 logger 前缀和 remoteLog 不含 rtc 标识', async () => {
	resetRemoteLog();
	const logs = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {}, debug: () => {} },
		PeerConnection: PC,
	});

	await peer.handleSignaling(makeOffer('c_impl2'));
	// logger 前缀应为 [coclaw/rtc]（无后缀）
	assert.ok(logs.some((m) => m.includes('[coclaw/rtc]')), `expected [coclaw/rtc] in logs: ${JSON.stringify(logs)}`);
	// remoteLog 不应包含 rtc=
	assert.ok(!remoteLogBuffer.some((e) => e.text.includes('rtc=')), `expected no rtc= in remoteLog: ${JSON.stringify(remoteLogBuffer.map((e) => e.text))}`);

	await peer.closeAll();
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
		impl: 'ndc',
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
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_file_02'));
	const pc = PC.instances[0];
	const sent = [];
	const fakeChannel = makeMockRpcDc({ send: (d) => sent.push(d) });
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
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'pion',
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

test('WebRtcPeer: ICE restart 无现有 session 时发送 rtc:restart-rejected', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	// 直接发送 ICE restart offer（无现有 session）
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_ir02',
		payload: { sdp: 'ice-restart-sdp', iceRestart: true },
	});

	// 不应创建新 PC（不 fall through）
	assert.equal(PC.instances.length, 0);
	// 应发送 restart-rejected
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, 'rtc:restart-rejected');
	assert.equal(sent[0].toConnId, 'c_ir02');
	assert.equal(sent[0].payload.reason, 'no_session');
});

test('WebRtcPeer: ICE restart 非 pion impl 立即 reject（impl_unsupported）', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	// 先建立正常连接
	await peer.handleSignaling(makeOffer('c_ir_impl'));
	assert.equal(PC.instances.length, 1);
	sent.length = 0;

	// 发送 ICE restart offer → 应被 impl 检查拦截
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_ir_impl',
		payload: { sdp: 'ice-restart-sdp', iceRestart: true },
	});

	// 应发送 restart-rejected，reason=impl_unsupported
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, 'rtc:restart-rejected');
	assert.equal(sent[0].toConnId, 'c_ir_impl');
	assert.equal(sent[0].payload.reason, 'impl_unsupported');
	// session 应保留（不关闭 PC）
	assert.ok(peer.__sessions.has('c_ir_impl'));

	await peer.closeAll();
});

test('WebRtcPeer: ICE restart 协商失败时发送 rtc:restart-rejected', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
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

	// 不应创建新 PC（不 fall through）
	assert.equal(PC.instances.length, 1);
	// 旧 PC 应已关闭（closeByConnId）
	assert.equal(firstPc.connectionState, 'closed');
	// 应发送 restart-rejected
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, 'rtc:restart-rejected');
	assert.equal(sent[0].toConnId, 'c_ir03');
	assert.equal(sent[0].payload.reason, 'restart_failed');
});

test('WebRtcPeer: ICE failed 后仍可 ICE restart 恢复', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	// 建立正常连接
	await peer.handleSignaling(makeOffer('c_ir04'));
	const pc = PC.instances[0];
	sent.length = 0;

	// 模拟 ICE failed（如 app 后台冻结后 pion 侧超时）
	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	// session 应保留
	assert.ok(peer.__sessions.has('c_ir04'));

	// 前台恢复后 UI 发起 ICE restart
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_ir04',
		payload: { sdp: 'restart-sdp', iceRestart: true },
	});

	// 应在现有 PC 上完成 restart（不创建新 PC）
	assert.equal(PC.instances.length, 1);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, 'rtc:answer');
	assert.equal(sent[0].toConnId, 'c_ir04');

	await peer.closeAll();
});

// --- 竞态保护测试 ---

test('WebRtcPeer: closeByConnId detach 事件防止旧 PC 回调影响新 session', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
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

import { HEADER_SIZE, FLAG_BEGIN, FLAG_END, FLAG_MIDDLE } from './dc-chunking.js';

test('WebRtcPeer: broadcast 小消息不分片，直接 send string', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'ndc' });
	await peer.handleSignaling(makeOffer('c_chunk01', 'v=0\r\na=max-message-size:262144\r\n'));
	const pc = PC.instances[0];
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	pc.ondatachannel({ channel: dc });

	peer.broadcast({ type: 'event', event: 'ping' });
	assert.equal(sent.length, 1);
	assert.equal(typeof sent[0], 'string');
	await peer.closeAll();
});

test('WebRtcPeer: broadcast 大消息自动分片', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'ndc' });
	// 设置很小的 maxMessageSize 以触发分片
	await peer.handleSignaling(makeOffer('c_chunk02', 'v=0\r\na=max-message-size:50\r\n'));
	const pc = PC.instances[0];
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
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
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'ndc' });

	// 连接 1：maxMessageSize=50（小，需要更多 chunk）
	await peer.handleSignaling(makeOffer('c_chunk03a', 'v=0\r\na=max-message-size:50\r\n'));
	const sent1 = [];
	const dc1 = makeMockRpcDc({ send: (d) => sent1.push(d) });
	PC.instances[0].ondatachannel({ channel: dc1 });

	// 连接 2：maxMessageSize=200（大，需要更少 chunk）
	await peer.handleSignaling(makeOffer('c_chunk03b', 'v=0\r\na=max-message-size:200\r\n'));
	const sent2 = [];
	const dc2 = makeMockRpcDc({ send: (d) => sent2.push(d) });
	PC.instances[1].ondatachannel({ channel: dc2 });

	peer.broadcast({ type: 'res', data: 'Y'.repeat(150) });

	assert.ok(sent1.length > sent2.length, `conn1 should have more chunks: ${sent1.length} vs ${sent2.length}`);

	await peer.closeAll();
});

test('WebRtcPeer: SDP 无 max-message-size 时默认 65536', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'ndc' });
	await peer.handleSignaling(makeOffer('c_chunk04', 'v=0\r\n')); // 无 max-message-size
	const session = peer.__sessions.get('c_chunk04');
	assert.equal(session.remoteMaxMessageSize, 65536);
	await peer.closeAll();
});

test('WebRtcPeer: SDP 中正确提取 max-message-size 值', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'ndc' });
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
		impl: 'ndc',
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
		impl: 'ndc',
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
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_chunk08', 'v=0\r\na=max-message-size:80\r\n'));
	const pc = PC.instances[0];
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
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
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_chunk09'));
	const pc = PC.instances[0];
	const dc = makeMockRpcDc();
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

// --- RpcSendQueue 集成 ---

test('WebRtcPeer: 建立 rpc DC 时创建 RpcSendQueue 并设置 bufferedAmountLowThreshold', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_sq01'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });

	const session = peer.__sessions.get('c_sq01');
	assert.ok(session.rpcSendQueue, 'rpcSendQueue should be created');
	assert.equal(dc.bufferedAmountLowThreshold, 256 * 1024, 'LOW_WATER_MARK should be set on DC');
	assert.equal(typeof dc.onbufferedamountlow, 'function', 'onbufferedamountlow should be wired');
	await peer.closeAll();
});

test('WebRtcPeer: file DC 不创建 RpcSendQueue（仅 rpc label 触发）', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		onFileChannel: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_sq_file'));
	const fileDc = { label: 'file:abc', readyState: 'open', onopen: null, onclose: null, onmessage: null };
	PC.instances[0].ondatachannel({ channel: fileDc });
	const session = peer.__sessions.get('c_sq_file');
	assert.equal(session.rpcSendQueue, null, 'file DC must not create RpcSendQueue');
	assert.equal(session.fileChannels.size, 1);
	await peer.closeAll();
});

test('WebRtcPeer: DC 不支持 bufferedAmountLowThreshold 时跳过设置但仍创建 queue', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'ndc' });
	await peer.handleSignaling(makeOffer('c_sq_noba'));
	// mock DC 不含 bufferedAmountLowThreshold 属性（使用旧 ad-hoc 形式）
	const dc = { label: 'rpc', readyState: 'open', bufferedAmount: 0, send: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null };
	PC.instances[0].ondatachannel({ channel: dc });
	const session = peer.__sessions.get('c_sq_noba');
	assert.ok(session.rpcSendQueue);
	assert.equal('bufferedAmountLowThreshold' in dc, false, 'threshold 属性未被注入');
	await peer.closeAll();
});

test('WebRtcPeer: ICE restart 保留 RpcSendQueue 实例与队列状态', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_sq_icr', 'v=0\r\na=max-message-size:100\r\n'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });
	const session = peer.__sessions.get('c_sq_icr');
	const queueBefore = session.rpcSendQueue;

	// 让 queue 堆积 chunks（顶到 HIGH 使入队）
	dc.bufferedAmount = 1024 * 1024;
	peer.broadcast({ type: 'res', data: 'Q'.repeat(500) });
	const queuedChunksBefore = queueBefore.queue.length;
	assert.ok(queuedChunksBefore > 0);

	// 发起 ICE restart offer（同 connId）
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_sq_icr',
		payload: { sdp: 'v=0\r\na=max-message-size:100\r\n', iceRestart: true },
	});

	// queue 与 rpcSendQueue 实例应保持不变（设计要点：ICE restart 不触发 DC close）
	assert.equal(session.rpcSendQueue, queueBefore, 'same queue instance preserved');
	assert.equal(session.rpcSendQueue.queue.length, queuedChunksBefore, 'queue state preserved');
	assert.equal(session.rpcSendQueue.closed, false);

	// 模拟 SACK 恢复 → BAL → drain 应能继续
	dc.bufferedAmount = 0;
	dc.onbufferedamountlow();
	assert.equal(session.rpcSendQueue.queue.length, 0, 'queue drained after restart');
	await peer.closeAll();
});

test('WebRtcPeer: onbufferedamountlow 事件触发 queue drain', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_sq02', 'v=0\r\na=max-message-size:100\r\n'));
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	PC.instances[0].ondatachannel({ channel: dc });

	// 顶到 HIGH，让大消息全部入队
	dc.bufferedAmount = 1024 * 1024;
	peer.broadcast({ type: 'res', data: 'X'.repeat(500) });
	const session = peer.__sessions.get('c_sq02');
	assert.ok(session.rpcSendQueue.queue.length > 0, 'chunks queued');

	// 模拟 SACK：bufferedAmount 降到 0，触发 onbufferedamountlow
	dc.bufferedAmount = 0;
	dc.onbufferedamountlow();

	// drain 排空队列
	assert.equal(session.rpcSendQueue.queue.length, 0);
	assert.ok(sent.length > 0);
	await peer.closeAll();
});

test('WebRtcPeer: dc.onclose 关闭 RpcSendQueue，之后 broadcast 不再 send', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_sq03'));
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	PC.instances[0].ondatachannel({ channel: dc });

	const session = peer.__sessions.get('c_sq03');
	assert.ok(session.rpcSendQueue);

	// 触发 onclose
	dc.readyState = 'closed';
	dc.onclose();
	assert.equal(session.rpcSendQueue, null);
	assert.equal(session.rpcChannel, null);

	// 之后 broadcast 不应 send（因为 session.rpcSendQueue === null）
	const sentBefore = sent.length;
	peer.broadcast({ type: 'event', event: 'after-close' });
	assert.equal(sent.length, sentBefore);
	await peer.closeAll();
});

test('WebRtcPeer: broadcast 遇到 buildChunks 抛异常时 logDebug 但不崩', async () => {
	const PC = MockPCFactory();
	const debugMsgs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: (m) => debugMsgs.push(m) },
		PeerConnection: PC,
		impl: 'ndc',
	});
	// 过小的 maxMessageSize 让 buildChunks 抛（chunkPayloadSize <= 0）
	await peer.handleSignaling(makeOffer('c_sq_throw_b', 'v=0\r\na=max-message-size:3\r\n'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });

	// payload > 3 bytes → 触发分片路径 → buildChunks 抛
	peer.broadcast({ type: 'res', data: 'hello world' });
	assert.ok(debugMsgs.some((m) => m.includes('broadcast send failed')));
	await peer.closeAll();
});

test('WebRtcPeer: files sendFn 遇到 buildChunks 抛异常时 logDebug 但不崩', async () => {
	const PC = MockPCFactory();
	const debugMsgs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		onFileRpc: (payload, sendFn) => {
			sendFn({ type: 'res', id: payload.id, data: 'hello world' });
		},
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: (m) => debugMsgs.push(m) },
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_sq_throw_f', 'v=0\r\na=max-message-size:3\r\n'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });

	dc.onmessage({ data: JSON.stringify({ type: 'req', id: 'tfz', method: 'coclaw.files.list', params: {} }) });
	assert.ok(debugMsgs.some((m) => m.includes('sendFn failed')));
	await peer.closeAll();
});

test('WebRtcPeer: probe-ack 绕过 RpcSendQueue（背压场景 + spy 双验证）', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_sq04'));
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	PC.instances[0].ondatachannel({ channel: dc });

	// 模拟 queue 处于 "满" 状态 + 高 bufferedAmount 的背压条件
	const session = peer.__sessions.get('c_sq04');
	const fakeBig = Buffer.alloc(11 * 1024 * 1024);
	session.rpcSendQueue.queue.push(fakeBig);
	session.rpcSendQueue.queueBytes = fakeBig.length;
	dc.bufferedAmount = 10 * 1024 * 1024; // 远超 HIGH，正常路径 drain 会被阻塞

	// 额外用 spy 替换 queue.send — 若 probe-ack 误走 queue，spy 会记录到
	let queueSendCallCount = 0;
	const origQueueSend = session.rpcSendQueue.send.bind(session.rpcSendQueue);
	session.rpcSendQueue.send = (jsonStr) => {
		queueSendCallCount += 1;
		return origQueueSend(jsonStr);
	};

	// 收到 probe → 触发 probe-ack（应绕过 queue 直发，背压条件下仍成功）
	dc.onmessage({ data: JSON.stringify({ type: 'probe' }) });

	// probe-ack 应出现在最后一次 dc.send（string）
	const lastSent = sent[sent.length - 1];
	assert.equal(typeof lastSent, 'string');
	assert.equal(JSON.parse(lastSent).type, 'probe-ack');
	// 且 queue.send 未被调用（严格验证"绕过"）
	assert.equal(queueSendCallCount, 0, 'probe-ack must NOT go through rpcSendQueue.send');
	await peer.closeAll();
});

// --- ICE 诊断日志 ---

test('WebRtcPeer: offer 时记录 ICE 服务器配置（脱敏）', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	const turnCreds = {
		urls: ['stun:stun.example.com:3478', 'turn:turn.example.com:3478?transport=udp'],
		username: 'secret-user',
		credential: 'secret-pass',
	};
	await peer.handleSignaling(makeOffer('c_diag_01', 'sdp', turnCreds));

	const configLog = remoteLogBuffer.find((e) => e.text.includes('rtc.ice-config'));
	assert.ok(configLog, 'should have rtc.ice-config log');
	assert.ok(configLog.text.includes('stun=stun:stun.example.com:3478'), 'should log stun URL');
	assert.ok(configLog.text.includes('turn=turn:turn.example.com:3478'), 'should log turn URL');
	// credential 不应出现在日志中
	assert.ok(!configLog.text.includes('secret-user'), 'should not contain username');
	assert.ok(!configLog.text.includes('secret-pass'), 'should not contain credential');

	await peer.closeAll();
});

test('WebRtcPeer: 无 STUN/TURN 时 ice-config 显示 none', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_diag_02'));

	const configLog = remoteLogBuffer.find((e) => e.text.includes('rtc.ice-config'));
	assert.ok(configLog, 'should have rtc.ice-config log');
	assert.ok(configLog.text.includes('stun=none'), 'should show stun=none');
	assert.ok(configLog.text.includes('turn=none'), 'should show turn=none');

	await peer.closeAll();
});

test('WebRtcPeer: candidate gathering 汇总统计各类型', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_diag_03'));
	const pc = PC.instances[0];

	// 模拟收集到多种类型的 candidate
	pc.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.1 10000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
	pc.onicecandidate({ candidate: { candidate: 'candidate:2 1 udp 1686052607 1.2.3.4 20000 typ srflx raddr 192.168.1.1 rport 10000', sdpMid: '0', sdpMLineIndex: 0 } });
	pc.onicecandidate({ candidate: { candidate: 'candidate:3 1 udp 41885695 5.6.7.8 30000 typ relay raddr 1.2.3.4 rport 20000', sdpMid: '0', sdpMLineIndex: 0 } });
	pc.onicecandidate({ candidate: { candidate: 'candidate:4 1 udp 2122194687 10.0.0.1 10001 typ host', sdpMid: '0', sdpMLineIndex: 0 } });

	// null → gathering 完成
	pc.onicecandidate({ candidate: null });

	const gathered = remoteLogBuffer.find((e) => e.text.includes('rtc.ice-gathered') && e.text.includes('c_diag_03'));
	assert.ok(gathered, 'should have rtc.ice-gathered log');
	assert.ok(gathered.text.includes('host=2'), 'should count 2 host candidates');
	assert.ok(gathered.text.includes('srflx=1'), 'should count 1 srflx candidate');
	assert.ok(gathered.text.includes('relay=1'), 'should count 1 relay candidate');

	await peer.closeAll();
});

test('WebRtcPeer: candidate 无 typ 字段时不计入统计', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_diag_04'));
	const pc = PC.instances[0];

	// candidate 字符串无 typ 字段
	pc.onicecandidate({ candidate: { candidate: 'some-invalid-candidate-string', sdpMid: '0', sdpMLineIndex: 0 } });
	pc.onicecandidate({ candidate: null });

	const gathered = remoteLogBuffer.find((e) => e.text.includes('rtc.ice-gathered') && e.text.includes('c_diag_04'));
	assert.ok(gathered);
	assert.ok(gathered.text.includes('host=0'));
	assert.ok(gathered.text.includes('srflx=0'));
	assert.ok(gathered.text.includes('relay=0'));

	await peer.closeAll();
});

// --- pion 适配测试 ---

function createPionMockPC() {
	const pc = {
		onicecandidate: null,
		onconnectionstatechange: null,
		onselectedcandidatepairchange: null,
		ondatachannel: null,
		connectionState: 'new',
		selectedCandidatePair: null,
		setRemoteDescription: async () => {},
		createAnswer: async () => ({ sdp: 'mock-sdp-answer' }),
		setLocalDescription: async () => {},
		addIceCandidate: async () => {},
		close: async () => { pc.connectionState = 'closed'; },
		__constructorArgs: null,
	};
	return pc;
}

function PionMockPCFactory() {
	const instances = [];
	function PC(opts) {
		const pc = createPionMockPC();
		pc.__constructorArgs = opts;
		instances.push(pc);
		return pc;
	}
	PC.instances = instances;
	return PC;
}

test('WebRtcPeer: pion — connectionState connected 不直接读取 selectedCandidatePair（避免 ICE restart 旧值）', async () => {
	resetRemoteLog();
	const PC = PionMockPCFactory();
	const logs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {}, debug: () => {} },
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_pion_01'));
	const pc = PC.instances[0];

	// pair 已设置，但 connectionstatechange 不应读取它（pair 通过独立事件上报）
	pc.selectedCandidatePair = {
		local: { type: 'srflx', address: '1.2.3.4', port: 12345 },
		remote: { type: 'host', address: '192.168.0.1', port: 54321 },
	};
	pc.connectionState = 'connected';
	pc.onconnectionstatechange();

	// 不应从 connectionstatechange 输出 ice-nominated
	assert.ok(!logs.some((l) => l.includes('ICE nominated')));
	assert.ok(!remoteLogBuffer.some((e) => e.text.includes('rtc.ice-nominated') && e.text.includes('c_pion_01')));

	await peer.closeAll();
});

test('WebRtcPeer: pion — onselectedcandidatepairchange 事件上报 pair', async () => {
	resetRemoteLog();
	const PC = PionMockPCFactory();
	const logs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {}, debug: () => {} },
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_pion_02'));
	const pc = PC.instances[0];

	// 验证 handler 已注册
	assert.equal(typeof pc.onselectedcandidatepairchange, 'function');

	// 触发事件
	pc.selectedCandidatePair = {
		local: { type: 'relay', address: '10.0.0.1', port: 9999, protocol: 'udp' },
		remote: { type: 'srflx', address: '203.0.113.1', port: 8888, protocol: 'udp' },
	};
	pc.onselectedcandidatepairchange();

	assert.ok(logs.some((l) => l.includes('ICE nominated: local=relay 10.0.0.1:9999 remote=srflx 203.0.113.1:8888')));
	assert.ok(remoteLogBuffer.some((e) => e.text.includes('rtc.ice-nominated') && e.text.includes('c_pion_02')));

	await peer.closeAll();
});

test('WebRtcPeer: pion — onselectedcandidatepairchange pair 为 null 时不崩溃', async () => {
	const PC = PionMockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_pion_03'));
	const pc = PC.instances[0];

	pc.selectedCandidatePair = null;
	pc.onselectedcandidatepairchange(); // 不应抛异常

	await peer.closeAll();
});

test('WebRtcPeer: pion — closeByConnId detach onselectedcandidatepairchange', async () => {
	const PC = PionMockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_pion_04'));
	const pc = PC.instances[0];
	assert.equal(typeof pc.onselectedcandidatepairchange, 'function');

	await peer.closeByConnId('c_pion_04');
	assert.equal(pc.onselectedcandidatepairchange, null);
});

// --- failed session 清理机制 ---

test('WebRtcPeer: 导出 FAILED_SESSION_TTL_MS 和 MAX_SESSIONS 常量', () => {
	assert.equal(typeof FAILED_SESSION_TTL_MS, 'number');
	assert.ok(FAILED_SESSION_TTL_MS > 0);
	assert.equal(typeof MAX_SESSIONS, 'number');
	assert.ok(MAX_SESSIONS > 0);
});

test('WebRtcPeer: closed 路径调用 pc.close() 释放资源', async () => {
	const PC = MockPCFactory();
	let closeCalled = false;
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_closed_fix'));
	const pc = PC.instances[0];
	const origClose = pc.close;
	pc.close = async () => { closeCalled = true; await origClose.call(pc); };

	pc.connectionState = 'closed';
	pc.onconnectionstatechange();

	// closeByConnId 是 fire-and-forget，等下一个 microtask
	await new Promise((r) => setTimeout(r, 0));

	assert.ok(closeCalled, 'pc.close() should be called on natural closed transition');
	assert.ok(!peer.__sessions.has('c_closed_fix'));
});

test('WebRtcPeer: failed 状态启动 TTL 定时器', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_ttl01'));
	const pc = PC.instances[0];

	pc.connectionState = 'failed';
	pc.onconnectionstatechange();

	// session 保留
	assert.ok(peer.__sessions.has('c_ttl01'));
	const session = peer.__sessions.get('c_ttl01');
	assert.ok(session.__failedTimer, 'should set __failedTimer');
});

test('WebRtcPeer: TTL 到期后回收 failed session', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_ttl02'));
	const pc = PC.instances[0];

	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	assert.ok(peer.__sessions.has('c_ttl02'));

	// 推进到 TTL 到期
	t.mock.timers.tick(FAILED_SESSION_TTL_MS);

	// closeByConnId 是 fire-and-forget，等 microtask
	await new Promise((r) => { t.mock.timers.tick(0); setImmediate(r); });

	assert.ok(!peer.__sessions.has('c_ttl02'), 'session should be cleaned up after TTL');
	assert.equal(pc.connectionState, 'closed', 'pc should be closed');
	assert.ok(remoteLogBuffer.some((e) => e.text.includes('rtc.session-expired') && e.text.includes('c_ttl02')));
});

test('WebRtcPeer: ICE restart 恢复 connected 取消 TTL 定时器', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_ttl03'));
	const pc = PC.instances[0];

	// 进入 failed，启动 timer
	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	const session = peer.__sessions.get('c_ttl03');
	assert.ok(session.__failedTimer);

	// ICE restart 成功，恢复 connected
	pc.connectionState = 'connected';
	pc.onconnectionstatechange();
	assert.equal(session.__failedTimer, null, 'timer should be cleared on connected');

	// TTL 到期后 session 不应被清理
	t.mock.timers.tick(FAILED_SESSION_TTL_MS);
	await new Promise((r) => { t.mock.timers.tick(0); setImmediate(r); });
	assert.ok(peer.__sessions.has('c_ttl03'), 'session should survive after TTL when recovered');

	await peer.closeAll();
});

test('WebRtcPeer: rtc:closed 信令取消 TTL 定时器', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_ttl04'));
	const pc = PC.instances[0];

	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	assert.ok(peer.__sessions.get('c_ttl04').__failedTimer);

	// rtc:closed 到来
	await peer.handleSignaling({ type: 'rtc:closed', fromConnId: 'c_ttl04' });
	assert.ok(!peer.__sessions.has('c_ttl04'));

	// TTL 到期后不应有副作用（closeByConnId 幂等）
	t.mock.timers.tick(FAILED_SESSION_TTL_MS);
	await new Promise((r) => { t.mock.timers.tick(0); setImmediate(r); });
	// 无异常即通过
});

test('WebRtcPeer: closeAll 清理所有 TTL 定时器', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_ttl05a'));
	await peer.handleSignaling(makeOffer('c_ttl05b'));
	PC.instances[0].connectionState = 'failed';
	PC.instances[0].onconnectionstatechange();
	PC.instances[1].connectionState = 'failed';
	PC.instances[1].onconnectionstatechange();

	await peer.closeAll();
	assert.equal(peer.__sessions.size, 0);

	// TTL 到期后不应有副作用
	t.mock.timers.tick(FAILED_SESSION_TTL_MS);
	await new Promise((r) => { t.mock.timers.tick(0); setImmediate(r); });
});

test('WebRtcPeer: ICE restart offer 取消 TTL timer 再尝试 restart', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_ttl06'));
	const pc = PC.instances[0];

	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	const session = peer.__sessions.get('c_ttl06');
	assert.ok(session.__failedTimer);

	// ICE restart offer → timer 应被取消
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_ttl06',
		payload: { sdp: 'restart-sdp', iceRestart: true },
	});
	assert.equal(session.__failedTimer, null, 'timer should be cleared during ICE restart');

	await peer.closeAll();
});

test('WebRtcPeer: 非 pion ICE restart reject 后 TTL timer 保持不变', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_ttl07'));
	const pc = PC.instances[0];

	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	const timerBefore = peer.__sessions.get('c_ttl07').__failedTimer;
	assert.ok(timerBefore);

	// 非 pion restart → reject 是同步的，不影响 TTL timer
	sent.length = 0;
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_ttl07',
		payload: { sdp: 'restart-sdp', iceRestart: true },
	});
	assert.equal(sent[0]?.payload?.reason, 'impl_unsupported');
	// session 保留，timer 也保持不变（非 pion reject 不清除 timer）
	assert.ok(peer.__sessions.has('c_ttl07'));
	assert.equal(peer.__sessions.get('c_ttl07').__failedTimer, timerBefore);

	// TTL 到期后应正常回收
	t.mock.timers.tick(FAILED_SESSION_TTL_MS);
	await new Promise((r) => { t.mock.timers.tick(0); setImmediate(r); });
	assert.ok(!peer.__sessions.has('c_ttl07'), 'session should be reclaimed after TTL');
});

test('WebRtcPeer: pion ICE restart 协商失败时清理 TTL timer', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_ttl_rf'));
	const pc = PC.instances[0];

	// 进入 failed → timer 设置
	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	assert.ok(peer.__sessions.get('c_ttl_rf').__failedTimer);

	// pion restart 协商失败
	pc.setRemoteDescription = async () => { throw new Error('restart SDP failed'); };
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_ttl_rf',
		payload: { sdp: 'bad-sdp', iceRestart: true },
	});

	// session 应已被 closeByConnId 清理（含 timer）
	assert.ok(!peer.__sessions.has('c_ttl_rf'));
	assert.equal(sent.at(-1)?.payload?.reason, 'restart_failed');

	// TTL 到期后不应有副作用
	t.mock.timers.tick(FAILED_SESSION_TTL_MS);
	await new Promise((r) => { t.mock.timers.tick(0); setImmediate(r); });
});

test('WebRtcPeer: failed → disconnected（异常转换）取消 TTL timer', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_ttl08'));
	const pc = PC.instances[0];

	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	const session = peer.__sessions.get('c_ttl08');
	assert.ok(session.__failedTimer);

	// 异常转换到 disconnected（某些 impl 可能出现）
	pc.connectionState = 'disconnected';
	pc.onconnectionstatechange();
	assert.equal(session.__failedTimer, null, 'timer should be cleared when leaving failed');

	await peer.closeAll();
});

test('WebRtcPeer: failed → connected → failed 重新启动 timer', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_ttl09'));
	const pc = PC.instances[0];

	// 第一次 failed
	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	const session = peer.__sessions.get('c_ttl09');
	const timer1 = session.__failedTimer;
	assert.ok(timer1);

	// 恢复
	pc.connectionState = 'connected';
	pc.onconnectionstatechange();
	assert.equal(session.__failedTimer, null);

	// 再次 failed
	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	const timer2 = session.__failedTimer;
	assert.ok(timer2);
	assert.notEqual(timer1, timer2, 'should be a new timer');

	await peer.closeAll();
});

test('WebRtcPeer: failed 连续触发两次，旧 timer 被替换', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_ttl_ff'));
	const pc = PC.instances[0];

	// 第一次 failed
	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	const session = peer.__sessions.get('c_ttl_ff');
	const timer1 = session.__failedTimer;
	assert.ok(timer1);

	// 连续第二次 failed（某些 WebRTC 实现可能重复触发）
	pc.onconnectionstatechange();
	const timer2 = session.__failedTimer;
	assert.ok(timer2);
	assert.notEqual(timer1, timer2, 'old timer should be replaced');

	// 仅新 timer 生效：推进 TTL 后 session 被回收
	t.mock.timers.tick(FAILED_SESSION_TTL_MS);
	await new Promise((r) => { t.mock.timers.tick(0); setImmediate(r); });
	assert.ok(!peer.__sessions.has('c_ttl_ff'), 'session should be reclaimed by new timer');
});

// --- queue length 限制 ---

test('WebRtcPeer: session 总数达到 MAX_SESSIONS 时淘汰最旧 failed session', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	// 创建 MAX_SESSIONS 个 session，前几个进入 failed
	for (let i = 0; i < MAX_SESSIONS; i++) {
		await peer.handleSignaling(makeOffer(`c_q${String(i).padStart(2, '0')}`));
	}
	assert.equal(peer.__sessions.size, MAX_SESSIONS);

	// 前 3 个进入 failed
	for (let i = 0; i < 3; i++) {
		const pc = PC.instances[i];
		pc.connectionState = 'failed';
		pc.onconnectionstatechange();
	}

	// 新 offer → 应淘汰 c_q00（最旧的 failed）
	await peer.handleSignaling(makeOffer('c_q_new'));
	assert.ok(!peer.__sessions.has('c_q00'), 'oldest failed session should be evicted');
	assert.ok(peer.__sessions.has('c_q01'), 'second failed session should survive');
	assert.ok(peer.__sessions.has('c_q_new'), 'new session should be created');
	assert.equal(peer.__sessions.size, MAX_SESSIONS);

	// 验证 remoteLog
	assert.ok(remoteLogBuffer.some((e) => e.text.includes('rtc.session-evicted') && e.text.includes('c_q00')));

	await peer.closeAll();
});

test('WebRtcPeer: 无 failed session 可淘汰时仍允许新连接', async () => {
	const PC = MockPCFactory();
	const warns = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {}, debug: () => {} },
		PeerConnection: PC,
		impl: 'pion',
	});

	// 创建 MAX_SESSIONS 个 connected session
	for (let i = 0; i < MAX_SESSIONS; i++) {
		await peer.handleSignaling(makeOffer(`c_nf${String(i).padStart(2, '0')}`));
	}

	// 新 offer → 无 failed 可淘汰，但仍创建
	await peer.handleSignaling(makeOffer('c_nf_new'));
	assert.ok(peer.__sessions.has('c_nf_new'));
	assert.equal(peer.__sessions.size, MAX_SESSIONS + 1);
	assert.ok(warns.some((m) => m.includes('session limit') && m.includes('no failed sessions to evict')));

	await peer.closeAll();
});

test('WebRtcPeer: 同 connId 重复 offer 先释放再检查 queue', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	// 创建 MAX_SESSIONS 个 session
	for (let i = 0; i < MAX_SESSIONS; i++) {
		await peer.handleSignaling(makeOffer(`c_dup${String(i).padStart(2, '0')}`));
	}

	// 同 connId 重复 offer → 先 close 旧的，count 降到 19，不触发淘汰
	await peer.handleSignaling(makeOffer('c_dup00'));
	assert.equal(peer.__sessions.size, MAX_SESSIONS);
	// 所有其他 session 应保留
	assert.ok(peer.__sessions.has('c_dup01'));

	await peer.closeAll();
});

test('WebRtcPeer: queue 淘汰选择 failed 而非 connected session', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	// 创建 MAX_SESSIONS 个 session
	for (let i = 0; i < MAX_SESSIONS; i++) {
		await peer.handleSignaling(makeOffer(`c_mix${String(i).padStart(2, '0')}`));
	}

	// 偶数 session 进入 failed（c_mix00, c_mix02, ...）
	for (let i = 0; i < MAX_SESSIONS; i += 2) {
		PC.instances[i].connectionState = 'failed';
		PC.instances[i].onconnectionstatechange();
	}

	// 新 offer → 应淘汰 c_mix00（最旧的 failed），而非 c_mix01（connected）
	await peer.handleSignaling(makeOffer('c_mix_new'));
	assert.ok(!peer.__sessions.has('c_mix00'), 'oldest failed should be evicted');
	assert.ok(peer.__sessions.has('c_mix01'), 'connected session should survive');
	assert.ok(peer.__sessions.has('c_mix02'), 'second failed should survive');
	assert.ok(peer.__sessions.has('c_mix_new'));

	await peer.closeAll();
});

test('WebRtcPeer: SDP 协商期间 PC 进入 failed 后协商失败 → catch 清理 timer', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	function FailDuringSdpPC() {
		const pc = createMockPC();
		pc.setRemoteDescription = async () => {
			// 模拟 Go 进程崩溃导致 PC 在 SDP 协商期间进入 failed
			pc.connectionState = 'failed';
			pc.onconnectionstatechange();
			throw new Error('IPC process exited');
		};
		return pc;
	}
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: FailDuringSdpPC,
		impl: 'pion',
	});

	await assert.rejects(
		() => peer.handleSignaling(makeOffer('c_sdp_timer')),
		{ message: 'IPC process exited' },
	);
	// session 应已被 catch 块清理
	assert.ok(!peer.__sessions.has('c_sdp_timer'));

	// TTL 到期后不应有副作用（timer 已在 catch 中清理）
	t.mock.timers.tick(FAILED_SESSION_TTL_MS);
	await new Promise((r) => { t.mock.timers.tick(0); setImmediate(r); });
});

test('WebRtcPeer: queue 淘汰时清理被淘汰 session 的 TTL timer', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	for (let i = 0; i < MAX_SESSIONS; i++) {
		await peer.handleSignaling(makeOffer(`c_qt${String(i).padStart(2, '0')}`));
	}

	// 第一个进入 failed → 有 timer
	PC.instances[0].connectionState = 'failed';
	PC.instances[0].onconnectionstatechange();

	// 新 offer → 淘汰 c_qt00
	await peer.handleSignaling(makeOffer('c_qt_new'));
	assert.ok(!peer.__sessions.has('c_qt00'));

	// TTL 到期后不应有副作用（timer 已清理）
	t.mock.timers.tick(FAILED_SESSION_TTL_MS);
	await new Promise((r) => { t.mock.timers.tick(0); setImmediate(r); });
	// 无异常即通过

	await peer.closeAll();
});
