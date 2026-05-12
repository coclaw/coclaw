/**
 * UI 远程日志 HTTP 通道：POST /api/v1/log/ui
 *
 * - 仅 POST，其他方法 405
 * - body 上限 1MB，超限 413
 * - schema 校验失败 400 且不更新去重 map
 * - 单调 seq 去重：seq <= lastSeq 静默丢弃仍返 200
 * - 身份标注：有 session → [user:<id>]；无 session → [anon]
 * - 打印格式：`[remote][ui]<identity>[batch=<uiId 尾部 8>:<seq>][ts=<ISO_UTC>] <text>`
 *
 * 详见 docs/designs/ui-remote-log-http-channel.md §4。
 */

import express, { Router } from 'express';
import { z } from 'zod';

import { fmtRemoteLogTs } from '../claw-ws-hub.js';
import { acceptBatch } from '../services/log-ui.svc.js';

// nanoid 默认 urlAlphabet 64 字符全部落在 [A-Za-z0-9_-]
const NANOID_RE = /^[A-Za-z0-9_-]{21}$/;
const MAX_LOGS_PER_BATCH = 100;
const BODY_LIMIT = '1mb';

const logEntrySchema = z.object({
	ts: z.number().finite().min(0),
	text: z.string(),
});

const batchSchema = z.object({
	uiId: z.string().regex(NANOID_RE),
	seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
	logs: z.array(logEntrySchema).min(1).max(MAX_LOGS_PER_BATCH),
});

function shortUiId(uiId) {
	return uiId.slice(-8);
}

function identityTag(req) {
	if (req.isAuthenticated?.() && req.user) {
		const uid = String(req.user.id ?? req.user);
		return `[user:${uid}]`;
	}
	return '[anon]';
}

/**
 * POST /api/v1/log/ui handler。
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function handlePostLogUi(req, res) {
	const parsed = batchSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(400).json({ code: 'INVALID_PAYLOAD', message: 'Invalid log batch payload' });
		return;
	}
	const { uiId, seq, logs } = parsed.data;
	if (!acceptBatch(uiId, seq)) {
		// 重传去重：静默丢弃，仍返 200（对客户端无差异）
		res.status(200).json({ ok: true });
		return;
	}
	const tag = identityTag(req);
	const sid = shortUiId(uiId);
	for (const entry of logs) {
		console.info(`[remote][ui]${tag}[batch=${sid}:${seq}]${fmtRemoteLogTs(entry.ts)} ${entry.text}`);
	}
	res.status(200).json({ ok: true });
}

/**
 * 在 app 上挂接 405 拦截 + 1MB JSON body parser + 413/400 错误处理。
 *
 * 必须在全局 `express.json()` 之前调用，路径专属 parser 才能在更大 limit 下生效。
 * 此函数与 `logUiRouter` 配套使用：parser/拦截在 app 层，handler 路由在 router 层（router 需要 session/passport 之后再 mount）。
 *
 * @param {import('express').Express} app
 */
export function attachLogUiBodyParser(app) {
	// 405：在解析 body 之前先拒绝非 POST 方法
	app.use('/api/v1/log/ui', (req, res, next) => {
		if (req.method !== 'POST') {
			res.status(405).set('Allow', 'POST').json({
				code: 'METHOD_NOT_ALLOWED',
				message: 'Only POST is allowed',
			});
			return;
		}
		next();
	});
	// 1MB JSON parser（必须早于全局 express.json() 的 100kb 默认 limit）
	app.use('/api/v1/log/ui', express.json({ limit: BODY_LIMIT }));
	// body 解析失败 → 413 / 400
	app.use('/api/v1/log/ui', (err, _req, res, next) => {
		if (err && (err.status === 413 || err.type === 'entity.too.large')) {
			res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' });
			return;
		}
		if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
			res.status(400).json({ code: 'INVALID_PAYLOAD', message: 'Invalid JSON body' });
			return;
		}
		next(err);
	});
}

export const logUiRouter = Router();
logUiRouter.post('/ui', handlePostLogUi);

// 测试辅助
export const __test = {
	NANOID_RE,
	MAX_LOGS_PER_BATCH,
	BODY_LIMIT,
	batchSchema,
	shortUiId,
	identityTag,
};
