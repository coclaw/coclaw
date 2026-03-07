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

test('readConfig should migrate from openclaw.json channels.coclaw (file)', async () => {
	resetEnv();
	const prevCwd = process.cwd();
	const prevHome = process.env.HOME;
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	// 不存在的 home 和 cwd，避免 legacy 文件干扰
	process.env.HOME = nodePath.join(dir, 'home-empty');
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	// 在旧位置写入配置
	const openclawPath = nodePath.join(dir, 'openclaw.json');
	process.env.OPENCLAW_CONFIG_PATH = openclawPath;
	await fs.writeFile(openclawPath, JSON.stringify({
		channels: {
			coclaw: {
				accounts: {
					default: { serverUrl: 'http://old', botId: 'old-b', token: 'old-t', boundAt: '2026-01-01T00:00:00.000Z' },
				},
			},
		},
	}), 'utf8');

	try {
		const loaded = await readConfig();
		assert.equal(loaded.token, 'old-t');
		assert.equal(loaded.botId, 'old-b');
		assert.equal(loaded.serverUrl, 'http://old');

		// 应迁移到新位置
		const raw = JSON.parse(await fs.readFile(getBindingsPath(), 'utf8'));
		assert.equal(raw.default.token, 'old-t');

		// 旧位置应被清理
		const openclawAfter = JSON.parse(await fs.readFile(openclawPath, 'utf8'));
		assert.equal(openclawAfter.channels.coclaw, undefined);
	} finally {
		process.chdir(prevCwd);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
	}
});

test('readConfig should migrate from openclaw.json channels.coclaw (runtime)', async () => {
	resetEnv();
	const prevCwd = process.cwd();
	const prevHome = process.env.HOME;
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.HOME = nodePath.join(dir, 'home-empty');
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const mockCfg = {
		channels: {
			coclaw: {
				accounts: {
					default: { serverUrl: 'http://rt', botId: 'rt-b', token: 'rt-t' },
				},
			},
		},
	};
	let writtenCfg = null;
	setRuntime({
		config: {
			loadConfig: () => structuredClone(mockCfg),
			writeConfigFile: async (cfg) => { writtenCfg = cfg; },
		},
	});

	try {
		const loaded = await readConfig();
		assert.equal(loaded.token, 'rt-t');

		// 迁移到新文件
		const raw = JSON.parse(await fs.readFile(getBindingsPath(), 'utf8'));
		assert.equal(raw.default.token, 'rt-t');

		// runtime 应被调用清理 channels.coclaw
		assert.equal(writtenCfg.channels.coclaw, undefined);
	} finally {
		process.chdir(prevCwd);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
	}
});

test('readConfig should migrate from legacy .coclaw-tunnel.json', async () => {
	resetEnv();
	const prevCwd = process.cwd();
	const prevHome = process.env.HOME;
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.HOME = nodePath.join(dir, 'home-empty');
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	// openclaw.json 无 token
	const openclawPath = nodePath.join(dir, 'openclaw.json');
	process.env.OPENCLAW_CONFIG_PATH = openclawPath;
	await fs.writeFile(openclawPath, JSON.stringify({}), 'utf8');

	// cwd 下的 legacy 文件
	await fs.writeFile(nodePath.join(dir, '.coclaw-tunnel.json'), JSON.stringify({
		botId: 'legacy-b', token: 'legacy-t', serverUrl: 'http://legacy',
	}), 'utf8');

	try {
		const loaded = await readConfig();
		assert.equal(loaded.token, 'legacy-t');
		assert.equal(loaded.botId, 'legacy-b');

		// 迁移到新位置
		const raw = JSON.parse(await fs.readFile(getBindingsPath(), 'utf8'));
		assert.equal(raw.default.token, 'legacy-t');

		// legacy 文件应被清理
		const legacyAfter = JSON.parse(await fs.readFile(nodePath.join(dir, '.coclaw-tunnel.json'), 'utf8'));
		assert.deepEqual(legacyAfter, {});
	} finally {
		process.chdir(prevCwd);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
	}
});

test('clearConfig should remove account and delete file when empty', async () => {
	resetEnv();
	const prevCwd = process.cwd();
	const prevHome = process.env.HOME;
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.HOME = nodePath.join(dir, 'home-empty');
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	// openclaw.json 不含 coclaw（避免 cleanOldLocations 写文件）
	const openclawPath = nodePath.join(dir, 'openclaw.json');
	process.env.OPENCLAW_CONFIG_PATH = openclawPath;
	await fs.writeFile(openclawPath, JSON.stringify({}), 'utf8');

	await writeConfig({ botId: 'b1', token: 't1', serverUrl: 'http://s1' });
	const bindingsPath = getBindingsPath();

	try {
		// 确认写入
		const before = JSON.parse(await fs.readFile(bindingsPath, 'utf8'));
		assert.equal(before.default.token, 't1');

		await clearConfig();

		// 文件应被删除
		await assert.rejects(() => fs.access(bindingsPath), { code: 'ENOENT' });
	} finally {
		process.chdir(prevCwd);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
	}
});

test('clearConfig should also clean old openclaw.json channels.coclaw', async () => {
	resetEnv();
	const prevCwd = process.cwd();
	const prevHome = process.env.HOME;
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.HOME = nodePath.join(dir, 'home-empty');
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	// 旧位置有残留
	const openclawPath = nodePath.join(dir, 'openclaw.json');
	process.env.OPENCLAW_CONFIG_PATH = openclawPath;
	await fs.writeFile(openclawPath, JSON.stringify({
		channels: { coclaw: { accounts: { default: { token: 'old' } } } },
	}), 'utf8');

	// 新位置也有
	await writeConfig({ botId: 'b1', token: 't1' });

	try {
		await clearConfig();

		// 旧位置清理
		const openclawAfter = JSON.parse(await fs.readFile(openclawPath, 'utf8'));
		assert.equal(openclawAfter.channels.coclaw, undefined);
	} finally {
		process.chdir(prevCwd);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
	}
});

test('clearConfig via runtime should clean channels.coclaw and legacy files', async () => {
	resetEnv();
	const prevCwd = process.cwd();
	const prevHome = process.env.HOME;
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.HOME = dir;
	process.chdir(dir);

	const mockCfg = {
		channels: {
			telegram: { accounts: { default: { token: 'tg' } } },
			coclaw: { accounts: { default: { token: 'old' } } },
		},
	};
	let writtenCfg = null;
	setRuntime({
		config: {
			loadConfig: () => structuredClone(mockCfg),
			writeConfigFile: async (cfg) => { writtenCfg = cfg; },
		},
	});

	// legacy 残留
	const legacyPath = nodePath.join(dir, '.coclaw-tunnel.json');
	await fs.writeFile(legacyPath, JSON.stringify({ token: 'legacy' }), 'utf8');

	await writeConfig({ botId: 'b1', token: 't1' });

	try {
		await clearConfig();

		assert.equal(writtenCfg.channels.coclaw, undefined);
		assert.deepEqual(writtenCfg.channels.telegram, { accounts: { default: { token: 'tg' } } });

		const legacyAfter = JSON.parse(await fs.readFile(legacyPath, 'utf8'));
		assert.deepEqual(legacyAfter, {});
	} finally {
		process.chdir(prevCwd);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
	}
});

test('readConfig should not migrate when old location has no token', async () => {
	resetEnv();
	const prevCwd = process.cwd();
	const prevHome = process.env.HOME;
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.HOME = nodePath.join(dir, 'home-empty');
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const openclawPath = nodePath.join(dir, 'openclaw.json');
	process.env.OPENCLAW_CONFIG_PATH = openclawPath;
	await fs.writeFile(openclawPath, JSON.stringify({ channels: { coclaw: {} } }), 'utf8');

	try {
		const loaded = await readConfig();
		assert.equal(loaded.token, undefined);

		// bindings.json 不应被创建
		const bindingsPath = getBindingsPath();
		await assert.rejects(() => fs.access(bindingsPath), { code: 'ENOENT' });
	} finally {
		process.chdir(prevCwd);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
	}
});

test('cleanOldLocations should skip when openclaw.json has no channels.coclaw (no runtime)', async () => {
	resetEnv();
	const prevCwd = process.cwd();
	const prevHome = process.env.HOME;
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.HOME = nodePath.join(dir, 'home-empty');
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const openclawPath = nodePath.join(dir, 'openclaw.json');
	process.env.OPENCLAW_CONFIG_PATH = openclawPath;
	await fs.writeFile(openclawPath, JSON.stringify({ meta: { v: 1 } }), 'utf8');

	await writeConfig({ botId: 'b1', token: 't1' });

	try {
		await clearConfig();

		// openclaw.json 不应被修改（无 channels.coclaw 可清理）
		const openclawAfter = JSON.parse(await fs.readFile(openclawPath, 'utf8'));
		assert.deepEqual(openclawAfter, { meta: { v: 1 } });
	} finally {
		process.chdir(prevCwd);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
	}
});

test('cleanOldLocations via runtime should skip when no channels.coclaw', async () => {
	resetEnv();
	const prevCwd = process.cwd();
	const prevHome = process.env.HOME;
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.HOME = nodePath.join(dir, 'home-empty');
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const mockCfg = { channels: { telegram: { token: 'tg' } } };
	let writeCount = 0;
	setRuntime({
		config: {
			loadConfig: () => structuredClone(mockCfg),
			writeConfigFile: async () => { writeCount++; },
		},
	});

	await writeConfig({ botId: 'b1', token: 't1' });

	try {
		writeCount = 0;
		await clearConfig();
		// 不应调用 writeConfigFile（无 channels.coclaw 可清理）
		assert.equal(writeCount, 0);
	} finally {
		process.chdir(prevCwd);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
	}
});

test('clearConfig should keep other accounts when clearing one', async () => {
	resetEnv();
	const prevCwd = process.cwd();
	const prevHome = process.env.HOME;
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	process.env.HOME = nodePath.join(dir, 'home-empty');
	await fs.mkdir(process.env.HOME, { recursive: true });
	process.chdir(dir);

	const openclawPath = nodePath.join(dir, 'openclaw.json');
	process.env.OPENCLAW_CONFIG_PATH = openclawPath;
	await fs.writeFile(openclawPath, JSON.stringify({}), 'utf8');

	// 写入两个 account
	await writeConfig({ botId: 'b1', token: 't1' }, 'default');
	await writeConfig({ botId: 'b2', token: 't2' }, 'secondary');

	try {
		// 删除 default，secondary 应保留
		await clearConfig('default');
		const bindingsPath = getBindingsPath();
		const raw = JSON.parse(await fs.readFile(bindingsPath, 'utf8'));
		assert.equal(raw.default, undefined);
		assert.equal(raw.secondary.token, 't2');
	} finally {
		process.chdir(prevCwd);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
	}
});
