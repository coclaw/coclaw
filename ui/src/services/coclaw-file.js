/**
 * CoClaw 文件资源抽象层
 *
 * 定义 coclaw-file:// URL 协议，统一标识 agent 侧文件资源。
 * 格式：coclaw-file://botId:agentId/path/to/file
 *
 * 提供 URL 构建/解析 + 基于 URL 的文件获取能力。
 * 后续本地缓存将在此层实现（URL 天然为 cache key）。
 */
import { useBotConnections } from './bot-connection-manager.js';
import { downloadFile } from './file-transfer.js';

const SCHEME = 'coclaw-file://';

/**
 * 构建 coclaw-file URL
 *
 * 约束：botId 和 agentId 不得包含 ':' 或 '/'，否则解析时会出错。
 * @param {string} botId
 * @param {string} agentId
 * @param {string} path - 文件路径（不含前导 /）
 * @returns {string}
 */
export function buildCoclawUrl(botId, agentId, path) {
	return `${SCHEME}${botId}:${agentId}/${path}`;
}

/**
 * 解析 coclaw-file URL
 * @param {string} url
 * @returns {{ botId: string, agentId: string, path: string } | null}
 */
export function parseCoclawUrl(url) {
	if (!url || !url.startsWith(SCHEME)) return null;
	const rest = url.slice(SCHEME.length);
	const slashIdx = rest.indexOf('/');
	if (slashIdx < 0) return null;
	const authority = rest.slice(0, slashIdx);
	const colonIdx = authority.indexOf(':');
	if (colonIdx < 0) return null;
	const botId = authority.slice(0, colonIdx);
	const agentId = authority.slice(colonIdx + 1);
	if (!botId || !agentId) return null;
	const path = rest.slice(slashIdx + 1);
	if (!path) return null;
	return { botId, agentId, path };
}

/**
 * 判断是否为 coclaw-file URL
 * @param {string} url
 * @returns {boolean}
 */
export function isCoclawUrl(url) {
	return typeof url === 'string' && url.startsWith(SCHEME);
}

/**
 * 通过 coclaw-file URL 获取文件内容
 *
 * 解析 URL → 获取 botConn → 调用 downloadFile → 返回 Blob。
 * @param {string} url - coclaw-file:// URL
 * @returns {Promise<Blob>}
 * @throws {Error} URL 无效、连接不存在、下载失败
 */
export async function fetchCoclawFile(url) {
	const parsed = parseCoclawUrl(url);
	if (!parsed) throw new Error(`Invalid coclaw-file URL: ${url}`);

	const { botId, agentId, path } = parsed;
	const botConn = useBotConnections().get(botId);
	if (!botConn) throw new Error(`Bot connection not found: ${botId}`);

	const handle = downloadFile(botConn, agentId, path);
	const result = await handle.promise;
	return result.blob;
}
