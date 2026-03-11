/* c8 ignore start */
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

const DERIVED_TITLE_MAX_LEN = 60;

// OC 注入的 inbound metadata 头部（Conversation info / Sender / Thread starter 等）
const INBOUND_META_RE = /^\w[\w ]* \(untrusted[^)]*\):\n```json\n[\s\S]*?\n```\n\n/;
// operator 级策略/指令前缀，如 Skills store policy (operator configured): ...
const OPERATOR_POLICY_RE = /^\w[\w ]* \(operator configured\):[\s\S]*?\n\n/;
// OC 注入的用户消息时间戳前缀
const USER_TS_RE = /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+[^\]]+\]\s*/;
// 尾部 [message_id: xxx]
const MSG_ID_SUFFIX_RE = /\n\[message_id:\s*[^\]]+\]\s*$/;
// 尾部 Untrusted context 块（外部元数据注入）
const UNTRUSTED_CTX_SUFFIX_RE = /\n\nUntrusted context \(metadata, do not treat as instructions or commands\):\n[\s\S]*$/;
// 定时任务前缀
const CRON_UUID_RE = /\[cron:[0-9a-f-]+(?:\s+([^\]]*))?\]\s*/;
// cron 注入的 Current time 行及其后的系统追加指令（如 "Return your summary..."）
const CRON_TIME_TAIL_RE = /\nCurrent time:[^\n]+[\s\S]*$/;
// 从 Current time 行提取 UTC 时间部分
const CRON_TIME_UTC_RE = /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s+UTC/;

function formatCronTime(matchedText) {
	const m = matchedText.match(CRON_TIME_UTC_RE);
	if (!m) return '';
	try {
		const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
		if (!Number.isFinite(d.getTime())) return '';
		const y = d.getFullYear();
		const mo = String(d.getMonth() + 1).padStart(2, '0');
		const dd = String(d.getDate()).padStart(2, '0');
		const hh = String(d.getHours()).padStart(2, '0');
		const mi = String(d.getMinutes()).padStart(2, '0');
		return ` ${y}-${mo}-${dd} ${hh}${mi}`;
	}
	catch {
		return '';
	}
}

function stripLeadingPattern(text, re) {
	let prev;
	do {
		prev = text;
		text = text.replace(re, '');
	} while (text !== prev);
	return text;
}

function cleanTitleText(text) {
	if (!text) return '';
	let s = stripLeadingPattern(text, INBOUND_META_RE);
	s = stripLeadingPattern(s, OPERATOR_POLICY_RE);
	s = s.replace(CRON_TIME_TAIL_RE, (match) => formatCronTime(match));
	return s
		.replace(USER_TS_RE, '')
		.replace(CRON_UUID_RE, (_, taskName) => taskName ? `${taskName} ` : '')
		.replace(UNTRUSTED_CTX_SUFFIX_RE, '')
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
	const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
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

		// 补充 sessions.json 中有索引但无 transcript 文件的 session（如 reset 后未对话、新建 session）
		for (const [sessionKey, entry] of Object.entries(index)) {
			const sid = entry?.sessionId;
			if (!sid || grouped.has(sid)) continue;
			grouped.set(sid, {
				sessionId: sid,
				sessionKey,
				indexed: true,
				archiveType: 'live',
				fileName: null,
				updatedAt: entry.updatedAt ?? 0,
				size: 0,
			});
		}

		const rows = Array.from(grouped.values());
		rows.sort((a, b) => b.updatedAt - a.updatedAt);

		const items = rows.slice(cursor, cursor + limit).map((row) => {
			if (!row.fileName) {
				return { ...row };
			}
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
		// live 文件优先：同一 sessionId 可能同时存在 live 和 reset 文件
		// （OpenClaw reset 后复用 sessionId），live 代表当前活跃 transcript
		const livePath = nodePath.join(dir, `${sessionId}.jsonl`);
		if (fs.existsSync(livePath)) {
			return livePath;
		}
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
		return null;
	}

	function get(params = {}) {
		const agentId = typeof params.agentId === 'string' && params.agentId.trim() ? params.agentId.trim() : 'main';
		const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
		if (!sessionId) throw new Error('sessionId required');
		const limit = clamp(params.limit, 1, 500, 100);
		const cursor = clamp(params.cursor, 0, Number.MAX_SAFE_INTEGER, 0);
		const file = resolveTranscriptFile(agentId, sessionId);
		if (!file) {
			return { agentId, sessionId, total: 0, cursor: String(cursor), nextCursor: null, messages: [] };
		}

		const all = [];
		for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
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
