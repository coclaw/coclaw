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

/**
 * 匹配 markdown 中的 coclaw-file 链接（含可选 `!` 前缀的图片语法）。
 * 两种形式：
 * - 尖括号形式 `[label](<coclaw-file:path>)`：推荐，CommonMark 允许 URL 含括号/空格等
 * - 裸形式 `[label](coclaw-file:path)`：向后兼容，路径不得含 `()` 空格 `<>`
 * 捕获组：1=`!?` 前缀，2=label，3=尖括号形式 URL，4=裸形式 URL（3/4 互斥）
 */
const COCLAW_LINK_RE = /(!?)\[([^\]]*)\]\((?:<(coclaw-file:[^>\r\n]+)>|(coclaw-file:[^()\s<>]+))\)/g;

/**
 * 遍历 markdown 文本中所有 coclaw-file 链接。
 *
 * 供 markdown 预处理与附件提取共用，避免两处正则重复且容易漂移。
 * @param {string} text
 * @returns {{ isImg: boolean, label: string, url: string, path: string, match: string, index: number }[]}
 */
export function findCoclawMarkdownLinks(text) {
	if (!text) return [];
	const re = new RegExp(COCLAW_LINK_RE.source, 'g');
	const links = [];
	let m;
	while ((m = re.exec(text)) !== null) {
		const url = m[3] || m[4];
		links.push({
			isImg: m[1] === '!',
			label: m[2],
			url,
			path: url.slice(SCHEME_PREFIX.length),
			match: m[0],
			index: m.index,
		});
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
