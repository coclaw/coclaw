import { Router } from 'express';

import { requireAdmin } from '../middlewares/require-admin.js';
import { getAdminDashboard } from '../services/admin-dashboard.svc.js';
import * as adminRepo from '../repos/admin.repo.js';
import { listOnlineClawIds } from '../claw-ws-hub.js';
import { registerAdminSseClient } from '../admin-sse.js';

export const adminRouter = Router();

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 100;

function parseLimit(value) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) {
		return LIMIT_DEFAULT;
	}
	return Math.min(Math.floor(n), LIMIT_MAX);
}

function normalizeSearch(value) {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

// cursor 必须是正整数字符串（Snowflake id），否则忽略
function normalizeCursor(value) {
	if (typeof value !== 'string' || value.length === 0) {
		return undefined;
	}
	return /^\d+$/.test(value) ? value : undefined;
}

export async function dashboardHandler(req, res, next, deps = {}) {
	const getDashboard = deps.getAdminDashboard ?? getAdminDashboard;
	try {
		const data = await getDashboard();
		res.json(data);
	}
	catch (err) {
		next(err);
	}
}

export async function listClawsHandler(req, res, next, deps = {}) {
	const listFn = deps.listClawsPaginated ?? adminRepo.listClawsPaginated;
	const onlineIdsFn = deps.listOnlineClawIds ?? listOnlineClawIds;
	try {
		const limit = parseLimit(req.query?.limit);
		const search = normalizeSearch(req.query?.search);
		const cursor = normalizeCursor(req.query?.cursor);
		const result = await listFn({ cursor, limit, search });
		const onlineIds = onlineIdsFn();
		const items = result.items.map((c) => ({ ...c, online: onlineIds.has(c.id) }));
		res.json({ items, nextCursor: result.nextCursor });
	}
	catch (err) {
		next(err);
	}
}

export async function listUsersHandler(req, res, next, deps = {}) {
	const listFn = deps.listUsersPaginated ?? adminRepo.listUsersPaginated;
	try {
		const limit = parseLimit(req.query?.limit);
		const search = normalizeSearch(req.query?.search);
		const cursor = normalizeCursor(req.query?.cursor);
		const result = await listFn({ cursor, limit, search });
		res.json(result);
	}
	catch (err) {
		next(err);
	}
}

export async function adminStreamHandler(req, res, _next, deps = {}) {
	const registerFn = deps.registerAdminSseClient ?? registerAdminSseClient;
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
	});
	res.write('\n');
	registerFn(res);

	// 应用层心跳（UI 可感知，检测 SSE 健康）
	const hbTimer = setInterval(() => {
		try {
			res.write('data: {"event":"heartbeat"}\n\n');
		}
		catch (err) {
			console.debug('[coclaw/admin-sse] heartbeat write failed: %s', err?.message);
			clearInterval(hbTimer);
		}
	}, 30_000);
	req.on('close', () => clearInterval(hbTimer));
}

adminRouter.get('/dashboard', requireAdmin, (req, res, next) => dashboardHandler(req, res, next));
adminRouter.get('/claws', requireAdmin, (req, res, next) => listClawsHandler(req, res, next));
adminRouter.get('/users', requireAdmin, (req, res, next) => listUsersHandler(req, res, next));
adminRouter.get('/stream', requireAdmin, (req, res, next) => adminStreamHandler(req, res, next));

// 测试辅助
export const __test = { parseLimit, normalizeSearch, normalizeCursor };
