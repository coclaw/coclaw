import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { getHostName, readSettings, writeName } from './settings.js';
import { setRuntime } from './runtime.js';

function resetEnv() {
	delete process.env.OPENCLAW_STATE_DIR;
	setRuntime(null);
}

async function makeTmpDir(prefix = 'coclaw-settings-') {
	return await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
}

function settingsPath(stateDir) {
	return nodePath.join(stateDir, 'coclaw', 'settings.json');
}

test('readSettings should return empty object when file does not exist', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	const settings = await readSettings();
	assert.deepEqual(settings, {});
});

test('writeName should persist name and readSettings should return it', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	await writeName('My PC');
	const settings = await readSettings();
	assert.equal(settings.name, 'My PC');

	// 验证文件内容
	const raw = JSON.parse(await fs.readFile(settingsPath(dir), 'utf8'));
	assert.equal(raw.name, 'My PC');
});

test('writeName should trim whitespace', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	await writeName('  hello world  ');
	const settings = await readSettings();
	assert.equal(settings.name, 'hello world');
});

test('writeName with null should clear name field', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	await writeName('My PC');
	await writeName(null);

	const settings = await readSettings();
	assert.equal(settings.name, undefined);

	// 文件应存在但无 name 字段
	const raw = JSON.parse(await fs.readFile(settingsPath(dir), 'utf8'));
	assert.equal(raw.name, undefined);
});

test('writeName with empty string should clear name field', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	await writeName('My PC');
	await writeName('');

	const settings = await readSettings();
	assert.equal(settings.name, undefined);
});

test('writeName with whitespace-only string should clear name field', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	await writeName('My PC');
	await writeName('   ');

	const settings = await readSettings();
	assert.equal(settings.name, undefined);
});

test('writeName should reject name exceeding 63 characters', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	const longName = 'a'.repeat(64);
	await assert.rejects(() => writeName(longName), /maximum length/);
});

test('writeName should accept name of exactly 63 characters', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	const name63 = 'a'.repeat(63);
	await writeName(name63);

	const settings = await readSettings();
	assert.equal(settings.name, name63);
});

test('writeName should preserve other fields in settings.json', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	// 预写入包含其他字段的文件
	const sp = settingsPath(dir);
	await fs.mkdir(nodePath.dirname(sp), { recursive: true });
	await fs.writeFile(sp, JSON.stringify({ otherField: 'keep' }), 'utf8');

	await writeName('Test');

	const raw = JSON.parse(await fs.readFile(sp, 'utf8'));
	assert.equal(raw.name, 'Test');
	assert.equal(raw.otherField, 'keep');
});

test('readSettings should handle corrupt file gracefully', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	const sp = settingsPath(dir);
	await fs.mkdir(nodePath.dirname(sp), { recursive: true });
	await fs.writeFile(sp, '{bad json', 'utf8');

	const warns = [];
	const origWarn = console.warn;
	console.warn = (...args) => warns.push(args.join(' '));
	try {
		const settings = await readSettings();
		assert.deepEqual(settings, {});
		assert.ok(warns.some((w) => w.includes('corrupt settings file deleted')));
	}
	finally {
		console.warn = origWarn;
	}
});

test('readSettings should treat empty file as empty object', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	const sp = settingsPath(dir);
	await fs.mkdir(nodePath.dirname(sp), { recursive: true });
	await fs.writeFile(sp, '  \n', 'utf8');

	const settings = await readSettings();
	assert.deepEqual(settings, {});
});

test('readSettings should return empty object when file contains array', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	const sp = settingsPath(dir);
	await fs.mkdir(nodePath.dirname(sp), { recursive: true });
	await fs.writeFile(sp, '[1,2,3]', 'utf8');

	const settings = await readSettings();
	assert.deepEqual(settings, {});
});

test('writeName should handle settings.json containing array', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	const sp = settingsPath(dir);
	await fs.mkdir(nodePath.dirname(sp), { recursive: true });
	await fs.writeFile(sp, '[1,2,3]', 'utf8');

	await writeName('Test');
	const raw = JSON.parse(await fs.readFile(sp, 'utf8'));
	assert.equal(raw.name, 'Test');
	// 数组内容应被替换为对象
	assert.ok(!Array.isArray(raw));
});

test('writeName should handle settings.json containing null', async () => {
	resetEnv();
	const dir = await makeTmpDir();
	process.env.OPENCLAW_STATE_DIR = dir;

	const sp = settingsPath(dir);
	await fs.mkdir(nodePath.dirname(sp), { recursive: true });
	await fs.writeFile(sp, 'null', 'utf8');

	await writeName('Test');
	const raw = JSON.parse(await fs.readFile(sp, 'utf8'));
	assert.equal(raw.name, 'Test');
});

test('getHostName should return hostname without .local suffix', () => {
	const name = getHostName();
	assert.equal(typeof name, 'string');
	assert.ok(name.length > 0);
	assert.ok(!name.endsWith('.local'));
});
