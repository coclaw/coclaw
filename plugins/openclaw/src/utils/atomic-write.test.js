import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { atomicWriteFile, atomicWriteJsonFile } from './atomic-write.js';

async function makeTmpDir(prefix = 'coclaw-atomic-') {
	return await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
}

// --- atomicWriteFile ---

test('atomicWriteFile 写入文本并正确读回', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'test.txt');

	await atomicWriteFile(filePath, 'hello world');

	const content = await fs.readFile(filePath, 'utf8');
	assert.equal(content, 'hello world');
});

test('atomicWriteFile 覆盖已有文件', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'overwrite.txt');

	await atomicWriteFile(filePath, 'first');
	await atomicWriteFile(filePath, 'second');

	const content = await fs.readFile(filePath, 'utf8');
	assert.equal(content, 'second');
});

test('atomicWriteFile 自动创建父目录', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'sub', 'deep', 'file.txt');

	await atomicWriteFile(filePath, 'nested');

	const content = await fs.readFile(filePath, 'utf8');
	assert.equal(content, 'nested');
});

test('atomicWriteFile 写入后无临时文件残留', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'clean.txt');

	await atomicWriteFile(filePath, 'data');

	const files = await fs.readdir(dir);
	// 目录下只有目标文件，无 .tmp 残留
	assert.equal(files.length, 1);
	assert.equal(files[0], 'clean.txt');
});

test('atomicWriteFile 设置文件权限 mode', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'perm.txt');

	await atomicWriteFile(filePath, 'secure', { mode: 0o644 });

	const stat = await fs.stat(filePath);
	assert.equal(stat.mode & 0o777, 0o644);
});

test('atomicWriteFile 默认权限 0o600', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'default-perm.txt');

	await atomicWriteFile(filePath, 'secure');

	const stat = await fs.stat(filePath);
	assert.equal(stat.mode & 0o777, 0o600);
});

test('atomicWriteFile 设置 dirMode', async () => {
	const dir = await makeTmpDir();
	const subDir = nodePath.join(dir, 'protected');
	const filePath = nodePath.join(subDir, 'file.txt');

	await atomicWriteFile(filePath, 'data', { dirMode: 0o700 });

	const stat = await fs.stat(subDir);
	assert.equal(stat.mode & 0o777, 0o700);
});

test('atomicWriteFile 支持 Buffer 内容', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'binary.bin');
	const buf = Buffer.from([0x00, 0x01, 0x02, 0xFF]);

	await atomicWriteFile(filePath, buf);

	const content = await fs.readFile(filePath);
	assert.deepEqual(content, buf);
});

test('atomicWriteFile 支持空内容', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'empty.txt');

	await atomicWriteFile(filePath, '');

	const content = await fs.readFile(filePath, 'utf8');
	assert.equal(content, '');
});

test('atomicWriteFile 写入失败时不损坏已有文件', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'safe.txt');

	// 先写入原始数据
	await atomicWriteFile(filePath, 'original');

	// 写入一个路径为已存在目录的位置来触发 rename 错误
	const blockDir = nodePath.join(dir, 'blocker');
	await fs.mkdir(blockDir);

	try {
		await atomicWriteFile(blockDir, 'bad');
	} catch {
		// 预期失败
	}

	// 原文件不受影响
	const content = await fs.readFile(filePath, 'utf8');
	assert.equal(content, 'original');
});

// --- atomicWriteJsonFile ---

test('atomicWriteJsonFile 写入格式化的 JSON', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'data.json');
	const obj = { name: 'test', count: 42 };

	await atomicWriteJsonFile(filePath, obj);

	const raw = await fs.readFile(filePath, 'utf8');
	// 2 空格缩进
	assert.equal(raw, JSON.stringify(obj, null, 2) + '\n');
	// 尾部换行
	assert.equal(raw.endsWith('\n'), true);
	// 可正确 parse 回来
	assert.deepEqual(JSON.parse(raw), obj);
});

test('atomicWriteJsonFile 写入数组', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'arr.json');
	const arr = [1, 'two', { three: 3 }];

	await atomicWriteJsonFile(filePath, arr);

	const raw = await fs.readFile(filePath, 'utf8');
	assert.deepEqual(JSON.parse(raw), arr);
});

test('atomicWriteJsonFile 写入 null', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'null.json');

	await atomicWriteJsonFile(filePath, null);

	const raw = await fs.readFile(filePath, 'utf8');
	assert.equal(raw, 'null\n');
	assert.equal(JSON.parse(raw), null);
});

test('atomicWriteJsonFile 写入嵌套对象', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'nested.json');
	const obj = {
		users: [
			{ id: 1, name: 'Alice' },
			{ id: 2, name: 'Bob' },
		],
		meta: { version: '1.0' },
	};

	await atomicWriteJsonFile(filePath, obj);

	const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
	assert.deepEqual(parsed, obj);
});

test('atomicWriteJsonFile 覆盖已有 JSON 文件', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'update.json');

	await atomicWriteJsonFile(filePath, { v: 1 });
	await atomicWriteJsonFile(filePath, { v: 2 });

	const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
	assert.deepEqual(parsed, { v: 2 });
});

test('atomicWriteJsonFile 透传 mode 选项', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'perm.json');

	await atomicWriteJsonFile(filePath, {}, { mode: 0o644 });

	const stat = await fs.stat(filePath);
	assert.equal(stat.mode & 0o777, 0o644);
});

test('atomicWriteJsonFile 透传 dirMode 选项', async () => {
	const dir = await makeTmpDir();
	const subDir = nodePath.join(dir, 'secure');
	const filePath = nodePath.join(subDir, 'data.json');

	await atomicWriteJsonFile(filePath, {}, { dirMode: 0o700 });

	const stat = await fs.stat(subDir);
	assert.equal(stat.mode & 0o777, 0o700);
});

// --- 并发安全验证（结合 mutex 使用场景）---

test('atomicWriteFile 多次并发写入不产生损坏文件', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'concurrent.txt');

	// 模拟多个并发写入（无锁，但每次写入本身是原子的）
	const writes = Array.from({ length: 20 }, (_, i) =>
		atomicWriteFile(filePath, `content-${i}`)
	);

	await Promise.all(writes);

	// 文件应包含某一次完整写入的结果（不会是半截数据）
	const content = await fs.readFile(filePath, 'utf8');
	assert.match(content, /^content-\d+$/);

	// 无 .tmp 残留
	const files = await fs.readdir(dir);
	assert.equal(files.length, 1);
});

test('atomicWriteJsonFile 多次并发写入不产生损坏 JSON', async () => {
	const dir = await makeTmpDir();
	const filePath = nodePath.join(dir, 'concurrent.json');

	const writes = Array.from({ length: 20 }, (_, i) =>
		atomicWriteJsonFile(filePath, { index: i })
	);

	await Promise.all(writes);

	// 文件应是合法 JSON（不会是拼接/截断的）
	const raw = await fs.readFile(filePath, 'utf8');
	const parsed = JSON.parse(raw); // 不抛异常即通过
	assert.equal(typeof parsed.index, 'number');

	// 无 .tmp 残留
	const files = await fs.readdir(dir);
	assert.equal(files.length, 1);
});
