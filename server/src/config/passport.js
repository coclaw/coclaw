import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';

import { findUserById } from '../repos/user.repo.js';
import { loginByLoginName } from '../services/local-auth.svc.js';

export function setupPassport(deps = {}) {
	const {
		login = loginByLoginName,
		findUser = findUserById,
	} = deps;

	passport.use('local-login-name', new LocalStrategy(
		{
			usernameField: 'loginName',
			passwordField: 'password',
			session: true,
		},
		async (loginName, password, done) => {
			try {
				const result = await login({
					loginName,
					password,
				});

				if (!result.ok) {
					return done(null, false, {
						code: result.code,
						message: result.message,
					});
				}

				return done(null, result.user);
			}
			catch (err) {
				return done(err);
			}
		},
	));

	passport.serializeUser((user, done) => {
		done(null, user.id.toString());
	});

	passport.deserializeUser(async (id, done) => {
		try {
			const user = await findUser(BigInt(id));
			if (!user) {
				done(null, false);
				return;
			}

			done(null, {
				id: user.id,
				name: user.name,
				avatar: user.avatar,
				level: user.level,
				locked: user.locked,
			});
		}
		catch (err) {
			done(err);
		}
	});
}
