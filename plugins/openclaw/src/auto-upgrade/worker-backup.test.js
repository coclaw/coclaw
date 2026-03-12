import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';

import {
	createBackup,
	restoreFromBackup,
	removeBackup,
	getBackupDir,
	readVersionFromDir,
} from './worker-backup.js';

// 创建临时目录，内含若干测试文件
async function makeTmpPluginDir() {
	const base = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'backup-test-'));
	const pluginDir = nodePath.join(base, 'my-plugin');
	await fs.mkdir(pluginDir, { recursive: true });
	await fs.writeFile(nodePath.join(pluginDir, 'package.json'), JSON.stringify({ name: 'test', version: '1.2.3' }));
	await fs.mkdir(nodePath.join(pluginDir, 'sub'), { recursive: true });
	await fs.writeFile(nodePath.join(pluginDir, 'sub', 'file.txt'), 'hello');
	return { base, pluginDir };
}

// ── getBackupDir ──

test('getBackupDir 返回 pluginDir + .bak 后缀', () => {
	assert.equal(getBackupDir('/foo/bar'), '/foo/bar.bak');
	assert.equal(getBackupDir('/a/b/c'), '/a/b/c.bak');
});

// ── createBackup ──

test('createBackup 创建 .bak 目录，内容与源一致', async () => {
	const { base, pluginDir } = await makeTmpPluginDir();
	try {
		const backupDir = await createBackup(pluginDir);
		assert.equal(backupDir, `${pluginDir}.bak`);

		// 验证备份内容
		const pkg = JSON.parse(await fs.readFile(nodePath.join(backupDir, 'package.json'), 'utf8'));
		assert.equal(pkg.version, '1.2.3');
		const sub = await fs.readFile(nodePath.join(backupDir, 'sub', 'file.txt'), 'utf8');
		assert.equal(sub, 'hello');
	} finally {
		await fs.rm(base, { recursive: true, force: true });
	}
});

test('createBackup 会先清理已有 .bak 目录', async () => {
	const { base, pluginDir } = await makeTmpPluginDir();
	try {
		// 预先创建一个旧 .bak
		const oldBak = `${pluginDir}.bak`;
		await fs.mkdir(oldBak, { recursive: true });
		await fs.writeFile(nodePath.join(oldBak, 'old.txt'), 'stale');

		const backupDir = await createBackup(pluginDir);

		// old.txt 不应存在
		await assert.rejects(() => fs.access(nodePath.join(backupDir, 'old.txt')));
		// 新内容应存在
		const pkg = JSON.parse(await fs.readFile(nodePath.join(backupDir, 'package.json'), 'utf8'));
		assert.equal(pkg.version, '1.2.3');
	} finally {
		await fs.rm(base, { recursive: true, force: true });
	}
});

test('createBackup 会先清理遗留的 .tmp.bak 目录', async () => {
	const { base, pluginDir } = await makeTmpPluginDir();
	try {
		// 预先创建一个遗留 tmp
		const tmpDir = `${pluginDir}.tmp.bak`;
		await fs.mkdir(tmpDir, { recursive: true });
		await fs.writeFile(nodePath.join(tmpDir, 'tmp.txt'), 'leftover');

		const backupDir = await createBackup(pluginDir);

		// tmp 目录应已被清理/替换
		await assert.rejects(() => fs.access(tmpDir));
		// 备份正常
		assert.equal(backupDir, `${pluginDir}.bak`);
	} finally {
		await fs.rm(base, { recursive: true, force: true });
	}
});

// ── restoreFromBackup ──

test('restoreFromBackup 从备份恢复插件目录', async () => {
	const { base, pluginDir } = await makeTmpPluginDir();
	try {
		// 先创建备份
		await createBackup(pluginDir);

		// 破坏原目录
		await fs.rm(pluginDir, { recursive: true, force: true });
		await fs.mkdir(pluginDir);
		await fs.writeFile(nodePath.join(pluginDir, 'corrupted.txt'), 'bad');

		const result = await restoreFromBackup(pluginDir);
		assert.equal(result, true);

		// 验证恢复后的内容
		const pkg = JSON.parse(await fs.readFile(nodePath.join(pluginDir, 'package.json'), 'utf8'));
		assert.equal(pkg.version, '1.2.3');
		const sub = await fs.readFile(nodePath.join(pluginDir, 'sub', 'file.txt'), 'utf8');
		assert.equal(sub, 'hello');

		// .bak 应已被移走
		await assert.rejects(() => fs.access(`${pluginDir}.bak`));
	} finally {
		await fs.rm(base, { recursive: true, force: true });
	}
});

test('restoreFromBackup 无备份时返回 false', async () => {
	const { base, pluginDir } = await makeTmpPluginDir();
	try {
		const result = await restoreFromBackup(pluginDir);
		assert.equal(result, false);
	} finally {
		await fs.rm(base, { recursive: true, force: true });
	}
});

// ── removeBackup ──

test('removeBackup 删除 .bak 目录', async () => {
	const { base, pluginDir } = await makeTmpPluginDir();
	try {
		await createBackup(pluginDir);
		const bakDir = `${pluginDir}.bak`;
		// 确认存在
		await fs.access(bakDir);

		await removeBackup(pluginDir);

		// 确认已删除
		await assert.rejects(() => fs.access(bakDir));
	} finally {
		await fs.rm(base, { recursive: true, force: true });
	}
});

test('removeBackup 不存在时不抛异常', async () => {
	const { base, pluginDir } = await makeTmpPluginDir();
	try {
		// 没有 .bak 目录，不应抛异常
		await assert.doesNotReject(() => removeBackup(pluginDir));
	} finally {
		await fs.rm(base, { recursive: true, force: true });
	}
});

// ── readVersionFromDir ──

test('readVersionFromDir 读取目录下 package.json 的 version', async () => {
	const { base, pluginDir } = await makeTmpPluginDir();
	try {
		const ver = await readVersionFromDir(pluginDir);
		assert.equal(ver, '1.2.3');
	} finally {
		await fs.rm(base, { recursive: true, force: true });
	}
});

test('readVersionFromDir 目录不存在时抛异常', async () => {
	await assert.rejects(() => readVersionFromDir('/nonexistent/path'));
});
