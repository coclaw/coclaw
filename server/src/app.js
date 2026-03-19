import cors from 'cors';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import morgan from 'morgan';
import passport from 'passport';

import { setupPassport } from './config/passport.js';
import { prisma } from './db/prisma.js';
import { PrismaSessionStore } from './db/prisma-session-store.js';
import { authRouter } from './routes/auth.route.js';
import { botRouter } from './routes/bot.route.js';
import { clawRouter } from './routes/claw.route.js';
import { userRouter } from './routes/user.route.js';

setupPassport();

export function createApp() {
	const app = express();
	const isProduction = process.env.NODE_ENV === 'production';
	const sessionSecret = process.env.SESSION_SECRET ?? 'coclaw-dev-session-secret';
	const enforceHttps = isProduction
		&& String(process.env.ENFORCE_HTTPS ?? 'true').toLowerCase() !== 'false';

	if (isProduction && sessionSecret === 'coclaw-dev-session-secret') {
		throw new Error('SESSION_SECRET is required in production');
	}

	if (isProduction) {
		app.set('trust proxy', 1);
	}

	app.use(helmet({
		hsts: false,
	}));
	app.use(cors({
		origin: true,
		credentials: true,
	}));
	app.use(morgan('dev'));
	app.use(express.json());

	if (enforceHttps) {
		app.use((req, res, next) => {
			if (req.secure || req.path === '/healthz') {
				next();
				return;
			}
			res.status(426).json({
				code: 'HTTPS_REQUIRED',
				message: 'HTTPS is required',
			});
		});
	}

	const sessionMw = session({
		name: 'coclaw.sid',
		secret: sessionSecret,
		resave: false,
		saveUninitialized: false,
		cookie: {
			httpOnly: true,
			sameSite: 'lax',
			secure: isProduction,
			maxAge: 1000 * 60 * 60 * 24 * 30, // 30天
		},
		store: new PrismaSessionStore(prisma),
	});
	app.use(sessionMw);
	app.use(passport.initialize());
	app.use(passport.session());

	// 供 WS upgrade 认证使用
	app.sessionMiddleware = sessionMw;

	app.get('/healthz', (req, res) => {
		res.status(200).json({ ok: true });
	});

	app.use('/api/v1/auth', authRouter);
	app.use('/api/v1/user', userRouter);
	app.use('/api/v1/bots', botRouter);
	app.use('/api/v1/claws', clawRouter);

	app.use((err, req, res, _next) => {
		console.error(err);
		res.status(500).json({
			code: 'INTERNAL_SERVER_ERROR',
			message: 'Internal server error',
		});
	});

	return app;
}
