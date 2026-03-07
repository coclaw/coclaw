/* c8 ignore start */
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

const DERIVED_TITLE_MAX_LEN = 60;

// OC 注入的 untrusted metadata 头部
const CONV_INFO_RE = /^\w[\w ]* \(untrusted metadata\):\n```json\n[\s\S]*?\n```\n\n/;
// OC 注入的用户消息时间戳前缀
const USER_TS_RE = /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+[^\]]+\]\s*/;
// 尾部 [message_id: xxx]
const MSG_ID_SUFFIX_RE = /\n\[message_id:\s*[^\]]+\]\s*$/;
// 定时任务前缀
const CRON_UUID_RE = /\[cron:[0-9a-f-]+(?:\s+([^\]]*))?\]\s*/;

function cleanTitleText(text) {
	if (!text) return '';
	return text
		.replace(CONV_INFO_RE, '')
		.replace(USER_TS_RE, '')
		.replace(CRON_UUID_RE, (_, taskName) => taskName ? `${taskName} ` : '')
		.replace(MSG_ID_SUFFIX_RE, '')
		.trim();
}

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

function readJsonSafe(filePath, fallback) {
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf8'));
	}
	catch {
		return fallback;
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
	return archiveType === 'reset' ? 2 : 1;
}

function shouldReplaceByPriority(current, next) {
	const currentPriority = archiveTypePriority(current.archiveType);
	const nextPriority = archiveTypePriority(next.archiveType);
	if (nextPriority !== currentPriority) {
		return nextPriority > currentPriority;
	}
	return next.updatedAt > current.updatedAt;
}

function truncateTitle(text, maxLen = DERIVED_TITLE_MAX_LEN) {
	if (text.length <= maxLen) return text;
	const cut = text.slice(0, maxLen - 1);
	const lastSpace = cut.lastIndexOf(' ');
	if (lastSpace > maxLen * 0.6) {
		return `${cut.slice(0, lastSpace)}…`;
	}
	return `${cut}…`;
}

function extractRawTextFromContent(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return undefined;
	for (const part of content) {
		if (!part || typeof part !== 'object') continue;
		if (part.type !== 'text') continue;
		if (typeof part.text !== 'string') continue;
		if (part.text.trim()) return part.text;
	}
	return undefined;
}

function findFirstUserRawText(filePath, logger) {
	const lines = fs.readFileSync(filePath, 'utf8').split('\n');
	for (const line of lines) {
		if (!line) continue;
		try {
			const row = JSON.parse(line);
			if (row?.type !== 'message') continue;
			if (row?.message?.role !== 'user') continue;
			const raw = extractRawTextFromContent(row?.message?.content);
			if (raw && raw.trim()) return raw;
		}
		catch (err) {
			logger.warn?.(`[session-manager] bad json line skipped when deriving title: ${String(err?.message ?? err)}`);
		}
	}
	return undefined;
}

function deriveTitle(filePath, logger) {
	const rawText = findFirstUserRawText(filePath, logger);
	if (!rawText) return undefined;
	const cleaned = cleanTitleText(rawText);
	if (!cleaned) return undefined;
	const normalized = cleaned.replace(/\s+/g, ' ').trim();
	if (!normalized) return undefined;
	return truncateTitle(normalized, DERIVED_TITLE_MAX_LEN);
}

export function createSessionManager(options = {}) {
	const rootDir = options.rootDir ?? nodePath.join(os.homedir(), '.openclaw', 'agents');
	const logger = options.logger ?? console;

	function sessionsDir(agentId = 'main') {
		const aid = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : 'main';
		return nodePath.join(rootDir, aid, 'sessions');
	}

	function readIndex(agentId = 'main') {
		const file = nodePath.join(sessionsDir(agentId), 'sessions.json');
		const data = readJsonSafe(file, {});
		if (!data || typeof data !== 'object') return {};
		return data;
	}

	function listAll(params = {}) {
		const agentId = typeof params.agentId === 'string' && params.agentId.trim() ? params.agentId.trim() : 'main';
		const limit = clamp(params.limit, 1, 200, 50);
		const cursor = clamp(params.cursor, 0, Number.MAX_SAFE_INTEGER, 0);
		const dir = sessionsDir(agentId);
		const index = readIndex(agentId);
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

		const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
		const grouped = new Map();
		for (const file of files) {
			const parsed = parseSessionFileName(file);
			if (!parsed?.sessionId) continue;
			const full = nodePath.join(dir, file);
			const stat = fs.statSync(full);
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

		const rows = Array.from(grouped.values());
		rows.sort((a, b) => b.updatedAt - a.updatedAt);

		const items = rows.slice(cursor, cursor + limit).map((row) => {
			const transcriptPath = nodePath.join(dir, row.fileName);
			const derivedTitle = deriveTitle(transcriptPath, logger);
			if (!derivedTitle) {
				return { ...row };
			}
			return {
				...row,
				derivedTitle,
			};
		});
		const nextCursor = cursor + limit < rows.length ? String(cursor + limit) : null;
		return {
			agentId,
			total: rows.length,
			cursor: String(cursor),
			nextCursor,
			items,
		};
	}

	function resolveTranscriptFile(agentId, sessionId) {
		const dir = sessionsDir(agentId);
		const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
		const resetPrefix = `${sessionId}.jsonl.reset.`;
		const resetCandidates = files
			.filter((name) => name.startsWith(resetPrefix))
			.map((name) => {
				const full = nodePath.join(dir, name);
				const stat = fs.statSync(full);
				return {
					path: full,
					archiveStamp: name.slice(resetPrefix.length),
					updatedAt: stat.mtimeMs,
				};
			})
			.sort((a, b) => {
				if (a.archiveStamp !== b.archiveStamp) {
					return b.archiveStamp.localeCompare(a.archiveStamp);
				}
				return b.updatedAt - a.updatedAt;
			});
		if (resetCandidates.length > 0) {
			return resetCandidates[0].path;
		}
		const livePath = nodePath.join(dir, `${sessionId}.jsonl`);
		if (fs.existsSync(livePath)) {
			return livePath;
		}
		return null;
	}

	function get(params = {}) {
		const agentId = typeof params.agentId === 'string' && params.agentId.trim() ? params.agentId.trim() : 'main';
		const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
		if (!sessionId) throw new Error('sessionId required');
		const limit = clamp(params.limit, 1, 500, 100);
		const cursor = clamp(params.cursor, 0, Number.MAX_SAFE_INTEGER, 0);
		const file = resolveTranscriptFile(agentId, sessionId);
		if (!file) throw new Error(`session transcript not found: ${sessionId}`);

		const all = [];
		for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
			try {
				all.push(JSON.parse(line));
			}
			catch (err) {
				logger.warn?.(`[session-manager] bad json line skipped: ${String(err?.message ?? err)}`);
			}
		}
		const messages = all.slice(cursor, cursor + limit);
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

	return { listAll, get };
}
/* c8 ignore stop */
