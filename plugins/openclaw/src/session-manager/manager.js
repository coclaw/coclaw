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
		throw err;
	}
}

// OpenClaw ISO 时间戳：YYYY-MM-DDTHH-MM-SS[.sss]Z（与 artifacts.ts ARCHIVE_TIMESTAMP_RE 对齐：毫秒可选）
// 用于过滤 rsync/备份等场景带入的非法后缀（如 .jsonl.reset.<ts>.bak）
const ARCHIVE_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z$/;

async function safeAccess(filePath) {
	try { await fsp.access(filePath); return true; }
	catch (err) {
		if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
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
	const logger = options.logger ?? console;
	const resolveSessionsDir = options.resolveSessionsDir ?? agentSessionsDir;
	const resolveStorePath = options.resolveStorePath ?? sessionStorePath;
	const resolveTranscriptPath = options.resolveTranscriptPath ?? sessionTranscriptPath;

	function sessionsDir(agentId = 'main') {
		const aid = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : 'main';
		return resolveSessionsDir(aid);
	}

	async function readIndex(agentId = 'main') {
		const aid = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : 'main';
		const file = resolveStorePath(aid);
		const data = await readJsonSafe(file, {});
		// readJsonSafe 抛错时返回 {}（已是 object），此处兜底 sessions.json 内容是合法 JSON
		// 但非 object（number / string / boolean / null / array 由下游 listAllEntries 单独处理）
		if (!data || typeof data !== 'object') return {};
		return data;
	}

	// 启动期对账用：直接读 sessions.json 把当前所有 sessionKey -> sessionId 摘出来。
	// 不扫 transcript 文件 / 不做 stat，因此远比 listAll 轻量；缺/坏文件返回空数组。
	async function listAllEntries(agentId = 'main') {
		const idx = await readIndex(agentId);
		// sessions.json 异常被写成数组时，Object.entries 会生成 "0"/"1" 假键，
		// 把它们当 sessionKey 喂下游会污染。直接拒绝数组形态，同时打 warn 暴露异常。
		if (Array.isArray(idx)) {
			logger.warn?.(`[session-manager] sessions.json for agent=${agentId} is an array, expected object — returning empty entries`);
			return [];
		}
		const out = [];
		for (const [sessionKey, item] of Object.entries(idx)) {
			const sid = item?.sessionId;
			if (typeof sessionKey !== 'string' || !sessionKey) continue;
			if (typeof sid !== 'string' || !sid) continue;
			out.push({ sessionKey, sessionId: sid });
		}
		return out;
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
			catch (err) {
				if (err.code === 'ENOENT') continue;
				throw err;
			}
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
				// entry.updatedAt 缺失或非数字时回落 0；UI 端按 updatedAt 排序时无 transcript 项排到末位
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
		// live 文件优先：同一 sessionId 可能同时存在 live 和 reset/deleted 归档
		// （OpenClaw reset 后复用 sessionId），live 代表当前活跃 transcript
		const livePath = resolveTranscriptPath(sessionId, agentId);
		if (await safeAccess(livePath)) return livePath;

		// .reset.<ts> 与 .deleted.<ts> 都代表 session 的最终态，合并扫描按时间戳取最新
		// 时间戳是 OpenClaw ISO YYYY-MM-DDTHH-MM-SS[.sss]Z（artifacts.ts 锁住毫秒可选），字典序 = 时间序
		const resetPrefix = `${sessionId}.jsonl.reset.`;
		const deletedPrefix = `${sessionId}.jsonl.deleted.`;
		const files = await safeReaddir(dir);
		const candidates = [];
		for (const name of files) {
			let archiveStamp;
			if (name.startsWith(resetPrefix)) archiveStamp = name.slice(resetPrefix.length);
			else if (name.startsWith(deletedPrefix)) archiveStamp = name.slice(deletedPrefix.length);
			else continue;
			// 严格 ISO 时间戳校验，过滤 .jsonl.reset.<ts>.bak 等带尾巴的备份/同步残留
			if (!ARCHIVE_TS_RE.test(archiveStamp)) continue;
			const full = nodePath.join(dir, name);
			let stat;
			try { stat = await fsp.stat(full); }
			catch (err) {
				if (err.code === 'ENOENT') continue;
				throw err;
			}
			candidates.push({
				path: full,
				archiveStamp,
				updatedAt: stat.mtimeMs,
			});
		}
		candidates.sort((a, b) => {
			if (a.archiveStamp !== b.archiveStamp) {
				return b.archiveStamp.localeCompare(a.archiveStamp);
			}
			return b.updatedAt - a.updatedAt;
		});
		if (candidates.length > 0) {
			return candidates[0].path;
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

	/**
	 * 按 sessionId 获取消息，返回完整 JSONL 行级结构。
	 * 只返回 type==="message" 且有合法 message.role 的行。
	 * limit 语义：不传/null/非 number/NaN/Infinity/<1 → 返回全部；>=1 的有限 number → 取最后 Math.trunc(limit) 条。无默认/最大值。
	 *
	 * 取不到正文时用错误码区分成因，调用方据此精确处置（不再统一塌缩成空数组）：
	 * - transcript 文件不存在（裸名 / .reset. / .deleted. 变体全无）→ 抛 code='NOT_FOUND'
	 * - 文件在但一行都解析不出（非空却零行成功 JSON.parse）→ 抛 code='PARSE_FAILED'
	 * - 真·读盘 IO 错误：readTranscriptText 原样上抛（由 RPC 层映射）
	 * 空文件 / 全空白行（含仅含空格、制表符的行）/ 文件在但无 message 行 → 正常返回 { messages: [] }（良性空，非失败）。
	 *
	 * 部分坏行（有成功解析的行 + 个别 JSON.parse 失败）走容错：返回解析出的消息，
	 * 并在 payload 平行附 badLines（仅 >0 时）记录坏行原文供排障，不丢整段。
	 * badLines[].index 是坏行在「非空白内容行」序列中的 0-based 位置（空白行已被跳过，故非原始文件行号）。
	 * @param {{ sessionId: string, agentId?: string, limit?: number }} params
	 * @returns {Promise<{ messages: object[], badLines?: { index: number, raw: string, error: string }[] }>}
	 */
	async function getById(params = {}) {
		const agentId = typeof params.agentId === 'string' && params.agentId.trim() ? params.agentId.trim() : 'main';
		const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
		if (!sessionId) throw new Error('sessionId required');
		// limit 类型严格：只接受 number 且 >= 1。string/bool/array 走非 number 分支被拒，
		// 0 / 负数 / NaN / Infinity / (0,1) 区间也都视为"不限"——(0,1) 不视为不限的话 Math.trunc 后会变 0、slice(-0) 退化为全部
		const useLimit = typeof params.limit === 'number' && Number.isFinite(params.limit) && params.limit >= 1;
		const limitNum = useLimit ? Math.trunc(params.limit) : 0;
		const file = await resolveTranscriptFile(agentId, sessionId);
		if (!file) {
			throw Object.assign(new Error(`session transcript not found: ${sessionId}`), { code: 'NOT_FOUND' });
		}

		const text = await readTranscriptText(file);
		const messages = [];
		const badLines = [];
		// parseOk 在 JSON.parse 成功后立即 +1，必须在 type 过滤之前——
		// 否则"全合法 JSON 但无 message 行"会被错判 PARSE_FAILED
		let parseOk = 0;
		let index = -1;
		for await (const line of iterTextLines(text)) {
			// 纯空白行（仅空格/制表符等，iterTextLines 只跳零长度段）视同空行：
			// 既不计入 parseOk 也不进 badLines，保证"全空白文件 → 良性空"不变量、不误判 PARSE_FAILED
			if (line.trim() === '') continue;
			index++;
			let row;
			try {
				row = JSON.parse(line);
			}
			catch (err) {
				badLines.push({ index, raw: line, error: String(err?.message ?? err) });
				logger.warn?.(`[session-manager] bad json line skipped: ${String(err?.message ?? err)}`);
				continue;
			}
			parseOk++;
			if (row?.type !== 'message') continue;
			const msg = row?.message;
			if (!msg || typeof msg !== 'object' || !msg.role) continue;
			messages.push(row);
		}
		// 非空文件却一行都没解析出 = 整文损坏；空 / 全空白文件（含纯空格行）跳过后零内容行 → parseOk=0 且 badLines=[]，不算损坏
		if (parseOk === 0 && badLines.length > 0) {
			throw Object.assign(new Error(`session transcript unparseable: ${sessionId}`), { code: 'PARSE_FAILED' });
		}
		const sliced = (useLimit && messages.length > limitNum) ? messages.slice(-limitNum) : messages;
		return badLines.length > 0 ? { messages: sliced, badLines } : { messages: sliced };
	}

	return { listAll, listAllEntries, get, getById };
}
