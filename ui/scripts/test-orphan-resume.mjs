#!/usr/bin/env node
/**
 * 无界面验证脚本：orphan session 续聊（agent 路径）
 *
 * 流程：
 * 1. 登录获取 cookie
 * 2. 获取 clawId + ws ticket
 * 3. 建立 WebSocket
 * 4. 调用 nativeui.sessions.listAll 找到 orphan session（indexed=false）
 * 5. 调用 agent(sessionId) 发送消息
 * 6. 监听 agent 事件，打印全部流
 * 7. lifecycle.end 后 reload 消息验证
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const BASE = 'http://localhost:3000';
const LOGIN_NAME = 'test';
const PASSWORD = '123456';
// 可通过命令行参数指定 sessionId，否则自动选第一个 orphan
const ARG_SESSION_ID = process.argv[2] || '';
const SEND_TEXT = process.argv[3] || '你好，这是 orphan 续聊测试。请简短回复。';
const TIMEOUT = 120_000;

let cookie = '';

// ---- HTTP helpers ----
function request(method, path, body) {
	return new Promise((resolve, reject) => {
		const url = new URL(path, BASE);
		const opts = {
			method,
			hostname: url.hostname,
			port: url.port,
			path: url.pathname + url.search,
			headers: {
				'Content-Type': 'application/json',
				...(cookie ? { Cookie: cookie } : {}),
			},
		};
		const req = http.request(opts, (res) => {
			// 记录 set-cookie
			const sc = res.headers['set-cookie'];
			if (sc) {
				cookie = sc.map((c) => c.split(';')[0]).join('; ');
			}
			let data = '';
			res.on('data', (chunk) => { data += chunk; });
			res.on('end', () => {
				try { resolve(JSON.parse(data)); }
				catch { resolve(data); }
			});
		});
		req.on('error', reject);
		if (body) req.write(JSON.stringify(body));
		req.end();
	});
}

// ---- RPC over WS ----
function createRpcClient(ws) {
	const pending = new Map();
	const eventListeners = new Map();
	let counter = 1;

	ws.addEventListener('message', (event) => {
		let payload;
		try { payload = JSON.parse(String(event.data ?? '')); }
		catch { return; }

		if (payload?.type === 'event' && payload.event) {
			const cbs = eventListeners.get(payload.event);
			if (cbs) {
				for (const cb of cbs) cb(payload.payload);
			}
			return;
		}

		if (payload?.type !== 'res' || !payload.id) return;
		const w = pending.get(payload.id);
		if (!w) return;
		pending.delete(payload.id);
		if (payload.ok === false) {
			const err = new Error(payload?.error?.message ?? 'rpc failed');
			err.code = payload?.error?.code;
			w.reject(err);
			return;
		}
		w.resolve(payload.payload ?? {});
	});

	return {
		request(method, params = {}) {
			const id = `test-${Date.now()}-${counter++}`;
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject });
				ws.send(JSON.stringify({ type: 'req', id, method, params }));
			});
		},
		on(event, cb) {
			const set = eventListeners.get(event) ?? new Set();
			set.add(cb);
			eventListeners.set(event, set);
		},
		off(event, cb) {
			eventListeners.get(event)?.delete(cb);
		},
	};
}

// ---- Main ----
async function main() {
	console.log('=== Orphan Session Resume Test ===\n');

	// 1. 登录
	console.log('[1] 登录...');
	const loginRes = await request('POST', '/api/v1/auth/local/login', {
		loginName: LOGIN_NAME,
		password: PASSWORD,
	});
	console.log('    user:', loginRes?.user?.name ?? loginRes?.user?.id ?? '(failed)');

	// 2. 获取 claws
	console.log('[2] 获取 claws...');
	const clawsRes = await request('GET', '/api/v1/claws');
	const claws = clawsRes?.items ?? [];
	if (!claws.length) {
		console.error('    无可用 claw，退出');
		process.exit(1);
	}
	const claw = claws[0];
	console.log('    claw: %s (%s, online=%s)', claw.name, claw.id, claw.online);

	// 3. 获取 WS ticket
	console.log('[3] 获取 WS ticket...');
	const ticketRes = await request('POST', '/api/v1/claws/ws-ticket', { clawId: claw.id });
	const ticket = ticketRes?.ticket;
	if (!ticket) {
		console.error('    ticket 获取失败:', ticketRes);
		process.exit(1);
	}
	console.log('    ticket: %s', ticket);

	// 4. 连接 WebSocket
	console.log('[4] 连接 WebSocket...');
	const wsUrl = `ws://localhost:3000/api/v1/claws/stream?role=ui&ticket=${ticket}`;
	const ws = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', () => resolve(), { once: true });
		ws.addEventListener('error', (e) => reject(new Error('ws connect failed')), { once: true });
	});
	console.log('    WS 已连接');

	const rpc = createRpcClient(ws);

	// 5. 获取 sessions，确定 orphan
	console.log('[5] 获取 sessions...');
	const listAll = await rpc.request('nativeui.sessions.listAll', {
		agentId: 'main',
		limit: 200,
		cursor: 0,
	});
	const sessions = Array.isArray(listAll?.items) ? listAll.items : [];
	console.log('    total sessions: %d', sessions.length);

	// 打印所有 session 的 indexed 状态
	for (const s of sessions) {
		console.log('    - %s indexed=%s key=%s title=%s',
			s.sessionId, s.indexed, s.sessionKey ? s.sessionKey.slice(0, 8) + '...' : '(none)', s.title ?? '');
	}

	let targetSessionId = ARG_SESSION_ID;
	if (!targetSessionId) {
		// 自动选第一个 orphan（indexed=false 或无 sessionKey）
		const orphan = sessions.find((s) => !s.indexed || !s.sessionKey);
		if (orphan) {
			targetSessionId = orphan.sessionId;
			console.log('    自动选 orphan: %s', targetSessionId);
		} else {
			console.log('    无 orphan session，选最后一个 session 测试');
			targetSessionId = sessions[sessions.length - 1]?.sessionId;
		}
	}

	if (!targetSessionId) {
		console.error('    无可用 session，退出');
		ws.close();
		process.exit(1);
	}
	console.log('    target sessionId: %s', targetSessionId);

	// 6. 发送 agent 请求
	console.log('\n[6] 发送 agent 请求...');
	console.log('    message: %s', SEND_TEXT);

	const idempotencyKey = randomUUID();
	let streamingText = '';
	let runId = null;
	let done = false;

	const onEvent = (payload) => {
		if (runId && payload?.runId !== runId) {
			console.log('    [skip] runId mismatch: got=%s expect=%s', payload?.runId, runId);
			return;
		}
		const { stream, data } = payload;
		if (stream === 'assistant') {
			streamingText = data?.text ?? streamingText;
			// 只打印前 200 字符避免刷屏
			process.stdout.write(`\r    [assistant] ${streamingText.slice(0, 200).replace(/\n/g, '↵')}...`);
		} else if (stream === 'lifecycle') {
			console.log('\n    [lifecycle] phase=%s', data?.phase, data?.message ? `msg=${data.message}` : '');
			if (data?.phase === 'end' || data?.phase === 'error') {
				done = true;
			}
		} else if (stream === 'tool') {
			console.log('    [tool] phase=%s name=%s', data?.phase, data?.name);
		} else {
			console.log('    [event] stream=%s data:', stream, JSON.stringify(data).slice(0, 200));
		}
	};

	rpc.on('agent', onEvent);

	try {
		const ack = await rpc.request('agent', {
			sessionId: targetSessionId,
			message: SEND_TEXT,
			deliver: false,
			idempotencyKey,
		});
		runId = ack?.runId ?? null;
		console.log('    ACK: runId=%s, full:', runId, JSON.stringify(ack));
	}
	catch (err) {
		console.error('    agent 请求失败:', err.message, err.code);
		ws.close();
		process.exit(1);
	}

	// 7. 等待完成
	console.log('[7] 等待事件流...\n');
	const start = Date.now();
	await new Promise((resolve) => {
		const check = setInterval(() => {
			if (done || Date.now() - start > TIMEOUT) {
				clearInterval(check);
				resolve();
			}
		}, 200);
	});

	rpc.off('agent', onEvent);

	if (!done) {
		console.log('\n    ⚠️  超时 (%ds)，未收到 lifecycle end/error', TIMEOUT / 1000);
	}

	// 8. 验证结果
	console.log('\n[8] 验证结果...');
	console.log('    最终 streamingText 长度: %d', streamingText.length);
	if (streamingText) {
		console.log('    内容预览:\n---\n%s\n---', streamingText.slice(0, 500));
	}

	// reload messages 验证
	try {
		const result = await rpc.request('nativeui.sessions.get', {
			agentId: 'main',
			sessionId: targetSessionId,
			limit: 500,
			cursor: 0,
		});
		const msgs = Array.isArray(result?.messages) ? result.messages : [];
		console.log('    reload 后消息数: %d', msgs.length);
		const lastMsg = msgs[msgs.length - 1];
		if (lastMsg) {
			console.log('    最后一条: type=%s role=%s', lastMsg.type, lastMsg.message?.role);
		}
	}
	catch (err) {
		console.log('    reload 失败:', err.message);
	}

	console.log('\n=== 测试完成 ===');
	ws.close();
	process.exit(done ? 0 : 1);
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
