import crypto from 'node:crypto';

const bindingStates = new Map();

function nowMs() {
	return Date.now();
}

function getOrCreateState(code) {
	let state = bindingStates.get(code);
	if (!state) {
		state = {
			waitToken: '',
			userId: '',
			expiresAt: 0,
			status: 'pending', // pending | bound | cancelled | expired
			boundBot: null,
			waiters: new Set(),
		};
		bindingStates.set(code, state);
	}
	return state;
}

function settleState(code, payload) {
	const state = bindingStates.get(code);
	if (!state) {
		return;
	}
	for (const waiter of state.waiters) {
		try {
			waiter(payload);
		}
		catch {}
	}
	state.waiters.clear();
}

export function registerBindingWait({ code, userId, expiresAt }) {
	const state = getOrCreateState(code);
	state.waitToken = crypto.randomBytes(16).toString('hex');
	state.userId = String(userId);
	state.expiresAt = new Date(expiresAt).getTime();
	state.status = 'pending';
	state.boundBot = null;
	state.waiters.clear();

	// 清除旧的 cleanup timer（重复注册场景）
	clearTimeout(state.cleanupTimer);

	// 过期后自动清理，防止内存泄漏（+60s 缓冲，确保末尾轮询已完成）
	const ttlMs = state.expiresAt - Date.now() + 60_000;
	state.cleanupTimer = setTimeout(() => bindingStates.delete(code), Math.max(ttlMs, 0));

	return state.waitToken;
}

export function markBindingBound({ code, botId, botName }) {
	const state = bindingStates.get(code);
	if (!state || state.status !== 'pending') {
		return;
	}
	state.status = 'bound';
	state.boundBot = {
		id: String(botId),
		name: botName ?? null,
	};
	settleState(code, {
		status: 'BOUND',
		bot: state.boundBot,
	});

	// 已完成的条目延迟清理（60s 缓冲，让迟到的 waiter 仍能获取结果）
	clearTimeout(state.cleanupTimer);
	state.cleanupTimer = setTimeout(() => bindingStates.delete(code), 60_000);
}

export function waitBindingResult({ code, waitToken, userId }) {
	const state = bindingStates.get(code);
	if (!state || state.waitToken !== waitToken || state.userId !== String(userId)) {
		return Promise.resolve({ status: 'INVALID' });
	}

	if (state.status === 'bound') {
		return Promise.resolve({ status: 'BOUND', bot: state.boundBot });
	}

	if (state.status === 'cancelled') {
		return Promise.resolve({ status: 'CANCELLED' });
	}

	if (state.expiresAt <= nowMs()) {
		state.status = 'expired';
		return Promise.resolve({ status: 'TIMEOUT' });
	}

	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			state.waiters.delete(onDone);
			if (state.status === 'bound') {
				resolve({ status: 'BOUND', bot: state.boundBot });
				return;
			}
			if (state.expiresAt <= nowMs()) {
				state.status = 'expired';
				resolve({ status: 'TIMEOUT' });
				return;
			}
			resolve({ status: 'PENDING' });
		}, 25_000);

		const onDone = (payload) => {
			clearTimeout(timeout);
			resolve(payload);
		};

		state.waiters.add(onDone);
	});
}

export function cancelBindingWait({ code, waitToken, userId }) {
	const state = bindingStates.get(code);
	if (!state || state.waitToken !== waitToken || state.userId !== String(userId)) {
		return false;
	}
	if (state.status !== 'pending') {
		return false;
	}
	state.status = 'cancelled';
	settleState(code, { status: 'CANCELLED' });

	// 已取消的条目延迟清理
	clearTimeout(state.cleanupTimer);
	state.cleanupTimer = setTimeout(() => bindingStates.delete(code), 60_000);

	return true;
}
