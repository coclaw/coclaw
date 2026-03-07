#!/usr/bin/env node
/**
 * 验证脚本：indexed session 通过 agent(sessionKey) 发送消息
 *
 * 流程：
 * 1. 登录获取 cookie
 * 2. 获取 botId + ws ticket
 * 3. 建立 WebSocket
 * 4. 调用 nativeui.sessions.listAll 找到 indexed session
 * 5. 调用 agent(sessionKey) 发送消息（非 chat.send）
 * 6. 监听 agent 事件，打印全部流
 * 7. lifecycle.end 后 reload 消息验证
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const BASE = 'http://localhost:3000';
const LOGIN_NAME = 'test';
const PASSWORD = '123456';
// 可通过命令行指定 sessionKey，默认 agent:main:main
const ARG_SESSION_KEY = process.argv[2] || 'agent:main:main';
const SEND_TEXT = process.argv[3] || '你好，这是 agent+sessionKey 验证测试。请简短回复。';
const TIMEOUT = 120_000;

let cookie = '';

// ---- HTTP helpers ----
function request(method, urlPath, body) {
	return new Promise((resolve, reject) => {
		const url = new URL(urlPath, BASE);
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
	console.log('=== Agent + SessionKey Test ===\n');
	console.log('sessionKey: %s', ARG_SESSION_KEY);
	console.log('message:    %s\n', SEND_TEXT);

	// 1. 登录
	console.log('[1] 登录...');
	const loginRes = await request('POST', '/api/v1/auth/local/login', {
		loginName: LOGIN_NAME,
		password: PASSWORD,
	});
	console.log('    user: %s', loginRes?.user?.name ?? loginRes?.user?.id ?? '(failed)');

	// 2. 获取 bots
	console.log('[2] 获取 bots...');
	const botsRes = await request('GET', '/api/v1/bots');
	const bots = botsRes?.items ?? [];
	if (!bots.length) {
		console.error('    无可用 bot，退出');
		process.exit(1);
	}
	const bot = bots[0];
	console.log('    bot: %s (%s, online=%s)', bot.name, bot.id, bot.online);

	// 3. 获取 WS ticket
	console.log('[3] 获取 WS ticket...');
	const ticketRes = await request('POST', '/api/v1/bots/ws-ticket', { botId: bot.id });
	const ticket = ticketRes?.ticket;
	if (!ticket) {
		console.error('    ticket 获取失败:', ticketRes);
		process.exit(1);
	}
	console.log('    ticket: %s', ticket);

	// 4. 连接 WebSocket
	console.log('[4] 连接 WebSocket...');
	const wsUrl = `ws://localhost:3000/api/v1/bots/stream?role=ui&ticket=${ticket}`;
	const ws = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', () => resolve(), { once: true });
		ws.addEventListener('error', () => reject(new Error('ws connect failed')), { once: true });
	});
	console.log('    WS 已连接');

	const rpc = createRpcClient(ws);

	// 5. 获取 sessions，确认 sessionKey 存在
	console.log('[5] 获取 sessions...');
	const listAll = await rpc.request('nativeui.sessions.listAll', {
		agentId: 'main',
		limit: 200,
		cursor: 0,
	});
	const sessions = Array.isArray(listAll?.items) ? listAll.items : [];
	console.log('    total sessions: %d', sessions.length);

	const indexed = sessions.filter((s) => s.indexed && s.sessionKey);
	console.log('    indexed sessions: %d', indexed.length);
	for (const s of indexed) {
		console.log('    - %s key=%s', s.sessionId, s.sessionKey);
	}

	const target = indexed.find((s) => s.sessionKey === ARG_SESSION_KEY);
	if (target) {
		console.log('    ✔ 找到 sessionKey=%s -> sessionId=%s', ARG_SESSION_KEY, target.sessionId);
	} else {
		console.log('    ⚠ 未找到 sessionKey=%s 的 indexed session（agent 方法会自动创建）', ARG_SESSION_KEY);
	}

	// 6. 发送 agent 请求（用 sessionKey 而非 sessionId）
	console.log('\n[6] 发送 agent(sessionKey=%s) 请求...', ARG_SESSION_KEY);

	const idempotencyKey = randomUUID();
	let streamingText = '';
	let runId = null;
	let done = false;
	const steps = [];

	const onEvent = (payload) => {
		if (runId && payload?.runId !== runId) return;
		const { stream, data } = payload;
		if (stream === 'assistant') {
			streamingText = data?.text ?? streamingText;
			process.stdout.write(`\r    [assistant] ${streamingText.slice(0, 200).replace(/\n/g, '↵')}...`);
		} else if (stream === 'lifecycle') {
			console.log('\n    [lifecycle] phase=%s %s', data?.phase, data?.message ? `msg=${data.message}` : '');
			if (data?.phase === 'end' || data?.phase === 'error') {
				done = true;
			}
		} else if (stream === 'tool') {
			steps.push({ phase: data?.phase, name: data?.name });
			console.log('    [tool] phase=%s name=%s', data?.phase, data?.name);
		} else if (stream === 'thinking') {
			process.stdout.write(`\r    [thinking] ${(data?.text ?? '').slice(0, 100).replace(/\n/g, '↵')}...`);
		} else {
			console.log('    [event] stream=%s', stream);
		}
	};

	rpc.on('agent', onEvent);

	try {
		const ack = await rpc.request('agent', {
			sessionKey: ARG_SESSION_KEY,
			message: SEND_TEXT,
			deliver: false,
			idempotencyKey,
		});
		runId = ack?.runId ?? null;
		console.log('    ACK: runId=%s status=%s', runId, ack?.status ?? '(none)');
	}
	catch (err) {
		console.error('    ❌ agent 请求失败: %s (code=%s)', err.message, err.code);
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

	const elapsed = ((Date.now() - start) / 1000).toFixed(1);

	if (!done) {
		console.log('\n    ⚠ 超时 (%ds)，未收到 lifecycle end/error', TIMEOUT / 1000);
	}

	// 8. 验证结果
	console.log('\n[8] 验证结果...');
	console.log('    耗时: %ss', elapsed);
	console.log('    工具调用: %d', steps.length);
	console.log('    streamingText 长度: %d', streamingText.length);
	if (streamingText) {
		console.log('    回复预览:\n---\n%s\n---', streamingText.slice(0, 500));
	}

	// reload 验证 transcript 是否被写入
	if (target) {
		try {
			const result = await rpc.request('nativeui.sessions.get', {
				agentId: 'main',
				sessionId: target.sessionId,
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
			console.log('    reload 失败: %s', err.message);
		}
	}

	console.log('\n=== 测试%s ===', done ? '通过 ✔' : '未完成 ⚠');
	ws.close();
	process.exit(done ? 0 : 1);
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
