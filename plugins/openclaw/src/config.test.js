import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { clearConfig, getBindingsPath, readConfig, writeConfig } from './config.js';
import { setRuntime } from './runtime.js';

function setStateDir(dir) {
	setRuntime({ state: { resolveStateDir: () => dir } });
}

function reset() {
	setRuntime(null);
}

async function makeTmpDir(prefix = 'coclaw-cfg-') {
	return await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
}

test('getBindingsPath should use runtime.state.resolveStateDir', () => {
	setStateDir('/custom/state');
	try {
		const p = getBindingsPath();
		assert.equal(p, '/custom/state/coclaw/bindings.json');
	}
	finally {
		reset();
	}
});

test('getBindingsPath should throw when runtime not injected', () => {
	reset();
	assert.throws(() => getBindingsPath(), /runtime not injected/);
});

test('writeConfig/readConfig should persist to bindings.json', async () => {
	const dir = await makeTmpDir();
	setStateDir(dir);
	try {
		await writeConfig({
			serverUrl: 'http://localhost:5173',
			clawId: 'b1',
			token: 't1',
			boundAt: '2026-03-04T00:00:00.000Z',
		});

		const loaded = await readConfig();
		assert.equal(loaded.serverUrl, 'http://localhost:5173');
		assert.equal(loaded.clawId, 'b1');
		assert.equal(loaded.token, 't1');
		assert.equal(loaded.boundAt, '2026-03-04T00:00:00.000Z');

		// 验证文件结构
		const raw = JSON.parse(await fs.readFile(getBindingsPath(), 'utf8'));
		assert.equal(raw.default.clawId, 'b1');
		assert.equal(raw.default.token, 't1');
	}
	finally {
		reset();
	}
});

test('writeConfig should merge with existing data', async () => {
	const dir = await makeTmpDir();
	setStateDir(dir);
	try {
		await writeConfig({ serverUrl: 'http://s1', clawId: 'b1', token: 't1' });
		await writeConfig({ token: 't2' });

		const loaded = await readConfig();
		assert.equal(loaded.serverUrl, 'http://s1');
		assert.equal(loaded.clawId, 'b1');
		assert.equal(loaded.token, 't2');
	}
	finally {
		reset();
	}
});

test('readConfig should return empty entry when no bindings exist', async () => {
	const dir = await makeTmpDir();
	setStateDir(dir);
	try {
		const loaded = await readConfig();
		assert.equal(loaded.token, undefined);
		assert.equal(loaded.clawId, undefined);
	}
	finally {
		reset();
	}
});

test('readConfig should delete corrupt file, log warning, and return empty', async () => {
	const dir = await makeTmpDir();
	setStateDir(dir);
	const bindingsPath = nodePath.join(dir, 'coclaw', 'bindings.json');
	await fs.mkdir(nodePath.dirname(bindingsPath), { recursive: true });
	await fs.writeFile(bindingsPath, '{bad', 'utf8');

	const warns = [];
	const origWarn = console.warn;
	console.warn = (...args) => warns.push(args.join(' '));
	try {
		const loaded = await readConfig();
		assert.deepEqual(loaded, {});
		// 损坏文件应被删除
		await assert.rejects(() => fs.access(bindingsPath), { code: 'ENOENT' });
		// 应输出 warn 日志
		assert.ok(warns.some((w) => w.includes('corrupt bindings file deleted') && w.includes(bindingsPath)), 'should warn about corrupt file');
	}
	finally {
		console.warn = origWarn;
		reset();
	}
});

test('readConfig should treat empty file as empty object', async () => {
	const dir = await makeTmpDir();
	setStateDir(dir);
	const bindingsPath = nodePath.join(dir, 'coclaw', 'bindings.json');
	await fs.mkdir(nodePath.dirname(bindingsPath), { recursive: true });
	await fs.writeFile(bindingsPath, '   \n\t', 'utf8');

	try {
		const loaded = await readConfig();
		assert.equal(loaded.token, undefined);
	}
	finally {
		reset();
	}
});

test('clearConfig should remove account and delete file when empty', async () => {
	const dir = await makeTmpDir();
	setStateDir(dir);
	try {
		await writeConfig({ clawId: 'b1', token: 't1', serverUrl: 'http://s1' });
		const bindingsPath = getBindingsPath();

		// 确认写入
		const before = JSON.parse(await fs.readFile(bindingsPath, 'utf8'));
		assert.equal(before.default.token, 't1');

		await clearConfig();

		// 文件应被删除
		await assert.rejects(() => fs.access(bindingsPath), { code: 'ENOENT' });
	}
	finally {
		reset();
	}
});

test('clearConfig should keep other accounts when clearing one', async () => {
	const dir = await makeTmpDir();
	setStateDir(dir);
	try {
		// 写入两个 account
		await writeConfig({ clawId: 'b1', token: 't1' }, 'default');
		await writeConfig({ clawId: 'b2', token: 't2' }, 'secondary');

		// 删除 default，secondary 应保留
		await clearConfig('default');
		const bindingsPath = getBindingsPath();
		const raw = JSON.parse(await fs.readFile(bindingsPath, 'utf8'));
		assert.equal(raw.default, undefined);
		assert.equal(raw.secondary.token, 't2');
	}
	finally {
		reset();
	}
});

test('readConfig should map legacy botId to clawId for backward compat', async () => {
	const dir = await makeTmpDir();
	setStateDir(dir);
	const bindingsPath = nodePath.join(dir, 'coclaw', 'bindings.json');
	await fs.mkdir(nodePath.dirname(bindingsPath), { recursive: true });

	// 模拟旧格式 bindings.json（使用 botId）
	await fs.writeFile(bindingsPath, JSON.stringify({
		default: { serverUrl: 'http://s1', botId: 'legacy-bot', token: 't1' },
	}), 'utf8');

	try {
		const loaded = await readConfig();
		assert.equal(loaded.clawId, 'legacy-bot');
		assert.equal(loaded.botId, 'legacy-bot'); // 原始字段仍存在
	}
	finally {
		reset();
	}
});
