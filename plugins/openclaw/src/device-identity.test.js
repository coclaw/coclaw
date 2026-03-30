import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import test from 'node:test';

import {
	loadOrCreateDeviceIdentity,
	signDevicePayload,
	publicKeyRawBase64Url,
	buildDeviceAuthPayloadV3,
	getIdentityPath,
} from './device-identity.js';
import { setRuntime } from './runtime.js';

function makeTmpDir() {
	return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'coclaw-devid-test-'));
}

function cleanup(dir) {
	fs.rmSync(dir, { recursive: true, force: true });
}

test('loadOrCreateDeviceIdentity 创建新身份', () => {
	const dir = makeTmpDir();
	try {
		const fp = nodePath.join(dir, 'device-identity.json');
		const id = loadOrCreateDeviceIdentity(fp);
		assert.ok(id.deviceId, 'deviceId should exist');
		assert.ok(id.publicKeyPem.includes('BEGIN PUBLIC KEY'), 'should have PEM public key');
		assert.ok(id.privateKeyPem.includes('BEGIN PRIVATE KEY'), 'should have PEM private key');

		// 文件应已写入
		const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
		assert.equal(raw.version, 1);
		assert.equal(raw.deviceId, id.deviceId);
		assert.ok(raw.createdAtMs > 0);

		// 文件权限应为 0o600
		const stat = fs.statSync(fp);
		assert.equal(stat.mode & 0o777, 0o600);
	}
	finally {
		cleanup(dir);
	}
});

test('loadOrCreateDeviceIdentity 加载已有身份', () => {
	const dir = makeTmpDir();
	try {
		const fp = nodePath.join(dir, 'device-identity.json');
		const first = loadOrCreateDeviceIdentity(fp);
		const second = loadOrCreateDeviceIdentity(fp);
		assert.equal(second.deviceId, first.deviceId);
		assert.equal(second.publicKeyPem, first.publicKeyPem);
		assert.equal(second.privateKeyPem, first.privateKeyPem);
	}
	finally {
		cleanup(dir);
	}
});

test('loadOrCreateDeviceIdentity 修正不一致的 deviceId', () => {
	const dir = makeTmpDir();
	try {
		const fp = nodePath.join(dir, 'device-identity.json');
		const id = loadOrCreateDeviceIdentity(fp);
		// 篡改 deviceId
		const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
		raw.deviceId = 'wrong-id';
		fs.writeFileSync(fp, JSON.stringify(raw));

		const corrected = loadOrCreateDeviceIdentity(fp);
		assert.equal(corrected.deviceId, id.deviceId, 'should correct to derived id');
		assert.notEqual(corrected.deviceId, 'wrong-id');

		// 文件也应被更新
		const updated = JSON.parse(fs.readFileSync(fp, 'utf8'));
		assert.equal(updated.deviceId, id.deviceId);
	}
	finally {
		cleanup(dir);
	}
});

test('loadOrCreateDeviceIdentity 文件内容无效时重新生成', () => {
	const dir = makeTmpDir();
	try {
		const fp = nodePath.join(dir, 'device-identity.json');
		fs.writeFileSync(fp, '{"version":999}');
		const id = loadOrCreateDeviceIdentity(fp);
		assert.ok(id.deviceId);
		assert.ok(id.publicKeyPem.includes('BEGIN PUBLIC KEY'));
	}
	finally {
		cleanup(dir);
	}
});

test('loadOrCreateDeviceIdentity 文件不可读时重新生成并输出 warn', () => {
	const dir = makeTmpDir();
	const warns = [];
	const origWarn = console.warn;
	console.warn = (...args) => warns.push(args.join(' '));
	try {
		const fp = nodePath.join(dir, 'device-identity.json');
		fs.writeFileSync(fp, 'not-json!!!');
		const id = loadOrCreateDeviceIdentity(fp);
		assert.ok(id.deviceId);
		assert.ok(id.publicKeyPem.includes('BEGIN PUBLIC KEY'));
		assert.ok(warns.some((w) => w.includes('device identity read failed') && w.includes('regenerating')), 'should warn about regeneration');
	}
	finally {
		console.warn = origWarn;
		cleanup(dir);
	}
});

test('signDevicePayload 返回 base64url 签名', () => {
	const dir = makeTmpDir();
	try {
		const fp = nodePath.join(dir, 'device-identity.json');
		const id = loadOrCreateDeviceIdentity(fp);
		const sig = signDevicePayload(id.privateKeyPem, 'test-payload');
		assert.ok(typeof sig === 'string');
		assert.ok(sig.length > 0);
		// 不含标准 base64 的 +/= 字符
		assert.ok(!sig.includes('+'));
		assert.ok(!sig.includes('/'));

		// 验证签名
		const key = crypto.createPublicKey(id.publicKeyPem);
		const sigBuf = Buffer.from(sig.replaceAll('-', '+').replaceAll('_', '/') + '==', 'base64');
		const valid = crypto.verify(null, Buffer.from('test-payload', 'utf8'), key, sigBuf);
		assert.ok(valid, 'signature should be verifiable');
	}
	finally {
		cleanup(dir);
	}
});

test('publicKeyRawBase64Url 返回裸公钥的 base64url', () => {
	const dir = makeTmpDir();
	try {
		const fp = nodePath.join(dir, 'device-identity.json');
		const id = loadOrCreateDeviceIdentity(fp);
		const raw = publicKeyRawBase64Url(id.publicKeyPem);
		assert.ok(typeof raw === 'string');
		assert.ok(raw.length > 0);
		assert.ok(!raw.includes('+'));
		assert.ok(!raw.includes('/'));
	}
	finally {
		cleanup(dir);
	}
});

test('buildDeviceAuthPayloadV3 构建正确的 v3 载荷', () => {
	const result = buildDeviceAuthPayloadV3({
		deviceId: 'abc123',
		clientId: 'gateway-client',
		clientMode: 'backend',
		role: 'operator',
		scopes: ['operator.admin'],
		signedAtMs: 1700000000000,
		token: 'my-token',
		nonce: 'nonce-xyz',
		platform: 'Linux',
		deviceFamily: '',
	});
	assert.equal(
		result,
		'v3|abc123|gateway-client|backend|operator|operator.admin|1700000000000|my-token|nonce-xyz|linux|'
	);
});

test('buildDeviceAuthPayloadV3 处理缺省参数', () => {
	const result = buildDeviceAuthPayloadV3({
		deviceId: 'abc',
		clientId: 'c',
		clientMode: 'm',
		role: 'r',
		scopes: [],
		signedAtMs: 0,
		nonce: '',
	});
	assert.equal(result, 'v3|abc|c|m|r||0||||');
});

test('getIdentityPath 使用 runtime resolveStateDir', () => {
	const prev = setRuntime({ state: { resolveStateDir: () => '/mock/state' } });
	try {
		const p = getIdentityPath();
		assert.equal(p, nodePath.join('/mock/state', 'coclaw', 'device-identity.json'));
	}
	finally {
		setRuntime(prev);
	}
});

test('getIdentityPath 使用 OPENCLAW_STATE_DIR', () => {
	const prev = setRuntime(null);
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	try {
		process.env.OPENCLAW_STATE_DIR = '/env/state';
		const p = getIdentityPath();
		assert.equal(p, nodePath.join('/env/state', 'coclaw', 'device-identity.json'));
	}
	finally {
		process.env.OPENCLAW_STATE_DIR = origEnv;
		setRuntime(prev);
	}
});

test('getIdentityPath 默认回退 ~/.openclaw', () => {
	const prev = setRuntime(null);
	const origEnv = process.env.OPENCLAW_STATE_DIR;
	try {
		delete process.env.OPENCLAW_STATE_DIR;
		const p = getIdentityPath();
		assert.equal(p, nodePath.join(os.homedir(), '.openclaw', 'coclaw', 'device-identity.json'));
	}
	finally {
		if (origEnv !== undefined) process.env.OPENCLAW_STATE_DIR = origEnv;
		setRuntime(prev);
	}
});
