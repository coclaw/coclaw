// 通过 `openclaw gateway call` CLI 调 RPC 的薄封装。
// 不走 WebSocket 直连——CLI 已经处理 transport + 重连，e2e 不重复实现。

import { execFileSync } from 'node:child_process';

const CLI = process.env.OPENCLAW_CLI || 'openclaw';

/**
 * 调一次 gateway RPC，返回解析后的 JSON。
 * 失败（CLI 非零退出 / JSON 解析失败）直接抛——e2e test 会自动失败。
 *
 * @param {string} method - gateway method 名（如 'sessions.reset'）
 * @param {object} [params] - method 参数对象
 * @param {object} [opts] - 可选项
 * @param {number} [opts.timeoutMs=15000] - 子进程超时
 * @returns {object} CLI 输出的解析 JSON
 */
export function rpcCall(method, params = {}, opts = {}) {
	const timeoutMs = opts.timeoutMs ?? 15000;
	const args = ['gateway', 'call', '--json', '--params', JSON.stringify(params), method];
	const out = execFileSync(CLI, args, {
		encoding: 'utf8',
		timeout: timeoutMs,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return JSON.parse(out);
}

/**
 * 跑一次 embedded agent，返回 CLI JSON 输出。
 *
 * @param {string} message - 给 main agent 的 prompt
 * @param {object} [opts] - 可选项
 * @param {string} [opts.agent='main'] - 目标 agent id
 * @param {number} [opts.timeoutSec=60] - agent run 超时（秒）
 * @returns {object} CLI 输出 JSON
 */
export function runAgent(message, opts = {}) {
	const agent = opts.agent ?? 'main';
	const timeoutSec = opts.timeoutSec ?? 60;
	const args = [
		'agent',
		'--agent', agent,
		'--message', message,
		'--json',
		'--timeout', String(timeoutSec),
	];
	const out = execFileSync(CLI, args, {
		encoding: 'utf8',
		timeout: (timeoutSec + 10) * 1000,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return JSON.parse(out);
}
