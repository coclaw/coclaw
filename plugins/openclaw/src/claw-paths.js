/**
 * claw-paths.js — OpenClaw 路径解析的唯一入口（gateway 主进程内）
 *
 * 设计原则：
 * - clawStateDir：高度稳定的 OpenClaw API（自 2026-02-19 起注入 runtime），直接信任
 * - session 三件套（store / transcript / sessions dir）：自 2026-03-16 起才注入 runtime，
 *   做防御性 fallback，回退到 OpenClaw 自家长期稳定的固定布局
 * - 不读 OPENCLAW_STATE_DIR 环境变量；不回退到 ~/.openclaw 家目录
 * - runtime 缺失或字段缺失（除 session helper 外）即抛错，bug 早暴露
 *
 * 例外：auto-upgrade/state.js 是 gateway 与 worker 子进程共用的，worker 没 runtime，
 * 故那个文件保留独立的 env 兜底，不走本模块。
 */
import nodePath from 'node:path';

import { getRuntime } from './runtime.js';

const CHANNEL_ID = 'coclaw';

/**
 * OpenClaw 真实 state 目录
 * @returns {string}
 */
export function clawStateDir() {
	const rt = getRuntime();
	if (!rt?.state?.resolveStateDir) {
		throw new Error('claw-paths: runtime not injected; cannot resolve state dir');
	}
	return rt.state.resolveStateDir();
}

/**
 * CoClaw 自管文件根目录（bindings / settings / device-identity / rpc-queues）
 * @returns {string}
 */
export function pluginDir() {
	return nodePath.join(clawStateDir(), CHANNEL_ID);
}

/**
 * sessions.json 全路径（session-manager 读会话索引用）
 *
 * 优先 runtime helper（自 2026-03-16 起），允许跟随 OpenClaw 自定义 store 配置；
 * runtime 没注入 helper 时回退到固定布局。
 * @param {string} agentId
 * @returns {string}
 */
export function sessionStorePath(agentId) {
	const rt = getRuntime();
	const helper = rt?.agent?.session?.resolveStorePath;
	if (helper) {
		return helper(undefined, { agentId });
	}
	return nodePath.join(clawStateDir(), 'agents', agentId, 'sessions', 'sessions.json');
}

/**
 * sessions 所在目录（topic / chat-history 写自己的扩展文件用）
 *
 * 通过 sessionStorePath 反推 dirname，使 CoClaw 扩展文件随 OpenClaw 真实存储位置走。
 * @param {string} agentId
 * @returns {string}
 */
export function agentSessionsDir(agentId) {
	return nodePath.dirname(sessionStorePath(agentId));
}

/**
 * 单条 session 的 JSONL transcript 全路径（session-manager 读单会话用）
 * @param {string} sessionId
 * @param {string} agentId
 * @param {{ sessionFile?: string }} [entry] - sessions.json 索引条目，可能含 sessionFile 覆盖
 * @returns {string}
 */
export function sessionTranscriptPath(sessionId, agentId, entry) {
	const rt = getRuntime();
	const helper = rt?.agent?.session?.resolveSessionFilePath;
	if (helper) {
		return helper(sessionId, entry, { agentId });
	}
	return nodePath.join(agentSessionsDir(agentId), `${sessionId}.jsonl`);
}

export { CHANNEL_ID };
