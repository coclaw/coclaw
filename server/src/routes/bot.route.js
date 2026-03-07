import crypto from 'node:crypto';
import { Router } from 'express';

import {
	bindBot,
	createBindingCodeForUser,
	unbindBotByToken,
	unbindBotByUser,
} from '../services/bot-binding.svc.js';
import { deleteBindingCode, findBindingCode } from '../repos/bot-binding-code.repo.js';
import { findBotById, findBotByTokenHash, findLatestBotByUserId, listBotsByUserId } from '../repos/bot.repo.js';
import {
	cancelBindingWait,
	markBindingBound,
	registerBindingWait,
	waitBindingResult,
} from '../binding-wait-hub.js';
import { createUiWsTicket, listOnlineBotIds, notifyAndDisconnectBot, refreshBotName } from '../bot-ws-hub.js';
import { registerSseClient, sendToUser } from '../bot-status-sse.js';

export const botRouter = Router();

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

export async function listBotsHandler(req, res, next, deps = {}) {
	if (!requireSession(req, res)) {
		return;
	}

	const {
		listBotsByUserIdImpl = listBotsByUserId,
		listOnlineBotIdsImpl = listOnlineBotIds,
		refreshBotNameImpl = refreshBotName,
	} = deps;

	try {
		const [bots, onlineBotIds] = await Promise.all([
			listBotsByUserIdImpl(req.user.id),
			Promise.resolve(listOnlineBotIdsImpl()),
		]);

		const refreshedNameMap = new Map();
		const onlineBots = bots.filter((bot) => onlineBotIds.has(bot.id.toString()));
		const refreshResults = await Promise.allSettled(
			onlineBots.map(async (bot) => {
				const latestName = await refreshBotNameImpl(bot.id, { timeoutMs: 1000 });
				if (latestName !== undefined) {
					refreshedNameMap.set(bot.id.toString(), latestName);
				}
			}),
		);
		for (const result of refreshResults) {
			if (result.status === 'rejected') {
				// noop: best-effort refresh only
			}
		}

		res.status(200).json({
			items: bots.map((bot) => {
				const botId = bot.id.toString();
				const name = refreshedNameMap.has(botId)
					? refreshedNameMap.get(botId)
					: bot.name;
				return {
					id: botId,
					name,
					online: onlineBotIds.has(botId),
					lastSeenAt: bot.lastSeenAt,
					createdAt: bot.createdAt,
					updatedAt: bot.updatedAt,
				};
			}),
		});
	}
	catch (err) {
		next(err);
	}
}

export async function createBindingCodeHandler(req, res, next) {
	if (!requireSession(req, res)) {
		return;
	}

	try {
		const result = await createBindingCodeForUser({
			userId: req.user.id,
		});

		if (!result.ok) {
			res.status(500).json({
				code: result.code,
				message: result.message,
			});
			return;
		}

		const waitToken = registerBindingWait({
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

export async function bindBotHandler(req, res, next, deps = {}) {
	const {
		bindBotImpl = bindBot,
		markBindingBoundImpl = markBindingBound,
		notifyAndDisconnectBotImpl = notifyAndDisconnectBot,
	} = deps;
	try {
		const result = await bindBotImpl({
			code: req.body?.code,
			name: req.body?.name,
		});

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

		if (result.rebound) {
			console.info(`[coclaw/api] bind rebound botId=${result.botId.toString()} -> revoke old connection`);
			notifyAndDisconnectBotImpl(result.botId, 'token_revoked');
		}
		const boundBotName = result.botName ?? null;
		markBindingBoundImpl({
			code: result.bindingCode,
			botId: result.botId,
			botName: boundBotName,
		});

		console.info(`[coclaw/api] bind success botId=${result.botId.toString()} rebound=${Boolean(result.rebound)}`);
		sendToUser(String(result.userId), {
			event: 'bot.bound',
			bot: {
				id: result.botId.toString(),
				name: boundBotName,
			},
		});
		res.status(200).json({
			botId: result.botId.toString(),
			token: result.token,
			rebound: result.rebound,
			bot: {
				id: result.botId.toString(),
				name: boundBotName ?? null,
			},
		});
	}
	catch (err) {
		next(err);
	}
}

export async function getBotSelfHandler(req, res, next) {
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
		const bot = await findBotByTokenHash(tokenHash);
		if (!bot) {
			res.status(401).json({
				code: 'UNAUTHORIZED',
				message: 'Invalid token',
			});
			return;
		}

		res.status(200).json({
			botId: bot.id.toString(),
		});
	}
	catch (err) {
		next(err);
	}
}

export async function createUiWsTicketHandler(req, res, next) {
	if (!requireSession(req, res)) {
		return;
	}

	try {
		const rawBotId = req.body?.botId;
		let bot = null;

		if (rawBotId !== undefined && rawBotId !== null && String(rawBotId).trim() !== '') {
			try {
				bot = await findBotById(BigInt(String(rawBotId)));
			}
			catch {
				res.status(400).json({
					code: 'INVALID_INPUT',
					message: 'botId is invalid',
				});
				return;
			}

			if (!bot || bot.userId !== req.user.id) {
				res.status(404).json({
					code: 'BOT_NOT_FOUND',
					message: 'No active bot found',
				});
				return;
			}
		}
		else {
			bot = await findLatestBotByUserId(req.user.id);
			if (!bot) {
				res.status(404).json({
					code: 'BOT_NOT_FOUND',
					message: 'No active bot found',
				});
				return;
			}
		}

		const ticket = createUiWsTicket({
			botId: bot.id,
			userId: req.user.id,
		});
		res.status(201).json({
			ticket,
			botId: String(bot.id),
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
		findBindingCodeImpl = findBindingCode,
		deleteBindingCodeImpl = deleteBindingCode,
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
	const onAbort = async () => {
		aborted = true;
		const cancelled = cancelBindingWaitImpl({
			code,
			waitToken,
			userId: req.user.id,
		});
		if (!cancelled) {
			return;
		}
		const bindingCode = await findBindingCodeImpl(code).catch(() => null);
		if (!bindingCode || bindingCode.userId !== req.user.id) {
			return;
		}
		await deleteBindingCodeImpl(code).catch(() => {});
	};

	req.on('aborted', onAbort);

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
	finally {
		req.off('aborted', onAbort);
	}
}

export async function unbindBotByUserHandler(req, res, next) {
	if (!requireSession(req, res)) {
		return;
	}

	try {
		const rawBotId = req.body?.botId;
		if (rawBotId === undefined || rawBotId === null || String(rawBotId).trim() === '') {
			res.status(400).json({
				code: 'INVALID_INPUT',
				message: 'botId is required',
			});
			return;
		}

		let botId;
		try {
			botId = BigInt(String(rawBotId));
		}
		catch {
			res.status(400).json({
				code: 'INVALID_INPUT',
				message: 'botId is invalid',
			});
			return;
		}

		const result = await unbindBotByUser({ userId: req.user.id, botId });
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
		notifyAndDisconnectBot(result.botId, 'bot_unbound');
		sendToUser(String(req.user.id), {
			event: 'bot.unbound',
			botId: result.botId.toString(),
		});

		res.status(200).json({
			botId: result.botId.toString(),
			unbound: true,
		});
	}
	catch (err) {
		next(err);
	}
}

export async function unbindBotHandler(req, res, next) {
	const token = parseBearerToken(req);
	if (!token) {
		res.status(401).json({
			code: 'UNAUTHORIZED',
			message: 'Unauthorized',
		});
		return;
	}

	try {
		const result = await unbindBotByToken({ token });
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
		notifyAndDisconnectBot(result.botId, 'bot_unbound');
		sendToUser(String(result.userId), {
			event: 'bot.unbound',
			botId: result.botId.toString(),
		});

		res.status(200).json({
			botId: result.botId.toString(),
			unbound: true,
		});
	}
	catch (err) {
		next(err);
	}
}

export function botStatusStreamHandler(req, res) {
	if (!requireSession(req, res)) {
		return;
	}

	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
	});
	res.write('\n');

	registerSseClient(req.user.id, res);

	const hbTimer = setInterval(() => {
		try {
			res.write(': heartbeat\n\n');
		}
		catch {
			clearInterval(hbTimer);
		}
	}, 30_000);

	req.on('close', () => clearInterval(hbTimer));
}

botRouter.get('/', listBotsHandler);
botRouter.get('/self', getBotSelfHandler);
botRouter.get('/status-stream', botStatusStreamHandler);
botRouter.post('/binding-codes', createBindingCodeHandler);
botRouter.post('/binding-codes/wait', waitBindingCodeHandler);
botRouter.post('/ws-ticket', createUiWsTicketHandler);
botRouter.post('/bind', bindBotHandler);
botRouter.post('/unbind', unbindBotHandler);
botRouter.post('/unbind-by-user', unbindBotByUserHandler);
