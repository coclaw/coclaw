import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import { mock, test } from 'node:test';

import {
	addSkippedVersion,
	appendLog,
	getLogPath,
	getStatePath,
	readInflight,
	readState,
	recordUpgradeTerminal,
	updateInflight,
	updateLastCheck,
	updateLastUpgrade,
	writeInflight,
	writeState,
} from './state.js';
import { setRuntime } from '../runtime.js';

function resetEnv() {
	delete process.env.OPENCLAW_STATE_DIR;
	setRuntime(null);
}

async function makeTmpDir(prefix = 'coclaw-state-') {
	return await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
}

// --- getStatePath / getLogPath ---

test('getStatePath 使用 OPENCLAW_STATE_DIR', () => {
	resetEnv();
	process.env.OPENCLAW_STATE_DIR = '/tmp/fake-state';
	const p = getStatePath();
	assert.equal(p, '/tmp/fake-state/coclaw/upgrade-state.json');
});

test('getStatePath 使用 runtime.state.resolveStateDir', () => {
	resetEnv();
	setRuntime({ state: { resolveStateDir: () => '/custom/state' } });
	const p = getStatePath();
	assert.equal(p, '/custom/state/coclaw/upgrade-state.json');
});

test('getStatePath 默认回退到 ~/.openclaw', () => {
	resetEnv();
	const p = getStatePath();
	assert.equal(p, nodePath.join(os.homedir(), '.openclaw', 'coclaw', 'upgrade-state.json'));
});

test('getLogPath 使用 OPENCLAW_STATE_DIR', () => {
	resetEnv();
	process.env.OPENCLAW_STATE_DIR = '/tmp/fake-state';
	const p = getLogPath();
	assert.equal(p, '/tmp/fake-state/coclaw/upgrade-log.jsonl');
});

test('getLogPath 使用 runtime.state.resolveStateDir', () => {
	resetEnv();
	setRuntime({ state: { resolveStateDir: () => '/custom/state' } });
	const p = getLogPath();
	assert.equal(p, '/custom/state/coclaw/upgrade-log.jsonl');
});

test('getLogPath 默认回退到 ~/.openclaw', () => {
	resetEnv();
	const p = getLogPath();
	assert.equal(p, nodePath.join(os.homedir(), '.openclaw', 'coclaw', 'upgrade-log.jsonl'));
});

// --- readState ---

test('readState 文件不存在时返回空对象', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const state = await readState();
		assert.deepEqual(state, {});
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('readState 文件存在时返回解析后的对象', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const stateDir = nodePath.join(dir, 'coclaw');
		await fs.mkdir(stateDir, { recursive: true });
		const data = { skippedVersions: ['1.0.0'], lastCheck: '2026-03-12T00:00:00.000Z' };
		await fs.writeFile(nodePath.join(stateDir, 'upgrade-state.json'), JSON.stringify(data), 'utf8');

		const state = await readState();
		assert.deepEqual(state, data);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('readState 空白文件返回空对象', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const stateDir = nodePath.join(dir, 'coclaw');
		await fs.mkdir(stateDir, { recursive: true });
		await fs.writeFile(nodePath.join(stateDir, 'upgrade-state.json'), '  \n\t  ', 'utf8');

		const state = await readState();
		assert.deepEqual(state, {});
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('readState 无效 JSON 抛出异常', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const stateDir = nodePath.join(dir, 'coclaw');
		await fs.mkdir(stateDir, { recursive: true });
		await fs.writeFile(nodePath.join(stateDir, 'upgrade-state.json'), '{bad json', 'utf8');

		await assert.rejects(() => readState());
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('readState 非 ENOENT 错误向上抛出', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		// 创建同名目录使读文件失败（EISDIR）
		const stateDir = nodePath.join(dir, 'coclaw');
		await fs.mkdir(nodePath.join(stateDir, 'upgrade-state.json'), { recursive: true });

		await assert.rejects(() => readState(), (err) => {
			assert.notEqual(err.code, 'ENOENT');
			return true;
		});
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// --- writeState ---

test('writeState 创建目录并写入文件', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const data = { skippedVersions: ['2.0.0'] };
		await writeState(data);

		const raw = await fs.readFile(getStatePath(), 'utf8');
		assert.deepEqual(JSON.parse(raw), data);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('writeState 覆盖已有文件', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await writeState({ a: 1 });
		await writeState({ b: 2 });

		const raw = await fs.readFile(getStatePath(), 'utf8');
		const parsed = JSON.parse(raw);
		assert.equal(parsed.a, undefined);
		assert.equal(parsed.b, 2);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// --- addSkippedVersion ---

test('addSkippedVersion 添加版本', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await addSkippedVersion('1.0.0');
		const state = await readState();
		assert.deepEqual(state.skippedVersions, ['1.0.0']);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('addSkippedVersion 不重复添加', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await addSkippedVersion('1.0.0');
		await addSkippedVersion('1.0.0');
		const state = await readState();
		assert.deepEqual(state.skippedVersions, ['1.0.0']);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('addSkippedVersion 原 skippedVersions 非数组时创建新数组', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await writeState({ skippedVersions: 'invalid' });
		await addSkippedVersion('2.0.0');
		const state = await readState();
		assert.deepEqual(state.skippedVersions, ['2.0.0']);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// --- updateLastCheck ---

test('updateLastCheck 写入 ISO 时间戳', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const before = new Date().toISOString();
		await updateLastCheck();
		const after = new Date().toISOString();

		const state = await readState();
		assert.ok(state.lastCheck >= before);
		assert.ok(state.lastCheck <= after);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('updateLastCheck 保留已有字段', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await writeState({ skippedVersions: ['1.0.0'] });
		await updateLastCheck();
		const state = await readState();
		assert.deepEqual(state.skippedVersions, ['1.0.0']);
		assert.ok(state.lastCheck);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// --- updateLastUpgrade ---

test('updateLastUpgrade 写入升级信息和时间戳', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const before = new Date().toISOString();
		await updateLastUpgrade({ from: '1.0.0', to: '2.0.0', result: 'success' });
		const after = new Date().toISOString();

		const state = await readState();
		assert.equal(state.lastUpgrade.from, '1.0.0');
		assert.equal(state.lastUpgrade.to, '2.0.0');
		assert.equal(state.lastUpgrade.result, 'success');
		assert.ok(state.lastUpgrade.ts >= before);
		assert.ok(state.lastUpgrade.ts <= after);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('updateLastUpgrade 保留已有字段', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await writeState({ lastCheck: '2026-01-01T00:00:00.000Z' });
		await updateLastUpgrade({ from: '1.0.0', to: '2.0.0', result: 'success' });
		const state = await readState();
		assert.equal(state.lastCheck, '2026-01-01T00:00:00.000Z');
		assert.ok(state.lastUpgrade);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// --- appendLog ---

test('appendLog 创建文件并追加 JSONL 行', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await appendLog({ from: '1.0.0', to: '2.0.0', result: 'success' });
		await appendLog({ from: '2.0.0', to: '3.0.0', result: 'fail', error: 'timeout' });

		const raw = await fs.readFile(getLogPath(), 'utf8');
		const lines = raw.trim().split('\n');
		assert.equal(lines.length, 2);

		const first = JSON.parse(lines[0]);
		assert.equal(first.from, '1.0.0');
		assert.equal(first.to, '2.0.0');
		assert.ok(first.ts);

		const second = JSON.parse(lines[1]);
		assert.equal(second.error, 'timeout');
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// --- trimLog ---

test('appendLog 超过 200 行时截断到 100 行', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const logPath = getLogPath();
		await fs.mkdir(nodePath.dirname(logPath), { recursive: true });

		// 预写 200 行
		const preLines = [];
		for (let i = 0; i < 200; i++) {
			preLines.push(JSON.stringify({ ts: `t${i}`, seq: i }));
		}
		await fs.writeFile(logPath, preLines.join('\n') + '\n', 'utf8');

		// 追加第 201 行，触发 trimLog
		await appendLog({ from: '1.0.0', to: '2.0.0', result: 'ok' });

		const raw = await fs.readFile(logPath, 'utf8');
		const lines = raw.trim().split('\n');
		// 截断保留最近 100 行
		assert.equal(lines.length, 100);

		// 验证保留的是最后 100 行（含刚追加的）
		const last = JSON.parse(lines[lines.length - 1]);
		assert.equal(last.result, 'ok');
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('appendLog 未超过 200 行时不截断', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		for (let i = 0; i < 5; i++) {
			await appendLog({ seq: i, from: '1.0.0', to: '2.0.0', result: 'ok' });
		}

		const raw = await fs.readFile(getLogPath(), 'utf8');
		const lines = raw.trim().split('\n');
		assert.equal(lines.length, 5);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// --- trimLog ---

test('trimLog 内部异常被静默捕获，不影响 appendLog', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const logPath = getLogPath();
		await fs.mkdir(nodePath.dirname(logPath), { recursive: true });

		// 预写 201 行使 trimLog 进入截断路径
		const preLines = [];
		for (let i = 0; i < 201; i++) {
			preLines.push(JSON.stringify({ ts: `t${i}`, seq: i }));
		}
		await fs.writeFile(logPath, preLines.join('\n') + '\n', 'utf8');

		// mock fs.writeFile 在 trimLog 写回时抛异常
		// trimLog 改 atomic 后写入路径是 `${logPath}.${uuid}.tmp`，不再等于 logPath
		const origWriteFile = fs.writeFile;
		mock.method(fs, 'writeFile', async (...args) => {
			const target = args[0];
			if (typeof target === 'string' && target.startsWith(logPath)) {
				throw new Error('mock write failure');
			}
			return origWriteFile.apply(fs, args);
		});

		// appendLog 使用 appendFile（不受 mock 影响），trimLog 内部 writeFile 失败被捕获
		await assert.doesNotReject(() => appendLog({ from: '1.0.0', to: '2.0.0', result: 'ok' }));

		mock.restoreAll();

		// 验证追加的行仍在文件中（trimLog 截断失败，文件未被截断）
		const raw = await fs.readFile(logPath, 'utf8');
		const lines = raw.trim().split('\n');
		// 原 201 行 + 追加的 1 行 = 202（因为 trimLog 失败未截断）
		assert.equal(lines.length, 202);
	}
	finally {
		mock.restoreAll();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// --- atomic 写保护：写入中途失败不损坏原文件 ---

test('writeState 写入中途崩溃保留原 state 文件（atomic 保护）', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const statePath = getStatePath();
		// 先写入合法 state
		await writeState({ a: 1, b: 'keep' });
		assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')), { a: 1, b: 'keep' });

		// 模拟"裸 fs.writeFile O_TRUNC 后 write syscall 失败"的真实损坏场景：
		// 拦截对 statePath 的直接写入，先 truncate 再抛错（复刻裸路径行为）。
		// atomic 写到 statePath.tmp 时也注入失败（统一磁盘问题），但不 truncate 原文件。
		const origWriteFile = fs.writeFile;
		mock.method(fs, 'writeFile', async (target, ...rest) => {
			if (target === statePath) {
				await fs.truncate(target, 0);
				throw new Error('mid-syscall fail');
			}
			if (typeof target === 'string' && target.startsWith(`${statePath}.`)) {
				throw new Error('mid-syscall fail');
			}
			return origWriteFile(target, ...rest);
		});

		await assert.rejects(() => writeState({ a: 999 }));

		mock.restoreAll();

		// 关键断言：原文件应保持完整可读
		// 修前（裸 fs.writeFile）：truncate 已发生 + write 抛 → 文件被清空 → JSON.parse 抛
		// 修后（atomic）：fs.writeFile(tmp) 抛 → rename 未发生 → 原文件未动
		const raw = await fs.readFile(statePath, 'utf8');
		assert.deepEqual(JSON.parse(raw), { a: 1, b: 'keep' });
	}
	finally {
		mock.restoreAll();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// --- inflight helpers ---

test('writeInflight 写入 inflight 并附 ts；readInflight 读回', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		assert.equal(await readInflight(), null);

		await writeInflight({ from: '1.0.0', to: '1.1.0', verifyTarget: '1.1.0', pluginDir: '/opt/p', phase: 'update' });

		const inflight = await readInflight();
		assert.equal(inflight.from, '1.0.0');
		assert.equal(inflight.to, '1.1.0');
		assert.equal(inflight.verifyTarget, '1.1.0');
		assert.equal(inflight.pluginDir, '/opt/p');
		assert.equal(inflight.phase, 'update');
		assert.match(inflight.ts, /^\d{4}-\d{2}-\d{2}T/);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('writeInflight 保留 state 其它字段', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await writeState({ lastCheck: '2026-01-01T00:00:00.000Z' });
		await writeInflight({ from: '1.0.0', to: '1.1.0', verifyTarget: '1.1.0', pluginDir: '/opt/p', phase: 'update' });
		const state = await readState();
		assert.equal(state.lastCheck, '2026-01-01T00:00:00.000Z');
		assert.ok(state.inflight);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('updateInflight 合并 patch（phase 推进 / verifyTarget 修正）', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await writeInflight({ from: '1.0.0', to: '1.1.0', verifyTarget: '1.1.0', pluginDir: '/opt/p', phase: 'update' });
		await updateInflight({ phase: 'verify', verifyTarget: '1.0.5' });

		const inflight = await readInflight();
		assert.equal(inflight.phase, 'verify');
		assert.equal(inflight.verifyTarget, '1.0.5');
		// 未 patch 字段保留
		assert.equal(inflight.from, '1.0.0');
		assert.equal(inflight.pluginDir, '/opt/p');
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('updateInflight 无 inflight 时 no-op（迟到更新不复活账目）', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await writeState({ lastCheck: '2026-01-01T00:00:00.000Z' });
		await updateInflight({ phase: 'rollback' });
		const state = await readState();
		assert.equal(state.inflight, undefined);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// --- recordUpgradeTerminal ---

test('recordUpgradeTerminal 一次完成 lastUpgrade + 清 inflight + skipVersion + jsonl', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await writeInflight({ from: '1.0.0', to: '1.1.0', verifyTarget: '1.1.0', pluginDir: '/opt/p', phase: 'verify' });

		await recordUpgradeTerminal({
			from: '1.0.0', to: '1.0.5', result: 'ok', skipVersion: '1.1.0',
		});

		const state = await readState();
		assert.equal(state.lastUpgrade.from, '1.0.0');
		assert.equal(state.lastUpgrade.to, '1.0.5');
		assert.equal(state.lastUpgrade.result, 'ok');
		assert.match(state.lastUpgrade.ts, /^\d{4}-\d{2}-\d{2}T/);
		assert.deepEqual(state.skippedVersions, ['1.1.0']);
		assert.equal(state.inflight, undefined, 'inflight 应在同一次写入中清除');

		const logRaw = await fs.readFile(getLogPath(), 'utf8');
		const entry = JSON.parse(logRaw.trim());
		assert.equal(entry.result, 'ok');
		assert.equal(entry.to, '1.0.5');
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('recordUpgradeTerminal 不带 skipVersion 时不动 skippedVersions；error/phase 进账', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await recordUpgradeTerminal({
			from: '1.0.0', to: '1.1.0', result: 'interrupted', phase: 'verify', error: 'boom',
		});

		const state = await readState();
		assert.equal(state.skippedVersions, undefined);
		assert.equal(state.lastUpgrade.result, 'interrupted');
		assert.equal(state.lastUpgrade.phase, 'verify');
		assert.equal(state.lastUpgrade.error, 'boom');

		const entry = JSON.parse((await fs.readFile(getLogPath(), 'utf8')).trim());
		assert.equal(entry.phase, 'verify');
		assert.equal(entry.error, 'boom');
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('recordUpgradeTerminal lastUpgrade.error 截断保尾部，jsonl 保留完整', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		const longErr = `${'x'.repeat(1700)}TAIL`;
		await recordUpgradeTerminal({
			from: '1.0.0', to: '1.1.0', result: 'rollback', error: longErr,
		});

		const state = await readState();
		assert.equal(state.lastUpgrade.error.length, 1600);
		assert.ok(state.lastUpgrade.error.endsWith('TAIL'), '截断须保尾部（真因在尾部）');

		const entry = JSON.parse((await fs.readFile(getLogPath(), 'utf8')).trim());
		assert.equal(entry.error, longErr);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('recordUpgradeTerminal skipVersion 去重（已在列表时不重复）', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await writeState({ skippedVersions: ['1.1.0'] });
		await recordUpgradeTerminal({
			from: '1.0.0', to: '1.1.0', result: 'noop-skip', skipVersion: '1.1.0',
		});
		const state = await readState();
		assert.deepEqual(state.skippedVersions, ['1.1.0']);
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('recordUpgradeTerminal 终态是单次 state 写入（lastUpgrade 与清 inflight 不拆两次写）', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await writeInflight({ from: '1.0.0', to: '1.1.0', verifyTarget: '1.1.0', pluginDir: '/opt/p', phase: 'verify' });

		// 拦截底层写函数计数：atomic 写 state 走 fs.writeFile(`${statePath}.<uuid>.tmp`)
		const statePath = getStatePath();
		const stateWrites = [];
		const origWriteFile = fs.writeFile;
		mock.method(fs, 'writeFile', async (target, data, ...rest) => {
			if (typeof target === 'string' && target.startsWith(`${statePath}.`)) {
				stateWrites.push(String(data));
			}
			return origWriteFile(target, data, ...rest);
		});

		await recordUpgradeTerminal({ from: '1.0.0', to: '1.1.0', result: 'ok', skipVersion: '1.1.0' });

		mock.restoreAll();

		// 防回归锚：终态若拆成"先写 lastUpgrade、再清 inflight"两次写，
		// 中间崩溃会留下"账已记但 inflight 残留"的矛盾态
		assert.equal(stateWrites.length, 1, '整个终态操作只允许一次 state 文件写入');
		const written = JSON.parse(stateWrites[0]);
		assert.equal(written.lastUpgrade.result, 'ok');
		assert.deepEqual(written.skippedVersions, ['1.1.0']);
		assert.equal(written.inflight, undefined, '同一次写入须同时含 lastUpgrade 与 inflight 清除');
	}
	finally {
		mock.restoreAll();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('recordUpgradeTerminal jsonl 追加失败不抛（best-effort），终态仍落盘', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		// 在 log 路径处预置目录，使 appendFile 报 EISDIR
		await fs.mkdir(getLogPath(), { recursive: true });

		await assert.doesNotReject(() => recordUpgradeTerminal({
			from: '1.0.0', to: '1.1.0', result: 'ok',
		}));

		const state = await readState();
		assert.equal(state.lastUpgrade.result, 'ok');
	}
	finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('recordUpgradeTerminal 终态写失败时抛出且 inflight 保留（下轮对账可见）', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	try {
		await writeInflight({ from: '1.0.0', to: '1.1.0', verifyTarget: '1.1.0', pluginDir: '/opt/p', phase: 'update' });

		const statePath = getStatePath();
		const origWriteFile = fs.writeFile;
		mock.method(fs, 'writeFile', async (target, ...rest) => {
			// 拦截 atomic 写 state 的 tmp 文件
			if (typeof target === 'string' && target.startsWith(`${statePath}.`)) {
				throw new Error('disk full');
			}
			return origWriteFile(target, ...rest);
		});

		await assert.rejects(() => recordUpgradeTerminal({ from: '1.0.0', to: '1.1.0', result: 'ok' }));

		mock.restoreAll();

		const inflight = await readInflight();
		assert.ok(inflight, '终态写失败时 inflight 不得被清');
	}
	finally {
		mock.restoreAll();
		await fs.rm(dir, { recursive: true, force: true });
	}
});
