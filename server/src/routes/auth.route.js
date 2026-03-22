import { Router } from 'express';
import passport from 'passport';
import { createLocalAccount } from '../services/local-auth.svc.js';
import { toAuthResponseUser } from '../services/user-view.svc.js';

export const authRouter = Router();

// --- Login rate limiter (per IP, no external dependencies) ---
const LOGIN_WINDOW_MS = 15 * 60_000; // 15 分钟窗口
const LOGIN_MAX_ATTEMPTS = 10;        // 每个 IP 最多 10 次
const loginAttempts = new Map();       // ip → { count, resetAt }

// 每 5 分钟清理过期条目
setInterval(() => {
	const now = Date.now();
	for (const [ip, entry] of loginAttempts) {
		if (entry.resetAt <= now) loginAttempts.delete(ip);
	}
}, 5 * 60_000).unref();

export function loginRateLimiter(req, res, next) {
	const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
	const now = Date.now();
	const entry = loginAttempts.get(ip);

	if (entry && entry.resetAt > now) {
		if (entry.count >= LOGIN_MAX_ATTEMPTS) {
			const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
			res.set('Retry-After', String(retryAfter));
			res.status(429).json({
				code: 'TOO_MANY_REQUESTS',
				message: 'Too many login attempts, please try again later',
			});
			return;
		}
		entry.count++;
	}
	else {
		loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
	}
	next();
}

export function loginByLoginNameHandler(req, res, next) {
	passport.authenticate('local-login-name', (err, user, info) => {
		if (err) {
			next(err);
			return;
		}

		if (!user) {
			res.status(401).json({
				code: info?.code ?? 'UNAUTHORIZED',
				message: info?.message ?? 'Unauthorized',
			});
			return;
		}

		req.logIn(user, (loginErr) => {
			if (loginErr) {
				next(loginErr);
				return;
			}

			res.status(200).json({
				user: toAuthResponseUser(user),
			});
		});
	})(req, res, next);
}

export function getCurrentSessionHandler(req, res) {
	// Deprecated: use GET /api/v1/user instead.
	res.set('Deprecation', 'true');
	res.set('Link', '</api/v1/user>; rel="successor-version"');

	if (!req.isAuthenticated?.() || !req.user) {
		res.status(200).json({
			user: null,
		});
		return;
	}

	res.status(200).json({
		user: toAuthResponseUser(req.user),
	});
}

export function logoutHandler(req, res, next) {
	req.logout((err) => {
		if (err) {
			next(err);
			return;
		}

		req.session.destroy((destroyErr) => {
			if (destroyErr) {
				next(destroyErr);
				return;
			}

			res.status(204).end();
		});
	});
}

export function registerLocalHandler(req, res, next, deps = {}) {
	const { createAccount = createLocalAccount } = deps;
	const { loginName, password } = req.body;

	createAccount({ loginName, password })
		.then((result) => {
			if (!result.ok) {
				const status = result.code === 'LOGIN_NAME_TAKEN' ? 409 : 400;
				res.status(status).json({
					code: result.code,
					message: result.message,
				});
				return;
			}

			req.logIn(result.user, (err) => {
				if (err) {
					next(err);
					return;
				}

				res.status(201).json({
					user: toAuthResponseUser(result.user),
				});
			});
		})
		.catch(next);
}

authRouter.post('/local/login', loginRateLimiter, loginByLoginNameHandler);
authRouter.post('/local/register', registerLocalHandler);
// Deprecated: keep for backward compatibility.
authRouter.get('/session', getCurrentSessionHandler);
authRouter.post('/logout', logoutHandler);
