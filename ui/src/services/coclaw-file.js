/**
 * CoClaw 文件资源抽象层
 *
 * 定义 coclaw-file URL 协议，统一标识 agent 侧文件资源。
 *
 * 两种合法形态（均符合 RFC 3986）：
 * - 完整 URL（前端内部）：coclaw-file://clawId:agentId/path
 *   scheme://authority/path —— authority 为 clawId:agentId
 * - 短格式（Agent markdown 中）：coclaw-file:path
 *   scheme:path —— path-rootless，无 authority，workspace 相对路径
 *
 * 提供 URL 构建/解析 + 基于 URL 的文件获取能力。
 * 后续本地缓存将在此层实现（URL 天然为 cache key）。
 */
import { useClawConnections } from './claw-connection-manager.js';
import { downloadFile } from './file-transfer.js';

const SCHEME = 'coclaw-file://';
const SCHEME_PREFIX = 'coclaw-file:';

/**
 * 构建 coclaw-file URL
 *
 * 约束：clawId 和 agentId 不得包含 ':' 或 '/'，否则解析时会出错。
 * @param {string} clawId
 * @param {string} agentId
 * @param {string} path - 文件路径（不含前导 /）
 * @returns {string}
 */
export function buildCoclawUrl(clawId, agentId, path) {
	return `${SCHEME}${clawId}:${agentId}/${path}`;
}

/**
 * 解析 coclaw-file URL
 * @param {string} url
 * @returns {{ clawId: string, agentId: string, path: string } | null}
 */
export function parseCoclawUrl(url) {
	if (!url || !url.startsWith(SCHEME)) return null;
	const rest = url.slice(SCHEME.length);
	const slashIdx = rest.indexOf('/');
	if (slashIdx < 0) return null;
	const authority = rest.slice(0, slashIdx);
	const colonIdx = authority.indexOf(':');
	if (colonIdx < 0) return null;
	const clawId = authority.slice(0, colonIdx);
	const agentId = authority.slice(colonIdx + 1);
	if (!clawId || !agentId) return null;
	const path = rest.slice(slashIdx + 1);
	if (!path) return null;
	return { clawId, agentId, path };
}

/**
 * 判断是否为完整 coclaw-file URL（coclaw-file://clawId:agentId/path）
 * @param {string} url
 * @returns {boolean}
 */
export function isCoclawUrl(url) {
	return typeof url === 'string' && url.startsWith(SCHEME);
}

/**
 * 判断是否为任意形态的 coclaw-file 引用（完整 URL 或短格式）
 * @param {string} url
 * @returns {boolean}
 */
export function isCoclawScheme(url) {
	return typeof url === 'string' && url.startsWith(SCHEME_PREFIX);
}

/**
 * 从短格式 coclaw-file:path 中提取 workspace 相对路径。
 * 仅处理无 authority 的短格式；完整 URL 返回 null。
 * markdown-it 会对非 ASCII 字符进行 percent-encoding，此处自动解码。
 * @param {string} url
 * @returns {string|null}
 */
export function extractCoclawPath(url) {
	if (!url || !url.startsWith(SCHEME_PREFIX)) return null;
	const rest = url.slice(SCHEME_PREFIX.length);
	// 以 // 开头为完整 URL，非短格式
	if (rest.startsWith('//')) return null;
	if (!rest) return null;
	try {
		return decodeURI(rest);
	} catch {
		return rest;
	}
}

// 匹配 `[label](` 或 `![label](` 的头部；URL 体由扫描器单独处理
const COCLAW_LINK_HEADER_RE = /(!?)\[([^\]]*)\]\(/g;

/**
 * 扫描裸形式 URL 体，返回收尾 `)` 的位置（不含）；失败返回 -1。
 *
 * 算法：跟踪括号深度。`(` 深度 +1；`)` 若深度为 0 则是 markdown 链接的收尾（停止并返回），
 * 否则深度 -1（括号是路径的一部分）。
 *
 * 终止（返回 -1，视为不匹配）：
 * - 换行 `\n`/`\r`：CommonMark 链接禁止跨行，避免一条坏链接吞掉后续多行正常内容
 * - 空白 ` `/`\t`：CommonMark 裸 URL 不允许空白
 * - `<`/`>`：保留给尖括号形式
 * - 字符串结束仍未找到收尾 `)`
 * @param {string} text
 * @param {number} startIdx - 开始扫描的位置（通常是 `coclaw-file:` 之后）
 * @returns {number}
 */
function __scanBareUrlEnd(text, startIdx) {
	let depth = 0;
	for (let i = startIdx; i < text.length; i++) {
		const c = text[i];
		if (c === '\n' || c === '\r' || c === ' ' || c === '\t' || c === '<' || c === '>') return -1;
		if (c === '(') {
			depth++;
		} else if (c === ')') {
			if (depth === 0) return i;
			depth--;
		}
	}
	return -1;
}

/**
 * 扫描尖括号 URL 体，返回 `>` 的位置（不含）；失败返回 -1。
 * 终止：遇 `<`/`\n`/`\r` 直接失败；遇 `>` 成功返回。
 * @param {string} text
 * @param {number} startIdx
 * @returns {number}
 */
function __scanAngleUrlEnd(text, startIdx) {
	for (let i = startIdx; i < text.length; i++) {
		const c = text[i];
		if (c === '\n' || c === '\r' || c === '<') return -1;
		if (c === '>') return i;
	}
	return -1;
}

/**
 * 遍历 markdown 文本中所有 coclaw-file 链接（含可选 `!` 前缀的图片语法）。
 *
 * 支持两种形式：
 * - 尖括号形式 `[label](<coclaw-file:path>)`：推荐，`<>` 内仅禁 `<>` 与换行
 * - 裸形式 `[label](coclaw-file:path)`：容错支持**平衡的**半角括号（`a(b).pdf`、`a(1)_(2).pdf` 等）；
 *   不平衡的开括号会使扫描器吞到字符串末尾而失败，不影响其它链接
 *
 * 已知局限：label 用 `[^\]]*` 匹配，不支持 CommonMark 的 `\]` 转义（如 `[a\]b](...)` 会漏识别）。
 * Agent 输出概率极低，不做复杂化处理。
 *
 * 供 markdown 预处理与附件提取共用，避免两处解析逻辑重复漂移。
 * @param {string} text
 * @returns {{ isImg: boolean, label: string, url: string, path: string, match: string, index: number }[]}
 */
export function findCoclawMarkdownLinks(text) {
	if (!text) return [];
	const headerRE = new RegExp(COCLAW_LINK_HEADER_RE.source, 'g');
	const links = [];
	let h;
	while ((h = headerRE.exec(text)) !== null) {
		const headerIdx = h.index;
		const isImg = h[1] === '!';
		const label = h[2];
		const urlStart = headerIdx + h[0].length; // `(` 之后的位置

		let url;
		let matchEnd; // 完整 markdown 链接结束位置（不含，即下一个字符）

		if (text[urlStart] === '<') {
			// 尖括号形式
			const gt = __scanAngleUrlEnd(text, urlStart + 1);
			if (gt === -1 || text[gt + 1] !== ')') continue;
			url = text.slice(urlStart + 1, gt);
			matchEnd = gt + 2;
		} else {
			// 裸形式
			if (!text.startsWith(SCHEME_PREFIX, urlStart)) continue;
			const closeParen = __scanBareUrlEnd(text, urlStart + SCHEME_PREFIX.length);
			if (closeParen === -1) continue;
			url = text.slice(urlStart, closeParen);
			matchEnd = closeParen + 1;
		}

		if (!url.startsWith(SCHEME_PREFIX) || url.length <= SCHEME_PREFIX.length) continue;

		links.push({
			isImg,
			label,
			url,
			path: url.slice(SCHEME_PREFIX.length),
			match: text.slice(headerIdx, matchEnd),
			index: headerIdx,
		});
		// 手动推进 lastIndex 越过整个 link，避免在 URL 内部重复匹配嵌套的 `[...]`
		headerRE.lastIndex = matchEnd;
	}
	return links;
}

/**
 * 通过 coclaw-file URL 获取文件内容
 *
 * 解析 URL → 获取 clawConn → 调用 downloadFile → 返回 Blob。
 * @param {string} url - coclaw-file:// URL
 * @returns {Promise<Blob>}
 * @throws {Error} URL 无效、连接不存在、下载失败
 */
export async function fetchCoclawFile(url) {
	const parsed = parseCoclawUrl(url);
	if (!parsed) throw new Error(`Invalid coclaw-file URL: ${url}`);

	const { clawId, agentId, path } = parsed;
	const clawConn = useClawConnections().get(clawId);
	if (!clawConn) throw new Error(`Claw connection not found: ${clawId}`);

	const handle = downloadFile(clawConn, agentId, path);
	const result = await handle.promise;
	return result.blob;
}
