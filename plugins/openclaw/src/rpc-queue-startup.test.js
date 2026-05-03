import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';

import { cleanupResiduals, measureDiskCap, ONE_GB, SIXTY_FOUR_MB } from './rpc-queue-startup.js';

// --- helpers ---

function silentLogger() {
	const warnings = [];
	return {
		warnings,
		info() {},
		warn(msg) { warnings.push(String(msg)); },
		error() {},
		debug() {},
	};
}

async function makeTmpDir(prefix = 'coclaw-rqstart-') {
	return await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
}

async function rmTmp(dir) {
	await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// --- cleanupResiduals ---

test('cleanupResiduals should create dir when missing', async () => {
	const root = await makeTmpDir();
	try {
		const target = nodePath.join(root, 'rpc-queues');
		await cleanupResiduals(target, { logger: silentLogger() });
		const st = await fs.stat(target);
		assert.equal(st.isDirectory(), true);
	} finally {
		await rmTmp(root);
	}
});

test('cleanupResiduals should remove only *.jsonl files (whitelist)', async () => {
	const root = await makeTmpDir();
	try {
		const target = nodePath.join(root, 'rpc-queues');
		await fs.mkdir(target, { recursive: true });
		await fs.writeFile(nodePath.join(target, 'a.jsonl'), 'x', 'utf8');
		await fs.writeFile(nodePath.join(target, 'b.jsonl'), 'y', 'utf8');
		await fs.writeFile(nodePath.join(target, 'account.json'), '{}', 'utf8');
		await fs.writeFile(nodePath.join(target, '.tmp'), '_', 'utf8');

		await cleanupResiduals(target, { logger: silentLogger() });

		const remaining = (await fs.readdir(target)).sort();
		assert.deepEqual(remaining, ['.tmp', 'account.json']);
	} finally {
		await rmTmp(root);
	}
});

test('cleanupResiduals should handle empty dir without error', async () => {
	const root = await makeTmpDir();
	try {
		const target = nodePath.join(root, 'rpc-queues');
		await fs.mkdir(target, { recursive: true });
		const logger = silentLogger();
		await cleanupResiduals(target, { logger });
		assert.equal(logger.warnings.length, 0);
		const st = await fs.stat(target);
		assert.equal(st.isDirectory(), true);
	} finally {
		await rmTmp(root);
	}
});

test('cleanupResiduals should warn and return when mkdir throws', async () => {
	const logger = silentLogger();
	const fsOps = {
		mkdir: async () => { throw new Error('boom-mkdir'); },
		readdir: async () => { throw new Error('readdir-should-not-be-called'); },
		unlink: async () => { throw new Error('unlink-should-not-be-called'); },
	};
	await assert.doesNotReject(() => cleanupResiduals('/tmp/whatever', { logger, fsOps }));
	assert.equal(logger.warnings.length, 1);
	assert.match(logger.warnings[0], /rpc-queues cleanup mkdir failed/);
	assert.match(logger.warnings[0], /boom-mkdir/);
});

test('cleanupResiduals should warn and return when readdir throws', async () => {
	const logger = silentLogger();
	const fsOps = {
		mkdir: async () => {},
		readdir: async () => { throw new Error('boom-readdir'); },
		unlink: async () => { throw new Error('unlink-should-not-be-called'); },
	};
	await assert.doesNotReject(() => cleanupResiduals('/tmp/whatever', { logger, fsOps }));
	assert.equal(logger.warnings.length, 1);
	assert.match(logger.warnings[0], /rpc-queues cleanup readdir failed/);
	assert.match(logger.warnings[0], /boom-readdir/);
});

test('cleanupResiduals should warn and continue on individual unlink failure', async () => {
	const logger = silentLogger();
	const unlinked = [];
	const fsOps = {
		mkdir: async () => {},
		readdir: async () => ['a.jsonl', 'b.jsonl', 'c.jsonl'],
		unlink: async (p) => {
			if (p.endsWith('a.jsonl')) {
				const err = new Error('eperm');
				err.code = 'EPERM';
				throw err;
			}
			unlinked.push(nodePath.basename(p));
		},
	};
	await assert.doesNotReject(() => cleanupResiduals('/tmp/whatever', { logger, fsOps }));
	assert.deepEqual(unlinked, ['b.jsonl', 'c.jsonl']);
	assert.equal(logger.warnings.length, 1);
	assert.match(logger.warnings[0], /rpc-queues unlink failed/);
	assert.match(logger.warnings[0], /file=a\.jsonl/);
	assert.match(logger.warnings[0], /eperm/);
});

test('cleanupResiduals should not crash when logger is omitted (warn paths use optional chaining)', async () => {
	// 三条 warn 路径都走 logger?.warn?.(...) — 不传 logger 时 ?. 应短路，不抛
	const fsOps = {
		mkdir: async () => { throw new Error('m'); },
		readdir: async () => { throw new Error('r'); },
		unlink: async () => { throw new Error('u'); },
	};
	await assert.doesNotReject(() => cleanupResiduals('/tmp/x', { fsOps }));

	const fsOps2 = {
		mkdir: async () => {},
		readdir: async () => { throw new Error('r'); },
		unlink: async () => {},
	};
	await assert.doesNotReject(() => cleanupResiduals('/tmp/x', { fsOps: fsOps2 }));

	const fsOps3 = {
		mkdir: async () => {},
		readdir: async () => ['a.jsonl'],
		unlink: async () => { throw new Error('u'); },
	};
	await assert.doesNotReject(() => cleanupResiduals('/tmp/x', { fsOps: fsOps3 }));
});

test('measureDiskCap should not crash when logger is omitted', async () => {
	const fsOps = { statfs: async () => { throw new Error('boom'); } };
	const cap = await measureDiskCap('/tmp/x', { fsOps });
	assert.equal(cap, ONE_GB);
});

test('cleanupResiduals should default fsOps to fs.promises', async () => {
	// 不传 fsOps，验证默认 fs.promises 路径成功执行
	const root = await makeTmpDir();
	try {
		const target = nodePath.join(root, 'rpc-queues');
		await fs.mkdir(target, { recursive: true });
		await fs.writeFile(nodePath.join(target, 'real.jsonl'), 'x', 'utf8');
		await cleanupResiduals(target, { logger: silentLogger() });
		const remaining = await fs.readdir(target);
		assert.deepEqual(remaining, []);
	} finally {
		await rmTmp(root);
	}
});

// --- measureDiskCap ---

test('measureDiskCap should return min(1GB, max(64MB, free*50%))', async () => {
	const logger = silentLogger();
	// free=4GB → free*0.5=2GB → min(1GB, 2GB) → 1GB（上限）
	const big = { bavail: 4 * 1024 * 1024, bsize: 1024 };
	const cap1 = await measureDiskCap('/tmp/x', { logger, fsOps: { statfs: async () => big } });
	assert.equal(cap1, ONE_GB);

	// free=200MB → free*0.5=100MB → max(64MB, 100MB)=100MB；min(1GB, 100MB)=100MB
	const mid = { bavail: 200 * 1024, bsize: 1024 };
	const cap2 = await measureDiskCap('/tmp/x', { logger, fsOps: { statfs: async () => mid } });
	assert.equal(cap2, 100 * 1024 * 1024);

	// free=10MB → free*0.5=5MB → max(64MB, 5MB)=64MB
	const low = { bavail: 10 * 1024, bsize: 1024 };
	const cap3 = await measureDiskCap('/tmp/x', { logger, fsOps: { statfs: async () => low } });
	assert.equal(cap3, SIXTY_FOUR_MB);

	assert.equal(logger.warnings.length, 0);
});

test('measureDiskCap should clamp free=0 to 64MB lower bound', async () => {
	const logger = silentLogger();
	const empty = { bavail: 0, bsize: 4096 };
	const cap = await measureDiskCap('/tmp/x', { logger, fsOps: { statfs: async () => empty } });
	assert.equal(cap, SIXTY_FOUR_MB);
	assert.equal(logger.warnings.length, 0);
});

test('measureDiskCap should fall back to 1GB on statfs throw', async () => {
	const logger = silentLogger();
	const fsOps = { statfs: async () => { throw new Error('enosys-boom'); } };
	const cap = await measureDiskCap('/tmp/x', { logger, fsOps });
	assert.equal(cap, ONE_GB);
	assert.equal(logger.warnings.length, 1);
	assert.match(logger.warnings[0], /rpc-queues statfs failed/);
	assert.match(logger.warnings[0], /enosys-boom/);
});

test('measureDiskCap should fall back to 1GB on missing statfs (Node <18.15)', async () => {
	const logger = silentLogger();
	// fsOps 不含 statfs 字段——模拟旧 Node。await undefined() 会抛 TypeError 走 catch。
	const fsOps = {};
	const cap = await measureDiskCap('/tmp/x', { logger, fsOps });
	assert.equal(cap, ONE_GB);
	assert.equal(logger.warnings.length, 1);
	assert.match(logger.warnings[0], /rpc-queues statfs failed/);
});

test('measureDiskCap should default fsOps to fs.promises and return positive int <=1GB', async () => {
	const root = await makeTmpDir();
	try {
		const cap = await measureDiskCap(root, { logger: silentLogger() });
		assert.equal(Number.isInteger(cap), true);
		assert.ok(cap > 0, `cap=${cap} should be positive`);
		assert.ok(cap <= ONE_GB, `cap=${cap} should be <= 1GB`);
		assert.ok(cap >= SIXTY_FOUR_MB, `cap=${cap} should be >= 64MB`);
	} finally {
		await rmTmp(root);
	}
});
