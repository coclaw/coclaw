import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

import { getRuntime } from './runtime.js';

const CHANNEL_ID = 'coclaw';
const IDENTITY_FILENAME = 'device-identity.json';

// Ed25519 SPKI 前缀（固定 12 字节），公钥裸字节从 SPKI DER 中截取
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function base64UrlEncode(buf) {
	return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

// 仅处理 ASCII 范围的大写→小写，保持跨运行时确定性
function toLowerAscii(input) {
	return input.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

function normalizeMetadataForAuth(value) {
	if (typeof value !== 'string') return '';
	const trimmed = value.trim();
	return trimmed ? toLowerAscii(trimmed) : '';
}

function resolveStateDir() {
	const rt = getRuntime();
	if (rt?.state?.resolveStateDir) {
		return rt.state.resolveStateDir();
	}
	return process.env.OPENCLAW_STATE_DIR
		? nodePath.resolve(process.env.OPENCLAW_STATE_DIR)
		: nodePath.join(os.homedir(), '.openclaw');
}

/**
 * 获取身份文件路径
 * @returns {string}
 */
export function getIdentityPath() {
	return nodePath.join(resolveStateDir(), CHANNEL_ID, IDENTITY_FILENAME);
}

/**
 * 从 PEM 公钥提取裸字节
 * @param {string} publicKeyPem
 * @returns {Buffer}
 */
function derivePublicKeyRaw(publicKeyPem) {
	const key = crypto.createPublicKey(publicKeyPem);
	const spki = key.export({ type: 'spki', format: 'der' });
	if (
		spki.length === ED25519_SPKI_PREFIX.length + 32
		&& spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
	) {
		return spki.subarray(ED25519_SPKI_PREFIX.length);
	}
	/* c8 ignore next -- Ed25519 密钥 SPKI 格式固定，此分支仅防御未知密钥格式 */
	return spki;
}

/**
 * 公钥指纹 = SHA256(裸公钥字节) 的十六进制
 * @param {string} publicKeyPem
 * @returns {string}
 */
function fingerprintPublicKey(publicKeyPem) {
	const raw = derivePublicKeyRaw(publicKeyPem);
	return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * 生成新的 Ed25519 密钥对
 * @returns {{ deviceId: string, publicKeyPem: string, privateKeyPem: string }}
 */
function generateIdentity() {
	const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
	const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
	const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
	const deviceId = fingerprintPublicKey(publicKeyPem);
	return { deviceId, publicKeyPem, privateKeyPem };
}

/**
 * 加载或创建设备身份（Ed25519 密钥对）
 *
 * 存储格式与 OpenClaw device-identity.ts 保持一致。
 * @param {string} [filePath] - 自定义路径，默认 ~/.openclaw/coclaw/device-identity.json
 * @returns {{ deviceId: string, publicKeyPem: string, privateKeyPem: string }}
 */
export function loadOrCreateDeviceIdentity(filePath) {
	const fp = filePath ?? getIdentityPath();
	try {
		if (fs.existsSync(fp)) {
			const raw = fs.readFileSync(fp, 'utf8');
			const parsed = JSON.parse(raw);
			if (
				parsed?.version === 1
				&& typeof parsed.deviceId === 'string'
				&& typeof parsed.publicKeyPem === 'string'
				&& typeof parsed.privateKeyPem === 'string'
			) {
				// 校验 deviceId 一致性
				const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
				if (derivedId && derivedId !== parsed.deviceId) {
					const updated = { ...parsed, deviceId: derivedId };
					fs.writeFileSync(fp, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
					try { fs.chmodSync(fp, 0o600); } catch { /* best-effort */ }
					return { deviceId: derivedId, publicKeyPem: parsed.publicKeyPem, privateKeyPem: parsed.privateKeyPem };
				}
				return { deviceId: parsed.deviceId, publicKeyPem: parsed.publicKeyPem, privateKeyPem: parsed.privateKeyPem };
			}
		}
	}
	catch (err) {
		// 读取/解析失败时重新生成（将产生新 deviceId，需重新 enroll）
		/* c8 ignore next -- ?./?? fallback */
		console.warn?.(`[coclaw] device identity read failed, regenerating: ${String(err?.message ?? err)}`);
	}

	const identity = generateIdentity();
	fs.mkdirSync(nodePath.dirname(fp), { recursive: true });
	const stored = {
		version: 1,
		deviceId: identity.deviceId,
		publicKeyPem: identity.publicKeyPem,
		privateKeyPem: identity.privateKeyPem,
		createdAtMs: Date.now(),
	};
	fs.writeFileSync(fp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
	try { fs.chmodSync(fp, 0o600); } catch { /* best-effort */ }
	return identity;
}

/**
 * 签名设备认证载荷
 * @param {string} privateKeyPem
 * @param {string} payload
 * @returns {string} base64url 编码签名
 */
export function signDevicePayload(privateKeyPem, payload) {
	const key = crypto.createPrivateKey(privateKeyPem);
	const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
	return base64UrlEncode(sig);
}

/**
 * 公钥 PEM → base64url 裸字节
 * @param {string} publicKeyPem
 * @returns {string}
 */
export function publicKeyRawBase64Url(publicKeyPem) {
	return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

/**
 * 构建 v3 版本的设备认证载荷字符串
 * @param {object} params
 * @param {string} params.deviceId
 * @param {string} params.clientId
 * @param {string} params.clientMode
 * @param {string} params.role
 * @param {string[]} params.scopes
 * @param {number} params.signedAtMs
 * @param {string} [params.token]
 * @param {string} params.nonce
 * @param {string} [params.platform]
 * @param {string} [params.deviceFamily]
 * @returns {string}
 */
export function buildDeviceAuthPayloadV3(params) {
	const scopes = params.scopes.join(',');
	const token = params.token ?? '';
	const platform = normalizeMetadataForAuth(params.platform);
	const deviceFamily = normalizeMetadataForAuth(params.deviceFamily);
	return [
		'v3',
		params.deviceId,
		params.clientId,
		params.clientMode,
		params.role,
		scopes,
		String(params.signedAtMs),
		token,
		params.nonce,
		platform,
		deviceFamily,
	].join('|');
}
