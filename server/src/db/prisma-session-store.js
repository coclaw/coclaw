import { Store } from 'express-session';

const ONE_DAY_MS = 86400000;
const DEFAULT_PRUNE_INTERVAL_MS = 10 * 60 * 1000; // 10分钟

/**
 * 基于 Prisma 的 express-session Store 适配层
 */
export class PrismaSessionStore extends Store {
	/**
	 * @param {import('../../src/generated/prisma/client.js').PrismaClient} prisma
	 * @param {object} [opts]
	 * @param {number} [opts.pruneInterval] - 过期清理间隔（ms），0 禁用
	 */
	constructor(prisma, opts = {}) {
		super();
		this.prisma = prisma;
		const interval = opts.pruneInterval ?? DEFAULT_PRUNE_INTERVAL_MS;
		this.__pruneTimer = null;
		if (interval > 0) {
			this.__pruneTimer = setInterval(() => this.__prune(), interval);
			this.__pruneTimer.unref();
		}
	}

	/**
	 * 获取 session
	 * @param {string} sid
	 * @param {function} cb
	 */
	get(sid, cb) {
		this.prisma.expressSession.findUnique({ where: { sid } })
			.then((row) => {
				if (!row) return cb(null, null);
				if (row.expiresAt < new Date()) {
					// 已过期，删除并返回 null
					return this.prisma.expressSession.delete({ where: { sid } })
						.then(() => cb(null, null))
						.catch(() => cb(null, null));
				}
				try {
					cb(null, JSON.parse(row.data));
				} catch (err) {
					cb(err);
				}
			})
			.catch((err) => cb(err));
	}

	/**
	 * 写入/更新 session
	 * @param {string} sid
	 * @param {object} session
	 * @param {function} cb
	 */
	set(sid, session, cb) {
		const maxAge = session?.cookie?.maxAge ?? ONE_DAY_MS;
		const expiresAt = new Date(Date.now() + maxAge);
		const data = JSON.stringify(session);

		this.prisma.expressSession.upsert({
			where: { sid },
			create: { sid, data, expiresAt },
			update: { data, expiresAt },
		})
			.then(() => cb(null))
			.catch((err) => cb(err));
	}

	/**
	 * 销毁 session
	 * @param {string} sid
	 * @param {function} cb
	 */
	destroy(sid, cb) {
		this.prisma.expressSession.delete({ where: { sid } })
			.then(() => cb(null))
			.catch((err) => {
				// 记录不存在时视为成功
				if (err?.code === 'P2025') return cb(null);
				cb(err);
			});
	}

	/**
	 * 刷新过期时间（不更新 data）
	 * @param {string} sid
	 * @param {object} session
	 * @param {function} cb
	 */
	touch(sid, session, cb) {
		const maxAge = session?.cookie?.maxAge ?? ONE_DAY_MS;
		const expiresAt = new Date(Date.now() + maxAge);

		this.prisma.expressSession.update({
			where: { sid },
			data: { expiresAt },
		})
			.then(() => cb(null))
			.catch((err) => {
				if (err?.code === 'P2025') return cb(null);
				cb(err);
			});
	}

	/** 清理过期记录 */
	__prune() {
		this.prisma.expressSession.deleteMany({
			where: { expiresAt: { lt: new Date() } },
		}).catch(() => {}); // 静默
	}

	/** 停止清理定时器 */
	shutdown() {
		if (this.__pruneTimer) {
			clearInterval(this.__pruneTimer);
			this.__pruneTimer = null;
		}
	}
}
