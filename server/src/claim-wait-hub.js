import crypto from 'node:crypto';

// 认领码等待状态（与 binding-wait-hub 对称，无 userId 语义）
const claimStates = new Map();

function nowMs() {
	return Date.now();
}

function getOrCreateState(code) {
	let state = claimStates.get(code);
	if (!state) {
		state = {
			waitToken: '',
			expiresAt: 0,
			status: 'pending', // pending | bound | expired
			boundResult: null,
			waiters: new Set(),
		};
		claimStates.set(code, state);
	}
	return state;
}

function settleState(code, payload) {
	const state = claimStates.get(code);
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

export function registerClaimWait({ code, expiresAt }) {
	const state = getOrCreateState(code);
	state.waitToken = crypto.randomBytes(16).toString('hex');
	state.expiresAt = new Date(expiresAt).getTime();
	state.status = 'pending';
	state.boundResult = null;
	state.waiters.clear();

	// 清除旧的 cleanup timer（重复注册场景）
	clearTimeout(state.cleanupTimer);

	// 过期后自动清理，防止内存泄漏（+60s 缓冲，确保末尾轮询已完成）
	const ttlMs = state.expiresAt - Date.now() + 60_000;
	state.cleanupTimer = setTimeout(() => claimStates.delete(code), Math.max(ttlMs, 0));
	state.cleanupTimer.unref();

	return state.waitToken;
}

export function markClaimBound({ code, botId, token }) {
	const state = claimStates.get(code);
	if (!state || state.status !== 'pending') {
		return;
	}
	state.status = 'bound';
	state.boundResult = {
		botId: String(botId),
		token,
	};
	settleState(code, {
		status: 'BOUND',
		botId: state.boundResult.botId,
		token,
	});

	// 已完成的条目延迟清理（60s 缓冲，让迟到的 waiter 仍能获取结果）
	clearTimeout(state.cleanupTimer);
	state.cleanupTimer = setTimeout(() => claimStates.delete(code), 60_000);
	state.cleanupTimer.unref();
}

// 仅提前 settle 当前 waiters，不改 status，不影响后续 markClaimBound。
// 与 binding-wait-hub.cancelBindingWait 不同：后者会设 status='cancelled'，
// 因为 binding 的 cancel(UI 端) 和 markBound(plugin 端) 由不同发起方调用，互不干扰。
// 而 claim 的 cancel(plugin 断连) 和 markBound(用户 claim) 共享同一 state，
// 改 status 会阻断 markClaimBound → 导致 enroll 流程卡死。
export function cancelClaimWait({ code, waitToken }) {
	const state = claimStates.get(code);
	if (!state || state.waitToken !== waitToken) {
		return false;
	}
	if (state.status !== 'pending') {
		return false;
	}
	settleState(code, { status: 'CANCELLED' });
	return true;
}

export function waitClaimResult({ code, waitToken }) {
	const state = claimStates.get(code);
	if (!state || state.waitToken !== waitToken) {
		return Promise.resolve({ status: 'INVALID' });
	}

	if (state.status === 'bound') {
		return Promise.resolve({
			status: 'BOUND',
			botId: state.boundResult.botId,
			token: state.boundResult.token,
		});
	}

	if (state.expiresAt <= nowMs()) {
		state.status = 'expired';
		return Promise.resolve({ status: 'TIMEOUT' });
	}

	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			state.waiters.delete(onDone);
			if (state.status === 'bound') {
				resolve({
					status: 'BOUND',
					botId: state.boundResult.botId,
					token: state.boundResult.token,
				});
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
