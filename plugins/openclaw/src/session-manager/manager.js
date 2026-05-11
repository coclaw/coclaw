import fsp from 'node:fs/promises';
import nodePath from 'node:path';

import { agentSessionsDir, sessionStorePath, sessionTranscriptPath } from '../claw-paths.js';
import { iterTextLines } from '../utils/text-line-stream.js';

function toNum(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp(value, min, max, fallback) {
	const n = toNum(value, fallback);
	if (n < min) return min;
	if (n > max) return max;
	return n;
}

async function readJsonSafe(filePath, fallback) {
	try {
		const text = await fsp.readFile(filePath, 'utf8');
		return JSON.parse(text);
	}
	catch {
		return fallback;
	}
}

// readdir 与后续 stat 之间存在天然 race window（文件被并发删除/reset 归档）。
// 统一把 ENOENT/ENOTDIR 视为"目录消失即空目录"，其它错误（如 EACCES）按原样上抛。
async function safeReaddir(dir) {
	try { return await fsp.readdir(dir); }
	catch (err) {
		if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
		/* c8 ignore next 2 -- 非 ENOENT/ENOTDIR 的 fs 错误按原样上抛 */
		throw err;
	}
}

async function safeAccess(filePath) {
	try { await fsp.access(filePath); return true; }
	catch (err) {
		if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
		/* c8 ignore next 2 -- 非 ENOENT/ENOTDIR 的 fs 错误按原样上抛 */
		throw err;
	}
}

function parseSessionFileName(fileName) {
	if (typeof fileName !== 'string' || !fileName.includes('.jsonl')) return null;
	if (fileName.includes('.jsonl.delete.') || fileName.includes('.jsonl.deleted.')) return null;

	if (fileName.endsWith('.jsonl')) {
		return {
			sessionId: fileName.slice(0, -6),
			archiveType: 'live',
		};
	}
	if (fileName.includes('.jsonl.reset.')) {
		return {
			sessionId: fileName.split('.jsonl.reset.')[0],
			archiveType: 'reset',
		};
	}
	return null;
}

function archiveTypePriority(archiveType) {
	return archiveType === 'live' ? 2 : 1;
}

function shouldReplaceByPriority(current, next) {
	const currentPriority = archiveTypePriority(current.archiveType);
	const nextPriority = archiveTypePriority(next.archiveType);
	if (nextPriority !== currentPriority) {
		return nextPriority > currentPriority;
	}
	return next.updatedAt > current.updatedAt;
}

export function createSessionManager(options = {}) {
	/* c8 ignore next */
	const logger = options.logger ?? console;
	const resolveSessionsDir = options.resolveSessionsDir ?? agentSessionsDir;
	const resolveStorePath = options.resolveStorePath ?? sessionStorePath;
	const resolveTranscriptPath = options.resolveTranscriptPath ?? sessionTranscriptPath;

	function sessionsDir(agentId = 'main') {
		/* c8 ignore next */
		const aid = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : 'main';
		return resolveSessionsDir(aid);
	}

	async function readIndex(agentId = 'main') {
		/* c8 ignore next */
		const aid = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : 'main';
		const file = resolveStorePath(aid);
		const data = await readJsonSafe(file, {});
		/* c8 ignore next */
		if (!data || typeof data !== 'object') return {};
		return data;
	}

	async function listAll(params = {}) {
		const agentId = typeof params.agentId === 'string' && params.agentId.trim() ? params.agentId.trim() : 'main';
		const limit = clamp(params.limit, 1, 200, 50);
		const cursor = clamp(params.cursor, 0, Number.MAX_SAFE_INTEGER, 0);
		const dir = sessionsDir(agentId);
		const index = await readIndex(agentId);
		const indexed = new Set(
			Object.values(index)
				.map((item) => item?.sessionId)
				.filter(Boolean),
		);
		const sessionKeyById = new Map();
		for (const [sessionKey, item] of Object.entries(index)) {
			const sid = item?.sessionId;
			if (sid) {
				sessionKeyById.set(sid, sessionKey);
			}
		}

		const files = await safeReaddir(dir);
		const grouped = new Map();
		for (const file of files) {
			const parsed = parseSessionFileName(file);
			if (!parsed?.sessionId) continue;
			const full = nodePath.join(dir, file);
			let stat;
			try { stat = await fsp.stat(full); }
			/* c8 ignore start -- readdir→stat race window：文件被并发删除时跳过 */
			catch (err) {
				if (err.code === 'ENOENT') continue;
				throw err;
			}
			/* c8 ignore stop */
			const row = {
				sessionId: parsed.sessionId,
				sessionKey: sessionKeyById.get(parsed.sessionId) ?? null,
				indexed: indexed.has(parsed.sessionId),
				archiveType: parsed.archiveType,
				fileName: file,
				updatedAt: stat.mtimeMs,
				size: stat.size,
			};
			const previous = grouped.get(parsed.sessionId);
			if (!previous || shouldReplaceByPriority(previous, row)) {
				grouped.set(parsed.sessionId, row);
			}
		}

		// 补充 sessions.json 中有索引但无 transcript 文件的 session（如 reset 后未对话、新建 session）
		for (const [sessionKey, entry] of Object.entries(index)) {
			const sid = entry?.sessionId;
			/* c8 ignore next -- !sid 防御性检查 */
			if (!sid || grouped.has(sid)) continue;
			grouped.set(sid, {
				sessionId: sid,
				sessionKey,
				indexed: true,
				archiveType: 'live',
				fileName: null,
				/* c8 ignore next -- ?? fallback */
				updatedAt: entry.updatedAt ?? 0,
				size: 0,
			});
		}

		const rows = Array.from(grouped.values());
		rows.sort((a, b) => b.updatedAt - a.updatedAt);

		const items = rows.slice(cursor, cursor + limit).map((row) => ({ ...row }));
		const nextCursor = cursor + limit < rows.length ? String(cursor + limit) : null;
		return {
			agentId,
			total: rows.length,
			cursor: String(cursor),
			nextCursor,
			items,
		};
	}

	async function resolveTranscriptFile(agentId, sessionId) {
		const dir = sessionsDir(agentId);
		// live 文件优先：同一 sessionId 可能同时存在 live 和 reset 文件
		// （OpenClaw reset 后复用 sessionId），live 代表当前活跃 transcript
		const livePath = resolveTranscriptPath(sessionId, agentId);
		if (await safeAccess(livePath)) return livePath;

		const files = await safeReaddir(dir);
		const resetPrefix = `${sessionId}.jsonl.reset.`;
		const resetCandidates = [];
		for (const name of files) {
			if (!name.startsWith(resetPrefix)) continue;
			const full = nodePath.join(dir, name);
			let stat;
			try { stat = await fsp.stat(full); }
			/* c8 ignore start -- readdir→stat race window */
			catch (err) {
				if (err.code === 'ENOENT') continue;
				throw err;
			}
			/* c8 ignore stop */
			resetCandidates.push({
				path: full,
				archiveStamp: name.slice(resetPrefix.length),
				updatedAt: stat.mtimeMs,
			});
		}
		resetCandidates.sort((a, b) => {
			if (a.archiveStamp !== b.archiveStamp) {
				return b.archiveStamp.localeCompare(a.archiveStamp);
			}
			/* c8 ignore next -- 同一 sessionId 的 reset 文件不会有相同 archiveStamp */
			return b.updatedAt - a.updatedAt;
		});
		if (resetCandidates.length > 0) {
			return resetCandidates[0].path;
		}
		return null;
	}

	// 读 transcript 全文；不存在视为空字符串。返回原始文本，由调用方走 iterTextLines
	// 流式扫描 + 解析，避免大文件 split 一次性卡 event loop。
	async function readTranscriptText(file) {
		try {
			return await fsp.readFile(file, 'utf8');
		}
		/* c8 ignore start -- resolveTranscriptFile→readFile race window */
		catch (err) {
			if (err.code === 'ENOENT') return '';
			throw err;
		}
		/* c8 ignore stop */
	}

	async function get(params = {}) {
		const agentId = typeof params.agentId === 'string' && params.agentId.trim() ? params.agentId.trim() : 'main';
		const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
		if (!sessionId) throw new Error('sessionId required');
		const limit = clamp(params.limit, 1, 500, 100);
		const cursor = clamp(params.cursor, 0, Number.MAX_SAFE_INTEGER, 0);
		const file = await resolveTranscriptFile(agentId, sessionId);
		if (!file) {
			return { agentId, sessionId, total: 0, cursor: String(cursor), nextCursor: null, messages: [] };
		}

		const text = await readTranscriptText(file);
		const all = [];
		for await (const line of iterTextLines(text)) {
			try {
				all.push(JSON.parse(line));
			}
			catch (err) {
				/* c8 ignore next -- ?./?? fallback */
				logger.warn?.(`[session-manager] bad json line skipped: ${String(err?.message ?? err)}`);
			}
		}
		const messages = all.slice(cursor, cursor + limit);
		/* c8 ignore next */
		const nextCursor = cursor + limit < all.length ? String(cursor + limit) : null;
		return {
			agentId,
			sessionId,
			total: all.length,
			cursor: String(cursor),
			nextCursor,
			messages,
		};
	}

	/**
	 * 按 sessionId 获取消息，返回完整 JSONL 行级结构。
	 * 只返回 type==="message" 且有合法 message.role 的行。
	 * @param {{ sessionId: string, agentId?: string, limit?: number }} params
	 * @returns {Promise<{ messages: object[] }>}
	 */
	async function getById(params = {}) {
		const agentId = typeof params.agentId === 'string' && params.agentId.trim() ? params.agentId.trim() : 'main';
		const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
		if (!sessionId) throw new Error('sessionId required');
		const limit = clamp(params.limit, 1, 500, 500);
		const file = await resolveTranscriptFile(agentId, sessionId);
		if (!file) {
			return { messages: [] };
		}

		const text = await readTranscriptText(file);
		const messages = [];
		for await (const line of iterTextLines(text)) {
			try {
				const row = JSON.parse(line);
				if (row?.type !== 'message') continue;
				const msg = row?.message;
				if (!msg || typeof msg !== 'object' || !msg.role) continue;
				messages.push(row);
			}
			catch (err) {
				/* c8 ignore next -- ?./?? fallback */
				logger.warn?.(`[session-manager] bad json line skipped: ${String(err?.message ?? err)}`);
			}
		}
		// 取最后 limit 条
		const sliced = messages.length > limit ? messages.slice(-limit) : messages;
		return { messages: sliced };
	}

	return { listAll, get, getById };
}
