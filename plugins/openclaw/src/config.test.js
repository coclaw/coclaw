import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { clearConfig, getBindingsPath, readConfig, writeConfig } from './config.js';
import { setRuntime } from './runtime.js';

function resetEnv() {
	delete process.env.OPENCLAW_CONFIG_PATH;
	delete process.env.OPENCLAW_STATE_DIR;
	setRuntime(null);
}

async function makeTmpDir(prefix = 'coclaw-cfg-') {
	return await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
}

test('getBindingsPath should use OPENCLAW_STATE_DIR when set', () => {
	resetEnv();
	process.env.OPENCLAW_STATE_DIR = '/tmp/fake-state';
	const p = getBindingsPath();
	assert.equal(p, '/tmp/fake-state/coclaw/bindings.json');
});

test('getBindingsPath should use runtime.state.resolveStateDir when available', () => {
	resetEnv();
	setRuntime({ state: { resolveStateDir: () => '/custom/state' } });
	const p = getBindingsPath();
	assert.equal(p, '/custom/state/coclaw/bindings.json');
});

test('getBindingsPath should default to ~/.openclaw/coclaw/bindings.json', () => {
	resetEnv();
	const p = getBindingsPath();
	assert.equal(p, nodePath.join(os.homedir(), '.openclaw', 'coclaw', 'bindings.json'));
});

test('writeConfig/readConfig should persist to bindings.json', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	await writeConfig({
		serverUrl: 'http://localhost:5173',
		botId: 'b1',
		token: 't1',
		boundAt: '2026-03-04T00:00:00.000Z',
	});

	const loaded = await readConfig();
	assert.equal(loaded.serverUrl, 'http://localhost:5173');
	assert.equal(loaded.botId, 'b1');
	assert.equal(loaded.token, 't1');
	assert.equal(loaded.boundAt, '2026-03-04T00:00:00.000Z');

	// 验证文件结构
	const raw = JSON.parse(await fs.readFile(getBindingsPath(), 'utf8'));
	assert.equal(raw.default.botId, 'b1');
	assert.equal(raw.default.token, 't1');
});

test('writeConfig should merge with existing data', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	await writeConfig({ serverUrl: 'http://s1', botId: 'b1', token: 't1' });
	await writeConfig({ token: 't2' });

	const loaded = await readConfig();
	assert.equal(loaded.serverUrl, 'http://s1');
	assert.equal(loaded.botId, 'b1');
	assert.equal(loaded.token, 't2');
});

test('readConfig should return empty entry when no bindings exist', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	const loaded = await readConfig();
	assert.equal(loaded.token, undefined);
	assert.equal(loaded.botId, undefined);
});

test('readConfig should throw for invalid json', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	const bindingsPath = nodePath.join(dir, 'coclaw', 'bindings.json');
	await fs.mkdir(nodePath.dirname(bindingsPath), { recursive: true });
	await fs.writeFile(bindingsPath, '{bad', 'utf8');

	await assert.rejects(() => readConfig());
});

test('readConfig should treat empty file as empty object', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	const bindingsPath = nodePath.join(dir, 'coclaw', 'bindings.json');
	await fs.mkdir(nodePath.dirname(bindingsPath), { recursive: true });
	await fs.writeFile(bindingsPath, '   \n\t', 'utf8');

	const loaded = await readConfig();
	assert.equal(loaded.token, undefined);
});

test('clearConfig should remove account and delete file when empty', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	await writeConfig({ botId: 'b1', token: 't1', serverUrl: 'http://s1' });
	const bindingsPath = getBindingsPath();

	// 确认写入
	const before = JSON.parse(await fs.readFile(bindingsPath, 'utf8'));
	assert.equal(before.default.token, 't1');

	await clearConfig();

	// 文件应被删除
	await assert.rejects(() => fs.access(bindingsPath), { code: 'ENOENT' });
});

test('clearConfig should keep other accounts when clearing one', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	// 写入两个 account
	await writeConfig({ botId: 'b1', token: 't1' }, 'default');
	await writeConfig({ botId: 'b2', token: 't2' }, 'secondary');

	// 删除 default，secondary 应保留
	await clearConfig('default');
	const bindingsPath = getBindingsPath();
	const raw = JSON.parse(await fs.readFile(bindingsPath, 'utf8'));
	assert.equal(raw.default, undefined);
	assert.equal(raw.secondary.token, 't2');
});
