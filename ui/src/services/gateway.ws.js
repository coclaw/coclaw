import { createBotWsTicket } from './bots.api.js';

function resolveApiBaseUrl() {
	const configured = String(import.meta.env.VITE_API_BASE_URL ?? '').trim();
	if (configured) {
		return configured;
	}
	if (typeof window !== 'undefined' && window.location?.origin) {
		return window.location.origin;
	}
	return 'http://localhost:3000';
}

function toWsBaseUrl(httpBaseUrl) {
	const url = new URL(httpBaseUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = '/api/v1/bots/stream';
	return url;
}

export async function createGatewayRpcClient(options = {}) {
	const { botId } = options;
	const { ticket } = await createBotWsTicket(botId);
	if (!ticket) {
		throw new Error('ws ticket missing');
	}

	const wsUrl = toWsBaseUrl(resolveApiBaseUrl());
	wsUrl.searchParams.set('role', 'ui');
	wsUrl.searchParams.set('ticket', ticket);

	const ws = new WebSocket(wsUrl.toString());
	const pending = new Map();
	const eventListeners = new Map();
	let counter = 1;

	// agent 两阶段响应的终态 status 值
	const TERMINAL_STATUSES = new Set(['ok', 'error']);

	ws.addEventListener('message', (event) => {
		let payload = null;
		try {
			payload = JSON.parse(String(event.data ?? '{}'));
		}
		catch (parseErr) {
			console.warn('[gw-ws] JSON parse failed:', parseErr);
			return;
		}

		// 事件消息分支
		if (payload?.type === 'event' && payload.event) {
			const cbs = eventListeners.get(payload.event);
			console.debug('[gw-ws] event=%s, listeners=%d, payload:', payload.event, cbs?.size ?? 0, payload.payload);
			if (cbs) {
				for (const cb of cbs) cb(payload.payload);
			}
			return;
		}

		if (payload?.type !== 'res' || !payload.id) {
			console.debug('[gw-ws] ignored frame type=%s', payload?.type, payload);
			return;
		}
		const waiter = pending.get(payload.id);
		if (!waiter) {
			return;
		}

		// 任何阶段 ok === false 都立即 reject
		if (payload.ok === false) {
			pending.delete(payload.id);
			const err = new Error(payload?.error?.message ?? 'rpc failed');
			err.code = payload?.error?.code ?? 'RPC_FAILED';
			waiter.reject(err);
			return;
		}

		const status = payload.payload?.status;

		// 两阶段模式：已知中间态 accepted -> 调用回调，保留 waiter
		if (waiter.onAccepted && status === 'accepted') {
			console.debug('[gw-ws] res accepted id=%s', payload.id, payload.payload);
			waiter.onAccepted(payload.payload);
			return;
		}

		// 非两阶段模式（无 onAccepted）：任何 ok=true 响应直接 resolve
		if (!waiter.onAccepted) {
			pending.delete(payload.id);
			waiter.resolve(payload.payload ?? {});
			return;
		}

		// 两阶段模式：终态 -> resolve/reject 并移除 waiter
		if (TERMINAL_STATUSES.has(status)) {
			pending.delete(payload.id);
			waiter.resolve(payload.payload ?? {});
			return;
		}

		// 两阶段模式：未知中间态 -> log + notify，保留 waiter
		console.error('[gw-ws] unknown intermediate status=%s id=%s payload:', status, payload.id, payload.payload);
		if (waiter.onUnknownStatus) {
			waiter.onUnknownStatus(status, payload.payload);
		}
	});

	ws.addEventListener('close', (ev) => {
		console.debug('[gw-ws] closed code=%d reason=%s pending=%d', ev.code, ev.reason, pending.size);
		for (const waiter of pending.values()) {
			const err = new Error('gateway ws closed');
			err.code = 'WS_CLOSED';
			waiter.reject(err);
		}
		pending.clear();
	});

	await new Promise((resolve, reject) => {
		const onOpen = () => {
			ws.removeEventListener('error', onError);
			console.log('[gw-ws] connected url=%s', wsUrl.toString());
			resolve();
		};
		const onError = () => {
			ws.removeEventListener('open', onOpen);
			console.warn('[gw-ws] connect failed url=%s', wsUrl.toString());
			reject(new Error('gateway ws connect failed'));
		};
		ws.addEventListener('open', onOpen, { once: true });
		ws.addEventListener('error', onError, { once: true });
	});

	return {
		/**
		 * @param {string} method
		 * @param {object} params
		 * @param {object} [options]
		 * @param {(payload: object) => void} [options.onAccepted] - 两阶段模式：收到 status=accepted 时回调，Promise 继续等终态
		 * @param {(status: string, payload: object) => void} [options.onUnknownStatus] - 收到未知中间态时回调
		 */
		request(method, params = {}, options = {}) {
			const id = `ui-${Date.now()}-${counter++}`;
			console.debug('[gw-ws] req id=%s method=%s', id, method, params);
			return new Promise((resolve, reject) => {
				const waiter = { resolve, reject };
				if (options.onAccepted) {
					waiter.onAccepted = options.onAccepted;
				}
				if (options.onUnknownStatus) {
					waiter.onUnknownStatus = options.onUnknownStatus;
				}
				pending.set(id, waiter);
				ws.send(JSON.stringify({
					type: 'req',
					id,
					method,
					params,
				}));
			});
		},
		on(eventName, cb) {
			const set = eventListeners.get(eventName) ?? new Set();
			set.add(cb);
			eventListeners.set(eventName, set);
		},
		off(eventName, cb) {
			eventListeners.get(eventName)?.delete(cb);
		},
		close() {
			ws.close(1000, 'done');
		},
	};
}
