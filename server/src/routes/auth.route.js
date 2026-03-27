import { Router } from 'express';
import passport from 'passport';
import { createLocalAccount } from '../services/local-auth.svc.js';
import { touchUserLogout } from '../repos/user.repo.js';
import { toAuthResponseUser } from '../services/user-view.svc.js';

export const authRouter = Router();

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

export function logoutHandler(req, res, next, deps = {}) {
	const { touchLogout = touchUserLogout } = deps;
	const userId = req.user?.id ?? null;
	req.logout(async (err) => {
		if (err) {
			next(err);
			return;
		}

		// 写入 lastLogoutAt
		if (userId) {
			try {
				await touchLogout(userId);
			} catch {
				// 写入失败不影响退出流程
			}
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

authRouter.post('/local/login', loginByLoginNameHandler);
authRouter.post('/local/register', registerLocalHandler);
// Deprecated: keep for backward compatibility.
authRouter.get('/session', getCurrentSessionHandler);
authRouter.post('/logout', logoutHandler);
