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
import { setRuntime } from '../runtime.js';

const PLUGIN_ID = 'test-plugin';

// 创建临时环境：state 目录 + 插件目录（含测试文件）
async function makeTmpEnv() {
	const base = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'backup-test-'));
	const pluginDir = nodePath.join(base, 'my-plugin');
	await fs.mkdir(pluginDir, { recursive: true });
	await fs.writeFile(nodePath.join(pluginDir, 'package.json'), JSON.stringify({ name: 'test', version: '1.2.3' }));
	await fs.mkdir(nodePath.join(pluginDir, 'sub'), { recursive: true });
	await fs.writeFile(nodePath.join(pluginDir, 'sub', 'file.txt'), 'hello');

	const stateDir = nodePath.join(base, 'state');
	await fs.mkdir(stateDir, { recursive: true });
	setRuntime(null);
	process.env.OPENCLAW_STATE_DIR = stateDir;

	const backupDir = nodePath.join(stateDir, 'coclaw', 'upgrade-backup', PLUGIN_ID);
	return { base, pluginDir, stateDir, backupDir };
}

async function cleanTmpEnv(base) {
	delete process.env.OPENCLAW_STATE_DIR;
	await fs.rm(base, { recursive: true, force: true });
}

// ── getBackupDir ──

test('getBackupDir 返回 <state-dir>/coclaw/upgrade-backup/<pluginId>（npm 地盘之外）', async () => {
	const { base, stateDir, backupDir } = await makeTmpEnv();
	try {
		assert.equal(getBackupDir(PLUGIN_ID), backupDir);
		// 关键属性：备份不在插件安装目录下（npm prune 免疫）
		assert.ok(getBackupDir(PLUGIN_ID).startsWith(stateDir));
	} finally {
		await cleanTmpEnv(base);
	}
});

// ── createBackup ──

test('createBackup 在 state-dir 备份区创建目录，内容与源一致', async () => {
	const { base, pluginDir, backupDir } = await makeTmpEnv();
	try {
		const created = await createBackup(pluginDir, PLUGIN_ID);
		assert.equal(created, backupDir);

		// 验证备份内容
		const pkg = JSON.parse(await fs.readFile(nodePath.join(backupDir, 'package.json'), 'utf8'));
		assert.equal(pkg.version, '1.2.3');
		const sub = await fs.readFile(nodePath.join(backupDir, 'sub', 'file.txt'), 'utf8');
		assert.equal(sub, 'hello');
	} finally {
		await cleanTmpEnv(base);
	}
});

test('createBackup 会先清理已有备份目录', async () => {
	const { base, pluginDir, backupDir } = await makeTmpEnv();
	try {
		// 预先创建一个旧备份
		await fs.mkdir(backupDir, { recursive: true });
		await fs.writeFile(nodePath.join(backupDir, 'old.txt'), 'stale');

		await createBackup(pluginDir, PLUGIN_ID);

		// old.txt 不应存在
		await assert.rejects(() => fs.access(nodePath.join(backupDir, 'old.txt')));
		// 新内容应存在
		const pkg = JSON.parse(await fs.readFile(nodePath.join(backupDir, 'package.json'), 'utf8'));
		assert.equal(pkg.version, '1.2.3');
	} finally {
		await cleanTmpEnv(base);
	}
});

test('createBackup 会先清理遗留的 .tmp 临时目录', async () => {
	const { base, pluginDir, backupDir } = await makeTmpEnv();
	try {
		// 预先创建一个遗留 tmp
		const tmpDir = `${backupDir}.tmp`;
		await fs.mkdir(tmpDir, { recursive: true });
		await fs.writeFile(nodePath.join(tmpDir, 'tmp.txt'), 'leftover');

		const created = await createBackup(pluginDir, PLUGIN_ID);

		// tmp 目录应已被清理/替换
		await assert.rejects(() => fs.access(tmpDir));
		// 备份正常
		assert.equal(created, backupDir);
	} finally {
		await cleanTmpEnv(base);
	}
});

// ── restoreFromBackup ──

test('restoreFromBackup 从备份恢复插件目录', async () => {
	const { base, pluginDir, backupDir } = await makeTmpEnv();
	try {
		// 先创建备份
		await createBackup(pluginDir, PLUGIN_ID);

		// 破坏原目录
		await fs.rm(pluginDir, { recursive: true, force: true });
		await fs.mkdir(pluginDir);
		await fs.writeFile(nodePath.join(pluginDir, 'corrupted.txt'), 'bad');

		const result = await restoreFromBackup(pluginDir, PLUGIN_ID);
		assert.equal(result, true);

		// 验证恢复后的内容
		const pkg = JSON.parse(await fs.readFile(nodePath.join(pluginDir, 'package.json'), 'utf8'));
		assert.equal(pkg.version, '1.2.3');
		const sub = await fs.readFile(nodePath.join(pluginDir, 'sub', 'file.txt'), 'utf8');
		assert.equal(sub, 'hello');
		// 损坏内容应已不在
		await assert.rejects(() => fs.access(nodePath.join(pluginDir, 'corrupted.txt')));

		// 备份应已被移走
		await assert.rejects(() => fs.access(backupDir));
	} finally {
		await cleanTmpEnv(base);
	}
});

test('restoreFromBackup 无备份时返回 false', async () => {
	const { base, pluginDir } = await makeTmpEnv();
	try {
		const result = await restoreFromBackup(pluginDir, PLUGIN_ID);
		assert.equal(result, false);
	} finally {
		await cleanTmpEnv(base);
	}
});

test('restoreFromBackup rename 报 EXDEV 时退化 cp+rm（跨文件系统）', async () => {
	const { base, pluginDir, backupDir } = await makeTmpEnv();
	try {
		await createBackup(pluginDir, PLUGIN_ID);
		await fs.rm(pluginDir, { recursive: true, force: true });

		// 注入 rename 抛 EXDEV，模拟 state-dir 与 extensions 跨文件系统
		const exdevErr = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
		const renameCalls = [];
		const result = await restoreFromBackup(pluginDir, PLUGIN_ID, {
			renameFn: async (...args) => { renameCalls.push(args); throw exdevErr; },
		});

		assert.equal(result, true);
		assert.equal(renameCalls.length, 1);
		// cp 兜底恢复成功
		const pkg = JSON.parse(await fs.readFile(nodePath.join(pluginDir, 'package.json'), 'utf8'));
		assert.equal(pkg.version, '1.2.3');
		// 备份目录被 rm 清理
		await assert.rejects(() => fs.access(backupDir));
	} finally {
		await cleanTmpEnv(base);
	}
});

test('restoreFromBackup EXDEV 退化路径 cp 成功后 rm 失败不算 restore 失败（warn + 返回 true）', async () => {
	const { base, pluginDir } = await makeTmpEnv();
	try {
		await createBackup(pluginDir, PLUGIN_ID);
		await fs.rm(pluginDir, { recursive: true, force: true });

		const exdevErr = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
		const logs = [];
		// cp 已恢复文件态；备份目录清理失败若整体抛出，调用方会误走 fallback
		// install / 误记 rollback-failed——必须降级为告警并照常返回成功
		const result = await restoreFromBackup(pluginDir, PLUGIN_ID, {
			renameFn: async () => { throw exdevErr; },
			rmFn: async () => { throw new Error('rm boom'); },
			log: (m) => logs.push(m),
		});

		assert.equal(result, true, '文件态已恢复，restore 应判定成功');
		// 文件态确实已由 cp 恢复
		const pkg = JSON.parse(await fs.readFile(nodePath.join(pluginDir, 'package.json'), 'utf8'));
		assert.equal(pkg.version, '1.2.3');
		assert.ok(
			logs.some(m => m.includes('non-fatal') && m.includes('rm boom')),
			'rm 失败应降级为本地告警',
		);
	} finally {
		await cleanTmpEnv(base);
	}
});

test('restoreFromBackup rename 报非 EXDEV 错误时向上抛', async () => {
	const { base, pluginDir } = await makeTmpEnv();
	try {
		await createBackup(pluginDir, PLUGIN_ID);

		const eaccesErr = Object.assign(new Error('permission denied'), { code: 'EACCES' });
		await assert.rejects(
			() => restoreFromBackup(pluginDir, PLUGIN_ID, {
				renameFn: async () => { throw eaccesErr; },
			}),
			(err) => err.code === 'EACCES',
		);
	} finally {
		await cleanTmpEnv(base);
	}
});

// ── removeBackup ──

test('removeBackup 删除备份目录', async () => {
	const { base, pluginDir, backupDir } = await makeTmpEnv();
	try {
		await createBackup(pluginDir, PLUGIN_ID);
		// 确认存在
		await fs.access(backupDir);

		await removeBackup(PLUGIN_ID);

		// 确认已删除
		await assert.rejects(() => fs.access(backupDir));
	} finally {
		await cleanTmpEnv(base);
	}
});

test('removeBackup 不存在时不抛异常', async () => {
	const { base } = await makeTmpEnv();
	try {
		await assert.doesNotReject(() => removeBackup(PLUGIN_ID));
	} finally {
		await cleanTmpEnv(base);
	}
});

// ── readVersionFromDir ──

test('readVersionFromDir 读取目录下 package.json 的 version', async () => {
	const { base, pluginDir } = await makeTmpEnv();
	try {
		const ver = await readVersionFromDir(pluginDir);
		assert.equal(ver, '1.2.3');
	} finally {
		await cleanTmpEnv(base);
	}
});

test('readVersionFromDir 目录不存在时抛异常', async () => {
	await assert.rejects(() => readVersionFromDir('/nonexistent/path'));
});
