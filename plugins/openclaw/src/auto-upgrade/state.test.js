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
	readState,
	updateLastCheck,
	updateLastUpgrade,
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
		const origWriteFile = fs.writeFile;
		mock.method(fs, 'writeFile', async (...args) => {
			// trimLog 调用 writeFile 时使 logPath 为参数
			if (args[0] === logPath) {
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
