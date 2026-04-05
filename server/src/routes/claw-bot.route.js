import crypto from 'node:crypto';
import { Router } from 'express';

import {
	bindClaw,
	createBindingCodeForUser,
	unbindClawByToken,
	unbindClawByUser,
} from '../services/claw-binding.svc.js';
import { deleteBindingCode, findBindingCode } from '../repos/claw-binding-code.repo.js';
import { findClawById, findClawByTokenHash, findLatestClawByUserId, listClawsByUserId } from '../repos/claw.repo.js';
import {
	cancelBindingWait,
	markBindingBound,
	registerBindingWait,
	waitBindingResult,
} from '../binding-wait-hub.js';
import { createUiWsTicket, listOnlineClawIds, notifyAndDisconnectClaw, refreshClawName } from '../claw-ws-hub.js';
import { registerSseClient, sendSnapshot, sendToUser } from '../claw-status-sse.js';

export const clawBotRouter = Router();

function parseBearerToken(req) {
	const auth = req.headers.authorization;
	if (typeof auth !== 'string') {
		return null;
	}
	const [scheme, token] = auth.split(' ');
	if (scheme !== 'Bearer' || !token) {
		return null;
	}
	return token;
}

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

/**
 * 列出当前用户绑定的所有 claw。
 * 注：UI 主流程已通过 SSE bot.snapshot 获取列表，此 HTTP 端点作为后备保留。
 */
export async function listClawsHandler(req, res, next, deps = {}) {
	if (!requireSession(req, res)) {
		return;
	}

	const {
		listClawsByUserIdImpl = listClawsByUserId,
		listOnlineClawIdsImpl = listOnlineClawIds,
		refreshClawNameImpl = refreshClawName,
	} = deps;

	try {
		const [claws, onlineClawIds] = await Promise.all([
			listClawsByUserIdImpl(req.user.id),
			Promise.resolve(listOnlineClawIdsImpl()),
		]);

		const refreshedNameMap = new Map();
		const onlineClaws = claws.filter((c) => onlineClawIds.has(c.id.toString()));
		const refreshResults = await Promise.allSettled(
			onlineClaws.map(async (c) => {
				const latestName = await refreshClawNameImpl(c.id, { timeoutMs: 1000 });
				if (latestName !== undefined) {
					refreshedNameMap.set(c.id.toString(), latestName);
				}
			}),
		);
		for (const result of refreshResults) {
			if (result.status === 'rejected') {
				// noop: best-effort refresh only
			}
		}

		res.status(200).json({
			items: claws.map((c) => {
				const clawId = c.id.toString();
				const name = refreshedNameMap.has(clawId)
					? refreshedNameMap.get(clawId)
					: c.name;
				return {
					id: clawId,
					name,
					online: onlineClawIds.has(clawId),
					lastSeenAt: c.lastSeenAt,
					createdAt: c.createdAt,
					updatedAt: c.updatedAt,
				};
			}),
		});
	}
	catch (err) {
		next(err);
	}
}

export async function createBindingCodeHandler(req, res, next, deps = {}) {
	if (!requireSession(req, res)) {
		return;
	}

	const {
		createBindingCodeForUserImpl = createBindingCodeForUser,
		registerBindingWaitImpl = registerBindingWait,
	} = deps;

	try {
		const result = await createBindingCodeForUserImpl({
			userId: req.user.id,
		});

		if (!result.ok) {
			res.status(500).json({
				code: result.code,
				message: result.message,
			});
			return;
		}

		const waitToken = registerBindingWaitImpl({
			code: result.code,
			userId: req.user.id,
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

export async function bindClawHandler(req, res, next, deps = {}) {
	const {
		bindClawImpl = bindClaw,
		markBindingBoundImpl = markBindingBound,
		notifyAndDisconnectClawImpl = notifyAndDisconnectClaw,
	} = deps;
	try {
		const result = await bindClawImpl({
			code: req.body?.code,
			name: req.body?.name,
		});

		if (!result.ok) {
			const status = result.code === 'INVALID_INPUT'
				? 400
				: 401;
			console.warn(`[coclaw/api] bind failed code=${result.code} message=${result.message}`);
			res.status(status).json({
				code: result.code,
				message: result.message,
			});
			return;
		}

		if (result.rebound) {
			console.info(`[coclaw/api] bind rebound botId=${result.botId.toString()} userId=${result.userId} -> revoke old connection`);
			notifyAndDisconnectClawImpl(result.botId, 'token_revoked');
		}
		const boundClawName = result.botName ?? null;
		markBindingBoundImpl({
			code: result.bindingCode,
			clawId: result.botId,
			clawName: boundClawName,
		});

		console.info(`[coclaw/api] bind success botId=${result.botId.toString()} userId=${result.userId} rebound=${Boolean(result.rebound)}`);
		const clawObj = {
			id: result.botId.toString(),
			name: boundClawName,
		};
		sendToUser(String(result.userId), {
			event: 'claw.bound',
			claw: clawObj,
		});
		sendToUser(String(result.userId), {
			event: 'bot.bound',
			bot: clawObj,
			claw: clawObj,
		});
		res.status(200).json({
			botId: result.botId.toString(),
			clawId: result.botId.toString(),
			token: result.token,
			rebound: result.rebound,
			bot: {
				id: result.botId.toString(),
				name: boundClawName ?? null,
			},
			claw: {
				id: result.botId.toString(),
				name: boundClawName ?? null,
			},
		});
	}
	catch (err) {
		next(err);
	}
}

export async function getClawSelfHandler(req, res, next, deps = {}) {
	const { findClawByTokenHashImpl = findClawByTokenHash } = deps;

	const token = parseBearerToken(req);
	if (!token) {
		res.status(401).json({
			code: 'UNAUTHORIZED',
			message: 'Unauthorized',
		});
		return;
	}

	try {
		const tokenHash = crypto
			.createHash('sha256')
			.update(token, 'utf8')
			.digest();
		const claw = await findClawByTokenHashImpl(tokenHash);
		if (!claw) {
			res.status(401).json({
				code: 'UNAUTHORIZED',
				message: 'Invalid token',
			});
			return;
		}

		res.status(200).json({
			botId: claw.id.toString(),
			clawId: claw.id.toString(),
		});
	}
	catch (err) {
		next(err);
	}
}

export async function createUiWsTicketHandler(req, res, next, deps = {}) {
	if (!requireSession(req, res)) {
		return;
	}

	const {
		findClawByIdImpl = findClawById,
		findLatestClawByUserIdImpl = findLatestClawByUserId,
		createUiWsTicketImpl = createUiWsTicket,
	} = deps;

	try {
		const rawBotId = req.body?.botId;
		let claw = null;

		if (rawBotId !== undefined && rawBotId !== null && String(rawBotId).trim() !== '') {
			try {
				claw = await findClawByIdImpl(BigInt(String(rawBotId)));
			}
			catch {
				res.status(400).json({
					code: 'INVALID_INPUT',
					message: 'botId is invalid',
				});
				return;
			}

			if (!claw || claw.userId !== req.user.id) {
				res.status(404).json({
					code: 'BOT_NOT_FOUND',
					message: 'No active bot found',
				});
				return;
			}
		}
		else {
			claw = await findLatestClawByUserIdImpl(req.user.id);
			if (!claw) {
				res.status(404).json({
					code: 'BOT_NOT_FOUND',
					message: 'No active bot found',
				});
				return;
			}
		}

		const ticket = createUiWsTicketImpl({
			clawId: claw.id,
			userId: req.user.id,
		});
		res.status(201).json({
			ticket,
			botId: String(claw.id),
			clawId: String(claw.id),
		});
	}
	catch (err) {
		next(err);
	}
}

export async function waitBindingCodeHandler(req, res, next, deps = {}) {
	if (!requireSession(req, res)) {
		return;
	}

	const {
		cancelBindingWaitImpl = cancelBindingWait,
		waitBindingResultImpl = waitBindingResult,
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

	let aborted = false;
	const onAbort = () => {
		aborted = true;
		cancelBindingWaitImpl({
			code,
			waitToken,
			userId: req.user.id,
		});
	};

	res.on('close', () => {
		if (!res.writableFinished) onAbort();
	});

	try {
		const result = await waitBindingResultImpl({
			code,
			waitToken,
			userId: req.user.id,
		});
		if (aborted) {
			return;
		}

		if (result.status === 'INVALID') {
			res.status(404).json({
				code: 'BINDING_NOT_FOUND',
				message: 'Binding code not found',
			});
			return;
		}

		if (result.status === 'TIMEOUT') {
			res.status(408).json({
				code: 'BINDING_TIMEOUT',
				message: 'Binding code expired',
			});
			return;
		}

		if (result.status === 'BOUND') {
			res.status(200).json({
				code: 'BINDING_SUCCESS',
				bot: result.bot,
				claw: result.bot,
			});
			return;
		}

		res.status(200).json({
			code: 'BINDING_PENDING',
		});
	}
	catch (err) {
		next(err);
	}
}

export async function unbindClawByUserHandler(req, res, next, deps = {}) {
	if (!requireSession(req, res)) {
		return;
	}

	const {
		unbindClawByUserImpl = unbindClawByUser,
		notifyAndDisconnectClawImpl = notifyAndDisconnectClaw,
		sendToUserImpl = sendToUser,
	} = deps;

	try {
		const rawBotId = req.body?.botId;
		if (rawBotId === undefined || rawBotId === null || String(rawBotId).trim() === '') {
			res.status(400).json({
				code: 'INVALID_INPUT',
				message: 'botId is required',
			});
			return;
		}

		let clawId;
		try {
			clawId = BigInt(String(rawBotId));
		}
		catch {
			res.status(400).json({
				code: 'INVALID_INPUT',
				message: 'botId is invalid',
			});
			return;
		}

		const result = await unbindClawByUserImpl({ userId: req.user.id, botId: clawId });
		if (!result.ok) {
			const status = result.code === 'INVALID_INPUT'
				? 400
				: result.code === 'BOT_NOT_FOUND'
					? 404
					: 401;
			res.status(status).json({
				code: result.code,
				message: result.message,
			});
			return;
		}

		console.info(`[coclaw/api] unbind-by-user success botId=${result.botId.toString()} userId=${req.user.id}`);
		notifyAndDisconnectClawImpl(result.botId, 'bot_unbound');
		const unboundClawId = result.botId.toString();
		sendToUserImpl(String(req.user.id), {
			event: 'claw.unbound',
			clawId: unboundClawId,
		});
		sendToUserImpl(String(req.user.id), {
			event: 'bot.unbound',
			botId: unboundClawId,
			clawId: unboundClawId,
		});

		res.status(200).json({
			botId: result.botId.toString(),
			clawId: result.botId.toString(),
			unbound: true,
		});
	}
	catch (err) {
		next(err);
	}
}

export async function unbindClawHandler(req, res, next, deps = {}) {
	const {
		unbindClawByTokenImpl = unbindClawByToken,
		notifyAndDisconnectClawImpl = notifyAndDisconnectClaw,
		sendToUserImpl = sendToUser,
	} = deps;

	const token = parseBearerToken(req);
	if (!token) {
		res.status(401).json({
			code: 'UNAUTHORIZED',
			message: 'Unauthorized',
		});
		return;
	}

	try {
		const result = await unbindClawByTokenImpl({ token });
		if (!result.ok) {
			const status = result.code === 'INVALID_INPUT'
				? 400
				: 401;
			res.status(status).json({
				code: result.code,
				message: result.message,
			});
			return;
		}

		console.info('[coclaw/api] unbind success botId=%s userId=%s (type=%s)', result.botId, result.userId, typeof result.userId);
		notifyAndDisconnectClawImpl(result.botId, 'bot_unbound');
		const unboundClawId = result.botId.toString();
		sendToUserImpl(String(result.userId), {
			event: 'claw.unbound',
			clawId: unboundClawId,
		});
		sendToUserImpl(String(result.userId), {
			event: 'bot.unbound',
			botId: unboundClawId,
			clawId: unboundClawId,
		});

		res.status(200).json({
			botId: result.botId.toString(),
			clawId: result.botId.toString(),
			unbound: true,
		});
	}
	catch (err) {
		next(err);
	}
}

export async function clawStatusStreamHandler(req, res, _next, {
	sendSnapshotImpl = sendSnapshot,
} = {}) {
	if (!requireSession(req, res)) {
		return;
	}

	const remoteIp = req.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
		|| req.socket?.remoteAddress
		|| 'unknown';
	console.info('[coclaw/sse] stream request userId=%s ip=%s', req.user.id, remoteIp);

	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
	});
	res.write('\n');

	// 先推送快照再注册增量事件，避免增量事件被后到的快照覆盖
	await sendSnapshotImpl(req.user.id, res).catch((err) => {
		console.warn('[SSE] snapshot failed userId=%s: %s', req.user.id, err?.message);
	});
	registerSseClient(req.user.id, res);

	// 应用层心跳（UI 可感知，用于检测 SSE 健康）
	const hbTimer = setInterval(() => {
		try {
			res.write('data: {"event":"heartbeat"}\n\n');
		}
		catch (err) {
			console.debug('[SSE] heartbeat write failed, clearing timer: %s', err?.message);
			clearInterval(hbTimer);
		}
	}, 30_000);

	req.on('close', () => clearInterval(hbTimer));
}

// 撤销未使用的绑定码（用户离开页面时调用）
export async function cancelBindingCodeHandler(req, res, next, {
	findBindingCodeImpl = findBindingCode,
	deleteBindingCodeImpl = deleteBindingCode,
} = {}) {
	if (!requireSession(req, res)) {
		return;
	}

	const { code } = req.params;
	if (!code) {
		res.status(400).json({ code: 'INVALID_REQUEST', message: 'Missing code' });
		return;
	}

	try {
		const bindingCode = await findBindingCodeImpl(code);
		if (!bindingCode || bindingCode.userId !== req.user.id) {
			res.status(204).end();
			return;
		}
		await deleteBindingCodeImpl(code).catch(() => {});
		res.status(204).end();
	}
	catch (err) {
		next(err);
	}
}

clawBotRouter.get('/', listClawsHandler);
clawBotRouter.get('/self', getClawSelfHandler);
clawBotRouter.get('/status-stream', clawStatusStreamHandler);
clawBotRouter.post('/binding-codes', createBindingCodeHandler);
clawBotRouter.post('/binding-codes/wait', waitBindingCodeHandler);
clawBotRouter.delete('/binding-codes/:code', cancelBindingCodeHandler);
clawBotRouter.post('/ws-ticket', createUiWsTicketHandler);
clawBotRouter.post('/bind', bindClawHandler);
clawBotRouter.post('/unbind', unbindClawHandler);
clawBotRouter.post('/unbind-by-user', unbindClawByUserHandler);
