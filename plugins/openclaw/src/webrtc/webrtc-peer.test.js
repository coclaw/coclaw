import assert from 'node:assert/strict';
import test from 'node:test';

import { WebRtcPeer, FAILED_SESSION_TTL_MS, MAX_SESSIONS } from './webrtc-peer.js';
import { DC_HIGH_WATER_MARK, DC_LOW_WATER_MARK } from './rpc-dc-sender.js';
import { __reset as resetRemoteLog, __buffer as remoteLogBuffer } from '../remote-log.js';
import { MemoryQueue } from '../utils/memory-queue.js';

/**
 * 阶段 1 改造后：broadcast / sendFn enqueue 是 async fire-and-forget；消费循环异步从队列拉
 * 数据再 await sender.send()。生产 → 消费 之间至少跨 1-2 微任务。
 * 测试需要在生产后 flush 微任务才能看到 dc.sent / logger 更新。
 */
async function flushAsync() {
	for (let i = 0; i < 5; i += 1) {
		await new Promise((r) => setImmediate(r));
	}
}

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
 * 创建 rpc DC 的完整 mock，含 RpcDcSender 所需的属性（bufferedAmount 等）
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

function warnCapturingLogger() {
	const warnings = [];
	return {
		warnings,
		info: () => {},
		warn: (msg) => { warnings.push(String(msg)); },
		error: () => {},
		debug: () => {},
	};
}

test('WebRtcPeer: 畸形 turnCreds.urls (undefined) 降级 host-only + warn', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const logger = warnCapturingLogger();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger,
		PeerConnection: PC,
		impl: 'ndc',
	});

	const turnCreds = { username: 'u', credential: 'c' };
	await peer.handleSignaling(makeOffer('c_malformed_undef', 'sdp', turnCreds));

	assert.equal(PC.instances.length, 1);
	assert.deepEqual(PC.instances[0].__constructorArgs.iceServers, []);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, 'rtc:answer');
	assert.ok(logger.warnings.some((w) => w.includes('malformed turnCreds.urls')), 'expected malformed-urls warn');

	await peer.closeAll();
});

test('WebRtcPeer: 畸形 turnCreds.urls (字符串) 不被逐字符展开 + warn', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const logger = warnCapturingLogger();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger,
		PeerConnection: PC,
		impl: 'ndc',
	});

	const turnCreds = { urls: 'turn:example.com:3478', username: 'u', credential: 'c' };
	await peer.handleSignaling(makeOffer('c_malformed_str', 'sdp', turnCreds));

	assert.equal(PC.instances.length, 1);
	assert.deepEqual(PC.instances[0].__constructorArgs.iceServers, []);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, 'rtc:answer');
	assert.ok(logger.warnings.some((w) => w.includes('malformed turnCreds.urls')), 'expected malformed-urls warn');

	await peer.closeAll();
});

test('WebRtcPeer: turnCreds.urls 数组内非字符串元素被跳过', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	const turnCreds = {
		urls: ['turn:ok.example.com:3478', null, 42, 'turns:ok.example.com:443'],
		username: 'u',
		credential: 'c',
	};
	await peer.handleSignaling(makeOffer('c_mixed_urls', 'sdp', turnCreds));

	const args = PC.instances[0].__constructorArgs;
	// null 和 number 被跳过，仅保留两个合法 string
	assert.equal(args.iceServers.length, 2);
	assert.equal(args.iceServers[0].urls, 'turn:ok.example.com:3478');
	assert.equal(args.iceServers[1].urls, 'turns:ok.example.com:443');

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
	await flushAsync();

	pc.connectionState = 'failed';
	pc.onconnectionstatechange();

	const dump = remoteLogBuffer.find((e) => /rtc\.dump/.test(e.text) && /conn=c_dump1/.test(e.text));
	assert.ok(dump, `expected rtc.dump log, got: ${JSON.stringify(remoteLogBuffer.map((e) => e.text))}`);
	assert.match(dump.text, /state=failed/);
	assert.match(dump.text, /rpc=open/);
	assert.match(dump.text, /fileCount=2/);
	// 非 closed 态附带 label；closed 态只给计数
	assert.match(dump.text, /open:1\(file:abc\)/);
	assert.match(dump.text, /closed:1/);
	assert.ok(!/file:def/.test(dump.text), 'closed DC labels should not be listed');
	// queue 诊断字段：有 rpc DC 则显示 queue 状态（ondatachannel 的 rpc 分支创建了 queue）
	assert.match(dump.text, /queueLen=\d+ queueBytes=\d+ dropped=\d+/);

	// failed 保留 session 以支持 ICE restart
	assert.ok(peer.__sessions.has('c_dump1'));
});

test('WebRtcPeer: dump 在无 rpc DC 时输出 queue=none', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_dump_noq'));
	const pc = PC.instances[0];
	// 未绑定任何 DC → session.rpcQueue / rpcDcSender 保持 null
	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	const dump = remoteLogBuffer.find((e) => /rtc\.dump/.test(e.text) && /conn=c_dump_noq/.test(e.text));
	assert.ok(dump);
	assert.match(dump.text, /queue=none/);
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
	assert.ok(!/file:dc0\b/.test(dump.text), 'dc0 should be evicted');
	assert.ok(!/file:dc4\b/.test(dump.text), 'dc4 should be evicted');
	// 最新的 dc5..dc24 应保留（open 态列出 label）
	assert.match(dump.text, /file:dc5\b/);
	assert.match(dump.text, /file:dc24\b/);
	assert.match(dump.text, /open:20\(/);
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
	await flushAsync();

	const payload = { type: 'event', event: 'agent', payload: { runId: 'r1' } };
	peer.broadcast(payload);
	await flushAsync();

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

test('WebRtcPeer: broadcast send 失败时不抛异常（RpcDcSender 内部捕获）', async () => {
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
	await flushAsync();

	peer.broadcast({ type: 'res', id: 'y' });
	await flushAsync();
	// RpcDcSender 内部 __sendOne try/catch 记录 warn，broadcast 不会抛
	assert.ok(warns.some((l) => l.includes('dc.send failed')));

	await peer.closeAll();
});

// --- sendTo 单播 API ---

test('WebRtcPeer: sendTo 向指定 session 的 rpc DC 发送', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_s01'));
	await peer.handleSignaling(makeOffer('c_s02'));

	const sent = { c_s01: [], c_s02: [] };
	const dc1 = makeMockRpcDc({ send: (d) => sent.c_s01.push(d) });
	const dc2 = makeMockRpcDc({ send: (d) => sent.c_s02.push(d) });
	PC.instances[0].ondatachannel({ channel: dc1 });
	PC.instances[1].ondatachannel({ channel: dc2 });
	await flushAsync();

	const ok = await peer.sendTo('c_s01', { type: 'event', event: 'x' });
	assert.equal(ok, true);
	await flushAsync();
	assert.equal(sent.c_s01.length, 1);
	assert.equal(sent.c_s02.length, 0); // 不发给其他 session

	await peer.closeAll();
});

test('WebRtcPeer: sendTo 在 session 不存在时返回 false', async () => {
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: MockPCFactory(),
		impl: 'ndc',
	});
	assert.equal(await peer.sendTo('nonexistent', { type: 'event' }), false);
});

test('WebRtcPeer: sendTo 在 rpcChannel 未 open 时返回 false', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_s10'));
	// rpcChannel 未赋值
	assert.equal(await peer.sendTo('c_s10', { type: 'event' }), false);

	// rpcChannel 存在但 readyState 非 open
	const dc = makeMockRpcDc({ readyState: 'connecting' });
	PC.instances[0].ondatachannel({ channel: dc });
	assert.equal(await peer.sendTo('c_s10', { type: 'event' }), false);

	await peer.closeAll();
});

test('WebRtcPeer: sendTo 透传 queue.enqueue 返回值（队列满等场景下应返回 false）', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_s_pass'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();
	// monkey-patch queue.enqueue 返回 false 模拟"队列满 / drop"
	const session = peer.__sessions.get('c_s_pass');
	session.rpcQueue.enqueue = async () => false;
	assert.equal(await peer.sendTo('c_s_pass', { type: 'event' }), false, 'sendTo 必须透传 queue.enqueue 的 false 返回');
	await peer.closeAll();
});

test('WebRtcPeer: broadcast 遇到 JSON.stringify 抛（循环引用）→ 不抛，整条丢弃', async () => {
	const PC = MockPCFactory();
	const debugMsgs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: (m) => debugMsgs.push(m) },
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_s_circ'));
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	PC.instances[0].ondatachannel({ channel: dc });
	const circ = { type: 'event' };
	circ.self = circ;
	assert.doesNotThrow(() => peer.broadcast(circ));
	assert.equal(sent.length, 0);
	assert.ok(debugMsgs.some((m) => m.includes('broadcast stringify failed')));
	await peer.closeAll();
});

test('WebRtcPeer: sendTo 遇到 JSON.stringify 抛（循环引用）→ 返回 false，不抛', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_s_circ2'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();
	const circ = { type: 'event' };
	circ.self = circ;
	let ok;
	await assert.doesNotReject(async () => { ok = await peer.sendTo('c_s_circ2', circ); });
	assert.equal(ok, false);
	await peer.closeAll();
});

test('WebRtcPeer: files sendFn 遇到 JSON.stringify 抛（循环引用）→ 不抛，且不发任何坏数据', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		onFileRpc: (payload, sendFn) => {
			const circ = { type: 'res', id: payload.id };
			circ.self = circ;
			sendFn(circ);
		},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_s_circ3'));
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	PC.instances[0].ondatachannel({ channel: dc });
	assert.doesNotThrow(() => {
		dc.onmessage({ data: JSON.stringify({ type: 'req', id: 'tcir', method: 'coclaw.files.list', params: {} }) });
	});
	assert.equal(sent.length, 0, 'stringify 失败时不应有任何 dc.send 发出');
	await peer.closeAll();
});

test('WebRtcPeer: broadcast 收到 undefined payload（stringify 返回 undefined）→ 静默丢弃', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_s_undef'));
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	PC.instances[0].ondatachannel({ channel: dc });
	assert.doesNotThrow(() => peer.broadcast(undefined));
	assert.equal(sent.length, 0);
	await peer.closeAll();
});

// --- __sendPeerTransport & 触发点 ---

/** 轮等微任务：queueMicrotask 入队的回调 + 阶段 1 后 sendTo 的 async 链路 */
async function flushMicrotasks() {
	for (let i = 0; i < 10; i += 1) {
		await new Promise((r) => setImmediate(r));
	}
}

test('WebRtcPeer: pion — rpc dc.onopen 触发 __sendPeerTransport，发送事件到 UI', async () => {
	const PC = PionMockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_pt01'));
	const pc = PC.instances[0];
	pc.selectedCandidatePair = {
		local: { type: 'relay', address: '10.0.0.1', port: 9999, protocol: 'udp', relayProtocol: 'tcp' },
		remote: { type: 'host', address: '1.2.3.4', port: 3000, protocol: 'udp' },
	};

	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	pc.ondatachannel({ channel: dc });
	await flushMicrotasks();
	dc.onopen();
	await flushMicrotasks();

	const frames = sent.map((s) => JSON.parse(s));
	const evt = frames.find((f) => f.type === 'event' && f.event === 'coclaw.rtc.peerTransport');
	assert.ok(evt, '应收到 coclaw.rtc.peerTransport 事件');
	assert.deepEqual(evt.payload, {
		candidateType: 'relay',
		protocol: 'udp',
		relayProtocol: 'tcp',
	});

	await peer.closeAll();
});

test('WebRtcPeer: pion — onselectedcandidatepairchange 触发 __sendPeerTransport（ICE restart 场景）', async () => {
	const PC = PionMockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_pt02'));
	const pc = PC.instances[0];
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	pc.ondatachannel({ channel: dc });
	dc.onopen();
	await flushMicrotasks();
	// 首次 dc.onopen pair 为 null，不应发出事件
	let frames = sent.map((s) => JSON.parse(s));
	assert.ok(!frames.some((f) => f.event === 'coclaw.rtc.peerTransport'));

	// 模拟 ICE 选中 relay
	pc.selectedCandidatePair = {
		local: { type: 'relay', address: '10.0.0.1', port: 9999, protocol: 'udp', relayProtocol: 'udp' },
		remote: { type: 'host', address: '1.2.3.4', port: 3000, protocol: 'udp' },
	};
	pc.onselectedcandidatepairchange();
	await flushMicrotasks();

	frames = sent.map((s) => JSON.parse(s));
	const evts = frames.filter((f) => f.event === 'coclaw.rtc.peerTransport');
	assert.equal(evts.length, 1);
	assert.equal(evts[0].payload.relayProtocol, 'udp');

	await peer.closeAll();
});

test('WebRtcPeer: pion — __sendPeerTransport sendTo 队列拒收（返回 false）→ 回滚签名以便下次重试', async () => {
	const PC = PionMockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_pt_drop'));
	const pc = PC.instances[0];
	pc.selectedCandidatePair = {
		local: { type: 'relay', address: '1.1.1.1', port: 1, protocol: 'udp', relayProtocol: 'tcp' },
		remote: { type: 'host', address: '2.2.2.2', port: 2, protocol: 'udp' },
	};
	const dc = makeMockRpcDc();
	pc.ondatachannel({ channel: dc });
	await flushMicrotasks();
	dc.onopen();
	await flushMicrotasks();

	// dc.onopen 已经发过一次（签名记下），先清空让 onselectedcandidatepairchange 走完整路径
	const session = peer.__sessions.get('c_pt_drop');
	assert.notEqual(session.__lastPeerTransportSig, null, 'dc.onopen 应已记下签名');
	session.__lastPeerTransportSig = null;
	// 让队列拒收（模拟 enqueue 因队列满返回 false）
	session.rpcQueue.enqueue = async () => false;
	pc.onselectedcandidatepairchange();
	await flushMicrotasks();
	// 签名应被回滚为 null，下次相同 pair 变化时可重发
	assert.equal(session.__lastPeerTransportSig, null, 'sendTo 返回 false 时签名应被回滚');

	await peer.closeAll();
});

test('WebRtcPeer: pion — __sendPeerTransport 签名去重：相同 pair 不重复发送', async () => {
	const PC = PionMockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_pt03'));
	const pc = PC.instances[0];
	pc.selectedCandidatePair = {
		local: { type: 'relay', address: '1.1.1.1', port: 1, protocol: 'udp', relayProtocol: 'tcp' },
		remote: { type: 'host', address: '2.2.2.2', port: 2, protocol: 'udp' },
	};
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	pc.ondatachannel({ channel: dc });
	dc.onopen();
	await flushMicrotasks();
	// dc.onopen + onselectedcandidatepairchange 都会触发，但签名相同应只发一次
	pc.onselectedcandidatepairchange();
	pc.onselectedcandidatepairchange();
	await flushMicrotasks();

	const evts = sent.map((s) => JSON.parse(s)).filter((f) => f.event === 'coclaw.rtc.peerTransport');
	assert.equal(evts.length, 1, `期望 1 次，实际 ${evts.length}`);

	await peer.closeAll();
});

test('WebRtcPeer: pion — __sendPeerTransport pair 变化（relay → host）重新发送', async () => {
	const PC = PionMockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_pt04'));
	const pc = PC.instances[0];
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	pc.ondatachannel({ channel: dc });
	await flushMicrotasks();
	pc.selectedCandidatePair = {
		local: { type: 'relay', address: '1.1.1.1', port: 1, protocol: 'udp', relayProtocol: 'udp' },
		remote: {},
	};
	dc.onopen();
	await flushMicrotasks();

	// pair 切换到 host
	pc.selectedCandidatePair = {
		local: { type: 'host', address: '192.168.1.1', port: 2, protocol: 'udp' },
		remote: {},
	};
	pc.onselectedcandidatepairchange();
	await flushMicrotasks();

	const evts = sent.map((s) => JSON.parse(s)).filter((f) => f.event === 'coclaw.rtc.peerTransport');
	assert.equal(evts.length, 2);
	assert.equal(evts[0].payload.candidateType, 'relay');
	assert.equal(evts[1].payload.candidateType, 'host');
	assert.equal(evts[1].payload.relayProtocol, null);

	await peer.closeAll();
});

test('WebRtcPeer: pion — __sendPeerTransport pair 未就绪时早退', async () => {
	const PC = PionMockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_pt05'));
	const pc = PC.instances[0];
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	pc.ondatachannel({ channel: dc });
	// 不设置 selectedCandidatePair
	pc.selectedCandidatePair = null;
	dc.onopen();
	await flushMicrotasks();

	const evts = sent.map((s) => JSON.parse(s)).filter((f) => f.event === 'coclaw.rtc.peerTransport');
	assert.equal(evts.length, 0);

	await peer.closeAll();
});

test('WebRtcPeer: __sendPeerTransport session 不存在时静默返回', async () => {
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: MockPCFactory(),
		impl: 'pion',
	});
	// 阶段 1 后 __sendPeerTransport 是 async；不抛异常即可
	await peer.__sendPeerTransport('nonexistent');
});

test('WebRtcPeer: pion — microtask 执行前 session 已被 close，__sendPeerTransport 静默早退', async () => {
	const PC = PionMockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_pt07'));
	const pc = PC.instances[0];
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	pc.ondatachannel({ channel: dc });
	pc.selectedCandidatePair = {
		local: { type: 'relay', address: '1.1.1.1', port: 1, protocol: 'udp', relayProtocol: 'udp' },
		remote: {},
	};

	// 同步触发 onselectedcandidatepairchange（queueMicrotask 入队 __sendPeerTransport），
	// 微任务执行前立刻 close —— 此时微任务里 __sessions.get 返回 undefined，应静默早退
	pc.onselectedcandidatepairchange();
	await peer.closeByConnId('c_pt07');
	await flushMicrotasks();

	const evts = sent.map((s) => JSON.parse(s)).filter((f) => f.event === 'coclaw.rtc.peerTransport');
	assert.equal(evts.length, 0, 'close 先于 microtask 时不应发送任何事件');
});

test('WebRtcPeer: pion — sendTo 失败时 __sendPeerTransport 回滚签名允许重试', async () => {
	const PC = PionMockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_pt06'));
	const pc = PC.instances[0];
	pc.selectedCandidatePair = {
		local: { type: 'relay', address: '1.1.1.1', port: 1, protocol: 'udp', relayProtocol: 'udp' },
		remote: {},
	};
	// 先在 rpcChannel 未 open 时触发 selectedpairchange → sendTo 失败
	pc.onselectedcandidatepairchange();
	await flushMicrotasks();
	assert.equal(peer.__sessions.get('c_pt06').__lastPeerTransportSig, null, '签名应被回滚');

	// 随后 dc.onopen（或再次 pair-change）应能成功发送
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	pc.ondatachannel({ channel: dc });
	await flushMicrotasks();
	dc.onopen();
	await flushMicrotasks();

	const evts = sent.map((s) => JSON.parse(s)).filter((f) => f.event === 'coclaw.rtc.peerTransport');
	assert.equal(evts.length, 1);

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
	await flushAsync();

	fakeChannel.onmessage({ data: JSON.stringify({ type: 'req', id: 'f2', method: 'coclaw.files.list', params: {} }) });
	await flushAsync();

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

// --- ICE restart credRemain 诊断字段 ---

test('WebRtcPeer: ICE restart 日志带 credRemain（凭证仍有效）', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_cr01'));

	// 构造未过期凭证：expireAt = now + 3600
	const expireAt = Math.floor(Date.now() / 1000) + 3600;
	resetRemoteLog();
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_cr01',
		payload: { sdp: 'sdp', iceRestart: true },
		turnCreds: { username: `${expireAt}:42`, credential: 'x', urls: [] },
	});

	const log = remoteLogBuffer.find((e) => /rtc\.ice-restart conn=c_cr01/.test(e.text));
	assert.ok(log, `expected rtc.ice-restart log, got: ${JSON.stringify(remoteLogBuffer.map((e) => e.text))}`);
	const m = log.text.match(/credRemain=(-?\d+)/);
	assert.ok(m, `credRemain field missing in log: ${log.text}`);
	const v = Number(m[1]);
	assert.ok(v > 3500 && v <= 3600, `credRemain ${v} should be ~3600`);

	await peer.closeAll();
});

test('WebRtcPeer: ICE restart 日志 credRemain 为负（凭证已过期）', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_cr02'));

	// 构造已过期凭证：expireAt = now - 60
	const expireAt = Math.floor(Date.now() / 1000) - 60;
	resetRemoteLog();
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_cr02',
		payload: { sdp: 'sdp', iceRestart: true },
		turnCreds: { username: `${expireAt}:42`, credential: 'x', urls: [] },
	});

	const log = remoteLogBuffer.find((e) => /rtc\.ice-restart conn=c_cr02/.test(e.text));
	assert.ok(log, 'expected rtc.ice-restart log');
	const m = log.text.match(/credRemain=(-?\d+)/);
	assert.ok(m, `credRemain field missing: ${log.text}`);
	assert.ok(Number(m[1]) < 0, `expected negative credRemain, got ${m[1]}`);

	await peer.closeAll();
});

test('WebRtcPeer: ICE restart 日志 credRemain=none（无 turnCreds 或解析失败）', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_cr03'));

	// 1) 不带 turnCreds → credRemain=none
	resetRemoteLog();
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_cr03',
		payload: { sdp: 'sdp', iceRestart: true },
	});
	let log = remoteLogBuffer.find((e) => /rtc\.ice-restart conn=c_cr03/.test(e.text));
	assert.ok(/credRemain=none/.test(log.text), `expected credRemain=none, got: ${log.text}`);

	// 2) username 不含冒号或非数字时间戳 → credRemain=none
	resetRemoteLog();
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_cr03',
		payload: { sdp: 'sdp', iceRestart: true },
		turnCreds: { username: 'malformed', credential: 'x', urls: [] },
	});
	log = remoteLogBuffer.find((e) => /rtc\.ice-restart conn=c_cr03/.test(e.text));
	assert.ok(/credRemain=none/.test(log.text), `expected credRemain=none for malformed username, got: ${log.text}`);

	await peer.closeAll();
});

test('WebRtcPeer: ICE restart 各失败/拒绝路径日志均带 credRemain', async () => {
	const expireAt = Math.floor(Date.now() / 1000) + 1800;
	const turnCreds = { username: `${expireAt}:42`, credential: 'x', urls: [] };

	// 1) ice-restart-no-session：无 session 时
	{
		resetRemoteLog();
		const PC = MockPCFactory();
		const peer = new WebRtcPeer({
			onSend: () => {},
			logger: silentLogger(),
			PeerConnection: PC,
			impl: 'pion',
		});
		await peer.handleSignaling({
			type: 'rtc:offer',
			fromConnId: 'c_cr_ns',
			payload: { sdp: 'sdp', iceRestart: true },
			turnCreds,
		});
		const log = remoteLogBuffer.find((e) => /rtc\.ice-restart-no-session/.test(e.text));
		assert.ok(log && /credRemain=\d+/.test(log.text), `no-session log missing credRemain: ${log?.text}`);
	}

	// 2) ice-restart-unsupported：非 pion impl
	{
		resetRemoteLog();
		const PC = MockPCFactory();
		const peer = new WebRtcPeer({
			onSend: () => {},
			logger: silentLogger(),
			PeerConnection: PC,
			impl: 'ndc',
		});
		await peer.handleSignaling(makeOffer('c_cr_un'));
		resetRemoteLog();
		await peer.handleSignaling({
			type: 'rtc:offer',
			fromConnId: 'c_cr_un',
			payload: { sdp: 'sdp', iceRestart: true },
			turnCreds,
		});
		const log = remoteLogBuffer.find((e) => /rtc\.ice-restart-unsupported/.test(e.text));
		assert.ok(log && /credRemain=\d+/.test(log.text), `unsupported log missing credRemain: ${log?.text}`);
		await peer.closeAll();
	}

	// 3) ice-restart-failed：协商抛错
	{
		resetRemoteLog();
		const PC = MockPCFactory();
		const peer = new WebRtcPeer({
			onSend: () => {},
			logger: silentLogger(),
			PeerConnection: PC,
			impl: 'pion',
		});
		await peer.handleSignaling(makeOffer('c_cr_fail'));
		PC.instances[0].setRemoteDescription = async () => { throw new Error('boom'); };
		resetRemoteLog();
		await peer.handleSignaling({
			type: 'rtc:offer',
			fromConnId: 'c_cr_fail',
			payload: { sdp: 'sdp', iceRestart: true },
			turnCreds,
		});
		const log = remoteLogBuffer.find((e) => /rtc\.ice-restart-failed/.test(e.text));
		assert.ok(log && /credRemain=\d+/.test(log.text), `failed log missing credRemain: ${log?.text}`);
	}
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
	await flushAsync();

	peer.broadcast({ type: 'event', event: 'ping' });
	await flushAsync();
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
	await flushAsync();

	const largePayload = { type: 'res', data: 'X'.repeat(200) };
	peer.broadcast(largePayload);
	await flushAsync();

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
	await flushAsync();

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
	await flushAsync();

	// 发送 file RPC 请求
	dc.onmessage({ data: JSON.stringify({ type: 'req', id: 'ui-f1', method: 'coclaw.files.read', params: {} }) });
	await flushAsync();

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

test('WebRtcPeer: rpc DC dc.onmessage 旧 DC 迟到的 req 不污染新 session（identity guard）', async () => {
	// 与 dc.onclose 的 identity guard 对称：DC 重建后，旧 dc 的 reassembler 回调可能仍在 microtask
	// 队列里待派发；进入 req 分支前必须核身份，否则旧请求会注入 __onRequest（或 enqueue 到新 rpcQueue）
	const PC = MockPCFactory();
	const requests = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		onRequest: (payload, connId) => requests.push({ payload, connId }),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_h1guard'));
	const dc1 = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc1 });

	const session = peer.__sessions.get('c_h1guard');
	assert.equal(session.rpcChannel, dc1);

	// 模拟 DC 重建：rpcChannel 已被新 dc2 覆盖（这里只换 rpcChannel 字段，不真正起新 setup）
	const dc2 = makeMockRpcDc();
	session.rpcChannel = dc2;

	// 旧 dc1 现在派发 message 事件（reassembler.feed 直接交付完整 string）
	const reqPayload = JSON.stringify({ type: 'req', id: 'r1', method: 'gateway.foo', params: {} });
	dc1.onmessage({ data: reqPayload });

	assert.equal(requests.length, 0, '旧 DC 的迟到 req 不应进入 __onRequest');
	await peer.closeAll();
});

// --- MemoryQueue + RpcDcSender 集成（阶段 1 替换原 RpcSendQueue 集成）---

test('WebRtcPeer: 建立 rpc DC 时创建 MemoryQueue + RpcDcSender 并设置 bufferedAmountLowThreshold', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_sq01'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	const session = peer.__sessions.get('c_sq01');
	assert.ok(session.rpcQueue, 'rpcQueue should be created');
	assert.ok(session.rpcDcSender, 'rpcDcSender should be created');
	assert.ok(session.rpcConsumeLoop instanceof Promise, 'rpcConsumeLoop should be a Promise');
	assert.equal(dc.bufferedAmountLowThreshold, DC_LOW_WATER_MARK, 'LOW_WATER_MARK should be set on DC');
	assert.equal(typeof dc.onbufferedamountlow, 'function', 'onbufferedamountlow should be wired');
	await peer.closeAll();
});

test('WebRtcPeer: file DC 不创建 rpc 链路（仅 rpc label 触发）', async () => {
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
	assert.equal(session.rpcQueue, null, 'file DC must not create rpc queue');
	assert.equal(session.rpcDcSender, null);
	assert.equal(session.fileChannels.size, 1);
	await peer.closeAll();
});

test('WebRtcPeer: DC 不支持 bufferedAmountLowThreshold 时跳过设置但仍创建 queue/sender', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'ndc' });
	await peer.handleSignaling(makeOffer('c_sq_noba'));
	const dc = { label: 'rpc', readyState: 'open', bufferedAmount: 0, send: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null };
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();
	const session = peer.__sessions.get('c_sq_noba');
	assert.ok(session.rpcQueue);
	assert.ok(session.rpcDcSender);
	assert.equal('bufferedAmountLowThreshold' in dc, false, 'threshold 属性未被注入');
	await peer.closeAll();
});

test('WebRtcPeer: ICE restart 保留 queue/sender 实例与积压', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_sq_icr', 'v=0\r\na=max-message-size:100\r\n'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();
	const session = peer.__sessions.get('c_sq_icr');
	const queueBefore = session.rpcQueue;
	const senderBefore = session.rpcDcSender;

	// 让 queue 堆积消息：bufferedAmount 顶到 HIGH，sender 阻塞在第 1 条 chunk；多条消息排在
	// queue 中等待。架构差异：原 RpcSendQueue 把所有 chunks 缓在 queue 内；新架构以"完整消息"
	// 为粒度排队，已被消费者拉走的消息进入 sender 的 chunk 循环（其中 1 条 chunk 卡在 BAL 等待）。
	dc.bufferedAmount = 1024 * 1024;
	for (let i = 0; i < 5; i += 1) {
		peer.broadcast({ type: 'res', data: 'Q', n: i });
	}
	await flushAsync();
	const memCountBefore = queueBefore.stats().memCount;
	assert.ok(memCountBefore > 0, 'pending messages should accumulate in queue while sender is blocked');
	assert.ok(senderBefore.balWaiters.length >= 1, 'sender should have a pending BAL waiter');

	// ICE restart offer（同 connId）
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_sq_icr',
		payload: { sdp: 'v=0\r\na=max-message-size:100\r\n', iceRestart: true },
	});

	// queue/sender 实例都应保持不变（设计要点：ICE restart 不触发 DC close）
	assert.equal(session.rpcQueue, queueBefore, 'same queue instance preserved');
	assert.equal(session.rpcDcSender, senderBefore, 'same sender instance preserved');
	assert.equal(queueBefore.destroyed, false);
	assert.equal(senderBefore.closed, false);
	assert.equal(queueBefore.stats().memCount, memCountBefore, 'queue residual preserved across ICE restart');

	// 模拟 SACK 恢复 → BAL → 消费循环继续把积压拉空
	for (let i = 0; i < 30 && queueBefore.stats().memCount > 0; i += 1) {
		dc.bufferedAmount = 0;
		dc.onbufferedamountlow();
		await flushAsync();
	}
	assert.equal(queueBefore.stats().memCount, 0, 'queue drained after restart');
	await peer.closeAll();
});

test('WebRtcPeer: ICE restart 重协商 max-message-size 变化时刷新 sender.maxMessageSize', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_mms_icr', 'v=0\r\na=max-message-size:100\r\n'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();
	const session = peer.__sessions.get('c_mms_icr');
	assert.equal(session.remoteMaxMessageSize, 100);
	assert.equal(session.rpcDcSender.maxMessageSize, 100);

	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mms_icr',
		payload: { sdp: 'v=0\r\na=max-message-size:512\r\n', iceRestart: true },
	});
	assert.equal(session.remoteMaxMessageSize, 512, 'session value refreshed');
	assert.equal(session.rpcDcSender.maxMessageSize, 512, 'sender value refreshed');
	await peer.closeAll();
});

test('WebRtcPeer: ICE restart 同 max-message-size 不触发 sender 刷新（实例同值）', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_mms_same', 'v=0\r\na=max-message-size:200\r\n'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();
	const session = peer.__sessions.get('c_mms_same');
	const senderBefore = session.rpcDcSender;
	assert.equal(senderBefore.maxMessageSize, 200);

	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mms_same',
		payload: { sdp: 'v=0\r\na=max-message-size:200\r\n', iceRestart: true },
	});
	assert.equal(session.remoteMaxMessageSize, 200);
	assert.equal(session.rpcDcSender, senderBefore);
	assert.equal(senderBefore.maxMessageSize, 200);
	await peer.closeAll();
});

test('WebRtcPeer: closeByConnId 显式关闭 sender + 销毁 queue + 等待消费循环退出，触发 close 汇总 remoteLog', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_close_q', 'v=0\r\na=max-message-size:100\r\n'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();
	const session = peer.__sessions.get('c_close_q');
	const q = session.rpcQueue;
	// 制造残留：bufferedAmount 高让 sender 阻塞在第 1 条；多条消息排在 queue 形成残留
	dc.bufferedAmount = 1024 * 1024;
	for (let i = 0; i < 5; i += 1) {
		peer.broadcast({ type: 'res', data: 'Y', n: i });
	}
	await flushAsync();
	assert.ok(q.stats().memCount > 0, 'queue should have pending messages');

	// closeByConnId 应主动 close sender + destroy queue + await consumeLoop
	await peer.closeByConnId('c_close_q');
	assert.equal(q.destroyed, true, 'queue must be destroyed by closeByConnId');
	const closeLog = remoteLogBuffer.find((e) => /rpc-queue\.close/.test(e.text));
	assert.ok(closeLog, 'rpc-queue.close log expected when queue had residual');
	assert.match(closeLog.text, /residualChunks=[1-9]/);
});

test('WebRtcPeer: onbufferedamountlow 事件触发 sender drain', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_sq02', 'v=0\r\na=max-message-size:100\r\n'));
	const sent = [];
	const dc = makeMockRpcDc({
		send(d) {
			const len = typeof d === 'string' ? Buffer.byteLength(d, 'utf8') : d.length;
			dc.bufferedAmount += len;
			sent.push(d);
		},
	});
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	// 顶到 HIGH，让 sender 阻塞在第一条 chunk 的 BAL 等待
	dc.bufferedAmount = 1024 * 1024;
	peer.broadcast({ type: 'res', data: 'X'.repeat(500) });
	await flushAsync();
	const session = peer.__sessions.get('c_sq02');
	assert.ok(session.rpcDcSender.balWaiters.length >= 1, 'sender should be blocked on BAL');
	assert.equal(sent.length, 0, 'no chunk sent while bufferedAmount is HIGH');

	// 模拟 SACK：bufferedAmount 降到 0，触发 onbufferedamountlow 多轮（每轮发完后会再顶满）
	for (let i = 0; i < 30 && session.rpcDcSender.balWaiters.length > 0; i += 1) {
		dc.bufferedAmount = 0;
		dc.onbufferedamountlow();
		await flushAsync();
	}

	assert.ok(sent.length > 0, 'chunks drained after BAL');
	await peer.closeAll();
});

test('WebRtcPeer: dc.onclose 关闭 sender + 销毁 queue，之后 broadcast 不再 send', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_sq03'));
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	const session = peer.__sessions.get('c_sq03');
	assert.ok(session.rpcQueue);
	assert.ok(session.rpcDcSender);

	// 触发 onclose
	dc.readyState = 'closed';
	dc.onclose();
	assert.equal(session.rpcQueue, null);
	assert.equal(session.rpcDcSender, null);
	assert.equal(session.rpcConsumeLoop, null);
	assert.equal(session.rpcChannel, null);

	// 之后 broadcast 不应 send（rpcQueue===null 时跳过）
	const sentBefore = sent.length;
	peer.broadcast({ type: 'event', event: 'after-close' });
	await flushAsync();
	assert.equal(sent.length, sentBefore);
	await peer.closeAll();
});

test('WebRtcPeer: 同 session 第二条 rpc DC → 旧三件套被 close + destroy（防御 UI 重建场景）', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_rebuild'));
	const dc1 = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc1 });
	await flushAsync();

	const session = peer.__sessions.get('c_rebuild');
	const oldQueue = session.rpcQueue;
	const oldSender = session.rpcDcSender;
	const oldLoop = session.rpcConsumeLoop;
	assert.ok(oldQueue && oldSender && oldLoop);

	// 模拟 UI 重建 rpc DC：ondatachannel 再来一条 'rpc' label
	const dc2 = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc2 });
	await flushAsync();

	// 旧三件套应被关闭 / 销毁；新三件套已就位且与旧的不同实例
	assert.equal(oldSender.closed, true, '旧 sender 应被 close');
	assert.equal(oldQueue.destroyed, true, '旧 queue 应被 destroy');
	assert.notEqual(session.rpcQueue, oldQueue, '新 queue 实例已替换');
	assert.notEqual(session.rpcDcSender, oldSender, '新 sender 实例已替换');
	assert.notEqual(session.rpcConsumeLoop, oldLoop, '新 consumeLoop 实例已替换');
	// 旧 loop 应因 SENDER_CLOSED break 退出（finally identity guard 检查 session.rpcQueue===oldQueue
	// 失败，不会清新字段）
	await oldLoop;
	assert.ok(session.rpcQueue, '旧 loop 退出后新 queue 仍在');
	assert.ok(session.rpcDcSender, '旧 loop 退出后新 sender 仍在');

	await peer.closeAll();
});

test('WebRtcPeer: connId 复用后旧 PC 的 ondatachannel 微任务迟到 → pc identity guard 防止污染新 session', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_reuse'));
	const oldPc = PC.instances[0];
	// 捕获旧 ondatachannel handler 引用：模拟"事件已 dispatch 但回调未执行"的微任务窗口；
	// closeByConnId 把 pc.ondatachannel = null 不能阻止已 queue 的 callback
	const staleOndatachannel = oldPc.ondatachannel;
	assert.equal(typeof staleOndatachannel, 'function');

	await peer.closeByConnId('c_reuse');

	// 同 connId 复用，建立新 session
	await peer.handleSignaling(makeOffer('c_reuse'));
	const newPc = PC.instances[1];
	const newDc = makeMockRpcDc();
	newPc.ondatachannel({ channel: newDc });
	await flushAsync();
	const session = peer.__sessions.get('c_reuse');
	assert.equal(session.rpcChannel, newDc, 'baseline: 新 dc 装入新 session');
	const newQueue = session.rpcQueue;
	const newSender = session.rpcDcSender;

	// 模拟旧 PC 的 ondatachannel 微任务迟到投递：闭包内 session 仍是旧 session 引用，
	// 调 __setupDataChannel(connId, staleDc) 进去后 Map.get(connId) 拿到的是新 session
	const staleDc = makeMockRpcDc();
	staleOndatachannel({ channel: staleDc });
	await flushAsync();

	// pc identity guard 必须把 staleDc 拒于门外，不污染新 session
	assert.equal(session.rpcChannel, newDc, '新 session.rpcChannel 不应被旧 dc 替换');
	assert.equal(session.rpcQueue, newQueue, '新 queue 不应被旧 ondatachannel 触发的 setup 替换');
	assert.equal(session.rpcDcSender, newSender, '新 sender 不应被旧 ondatachannel 触发的 setup 替换');

	await peer.closeAll();
});

test('WebRtcPeer: 旧 dc.onbufferedamountlow 在新 sender 阻塞期间迟到 → 不应错唤醒新 sender', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_bal_late'));
	const dc1 = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc1 });
	await flushAsync();

	// 同 session rebuild：新 dc bufferedAmount 顶到高水位，新 sender 一发就阻塞
	const sentDc2 = [];
	const dc2 = makeMockRpcDc({
		bufferedAmount: DC_HIGH_WATER_MARK + 1,
		send: (d) => sentDc2.push(d),
	});
	PC.instances[0].ondatachannel({ channel: dc2 });
	await flushAsync();

	const session = peer.__sessions.get('c_bal_late');
	const newSender = session.rpcDcSender;

	// 让新 sender 进 BAL waiter
	peer.broadcast({ type: 'event', event: 'x' });
	await flushAsync();
	assert.equal(newSender.balWaiters.length, 1, '新 sender 应卡在 BAL');
	assert.equal(sentDc2.length, 0, '高水位时新 dc 不应发送');

	// 旧 dc1.onbufferedamountlow 迟到触发：闭包若读 session.rpcDcSender 就会唤醒新 sender
	dc1.onbufferedamountlow();
	await flushAsync();

	assert.equal(newSender.balWaiters.length, 1, '旧 dc1 BAL 不应唤醒新 sender');
	assert.equal(sentDc2.length, 0, '新 dc 仍应阻塞在高水位');

	await peer.closeAll();
});

test('WebRtcPeer: 旧 dc.onclose 在新三件套就位后迟到 → identity guard 防止误清新三件套', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_dc1_late'));
	const dc1 = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc1 });
	await flushAsync();

	// 第二条 rpc DC 替换三件套（UI 重建 rpc DC 场景）
	const dc2 = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc2 });
	await flushAsync();

	const session = peer.__sessions.get('c_dc1_late');
	const newQueue = session.rpcQueue;
	const newSender = session.rpcDcSender;
	const newLoop = session.rpcConsumeLoop;
	assert.ok(newQueue && newSender && newLoop);
	assert.equal(session.rpcChannel, dc2);

	// 模拟旧 dc1.onclose 在新三件套就位后才到达（WebRTC 实现可能延迟投递 close 事件）
	dc1.readyState = 'closed';
	dc1.onclose();
	await flushAsync();

	// identity guard 必须按 sess.rpcChannel === dc 判定，否则旧 dc 错清新三件套
	assert.equal(session.rpcQueue, newQueue, '旧 dc1.onclose 不应清新 queue');
	assert.equal(session.rpcDcSender, newSender, '旧 dc1.onclose 不应清新 sender');
	assert.equal(session.rpcConsumeLoop, newLoop, '旧 dc1.onclose 不应清新 loop');
	assert.equal(session.rpcChannel, dc2, '旧 dc1.onclose 不应清 rpcChannel');
	assert.equal(newSender.closed, false, '新 sender 不应被 close');
	assert.equal(newQueue.destroyed, false, '新 queue 不应被 destroy');

	await peer.closeAll();
});

test('WebRtcPeer: dc.send 持续抛 → consumeLoop 自身退出后清空 session 三字段（finally 防御）', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_sq_finally'));
	// dc 一直 open 但 send 抛 → sender 包成 SENDER_CLOSED → loop break → finally
	// 此场景下 dc.onclose 不会自动触发（dc.readyState 仍 'open'），fields 是否清完全靠 finally 防御
	const dc = makeMockRpcDc({ send: () => { throw new Error('persistent dc.send error'); } });
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	const session = peer.__sessions.get('c_sq_finally');
	assert.ok(session.rpcQueue);
	assert.ok(session.rpcDcSender);
	assert.ok(session.rpcConsumeLoop);

	peer.broadcast({ type: 'event', event: 'trigger' });
	await flushAsync();
	// finally 防御兜底：dc 仍 'open' 没触发 dc.onclose，三字段应由 loop 自身的 finally 清空
	assert.equal(session.rpcQueue, null);
	assert.equal(session.rpcDcSender, null);
	assert.equal(session.rpcConsumeLoop, null);
	await peer.closeAll();
});

test('WebRtcPeer: broadcast 遇到 buildChunks 异常 → 不抛、消费循环 warn 上报后继续', async () => {
	const PC = MockPCFactory();
	const warnMsgs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: (m) => warnMsgs.push(m), error: () => {}, debug: () => {} },
		PeerConnection: PC,
		impl: 'ndc',
	});
	// 过小的 maxMessageSize 让 buildChunks 抛（chunkPayloadSize <= 0）
	await peer.handleSignaling(makeOffer('c_sq_throw_b', 'v=0\r\na=max-message-size:3\r\n'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	// payload > 3 bytes → 触发分片路径；buildChunks 在 sender 内部抛 BUILD_CHUNKS_FAILED，
	// 消费循环 warn `rpc-dc.send-failed code=BUILD_CHUNKS_FAILED ...`
	assert.doesNotThrow(() => peer.broadcast({ type: 'res', data: 'hello world' }));
	await flushAsync();
	// sender 内部 __safeWarn 'build-chunks-failed' + 消费循环 'rpc-dc.send-failed code=BUILD_CHUNKS_FAILED' 各一条
	assert.ok(warnMsgs.some((m) => m.includes('build-chunks-failed')), 'sender 应 warn build-chunks-failed');
	assert.ok(warnMsgs.some((m) => m.includes('rpc-dc.send-failed code=BUILD_CHUNKS_FAILED')), '消费循环应 warn rpc-dc.send-failed');
	await peer.closeAll();
});

test('WebRtcPeer: files sendFn 遇到 buildChunks 异常 → 不抛、消费循环 warn 上报', async () => {
	const PC = MockPCFactory();
	const warnMsgs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		onFileRpc: (payload, sendFn) => {
			sendFn({ type: 'res', id: payload.id, data: 'hello world' });
		},
		logger: { info: () => {}, warn: (m) => warnMsgs.push(m), error: () => {}, debug: () => {} },
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_sq_throw_f', 'v=0\r\na=max-message-size:3\r\n'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	assert.doesNotThrow(() => {
		dc.onmessage({ data: JSON.stringify({ type: 'req', id: 'tfz', method: 'coclaw.files.list', params: {} }) });
	});
	await flushAsync();
	assert.ok(warnMsgs.some((m) => m.includes('build-chunks-failed')), 'sender 应 warn build-chunks-failed');
	assert.ok(warnMsgs.some((m) => m.includes('rpc-dc.send-failed code=BUILD_CHUNKS_FAILED')), '消费循环应 warn rpc-dc.send-failed');
	await peer.closeAll();
});

test('WebRtcPeer: probe-ack 绕过 MemoryQueue + RpcDcSender（背压场景 + spy 双验证）', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_sq04'));
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	// 模拟背压条件
	const session = peer.__sessions.get('c_sq04');
	dc.bufferedAmount = 10 * 1024 * 1024; // 远超 HIGH

	// spy 替换 queue.enqueue + sender.send — 任一被调说明 probe-ack 误走了队列
	let queueEnqueueCallCount = 0;
	let senderSendCallCount = 0;
	const origEnqueue = session.rpcQueue.enqueue.bind(session.rpcQueue);
	const origSenderSend = session.rpcDcSender.send.bind(session.rpcDcSender);
	session.rpcQueue.enqueue = async (jsonStr) => {
		queueEnqueueCallCount += 1;
		return await origEnqueue(jsonStr);
	};
	session.rpcDcSender.send = async (jsonStr) => {
		senderSendCallCount += 1;
		return await origSenderSend(jsonStr);
	};

	// 收到 probe → 触发 probe-ack（应绕过 queue/sender 直发，背压条件下仍成功）
	dc.onmessage({ data: JSON.stringify({ type: 'probe' }) });
	await flushAsync();

	const lastSent = sent[sent.length - 1];
	assert.equal(typeof lastSent, 'string');
	assert.equal(JSON.parse(lastSent).type, 'probe-ack');
	assert.equal(queueEnqueueCallCount, 0, 'probe-ack must NOT go through rpcQueue.enqueue');
	assert.equal(senderSendCallCount, 0, 'probe-ack must NOT go through rpcDcSender.send');
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
		onicegatheringstatechange: null,
		ondatachannel: null,
		connectionState: 'new',
		iceGatheringState: 'new',
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
		local: { type: 'relay', address: '10.0.0.1', port: 9999, protocol: 'udp', relayProtocol: 'tcp' },
		remote: { type: 'srflx', address: '203.0.113.1', port: 8888, protocol: 'udp' },
	};
	pc.onselectedcandidatepairchange();

	// 日志格式升级：type/protocol(relayProtocol) address:port
	assert.ok(logs.some((l) => l.includes('ICE nominated: local=relay/udp(tcp) 10.0.0.1:9999 remote=srflx/udp 203.0.113.1:8888')));
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

// --- 诊断日志：ICE restart-answer-sent + iceConnectionState + connected 恢复 dump + plugin-probe ---

test('WebRtcPeer: ICE restart 成功回复 answer 时输出 rtc.restart-answer-sent', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_ras01'));
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_ras01',
		payload: { sdp: 'ice-restart-sdp', iceRestart: true },
	});

	assert.ok(
		remoteLogBuffer.some((e) => e.text.includes('rtc.restart-answer-sent') && e.text.includes('c_ras01')),
		'should emit rtc.restart-answer-sent after successful restart',
	);

	await peer.closeAll();
});

test('WebRtcPeer: pion oniceconnectionstatechange 触发 rtc.iceState 日志', async () => {
	resetRemoteLog();
	// 构造带 oniceconnectionstatechange / iceConnectionState 的 mock（模拟 pion-node 行为）
	function PionPC() {
		const pc = createMockPC();
		pc.iceConnectionState = 'new';
		// 通过直接设置属性而非 Object.defineProperty 使 `'...' in pc` 为 true
		pc.oniceconnectionstatechange = null;
		return pc;
	}
	PionPC.instances = [];
	function Factory() {
		const pc = PionPC();
		PionPC.instances.push(pc);
		return pc;
	}
	Factory.instances = PionPC.instances;

	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: Factory,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_ics01'));
	const pc = Factory.instances[0];
	pc.iceConnectionState = 'checking';
	pc.oniceconnectionstatechange();
	pc.iceConnectionState = 'connected';
	pc.oniceconnectionstatechange();

	const lines = remoteLogBuffer.filter((e) => /rtc\.iceState/.test(e.text) && /c_ics01/.test(e.text));
	assert.equal(lines.length, 2, 'should emit one iceState line per state change');
	assert.ok(lines[0].text.includes('checking'));
	assert.ok(lines[1].text.includes('connected'));

	await peer.closeAll();
});

test('WebRtcPeer: pion oniceconnectionstatechange 对旧 PC 回调 no-op（pc 归属校验）', async () => {
	resetRemoteLog();
	function PionPC() {
		const pc = createMockPC();
		pc.iceConnectionState = 'new';
		pc.oniceconnectionstatechange = null;
		return pc;
	}
	const instances = [];
	function Factory() {
		const pc = PionPC();
		instances.push(pc);
		return pc;
	}

	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: Factory,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_ics02'));
	const oldPc = instances[0];
	const oldHandler = oldPc.oniceconnectionstatechange;

	await peer.handleSignaling(makeOffer('c_ics02')); // 替换 PC
	const newPc = instances[1];
	assert.notEqual(oldPc, newPc);

	oldPc.iceConnectionState = 'checking';
	oldHandler(); // 旧 PC 回调不应记录日志

	const lines = remoteLogBuffer.filter((e) => /rtc\.iceState.*c_ics02/.test(e.text));
	assert.equal(lines.length, 0, 'stale PC oniceconnectionstatechange should be ignored');

	await peer.closeAll();
});

test('WebRtcPeer: pion 从 disconnected 恢复 connected 时 dump + 调度 plugin-probe', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_rec01'));
	const pc = PC.instances[0];

	// 装配一个打开的 rpc DC，让 __sendPluginProbe 有目标可发
	const session = peer.__sessions.get('c_rec01');
	const dcSent = [];
	session.rpcChannel = makeMockRpcDc({ send: (d) => dcSent.push(d) });

	// 先 disconnected，再 connected → 触发恢复分支
	pc.connectionState = 'disconnected';
	pc.onconnectionstatechange();
	pc.connectionState = 'connected';
	pc.onconnectionstatechange();

	// 期望：rtc.dump state=connected 出现一次
	const dumps = remoteLogBuffer.filter((e) => /rtc\.dump/.test(e.text) && /c_rec01/.test(e.text) && /state=connected/.test(e.text));
	assert.equal(dumps.length, 1, 'should dump on disconnected→connected recovery');

	// 推进 500ms 让 probe 发出
	t.mock.timers.tick(500);

	assert.equal(dcSent.length, 1, 'plugin-probe should be sent after 500ms');
	const payload = JSON.parse(dcSent[0]);
	assert.equal(payload.type, 'plugin-probe');
	assert.ok(typeof payload.id === 'number');
	assert.ok(remoteLogBuffer.some((e) => /rtc\.plugin-probe.*c_rec01.*sent/.test(e.text)));

	await peer.closeAll();
});

test('WebRtcPeer: 首次 connected（prevDumpState 为 null）不触发恢复 dump/probe', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_first01'));
	const pc = PC.instances[0];
	const session = peer.__sessions.get('c_first01');
	const dcSent = [];
	session.rpcChannel = makeMockRpcDc({ send: (d) => dcSent.push(d) });

	// 首次进入 connected，此前没有 dump（prevDumpState=null）
	pc.connectionState = 'connected';
	pc.onconnectionstatechange();

	t.mock.timers.tick(500);

	const dumps = remoteLogBuffer.filter((e) => /rtc\.dump/.test(e.text) && /c_first01/.test(e.text) && /state=connected/.test(e.text));
	assert.equal(dumps.length, 0, 'initial connected should not dump');
	assert.equal(dcSent.length, 0, 'initial connected should not send plugin-probe');

	await peer.closeAll();
});

test('WebRtcPeer: 非 pion impl 的 connected 恢复不触发 dump/probe', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc', // 非 pion
	});

	await peer.handleSignaling(makeOffer('c_ndc01'));
	const pc = PC.instances[0];
	const session = peer.__sessions.get('c_ndc01');
	const dcSent = [];
	session.rpcChannel = makeMockRpcDc({ send: (d) => dcSent.push(d) });

	pc.connectionState = 'disconnected';
	pc.onconnectionstatechange();
	pc.connectionState = 'connected';
	pc.onconnectionstatechange();
	t.mock.timers.tick(500);

	const dumps = remoteLogBuffer.filter((e) => /rtc\.dump/.test(e.text) && /c_ndc01/.test(e.text) && /state=connected/.test(e.text));
	assert.equal(dumps.length, 0, 'non-pion impl should not dump on recovery');
	assert.equal(dcSent.length, 0, 'non-pion impl should not send plugin-probe');

	await peer.closeAll();
});

test('WebRtcPeer: __sendPluginProbe 无 session 时静默', () => {
	resetRemoteLog();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: MockPCFactory(),
		impl: 'pion',
	});
	peer.__sendPluginProbe('missing');
	const lines = remoteLogBuffer.filter((e) => /rtc\.plugin-probe/.test(e.text));
	assert.equal(lines.length, 0);
});

test('WebRtcPeer: __sendPluginProbe DC 未 open 时静默', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_probe_closed'));
	const session = peer.__sessions.get('c_probe_closed');
	session.rpcChannel = makeMockRpcDc({ readyState: 'closed' });

	peer.__sendPluginProbe('c_probe_closed');
	const lines = remoteLogBuffer.filter((e) => /rtc\.plugin-probe/.test(e.text));
	assert.equal(lines.length, 0);

	await peer.closeAll();
});

test('WebRtcPeer: __sendPluginProbe 已有 in-flight 时跳过', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_probe_inflight'));
	const session = peer.__sessions.get('c_probe_inflight');
	const dcSent = [];
	session.rpcChannel = makeMockRpcDc({ send: (d) => dcSent.push(d) });

	peer.__sendPluginProbe('c_probe_inflight');
	peer.__sendPluginProbe('c_probe_inflight'); // 第二次应被跳过

	assert.equal(dcSent.length, 1, 'only first call sends');

	await peer.closeAll();
});

test('WebRtcPeer: __sendPluginProbe dc.send 抛异常时记录 send-failed', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_probe_err'));
	const session = peer.__sessions.get('c_probe_err');
	session.rpcChannel = makeMockRpcDc({ send: () => { throw new Error('dc broken'); } });

	peer.__sendPluginProbe('c_probe_err');

	assert.ok(remoteLogBuffer.some((e) => /rtc\.plugin-probe.*c_probe_err.*send-failed.*dc broken/.test(e.text)));
	assert.equal(session.__pluginProbeInFlight, null, 'in-flight cleared on send failure');

	await peer.closeAll();
});

test('WebRtcPeer: __sendPluginProbe 5s 未 ack → timeout 日志', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_probe_to'));
	const session = peer.__sessions.get('c_probe_to');
	session.rpcChannel = makeMockRpcDc({ send: () => {} });

	peer.__sendPluginProbe('c_probe_to');
	t.mock.timers.tick(5000);

	assert.ok(remoteLogBuffer.some((e) => /rtc\.plugin-probe.*c_probe_to.*timeout/.test(e.text)));
	assert.equal(session.__pluginProbeInFlight, null, 'in-flight cleared on timeout');

	await peer.closeAll();
});

test('WebRtcPeer: __handlePluginProbeAck 匹配 id → 记 rtt + 清 in-flight', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_ack01'));
	const session = peer.__sessions.get('c_ack01');
	session.rpcChannel = makeMockRpcDc({ send: () => {} });

	peer.__sendPluginProbe('c_ack01');
	const id = session.__pluginProbeInFlight.id;
	peer.__handlePluginProbeAck('c_ack01', id);

	const acked = remoteLogBuffer.find((e) => /rtc\.plugin-probe.*c_ack01.*acked.*rtt=/.test(e.text));
	assert.ok(acked, 'should log acked line with rtt');
	assert.equal(session.__pluginProbeInFlight, null);
	assert.equal(session.__pluginProbeTimer, null);

	await peer.closeAll();
});

test('WebRtcPeer: __handlePluginProbeAck 无 session / 无 in-flight / id 不匹配时静默', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	// 无 session
	peer.__handlePluginProbeAck('missing', 1);

	await peer.handleSignaling(makeOffer('c_ack02'));
	// 无 in-flight
	peer.__handlePluginProbeAck('c_ack02', 1);

	const session = peer.__sessions.get('c_ack02');
	session.rpcChannel = makeMockRpcDc({ send: () => {} });
	peer.__sendPluginProbe('c_ack02');
	// id 不匹配
	peer.__handlePluginProbeAck('c_ack02', 9999);

	const acked = remoteLogBuffer.filter((e) => /rtc\.plugin-probe.*acked/.test(e.text));
	assert.equal(acked.length, 0, 'no ack logged for mismatched scenarios');
	// in-flight 仍保留（未被错误清掉）
	assert.ok(session.__pluginProbeInFlight);

	await peer.closeAll();
});

test('WebRtcPeer: reassembler 收到 plugin-probe-ack 路由到 __handlePluginProbeAck', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_ack03'));
	const pc = PC.instances[0];
	const dc = makeMockRpcDc({ send: () => {} });
	pc.ondatachannel({ channel: dc });
	const session = peer.__sessions.get('c_ack03');
	session.rpcChannel = dc;

	// 先发 probe 建立 in-flight
	peer.__sendPluginProbe('c_ack03');
	const id = session.__pluginProbeInFlight.id;

	// 模拟 UI 回 ack 经 DC message 到达。reassembler 对 string 类型直接交付（未分片路径）。
	dc.onmessage({ data: JSON.stringify({ type: 'plugin-probe-ack', id }) });

	assert.ok(remoteLogBuffer.some((e) => /rtc\.plugin-probe.*c_ack03.*acked/.test(e.text)));

	await peer.closeAll();
});

test('WebRtcPeer: closeByConnId 清理 plugin-probe timer 避免 session 关闭后误打 timeout', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_cleanup'));
	const session = peer.__sessions.get('c_cleanup');
	session.rpcChannel = makeMockRpcDc({ send: () => {} });
	peer.__sendPluginProbe('c_cleanup');
	assert.ok(session.__pluginProbeTimer);

	await peer.closeByConnId('c_cleanup');

	// 推进到 timeout 应到期的时刻，应不再触发 timeout 日志
	t.mock.timers.tick(10000);
	const timeouts = remoteLogBuffer.filter((e) => /rtc\.plugin-probe.*c_cleanup.*timeout/.test(e.text));
	assert.equal(timeouts.length, 0, 'cleared timer should not fire timeout after close');
});

test('WebRtcPeer: 500ms plugin-probe 调度窗口内 closeByConnId 取消探针发送', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_sched_cancel'));
	const pc = PC.instances[0];
	const session = peer.__sessions.get('c_sched_cancel');
	const dcSent = [];
	session.rpcChannel = makeMockRpcDc({ send: (d) => dcSent.push(d) });

	// 触发 disconnected → connected 走恢复分支，安排 500ms 探针
	pc.connectionState = 'disconnected';
	pc.onconnectionstatechange();
	pc.connectionState = 'connected';
	pc.onconnectionstatechange();
	assert.ok(session.__pluginProbeSchedTimer, 'schedule timer installed');

	// 500ms 到之前关闭 session
	await peer.closeByConnId('c_sched_cancel');
	t.mock.timers.tick(500);

	// 不应有 plugin-probe 发出
	assert.equal(dcSent.length, 0, 'closed session should not send plugin-probe');
	// 也不应有 sent 日志
	assert.equal(remoteLogBuffer.filter((e) => /rtc\.plugin-probe.*c_sched_cancel.*sent/.test(e.text)).length, 0);
});

test('WebRtcPeer: closeByConnId oniceconnectionstatechange detach（pion PC）', async () => {
	resetRemoteLog();
	function PionPC() {
		const pc = createMockPC();
		pc.iceConnectionState = 'new';
		pc.oniceconnectionstatechange = null;
		return pc;
	}
	const instances = [];
	function Factory() {
		const pc = PionPC();
		instances.push(pc);
		return pc;
	}

	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: Factory,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_det01'));
	const pc = instances[0];
	assert.ok(pc.oniceconnectionstatechange, 'handler installed before close');

	await peer.closeByConnId('c_det01');
	assert.equal(pc.oniceconnectionstatechange, null, 'handler detached after close');
});

test('WebRtcPeer: closeByConnId onicegatheringstatechange detach（pion PC）', async () => {
	const PC = PionMockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_gather_det'));
	const pc = PC.instances[0];
	assert.equal(typeof pc.onicegatheringstatechange, 'function', 'handler installed before close');

	await peer.closeByConnId('c_gather_det');
	assert.equal(pc.onicegatheringstatechange, null, 'handler detached after close');
});

test('WebRtcPeer: pion icegatheringstatechange=complete flushes gather diag (host addrs included)', async () => {
	resetRemoteLog();
	const PC = PionMockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_gather_pion'));
	const pc = PC.instances[0];
	assert.equal(typeof pc.onicegatheringstatechange, 'function', 'handler should be installed');

	pc.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.1 10000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
	pc.onicecandidate({ candidate: { candidate: 'candidate:2 1 udp 2122194687 172.17.0.1 10001 typ host', sdpMid: '0', sdpMLineIndex: 0 } });

	// pion 路径：complete 事件触发 flush
	pc.iceGatheringState = 'complete';
	pc.onicegatheringstatechange();

	const gathered = remoteLogBuffer.find((e) => e.text.includes('rtc.ice-gathered') && e.text.includes('c_gather_pion'));
	assert.ok(gathered, 'should log ice-gathered on complete');
	assert.ok(gathered.text.includes('host=2'));
	assert.ok(gathered.text.includes('hosts=192.168.1.1:10000,172.17.0.1:10001'));

	await peer.closeAll();
});

test('WebRtcPeer: pion icegatheringstatechange idempotent (null candidate + complete fires once)', async () => {
	resetRemoteLog();
	const PC = PionMockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_gather_dup'));
	const pc = PC.instances[0];

	pc.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 2122260223 10.0.0.1 10000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
	// 先走 null candidate flush
	pc.onicecandidate({ candidate: null });
	// 再收到 complete —— 不应重复 flush
	pc.iceGatheringState = 'complete';
	pc.onicegatheringstatechange();

	const gathered = remoteLogBuffer.filter((e) => e.text.includes('rtc.ice-gathered') && e.text.includes('c_gather_dup'));
	assert.equal(gathered.length, 1, 'only one gather log expected');

	await peer.closeAll();
});

test('WebRtcPeer: pion icegatheringstatechange=gathering resets flag for ICE restart', async () => {
	resetRemoteLog();
	const PC = PionMockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_gather_restart'));
	const pc = PC.instances[0];

	// 第一轮 gather：host 候选 → complete
	pc.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.1 10000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
	pc.iceGatheringState = 'complete';
	pc.onicegatheringstatechange();

	// ICE restart: gathering 重置 flag，再收 host + complete 应再次 flush
	pc.iceGatheringState = 'gathering';
	pc.onicegatheringstatechange();
	pc.onicecandidate({ candidate: { candidate: 'candidate:2 1 udp 2122194687 10.0.0.2 20000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
	pc.iceGatheringState = 'complete';
	pc.onicegatheringstatechange();

	const gathered = remoteLogBuffer.filter((e) => e.text.includes('rtc.ice-gathered') && e.text.includes('c_gather_restart'));
	assert.equal(gathered.length, 2, 'should flush once per gather cycle');
	assert.ok(gathered[0].text.includes('hosts=192.168.1.1:10000'));
	assert.ok(gathered[1].text.includes('hosts=10.0.0.2:20000'));

	await peer.closeAll();
});

test('WebRtcPeer: pion icegatheringstatechange=other states are no-op', async () => {
	resetRemoteLog();
	const PC = PionMockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_gather_other'));
	const pc = PC.instances[0];

	// 只进到 'new' 等非 gathering/complete 状态，不应产生日志
	pc.iceGatheringState = 'new';
	pc.onicegatheringstatechange();

	const gathered = remoteLogBuffer.filter((e) => e.text.includes('rtc.ice-gathered') && e.text.includes('c_gather_other'));
	assert.equal(gathered.length, 0);

	await peer.closeAll();
});

test('WebRtcPeer: host candidate with short string does not crash addr extraction', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_short_host'));
	const pc = PC.instances[0];

	// candidate 字符串被截断（少于 6 段），应仅计数不记地址
	pc.onicecandidate({ candidate: { candidate: 'candidate:1 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
	pc.onicecandidate({ candidate: null });

	const gathered = remoteLogBuffer.find((e) => e.text.includes('rtc.ice-gathered') && e.text.includes('c_short_host'));
	assert.ok(gathered);
	assert.ok(gathered.text.includes('host=1'));
	assert.ok(!gathered.text.includes('hosts='), 'short candidate: no addr recorded');

	await peer.closeAll();
});

// --- sctpRtoMax + SCTP stats dump (Phase 3) ---
// 下面的异步用例依赖模块级 flushMicrotasks（2 次 await）排空 __dumpSctpStats 的
// 单次 await 跳。若将来给 __dumpSctpStats 加入额外的 await，需要同步加深排空次数，
// 否则测试会在断言 rtc.sctp 时看到空 buffer 误通过。

test('WebRtcPeer: pion impl passes settings.sctpRtoMax=10000 to PeerConnection', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_sctp_s01'));

	assert.equal(PC.instances.length, 1);
	const args = PC.instances[0].__constructorArgs;
	assert.deepEqual(args.settings, { sctpRtoMax: 10000 });

	await peer.closeAll();
});

test('WebRtcPeer: non-pion impl does NOT pass settings to PeerConnection', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_sctp_s02'));

	const args = PC.instances[0].__constructorArgs;
	assert.equal(args.settings, undefined);

	await peer.closeAll();
});

test('WebRtcPeer: pion dump appends rtc.sctp line with cwnd/srtt/sent/recv/mtu', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_sctp01'));
	const pc = PC.instances[0];
	pc.getSctpStats = async () => ({
		bytesSent: 100,
		bytesReceived: 200,
		srttMs: 23.4,
		congestionWindow: 4380,
		receiverWindow: 65535,
		mtu: 1228,
	});

	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	await flushMicrotasks();

	const dump = remoteLogBuffer.find((e) => /rtc\.dump/.test(e.text) && /c_sctp01/.test(e.text));
	assert.ok(dump, 'rtc.dump should still be emitted');
	const sctp = remoteLogBuffer.find((e) => /rtc\.sctp/.test(e.text) && /c_sctp01/.test(e.text));
	assert.ok(sctp, `expected rtc.sctp log, got: ${JSON.stringify(remoteLogBuffer.map((e) => e.text))}`);
	assert.match(sctp.text, /state=failed/);
	assert.match(sctp.text, /cwnd=4380/);
	assert.match(sctp.text, /srtt=23ms/);
	assert.match(sctp.text, /sent=100/);
	assert.match(sctp.text, /recv=200/);
	assert.match(sctp.text, /mtu=1228/);

	await peer.closeAll();
});

test('WebRtcPeer: pion rtc.sctp emits sctp=none when association not yet up (null stats)', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_sctp02'));
	const pc = PC.instances[0];
	pc.getSctpStats = async () => null;

	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	await flushMicrotasks();

	const sctp = remoteLogBuffer.find((e) => /rtc\.sctp/.test(e.text) && /c_sctp02/.test(e.text));
	assert.ok(sctp);
	assert.match(sctp.text, /sctp=none/);

	await peer.closeAll();
});

test('WebRtcPeer: pion rtc.sctp emits error line when getSctpStats rejects; dump survives', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_sctp03'));
	const pc = PC.instances[0];
	pc.getSctpStats = async () => { throw new Error('boom'); };

	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	await flushMicrotasks();

	const sctp = remoteLogBuffer.find((e) => /rtc\.sctp/.test(e.text) && /c_sctp03/.test(e.text));
	assert.ok(sctp);
	assert.match(sctp.text, /error=boom/);
	// dump 本身不受影响
	const dump = remoteLogBuffer.find((e) => /rtc\.dump/.test(e.text) && /c_sctp03/.test(e.text));
	assert.ok(dump);

	await peer.closeAll();
});

test('WebRtcPeer: non-pion impl does not emit rtc.sctp line on dump', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});

	await peer.handleSignaling(makeOffer('c_sctp04'));
	const pc = PC.instances[0];
	// 即使挂了 getSctpStats，非 pion 路径也不应调用
	let called = false;
	pc.getSctpStats = async () => { called = true; return null; };

	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	await flushMicrotasks();

	assert.equal(called, false, 'non-pion impl must not call getSctpStats');
	const dump = remoteLogBuffer.find((e) => /rtc\.dump/.test(e.text) && /c_sctp04/.test(e.text));
	assert.ok(dump, 'rtc.dump should still be emitted');
	const sctp = remoteLogBuffer.find((e) => /rtc\.sctp/.test(e.text) && /c_sctp04/.test(e.text));
	assert.equal(sctp, undefined, 'non-pion should not emit rtc.sctp');

	await peer.closeAll();
});

test('WebRtcPeer: pion impl without pc.getSctpStats method skips rtc.sctp gracefully', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_sctp05'));
	// 不挂 getSctpStats → typeof !== 'function'
	const pc = PC.instances[0];

	pc.connectionState = 'failed';
	pc.onconnectionstatechange();
	await flushMicrotasks();

	const dump = remoteLogBuffer.find((e) => /rtc\.dump/.test(e.text) && /c_sctp05/.test(e.text));
	assert.ok(dump);
	const sctp = remoteLogBuffer.find((e) => /rtc\.sctp/.test(e.text) && /c_sctp05/.test(e.text));
	assert.equal(sctp, undefined, 'missing getSctpStats method should not emit rtc.sctp');

	await peer.closeAll();
});

// --- 阶段 1 场景补强（review 后由测试钉死实现行为） ---

test('WebRtcPeer: 同 session broadcast + sendTo + sendFn 同 tick 调用 → 三条均到达 dc.sent', async () => {
	const PC = MockPCFactory();
	let capturedSendFn = null;
	const peer = new WebRtcPeer({
		onSend: () => {},
		onFileRpc: (payload, sendFn) => { capturedSendFn = sendFn; },
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_concurrent'));
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	// 通过 file RPC req 触发 onFileRpc 暴露 sendFn 闭包
	dc.onmessage({ data: JSON.stringify({ type: 'req', id: 'r1', method: 'coclaw.files.list', params: {} }) });
	await flushAsync();
	assert.equal(typeof capturedSendFn, 'function');

	// 同 tick 三个 producer 并发入队
	peer.broadcast({ type: 'event', from: 'broadcast' });
	const sendToP = peer.sendTo('c_concurrent', { type: 'event', from: 'sendTo' });
	capturedSendFn({ type: 'res', id: 'r1', from: 'sendFn' });

	const delivered = await sendToP;
	await flushAsync();

	assert.equal(delivered, true);
	const parsed = sent.map((s) => JSON.parse(s));
	const froms = parsed.map((p) => p.from).filter(Boolean);
	assert.equal(froms.length, 3, '三条 producer 消息全部到达 dc');
	assert.ok(froms.includes('broadcast'));
	assert.ok(froms.includes('sendTo'));
	assert.ok(froms.includes('sendFn'));

	await peer.closeAll();
});

test('WebRtcPeer: loop self-exit 后 dc.onclose 才到达 → 幂等清理 rpcChannel', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_self_exit_then_close'));
	// dc 仍 'open' 但 send 抛 → loop SENDER_CLOSED break → finally 清三字段（不动 rpcChannel）
	const dc = makeMockRpcDc({ send: () => { throw new Error('persistent'); } });
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();
	const session = peer.__sessions.get('c_self_exit_then_close');
	peer.broadcast({ type: 'event', x: 1 });
	await flushAsync();

	// loop self-exit 后三字段已 null，rpcChannel 仍指向 dc（finally 不清它）
	assert.equal(session.rpcQueue, null);
	assert.equal(session.rpcDcSender, null);
	assert.equal(session.rpcConsumeLoop, null);
	assert.equal(session.rpcChannel, dc);

	// 现在 dc.onclose 到达：identity guard 通过（rpcChannel===dc），进入清理分支但三字段已 null
	// （幂等无副作用），同时把 rpcChannel 清空
	dc.readyState = 'closed';
	dc.onclose();
	assert.equal(session.rpcQueue, null);
	assert.equal(session.rpcDcSender, null);
	assert.equal(session.rpcConsumeLoop, null);
	assert.equal(session.rpcChannel, null);

	await peer.closeAll();
});

test('WebRtcPeer: closeByConnId 时 sender 阻塞 BAL → balWaiter 全 reject + 三件套全 null', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_close_with_bal'));
	const dc = makeMockRpcDc({ bufferedAmount: DC_HIGH_WATER_MARK + 1 });
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();
	const session = peer.__sessions.get('c_close_with_bal');
	const sender = session.rpcDcSender;

	// 入队后 sender 进入 BAL waiter
	peer.broadcast({ type: 'event', x: 1 });
	await flushAsync();
	assert.equal(sender.balWaiters.length, 1);

	await peer.closeByConnId('c_close_with_bal');

	// sender.close() reject 所有 waiter，waiters 数组清空
	assert.equal(sender.balWaiters.length, 0);
	assert.equal(sender.closed, true);
	// closeByConnId 显式清三件套
	assert.equal(session.rpcQueue, null);
	assert.equal(session.rpcDcSender, null);
	assert.equal(session.rpcConsumeLoop, null);
	assert.equal(session.rpcChannel, null);
	// session 已从 Map 删除
	assert.equal(peer.__sessions.has('c_close_with_bal'), false);
});

test('WebRtcPeer: closeAll 多 session → 每 session 三件套全 null + 6 PC handler 全 detach（pion）', async () => {
	const PC = PionMockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_all_a'));
	await peer.handleSignaling(makeOffer('c_all_b'));
	const sessA = peer.__sessions.get('c_all_a');
	const sessB = peer.__sessions.get('c_all_b');
	const dcA = makeMockRpcDc();
	const dcB = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dcA });
	PC.instances[1].ondatachannel({ channel: dcB });
	await flushAsync();

	const pcA = sessA.pc;
	const pcB = sessB.pc;
	assert.ok(sessA.rpcQueue && sessB.rpcQueue);

	await peer.closeAll();

	// Map 清空
	assert.equal(peer.__sessions.size, 0);
	// 每个 session 三件套 + rpcChannel 全 null
	for (const sess of [sessA, sessB]) {
		assert.equal(sess.rpcQueue, null);
		assert.equal(sess.rpcDcSender, null);
		assert.equal(sess.rpcConsumeLoop, null);
		assert.equal(sess.rpcChannel, null);
	}
	// 每个 PC 6 个 handler 全 detach（含 round 4 + bug 3 补的 onicegatheringstatechange）
	for (const pc of [pcA, pcB]) {
		assert.equal(pc.onconnectionstatechange, null);
		assert.equal(pc.onicecandidate, null);
		assert.equal(pc.ondatachannel, null);
		assert.equal(pc.onselectedcandidatepairchange, null);
		assert.equal(pc.oniceconnectionstatechange ?? null, null);
		assert.equal(pc.onicegatheringstatechange, null);
	}
});

test('WebRtcPeer: broadcast 一路 queue 满 drop 不影响另一路 dc 正常 send', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_full'));
	await peer.handleSignaling(makeOffer('c_ok'));
	const sentFull = [];
	const sentOk = [];
	// session A 高水位：sender 阻塞，queue 会积压
	const dcFull = makeMockRpcDc({
		bufferedAmount: DC_HIGH_WATER_MARK + 1,
		send: (d) => sentFull.push(d),
	});
	const dcOk = makeMockRpcDc({ send: (d) => sentOk.push(d) });
	PC.instances[0].ondatachannel({ channel: dcFull });
	PC.instances[1].ondatachannel({ channel: dcOk });
	await flushAsync();

	const sessFull = peer.__sessions.get('c_full');
	// 直接锁 memBytes 到 memBudget，模拟 sessionA queue 已积压到顶。这种状态在真实运行中
	// 由 sender 阻塞 + 上游持续 enqueue 累积形成；测试里直接锁字段更可控
	sessFull.rpcQueue.memBytes = sessFull.rpcQueue.memBudget;

	// broadcast 一条小消息：sessionA admission 拒（memBytes ≥ memBudget），sessionB 正常 send
	peer.broadcast({ type: 'event', tag: 'small' });
	await flushAsync();

	assert.ok(sessFull.rpcQueue.stats().droppedCount >= 1, 'sessionA queue 应 drop small msg');
	assert.equal(sentOk.length, 1, 'sessionB 不受影响');
	assert.equal(JSON.parse(sentOk[0]).tag, 'small');

	await peer.closeAll();
});

test('WebRtcPeer: sendTo 入队 true 但 sender 后置 BUILD_CHUNKS_FAILED → 本条 warn 丢失，状态保持', async () => {
	const PC = MockPCFactory();
	const warnings = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {}, debug: () => {} },
		PeerConnection: PC,
		impl: 'ndc',
	});
	// SDP 强制 maxMessageSize=3（< HEADER_SIZE 5），任意 payload buildChunks 都抛
	await peer.handleSignaling(makeOffer('c_post_fail', 'v=0\r\na=max-message-size:3\r\n'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	const delivered = await peer.sendTo('c_post_fail', { type: 'event', x: 'y' });
	assert.equal(delivered, true, 'sendTo 仅承诺入队成功');
	await flushAsync();

	// loop catch BUILD_CHUNKS_FAILED → warn，本条不发；session 三件套保持
	assert.ok(warnings.some((m) => m.includes('rpc-dc.send-failed code=BUILD_CHUNKS_FAILED')));
	const session = peer.__sessions.get('c_post_fail');
	assert.ok(session.rpcQueue);
	assert.ok(session.rpcDcSender);
	assert.ok(session.rpcConsumeLoop);

	await peer.closeAll();
});

// --- B 阶段补强 ---

test('WebRtcPeer: connId 复用后旧 PC 的 onselectedcandidatepairchange 微任务迟到 → pc identity guard 防止用旧 pair 数据打过时日志/转发过时 transport', async () => {
	resetRemoteLog();
	const PC = PionMockPCFactory();
	const sent = [];
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_pair_reuse'));
	const oldPc = PC.instances[0];
	const stalePairChange = oldPc.onselectedcandidatepairchange;
	assert.equal(typeof stalePairChange, 'function');

	// 给旧 PC 留下一份特征 pair（用于识别"旧 pc 数据 + 新 connId 上下文"的混合输出）
	oldPc.selectedCandidatePair = {
		local: { type: 'srflx', address: 'OLD-LOCAL', port: 11111, protocol: 'udp' },
		remote: { type: 'host', address: 'OLD-REMOTE', port: 22222, protocol: 'udp' },
	};

	await peer.closeByConnId('c_pair_reuse');

	// 同 connId 复用，建立新 session
	await peer.handleSignaling(makeOffer('c_pair_reuse'));
	const newPc = PC.instances[1];
	assert.notEqual(newPc, oldPc);

	// 模拟旧 PC 的 onselectedcandidatepairchange 微任务迟到投递（detach 不阻止已 dispatch 的 callback）
	stalePairChange();
	await flushAsync();

	// 不应输出含 OLD-LOCAL 的 rtc.ice-nominated（pc identity guard 应直接拒掉）
	const staleNominated = remoteLogBuffer.find((e) =>
		e.text.includes('rtc.ice-nominated') && e.text.includes('OLD-LOCAL')
	);
	assert.equal(staleNominated, undefined, '旧 pc 的 pair 数据不应被打入新 connId 上下文的日志');

	// 旧 pair 的 transport 也不应被转发给 UI（peer.peerTransport sentTo 走真实路径，但 pair 数据来自旧 pc）
	const stalePeerTransport = sent.find((m) =>
		m?.payload?.event === 'coclaw.rtc.peerTransport' && m?.toConnId === 'c_pair_reuse'
	);
	assert.equal(stalePeerTransport, undefined, '旧 pc 的 transport 不应被转发');

	await peer.closeAll();
});

// --- Phase A1：__setupDataChannel async + identity guard ---

function withQueueLifecycleMock({ blockInit = false, blockDestroy = false } = {}) {
	const origInit = MemoryQueue.prototype.init;
	const origDestroy = MemoryQueue.prototype.destroy;
	const initCalls = [];
	const destroyCalls = [];

	if (blockInit) {
		MemoryQueue.prototype.init = async function () {
			let resolve;
			const p = new Promise((r) => { resolve = r; });
			initCalls.push({ queue: this, resolve, p });
			await p;
		};
	}
	if (blockDestroy) {
		MemoryQueue.prototype.destroy = async function () {
			// 已 destroyed 的 queue 走 fast path，避免重入（如 loop.finally 又 destroy 一次）
			// 死锁——只首次销毁需要测试控制
			if (this.destroyed) return await origDestroy.call(this);
			let resolve;
			const p = new Promise((r) => { resolve = r; });
			destroyCalls.push({ queue: this, resolve, p });
			await p;
			return await origDestroy.call(this);
		};
	}
	return {
		initCalls,
		destroyCalls,
		releaseInitAt(idx) { initCalls[idx].resolve(); },
		releaseDestroyAt(idx) { destroyCalls[idx].resolve(); },
		restore() {
			MemoryQueue.prototype.init = origInit;
			MemoryQueue.prototype.destroy = origDestroy;
		},
	};
}

test('WebRtcPeer: __setupDataChannel 在 q.init() 期间不挂 session 三件套（async + 身份守卫前置）', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_init_block_a'));

	const m = withQueueLifecycleMock({ blockInit: true });
	try {
		const dc = makeMockRpcDc();
		PC.instances[0].ondatachannel({ channel: dc });
		await flushAsync();

		const session = peer.__sessions.get('c_init_block_a');
		// ondatachannel sync 路径仍把 dc 赋给 rpcChannel（身份守卫的依据）
		assert.equal(session.rpcChannel, dc);
		// q.init() 完成前三件套必须保持 null（旧 sync 实现已赋字段，会在此失败）
		assert.equal(session.rpcQueue, null, 'rpcQueue 不应在 init 完成前赋值');
		assert.equal(session.rpcDcSender, null, 'rpcDcSender 不应在 init 完成前赋值');
		assert.equal(session.rpcConsumeLoop, null, 'rpcConsumeLoop 不应在 init 完成前赋值');
		assert.equal(m.initCalls.length, 1, 'queue.init 必须被调用且尚未完成');

		// 释放 init → setup 走身份重核（通过）→ 赋字段
		m.releaseInitAt(0);
		await flushAsync();
		assert.ok(session.rpcQueue);
		assert.ok(session.rpcDcSender);
		assert.ok(session.rpcConsumeLoop);
	} finally {
		m.restore();
	}

	await peer.closeAll();
});

test('WebRtcPeer: q.init() 期间 closeByConnId → setup 走 stale 路径 destroy queue 不挂字段', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_init_close'));

	const m = withQueueLifecycleMock({ blockInit: true });
	try {
		const dc = makeMockRpcDc();
		PC.instances[0].ondatachannel({ channel: dc });
		await flushAsync();
		const session = peer.__sessions.get('c_init_close');
		const queueInstance = m.initCalls[0].queue;
		assert.equal(session.rpcQueue, null);

		// 在 init blocked 期间发起 closeByConnId
		const closeP = peer.closeByConnId('c_init_close');
		await flushAsync();
		assert.equal(peer.__sessions.has('c_init_close'), false, 'session 已从 Map 删除');

		// 释放 init → setup 重核身份失败（__sessions.get(connId) === undefined）→ destroy queue → return
		m.releaseInitAt(0);
		await closeP;
		await flushAsync();

		// stale 路径必须 destroy 该 queue 释放资源
		assert.equal(queueInstance.destroyed, true, 'stale 路径必须 destroy queue');
		// session 三件套从未被 setup 赋值
		assert.equal(session.rpcQueue, null);
		assert.equal(session.rpcDcSender, null);
		assert.equal(session.rpcConsumeLoop, null);
	} finally {
		m.restore();
	}
});

test('WebRtcPeer: q.init() 期间 broadcast → q===null 安全跳过 dc.send', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_init_broadcast'));

	const m = withQueueLifecycleMock({ blockInit: true });
	const sent = [];
	try {
		const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
		PC.instances[0].ondatachannel({ channel: dc });
		await flushAsync();

		// setup 卡在 init；session.rpcQueue 仍是 null
		peer.broadcast({ type: 'event', tag: 'in-init-window' });
		await flushAsync();
		// 旧 sync 实现已赋 q，broadcast → enqueue → sender → dc.send 会送达；
		// 新实现 q===null，broadcast 跳过
		assert.equal(sent.length, 0, 'init 期 broadcast 不应送达 dc');

		// 释放 init → 三件套就位
		m.releaseInitAt(0);
		await flushAsync();

		// 第二次 broadcast：现在 q 已就位，正常送达
		peer.broadcast({ type: 'event', tag: 'after-init' });
		await flushAsync();
		assert.equal(sent.length, 1);
		assert.equal(JSON.parse(sent[0]).tag, 'after-init');
	} finally {
		m.restore();
	}

	await peer.closeAll();
});

test('WebRtcPeer: q.init() 期间同 connId 二次 ondatachannel → 旧 setup stale 不覆盖新三件套', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_init_rebuild'));

	const m = withQueueLifecycleMock({ blockInit: true });
	try {
		const dc1 = makeMockRpcDc();
		PC.instances[0].ondatachannel({ channel: dc1 });
		await flushAsync();
		const session = peer.__sessions.get('c_init_rebuild');
		const queue1 = m.initCalls[0].queue;
		assert.equal(session.rpcQueue, null, 'setup1 卡在 init1');

		// 第二条 dc 进来（同 session，rpcChannel 被覆盖）
		const dc2 = makeMockRpcDc();
		PC.instances[0].ondatachannel({ channel: dc2 });
		await flushAsync();
		assert.equal(session.rpcChannel, dc2, 'rpcChannel 被新 dc 覆盖');
		assert.equal(m.initCalls.length, 2, 'setup2 已构造 queue 并 await init');
		const queue2 = m.initCalls[1].queue;

		// 先释放 init2 → setup2 完成赋字段
		m.releaseInitAt(1);
		await flushAsync();
		assert.equal(session.rpcQueue, queue2, 'setup2 完成后 rpcQueue 是 queue2');

		// 再释放 init1 → setup1 重核失败 → destroy queue1 → return（不覆盖新字段）
		m.releaseInitAt(0);
		await flushAsync();

		// 旧 setup1 不应覆盖 session.rpcQueue
		assert.equal(session.rpcQueue, queue2, 'setup1 stale 必须不覆盖 queue2');
		assert.equal(queue1.destroyed, true, 'stale queue1 必须 destroy');
		assert.equal(queue2.destroyed, false, 'queue2 仍活着');
	} finally {
		m.restore();
	}

	await peer.closeAll();
});

test('WebRtcPeer: 同 connId 重建走 await session.rpcQueue.destroy() → 旧 destroy 完成前不构造新 queue', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_rebuild_seq'));

	const m = withQueueLifecycleMock({ blockDestroy: true });
	try {
		const dc1 = makeMockRpcDc();
		PC.instances[0].ondatachannel({ channel: dc1 });
		await flushAsync();
		const session = peer.__sessions.get('c_rebuild_seq');
		const queue1 = session.rpcQueue;
		assert.ok(queue1, 'baseline: queue1 已就位');

		// 第二条 dc 触发"清理旧三件套"分支：sender1.close(sync) + await queue1.destroy()
		const dc2 = makeMockRpcDc();
		PC.instances[0].ondatachannel({ channel: dc2 });
		await flushAsync();

		// await destroy → setup2 卡住 → queue2 尚未构造 → session.rpcQueue 仍是 queue1
		// 旧 fire-and-forget 实现下 setup2 已同步替换 session.rpcQueue 为 queue2，断言会失败
		assert.equal(m.destroyCalls.length, 1, 'destroy mock 必须被调用一次');
		assert.equal(session.rpcQueue, queue1, 'queue2 不应在旧 destroy 完成前构造');

		// 释放 destroy → setup2 继续，构造 queue2 并赋字段
		m.releaseDestroyAt(0);
		await flushAsync();
		assert.notEqual(session.rpcQueue, queue1, 'queue2 已替换 queue1');
		assert.ok(session.rpcQueue, 'queue2 已就位');
	} finally {
		m.restore();
	}

	await peer.closeAll();
});
