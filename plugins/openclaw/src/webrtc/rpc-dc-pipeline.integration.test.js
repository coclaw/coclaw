/**
 * MemoryQueue + RpcDcSender + 消费循环 端到端集成
 *
 * 阶段 1 验证：两个新模块拼装后的行为与原 RpcSendQueue 等同（FIFO、bypassAdmission、close
 * 优雅退出、buildChunks 失败下条仍能跑、destroy 收 done）。webrtc-peer 改造后由其单元测试
 * 进一步覆盖 DC 生命周期联动；本文件仅关心两个新模块的协作。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryQueue } from '../utils/memory-queue.js';
import { RpcDcSender } from './rpc-dc-sender.js';
import { isAgentRunResponse } from './agent-run-response.js';
import { HEADER_SIZE } from './dc-chunking.js';
import { __reset as resetRemoteLog } from '../remote-log.js';

// --- helpers ---

function makeMockDc({ bufferedAmount = 0, readyState = 'open' } = {}) {
	const sent = [];
	const dc = {
		readyState,
		bufferedAmount,
		bufferedAmountLowThreshold: 0,
		send(data) {
			const len = typeof data === 'string'
				? Buffer.byteLength(data, 'utf8')
				: data.length;
			dc.bufferedAmount += len;
			sent.push(data);
		},
	};
	dc.sent = sent;
	return dc;
}

function silentLogger() {
	const warnings = [];
	const infos = [];
	return {
		warnings, infos,
		warn(m) { warnings.push(String(m)); },
		info(m) { infos.push(String(m)); },
		error() {},
	};
}

let globalMsgId = 0;
function nextMsgId() { return ++globalMsgId; }

/**
 * 启动 MemoryQueue + RpcDcSender 协作的消费循环。返回 { queue, sender, dc, consumeLoop }
 */
async function makePipeline({ memBudget, maxMessageSize, bypassAdmission, dcOpts, autoStart = true } = {}) {
	const dc = makeMockDc(dcOpts);
	const logger = silentLogger();
	const queue = new MemoryQueue({
		id: 'pipeline',
		memBudget,
		bypassAdmission,
		logger,
		tag: 'conn=I',
	});
	await queue.init();
	const sender = new RpcDcSender({
		dc,
		maxMessageSize: maxMessageSize ?? 65536,
		getNextMsgId: nextMsgId,
		logger,
		tag: 'conn=I',
	});
	function startConsumer() {
		const loop = (async () => {
			for await (const str of queue) {
				try { await sender.send(str); }
				catch (err) {
					if (err.code === 'SENDER_CLOSED') break;
					logger.warn(`rpc-dc.send-failed code=${err.code} size=${str.length}`);
				}
			}
		})();
		loop.catch(() => {});
		return loop;
	}
	const ctx = { dc, logger, queue, sender, consumeLoop: null, startConsumer };
	if (autoStart) ctx.consumeLoop = startConsumer();
	return ctx;
}

async function flush() {
	for (let i = 0; i < 10; i += 1) {
		await new Promise((r) => setImmediate(r));
	}
}

async function shutdown(p) {
	p.sender.close();
	await p.queue.destroy();
	await p.consumeLoop;
}

// --- 端到端 FIFO ---

test('pipeline: 单消费者按 FIFO 透传到 dc.send', async () => {
	resetRemoteLog();
	const p = await makePipeline();
	await p.queue.enqueue('"a"');
	await p.queue.enqueue('"b"');
	await p.queue.enqueue('"c"');
	await flush();
	assert.deepEqual(p.dc.sent, ['"a"', '"b"', '"c"']);
	await shutdown(p);
});

test('pipeline: 大消息自动分片，FIFO 在 chunk 粒度上保持', async () => {
	resetRemoteLog();
	const p = await makePipeline({ maxMessageSize: 100 });
	const big1 = '"' + 'x'.repeat(498) + '"';
	const big2 = '"' + 'y'.repeat(498) + '"';
	await p.queue.enqueue(big1);
	await p.queue.enqueue(big2);
	await flush();
	// 等待全部发完
	for (let i = 0; i < 20 && p.dc.sent.length < 10; i += 1) await flush();

	// 同消息 chunks msgId 一致；先全部 big1 chunks 再 big2 chunks
	const msgIds = p.dc.sent.map((s) => s.readUInt32BE(1));
	const firstId = msgIds[0];
	let split = msgIds.findIndex((id) => id !== firstId);
	if (split === -1) split = msgIds.length;
	const before = msgIds.slice(0, split);
	const after = msgIds.slice(split);
	assert.ok(before.length > 0 && after.length > 0);
	for (const id of before) assert.equal(id, firstId);
	const secondId = after[0];
	for (const id of after) assert.equal(id, secondId);
	assert.notEqual(firstId, secondId);
	await shutdown(p);
});

// --- bypassAdmission 联动 ---

test('pipeline: 队列满时白名单帧仍能透传（bypassAdmission 注入）', async () => {
	resetRemoteLog();
	// autoStart=false：先把队列灌到饱和再启动消费循环，确保 admission 决策稳定可观察
	const p = await makePipeline({
		memBudget: 100,
		bypassAdmission: isAgentRunResponse,
		dcOpts: { bufferedAmount: 1024 * 1024 }, // 顶满，让 sender 阻塞
		autoStart: false,
	});
	// 占满队列
	await p.queue.enqueue('"' + 'x'.repeat(120) + '"');
	const whitelistFrame = JSON.stringify({
		type: 'res', id: 1, ok: true,
		payload: { runId: 'r-1', status: 'ok' },
	});
	const ok = await p.queue.enqueue(whitelistFrame);
	assert.equal(ok, true);
	const ok2 = await p.queue.enqueue('"non-whitelist"');
	assert.equal(ok2, false);

	// 启动消费循环。dc 已顶满 → sender 阻塞在 BAL；queue 已积 2 条但不会被发出
	p.consumeLoop = p.startConsumer();
	await flush();
	assert.equal(p.dc.sent.length, 0);

	// 放开背压
	p.dc.bufferedAmount = 0;
	p.sender.onBufferedAmountLow();
	for (let i = 0; i < 10 && p.dc.sent.length < 2; i += 1) {
		await flush();
		// onBufferedAmountLow 可能要触发多次，因为每次 dc.send 后 bufferedAmount 又涨上来
		if (p.dc.bufferedAmount >= 1024 * 1024) {
			p.dc.bufferedAmount = 0;
			p.sender.onBufferedAmountLow();
		}
	}
	// 第一条（占满消息）+ 白名单帧均应到达 dc.sent
	assert.ok(p.dc.sent.length >= 2);
	assert.equal(p.dc.sent[1], whitelistFrame);
	await shutdown(p);
});

// --- close + 积压 → 优雅退出 ---

test('pipeline: close sender 时积压未消化 → 消费循环 break，无 unhandled rejection', async () => {
	resetRemoteLog();
	const p = await makePipeline({
		dcOpts: { bufferedAmount: 1024 * 1024 }, // 顶满让 sender 阻塞
	});
	await p.queue.enqueue('"a"');
	await p.queue.enqueue('"b"');
	await p.queue.enqueue('"c"');
	await flush();
	// sender 应阻塞在 BAL 等待
	assert.ok(p.sender.balWaiters.length >= 1);

	// close sender 让阻塞的 send 抛 SENDER_CLOSED → 消费循环 break
	p.sender.close();
	await flush();
	// destroy 队列让 iterator 收到 done
	await p.queue.destroy();
	await p.consumeLoop;
	// dc.sent 不增加（close 时阻塞中）
	assert.equal(p.dc.sent.length, 0);
});

test('pipeline: 仅 destroy queue（sender 不 close）→ 消费循环退出', async () => {
	resetRemoteLog();
	const p = await makePipeline();
	await p.queue.enqueue('"a"');
	await flush();
	// 已发送
	assert.equal(p.dc.sent.length, 1);
	// destroy queue → iterator 立即收到 done → 循环退出
	await p.queue.destroy();
	await p.consumeLoop;
	p.sender.close();
});

// --- buildChunks 失败 ---

test('pipeline: buildChunks 失败下条仍能跑（循环不退出）', async () => {
	resetRemoteLog();
	const p = await makePipeline({ maxMessageSize: HEADER_SIZE });
	// 第一条会触发 buildChunks 失败：JSON 长 > maxMessageSize
	await p.queue.enqueue('"' + 'x'.repeat(100) + '"');
	await flush();
	// 失败 warn 应已打
	assert.ok(p.logger.warnings.some((w) => w.includes('rpc-dc.send-failed code=BUILD_CHUNKS_FAILED')));

	// 把 maxMessageSize 提高让下一条能跑
	p.sender.maxMessageSize = 65536;
	await p.queue.enqueue('"recovered"');
	await flush();
	// recovered 应到 dc.sent
	assert.ok(p.dc.sent.some((s) => s === '"recovered"'));
	await shutdown(p);
});

// --- destroy queue 期间在 BAL 阻塞中的 send 不影响循环退出 ---

test('pipeline: destroy queue 时 sender 仍在 BAL 阻塞 → 等 sender close 后循环干净退出', async () => {
	resetRemoteLog();
	const p = await makePipeline({
		dcOpts: { bufferedAmount: 1024 * 1024 },
	});
	await p.queue.enqueue('"x"');
	await flush();
	assert.ok(p.sender.balWaiters.length >= 1);

	// 先 destroy queue 不会让 sender 阻塞退出（已经从 queue 出列了，处于 sender.send 阻塞中）
	await p.queue.destroy();
	// 此时 consumeLoop 仍在 await sender.send 阻塞
	await flush();
	// 必须 close sender 才能解阻塞
	p.sender.close();
	await p.consumeLoop;
});
