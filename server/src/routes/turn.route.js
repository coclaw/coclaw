import crypto from 'node:crypto';
import { Router } from 'express';

export const turnRouter = Router();

function requireSession(req, res) {
	if (req.isAuthenticated?.() && req.user) {
		return true;
	}
	res.status(401).json({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
	return false;
}

/**
 * 生成 TURN 临时凭证（HMAC-SHA1，与 coturn 的 use-auth-secret 机制配套）
 * @param {string} identity - 用户标识（用于 username 前缀）
 * @param {string} secret - 与 coturn 共享的密钥
 * @param {number} [ttl=86400] - 凭证有效期（秒）
 */
export function genTurnCreds(identity, secret, ttl = 86400) {
	const timestamp = Math.floor(Date.now() / 1000) + ttl;
	const username = `${timestamp}:${identity}`;
	const hmac = crypto.createHmac('sha1', secret);
	hmac.update(username);
	const turnDomain = process.env.TURN_DOMAIN || process.env.APP_DOMAIN;
	const port = process.env.TURN_PORT || '3478';
	const tlsPort = process.env.TURN_TLS_PORT;

	const urls = [
		`turn:${turnDomain}:${port}?transport=udp`,
		`turn:${turnDomain}:${port}?transport=tcp`,
	];
	if (tlsPort) {
		urls.push(`turns:${turnDomain}:${tlsPort}?transport=tcp`);
	}

	return {
		username,
		credential: hmac.digest('base64'),
		ttl,
		urls,
	};
}

/**
 * 为 gateway/plugin 生成兼容凭证（过滤 turns: URL，旧版 plugin 不支持）
 * TODO(2026-04-12): 届时旧版 plugin 应已全部升级，移除此函数，直接使用 genTurnCreds
 */
export function genTurnCredsForGateway(identity, secret, ttl) {
	const creds = genTurnCreds(identity, secret, ttl);
	creds.urls = creds.urls.filter(u => !u.startsWith('turns:'));
	return creds;
}

// 启动时校验（生产环境缺失则阻止启动，开发环境仅警告）
if (!process.env.TURN_SECRET) {
	if (process.env.NODE_ENV === 'production') {
		throw new Error('[coclaw] TURN_SECRET is required but not set');
	}
	console.warn('[coclaw] TURN_SECRET is not set — TURN credential API will return 503');
}

// GET /api/v1/turn/creds
turnRouter.get('/creds', (req, res) => {
	if (!requireSession(req, res)) return;
	const secret = process.env.TURN_SECRET;
	if (!secret) {
		res.status(503).json({ code: 'TURN_NOT_CONFIGURED', message: 'TURN service not configured' });
		return;
	}
	const userId = String(req.user.id ?? req.user);
	res.json(genTurnCreds(userId, secret));
});
