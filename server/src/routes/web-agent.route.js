import { Router } from 'express';

import { findAllForUser } from '../repos/web-agent.repo.js';
import { hide, recordClick } from '../services/web-agent.svc.js';

export const webAgentRouter = Router();

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

// schema: WebAgent.id @db.UnsignedInt → 0..4294967295
const WEB_AGENT_ID_MAX = 4294967295;

// 仅接受正整数字符串，且不超出 UnsignedInt 上界
export function parseWebAgentId(raw) {
	if (typeof raw !== 'string') return null;
	if (!/^[0-9]+$/.test(raw)) return null;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0 || n > WEB_AGENT_ID_MAX) return null;
	return n;
}

// GET /api/v1/web-agents — 全部可见 Web Agent
// 公开访问：未登录返回纯入口数据（lastClickedAt / hiddenAt 全 null）；登录后附带个人化字段
export async function listWebAgentsHandler(req, res, next, deps = {}) {
	const { findAllForUserImpl = findAllForUser } = deps;
	const userId = req.isAuthenticated?.() && req.user ? req.user.id : null;

	try {
		const items = await findAllForUserImpl(userId);
		res.status(200).json({ items });
	}
	catch (err) {
		next(err);
	}
}

// POST /api/v1/web-agents/:id/click — fire-and-forget 上报一次点击
export async function recordClickHandler(req, res, next, deps = {}) {
	if (!requireSession(req, res)) {
		return;
	}

	const { recordClickImpl = recordClick } = deps;

	const webAgentId = parseWebAgentId(req.params?.id);
	if (webAgentId == null) {
		res.status(400).json({
			code: 'INVALID_INPUT',
			message: 'id must be a positive integer',
		});
		return;
	}

	try {
		const ok = await recordClickImpl({
			userId: req.user.id,
			webAgentId,
		});
		if (!ok) {
			res.status(404).json({
				code: 'WEB_AGENT_NOT_FOUND',
				message: 'web agent not visible',
			});
			return;
		}
		res.status(204).end();
	}
	catch (err) {
		next(err);
	}
}

// POST /api/v1/web-agents/:id/hide — 将该 Agent 从当前用户的最近列表移除
export async function hideWebAgentHandler(req, res, next, deps = {}) {
	if (!requireSession(req, res)) {
		return;
	}

	const { hideImpl = hide } = deps;

	const webAgentId = parseWebAgentId(req.params?.id);
	if (webAgentId == null) {
		res.status(400).json({
			code: 'INVALID_INPUT',
			message: 'id must be a positive integer',
		});
		return;
	}

	try {
		const ok = await hideImpl({
			userId: req.user.id,
			webAgentId,
		});
		if (!ok) {
			res.status(404).json({
				code: 'WEB_AGENT_NOT_FOUND',
				message: 'web agent not visible',
			});
			return;
		}
		res.status(204).end();
	}
	catch (err) {
		next(err);
	}
}

webAgentRouter.get('/', listWebAgentsHandler);
webAgentRouter.post('/:id/click', recordClickHandler);
webAgentRouter.post('/:id/hide', hideWebAgentHandler);
