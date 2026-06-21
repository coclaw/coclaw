import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { checkForUpdate, getLatestVersion, getPackageInfo, inspectPluginInstall, isNewerVersion, isPrereleaseVersion } from './updater-check.js';
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

// --- inspectPluginInstall ---

test('inspectPluginInstall - 正常解析 install 记录，execFile 选项对齐先例', async () => {
	const calls = [];
	const fn = (cmd, args, opts, cb) => {
		calls.push({ cmd, args: [...args], opts });
		cb(null, JSON.stringify({
			plugin: { id: 'test-plugin' },
			install: { source: 'npm', installPath: '/opt/p', version: '1.2.3' },
		}));
	};
	const result = await inspectPluginInstall('test-plugin', { execFileFn: fn });
	assert.equal(result.ok, true);
	assert.deepEqual(result.install, { source: 'npm', installPath: '/opt/p', version: '1.2.3' });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].cmd, 'openclaw');
	assert.deepEqual(calls[0].args, ['plugins', 'inspect', 'test-plugin', '--json']);
	// 30s timeout + win32 shell：对齐 npm view / worker runCmd 先例
	assert.equal(calls[0].opts.timeout, 30_000);
	assert.equal(calls[0].opts.shell, process.platform === 'win32');
});

test('inspectPluginInstall - JSON 中无 install 字段时返回 install=null（无安装记录）', async () => {
	const fn = mockExecFile(null, JSON.stringify({ plugin: { id: 'test-plugin' } }));
	const result = await inspectPluginInstall('test-plugin', { execFileFn: fn });
	assert.deepEqual(result, { ok: true, install: null });
});

test('inspectPluginInstall - install 字段非对象时返回 install=null', async () => {
	const fn = mockExecFile(null, JSON.stringify({ install: 'weird' }));
	const result = await inspectPluginInstall('test-plugin', { execFileFn: fn });
	assert.deepEqual(result, { ok: true, install: null });
});

test('inspectPluginInstall - CLI 退出非 0 时返回 ok=false（真失败）', async () => {
	const fn = mockExecFile(new Error('exit 1'), '');
	const result = await inspectPluginInstall('test-plugin', { execFileFn: fn });
	assert.equal(result.ok, false);
	assert.match(result.reason, /inspect failed.*exit 1/);
});

test('inspectPluginInstall - 输出非 JSON 时返回 ok=false（真失败）', async () => {
	const fn = mockExecFile(null, 'Usage: openclaw plugins ...');
	const result = await inspectPluginInstall('test-plugin', { execFileFn: fn });
	assert.equal(result.ok, false);
	assert.match(result.reason, /not valid JSON/);
});

test('inspectPluginInstall - stdout 为 Buffer 时正常转字符串', async () => {
	const fn = (_cmd, _args, _opts, cb) => cb(null, Buffer.from(JSON.stringify({ install: { source: 'npm' } })));
	const result = await inspectPluginInstall('test-plugin', { execFileFn: fn });
	assert.equal(result.ok, true);
	assert.equal(result.install.source, 'npm');
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

// build metadata（`+` 后缀）：先剥 `+` 再剥 `-`，core 段参与比较
test('isNewerVersion - a 带 build metadata 时仍按 core 段判更大', () => {
	assert.equal(isNewerVersion('1.0.1+b', '1.0.0'), true);
});

test('isNewerVersion - b 带 build metadata 时 a 更小', () => {
	assert.equal(isNewerVersion('1.0.0', '1.0.1+b'), false);
});

test('isNewerVersion - core 段相同、仅 build metadata 不同视为相等', () => {
	assert.equal(isNewerVersion('1.0.0+b', '1.0.0'), false);
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

// --- isPrereleaseVersion（semver 语义：build metadata 不算 prerelease）---

test('isPrereleaseVersion - 正式版本不是 prerelease', () => {
	assert.equal(isPrereleaseVersion('1.2.3'), false);
});

test('isPrereleaseVersion - 含 prerelease 段', () => {
	assert.equal(isPrereleaseVersion('1.2.3-beta.1'), true);
	assert.equal(isPrereleaseVersion('1.2.3-rc-1'), true);
});

test('isPrereleaseVersion - 纯 build metadata 不是 prerelease（裸 indexOf("-") 的坑）', () => {
	assert.equal(isPrereleaseVersion('1.2.3+build.5'), false);
	assert.equal(isPrereleaseVersion('1.2.3+exp-sha.5114f85'), false);
});

test('isPrereleaseVersion - prerelease + build metadata 仍是 prerelease', () => {
	assert.equal(isPrereleaseVersion('1.2.3-rc.1+build.5'), true);
});

// --- checkForUpdate prerelease 闸 ---

test('checkForUpdate - latest 是 prerelease 时返回 unavailable + prerelease 标记，不写 skip', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	const pluginDir = await makeTmpDir('coclaw-checker-pkg-');
	await fs.writeFile(
		nodePath.join(pluginDir, 'package.json'),
		JSON.stringify({ name: '@test/pkg', version: '1.0.0' }),
		'utf8',
	);

	const fn = mockExecFile(null, '1.1.0-rc.1\n');
	const result = await checkForUpdate({ execFileFn: fn, pluginDir });
	assert.equal(result.available, false);
	assert.equal(result.prerelease, true);
	assert.equal(result.latestVersion, '1.1.0-rc.1');
	assert.equal(result.currentVersion, '1.0.0');
	assert.equal(result.pkgName, '@test/pkg');

	// 闸不落持久状态：不写 skip / lastUpgrade；lastCheck 照旧推进
	const statePath = nodePath.join(dir, 'coclaw', 'upgrade-state.json');
	const stateRaw = JSON.parse(await fs.readFile(statePath, 'utf8'));
	assert.equal(stateRaw.skippedVersions, undefined);
	assert.equal(stateRaw.lastUpgrade, undefined);
	assert.equal(typeof stateRaw.lastCheck, 'string');
});

test('checkForUpdate - latest 带纯 build metadata 时不触发 prerelease 闸', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;
	const pluginDir = await makeTmpDir('coclaw-checker-pkg-');
	await fs.writeFile(
		nodePath.join(pluginDir, 'package.json'),
		JSON.stringify({ name: '@test/pkg', version: '1.0.0' }),
		'utf8',
	);

	const fn = mockExecFile(null, '1.1.0+build.7\n');
	const result = await checkForUpdate({ execFileFn: fn, pluginDir });
	assert.equal(result.available, true);
	assert.equal(result.prerelease, undefined);
	assert.equal(result.latestVersion, '1.1.0+build.7');
});
