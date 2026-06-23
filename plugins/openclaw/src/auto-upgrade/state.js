/**
 * state.js — upgrade-state.json 与 upgrade-log.jsonl 读写
 *
 * 例外：本文件 gateway 主进程与 auto-upgrade worker 子进程共用，worker 没 runtime
 * 注入，故保留独立的双轨解析（不走 claw-paths.js）：
 * 1. runtime.state.resolveStateDir()（gateway 进程内）
 * 2. OPENCLAW_STATE_DIR 环境变量（worker 子进程，由 spawner 传入）
 * 3. ~/.openclaw（兜底默认值）
 *
 * 注：第 3 档（homedir）实际够不着——gateway 进程内 runtime 必在（full mode 才启
 * scheduler）、worker 进程 spawner 总会传 OPENCLAW_STATE_DIR，故不存在“worker 写错盘”。
 * 曾被对抗式 review 当 bug 捞出，核实为不可达防御，记此免再捞。
 * 同理“runtime 非空但 .state 缺失”的部分注入形态也不可达，勿为对齐 claw-paths.js 改成抛错。
 *
 * 锁策略：state 文件的 read-modify-write 统一走 stateMutex；纯读不加锁。
 * 锁只能护住同进程内并发（gateway 与 worker 跨进程仍各写各的），但 worker /
 * scheduler 各自内部是串行流，进程内互斥已足够。
 */
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';

import { getRuntime } from '../runtime.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { createMutex } from '../utils/mutex.js';

const CHANNEL_ID = 'coclaw';
const STATE_FILENAME = 'upgrade-state.json';
const LOG_FILENAME = 'upgrade-log.jsonl';
const LOG_MAX_LINES = 200;
const LOG_KEEP_LINES = 100;
// lastUpgrade.error 截断上限：远端上报行不宜过长；jsonl 保留完整 error
const ERROR_MAX_CHARS = 500;

const stateMutex = createMutex();
const logMutex = createMutex();

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

/** 不加锁的裸读，仅供本模块在 withLock 内复用（避免嵌套同把锁死锁） */
async function readStateRaw() {
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

/** 不加锁的裸写，仅供本模块在 withLock 内复用 */
async function writeStateRaw(state) {
	const filePath = getStatePath();
	await atomicWriteFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * 读取 upgrade-state.json（纯读不加锁，最多读到略旧快照）
 * @returns {Promise<{ skippedVersions?: string[], lastCheck?: string, lastUpgrade?: object, inflight?: object }>}
 */
export async function readState() {
	return readStateRaw();
}

/**
 * 写入 upgrade-state.json（完整覆盖）
 * @param {object} state
 */
export async function writeState(state) {
	await stateMutex.withLock(() => writeStateRaw(state));
}

/**
 * 将版本加入 skippedVersions
 * @param {string} version
 */
export async function addSkippedVersion(version) {
	await stateMutex.withLock(async () => {
		const state = await readStateRaw();
		appendSkippedTo(state, version);
		await writeStateRaw(state);
	});
}

/** 在 state 对象上原地追加 skippedVersions（去重） */
function appendSkippedTo(state, version) {
	const skipped = Array.isArray(state.skippedVersions) ? state.skippedVersions : [];
	if (!skipped.includes(version)) {
		skipped.push(version);
	}
	state.skippedVersions = skipped;
}

/**
 * 更新 lastCheck 时间戳
 */
export async function updateLastCheck() {
	await stateMutex.withLock(async () => {
		const state = await readStateRaw();
		state.lastCheck = new Date().toISOString();
		await writeStateRaw(state);
	});
}

/**
 * 更新 lastUpgrade 信息
 * @param {{ from: string, to: string, result: string }} info
 */
export async function updateLastUpgrade(info) {
	await stateMutex.withLock(async () => {
		const state = await readStateRaw();
		state.lastUpgrade = { ...info, ts: new Date().toISOString() };
		await writeStateRaw(state);
	});
}

/**
 * 读取 inflight 标记（纯读不加锁）
 * @returns {Promise<object|null>}
 */
export async function readInflight() {
	const state = await readStateRaw();
	/* c8 ignore next -- ?? fallback */
	return state.inflight ?? null;
}

/**
 * 写入 inflight 标记（worker 进 update 前调用；整体覆盖并附加 ts）。
 * worker 若没活到终态记账（典型：被自己触发的网关重启杀死），scheduler
 * 下轮据此对账补记终态。
 * @param {{ from: string, to: string, verifyTarget: string, pluginDir: string, phase: string }} info
 */
export async function writeInflight(info) {
	await stateMutex.withLock(async () => {
		const state = await readStateRaw();
		state.inflight = { ...info, ts: new Date().toISOString() };
		await writeStateRaw(state);
	});
}

/**
 * 合并更新 inflight 字段（phase 推进 / verifyTarget 修正）。
 * inflight 不存在时 no-op——终态已清账后，迟到的更新不应复活账目。
 * @param {object} patch
 */
export async function updateInflight(patch) {
	await stateMutex.withLock(async () => {
		const state = await readStateRaw();
		if (!state.inflight) return;
		state.inflight = { ...state.inflight, ...patch };
		await writeStateRaw(state);
	});
}

/** lastUpgrade.error 截断：保尾部（子命令真因通常在输出尾部） */
function truncateErrorTail(text) {
	const s = String(text);
	return s.length > ERROR_MAX_CHARS ? s.slice(-ERROR_MAX_CHARS) : s;
}

/**
 * 原子记录升级终态：同一把锁内一次读改写完成
 * "写 lastUpgrade + 清 inflight + 可选 addSkippedVersion"。
 * 终态写失败时 inflight 保留 → scheduler 下轮对账可见，不丢账。
 * upgrade-log.jsonl 追加放锁后 best-effort——终态已落盘，日志失败不回滚账目。
 *
 * @param {object} params
 * @param {string} params.from
 * @param {string} params.to
 * @param {string} params.result - ok / noop-skip / rollback / rollback-failed / interrupted
 * @param {string} [params.error] - lastUpgrade 内截断保存，jsonl 保留完整
 * @param {string} [params.phase] - 中断时刻所处阶段（interrupted 账目用）
 * @param {string} [params.skipVersion] - 需加入 skippedVersions 的版本（可缺）
 */
export async function recordUpgradeTerminal({ from, to, result, error, phase, skipVersion }) {
	await stateMutex.withLock(async () => {
		const state = await readStateRaw();
		if (skipVersion) {
			appendSkippedTo(state, skipVersion);
		}
		const last = { from, to, result };
		if (error) last.error = truncateErrorTail(error);
		if (phase) last.phase = phase;
		state.lastUpgrade = { ...last, ts: new Date().toISOString() };
		delete state.inflight;
		await writeStateRaw(state);
	});
	try {
		const entry = { from, to, result };
		if (error) entry.error = error;
		if (phase) entry.phase = phase;
		await appendLog(entry);
	}
	catch {
		// best-effort：jsonl 只是诊断日志，追加失败不影响终态
	}
}

/**
 * 追加升级日志
 * @param {{ from: string, to: string, result?: string, error?: string, phase?: string, event?: string }} entry
 */
export async function appendLog(entry) {
	await logMutex.withLock(async () => {
		const filePath = getLogPath();
		await fs.mkdir(nodePath.dirname(filePath), { recursive: true });
		const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
		await fs.appendFile(filePath, `${line}\n`, 'utf8');
		await trimLog(filePath);
	});
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
		// 整文件覆写走 atomic：truncate-then-write 中途崩溃会清空整个 log
		await atomicWriteFile(filePath, `${kept.join('\n')}\n`);
	}
	catch {
		// 截断失败不影响主流程
	}
}
