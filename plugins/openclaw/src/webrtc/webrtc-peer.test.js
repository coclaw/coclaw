import assert from 'node:assert/strict';
import test from 'node:test';
import nodePath from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { WebRtcPeer, FAILED_SESSION_TTL_MS, MAX_SESSIONS } from './webrtc-peer.js';
import { DC_HIGH_WATER_MARK, DC_LOW_WATER_MARK } from './rpc-dc-sender.js';
import { __reset as resetRemoteLog, __buffer as remoteLogBuffer } from '../remote-log.js';
import { MemoryQueue } from '../utils/memory-queue.js';
import { FileBackedQueue } from '../utils/file-backed-queue.js';
import { isAgentRunResponse } from './agent-run-response.js';
import { createMutex } from '../utils/mutex.js';

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

test('WebRtcPeer: constructor stores getDiskCap deps for B-stage2 FBQ swap', () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		PeerConnection: PC,
		getDiskCap: () => 1024 * 1024,
	});
	assert.equal(typeof peer.__getDiskCap, 'function');
	assert.equal(peer.__getDiskCap(), 1024 * 1024);
});

test('WebRtcPeer: constructor accepts no getDiskCap and stores null (backward compat)', () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, PeerConnection: PC });
	assert.equal(peer.__getDiskCap, null);
	// 非函数（如字符串）也应 coerce 到 null
	const peer2 = new WebRtcPeer({ onSend: () => {}, PeerConnection: PC, getDiskCap: 'not-a-fn' });
	assert.equal(peer2.__getDiskCap, null);
});

test('WebRtcPeer: constructor stores queueDir; non-string / empty coerced to null', () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, PeerConnection: PC, queueDir: '/tmp/x' });
	assert.equal(peer.__queueDir, '/tmp/x');
	const peer2 = new WebRtcPeer({ onSend: () => {}, PeerConnection: PC, queueDir: '' });
	assert.equal(peer2.__queueDir, null);
	const peer3 = new WebRtcPeer({ onSend: () => {}, PeerConnection: PC, queueDir: 123 });
	assert.equal(peer3.__queueDir, null);
});

// --- B9b: rpc DC queue impl swap (生产当前默认 FileBackedQueue；测试通过 rpcQueueImpl='mem' / 不传 queueDir 显式覆盖 mem / fallback 路径) ---

async function setupRpcDcSession({ peer, connId, dc }) {
	await peer.handleSignaling(makeOffer(connId));
	const pc = peer.__sessions.get(connId).pc;
	pc.ondatachannel({ channel: dc });
	dc.onopen?.();
	// __setupDataChannel 是 async fire-and-forget；轮询直到 rpc 三件套就绪（FBQ.init 涉及 fs IO 时序不稳）
	const start = Date.now();
	while (Date.now() - start < 1000) {
		const sess = peer.__sessions.get(connId);
		if (sess?.rpcQueue && sess?.rpcDcSender) return;
		await new Promise((r) => setImmediate(r));
	}
	throw new Error(`setupRpcDcSession timed out waiting for rpc queue (connId=${connId})`);
}

test('WebRtcPeer: rpc DC 装配走 FBQ 路径（带 queueDir + rpcQueueImpl=fbq）；id 含唯一后缀', async () => {
	// FBQ 已是生产默认；本测试同时显式传 rpcQueueImpl='fbq'，让覆盖 FBQ 装配路径不依赖默认值变化
	resetRemoteLog();
	const tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'wp-fbq-'));
	const logs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: () => {}, debug: () => {} },
		PeerConnection: MockPCFactory(),
		impl: 'ndc',
		getDiskCap: () => 100 * 1024 * 1024,
		queueDir: tmpDir,
		rpcQueueImpl: 'fbq',
	});
	await setupRpcDcSession({ peer, connId: 'c_fbq', dc: makeMockRpcDc() });
	const session = peer.__sessions.get('c_fbq');
	assert.ok(session.rpcQueue instanceof FileBackedQueue, 'queue should be FileBackedQueue');
	assert.match(session.rpcQueue.id, /^c_fbq-\d+-[a-f0-9]{8}$/, 'id should have unique suffix');
	// 容量参数：装配点把 getDiskCap() 结果与 RPC_QUEUE_MEM_BUDGET / MAX_SINGLE_MSG_BYTES 显式喂给 FBQ
	assert.equal(session.rpcQueue.diskCap, 100 * 1024 * 1024, 'diskCap should come from getDiskCap()');
	assert.equal(session.rpcQueue.memBudget, 10 * 1024 * 1024, 'memBudget should be RPC_QUEUE_MEM_BUDGET (10MB)');
	assert.equal(session.rpcQueue.maxMessageBytes, 50 * 1024 * 1024, 'maxMessageBytes should be MAX_SINGLE_MSG_BYTES (50MB)');
	assert.ok(logs.some((l) => l.includes('rpc queue impl=fbq')), 'local info log should mention impl=fbq');
	assert.ok(remoteLogBuffer.some((e) => e.text.includes('rtc.queue-impl conn=c_fbq impl=fbq')), 'remoteLog should record impl=fbq');
	await peer.closeAll();
});

test('WebRtcPeer: 同 connId 重建 → 两个 FBQ 实例 id/filePath 不同（race 隔离；rpcQueueImpl=fbq）', async () => {
	const tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'wp-race-'));
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: MockPCFactory(),
		impl: 'ndc',
		queueDir: tmpDir,
		rpcQueueImpl: 'fbq',
	});
	await setupRpcDcSession({ peer, connId: 'c_dup', dc: makeMockRpcDc() });
	const id1 = peer.__sessions.get('c_dup').rpcQueue.id;
	const fp1 = peer.__sessions.get('c_dup').rpcQueue.filePath;
	// 关连接、再开一次同 connId（模拟 UI 重发 offer）
	await peer.closeByConnId('c_dup', peer.__sessions.get('c_dup'));
	await setupRpcDcSession({ peer, connId: 'c_dup', dc: makeMockRpcDc() });
	const id2 = peer.__sessions.get('c_dup').rpcQueue.id;
	const fp2 = peer.__sessions.get('c_dup').rpcQueue.filePath;
	assert.notEqual(id1, id2, 'second FBQ instance should have a different id');
	assert.notEqual(fp1, fp2, 'second FBQ instance should target a different file path');
	await peer.closeAll();
});

test('WebRtcPeer: rpcQueueImpl=fbq + queueDir 为 null → 降级到 MemoryQueue；log 含 fallback 标记', async () => {
	// fbq 模式 + 无 queueDir → 装配点降级。FBQ 已是生产默认，测试同时显式传 'fbq'
	// 让该降级路径覆盖不依赖默认值变化。
	resetRemoteLog();
	const logs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: () => {}, debug: () => {} },
		PeerConnection: MockPCFactory(),
		impl: 'ndc',
		rpcQueueImpl: 'fbq',
		// 不传 queueDir → 装配点强制降级
	});
	await setupRpcDcSession({ peer, connId: 'c_mem', dc: makeMockRpcDc() });
	const session = peer.__sessions.get('c_mem');
	assert.ok(session.rpcQueue instanceof MemoryQueue, 'queue should fallback to MemoryQueue');
	assert.equal(session.rpcQueue.id, 'c_mem', 'mem mode keeps connId as id (no unique suffix)');
	assert.equal(session.rpcQueue.maxMessageBytes, 50 * 1024 * 1024, 'mem fallback also enforces MAX_SINGLE_MSG_BYTES');
	assert.ok(logs.some((l) => l.includes('impl=mem') && l.includes('fallback')), 'local log should mention fallback');
	assert.ok(remoteLogBuffer.some((e) => e.text.includes('impl=mem fallback=queue-dir-null')), 'remoteLog should record fallback');
	await peer.closeAll();
});

test('WebRtcPeer: 生产默认（不传 rpcQueueImpl）+ queueDir → FileBackedQueue', async () => {
	// FBQ 切回生产默认后的关键 invariant：默认装配走 FileBackedQueue（带 queueDir 时）；
	// log 不含 fallback 标记（FBQ 真正激活，不是降级）。
	resetRemoteLog();
	const tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'wp-prod-fbq-'));
	const logs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: () => {}, debug: () => {} },
		PeerConnection: MockPCFactory(),
		impl: 'ndc',
		queueDir: tmpDir,
		getDiskCap: () => 100 * 1024 * 1024,
		// 不传 rpcQueueImpl → 取模块默认（生产 'fbq'）
	});
	await setupRpcDcSession({ peer, connId: 'c_prod', dc: makeMockRpcDc() });
	const session = peer.__sessions.get('c_prod');
	assert.ok(session.rpcQueue instanceof FileBackedQueue, 'production default should be FileBackedQueue');
	assert.ok(!(session.rpcQueue instanceof MemoryQueue), 'production default should NOT be MemoryQueue');
	assert.match(session.rpcQueue.id, /^c_prod-\d+-[a-f0-9]{8}$/, 'fbq id should have unique suffix');
	assert.equal(session.rpcQueue.maxMessageBytes, 50 * 1024 * 1024, 'maxMessageBytes wired through');
	assert.ok(logs.some((l) => l.includes('rpc queue impl=fbq')), 'log should mention impl=fbq');
	assert.ok(!logs.some((l) => l.includes('fallback')), 'log should NOT contain fallback marker (fbq is configured, not degraded)');
	assert.ok(
		remoteLogBuffer.some((e) => e.text.includes('rtc.queue-impl conn=c_prod impl=fbq') && !e.text.includes('fallback')),
		'remoteLog should record impl=fbq without fallback suffix',
	);
	await peer.closeAll();
});

test('WebRtcPeer: 装配点把 bypassAdmission 接到 isAgentRunResponse（mem 路径，explicit override）', async () => {
	// 红线 3 装配点连接 pin：若装配代码漏传 bypassAdmission，agent 响应会被 capacity 层 drop。
	// 引用相等而非行为测：直接确认装配点把模块导出的 isAgentRunResponse 喂给了 queue.bypassAdmission。
	// 显式传 rpcQueueImpl='mem' 走 mem 装配分支，与下面 fbq explicit 测形成两路对照。
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: MockPCFactory(),
		impl: 'ndc',
		rpcQueueImpl: 'mem',
	});
	await setupRpcDcSession({ peer, connId: 'c_bypass_pin_mem', dc: makeMockRpcDc() });
	const session = peer.__sessions.get('c_bypass_pin_mem');
	assert.equal(session.rpcQueue.bypassAdmission, isAgentRunResponse, '装配点必须把 isAgentRunResponse 接到 bypassAdmission');
	await peer.closeAll();
});

test('WebRtcPeer: bypassAdmission 行为正确——agent run res 命中、非 agent 响应不命中（mem 路径，explicit override）', async () => {
	// 引用相等 pin 的互补测：直接调装配后的谓词，验证装配产物语义正确。
	// 即便将来有人把 bypassAdmission: isAgentRunResponse 改成等价 lambda 包装让上面引用相等测红，
	// 本测试仍能从语义上确保 agent 响应被识别、非 agent 响应不被识别。
	// 用谓词直调而非端到端 admission：避免 consumeLoop 边消费边入队让 mem 永不达 budget 的 race。
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: MockPCFactory(),
		impl: 'ndc',
		rpcQueueImpl: 'mem',
	});
	await setupRpcDcSession({ peer, connId: 'c_bypass_behave_mem', dc: makeMockRpcDc() });
	const queue = peer.__sessions.get('c_bypass_behave_mem').rpcQueue;
	const agentRes = JSON.stringify({ type: 'res', payload: { runId: 'r-xyz' } });
	const nonAgentRes = JSON.stringify({ type: 'res', payload: { ok: true } });
	assert.equal(queue.bypassAdmission(agentRes), true, 'agent run res 应被识别为白名单');
	assert.equal(queue.bypassAdmission(nonAgentRes), false, '无 runId 的 res 不应被识别');
	assert.equal(queue.bypassAdmission('not-a-json'), false, '非 JSON 输入应保守 false');
	// 边界：JSON 解析得到数组而非对象（顶层 type 字段访问 undefined 应保守 false，不抛错）
	assert.equal(queue.bypassAdmission(JSON.stringify(['res', { runId: 'r' }])), false, '解析为数组应保守 false');
	// 边界：有 runId 但 type 不是 'res'（lifecycle event 等带 runId 的帧不应被识别为响应）
	const eventWithRunId = JSON.stringify({ type: 'event', payload: { runId: 'r-xyz' } });
	assert.equal(queue.bypassAdmission(eventWithRunId), false, 'type 非 res 不应命中（红线 4：谓词只识 res 帧）');
	// 边界：null 输入（JSON.parse(null) 实际把 null 强转字符串 "null" 解析为 JS null → null?.type 为 undefined → false）
	assert.equal(queue.bypassAdmission(null), false, 'null 输入应保守 false');
	await peer.closeAll();
});

test('WebRtcPeer: 装配点把 bypassAdmission 接到 isAgentRunResponse（fbq 路径）', async () => {
	// 同上，但显式覆盖 FBQ 装配分支——保留与 mem 默认路径并行的 explicit pin，让两条路径独立
	const tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'wp-bypass-pin-fbq-'));
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: MockPCFactory(),
		impl: 'ndc',
		queueDir: tmpDir,
		rpcQueueImpl: 'fbq',
		getDiskCap: () => 100 * 1024 * 1024,
	});
	await setupRpcDcSession({ peer, connId: 'c_bypass_pin_fbq', dc: makeMockRpcDc() });
	const session = peer.__sessions.get('c_bypass_pin_fbq');
	assert.ok(session.rpcQueue instanceof FileBackedQueue);
	assert.equal(session.rpcQueue.bypassAdmission, isAgentRunResponse, 'FBQ 路径也必须把 isAgentRunResponse 接到 bypassAdmission');
	await peer.closeAll();
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
	// Phase A2：6 字段 stats（memCount/memBytes/diskBytes/writtenBytes/spilled/fsBroken）+ droppedCount/droppedBytes
	assert.match(dump.text, /queueLen=\d+ queueBytes=\d+ diskBytes=\d+ writtenBytes=\d+ spilled=(?:true|false) fsBroken=(?:true|false) dropped=\d+ droppedBytes=\d+/);
	// MemoryQueue 阶段 4 个磁盘字段恒为 0/false（给 Phase B 留形状）
	assert.match(dump.text, /diskBytes=0 writtenBytes=0 spilled=false fsBroken=false/);

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

	await peer.closeByConnId('c_070', peer.__sessions.get('c_070'));
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
	await peer.closeByConnId('c_nonexistent', peer.__sessions.get('c_nonexistent')); // 不应抛异常
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

// --- broadcast / sendTo rawStr 旁路（跳过 stringify）---

test('WebRtcPeer: broadcast(payload, rawStr) 用 rawStr 直通，跳过 stringify', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_raw_b1'));
	await peer.handleSignaling(makeOffer('c_raw_b2'));

	const sent = { c_raw_b1: [], c_raw_b2: [] };
	const dc1 = makeMockRpcDc({ send: (d) => sent.c_raw_b1.push(d) });
	const dc2 = makeMockRpcDc({ send: (d) => sent.c_raw_b2.push(d) });
	PC.instances[0].ondatachannel({ channel: dc1 });
	PC.instances[1].ondatachannel({ channel: dc2 });
	await flushAsync();

	// 关键证据：rawStr 与 payload 故意构造成 stringify(payload) 不等的形式（多空白）。
	// 实际转发到 dc 的必须是 rawStr 原值，证明没有走 JSON.stringify(payload) 这条路。
	const payload = { type: 'event', event: 'agent', payload: { runId: 'r1' } };
	const rawStr = '{"type":"event","event":"agent","payload":{"runId":"r1","extra":"only-in-raw"}}';
	peer.broadcast(payload, rawStr);
	await flushAsync();

	assert.equal(sent.c_raw_b1.length, 1);
	assert.equal(sent.c_raw_b1[0], rawStr, 'dc 必须收到 rawStr 而非 stringify(payload)');
	assert.equal(sent.c_raw_b2.length, 1);
	assert.equal(sent.c_raw_b2[0], rawStr);

	await peer.closeAll();
});

test('WebRtcPeer: broadcast(payload) 不传 rawStr 时仍走 stringify（兼容旧调用）', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_raw_b3'));
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	const payload = { type: 'event', event: 'agent', payload: { runId: 'r2' } };
	peer.broadcast(payload);
	await flushAsync();

	assert.equal(sent.length, 1);
	assert.equal(sent[0], JSON.stringify(payload), '未传 rawStr 时回退到 stringify');
	await peer.closeAll();
});

test('WebRtcPeer: broadcast rawStr 非字符串或空串 → 回退 stringify(payload)', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_raw_b4'));
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	const payload = { type: 'event', event: 'agent' };
	peer.broadcast(payload, undefined);
	peer.broadcast(payload, '');
	peer.broadcast(payload, null);
	peer.broadcast(payload, 42);
	await flushAsync();

	const expected = JSON.stringify(payload);
	assert.equal(sent.length, 4, '四次调用都应回退到 stringify 路径');
	for (const s of sent) assert.equal(s, expected);
	await peer.closeAll();
});

test('WebRtcPeer: sendTo(connId, payload, rawStr) 用 rawStr 直通，跳过 stringify', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_raw_s1'));
	await peer.handleSignaling(makeOffer('c_raw_s2'));

	const sent = { c_raw_s1: [], c_raw_s2: [] };
	const dc1 = makeMockRpcDc({ send: (d) => sent.c_raw_s1.push(d) });
	const dc2 = makeMockRpcDc({ send: (d) => sent.c_raw_s2.push(d) });
	PC.instances[0].ondatachannel({ channel: dc1 });
	PC.instances[1].ondatachannel({ channel: dc2 });
	await flushAsync();

	const payload = { type: 'res', id: 'r-abc', payload: { runId: 'run-xyz', status: 'ok' } };
	const rawStr = '{"type":"res","id":"r-abc","payload":{"runId":"run-xyz","status":"ok","extra":"only-in-raw"}}';
	const ok = await peer.sendTo('c_raw_s1', payload, rawStr);
	assert.equal(ok, true);
	await flushAsync();
	assert.equal(sent.c_raw_s1.length, 1);
	assert.equal(sent.c_raw_s1[0], rawStr, 'dc 必须收到 rawStr 而非 stringify(payload)');
	assert.equal(sent.c_raw_s2.length, 0, '不发给其他 session');

	await peer.closeAll();
});

test('WebRtcPeer: sendTo rawStr 直通时仍遵循 session/DC 未就绪 → false', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	assert.equal(await peer.sendTo('nonexistent', { type: 'event' }, '{"x":1}'), false);

	await peer.handleSignaling(makeOffer('c_raw_s3'));
	assert.equal(await peer.sendTo('c_raw_s3', { type: 'event' }, '{"x":1}'), false);

	const dc = makeMockRpcDc({ readyState: 'connecting' });
	PC.instances[0].ondatachannel({ channel: dc });
	assert.equal(await peer.sendTo('c_raw_s3', { type: 'event' }, '{"x":1}'), false);

	await peer.closeAll();
});

test('WebRtcPeer: sendTo rawStr 非字符串或空串 → 回退 stringify(payload)', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_raw_s4'));
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	const payload = { type: 'res', id: 'r-1' };
	const expected = JSON.stringify(payload);
	assert.equal(await peer.sendTo('c_raw_s4', payload, undefined), true);
	assert.equal(await peer.sendTo('c_raw_s4', payload, ''), true);
	assert.equal(await peer.sendTo('c_raw_s4', payload, null), true);
	assert.equal(await peer.sendTo('c_raw_s4', payload, 42), true);
	await flushAsync();
	assert.equal(sent.length, 4);
	for (const s of sent) assert.equal(s, expected);
	await peer.closeAll();
});

test('WebRtcPeer: broadcast rawStr 直通时即便 payload 含循环引用也不抛（不调 stringify）', async () => {
	const PC = MockPCFactory();
	const debugMsgs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: (m) => debugMsgs.push(m) },
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_raw_b5'));
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	// 关键：payload 自引用环，stringify 会抛。rawStr 直通必须完全绕开它。
	const payload = { type: 'event' };
	payload.self = payload;
	const rawStr = '{"type":"event","event":"agent","payload":{"runId":"r-circ"}}';
	assert.doesNotThrow(() => peer.broadcast(payload, rawStr));
	await flushAsync();
	assert.equal(sent.length, 1);
	assert.equal(sent[0], rawStr);
	assert.equal(debugMsgs.filter((m) => m.includes('stringify failed')).length, 0,
		'rawStr 直通路径不应触发 stringify failed 日志');
	await peer.closeAll();
});

test('WebRtcPeer: sendTo rawStr 直通时即便 payload 含循环引用也不抛（不调 stringify）', async () => {
	const PC = MockPCFactory();
	const debugMsgs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: (m) => debugMsgs.push(m) },
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_raw_s_circ'));
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	const payload = { type: 'res' };
	payload.self = payload;
	const rawStr = '{"type":"res","id":"r-1","payload":{"runId":"run-circ"}}';
	let ok;
	await assert.doesNotReject(async () => { ok = await peer.sendTo('c_raw_s_circ', payload, rawStr); });
	assert.equal(ok, true);
	await flushAsync();
	assert.equal(sent.length, 1);
	assert.equal(sent[0], rawStr);
	assert.equal(debugMsgs.filter((m) => m.includes('stringify failed')).length, 0,
		'rawStr 直通路径不应触发 stringify failed 日志');
	await peer.closeAll();
});

test('WebRtcPeer: broadcast rawStr 含字面 \\n 时回退 stringify(payload)（保 FBQ JSONL 行约束）', async () => {
	const PC = MockPCFactory();
	const debugMsgs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: (m) => debugMsgs.push(m) },
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_raw_nl_b'));
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	// rawStr 含字面 \n（合法 JSON 也允许 string value 之间的 whitespace）。
	// FBQ 默认实现把记录用 \n 拼成 JSONL，含字面换行会切坏 spill 文件——
	// 必须回退到 stringify(payload) 走归一化。
	const payload = { type: 'event', event: 'agent', payload: { runId: 'r-nl' } };
	const rawWithLF = '{\n  "type": "event",\n  "event": "agent"\n}';
	peer.broadcast(payload, rawWithLF);
	await flushAsync();
	assert.equal(sent.length, 1);
	assert.equal(sent[0], JSON.stringify(payload), '应回退到 stringify(payload)，不直传含换行的 rawStr');
	assert.ok(debugMsgs.some((m) => m.includes('rawStr fallback: contains newline')),
		'回退应有 debug 日志');

	// CR 单独也应触发回退
	debugMsgs.length = 0;
	sent.length = 0;
	const rawWithCR = '{"type":"event"\r,"event":"agent"}';
	peer.broadcast(payload, rawWithCR);
	await flushAsync();
	assert.equal(sent.length, 1);
	assert.equal(sent[0], JSON.stringify(payload));
	assert.ok(debugMsgs.some((m) => m.includes('rawStr fallback: contains newline')));
	await peer.closeAll();
});

test('WebRtcPeer: sendTo rawStr 含字面 \\n 时回退 stringify(payload)', async () => {
	const PC = MockPCFactory();
	const debugMsgs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: (m) => debugMsgs.push(m) },
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_raw_nl_s'));
	const sent = [];
	const dc = makeMockRpcDc({ send: (d) => sent.push(d) });
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	const payload = { type: 'res', id: 'r-nl' };
	const rawWithLF = '{"type":"res",\n"id":"r-nl"}';
	const ok = await peer.sendTo('c_raw_nl_s', payload, rawWithLF);
	assert.equal(ok, true);
	await flushAsync();
	assert.equal(sent.length, 1);
	assert.equal(sent[0], JSON.stringify(payload));
	assert.ok(debugMsgs.some((m) => m.includes('rawStr fallback: contains newline')));
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
	await peer.closeByConnId('c_pt07', peer.__sessions.get('c_pt07'));
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
	peer.__sessions.set('c_race03', { pc: fakePc, connId: 'c_race03', offerMutex: createMutex(), rpcChannel: null });

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
	assert.ok(session.rpcDropMonitor, 'rpcDropMonitor should be created');
	assert.ok(session.rpcConsumeLoop instanceof Promise, 'rpcConsumeLoop should be a Promise');
	assert.equal(dc.bufferedAmountLowThreshold, DC_LOW_WATER_MARK, 'LOW_WATER_MARK should be set on DC');
	assert.equal(typeof dc.onbufferedamountlow, 'function', 'onbufferedamountlow should be wired');
	// monitor 4 个方法都到位
	assert.equal(typeof session.rpcDropMonitor.onDrop, 'function');
	assert.equal(typeof session.rpcDropMonitor.maybeEmitOverflowEnd, 'function');
	assert.equal(typeof session.rpcDropMonitor.summarize, 'function');
	assert.equal(typeof session.rpcDropMonitor.getStats, 'function');
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
	const monitorBefore = session.rpcDropMonitor;

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

	// queue/sender/monitor 实例都应保持不变（设计要点：ICE restart 不触发 DC close）
	assert.equal(session.rpcQueue, queueBefore, 'same queue instance preserved');
	assert.equal(session.rpcDcSender, senderBefore, 'same sender instance preserved');
	assert.equal(session.rpcDropMonitor, monitorBefore, 'same monitor instance preserved');
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
	await peer.closeByConnId('c_close_q', peer.__sessions.get('c_close_q'));
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

	await peer.closeByConnId('c_reuse', peer.__sessions.get('c_reuse'));

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

	await peer.closeByConnId('c_pion_04', peer.__sessions.get('c_pion_04'));
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

	await peer.closeByConnId('c_cleanup', peer.__sessions.get('c_cleanup'));

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
	await peer.closeByConnId('c_sched_cancel', peer.__sessions.get('c_sched_cancel'));
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

	await peer.closeByConnId('c_det01', peer.__sessions.get('c_det01'));
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

	await peer.closeByConnId('c_gather_det', peer.__sessions.get('c_gather_det'));
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

	await peer.closeByConnId('c_close_with_bal', peer.__sessions.get('c_close_with_bal'));

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

	assert.ok(sessFull.rpcDropMonitor.getStats().dropCount >= 1, 'sessionA monitor 应记录 drop');
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

	await peer.closeByConnId('c_pair_reuse', peer.__sessions.get('c_pair_reuse'));

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

function withQueueLifecycleMock({ blockInit = false, blockDestroy = false, target = MemoryQueue } = {}) {
	// target=MemoryQueue 是默认（mem 路径装配）；FBQ 路径装配可传 target=FileBackedQueue
	// 镜像同一份 stale init / blockDestroy 不变量验证。
	const origInit = target.prototype.init;
	const origDestroy = target.prototype.destroy;
	const initCalls = [];
	const destroyCalls = [];

	if (blockInit) {
		target.prototype.init = async function () {
			let resolve;
			const p = new Promise((r) => { resolve = r; });
			initCalls.push({ queue: this, resolve, p });
			await p;
		};
	}
	if (blockDestroy) {
		target.prototype.destroy = async function () {
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
			target.prototype.init = origInit;
			target.prototype.destroy = origDestroy;
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

test('WebRtcPeer (FBQ 镜像): __setupDataChannel 在 FBQ.init() 期间不挂 session 三件套', async () => {
	// FBQ 镜像用例：生产默认走 FBQ 装配（webrtc-peer.js:712），mem 路径上的 stale init
	// 不变量同样要在 FBQ 路径成立。直接 patch FileBackedQueue.prototype，避免装配点
	// 行为分叉时漏测。
	const tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'wp-fbq-init-'));
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
		queueDir: tmpDir,
		rpcQueueImpl: 'fbq',
	});
	try {
		await peer.handleSignaling(makeOffer('c_fbq_init'));

		const m = withQueueLifecycleMock({ blockInit: true, target: FileBackedQueue });
		try {
			const dc = makeMockRpcDc();
			PC.instances[0].ondatachannel({ channel: dc });
			await flushAsync();

			const session = peer.__sessions.get('c_fbq_init');
			assert.equal(session.rpcChannel, dc);
			assert.equal(session.rpcQueue, null, 'FBQ.init 完成前 rpcQueue 必须 null');
			assert.equal(session.rpcDcSender, null, 'FBQ.init 完成前 rpcDcSender 必须 null');
			assert.equal(session.rpcConsumeLoop, null, 'FBQ.init 完成前 rpcConsumeLoop 必须 null');
			assert.equal(m.initCalls.length, 1, 'FBQ.init 必须被调用且尚未完成');
			assert.ok(m.initCalls[0].queue instanceof FileBackedQueue, '装配点确实走 FBQ 路径');

			m.releaseInitAt(0);
			await flushAsync();
			assert.ok(session.rpcQueue instanceof FileBackedQueue);
			assert.ok(session.rpcDcSender);
			assert.ok(session.rpcConsumeLoop);
		} finally {
			m.restore();
		}

		await peer.closeAll();
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
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
		const closeP = peer.closeByConnId('c_init_close', peer.__sessions.get('c_init_close'));
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

test('WebRtcPeer: stale 装配路径不打 rpc queue impl 日志（B10 修复 invariant pin）', async () => {
	// 装配身份重核失败时，函数 destroy queue 后直接 return，绝不应再 emit local info `rpc queue impl=...`
	// 或 remoteLog `rtc.queue-impl ...`——否则运维侧会以为有连接成功装配，被装配虚报误导。
	resetRemoteLog();
	const PC = MockPCFactory();
	const logs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: () => {}, debug: () => {} },
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_stale_log'));

	const m = withQueueLifecycleMock({ blockInit: true });
	try {
		const dc = makeMockRpcDc();
		PC.instances[0].ondatachannel({ channel: dc });
		await flushAsync();
		// init blocked 期间发起 close → session 从 Map 删除
		const closeP = peer.closeByConnId('c_stale_log', peer.__sessions.get('c_stale_log'));
		await flushAsync();
		// 释放 init → setup 走 stale 分支：destroy queue + return，不应打 impl 日志
		m.releaseInitAt(0);
		await closeP;
		await flushAsync();

		assert.ok(
			!logs.some((l) => typeof l === 'string' && l.includes('rpc queue impl=')),
			'stale 路径不应打 local info rpc queue impl 日志',
		);
		assert.ok(
			!remoteLogBuffer.some((e) => e.text.includes('rtc.queue-impl conn=c_stale_log')),
			'stale 路径不应打 remoteLog rtc.queue-impl',
		);
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

		// 第二条 dc 触发"清理旧三件套"分支：sync nullify 四字段 + await queue1.destroy()
		const dc2 = makeMockRpcDc();
		PC.instances[0].ondatachannel({ channel: dc2 });
		await flushAsync();

		// await destroy → setup2 卡住 → queue2 尚未构造；race 闭合后 session.rpcQueue
		// 在装配段开头被同步置 null（让 broadcast/sendTo 看不到旧 queue 误入消息），
		// 直到 destroy 完成才赋新 queue。旧 fire-and-forget 实现下 session.rpcQueue 还是 queue1。
		assert.equal(m.destroyCalls.length, 1, 'destroy mock 必须被调用一次');
		assert.equal(session.rpcQueue, null, 'queue2 不应在旧 destroy 完成前赋字段；race 窗口里 rpcQueue 应为 null');
		assert.equal(session.rpcDcSender, null, 'rpcDcSender 同步置 null');
		assert.equal(session.rpcConsumeLoop, null, 'rpcConsumeLoop 同步置 null');
		assert.equal(session.rpcDropMonitor, null, 'rpcDropMonitor 同步置 null');

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

test('WebRtcPeer: 同 connId 重建期 broadcast/sendTo 不进入旧 queue（race 闭合）', async () => {
	// race：sync ondatachannel 已切 rpcChannel 到新 dc（readyState='open'），但旧 rpcQueue
	// 字段保留到 await destroy 完成。修前 broadcast / sendTo 在该窗口会塞进即将销毁的旧 queue
	// → 消息丢失。修后 sync nullify 把字段先置 null，broadcast 跳过 / sendTo 返回 false。
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_rebuild_race'));

	const m = withQueueLifecycleMock({ blockDestroy: true });
	try {
		const dc1 = makeMockRpcDc();
		PC.instances[0].ondatachannel({ channel: dc1 });
		await flushAsync();
		const session = peer.__sessions.get('c_rebuild_race');
		const queue1 = session.rpcQueue;
		assert.ok(queue1, 'baseline: queue1 已就位');
		const memCountBefore = queue1.stats().memCount;

		// dc2 触发清理旧三件套分支；await destroy 卡住，setup2 挂起在 race 窗口里
		const dc2 = makeMockRpcDc();
		PC.instances[0].ondatachannel({ channel: dc2 });
		await flushAsync();
		assert.equal(m.destroyCalls.length, 1, 'destroy mock 已被调用且卡住');

		// race 窗口：rpcChannel=dc2(open) + rpcQueue 应为 null（修后）
		peer.broadcast({ type: 'event', event: 'race_msg' });
		const ok = await peer.sendTo('c_rebuild_race', { type: 'event', event: 'race_msg2' });

		assert.equal(ok, false, 'sendTo 在 race 窗口应返回 false（rpcQueue=null）');
		assert.equal(queue1.stats().memCount, memCountBefore, '旧 queue 不应接收 race 窗口里的消息');

		// 释放 destroy → setup2 继续；旧 queue 进 mutex 后 destroyed=true，新 queue 已就位
		m.releaseDestroyAt(0);
		await flushAsync();
		assert.notEqual(session.rpcQueue, queue1, '新 queue 已替换');
		assert.ok(session.rpcQueue, '新 queue 已就位');
	} finally {
		m.restore();
	}

	await peer.closeAll();
});

// --- Phase A2/B-stage1：__dumpSessionState 来源拆分（queue 6 字段 + monitor 2 字段） ---

test('WebRtcPeer dump: 6 字段来自 queue.stats()，dropped/droppedBytes 来自 monitor.getStats()', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'ndc',
	});
	await peer.handleSignaling(makeOffer('c_dump_a2'));
	const pc = PC.instances[0];
	pc.ondatachannel({ channel: makeMockRpcDc() });
	await flushAsync();

	const session = peer.__sessions.get('c_dump_a2');
	assert.ok(session.rpcQueue, 'queue 已就位');
	assert.ok(session.rpcDropMonitor, 'monitor 已就位');
	// 模拟 Phase B 形态：queue.stats 返回非零的磁盘字段（B-stage1 阶段实际恒 0/false，
	// 这里 mock 是为锁定 dump 不丢字段的契约）；monitor.getStats 返回非零累计。
	// spilled / fsBroken 取不同布尔值，避免字段对调时测试仍绿。
	session.rpcQueue.stats = () => ({
		memCount: 3,
		memBytes: 4096,
		diskBytes: 8192,
		writtenBytes: 16384,
		spilled: true,
		fsBroken: false,
	});
	session.rpcDropMonitor.getStats = () => ({
		dropCount: 7,
		dropBytes: 1024,
		overflowActive: true,
		fsBroken: false,
		lastReason: 'queue-full',
	});

	pc.connectionState = 'failed';
	pc.onconnectionstatechange();

	const dump = remoteLogBuffer.find((e) => /rtc\.dump/.test(e.text) && /conn=c_dump_a2/.test(e.text));
	assert.ok(dump);
	// 顺序：queueLen → queueBytes → diskBytes → writtenBytes → spilled → fsBroken → dropped → droppedBytes
	assert.match(
		dump.text,
		/queueLen=3 queueBytes=4096 diskBytes=8192 writtenBytes=16384 spilled=true fsBroken=false dropped=7 droppedBytes=1024/,
	);

	await peer.closeAll();
});

// --- Phase B-stage1: monitor wiring 生命周期 ---

test('WebRtcPeer monitor: dc.onclose 走 destroy onBeforeClear 钩子原子拿残留快照（含 in-flight enqueue）', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_mon_close', 'v=0\r\na=max-message-size:100\r\n'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();

	const session = peer.__sessions.get('c_mon_close');
	const monitor = session.rpcDropMonitor;
	const calls = [];
	const orig = monitor.summarize;
	monitor.summarize = (residual) => { calls.push(residual); return orig.call(monitor, residual); };

	// 制造背压：sender 阻塞 + 多条积压
	dc.bufferedAmount = 1024 * 1024;
	for (let i = 0; i < 3; i += 1) peer.broadcast({ type: 'res', n: i });
	// **race 关键**：紧接着同 tick 再来一条 broadcast（in-flight，未拿到 mutex）
	peer.broadcast({ type: 'res', n: 999 });
	// 立刻同步触发 dc.onclose（不 flushAsync）
	dc.readyState = 'closed';
	dc.onclose();
	// 三件套字段同步路径已清空（field 失访 → monRef 闭包仍持引用）
	assert.equal(session.rpcDropMonitor, null);
	assert.equal(session.rpcQueue, null);
	// 等异步 destroy 完成（onBeforeClear 在 mutex 内 fire）
	await flushAsync();

	assert.ok(calls.length >= 1, 'monitor.summarize 通过 destroy 回调被调');
	// 修复 D-Finding 1：onBeforeClear 在 mutex 内拿快照，能看到所有 in-flight enqueue
	assert.ok(calls[0]?.memCount >= 4, `onBeforeClear 必须看到全部入队消息（含 in-flight），got ${calls[0]?.memCount}`);

	await peer.closeAll();
});

test('WebRtcPeer monitor: closeByConnId 路径调 monitor.summarize 把残留传入', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_mon_cbc', 'v=0\r\na=max-message-size:100\r\n'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();
	const session = peer.__sessions.get('c_mon_cbc');
	const monitor = session.rpcDropMonitor;
	const calls = [];
	const orig = monitor.summarize;
	monitor.summarize = (r) => { calls.push(r); return orig.call(monitor, r); };

	// 制造残留
	dc.bufferedAmount = 1024 * 1024;
	for (let i = 0; i < 3; i += 1) peer.broadcast({ type: 'res', n: i });
	await flushAsync();

	await peer.closeByConnId('c_mon_cbc', peer.__sessions.get('c_mon_cbc'));
	assert.ok(calls.length >= 1, 'monitor.summarize 至少被调用一次');
	// 第一次调用必须带 queue.stats() 残留快照
	assert.ok(typeof calls[0]?.memCount === 'number');
	assert.ok(calls[0].memCount > 0, 'closeByConnId 时残留 memCount > 0');
});

test('WebRtcPeer monitor: 同 connId 重建走 await destroy 路径，旧 monitor 先 summarize 再被新实例替换', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_mon_rebuild'));
	const dc1 = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc1 });
	await flushAsync();
	const session = peer.__sessions.get('c_mon_rebuild');
	const oldMonitor = session.rpcDropMonitor;
	const summCalls = [];
	const orig = oldMonitor.summarize;
	oldMonitor.summarize = (r) => { summCalls.push(r); return orig.call(oldMonitor, r); };

	// 同 connId 二次 ondatachannel：触发旧三件套清理 + 新实例创建
	// pc.ondatachannel 内部会在 sync 段把 session.rpcChannel 切到 dc2，不需要测试手动赋值
	const dc2 = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc2 });
	await flushAsync();

	const newMonitor = session.rpcDropMonitor;
	assert.ok(newMonitor, '新 monitor 已挂');
	assert.notEqual(newMonitor, oldMonitor, '新 monitor 是新实例');
	// 旧 monitor.summarize 至少被调一次（重建清理路径调一次，旧 consumeLoop finally 也会再调一次，
	// 内部 summarized flag 保证只 emit 一条 close log）
	assert.ok(summCalls.length >= 1, '旧 monitor.summarize 至少被调一次');
	const closes = remoteLogBuffer.filter((e) => /rpc-queue\.close/.test(e.text));
	assert.ok(closes.length <= 1, '幂等：close log 最多一条');

	await peer.closeAll();
});

test('WebRtcPeer monitor: dc.onclose + consumeLoop finally 都调 destroy(callback)，destroy 幂等保证 onBeforeClear 仅一次', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_mon_loop'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();
	const session = peer.__sessions.get('c_mon_loop');
	const monitor = session.rpcDropMonitor;
	const calls = [];
	const orig = monitor.summarize;
	monitor.summarize = (r) => { calls.push(r); return orig.call(monitor, r); };

	// 触发 dc.onclose（同步路径走 destroy(callback)，consumeLoop finally 也走 destroy(callback)）
	dc.readyState = 'closed';
	dc.onclose();
	await flushAsync();

	// destroy 自身幂等（this.destroyed 短路），第二次调 onBeforeClear 不再 fire
	assert.equal(calls.length, 1, 'destroy 幂等：onBeforeClear 仅 fire 一次');
	// monitor 内部 summarized flag 也兜底（即使外部直调 monitor.summarize 第二次也 no-op）
	const closes = remoteLogBuffer.filter((e) => /rpc-queue\.close/.test(e.text));
	assert.equal(closes.length, 0, 'no drops, no residual → no close emit');

	await peer.closeAll();
});

test('WebRtcPeer monitor: stale-init 路径不挂载 monitor（blockInit + closeByConnId 释放）', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_mon_stale'));

	const m = withQueueLifecycleMock({ blockInit: true });
	try {
		const dc = makeMockRpcDc();
		PC.instances[0].ondatachannel({ channel: dc });
		await flushAsync();

		const session = peer.__sessions.get('c_mon_stale');
		// init 阻塞中：三件套（含 monitor）都还未挂
		assert.equal(session.rpcDropMonitor, null, 'init 完成前 monitor 不挂');
		assert.equal(m.initCalls.length, 1, 'queue.init 必须被调用且尚未完成');

		// 闯入 closeByConnId → session 从 Map 删除
		const closing = peer.closeByConnId('c_mon_stale', peer.__sessions.get('c_mon_stale'));
		await flushAsync();

		// 释放 init → setup 走 stale 分支退出，monitor 不挂
		m.releaseInitAt(0);
		await closing;

		// 即使 init 释放后 setup 走完 stale 分支，session.rpcDropMonitor 始终保持 null
		// （session 已从 Map 删除，但闭包还能引用 session 对象）
		assert.equal(session.rpcDropMonitor, null, 'stale 分支退出后 monitor 仍不挂');
		assert.equal(session.rpcQueue, null, 'stale 分支退出后 queue 仍不挂');

		assert.equal(peer.__sessions.has('c_mon_stale'), false, 'session 已被删除');
	} finally {
		m.restore();
	}

	await peer.closeAll();
});

test('WebRtcPeer monitor: dc 关闭后 session.rpcDropMonitor === null', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({ onSend: () => {}, logger: silentLogger(), PeerConnection: PC, impl: 'pion' });
	await peer.handleSignaling(makeOffer('c_mon_null'));
	const dc = makeMockRpcDc();
	PC.instances[0].ondatachannel({ channel: dc });
	await flushAsync();
	const session = peer.__sessions.get('c_mon_null');
	assert.ok(session.rpcDropMonitor);

	dc.readyState = 'closed';
	dc.onclose();
	await flushAsync();
	assert.equal(session.rpcDropMonitor, null);

	await peer.closeAll();
});

// --- per-connId offer mutex 串行化 + close-during-lock 身份重核 ---

/**
 * 用 manual-resolve 把 setRemoteDescription / createAnswer / setLocalDescription 卡住，
 * 配合 awaitNTicks 打开窗口模拟 close-during-lock 与并发 offer。
 */
function makeControllablePc(initial = {}) {
	const gates = {
		setRemoteDescription: [],
		createAnswer: [],
		setLocalDescription: [],
	};
	// 调用计数器：用于"持锁期间下一条 offer 完全没触碰 PC"的反向断言（A 项）
	const calls = {
		setRemoteDescription: 0,
		createAnswer: 0,
		setLocalDescription: 0,
	};
	const pc = createMockPC();
	Object.assign(pc, initial);
	pc.setRemoteDescription = async (desc) => {
		calls.setRemoteDescription += 1;
		pc.__lastRemoteSdp = desc.sdp;
		await new Promise((resolve) => gates.setRemoteDescription.push(resolve));
	};
	pc.createAnswer = async () => {
		calls.createAnswer += 1;
		await new Promise((resolve) => gates.createAnswer.push(resolve));
		return { sdp: `answer-for:${pc.__lastRemoteSdp ?? '?'}` };
	};
	pc.setLocalDescription = async (desc) => {
		calls.setLocalDescription += 1;
		pc.__lastLocalSdp = desc.sdp;
		await new Promise((resolve) => gates.setLocalDescription.push(resolve));
	};
	pc.__gates = gates;
	pc.__calls = calls;
	pc.__release = (name) => {
		const fn = gates[name].shift();
		if (fn) fn();
	};
	pc.__pending = (name) => gates[name].length;
	return pc;
}

test('WebRtcPeer: 同 connId 两条 ICE restart offer 串行化（最后一条胜出）', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	// 建立初始 session（首次 offer 走默认 mock，不卡）
	await peer.handleSignaling(makeOffer('c_mu01'));
	assert.equal(PC.instances.length, 1);

	// 把现有 PC 替换为可控 mock，session 字段同步指向新 pc
	const ctrl = makeControllablePc();
	const session = peer.__sessions.get('c_mu01');
	session.pc = ctrl;
	sent.length = 0;

	// 几乎同时投递两条 ICE restart offer：A、B
	const pA = peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu01',
		payload: { sdp: 'sdp-A', iceRestart: true },
	});
	const pB = peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu01',
		payload: { sdp: 'sdp-B', iceRestart: true },
	});

	await flushAsync();
	// A 进入 setRemoteDescription，B 在 mutex 队列里阻塞——逐节点反向断言：
	// B 完全没触碰 PC 任一方法（不光是 sent 顺序对，PC 调用本身也应被锁住）
	assert.equal(ctrl.__pending('setRemoteDescription'), 1, 'A should be at setRemoteDescription, B blocked on mutex');
	assert.equal(ctrl.__calls.setRemoteDescription, 1, 'only A reached setRemoteDescription');
	assert.equal(ctrl.__calls.createAnswer, 0, 'B should not reach createAnswer while A holds mutex');
	assert.equal(ctrl.__calls.setLocalDescription, 0, 'B should not reach setLocalDescription while A holds mutex');

	// 放行 A 的 setRemoteDescription → 进 createAnswer
	ctrl.__release('setRemoteDescription');
	await flushAsync();
	assert.equal(ctrl.__calls.createAnswer, 1, 'A reached createAnswer; B still blocked');
	assert.equal(ctrl.__calls.setRemoteDescription, 1, 'B still cannot touch setRemoteDescription');
	assert.equal(ctrl.__calls.setLocalDescription, 0, 'B still cannot touch setLocalDescription');

	// 放行 A 的 createAnswer → 进 setLocalDescription
	ctrl.__release('createAnswer');
	await flushAsync();
	assert.equal(ctrl.__calls.setLocalDescription, 1, 'A reached setLocalDescription; B still blocked');
	assert.equal(ctrl.__calls.setRemoteDescription, 1, 'B still cannot touch setRemoteDescription');

	// 放行 A 的 setLocalDescription → A 完成
	ctrl.__release('setLocalDescription');
	await pA;

	// A 的 answer 已发；放行 A 后 B 在下一波微任务中进入 setRemoteDescription（lastRemoteSdp
	// 被 B 的 sync 段覆盖为 sdp-B 是预期，因此这里只断言 sent[0] 来自 A）
	assert.ok(sent.length >= 1);
	assert.equal(sent[0].type, 'rtc:answer');
	assert.match(sent[0].payload.sdp, /sdp-A/, `expected A's answer first, got ${sent[0].payload.sdp}`);

	await flushAsync();
	assert.equal(ctrl.__pending('setRemoteDescription'), 1, 'B should now be at setRemoteDescription');

	// 放行 B 的三连
	ctrl.__release('setRemoteDescription');
	await flushAsync();
	ctrl.__release('createAnswer');
	await flushAsync();
	ctrl.__release('setLocalDescription');
	await pB;

	// 两条 answer 顺序与 offer 顺序一致：A then B
	assert.equal(sent.length, 2);
	assert.equal(sent[1].type, 'rtc:answer');
	assert.match(sent[1].payload.sdp, /sdp-B/);
	// 最后一条胜出：PC 凭据 = B
	assert.equal(ctrl.__lastRemoteSdp, 'sdp-B', 'last-write-wins: PC remote = B');

	await peer.closeAll();
});

test('WebRtcPeer: 同 connId 三条 ICE restart offer 严格 FIFO（最后一条胜出）', async () => {
	// UI 端 __restartInFlight 限制 N≤3；线上 N=3 真实出现，单独锁住"三条都被串行"行为
	// 防止 mutex 链式接龙错误地把第三条与前面并行
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_mu_n3'));
	const ctrl = makeControllablePc();
	peer.__sessions.get('c_mu_n3').pc = ctrl;
	sent.length = 0;

	const pA = peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu_n3',
		payload: { sdp: 'sdp-A', iceRestart: true },
	});
	const pB = peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu_n3',
		payload: { sdp: 'sdp-B', iceRestart: true },
	});
	const pC = peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu_n3',
		payload: { sdp: 'sdp-C', iceRestart: true },
	});

	await flushAsync();
	// A 持锁；B、C 都还没触碰 PC（mutex 队列里串行排队，不是并发）
	assert.equal(ctrl.__calls.setRemoteDescription, 1, 'only A reached setRemoteDescription');
	assert.equal(ctrl.__pending('setRemoteDescription'), 1);

	// 跑完 A：放三连
	ctrl.__release('setRemoteDescription');
	await flushAsync();
	ctrl.__release('createAnswer');
	await flushAsync();
	ctrl.__release('setLocalDescription');
	await pA;
	await flushAsync();

	// B 接力：A 跑完后 B 进 setRemoteDescription，C 仍在排队
	assert.equal(ctrl.__calls.setRemoteDescription, 2, 'B reached setRemoteDescription after A');
	assert.equal(ctrl.__pending('setRemoteDescription'), 1);

	ctrl.__release('setRemoteDescription');
	await flushAsync();
	ctrl.__release('createAnswer');
	await flushAsync();
	ctrl.__release('setLocalDescription');
	await pB;
	await flushAsync();

	// C 接力
	assert.equal(ctrl.__calls.setRemoteDescription, 3, 'C reached setRemoteDescription after B');

	ctrl.__release('setRemoteDescription');
	await flushAsync();
	ctrl.__release('createAnswer');
	await flushAsync();
	ctrl.__release('setLocalDescription');
	await pC;

	// 三条 answer，顺序 A→B→C；最终凭据 = C
	const answers = sent.filter((m) => m.type === 'rtc:answer');
	assert.equal(answers.length, 3);
	assert.match(answers[0].payload.sdp, /sdp-A/);
	assert.match(answers[1].payload.sdp, /sdp-B/);
	assert.match(answers[2].payload.sdp, /sdp-C/);
	assert.equal(ctrl.__lastRemoteSdp, 'sdp-C', 'last-write-wins: PC remote = C');

	await peer.closeAll();
});

test('WebRtcPeer: ICE restart 中途 closeByConnId → setRemoteDescription 后身份重核命中', async () => {
	const sent = [];
	const logs = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: { ...silentLogger(), info: (m) => logs.push(m) },
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_mu02'));
	const ctrl = makeControllablePc();
	peer.__sessions.get('c_mu02').pc = ctrl;
	sent.length = 0;
	logs.length = 0;

	const p = peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu02',
		payload: { sdp: 'restart-sdp', iceRestart: true },
	});
	await flushAsync();
	// fn 在 gate 1（setRemoteDescription 的 await）阻塞中。先 close 让 session 飞走，
	// 再放 gate → fn 唤醒、撞上 setRemoteDescription 后的身份重核
	await peer.closeByConnId('c_mu02', peer.__sessions.get('c_mu02'));
	ctrl.__release('setRemoteDescription');
	await p;
	// G 项：负向 send 断言前 flush，吃掉 onSend 可能被推迟到下一微任务的窗口；
	// 防止"实施把 onSend 改成 setImmediate"这类变化让断言静默通过
	await flushAsync();

	// 不发 stale rtc:answer
	assert.equal(sent.filter((m) => m.type === 'rtc:answer').length, 0);
	// 不发 restart-rejected（catch 也不应触发，正常路径走 abort）
	assert.equal(sent.filter((m) => m.type === 'rtc:restart-rejected').length, 0);
	// logger.info 中应有 abort 字样
	assert.ok(logs.some((m) => /aborted: session changed after setRemoteDescription/.test(m)),
		`expected abort log for setRemoteDescription, got: ${JSON.stringify(logs)}`);
});

test('WebRtcPeer: ICE restart 中途 closeByConnId → createAnswer 后身份重核命中', async () => {
	const sent = [];
	const logs = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: { ...silentLogger(), info: (m) => logs.push(m) },
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_mu03'));
	const ctrl = makeControllablePc();
	peer.__sessions.get('c_mu03').pc = ctrl;
	sent.length = 0;
	logs.length = 0;

	const p = peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu03',
		payload: { sdp: 'restart-sdp', iceRestart: true },
	});
	await flushAsync();
	// 放掉 gate 1，fn 通过 setRemoteDescription 后的重核（session 还在）→ 进入 gate 2
	ctrl.__release('setRemoteDescription');
	await flushAsync();
	// 此刻 fn 阻塞在 createAnswer 的 await：close 让 session 飞走，再放 gate 2
	await peer.closeByConnId('c_mu03', peer.__sessions.get('c_mu03'));
	ctrl.__release('createAnswer');
	await p;
	await flushAsync(); // G 项：负向 send 断言前 flush

	assert.equal(sent.filter((m) => m.type === 'rtc:answer').length, 0);
	assert.equal(sent.filter((m) => m.type === 'rtc:restart-rejected').length, 0);
	assert.ok(logs.some((m) => /aborted: session changed after createAnswer/.test(m)),
		`expected abort log for createAnswer, got: ${JSON.stringify(logs)}`);
});

test('WebRtcPeer: ICE restart 中途 closeByConnId → setLocalDescription 后身份重核命中', async () => {
	const sent = [];
	const logs = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: { ...silentLogger(), info: (m) => logs.push(m) },
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_mu04'));
	const ctrl = makeControllablePc();
	peer.__sessions.get('c_mu04').pc = ctrl;
	sent.length = 0;
	logs.length = 0;

	const p = peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu04',
		payload: { sdp: 'restart-sdp', iceRestart: true },
	});
	await flushAsync();
	ctrl.__release('setRemoteDescription');
	await flushAsync();
	ctrl.__release('createAnswer');
	await flushAsync();
	// 此刻 fn 阻塞在 setLocalDescription 的 await：close 让 session 飞走，再放 gate 3
	await peer.closeByConnId('c_mu04', peer.__sessions.get('c_mu04'));
	ctrl.__release('setLocalDescription');
	await p;
	await flushAsync(); // G 项：负向 send 断言前 flush

	assert.equal(sent.filter((m) => m.type === 'rtc:answer').length, 0);
	assert.equal(sent.filter((m) => m.type === 'rtc:restart-rejected').length, 0);
	assert.ok(logs.some((m) => /aborted: session changed after setLocalDescription/.test(m)),
		`expected abort log for setLocalDescription, got: ${JSON.stringify(logs)}`);
});

test('WebRtcPeer: ICE restart catch 入口身份重核命中（错误 + session 已换）', async () => {
	const sent = [];
	const logs = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: { ...silentLogger(), info: (m) => logs.push(m) },
		PeerConnection: PC,
		impl: 'pion',
	});

	// F 项：测试开头 reset remoteLogBuffer，避免被先行测试的 c_mu05 之外条目污染
	// （现在唯一过滤是 connId，hermetic 性强化）
	resetRemoteLog();

	await peer.handleSignaling(makeOffer('c_mu05'));
	const session = peer.__sessions.get('c_mu05');
	// B 项：用 throwGate 确定性触发，与其他 3 个 abort 测试 gate 风格一致；
	// 不再依赖 setImmediate ×2 的隐式时序
	let entered;
	const enteredP = new Promise((r) => { entered = r; });
	let triggerThrow;
	const throwGate = new Promise((r) => { triggerThrow = r; });
	session.pc.setRemoteDescription = async () => {
		entered();
		await throwGate;
		throw new Error('PC closed mid-flight');
	};
	sent.length = 0;
	logs.length = 0;

	const p = peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu05',
		payload: { sdp: 'restart-sdp', iceRestart: true },
	});
	await enteredP;
	// 此时 setRemoteDescription 卡在 throwGate 上 → 关掉 session 让身份变化
	await peer.closeByConnId('c_mu05', peer.__sessions.get('c_mu05'));
	// 触发抛错，fn 走 catch → 命中身份重核 suppress 路径
	triggerThrow();
	await p;
	// G 项：负向 send 断言前 flush，吃掉 onSend 微任务窗口
	await flushAsync();

	// catch 入口身份重核命中：不发 restart-rejected
	assert.equal(sent.filter((m) => m.type === 'rtc:restart-rejected').length, 0);
	assert.equal(sent.filter((m) => m.type === 'rtc:answer').length, 0);
	assert.ok(logs.some((m) => /ICE restart error after session change \(suppressed\)/.test(m)),
		`expected catch-entry suppressed log, got: ${JSON.stringify(logs)}`);
	// session 已被外部 close，catch 路径不应再调 closeByConnId（已经是 no-op，但避免噪声日志）
	// 通过 rtc.closed remoteLog 数量验证：第一条来自外部 close，无第二条
	const closedLogs = remoteLogBuffer.filter((e) => /^rtc\.closed conn=c_mu05/.test(e.text));
	assert.equal(closedLogs.length, 1, `expected exactly one rtc.closed (no double close), got: ${JSON.stringify(closedLogs.map((e) => e.text))}`);
});

test('WebRtcPeer: session 销毁后 offerMutex 随 session GC；新 session 持新 mutex 实例', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_mu06'));
	// session 字段含 offerMutex，与 session 同寿
	const firstSession = peer.__sessions.get('c_mu06');
	assert.ok(firstSession?.offerMutex, '首次 offer 后 session.offerMutex 应存在');
	const firstMutex = firstSession.offerMutex;

	await peer.closeByConnId('c_mu06', firstSession);
	// session 删除后，整个 session 引用 + offerMutex 一并随 GC
	assert.equal(peer.__sessions.has('c_mu06'), false, 'closeByConnId 后 session 被删');

	// 同 connId 再次 offer → 建新 session，新 offerMutex 实例
	await peer.handleSignaling(makeOffer('c_mu06'));
	const secondSession = peer.__sessions.get('c_mu06');
	assert.ok(secondSession?.offerMutex, '再次 offer 后 session.offerMutex 应存在');
	assert.notEqual(secondSession, firstSession, '应是新 session 实例');
	assert.notEqual(secondSession.offerMutex, firstMutex, 'offerMutex 应是新实例（不是旧引用）');

	await peer.closeAll();
});

test('WebRtcPeer: 不同 connId 的 ICE restart 互不阻塞（mutex per-connId 隔离）', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_mu_A'));
	await peer.handleSignaling(makeOffer('c_mu_B'));
	const ctrlA = makeControllablePc();
	const ctrlB = makeControllablePc();
	peer.__sessions.get('c_mu_A').pc = ctrlA;
	peer.__sessions.get('c_mu_B').pc = ctrlB;
	sent.length = 0;

	// A、B 两个 connId 各发一条 ICE restart：互不应阻塞
	const pA = peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu_A',
		payload: { sdp: 'sdp-A', iceRestart: true },
	});
	const pB = peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu_B',
		payload: { sdp: 'sdp-B', iceRestart: true },
	});
	await flushAsync();
	// 两个 PC 都应在 setRemoteDescription 上等待（并行）
	assert.equal(ctrlA.__pending('setRemoteDescription'), 1);
	assert.equal(ctrlB.__pending('setRemoteDescription'), 1);

	// 先放 B 完成，验证 A 不被 B 阻塞
	ctrlB.__release('setRemoteDescription');
	await flushAsync();
	ctrlB.__release('createAnswer');
	await flushAsync();
	ctrlB.__release('setLocalDescription');
	await pB;

	ctrlA.__release('setRemoteDescription');
	await flushAsync();
	ctrlA.__release('createAnswer');
	await flushAsync();
	ctrlA.__release('setLocalDescription');
	await pA;

	const answers = sent.filter((m) => m.type === 'rtc:answer');
	assert.equal(answers.length, 2);
	// B 的 answer 先到（虽然 A 先发）—— 验证不同 connId 互不阻塞
	assert.equal(answers[0].toConnId, 'c_mu_B');
	assert.equal(answers[1].toConnId, 'c_mu_A');

	await peer.closeAll();
});

test('WebRtcPeer: ICE restart 进行中收到 rtc:closed → 身份重核兜住，不发 stale answer', async () => {
	const sent = [];
	const logs = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: { ...silentLogger(), info: (m) => logs.push(m) },
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_mu_rc'));
	const ctrl = makeControllablePc();
	peer.__sessions.get('c_mu_rc').pc = ctrl;
	sent.length = 0;
	logs.length = 0;

	const p = peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu_rc',
		payload: { sdp: 'restart-sdp', iceRestart: true },
	});
	await flushAsync();
	// 模拟 server 转发 UI 主动 rtc:closed 信号 —— handleSignaling 直接路由到 closeByConnId
	await peer.handleSignaling({ type: 'rtc:closed', fromConnId: 'c_mu_rc' });
	ctrl.__release('setRemoteDescription');
	await p;
	await flushAsync(); // G 项：负向 send 断言前 flush

	assert.equal(sent.filter((m) => m.type === 'rtc:answer').length, 0, 'no stale answer');
	assert.equal(sent.filter((m) => m.type === 'rtc:restart-rejected').length, 0, 'no restart-rejected');
	assert.ok(logs.some((m) => /aborted: session changed after setRemoteDescription/.test(m)),
		`expected abort log, got: ${JSON.stringify(logs)}`);
});

test('WebRtcPeer: ICE restart 进行中 closeAll 触发 → 身份重核兜住', async () => {
	const sent = [];
	const logs = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: { ...silentLogger(), info: (m) => logs.push(m) },
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_mu_ca'));
	const ctrl = makeControllablePc();
	peer.__sessions.get('c_mu_ca').pc = ctrl;
	sent.length = 0;
	logs.length = 0;

	const p = peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu_ca',
		payload: { sdp: 'restart-sdp', iceRestart: true },
	});
	await flushAsync();
	ctrl.__release('setRemoteDescription');
	await flushAsync();
	// fn 在 createAnswer 等待中：模拟 gateway 退出/重启时的 closeAll
	const closeAllPromise = peer.closeAll();

	// D 项反向断言：closeAll 不等 in-flight handleOffer。closeAll 内部只 await closeByConnId，
	// 不与 offer mutex 关联——fn 仍卡在 createAnswer gate 上时 closeAll 应已 resolve。
	let pSettled = false;
	p.then(() => { pSettled = true; }, () => { pSettled = true; });
	await closeAllPromise;
	await flushAsync();
	assert.equal(pSettled, false, 'closeAll should resolve while in-flight handleOffer is still parked');
	assert.equal(ctrl.__pending('createAnswer'), 1, 'fn still parked at createAnswer gate after closeAll');

	// 现在放行 createAnswer，让 fn 进入 createAnswer 后的身份重核 abort 路径
	ctrl.__release('createAnswer');
	await p;
	await flushAsync(); // G 项：负向 send 断言前 flush

	assert.equal(sent.filter((m) => m.type === 'rtc:answer').length, 0, 'no stale answer after closeAll');
	assert.ok(logs.some((m) => /aborted: session changed/.test(m)),
		`expected abort log, got: ${JSON.stringify(logs)}`);
});

test('WebRtcPeer: failed → TTL 触发 closeByConnId 与 ICE restart in-flight 交叠 → 身份重核兜住', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const sent = [];
	const logs = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: { ...silentLogger(), info: (m) => logs.push(m) },
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_mu_ttl'));
	const realPc = PC.instances[0];
	// 进入 failed 启动 12h TTL timer
	realPc.connectionState = 'failed';
	realPc.onconnectionstatechange();
	assert.ok(peer.__sessions.get('c_mu_ttl').__failedTimer);

	// 现在用可控 PC 替换，模拟 ICE restart 协商中
	const ctrl = makeControllablePc();
	peer.__sessions.get('c_mu_ttl').pc = ctrl;
	sent.length = 0;
	logs.length = 0;

	const p = peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu_ttl',
		payload: { sdp: 'restart-sdp', iceRestart: true },
	});
	await flushAsync();
	// 注意：__handleOfferLocked 进入 ICE restart 路径会清 __failedTimer（260-264 行）
	// 所以模拟 TTL 在 restart 启动前到期：直接调 closeByConnId 模拟更晚到的 timer 兜底
	await peer.closeByConnId('c_mu_ttl', peer.__sessions.get('c_mu_ttl'));
	ctrl.__release('setRemoteDescription');
	await p;
	await flushAsync(); // G 项：负向 send 断言前 flush
	t.mock.timers.reset();

	assert.equal(sent.filter((m) => m.type === 'rtc:answer').length, 0);
	assert.ok(logs.some((m) => /aborted: session changed/.test(m)));
});

test('WebRtcPeer: 首次 offer 与紧随 ICE restart 经 mutex 串行（验证 mutex 包整个 __handleOffer）', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	// 用工厂但替换 PC 实现：让首次 offer 创建可控 PC，可卡住三连
	const ctrl = makeControllablePc();
	const PC2 = function () { PC.instances.push(ctrl); return ctrl; };
	PC2.instances = PC.instances;
	const peer2 = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC2,
		impl: 'pion',
	});

	// A：首次 offer，会创建新 PC 并进三连
	const pA = peer2.handleSignaling(makeOffer('c_mu_seq', 'first-sdp'));
	await flushAsync();
	// A 应在 setRemoteDescription gate 上
	assert.equal(ctrl.__pending('setRemoteDescription'), 1);

	// B：ICE restart 紧随，应被 mutex 阻塞排队
	const pB = peer2.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu_seq',
		payload: { sdp: 'restart-sdp', iceRestart: true },
	});
	await flushAsync();
	// B 仍未触碰 PC（mutex 排队）
	assert.equal(ctrl.__pending('setRemoteDescription'), 1, 'B should still be queued, not at gate');

	// 放行 A 的三连
	ctrl.__release('setRemoteDescription');
	await flushAsync();
	ctrl.__release('createAnswer');
	await flushAsync();
	ctrl.__release('setLocalDescription');
	await pA;

	// A 完成；B 现在应进入 ICE restart 三连
	await flushAsync();
	assert.equal(ctrl.__pending('setRemoteDescription'), 1, 'B now at setRemoteDescription');

	ctrl.__release('setRemoteDescription');
	await flushAsync();
	ctrl.__release('createAnswer');
	await flushAsync();
	ctrl.__release('setLocalDescription');
	await pB;

	// 两个 answer，顺序 A→B
	const answers = sent.filter((m) => m.type === 'rtc:answer');
	assert.equal(answers.length, 2);
	assert.equal(answers[0].toConnId, 'c_mu_seq');
	assert.match(answers[0].payload.sdp, /first-sdp/);
	assert.match(answers[1].payload.sdp, /restart-sdp/);
});

test('WebRtcPeer: 排队中的 ICE restart 在 withLock 期间 session 被删 → A/B 均身份重核静默 abort', async () => {
	// 场景（mutex 聚合进 session 后的新形态）：A 进 mutex 卡在 setRemoteDescription，B 在
	// 同一 session.offerMutex 队列里；期间外部 rtc:closed 同步删除 session 引用并 await
	// pc.close。释放 A 的三连 await → A 命中身份重核 abort；B 上场后用同一 captured session
	// 也调 setRemoteDescription，三连 await 释放后同样命中身份重核 abort。两者都不发 stale
	// rtc:answer 也不再走老设计中"锁内 no-session reject"分支（结构上已消失）。
	const sent = [];
	const logs = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {}, debug: () => {} },
		PeerConnection: PC,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_mu_qrc'));
	const ctrl = makeControllablePc();
	peer.__sessions.get('c_mu_qrc').pc = ctrl;
	sent.length = 0;
	logs.length = 0;

	// A 进 mutex（卡 setRemoteDescription gate）
	const pA = peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu_qrc',
		payload: { sdp: 'sdp-A', iceRestart: true },
	});
	await flushAsync();

	// B 在同一 session.offerMutex 上排队（sync gate 此时 sessions.has 仍 true，复用同一 session）
	const pB = peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu_qrc',
		payload: { sdp: 'sdp-B', iceRestart: true },
	});
	await flushAsync();

	// 外部 rtc:closed → closeByConnId 同步删 sessions 表项（pc.close 在 controllable mock 上立即 resolve）
	await peer.handleSignaling({ type: 'rtc:closed', fromConnId: 'c_mu_qrc' });

	// 放行 A：A 第一段 await 后身份重核命中（sessions.get → undefined）→ 静默 return
	ctrl.__release('setRemoteDescription');
	await pA;

	// B 接力进锁：再次调 setRemoteDescription 推一个新 gate；释放后 B 也命中身份重核静默 abort
	await flushAsync();
	ctrl.__release('setRemoteDescription');
	await pB;

	const answers = sent.filter((m) => m.type === 'rtc:answer');
	const rejects = sent.filter((m) => m.type === 'rtc:restart-rejected');
	assert.equal(answers.length, 0, 'A/B 均 abort，无 rtc:answer');
	assert.equal(rejects.length, 0, '新设计无锁内 no-session reject 分支，不应发 restart-rejected');
	// 双方 abort 日志都应可见（用于诊断）
	const abortLogs = logs.filter((m) => /ICE restart aborted: session changed after setRemoteDescription/.test(m));
	assert.equal(abortLogs.length, 2, 'A 与 B 各产生一条 abort 日志');
});

test('WebRtcPeer: no-session ICE restart 不创建 session（mutex 与 session 一一同寿）', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	// 直接发 ICE restart 给一个从未建过 session 的 connId → 走 no-session 前置 reject
	await peer.handleSignaling({
		type: 'rtc:offer',
		fromConnId: 'c_mu_leak',
		payload: { sdp: 'sdp', iceRestart: true },
	});

	// 该路径根本不建 session（也就不存在 session.offerMutex）
	assert.equal(peer.__sessions.has('c_mu_leak'), false, 'no-session restart 不应建 session');
	// reject 信号正常发出
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, 'rtc:restart-rejected');
	assert.equal(sent[0].payload.reason, 'no_session');
});

test('WebRtcPeer: 首次 offer 抛错后 catch 同步清 session（offerMutex 随 session GC）', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	// 让首次 offer 在 setRemoteDescription 抛错（PC 构造后 setRemoteDescription 失败）
	const origPC = PC;
	const FailingPC = function (opts) {
		const pc = origPC(opts);
		pc.setRemoteDescription = async () => { throw new Error('SDP rejected'); };
		return pc;
	};
	FailingPC.instances = PC.instances;
	const peer2 = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: FailingPC,
		impl: 'pion',
	});

	await assert.rejects(
		peer2.handleSignaling(makeOffer('c_mu_throw')),
		/SDP rejected/,
	);
	// session 已被 catch 通过 closeByConnId 删除；offerMutex 随 session 一同 GC，无残留可言
	assert.equal(peer2.__sessions.has('c_mu_throw'), false);
});

// ============================================================================
// mutex 聚合进 session 后新增的测试：覆盖首次 offer 三段 await 身份重核 + 非 ICE
// 重发到现有 session 的五件事原子 + 首次 offer catch 身份重核 suppress。
// ============================================================================

test('WebRtcPeer: 首次 offer setRemoteDescription 后 session 被替换 → 身份重核静默 abort（不发 stale rtc:answer）', async () => {
	const sent = [];
	const logs = [];
	const PC = MockPCFactory();
	const ctrl = makeControllablePc();
	// 让 sync gate 内 new PeerConnection 返回 ctrl（仅第一次）
	let used = false;
	const FirstCtrlPC = function (opts) {
		if (!used) {
			used = true;
			ctrl.__constructorArgs = opts;
			PC.instances.push(ctrl);
			return ctrl;
		}
		return PC(opts);
	};
	FirstCtrlPC.instances = PC.instances;
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {}, debug: () => {} },
		PeerConnection: FirstCtrlPC,
		impl: 'pion',
	});

	// 首次 offer：sync gate 建 session1 入表，进锁后卡在 setRemoteDescription
	const pFirst = peer.handleSignaling(makeOffer('c_fo01'));
	await flushAsync();

	const session1 = peer.__sessions.get('c_fo01');
	assert.ok(session1, 'session1 应已建好');

	// 外部 rtc:closed 同步删表 + fire-and-forget pc.close
	await peer.handleSignaling({ type: 'rtc:closed', fromConnId: 'c_fo01' });
	assert.equal(peer.__sessions.has('c_fo01'), false, '外部 close 后 session 从表中删除');

	// 放行 setRemoteDescription → 身份重核命中（sessions.get → undefined）→ 静默 return
	ctrl.__release('setRemoteDescription');
	await pFirst;

	const answers = sent.filter((m) => m.type === 'rtc:answer');
	assert.equal(answers.length, 0, '身份重核命中 → 不发 stale rtc:answer');
	assert.ok(
		logs.some((m) => /first offer aborted: session changed after setRemoteDescription/.test(m)),
		`expected first-offer abort log, got: ${JSON.stringify(logs)}`,
	);
});

test('WebRtcPeer: 首次 offer createAnswer 后 session 被替换 → 身份重核静默 abort', async () => {
	const sent = [];
	const logs = [];
	const PC = MockPCFactory();
	const ctrl = makeControllablePc();
	let used = false;
	const PCFactory = function (opts) {
		if (!used) {
			used = true;
			ctrl.__constructorArgs = opts;
			PC.instances.push(ctrl);
			return ctrl;
		}
		return PC(opts);
	};
	PCFactory.instances = PC.instances;
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {}, debug: () => {} },
		PeerConnection: PCFactory,
		impl: 'pion',
	});

	const pFirst = peer.handleSignaling(makeOffer('c_fo02'));
	await flushAsync();
	// 放行第一段 → 卡在 createAnswer
	ctrl.__release('setRemoteDescription');
	await flushAsync();

	// 此时身份重核第一关已过；外部 close 删 session
	await peer.handleSignaling({ type: 'rtc:closed', fromConnId: 'c_fo02' });

	// 放行 createAnswer → 第二段身份重核命中
	ctrl.__release('createAnswer');
	await pFirst;

	const answers = sent.filter((m) => m.type === 'rtc:answer');
	assert.equal(answers.length, 0);
	assert.ok(
		logs.some((m) => /first offer aborted: session changed after createAnswer/.test(m)),
		`expected createAnswer abort log, got: ${JSON.stringify(logs)}`,
	);
});

test('WebRtcPeer: 首次 offer setLocalDescription 后 session 被替换 → 身份重核静默 abort', async () => {
	const sent = [];
	const logs = [];
	const PC = MockPCFactory();
	const ctrl = makeControllablePc();
	let used = false;
	const PCFactory = function (opts) {
		if (!used) {
			used = true;
			ctrl.__constructorArgs = opts;
			PC.instances.push(ctrl);
			return ctrl;
		}
		return PC(opts);
	};
	PCFactory.instances = PC.instances;
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {}, debug: () => {} },
		PeerConnection: PCFactory,
		impl: 'pion',
	});

	const pFirst = peer.handleSignaling(makeOffer('c_fo03'));
	await flushAsync();
	ctrl.__release('setRemoteDescription');
	await flushAsync();
	ctrl.__release('createAnswer');
	await flushAsync();

	// 外部 close 在 setLocalDescription 前删 session
	await peer.handleSignaling({ type: 'rtc:closed', fromConnId: 'c_fo03' });
	ctrl.__release('setLocalDescription');
	await pFirst;

	const answers = sent.filter((m) => m.type === 'rtc:answer');
	assert.equal(answers.length, 0);
	assert.ok(
		logs.some((m) => /first offer aborted: session changed after setLocalDescription/.test(m)),
		`expected setLocalDescription abort log, got: ${JSON.stringify(logs)}`,
	);
});

test('WebRtcPeer: 首次 offer 中抛错且 session 已被替换 → catch 身份重核 suppress（不抛到上游）', async () => {
	const sent = [];
	const logs = [];
	const PC = MockPCFactory();
	const ctrl = makeControllablePc();
	// 让 setRemoteDescription 在 gate 释放时 reject（模拟外部 close 期间 pion 抛 "PC closed"）
	ctrl.setRemoteDescription = async () => {
		await new Promise((resolve) => ctrl.__gates.setRemoteDescription.push(resolve));
		throw new Error('PC has been closed');
	};
	let used = false;
	const PCFactory = function (opts) {
		if (!used) {
			used = true;
			ctrl.__constructorArgs = opts;
			PC.instances.push(ctrl);
			return ctrl;
		}
		return PC(opts);
	};
	PCFactory.instances = PC.instances;
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {}, debug: () => {} },
		PeerConnection: PCFactory,
		impl: 'pion',
	});

	const pFirst = peer.handleSignaling(makeOffer('c_fo04'));
	await flushAsync();

	// 外部 close 删 session（在 setRemoteDescription 抛错前）
	await peer.handleSignaling({ type: 'rtc:closed', fromConnId: 'c_fo04' });

	// 放行 setRemoteDescription → 它抛 'PC has been closed' → catch 入口身份重核命中 suppress
	ctrl.__release('setRemoteDescription');
	// pFirst 不应 reject —— catch suppress 后正常 resolve
	await pFirst;

	const answers = sent.filter((m) => m.type === 'rtc:answer');
	assert.equal(answers.length, 0, 'catch suppress 也不应发 stale rtc:answer');
	assert.ok(
		logs.some((m) => /first offer error after session change \(suppressed\)/.test(m)),
		`expected first-offer catch suppressed log, got: ${JSON.stringify(logs)}`,
	);
});

test('WebRtcPeer: 非 ICE 重发到现有 session 走 sync gate 五件事原子（旧 session 异步 finalize + 新 session 立即可用）', async () => {
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	// 首次 offer：建 session1
	await peer.handleSignaling(makeOffer('c_replace', 'sdp-1'));
	const session1 = peer.__sessions.get('c_replace');
	assert.ok(session1, 'session1 建好');
	const pc1 = session1.pc;
	let pc1Closed = false;
	const origClose1 = pc1.close.bind(pc1);
	pc1.close = async () => { pc1Closed = true; await origClose1(); };

	sent.length = 0;

	// 同 connId 再发非 ICE offer：sync gate 应同步替换 session 入表，新 session 立刻入锁 SDP
	await peer.handleSignaling(makeOffer('c_replace', 'sdp-2'));

	// 同步段五件事：sessions 表已指向 session2（不是 session1），并已发出 rtc.closed
	const session2 = peer.__sessions.get('c_replace');
	assert.ok(session2, 'session2 已建好');
	assert.notEqual(session2, session1, '应是新 session 实例（不复用 session1）');
	assert.notEqual(session2.offerMutex, session1.offerMutex, '新 session 持新 offerMutex');

	// 旧 pc fire-and-forget 已被 finalize（mock pc.close 同步触发我们的 spy）
	await flushAsync();
	assert.equal(pc1Closed, true, '旧 PC 在 fire-and-forget 内被 close');

	// 新 session SDP 协商完成，对外发了 rtc:answer
	const answers = sent.filter((m) => m.type === 'rtc:answer');
	assert.equal(answers.length, 1, '新 session 发出 rtc:answer');

	// rtc.closed remoteLog 单次（来自 sync gate 五件事；旧 closeByConnId 路径不参与）
	const closedLogs = remoteLogBuffer.filter((e) => /^rtc\.closed conn=c_replace/.test(e.text));
	assert.equal(closedLogs.length, 1, 'rtc.closed 仅一次');

	await peer.closeAll();
});

test('WebRtcPeer: 同步段五件事内 fire-and-forget finalize 内部抛错被 catch 不带垮 sync gate', async () => {
	const PC = MockPCFactory();
	const logs = [];
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: { info: () => {}, warn: (m) => logs.push(m), error: () => {}, debug: () => {} },
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_finalize_fail', 'sdp-1'));
	const session1 = peer.__sessions.get('c_finalize_fail');
	// 让旧 PC 的 close 抛错（模拟 pion-ipc 异常）
	session1.pc.close = async () => { throw new Error('mock pc.close failed'); };

	// 同 connId 重发：sync gate 触发 fire-and-forget，内部抛错应被 catch 转 warn，不影响新 session
	await peer.handleSignaling(makeOffer('c_finalize_fail', 'sdp-2'));
	await flushAsync();

	const session2 = peer.__sessions.get('c_finalize_fail');
	assert.ok(session2, 'session2 仍正常建好');
	assert.notEqual(session2, session1);
	assert.ok(
		logs.some((m) => /background finalize failed/.test(m)),
		`expected background finalize warn log, got: ${JSON.stringify(logs)}`,
	);

	await peer.closeAll();
});

test('WebRtcPeer: closeByConnId 接 expectedSession 传 undefined → no-op（向后兼容不抛）', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	// 不存在的 connId：expectedSession = peer.__sessions.get(...) = undefined
	await peer.closeByConnId('c_nope', peer.__sessions.get('c_nope'));
	// 不应抛错；sessions 表保持空
	assert.equal(peer.__sessions.size, 0);
});

test('WebRtcPeer: closeByConnId expectedSession 不匹配当前表项 → 身份守卫早返回（no-op）', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_guard'));
	const session1 = peer.__sessions.get('c_guard');
	// 同步替换：__sessions 指向另一个对象
	const fakeSession = { pc: createMockPC(), connId: 'c_guard', offerMutex: createMutex() };
	peer.__sessions.set('c_guard', fakeSession);
	// 用 session1（已不在表里）调 closeByConnId → 身份守卫早返回，fakeSession 不动
	await peer.closeByConnId('c_guard', session1);
	assert.equal(peer.__sessions.get('c_guard'), fakeSession, 'fake session 未被误删');
	// 收尾：清理 fakeSession（直接 set 回 session1 走原路径，避免泄漏）
	peer.__sessions.set('c_guard', session1);
	await peer.closeAll();
});

test('WebRtcPeer: fn1 仍持 session1 锁 + 非 ICE fn2 触发 sync gate 替换 → fn1 resume 后身份重核静默 abort（不发 stale rtc:answer）', async () => {
	// 真正高风险场景：fn1 卡在 setRemoteDescription，fn2 同步段五件事替换 session1 入新 session2，
	// fn2 在 session2.offerMutex 上正常完成发 answer。fn1 await resolve 后身份重核命中（sessions.get=session2 !== session1）→ 静默 abort。
	const sent = [];
	const logs = [];
	const PC = MockPCFactory();
	const ctrl = makeControllablePc();
	let used = false;
	const FirstCtrlPC = function (opts) {
		if (!used) {
			used = true;
			ctrl.__constructorArgs = opts;
			PC.instances.push(ctrl);
			return ctrl;
		}
		return PC(opts);
	};
	FirstCtrlPC.instances = PC.instances;
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {}, debug: () => {} },
		PeerConnection: FirstCtrlPC,
		impl: 'pion',
	});

	// fn1 = 首次 offer 进锁，卡在 setRemoteDescription
	const pFn1 = peer.handleSignaling(makeOffer('c_replace_busy', 'sdp-1'));
	await flushAsync();
	const session1 = peer.__sessions.get('c_replace_busy');
	assert.equal(session1.pc, ctrl, 'session1 持 ctrl');
	assert.equal(ctrl.__pending('setRemoteDescription'), 1, 'fn1 卡在 setRemoteDescription gate');

	// fn2 = 同 connId 非 ICE 重发；sync gate 同步段五件事替换 session1 → session2，
	// 然后在 session2.offerMutex 上跑 SDP（session2.pc 是默认 mock，立即 resolve）
	await peer.handleSignaling(makeOffer('c_replace_busy', 'sdp-2'));

	const session2 = peer.__sessions.get('c_replace_busy');
	assert.ok(session2, 'session2 已建好');
	assert.notEqual(session2, session1, '应是新 session');
	assert.notEqual(session2.offerMutex, session1.offerMutex, '新 session 持新 offerMutex');

	// 此时已发出 1 条 rtc:answer（来自 session2）
	assert.equal(sent.filter((m) => m.type === 'rtc:answer').length, 1, 'session2 发出 rtc:answer');

	// 放行 fn1 的 setRemoteDescription → fn1 第一段身份重核 sessions.get=session2 !== session1 → 静默 return
	ctrl.__release('setRemoteDescription');
	await pFn1;
	await flushAsync();

	// fn1 不应发出第二条 rtc:answer
	assert.equal(sent.filter((m) => m.type === 'rtc:answer').length, 1, 'fn1 静默 abort，不发 stale rtc:answer');
	// abort log 印出
	assert.ok(
		logs.some((m) => /first offer aborted: session changed after setRemoteDescription/.test(m)),
		`expected fn1 abort log, got: ${JSON.stringify(logs)}`,
	);

	await peer.closeAll();
});

test('WebRtcPeer: sync gate 非 ICE 替换是真 fire-and-forget（旧 pc.close 阻塞期间不阻塞新 session SDP 完成）', async () => {
	// 强断言"fire-and-forget"语义：把旧 pc.close 卡在 gate 上，验证新 session 已入表且 rtc:answer 已发出，
	// 然后才释放旧 pc.close。若实现意外变成 sequential（await 旧 close 后再建新 session），此前提断言会 fail。
	const sent = [];
	const PC = MockPCFactory();
	// 让首次 offer 用控制可控的 close
	const ctrl1 = createMockPC();
	let pc1CloseResolve;
	const pc1CloseGate = new Promise((resolve) => { pc1CloseResolve = resolve; });
	let pc1Closed = false;
	ctrl1.close = async () => { await pc1CloseGate; pc1Closed = true; ctrl1.connectionState = 'closed'; };
	let used = false;
	const PCFactory = function (opts) {
		if (!used) {
			used = true;
			ctrl1.__constructorArgs = opts;
			PC.instances.push(ctrl1);
			return ctrl1;
		}
		return PC(opts);
	};
	PCFactory.instances = PC.instances;
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PCFactory,
		impl: 'pion',
	});

	await peer.handleSignaling(makeOffer('c_ff', 'sdp-1'));
	const session1 = peer.__sessions.get('c_ff');
	assert.equal(session1.pc, ctrl1);
	sent.length = 0;

	// 同 connId 非 ICE 重发：sync gate 触发 __finalizeSessionAsync(session1).catch(...)，内部 await ctrl1.close 会卡在 gate
	const pSecond = peer.handleSignaling(makeOffer('c_ff', 'sdp-2'));

	// 给 sync gate 的 fn2 跑完 SDP 协商的机会（不依赖旧 close）
	await pSecond;

	// 关键断言：在旧 pc.close 仍被卡住的时候，新 session 已入表 + 已发 rtc:answer + sessions 表只指向新 session
	assert.equal(pc1Closed, false, '旧 pc.close 仍阻塞中（fire-and-forget gate 未释放）');
	const session2 = peer.__sessions.get('c_ff');
	assert.ok(session2, '新 session 已入表');
	assert.notEqual(session2, session1, '是新 session 实例');
	assert.equal(sent.filter((m) => m.type === 'rtc:answer').length, 1, '新 session 已发 rtc:answer');

	// 放行旧 pc.close → fire-and-forget 收尾完成
	pc1CloseResolve();
	await flushAsync();
	assert.equal(pc1Closed, true, '放行 gate 后旧 PC 完成 close');

	await peer.closeAll();
});

// === a145aa6 follow-up: test-only deep-review 专项补强 ===
//
// 本块在 a145aa6 主体重构（offer mutex 聚合进 session + sync gate 五件事原子）已落地后追加，
// 锁住 4 个之前未被断言锁住的真实使用场景，外加 1 条防御性回归保护：
//   1) sync gate 五件事调用顺序（顺序错则旧 handler 误踩新 session）
//   2) __createSession 同步抛错时的恢复路径（旧 session 已收尾、表空、同 connId 重发能正常建）
//   3) sync gate 替换后旧 PC 三类 ICE 回调（icecandidate / gathering / iceConnection）的迟到投递
//      被身份 guard 拦下，不污染新 session
//   4) closeByConnId 身份守卫不匹配时反向断言：fake 表项的 pc.close/handler/timer 完全未动
//   5) failed-TTL 回调即便意外 fire（假设 clearTimeout 退化）也被身份守卫兜底
//   6) MAX_SESSIONS 溢出时 evict 的 closeByConnId 阻塞，新 session 仍立刻入表并发 answer
test('WebRtcPeer: sync gate 五件事调用顺序锁住（detach → clear → delete → finalize-launch → rtc.closed → create）', async () => {
	resetRemoteLog();
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_order'));
	const session1 = peer.__sessions.get('c_order');
	assert.ok(session1);

	// spy 同步段五件事 + remoteLog（rtc.closed）；wrap 后调用原方法，不改变行为
	const calls = [];
	const origDetach = peer.__detachPcHandlers.bind(peer);
	peer.__detachPcHandlers = (s) => { calls.push(`detach:${s === session1 ? 'old' : 'other'}`); return origDetach(s); };
	const origClear = peer.__clearSessionSyncState.bind(peer);
	peer.__clearSessionSyncState = (s) => { calls.push(`clear:${s === session1 ? 'old' : 'other'}`); return origClear(s); };
	const origDelete = peer.__sessions.delete.bind(peer.__sessions);
	peer.__sessions.delete = (k) => { calls.push(`delete:${k}`); return origDelete(k); };
	const origFinalize = peer.__finalizeSessionAsync.bind(peer);
	peer.__finalizeSessionAsync = (s) => { calls.push(`finalize-launch:${s === session1 ? 'old' : 'other'}`); return origFinalize(s); };
	const origCreate = peer.__createSession.bind(peer);
	peer.__createSession = (msg, cid) => { calls.push(`create:${cid}`); return origCreate(msg, cid); };
	const origRemoteLog = peer.__remoteLog.bind(peer);
	peer.__remoteLog = (text) => { if (text.startsWith('rtc.closed conn=c_order')) calls.push('remoteLog:rtc.closed'); return origRemoteLog(text); };

	// 同 connId 非 ICE 重发 → 触发 sync gate
	await peer.handleSignaling(makeOffer('c_order', 'sdp-2'));

	const detIdx = calls.indexOf('detach:old');
	const clrIdx = calls.indexOf('clear:old');
	const delIdx = calls.indexOf('delete:c_order');
	const finIdx = calls.indexOf('finalize-launch:old');
	const rlgIdx = calls.indexOf('remoteLog:rtc.closed');
	const crtIdx = calls.indexOf('create:c_order');

	for (const [name, idx] of [['detach', detIdx], ['clear', clrIdx], ['delete', delIdx], ['finalize-launch', finIdx], ['remoteLog', rlgIdx], ['create', crtIdx]]) {
		assert.ok(idx >= 0, `${name} 应被触发；calls=${JSON.stringify(calls)}`);
	}
	// 顺序契约：detach → clear → delete → finalize-launch → rtc.closed remoteLog → create
	// 顺序保证：旧 handler 已摘除后才 fire-and-forget；新 session 入表前已发出 rtc.closed 日志
	assert.ok(detIdx < clrIdx, `detach 应先于 clear: ${JSON.stringify(calls)}`);
	assert.ok(clrIdx < delIdx, `clear 应先于 delete: ${JSON.stringify(calls)}`);
	assert.ok(delIdx < finIdx, `delete 应先于 finalize-launch: ${JSON.stringify(calls)}`);
	assert.ok(finIdx < rlgIdx, `finalize-launch 应先于 rtc.closed remoteLog: ${JSON.stringify(calls)}`);
	assert.ok(rlgIdx < crtIdx, `rtc.closed remoteLog 应先于 create 新 session: ${JSON.stringify(calls)}`);

	await peer.closeAll();
});

test('WebRtcPeer: sync gate 内 __createSession 抛错 → 旧 session 已收尾 + 表空 + 同 connId 重发能正常重建', async () => {
	const sent = [];
	const PC = MockPCFactory();
	// 第二次构造抛错，第三次起恢复正常
	let constructCount = 0;
	const ThrowOnSecondPC = function (opts) {
		constructCount += 1;
		if (constructCount === 2) {
			throw new Error('mock construct failure');
		}
		return PC(opts);
	};
	ThrowOnSecondPC.instances = PC.instances;
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: ThrowOnSecondPC,
		impl: 'pion',
	});

	// 首次 offer 正常建 session1
	await peer.handleSignaling(makeOffer('c_throw'));
	const session1 = peer.__sessions.get('c_throw');
	assert.ok(session1);
	let pc1Closed = false;
	const origClose1 = session1.pc.close.bind(session1.pc);
	session1.pc.close = async () => { pc1Closed = true; await origClose1(); };

	// 同 connId 非 ICE 重发：sync gate 五件事前 4 件正常执行，第 5 件 __createSession 抛错
	await assert.rejects(
		() => peer.handleSignaling(makeOffer('c_throw', 'sdp-2')),
		/mock construct failure/,
		'__createSession 抛错应传播到 handleSignaling 调用方',
	);
	// 让 fire-and-forget finalize 跑完
	await flushAsync();

	// 表里 c_throw 为空（旧 session 已删，新 session 未建成）
	assert.equal(peer.__sessions.has('c_throw'), false, '抛错后表里 c_throw 应为空');
	// 旧 PC 在 fire-and-forget finalize 内已被关闭
	assert.equal(pc1Closed, true, '旧 session 的 pc.close 已通过 fire-and-forget finalize 完成');

	// 同 connId 再发非 ICE offer（第 3 次构造，恢复正常）→ 能重新建 session
	sent.length = 0;
	await peer.handleSignaling(makeOffer('c_throw', 'sdp-3'));
	const session2 = peer.__sessions.get('c_throw');
	assert.ok(session2, '恢复后同 connId 重发应建出 session2');
	assert.notEqual(session2, session1, 'session2 是新实例');
	assert.equal(sent.filter((m) => m.type === 'rtc:answer').length, 1, 'session2 已发 rtc:answer');

	await peer.closeAll();
});

test('WebRtcPeer: sync gate 替换后旧 PC 三类 ICE 回调迟到投递 → 身份 guard 拦下，不污染新 session', async () => {
	resetRemoteLog();
	const sent = [];
	// 默认 createMockPC 不声明 onicegatheringstatechange / oniceconnectionstatechange 属性，
	// 生产代码的 `in pc` 检查（webrtc-peer.js:532, 549）会跳过 wire；这里用扩展 mock 让两者被 wire
	const instances = [];
	const ExtendedPC = function (opts) {
		const pc = createMockPC();
		pc.onicegatheringstatechange = null;
		pc.oniceconnectionstatechange = null;
		pc.iceGatheringState = 'new';
		pc.iceConnectionState = 'new';
		pc.__constructorArgs = opts;
		instances.push(pc);
		return pc;
	};
	ExtendedPC.instances = instances;
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: ExtendedPC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_stale'));
	const session1 = peer.__sessions.get('c_stale');
	const pc1 = session1.pc;
	// 抓取旧 PC 的三类 ICE 回调引用（detach 后属性会被置 null，但闭包仍可调用）
	const staleIceCandidate = pc1.onicecandidate;
	const staleIceGathering = pc1.onicegatheringstatechange;
	const staleIceConn = pc1.oniceconnectionstatechange;
	assert.equal(typeof staleIceCandidate, 'function');
	assert.equal(typeof staleIceGathering, 'function');
	assert.equal(typeof staleIceConn, 'function');

	// 同 connId 非 ICE 重发：sync gate 替换 session1 → session2
	await peer.handleSignaling(makeOffer('c_stale', 'sdp-2'));
	const session2 = peer.__sessions.get('c_stale');
	assert.notEqual(session2, session1);
	// 替换后旧 PC 上属性已被 detach 清空
	assert.equal(pc1.onicecandidate, null);
	assert.equal(pc1.onicegatheringstatechange, null);
	assert.equal(pc1.oniceconnectionstatechange, null);

	// 清空 sent（保留替换流程中的 rtc:answer）以便后续断言"旧回调没追加任何消息"
	const beforeStaleInvoke = sent.length;
	const remoteLogLenBefore = remoteLogBuffer.length;

	// 微任务投递：旧回调被外部 dispatch（例如 IPC 迟到事件）
	staleIceCandidate({ candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
	pc1.iceGatheringState = 'complete';
	staleIceGathering();
	pc1.iceConnectionState = 'connected';
	staleIceConn();

	// 身份 guard 拦下：sent 没新增 rtc:ice；remoteLog 没新增 rtc.iceState / rtc.ice-gathered
	assert.equal(sent.length, beforeStaleInvoke, '旧 onicecandidate 微任务投递应被身份 guard 拦下，不发 rtc:ice');
	assert.equal(
		remoteLogBuffer.slice(remoteLogLenBefore).filter((e) => e.text.startsWith('rtc.iceState') || e.text.startsWith('rtc.ice-gathered')).length,
		0,
		'旧 ICE gathering/connection 回调微任务投递不应产生 remoteLog',
	);

	await peer.closeAll();
});

test('WebRtcPeer: closeByConnId 身份守卫不匹配 → fakeSession 的 pc.close / handlers / timers 完全未动（反向断言）', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_guard2'));
	const session1 = peer.__sessions.get('c_guard2');

	// 构造一个 fake session 顶替表项；带 spy pc.close + 仍 wire 的 handler + 活跃 timer
	const fakePc = createMockPC();
	let fakePcCloseCalled = false;
	fakePc.close = async () => { fakePcCloseCalled = true; fakePc.connectionState = 'closed'; };
	const fakeHandlers = {
		onicecandidate: () => {},
		onconnectionstatechange: () => {},
		ondatachannel: () => {},
		onselectedcandidatepairchange: () => {},
		oniceconnectionstatechange: () => {},
		onicegatheringstatechange: () => {},
	};
	for (const [k, v] of Object.entries(fakeHandlers)) {
		fakePc[k] = v;
	}
	let fakeTimerFired = false;
	const fakeTimer = setTimeout(() => { fakeTimerFired = true; }, 100000);
	const fakeSession = {
		pc: fakePc,
		connId: 'c_guard2',
		offerMutex: createMutex(),
		__failedTimer: fakeTimer,
	};
	peer.__sessions.set('c_guard2', fakeSession);

	// 用 session1（已不在表里）调 closeByConnId → 身份守卫早返回
	await peer.closeByConnId('c_guard2', session1);

	// 反向断言：fakeSession 完全未动
	assert.equal(fakePcCloseCalled, false, 'fakeSession.pc.close 未被调用');
	for (const [k, v] of Object.entries(fakeHandlers)) {
		assert.strictEqual(fakePc[k], v, `fakeSession.pc.${k} 未被置 null`);
	}
	assert.strictEqual(fakeSession.__failedTimer, fakeTimer, 'fakeSession.__failedTimer 未被清空');
	assert.equal(peer.__sessions.get('c_guard2'), fakeSession, '表项仍指向 fakeSession');

	// 清理：移除 fakeSession（先清 timer，避免泄漏），把 session1 放回去走 closeAll 正常路径
	clearTimeout(fakeTimer);
	assert.equal(fakeTimerFired, false, '清理前 timer 应未 fire');
	peer.__sessions.set('c_guard2', session1);
	await peer.closeAll();
});

test('WebRtcPeer: failed-TTL 回调即便意外 fire（假设 clearTimeout 失效）→ 身份守卫兜底，新 session 不被关', async () => {
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	// 拦截 setTimeout，捕获 TTL 回调；clearTimeout 故意不真正清（模拟回归）
	const origSetTimeout = globalThis.setTimeout;
	const origClearTimeout = globalThis.clearTimeout;
	let capturedTtlCb = null;
	globalThis.setTimeout = (cb, ms) => {
		if (ms === FAILED_SESSION_TTL_MS) {
			capturedTtlCb = cb;
			// 返回一个不真正运行的 fake handle；包含 unref 兼容 .unref?.()
			return { unref: () => {}, ref: () => {}, [Symbol.toPrimitive]: () => 0 };
		}
		return origSetTimeout(cb, ms);
	};
	globalThis.clearTimeout = (h) => {
		// 故意：fake handle 不真正清掉 capturedTtlCb，模拟"clearTimeout 失效"
		if (h && typeof h === 'object' && '__failedFake' in h) return;
		return origClearTimeout(h);
	};

	try {
		// 建 session1，触发 failed 进入 TTL 调度
		await peer.handleSignaling(makeOffer('c_ttl'));
		const session1 = peer.__sessions.get('c_ttl');
		const pc1 = session1.pc;
		pc1.connectionState = 'failed';
		pc1.onconnectionstatechange();
		assert.ok(capturedTtlCb, 'TTL 回调应被捕获');

		// 同 connId 非 ICE 重发：sync gate 替换 session1 → session2
		// （内部 __clearSessionSyncState 调 clearTimeout，但我们拦截使其不真正清）
		await peer.handleSignaling(makeOffer('c_ttl', 'sdp-2'));
		const session2 = peer.__sessions.get('c_ttl');
		assert.ok(session2);
		assert.notEqual(session2, session1);

		// 手动触发已捕获的 TTL 回调（cur 闭包持 session1 引用，已 stale）
		capturedTtlCb();
		await flushAsync();

		// 身份守卫兜底：closeByConnId(connId, session1) → sessions.get=session2 !== session1 → no-op
		assert.equal(peer.__sessions.get('c_ttl'), session2, '新 session 应仍在表中');
		assert.equal(session2.pc.connectionState !== 'closed', true, '新 session.pc 未被误关');
	} finally {
		globalThis.setTimeout = origSetTimeout;
		globalThis.clearTimeout = origClearTimeout;
	}

	await peer.closeAll();
});

test('WebRtcPeer: MAX_SESSIONS 溢出时 evict 的 closeByConnId 阻塞 → 新 session 仍立刻入表并发 rtc:answer', async () => {
	resetRemoteLog();
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	// 填满 MAX_SESSIONS 个 session
	for (let i = 0; i < MAX_SESSIONS; i++) {
		await peer.handleSignaling(makeOffer(`c_evblk${String(i).padStart(2, '0')}`));
	}
	assert.equal(peer.__sessions.size, MAX_SESSIONS);

	// 第 0 个进入 failed 状态（将被淘汰），把其 pc.close 卡在 gate 上
	const pc0 = PC.instances[0];
	pc0.connectionState = 'failed';
	pc0.onconnectionstatechange();
	let pc0CloseResolve;
	const pc0CloseGate = new Promise((resolve) => { pc0CloseResolve = resolve; });
	let pc0Closed = false;
	pc0.close = async () => { await pc0CloseGate; pc0Closed = true; pc0.connectionState = 'closed'; };

	sent.length = 0;
	// 新 offer：sync gate 触发 evict → closeByConnId(c_evblk00, session0) fire-and-forget；
	// finalize 内 pc0.close 阻塞，但 sync gate 同步段已删 session0 → 立即 __createSession 新 session
	await peer.handleSignaling(makeOffer('c_evblk_new'));

	// 关键断言：旧 pc.close 还卡住，但新 session 已入表 + 已发 rtc:answer
	assert.equal(pc0Closed, false, '旧 PC 的 close 仍被 gate 阻塞');
	assert.ok(peer.__sessions.has('c_evblk_new'), '新 session 已立即入表');
	assert.equal(peer.__sessions.has('c_evblk00'), false, '被淘汰的 session 已从表中删除（evict 同步段完成）');
	assert.equal(sent.filter((m) => m.type === 'rtc:answer' && m.toConnId === 'c_evblk_new').length, 1, '新 session 已发 rtc:answer');

	// 放行旧 pc.close → fire-and-forget 收尾完成
	pc0CloseResolve();
	await flushAsync();
	assert.equal(pc0Closed, true, '放行 gate 后旧 PC 完成 close');

	await peer.closeAll();
});

// --- a145aa6 follow-up 第 9 项 pin 测试 ---
// closeAll 用 while-loop drain 结构性消除"快照漏掉新 session"竞态：每轮快照表内当前所有
// session 并发关，表非空就再来一轮。下面两条测试钉死：
//   (a) closeByConnId 的同步段（detach + clear + delete）真在第一个 await 之前完成
//   (b) closeAll 首轮 await 期间另一条路径建立的新 session，会被下一轮 drain 关掉

test('WebRtcPeer: closeByConnId 同步段（detach + clear + delete）在第一个 await 之前完成', async () => {
	// 把 sessionA 的 pc.close 卡在 gate 上 → closeAll 同步段跑完后 await __finalizeSessionAsync 卡住。
	// 调用 closeAll 返回 Promise 后**立即**（不 await flushAsync）断言 sessions.delete 已完成——
	// 这才能精确钉住"删除发生在同步段"。若未来有人把 sessions.delete 移到 await 之后，
	// 这条 assert 会红，明确指向"同步段删除契约被破坏"。
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_sync_del'));
	const sessionA = peer.__sessions.get('c_sync_del');

	let releaseClose;
	const closeGate = new Promise((resolve) => { releaseClose = resolve; });
	sessionA.pc.close = async () => { await closeGate; };

	const closeAllPromise = peer.closeAll();
	// 关键：不 await 任何东西，立刻断言。
	// closeAll() 调用进入同步函数体：__sessions.size > 0 → snapshot → map → 每个 closeByConnId
	// 同步执行到第一个 await（__finalizeSessionAsync 内的 pc.close）才让出 → 此时同步段已完成
	assert.equal(peer.__sessions.has('c_sync_del'), false, '同步段已 delete sessionA（无须等微任务）');
	// pc.handler 也已 detach
	assert.equal(sessionA.pc.onconnectionstatechange, null, '同步段已 detach onconnectionstatechange');
	assert.equal(sessionA.pc.onicecandidate, null, '同步段已 detach onicecandidate');

	releaseClose();
	await closeAllPromise;
});

test('WebRtcPeer: closeAll while-drain 把"首轮 await 期间落地的新 session"也关掉，兜底链路验证：sessionB 失败时 __failedTimer 启动', async () => {
	// 钉死 while-drain 契约（替代旧的"快照漏掉、靠 12h TTL 兜底"语义）：
	// (a) closeAll 首轮 await 期间另一条 handleSignaling 建好的 sessionB，被第二轮 drain 关掉
	// (b) 触发 sessionB.connectionState='failed'，断言 __failedTimer 实际被启动（兜底链路活的硬证）
	resetRemoteLog();
	const sent = [];
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: (msg) => sent.push(msg),
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});

	// 建 sessionA
	await peer.handleSignaling(makeOffer('c_drain_a'));
	const sessionA = peer.__sessions.get('c_drain_a');
	assert.ok(sessionA);

	// 卡住 sessionA 的 pc.close → 让 closeAll 首轮 Promise.all 停在 await 阶段
	let releaseAClose;
	const aCloseGate = new Promise((resolve) => { releaseAClose = resolve; });
	let pcAClosed = false;
	sessionA.pc.close = async () => { await aCloseGate; pcAClosed = true; };

	// 启动 closeAll（不 await）—— 首轮同步段对 sessionA detach + delete + 进入 finalize 卡 gate
	const closeAllPromise = peer.closeAll();
	await flushAsync();
	assert.equal(peer.__sessions.has('c_drain_a'), false, 'sessionA 同步段后已删');
	assert.equal(pcAClosed, false, 'sessionA 的 pc.close 仍卡在 gate（closeAll 卡在首轮 Promise.all）');

	// 并发：落地 sessionB（模拟 message handler 已过 sock guard 落地的新 offer）
	await peer.handleSignaling(makeOffer('c_drain_b'));
	const sessionB = peer.__sessions.get('c_drain_b');
	assert.ok(sessionB, 'sessionB 已入表（closeAll 首轮 await 期间）');

	// 兜底链路硬证：触发前先证明 __failedTimer 尚未设置（防"预置非 null 值"被 truthy 检查误满足）；
	// 再触发 connectionState='failed' → 断言 __failedTimer 被启动（仅断言 handler 是 function 太弱，
	// 空 handler 也能过；触发后看 timer 才证明 TTL 兜底链路活）。
	assert.equal(sessionB.__failedTimer ?? null, null, 'sessionB 触发 failed 之前 __failedTimer 应未设置');
	sessionB.pc.connectionState = 'failed';
	sessionB.pc.onconnectionstatechange();
	assert.ok(sessionB.__failedTimer, 'sessionB 进入 failed 时 __failedTimer 被启动（兜底链路活）');

	// 放行 sessionA → 首轮 Promise.all 完成 → while-loop 第二轮再扫，把 sessionB 也关掉
	releaseAClose();
	await closeAllPromise;
	assert.equal(pcAClosed, true, 'sessionA 已收尾');

	// 关键断言：sessionB 也被第二轮 drain 关闭（不再"残留 + 等 12h TTL"）
	assert.equal(peer.__sessions.has('c_drain_b'), false, 'sessionB 被 while-drain 的第二轮关闭');
	// drain 清理过程中应已 detach + clear timer，__failedTimer 在 __clearSessionSyncState 内被清掉
	assert.equal(sessionB.__failedTimer, null, 'sessionB 的 __failedTimer 已被清（同步段 clear）');
});

test('WebRtcPeer: rtc:closed 路径下 closeByConnId 抛错冒到 handleSignaling 调用方（不被同函数吞，让 realtime-bridge outer catch 拿到 type=rtc:closed）', async () => {
	// 钉死"rtc:closed 抛错上抛"契约：handleSignaling 内裸 await，错误必须冒到调用方。
	// outer realtime-bridge.js 的 try/catch 会接住并打 type=rtc:closed conn=... msg=... 日志和 remoteLog。
	// 若未来在 rtc:closed 分支内被人误加静默 catch / swallow，这条测试会红。
	const PC = MockPCFactory();
	const peer = new WebRtcPeer({
		onSend: () => {},
		logger: silentLogger(),
		PeerConnection: PC,
		impl: 'pion',
	});
	await peer.handleSignaling(makeOffer('c_close_throw'));
	const session = peer.__sessions.get('c_close_throw');
	session.pc.close = async () => { throw new Error('mock pc.close failed'); };

	await assert.rejects(
		peer.handleSignaling({ type: 'rtc:closed', fromConnId: 'c_close_throw' }),
		/mock pc\.close failed/,
		'handleSignaling 把 closeByConnId 抛的错继续上抛（outer realtime-bridge 兜底）',
	);
});
