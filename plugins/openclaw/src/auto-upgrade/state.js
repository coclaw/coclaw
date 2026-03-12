/**
 * state.js — upgrade-state.json 与 upgrade-log.jsonl 读写
 *
 * 状态文件存储在 OpenClaw state 目录下（~/.openclaw/coclaw/），
 * 与 bindings.json 共享同一目录。路径解析优先级：
 * 1. runtime.state.resolveStateDir()（gateway 进程内）
 * 2. OPENCLAW_STATE_DIR 环境变量（worker 进程，由 spawner 传入）
 * 3. ~/.openclaw（兜底默认值）
 */
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';

import { getRuntime } from '../runtime.js';

const CHANNEL_ID = 'coclaw';
const STATE_FILENAME = 'upgrade-state.json';
const LOG_FILENAME = 'upgrade-log.jsonl';
const LOG_MAX_LINES = 200;
const LOG_KEEP_LINES = 100;

export function resolveStateDir() {
	const rt = getRuntime();
	if (rt?.state?.resolveStateDir) {
		return rt.state.resolveStateDir();
	}
	return process.env.OPENCLAW_STATE_DIR
		? nodePath.resolve(process.env.OPENCLAW_STATE_DIR)
		: nodePath.join(os.homedir(), '.openclaw');
}

export function getStatePath() {
	return nodePath.join(resolveStateDir(), CHANNEL_ID, STATE_FILENAME);
}

export function getLogPath() {
	return nodePath.join(resolveStateDir(), CHANNEL_ID, LOG_FILENAME);
}

/**
 * 读取 upgrade-state.json
 * @returns {Promise<{ skippedVersions?: string[], lastCheck?: string, lastUpgrade?: object }>}
 */
export async function readState() {
	const filePath = getStatePath();
	try {
		const raw = await fs.readFile(filePath, 'utf8');
		const trimmed = raw.trim();
		if (!trimmed) return {};
		return JSON.parse(trimmed);
	}
	catch (err) {
		if (err?.code === 'ENOENT') return {};
		throw err;
	}
}

/**
 * 写入 upgrade-state.json（完整覆盖）
 * @param {object} state
 */
export async function writeState(state) {
	const filePath = getStatePath();
	await fs.mkdir(nodePath.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * 将版本加入 skippedVersions
 * @param {string} version
 */
export async function addSkippedVersion(version) {
	const state = await readState();
	const skipped = Array.isArray(state.skippedVersions) ? state.skippedVersions : [];
	if (!skipped.includes(version)) {
		skipped.push(version);
	}
	state.skippedVersions = skipped;
	await writeState(state);
}

/**
 * 更新 lastCheck 时间戳
 */
export async function updateLastCheck() {
	const state = await readState();
	state.lastCheck = new Date().toISOString();
	await writeState(state);
}

/**
 * 更新 lastUpgrade 信息
 * @param {{ from: string, to: string, result: string }} info
 */
export async function updateLastUpgrade(info) {
	const state = await readState();
	state.lastUpgrade = { ...info, ts: new Date().toISOString() };
	await writeState(state);
}

/**
 * 追加升级日志
 * @param {{ from: string, to: string, result: string, error?: string }} entry
 */
export async function appendLog(entry) {
	const filePath = getLogPath();
	await fs.mkdir(nodePath.dirname(filePath), { recursive: true });
	const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
	await fs.appendFile(filePath, `${line}\n`, 'utf8');
	await trimLog(filePath);
}

/**
 * 日志超过 LOG_MAX_LINES 时截断，保留最近 LOG_KEEP_LINES 行
 */
async function trimLog(filePath) {
	try {
		const content = await fs.readFile(filePath, 'utf8');
		const lines = content.split('\n').filter(Boolean);
		if (lines.length <= LOG_MAX_LINES) return;
		const kept = lines.slice(-LOG_KEEP_LINES);
		await fs.writeFile(filePath, `${kept.join('\n')}\n`, 'utf8');
	}
	catch {
		// 截断失败不影响主流程
	}
}
