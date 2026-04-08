import { Router } from 'express';

import { createClaimCode, claimClaw } from '../services/claw-binding.svc.js';
import {
	registerClaimWait,
	cancelClaimWait,
	waitClaimResult,
	markClaimBound,
} from '../claim-wait-hub.js';
import { sendToUser } from '../claw-status-sse.js';

export const clawRouter = Router();

function requireSession(req, res) {
	if (req.isAuthenticated?.() && req.user) {
		return true;
	}
	res.status(401).json({
		code: 'UNAUTHORIZED',
		message: 'Unauthorized',
	});
	return false;
}

// POST /api/v1/claws/claim-codes — 公开，Plugin(gateway) 调用
export async function createClaimCodeHandler(req, res, next, deps = {}) {
	const { createClaimCodeImpl = createClaimCode, registerClaimWaitImpl = registerClaimWait } = deps;

	try {
		const result = await createClaimCodeImpl();
		if (!result.ok) {
			res.status(500).json({
				code: result.code,
				message: result.message,
			});
			return;
		}

		const waitToken = registerClaimWaitImpl({
			code: result.code,
			expiresAt: result.expiresAt,
		});
		res.status(201).json({
			code: result.code,
			expiresAt: result.expiresAt,
			waitToken,
		});
	}
	catch (err) {
		next(err);
	}
}

// POST /api/v1/claws/claim-codes/wait — 公开，Plugin(gateway) 长轮询
export async function waitClaimCodeHandler(req, res, next, deps = {}) {
	const {
		cancelClaimWaitImpl = cancelClaimWait,
		waitClaimResultImpl = waitClaimResult,
	} = deps;

	const code = String(req.body?.code ?? '').trim();
	const waitToken = String(req.body?.waitToken ?? '').trim();
	if (!code || !waitToken) {
		res.status(400).json({
			code: 'INVALID_INPUT',
			message: 'code and waitToken are required',
		});
		return;
	}

	try {
		let aborted = false;
		res.on('close', () => {
			if (!res.writableFinished) {
				aborted = true;
				cancelClaimWaitImpl({ code, waitToken });
			}
		});

		const result = await waitClaimResultImpl({ code, waitToken });

		if (aborted || res.writableEnded) return;

		if (result.status === 'INVALID') {
			res.status(404).json({
				code: 'CLAIM_NOT_FOUND',
				message: 'Claim code not found',
			});
			return;
		}

		if (result.status === 'TIMEOUT') {
			res.status(408).json({
				code: 'CLAIM_TIMEOUT',
				message: 'Claim code expired',
			});
			return;
		}

		if (result.status === 'BOUND') {
			res.status(200).json({
				botId: result.botId,
				clawId: result.botId,
				token: result.token,
			});
			return;
		}

		res.status(200).json({
			code: 'CLAIM_PENDING',
		});
	}
	catch (err) {
		next(err);
	}
}

// POST /api/v1/claws/claim — Session 认证，用户 App 调用
export async function claimHandler(req, res, next, deps = {}) {
	if (!requireSession(req, res)) {
		return;
	}

	const { claimClawImpl = claimClaw, markClaimBoundImpl = markClaimBound, sendToUserImpl = sendToUser } = deps;

	const code = String(req.body?.code ?? '').trim();
	if (!code) {
		res.status(400).json({
			code: 'INVALID_INPUT',
			message: 'code is required',
		});
		return;
	}

	try {
		const result = await claimClawImpl({ code, userId: req.user.id });

		if (!result.ok) {
			const statusMap = {
				INVALID_INPUT: 400,
				CLAIM_CODE_INVALID: 404,
				CLAIM_CODE_EXPIRED: 410,
			};
			const status = statusMap[result.code] ?? 400;
			res.status(status).json({
				code: result.code,
				message: result.message,
			});
			return;
		}

		res.status(200).json({
			botId: result.botId.toString(),
			clawId: result.botId.toString(),
			botName: result.botName,
			clawName: result.botName,
		});

		// best-effort：通知用户 SSE（与 bindClawHandler 行为对齐）
		try {
			const clawObj = { id: result.botId.toString(), name: result.botName ?? null };
			sendToUserImpl(String(req.user.id), { event: 'claw.bound', claw: clawObj });
			sendToUserImpl(String(req.user.id), { event: 'bot.bound', bot: clawObj, claw: clawObj });
		} catch {}

		// best-effort：通知 plugin wait hub（独立 try-catch，不受 SSE 失败影响）
		try {
			markClaimBoundImpl({
				code,
				botId: result.botId,
				token: result.token,
			});
		} catch {}

	}
	catch (err) {
		next(err);
	}
}

clawRouter.post('/claim-codes', createClaimCodeHandler);
clawRouter.post('/claim-codes/wait', waitClaimCodeHandler);
clawRouter.post('/claim', claimHandler);
