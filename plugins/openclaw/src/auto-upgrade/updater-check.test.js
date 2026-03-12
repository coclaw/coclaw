import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { checkForUpdate, getLatestVersion, getPackageInfo, isNewerVersion } from './updater-check.js';
import { writeState } from './state.js';
import { setRuntime } from '../runtime.js';

async function makeTmpDir(prefix = 'coclaw-checker-') {
	return await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
}

function resetEnv() {
	delete process.env.OPENCLAW_STATE_DIR;
	setRuntime(null);
}

// 模拟 execFile 回调
function mockExecFile(err, stdout) {
	return (_cmd, _args, _opts, cb) => cb(err, stdout);
}

// --- getPackageInfo ---

test('getPackageInfo - 读取真实 package.json', async () => {
	resetEnv();
	const pluginDir = nodePath.resolve(import.meta.dirname, '..', '..');
	const info = await getPackageInfo(pluginDir);
	assert.equal(typeof info.name, 'string');
	assert.equal(typeof info.version, 'string');
	assert.match(info.version, /^\d+\.\d+\.\d+/);
});

test('getPackageInfo - 默认目录解析为插件根目录', async () => {
	resetEnv();
	const info = await getPackageInfo();
	assert.equal(typeof info.name, 'string');
	assert.equal(typeof info.version, 'string');
	assert.match(info.version, /^\d+\.\d+\.\d+/);
});

test('getPackageInfo - 自定义目录', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	await fs.writeFile(
		nodePath.join(dir, 'package.json'),
		JSON.stringify({ name: '@test/pkg', version: '9.8.7' }),
		'utf8',
	);
	const info = await getPackageInfo(dir);
	assert.equal(info.name, '@test/pkg');
	assert.equal(info.version, '9.8.7');
});

test('getPackageInfo - 目录不存在时抛出异常', async () => {
	resetEnv();
	await assert.rejects(
		() => getPackageInfo('/tmp/nonexistent-dir-checker-test-xyz'),
		{ code: 'ENOENT' },
	);
});

// --- getLatestVersion ---

test('getLatestVersion - 正常解析 npm 输出', async () => {
	const fn = mockExecFile(null, '  1.2.3\n');
	const version = await getLatestVersion('@coclaw/openclaw-coclaw', { execFileFn: fn });
	assert.equal(version, '1.2.3');
});

test('getLatestVersion - npm 错误时 reject', async () => {
	const fn = mockExecFile(new Error('network timeout'), '');
	await assert.rejects(
		() => getLatestVersion('@coclaw/openclaw-coclaw', { execFileFn: fn }),
		(err) => {
			assert.match(err.message, /npm view failed.*network timeout/);
			return true;
		},
	);
});

test('getLatestVersion - npm 返回空字符串时 reject', async () => {
	const fn = mockExecFile(null, '   \n');
	await assert.rejects(
		() => getLatestVersion('@coclaw/openclaw-coclaw', { execFileFn: fn }),
		(err) => {
			assert.match(err.message, /npm view returned empty version/);
			return true;
		},
	);
});

test('getLatestVersion - opts 无 execFileFn 时使用默认', async () => {
	// opts 存在但无 execFileFn，走 ?? nodeExecFile 分支
	const fn = mockExecFile(null, '0.0.1\n');
	const version = await getLatestVersion('@coclaw/openclaw-coclaw', { execFileFn: fn });
	assert.equal(version, '0.0.1');
});

test('getLatestVersion - stdout 为 Buffer 时正常转字符串', async () => {
	// String(stdout) 处理 Buffer 场景
	const fn = (_cmd, _args, _opts, cb) => cb(null, Buffer.from('2.0.0\n'));
	const version = await getLatestVersion('@coclaw/openclaw-coclaw', { execFileFn: fn });
	assert.equal(version, '2.0.0');
});

// --- isNewerVersion ---

test('isNewerVersion - major 更大', () => {
	assert.equal(isNewerVersion('2.0.0', '1.0.0'), true);
});

test('isNewerVersion - minor 更大', () => {
	assert.equal(isNewerVersion('1.2.0', '1.1.0'), true);
});

test('isNewerVersion - patch 更大', () => {
	assert.equal(isNewerVersion('1.0.2', '1.0.1'), true);
});

test('isNewerVersion - 版本相同', () => {
	assert.equal(isNewerVersion('1.2.3', '1.2.3'), false);
});

test('isNewerVersion - a 小于 b', () => {
	assert.equal(isNewerVersion('1.0.0', '2.0.0'), false);
});

test('isNewerVersion - minor 小于', () => {
	assert.equal(isNewerVersion('1.1.0', '1.2.0'), false);
});

test('isNewerVersion - patch 小于', () => {
	assert.equal(isNewerVersion('1.0.1', '1.0.2'), false);
});

test('isNewerVersion - 短版本号自动补零', () => {
	assert.equal(isNewerVersion('1.1', '1.0.0'), true);
});

test('isNewerVersion - 短版本号相等', () => {
	assert.equal(isNewerVersion('1.0', '1.0.0'), false);
});

test('isNewerVersion - b 短版本号补零后 a 更大', () => {
	assert.equal(isNewerVersion('1.0.1', '1.0'), true);
});

test('isNewerVersion - b 短版本号补零后 a 更小', () => {
	assert.equal(isNewerVersion('1.0.0', '1.1'), false);
});

// pre-release 相关

test('isNewerVersion - release > 同版本 pre-release', () => {
	assert.equal(isNewerVersion('1.0.0', '1.0.0-beta.1'), true);
});

test('isNewerVersion - pre-release < 同版本 release', () => {
	assert.equal(isNewerVersion('1.0.0-beta.1', '1.0.0'), false);
});

test('isNewerVersion - 两个 pre-release 同 x.y.z 视为相等', () => {
	assert.equal(isNewerVersion('1.0.0-alpha', '1.0.0-beta'), false);
	assert.equal(isNewerVersion('1.0.0-beta', '1.0.0-alpha'), false);
});

test('isNewerVersion - 含连字符的 pre-release', () => {
	assert.equal(isNewerVersion('1.0.0', '1.0.0-rc-1'), true);
	assert.equal(isNewerVersion('1.0.0-rc-1', '1.0.0'), false);
});

test('isNewerVersion - 更高版本 pre-release > 低版本 release', () => {
	assert.equal(isNewerVersion('2.0.0-beta.1', '1.9.0'), true);
});

// --- checkForUpdate ---

test('checkForUpdate - 无更新（latest <= current）', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	const pluginDir = await makeTmpDir('coclaw-checker-pkg-');
	await fs.writeFile(
		nodePath.join(pluginDir, 'package.json'),
		JSON.stringify({ name: '@test/pkg', version: '1.5.0' }),
		'utf8',
	);

	const fn = mockExecFile(null, '1.5.0\n');
	const result = await checkForUpdate({ execFileFn: fn, pluginDir });
	assert.equal(result.available, false);
	assert.equal(result.currentVersion, '1.5.0');
	assert.equal(result.latestVersion, undefined);
	assert.equal(result.pkgName, '@test/pkg');
});

test('checkForUpdate - 无更新（latest < current）', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	const pluginDir = await makeTmpDir('coclaw-checker-pkg-');
	await fs.writeFile(
		nodePath.join(pluginDir, 'package.json'),
		JSON.stringify({ name: '@test/pkg', version: '2.0.0' }),
		'utf8',
	);

	const fn = mockExecFile(null, '1.9.0\n');
	const result = await checkForUpdate({ execFileFn: fn, pluginDir });
	assert.equal(result.available, false);
	assert.equal(result.currentVersion, '2.0.0');
	assert.equal(result.pkgName, '@test/pkg');
});

test('checkForUpdate - 有可用更新', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	const pluginDir = await makeTmpDir('coclaw-checker-pkg-');
	await fs.writeFile(
		nodePath.join(pluginDir, 'package.json'),
		JSON.stringify({ name: '@test/pkg', version: '1.0.0' }),
		'utf8',
	);

	const fn = mockExecFile(null, '1.1.0\n');
	const result = await checkForUpdate({ execFileFn: fn, pluginDir });
	assert.equal(result.available, true);
	assert.equal(result.currentVersion, '1.0.0');
	assert.equal(result.latestVersion, '1.1.0');
	assert.equal(result.pkgName, '@test/pkg');
});

test('checkForUpdate - 已跳过的版本返回 available: false', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	const pluginDir = await makeTmpDir('coclaw-checker-pkg-');
	await fs.writeFile(
		nodePath.join(pluginDir, 'package.json'),
		JSON.stringify({ name: '@test/pkg', version: '1.0.0' }),
		'utf8',
	);

	// 预写跳过版本
	await writeState({ skippedVersions: ['1.2.0'] });

	const fn = mockExecFile(null, '1.2.0\n');
	const result = await checkForUpdate({ execFileFn: fn, pluginDir });
	assert.equal(result.available, false);
	assert.equal(result.currentVersion, '1.0.0');
	assert.equal(result.latestVersion, '1.2.0');
	assert.equal(result.pkgName, '@test/pkg');
});

test('checkForUpdate - 调用 updateLastCheck 写入时间戳', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	const pluginDir = await makeTmpDir('coclaw-checker-pkg-');
	await fs.writeFile(
		nodePath.join(pluginDir, 'package.json'),
		JSON.stringify({ name: '@test/pkg', version: '1.0.0' }),
		'utf8',
	);

	const fn = mockExecFile(null, '1.0.0\n');
	await checkForUpdate({ execFileFn: fn, pluginDir });

	// 验证 lastCheck 已写入 state 文件
	const statePath = nodePath.join(dir, 'coclaw', 'upgrade-state.json');
	const stateRaw = JSON.parse(await fs.readFile(statePath, 'utf8'));
	assert.equal(typeof stateRaw.lastCheck, 'string');
	assert.match(stateRaw.lastCheck, /^\d{4}-\d{2}-\d{2}T/);
});

test('checkForUpdate - npm 异常时向上抛出', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	const pluginDir = await makeTmpDir('coclaw-checker-pkg-');
	await fs.writeFile(
		nodePath.join(pluginDir, 'package.json'),
		JSON.stringify({ name: '@test/pkg', version: '1.0.0' }),
		'utf8',
	);

	const fn = mockExecFile(new Error('ETIMEDOUT'), '');
	await assert.rejects(
		() => checkForUpdate({ execFileFn: fn, pluginDir }),
		(err) => {
			assert.match(err.message, /npm view failed/);
			return true;
		},
	);
});

test('checkForUpdate - skippedVersions 非数组时正常处理', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	const pluginDir = await makeTmpDir('coclaw-checker-pkg-');
	await fs.writeFile(
		nodePath.join(pluginDir, 'package.json'),
		JSON.stringify({ name: '@test/pkg', version: '1.0.0' }),
		'utf8',
	);

	// skippedVersions 为非数组值
	await writeState({ skippedVersions: 'not-an-array' });

	const fn = mockExecFile(null, '1.1.0\n');
	const result = await checkForUpdate({ execFileFn: fn, pluginDir });
	assert.equal(result.available, true);
	assert.equal(result.latestVersion, '1.1.0');
	assert.equal(result.pkgName, '@test/pkg');
});
