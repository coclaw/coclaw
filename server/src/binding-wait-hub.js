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
	return true;
}
