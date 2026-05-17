// 读取 OpenClaw 自家 sessions 目录下的 coclaw-chat-history.json。
// e2e 不在 plugin runtime 里，没有 rt.state.resolveStateDir 可用——
// 退而求其次：依赖 OPENCLAW_STATE_DIR 环境变量，回退到 ~/.openclaw 默认值。
// 如果你的 OpenClaw 用自定义 state-dir（profile / system 安装），
// 跑 e2e 前 export OPENCLAW_STATE_DIR=/your/path。

import fs from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';

function stateDir() {
	return process.env.OPENCLAW_STATE_DIR || nodePath.join(os.homedir(), '.openclaw');
}

export function chatHistoryPath(agentId = 'main') {
	return nodePath.join(stateDir(), 'agents', agentId, 'sessions', 'coclaw-chat-history.json');
}

/**
 * 读取并解析 chat-history.json。文件不存在返回 null。
 *
 * @param {string} [agentId='main']
 * @returns {object|null}
 */
export function readChatHistory(agentId = 'main') {
	const p = chatHistoryPath(agentId);
	if (!fs.existsSync(p)) return null;
	const raw = fs.readFileSync(p, 'utf8');
	return JSON.parse(raw);
}

/**
 * 取某个 sessionKey 下的 entries 数组（不存在返回空数组）。
 *
 * @param {string} agentId
 * @param {string} sessionKey
 * @returns {Array}
 */
export function readEntries(agentId, sessionKey) {
	const data = readChatHistory(agentId);
	return data?.[sessionKey] ?? [];
}
